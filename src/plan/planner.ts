import { posix } from 'node:path';
import type { FileMeta, NoteId } from '../domain/model.ts';
import { nameKey } from '../naming/sanitize.ts';
import type { OutAttachment, OutNote } from '../state/db.ts';
import { sha256Hex } from '../util/hash.ts';
import type { RenderedNote, RenderPlan } from './render.ts';

export type DeletionMode = 'move' | 'keep' | 'delete';

/** Read-only view of the files currently on disk (paths are library-relative). */
export interface DiskState {
  sha256(path: string): string | null;
  md5(path: string): string | null;
}

export interface PlanOptions {
  readonly force: boolean;
  readonly deletions: DeletionMode;
  readonly deletedFolder: string;
}

interface Target {
  readonly note: RenderedNote;
  readonly hash: string;
}

export type NoteAction =
  | ({ kind: 'create' | 'update'; backup: boolean } & Target)
  | ({ kind: 'move'; from: string; rewrite: boolean; backup: boolean } & Target)
  | ({ kind: 'restore'; from: string } & Target)
  | ({ kind: 'adopt' | 'skip' } & Target)
  | { kind: 'retire'; row: OutNote; to: string | null; mode: DeletionMode | 'forget' }
  | {
      kind: 'conflict';
      noteId: NoteId;
      path: string;
      reason: 'edited' | 'occupied';
    };

export type AttachmentAction =
  | { kind: 'fetch'; file: FileMeta; paths: readonly string[] }
  | { kind: 'record'; file: FileMeta; path: string; md5: string }
  | { kind: 'gc'; row: OutAttachment }
  | { kind: 'forget'; row: OutAttachment; reason: 'missing' | 'modified' };

export type ActionKind = NoteAction['kind'] | `attachment:${AttachmentAction['kind']}`;

export interface SyncPlan {
  readonly notes: readonly NoteAction[];
  readonly attachments: readonly AttachmentAction[];
  readonly stats: Readonly<Partial<Record<ActionKind, number>>>;
}

interface Ctx {
  readonly disk: DiskState;
  readonly opts: PlanOptions;
  /** path key → note id owning it from the previous run. */
  readonly owners: ReadonlyMap<string, NoteId>;
}

function occupied(ctx: Ctx, path: string, id: NoteId, hash: string): 'free' | 'same' | 'foreign' {
  const onDisk = ctx.disk.sha256(path);
  if (onDisk === null) return 'free';
  if (onDisk === hash) return 'same';
  const owner = ctx.owners.get(nameKey(path));
  // Another note's previous file: it is moved/retired away in phase one of the executor.
  return owner !== undefined && owner !== id ? 'free' : 'foreign';
}

function planNew(ctx: Ctx, t: Target): NoteAction {
  const state = occupied(ctx, t.note.path, t.note.id, t.hash);
  if (state === 'same') return { kind: 'adopt', ...t };
  if (state === 'free') return { kind: 'create', backup: false, ...t };
  if (ctx.opts.force) return { kind: 'create', backup: true, ...t };
  return { kind: 'conflict', noteId: t.note.id, path: t.note.path, reason: 'occupied' };
}

function planExisting(ctx: Ctx, t: Target, row: OutNote): NoteAction {
  const current = ctx.disk.sha256(row.path);
  if (current === null) return { kind: 'restore', from: row.path, ...t };
  const edited = current !== row.hash;
  if (edited && !ctx.opts.force) {
    return { kind: 'conflict', noteId: t.note.id, path: row.path, reason: 'edited' };
  }
  if (row.path !== t.note.path) {
    const caseOnly = nameKey(row.path) === nameKey(t.note.path);
    const target = caseOnly ? 'free' : occupied(ctx, t.note.path, t.note.id, t.hash);
    if (target === 'foreign' && !ctx.opts.force) {
      return { kind: 'conflict', noteId: t.note.id, path: t.note.path, reason: 'occupied' };
    }
    const rewrite = t.hash !== row.hash || edited;
    return { kind: 'move', from: row.path, rewrite, backup: edited || target === 'foreign', ...t };
  }
  if (t.hash !== row.hash || edited) return { kind: 'update', backup: edited, ...t };
  return { kind: 'skip', ...t };
}

function planRetire(ctx: Ctx, row: OutNote, desired: ReadonlySet<string>): NoteAction {
  const current = ctx.disk.sha256(row.path);
  if (current === null) return { kind: 'retire', row, to: null, mode: 'forget' };
  const { deletions, deletedFolder, force } = ctx.opts;
  if (deletions === 'delete') {
    if (current !== row.hash && !force) {
      return { kind: 'conflict', noteId: row.noteId, path: row.path, reason: 'edited' };
    }
    return { kind: 'retire', row, to: null, mode: force ? 'delete' : 'keep' };
  }
  if (deletions === 'keep' || row.path.startsWith(`${deletedFolder}/`)) {
    return { kind: 'retire', row, to: null, mode: 'keep' };
  }
  const to = `${deletedFolder}/${posix.basename(row.path)}`;
  const blocked = ctx.disk.sha256(to) !== null || desired.has(nameKey(to));
  return { kind: 'retire', row, to: blocked ? null : to, mode: blocked ? 'keep' : 'move' };
}

interface AttachmentCtx {
  readonly disk: DiskState;
  readonly priorByPath: ReadonlyMap<string, OutAttachment>;
}

/** null = fine as is; 'fetch' = download; otherwise a row to (re)record. */
function desiredState(
  ctx: AttachmentCtx,
  file: FileMeta,
  path: string,
): 'fetch' | AttachmentAction | null {
  const row = ctx.priorByPath.get(path);
  const sameFile = row?.fileId === file.id;
  const expected = file.md5hex ?? (sameFile ? (row?.md5 ?? null) : null);
  const onDisk = ctx.disk.md5(path);
  if (onDisk === null || onDisk !== expected) return 'fetch';
  return sameFile && row?.md5 === onDisk ? null : { kind: 'record', file, path, md5: onDisk };
}

function planStale(row: OutAttachment, disk: DiskState): AttachmentAction {
  const onDisk = disk.md5(row.path);
  if (onDisk === row.md5) return { kind: 'gc', row };
  return { kind: 'forget', row, reason: onDisk === null ? 'missing' : 'modified' };
}

function planAttachments(
  plan: RenderPlan,
  prior: readonly OutAttachment[],
  disk: DiskState,
): AttachmentAction[] {
  const ctx: AttachmentCtx = { disk, priorByPath: new Map(prior.map((r) => [r.path, r])) };
  const actions: AttachmentAction[] = [];
  for (const a of plan.attachments) {
    const states = a.paths.map((path) => ({ path, state: desiredState(ctx, a.file, path) }));
    const fetch = states.filter((x) => x.state === 'fetch').map((x) => x.path);
    for (const { state } of states) if (state !== null && state !== 'fetch') actions.push(state);
    if (fetch.length > 0) actions.push({ kind: 'fetch', file: a.file, paths: fetch });
  }
  const wanted = new Set(plan.attachments.flatMap((a) => a.paths));
  for (const row of prior) if (!wanted.has(row.path)) actions.push(planStale(row, disk));
  return actions;
}

function count(notes: readonly NoteAction[], attachments: readonly AttachmentAction[]) {
  const stats: Partial<Record<ActionKind, number>> = {};
  const bump = (k: ActionKind) => {
    stats[k] = (stats[k] ?? 0) + 1;
  };
  for (const a of notes) bump(a.kind);
  for (const a of attachments) bump(`attachment:${a.kind}`);
  return stats;
}

/**
 * Pure: decides what to do with every note and attachment given the desired render, what the
 * previous run wrote, and what is on disk now. Edited files are never overwritten without
 * `force` (and then only after a backup).
 */
export function planSync(
  plan: RenderPlan,
  prior: readonly OutNote[],
  priorAttachments: readonly OutAttachment[],
  disk: DiskState,
  opts: PlanOptions,
): SyncPlan {
  const ctx: Ctx = {
    disk,
    opts,
    owners: new Map(prior.map((r) => [nameKey(r.path), r.noteId])),
  };
  const priorById = new Map(prior.map((r) => [r.noteId, r]));
  const desired = new Set(plan.notes.map((n) => nameKey(n.path)));
  const notes: NoteAction[] = plan.notes.map((note) => {
    const t: Target = { note, hash: sha256Hex(note.content) };
    const row = priorById.get(note.id);
    return row ? planExisting(ctx, t, row) : planNew(ctx, t);
  });
  const rendered = new Set(plan.notes.map((n) => n.id));
  for (const row of prior) {
    if (!rendered.has(row.noteId)) notes.push(planRetire(ctx, row, desired));
  }
  const attachments = planAttachments(plan, priorAttachments, disk);
  return { notes, attachments, stats: count(notes, attachments) };
}

/** True when applying the plan would change anything on disk or in the state. */
export function hasPendingWork(plan: SyncPlan): boolean {
  return (
    plan.notes.some((a) => a.kind !== 'skip' && a.kind !== 'conflict') ||
    plan.attachments.length > 0
  );
}
