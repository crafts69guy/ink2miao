import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { TEMP_PREFIX, writeAtomic } from '../apply/writer.ts';
import type { NoteId } from '../domain/model.ts';
import type { Platform } from '../platform/types.ts';
import type { PromotedFile, PromotedNote } from '../state/db.ts';
import { errorMessage } from '../util/errors.ts';
import type { PromoteFileAction, PromoteNoteAction, PromotePlan } from './planner.ts';

export interface PromoteStore {
  putPromotedNote(target: string, row: PromotedNote): void;
  deletePromotedNote(target: string, noteId: NoteId): void;
  putPromotedFile(target: string, row: PromotedFile): void;
  deletePromotedFile(target: string, path: string): void;
}

export interface PromoteDeps {
  readonly staging: string;
  readonly target: string;
  readonly store: PromoteStore;
  readonly platform: Platform;
  readonly signal: AbortSignal;
  readonly backupDir: string;
}

export interface PromoteResult {
  readonly copied: number;
  readonly moved: number;
  readonly retired: number;
  readonly filesCopied: number;
  readonly filesRemoved: number;
  readonly backups: readonly string[];
  readonly metadataFailures: readonly { path: string; error: string }[];
}

interface Run {
  readonly deps: PromoteDeps;
  readonly touched: Set<string>;
  readonly backups: string[];
  readonly metadataFailures: { path: string; error: string }[];
}

const inTarget = (run: Run, rel: string) => join(run.deps.target, rel);
const inStaging = (run: Run, rel: string) => join(run.deps.staging, rel);

async function backup(run: Run, rel: string): Promise<void> {
  const dest = join(run.deps.backupDir, rel);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(inTarget(run, rel), dest);
  run.backups.push(rel);
}

/** Copies birth/mod times and the pin flag from the staged file (copies lose both). */
async function copyMetadata(run: Run, rel: string, withPin: boolean): Promise<void> {
  const { platform } = run.deps;
  try {
    const st = await stat(inStaging(run, rel));
    platform.setTimes(inTarget(run, rel), st.birthtime.getTime(), st.mtime.getTime());
    if (withPin) platform.setPinned(inTarget(run, rel), platform.isPinned(inStaging(run, rel)));
  } catch (e) {
    run.metadataFailures.push({ path: rel, error: errorMessage(e) });
  }
}

async function copyIn(run: Run, rel: string, withPin: boolean): Promise<void> {
  await writeAtomic(inTarget(run, rel), await readFile(inStaging(run, rel)));
  await copyMetadata(run, rel, withPin);
}

function parkSource(a: PromoteNoteAction): string | null {
  if (a.kind === 'move') return a.from;
  return a.kind === 'retire' && a.mode === 'move' ? a.row.path : null;
}

async function park(run: Run, actions: readonly PromoteNoteAction[]) {
  const parked = new Map<PromoteNoteAction, string>();
  for (const a of actions) {
    const from = parkSource(a);
    if (from === null) continue;
    if (a.kind === 'move' && a.backup) await backup(run, from);
    const tmp = `${TEMP_PREFIX}mv-${randomBytes(6).toString('hex')}.tmp`;
    await rename(inTarget(run, from), inTarget(run, tmp));
    run.touched.add(dirname(from));
    parked.set(a, tmp);
  }
  return parked;
}

async function place(run: Run, tmp: string, to: string): Promise<void> {
  await mkdir(dirname(inTarget(run, to)), { recursive: true });
  await rename(inTarget(run, tmp), inTarget(run, to));
}

type Work = Exclude<PromoteNoteAction, { kind: 'skip' | 'conflict' }>;

function isWork(a: PromoteNoteAction): a is Work {
  return a.kind !== 'skip' && a.kind !== 'conflict';
}

async function applyNote(run: Run, a: Work, parked: ReadonlyMap<PromoteNoteAction, string>) {
  const { store, target } = run.deps;
  switch (a.kind) {
    case 'copy':
      if (a.backup) await backup(run, a.staged.path);
      await copyIn(run, a.staged.path, true);
      break;
    case 'move':
      await place(run, parked.get(a) as string, a.staged.path);
      if (a.rewrite) await copyIn(run, a.staged.path, true);
      else await copyMetadata(run, a.staged.path, true);
      break;
    case 'adopt':
      await copyMetadata(run, a.staged.path, true);
      break;
    case 'retire':
      if (a.mode === 'move') await place(run, parked.get(a) as string, a.to as string);
      if (a.mode === 'delete') {
        await backup(run, a.row.path);
        await rm(inTarget(run, a.row.path));
        run.touched.add(dirname(a.row.path));
      }
      store.deletePromotedNote(target, a.row.noteId);
      return;
  }
  store.putPromotedNote(target, {
    noteId: a.staged.noteId,
    path: a.staged.path,
    hash: a.staged.hash,
  });
}

async function applyFile(run: Run, a: PromoteFileAction): Promise<'copied' | 'removed' | null> {
  const { store, target } = run.deps;
  switch (a.kind) {
    case 'copy':
      if (a.backup) await backup(run, a.staged.path);
      await copyIn(run, a.staged.path, false);
      store.putPromotedFile(target, { path: a.staged.path, md5: a.staged.md5 });
      return 'copied';
    case 'record':
      store.putPromotedFile(target, { path: a.staged.path, md5: a.staged.md5 });
      return null;
    case 'remove':
      await rm(inTarget(run, a.row.path), { force: true });
      run.touched.add(dirname(a.row.path));
      store.deletePromotedFile(target, a.row.path);
      return 'removed';
    case 'forget':
      store.deletePromotedFile(target, a.row.path);
      return null;
    case 'conflict':
      return null;
  }
}

async function prune(run: Run): Promise<void> {
  for (const start of [...run.touched].sort((a, b) => b.length - a.length)) {
    for (let d = start; d !== '.' && d !== ''; d = dirname(d)) {
      const removed = await rmdir(inTarget(run, d)).then(
        () => true,
        () => false,
      );
      if (!removed) break;
    }
  }
}

/** Applies a promote plan to the MiaoYan library, recording each completed action. */
export async function executePromote(plan: PromotePlan, deps: PromoteDeps): Promise<PromoteResult> {
  const run: Run = { deps, touched: new Set(), backups: [], metadataFailures: [] };
  const parked = await park(run, plan.notes);
  const work = plan.notes.filter(isWork);
  const ordered = [...work.filter((a) => parked.has(a)), ...work.filter((a) => !parked.has(a))];
  const done: PromoteNoteAction['kind'][] = [];
  for (const a of ordered) {
    if (deps.signal.aborted && !parked.has(a)) break;
    await applyNote(run, a, parked);
    done.push(a.kind);
  }
  let filesCopied = 0;
  let filesRemoved = 0;
  for (const a of plan.files) {
    if (deps.signal.aborted) break;
    const r = await applyFile(run, a);
    if (r === 'copied') filesCopied++;
    if (r === 'removed') filesRemoved++;
  }
  await prune(run);
  return {
    copied: done.filter((k) => k === 'copy').length,
    moved: done.filter((k) => k === 'move').length,
    retired: done.filter((k) => k === 'retire').length,
    filesCopied,
    filesRemoved,
    backups: run.backups,
    metadataFailures: run.metadataFailures,
  };
}
