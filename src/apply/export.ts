import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AttachmentPlacement, RenderPlan } from '../plan/render.ts';
import type { Platform } from '../platform/types.ts';
import type { Source } from '../source/types.ts';
import { CliError, ExitCode, errorMessage } from '../util/errors.ts';
import { mapLimit } from '../util/pool.ts';
import { writeAtomic } from './writer.ts';

export const STAGING_MARKER = '.ink2miao-staging';

export interface ExportDeps {
  readonly source: Source;
  readonly platform: Platform;
  readonly signal: AbortSignal;
  readonly concurrency: number;
  readonly onProgress?: (done: number, total: number, phase: 'notes' | 'attachments') => void;
}

export interface Failure {
  readonly path: string;
  readonly error: string;
}

export interface ExportResult {
  readonly notesWritten: number;
  readonly attachmentsWritten: number;
  readonly attachmentFailures: readonly Failure[];
  readonly metadataFailures: readonly Failure[];
}

/**
 * Makes `dir` an empty staging directory. Only directories that are empty or that ink2miao
 * created (marker file) are ever wiped, and never the MiaoYan library itself.
 */
export async function prepareStaging(dir: string, target: string): Promise<void> {
  if (resolve(dir) === resolve(target)) {
    throw new CliError('staging must not be the MiaoYan library', ExitCode.Usage);
  }
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir);
  const owned = entries.includes(STAGING_MARKER);
  const visible = entries.filter((e) => e !== '.DS_Store');
  if (!owned && visible.length > 0) {
    throw new CliError(
      `refusing to wipe ${dir}: it is not empty and was not created by ink2miao`,
      ExitCode.Usage,
      'choose an empty directory with --staging',
    );
  }
  for (const e of entries) {
    if (e !== STAGING_MARKER) await rm(join(dir, e), { recursive: true, force: true });
  }
  await writeFile(join(dir, STAGING_MARKER), 'ink2miao staging directory\n');
}

export function isStaging(dir: string): boolean {
  return existsSync(join(dir, STAGING_MARKER));
}

function applyMetadata(
  platform: Platform,
  path: string,
  times: { created: number; modified: number },
  pinned: boolean | null,
  failures: Failure[],
): void {
  try {
    platform.setTimes(path, times.created, times.modified);
    if (pinned !== null) platform.setPinned(path, pinned);
  } catch (e) {
    failures.push({ path, error: errorMessage(e) });
  }
}

async function writeAttachment(
  root: string,
  a: AttachmentPlacement,
  deps: ExportDeps,
  metadataFailures: Failure[],
): Promise<number> {
  const bytes = await deps.source.attachment(a.file, deps.signal);
  for (const rel of a.paths) {
    const abs = join(root, rel);
    await writeAtomic(abs, bytes);
    const t = a.file.createdAt;
    applyMetadata(deps.platform, abs, { created: t, modified: t }, null, metadataFailures);
  }
  return a.paths.length;
}

/** Writes every rendered note and attachment into `root`, then applies times and pins. */
export async function writePlan(
  root: string,
  plan: RenderPlan,
  deps: ExportDeps,
): Promise<ExportResult> {
  const metadataFailures: Failure[] = [];
  let done = 0;
  const notes = await mapLimit(plan.notes, 8, deps.signal, async (n) => {
    const abs = join(root, n.path);
    await writeAtomic(abs, n.content);
    const times = { created: n.createdAt, modified: n.updatedAt };
    applyMetadata(deps.platform, abs, times, n.pinned, metadataFailures);
    deps.onProgress?.(++done, plan.notes.length, 'notes');
  });
  const failedNote = notes.find((r) => !r.ok);
  if (failedNote) {
    throw new Error(`cannot write ${failedNote.item.path}: ${errorMessage(failedNote.error)}`);
  }

  done = 0;
  const files = await mapLimit(plan.attachments, deps.concurrency, deps.signal, async (a) => {
    const n = await writeAttachment(root, a, deps, metadataFailures);
    deps.onProgress?.(++done, plan.attachments.length, 'attachments');
    return n;
  });
  const attachmentFailures = files
    .filter((r) => !r.ok)
    .map((r) => ({ path: r.item.paths[0] ?? r.item.name, error: errorMessage(r.error) }));

  return {
    notesWritten: notes.length,
    attachmentsWritten: files.reduce((sum, r) => sum + (r.value ?? 0), 0),
    attachmentFailures,
    metadataFailures,
  };
}
