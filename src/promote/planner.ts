import { posix } from 'node:path';
import type { NoteId } from '../domain/model.ts';
import { nameKey } from '../naming/sanitize.ts';
import type { DeletionMode, DiskState } from '../plan/planner.ts';
import type { OutAttachment, OutNote, PromotedFile, PromotedNote } from '../state/db.ts';

export interface PromoteOptions {
  readonly force: boolean;
  readonly deletions: DeletionMode;
  readonly deletedFolder: string;
}

export type PromoteConflictReason = 'edited' | 'deleted' | 'occupied' | 'staging-dirty';

export type PromoteNoteAction =
  | { kind: 'copy'; staged: OutNote; backup: boolean }
  | { kind: 'move'; staged: OutNote; from: string; rewrite: boolean; backup: boolean }
  | { kind: 'adopt' | 'skip'; staged: OutNote }
  | { kind: 'retire'; row: PromotedNote; to: string | null; mode: DeletionMode | 'forget' }
  | { kind: 'conflict'; noteId: NoteId; path: string; reason: PromoteConflictReason };

export type PromoteFileAction =
  | { kind: 'copy'; staged: OutAttachment; backup: boolean }
  | { kind: 'record'; staged: OutAttachment }
  | { kind: 'remove' | 'forget'; row: PromotedFile }
  | { kind: 'conflict'; path: string; reason: 'edited' | 'occupied' };

export interface PromotePlan {
  readonly notes: readonly PromoteNoteAction[];
  readonly files: readonly PromoteFileAction[];
  readonly stats: Readonly<Record<string, number>>;
}

interface Ctx {
  readonly staging: DiskState;
  readonly target: DiskState;
  readonly opts: PromoteOptions;
  readonly owners: ReadonlyMap<string, NoteId>;
}

function conflict(s: OutNote, path: string, reason: PromoteConflictReason): PromoteNoteAction {
  return { kind: 'conflict', noteId: s.noteId, path, reason };
}

function planNewNote(ctx: Ctx, s: OutNote): PromoteNoteAction {
  const there = ctx.target.sha256(s.path);
  if (there === null) return { kind: 'copy', staged: s, backup: false };
  if (there === s.hash) return { kind: 'adopt', staged: s };
  const owner = ctx.owners.get(nameKey(s.path));
  if (owner !== undefined && owner !== s.noteId) return { kind: 'copy', staged: s, backup: false };
  return ctx.opts.force
    ? { kind: 'copy', staged: s, backup: true }
    : conflict(s, s.path, 'occupied');
}

function planKnownNote(ctx: Ctx, s: OutNote, p: PromotedNote): PromoteNoteAction {
  const current = ctx.target.sha256(p.path);
  // Deleted in MiaoYan: do not resurrect it unless forced.
  if (current === null) {
    return ctx.opts.force
      ? { kind: 'copy', staged: s, backup: false }
      : conflict(s, p.path, 'deleted');
  }
  const edited = current !== p.hash;
  if (edited && !ctx.opts.force) return conflict(s, p.path, 'edited');
  if (p.path !== s.path) {
    return {
      kind: 'move',
      staged: s,
      from: p.path,
      rewrite: edited || p.hash !== s.hash,
      backup: edited,
    };
  }
  if (edited || p.hash !== s.hash) return { kind: 'copy', staged: s, backup: edited };
  return { kind: 'skip', staged: s };
}

function planRetire(ctx: Ctx, row: PromotedNote, desired: ReadonlySet<string>): PromoteNoteAction {
  const current = ctx.target.sha256(row.path);
  if (current === null) return { kind: 'retire', row, to: null, mode: 'forget' };
  const { deletions, deletedFolder, force } = ctx.opts;
  if (current !== row.hash) {
    if (deletions === 'delete' && !force) {
      return { kind: 'conflict', noteId: row.noteId, path: row.path, reason: 'edited' };
    }
    if (deletions !== 'delete') return { kind: 'retire', row, to: null, mode: 'keep' };
  }
  if (deletions === 'delete')
    return { kind: 'retire', row, to: null, mode: force ? 'delete' : 'keep' };
  if (deletions === 'keep' || row.path.startsWith(`${deletedFolder}/`)) {
    return { kind: 'retire', row, to: null, mode: 'keep' };
  }
  const to = `${deletedFolder}/${posix.basename(row.path)}`;
  const blocked = ctx.target.sha256(to) !== null || desired.has(nameKey(to));
  return { kind: 'retire', row, to: blocked ? null : to, mode: blocked ? 'keep' : 'move' };
}

function planFile(
  target: DiskState,
  force: boolean,
  s: OutAttachment,
  p: PromotedFile | undefined,
): PromoteFileAction | null {
  const current = target.md5(s.path);
  if (current === null) return { kind: 'copy', staged: s, backup: false };
  if (current === s.md5) return p?.md5 === s.md5 ? null : { kind: 'record', staged: s };
  if (p && current === p.md5) return { kind: 'copy', staged: s, backup: false };
  if (force) return { kind: 'copy', staged: s, backup: true };
  return { kind: 'conflict', path: s.path, reason: p ? 'edited' : 'occupied' };
}

function planFiles(
  ctx: Ctx,
  staged: readonly OutAttachment[],
  promoted: readonly PromotedFile[],
): PromoteFileAction[] {
  const byPath = new Map(promoted.map((p) => [p.path, p]));
  const actions: PromoteFileAction[] = [];
  for (const s of staged) {
    if (ctx.staging.md5(s.path) !== s.md5) continue;
    const action = planFile(ctx.target, ctx.opts.force, s, byPath.get(s.path));
    if (action) actions.push(action);
  }
  const wanted = new Set(staged.map((s) => s.path));
  for (const row of promoted) {
    if (wanted.has(row.path)) continue;
    const current = ctx.target.md5(row.path);
    actions.push({ kind: current === row.md5 ? 'remove' : 'forget', row });
  }
  return actions;
}

function tally(notes: readonly PromoteNoteAction[], files: readonly PromoteFileAction[]) {
  const stats: Record<string, number> = {};
  for (const k of [...notes.map((a) => a.kind), ...files.map((a) => `file:${a.kind}`)]) {
    stats[k] = (stats[k] ?? 0) + 1;
  }
  return stats;
}

/**
 * Pure: decides how to bring the library (`target`) in line with staging, given what was
 * promoted before. Changes made in MiaoYan (edits, deletions) are conflicts unless forced.
 */
export function planPromote(
  staged: readonly OutNote[],
  stagedFiles: readonly OutAttachment[],
  promoted: readonly PromotedNote[],
  promotedFiles: readonly PromotedFile[],
  disks: { staging: DiskState; target: DiskState },
  opts: PromoteOptions,
): PromotePlan {
  const ctx: Ctx = {
    ...disks,
    opts,
    owners: new Map(promoted.map((p) => [nameKey(p.path), p.noteId])),
  };
  const byId = new Map(promoted.map((p) => [p.noteId, p]));
  const notes: PromoteNoteAction[] = staged.map((s) => {
    if (disks.staging.sha256(s.path) !== s.hash) return conflict(s, s.path, 'staging-dirty');
    const p = byId.get(s.noteId);
    return p ? planKnownNote(ctx, s, p) : planNewNote(ctx, s);
  });
  const stagedIds = new Set(staged.map((s) => s.noteId));
  const desired = new Set(staged.map((s) => nameKey(s.path)));
  for (const row of promoted) {
    if (!stagedIds.has(row.noteId)) notes.push(planRetire(ctx, row, desired));
  }
  const files = planFiles(ctx, stagedFiles, promotedFiles);
  return { notes, files, stats: tally(notes, files) };
}
