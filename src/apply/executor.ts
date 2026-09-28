import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FileId } from '../domain/model.ts';
import type { AttachmentAction, NoteAction, SyncPlan } from '../plan/planner.ts';
import type { RenderedNote } from '../plan/render.ts';
import type { Platform } from '../platform/types.ts';
import type { Source } from '../source/types.ts';
import type { OutAttachment, OutNote } from '../state/db.ts';
import { errorMessage } from '../util/errors.ts';
import { mapLimit } from '../util/pool.ts';
import { TEMP_PREFIX, writeAtomic } from './writer.ts';

/** The subset of the state db the executor updates, one row per completed action. */
export interface OutputStore {
  putOutNote(row: OutNote): void;
  deleteOutNote(noteId: OutNote['noteId']): void;
  putOutAttachment(row: OutAttachment): void;
  deleteOutAttachment(path: string): void;
}

export interface ExecDeps {
  readonly root: string;
  readonly store: OutputStore;
  readonly source: Source;
  readonly platform: Platform;
  readonly signal: AbortSignal;
  readonly concurrency: number;
  /** Where overwritten or deleted files are copied first (`--force`). */
  readonly backupDir: string;
  readonly onProgress?: (done: number, total: number, phase: 'notes' | 'attachments') => void;
}

export interface Failure {
  readonly path: string;
  readonly error: string;
}

export interface ExecResult {
  readonly written: number;
  readonly moved: number;
  readonly retired: number;
  readonly backups: readonly string[];
  readonly attachmentsWritten: number;
  readonly attachmentsRemoved: number;
  readonly attachmentFailures: readonly Failure[];
  readonly metadataFailures: readonly Failure[];
}

type Written = Extract<NoteAction, { note: RenderedNote }>;

interface Run {
  readonly deps: ExecDeps;
  readonly touchedDirs: Set<string>;
  readonly backups: string[];
  readonly metadataFailures: Failure[];
}

const abs = (run: Run, rel: string) => join(run.deps.root, rel);

async function backup(run: Run, rel: string): Promise<void> {
  const dest = join(run.deps.backupDir, rel);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(abs(run, rel), dest);
  run.backups.push(rel);
}

function applyMetadata(run: Run, note: RenderedNote): void {
  const path = abs(run, note.path);
  try {
    run.deps.platform.setTimes(path, note.createdAt, note.updatedAt);
    run.deps.platform.setPinned(path, note.pinned);
  } catch (e) {
    run.metadataFailures.push({ path: note.path, error: errorMessage(e) });
  }
}

function record(run: Run, a: Written): void {
  run.deps.store.putOutNote({
    noteId: a.note.id,
    sourceTitle: a.note.sourceTitle,
    stem: a.note.stem,
    path: a.note.path,
    hash: a.hash,
  });
}

function parkSource(a: NoteAction): string | null {
  if (a.kind === 'move') return a.from;
  return a.kind === 'retire' && a.mode === 'move' ? a.row.path : null;
}

/** Phase one: park every file that moves (or retires by moving) under a hidden temp name. */
async function park(run: Run, actions: readonly NoteAction[]): Promise<Map<NoteAction, string>> {
  const parked = new Map<NoteAction, string>();
  for (const a of actions) {
    const from = parkSource(a);
    if (from === null) continue;
    if (a.kind === 'move' && a.backup) await backup(run, from);
    const tmp = `${TEMP_PREFIX}mv-${randomBytes(6).toString('hex')}.tmp`;
    await rename(abs(run, from), abs(run, tmp));
    run.touchedDirs.add(dirname(from));
    parked.set(a, tmp);
  }
  return parked;
}

async function place(run: Run, tmp: string, to: string): Promise<void> {
  await mkdir(dirname(abs(run, to)), { recursive: true });
  await rename(abs(run, tmp), abs(run, to));
}

async function applyNote(run: Run, a: NoteAction, parked: ReadonlyMap<NoteAction, string>) {
  switch (a.kind) {
    case 'move': {
      await place(run, parked.get(a) as string, a.note.path);
      if (a.rewrite) await writeAtomic(abs(run, a.note.path), a.note.content);
      break;
    }
    case 'create':
    case 'update':
      if (a.backup) await backup(run, a.note.path);
      await writeAtomic(abs(run, a.note.path), a.note.content);
      break;
    case 'restore':
      await writeAtomic(abs(run, a.note.path), a.note.content);
      break;
    case 'retire':
      if (a.mode === 'move') await place(run, parked.get(a) as string, a.to as string);
      if (a.mode === 'delete') {
        await backup(run, a.row.path);
        await rm(abs(run, a.row.path));
        run.touchedDirs.add(dirname(a.row.path));
      }
      run.deps.store.deleteOutNote(a.row.noteId);
      return;
    default:
      if (a.kind !== 'adopt') return;
  }
  applyMetadata(run, a.note);
  record(run, a);
}

async function applyAttachments(run: Run, actions: readonly AttachmentAction[]) {
  const { deps } = run;
  let removed = 0;
  for (const a of actions) {
    if (a.kind === 'record')
      deps.store.putOutAttachment({ path: a.path, fileId: a.file.id, md5: a.md5 });
    if (a.kind === 'gc') {
      await rm(abs(run, a.row.path), { force: true });
      run.touchedDirs.add(dirname(a.row.path));
      removed++;
    }
    if (a.kind === 'gc' || a.kind === 'forget') deps.store.deleteOutAttachment(a.row.path);
  }
  const fetches = actions.filter(
    (a): a is Extract<AttachmentAction, { kind: 'fetch' }> => a.kind === 'fetch',
  );
  let done = 0;
  const results = await mapLimit(fetches, deps.concurrency, deps.signal, async (a) => {
    const bytes = await deps.source.attachment(a.file, deps.signal);
    const md5 = new Bun.CryptoHasher('md5').update(bytes).digest('hex');
    for (const rel of a.paths) {
      await writeAtomic(abs(run, rel), bytes);
      try {
        deps.platform.setTimes(abs(run, rel), a.file.createdAt, a.file.createdAt);
      } catch (e) {
        run.metadataFailures.push({ path: rel, error: errorMessage(e) });
      }
      deps.store.putOutAttachment({ path: rel, fileId: a.file.id as FileId, md5 });
    }
    deps.onProgress?.(++done, fetches.length, 'attachments');
    return a.paths.length;
  });
  const failures = results
    .filter((r) => !r.ok)
    .map((r) => ({ path: r.item.paths[0] as string, error: errorMessage(r.error) }));
  const written = results.reduce((n, r) => n + (r.value ?? 0), 0);
  return { written, removed, failures };
}

/** Removes directories emptied by moves or deletions, walking up to (not including) root. */
async function pruneEmptyDirs(run: Run): Promise<void> {
  const dirs = [...run.touchedDirs].sort((a, b) => b.length - a.length);
  for (const start of dirs) {
    for (let d = start; d !== '.' && d !== ''; d = dirname(d)) {
      const removed = await rmdir(abs(run, d)).then(
        () => true,
        () => false,
      );
      if (!removed) break;
    }
  }
}

/** Applies a sync plan to `deps.root`, committing each completed action to the store. */
export async function executePlan(plan: SyncPlan, deps: ExecDeps): Promise<ExecResult> {
  const run: Run = { deps, touchedDirs: new Set(), backups: [], metadataFailures: [] };
  const parked = await park(run, plan.notes);
  let done = 0;
  const work = plan.notes.filter((a) => a.kind !== 'skip' && a.kind !== 'conflict');
  // Parked files are placed first and unconditionally: an interrupt must not strand them.
  const ordered = [...work.filter((a) => parked.has(a)), ...work.filter((a) => !parked.has(a))];
  const applied: NoteAction['kind'][] = [];
  for (const a of ordered) {
    if (deps.signal.aborted && !parked.has(a)) break;
    await applyNote(run, a, parked);
    applied.push(a.kind);
    deps.onProgress?.(++done, work.length, 'notes');
  }
  const attachments = await applyAttachments(run, plan.attachments);
  await pruneEmptyDirs(run);
  const kinds = applied;
  return {
    written: kinds.filter((k) => k === 'create' || k === 'update' || k === 'restore').length,
    moved: kinds.filter((k) => k === 'move').length,
    retired: kinds.filter((k) => k === 'retire').length,
    backups: run.backups,
    attachmentsWritten: attachments.written,
    attachmentsRemoved: attachments.removed,
    attachmentFailures: attachments.failures,
    metadataFailures: run.metadataFailures,
  };
}
