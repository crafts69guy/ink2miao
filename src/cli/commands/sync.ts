import { join } from 'node:path';
import { executePlan } from '../../apply/executor.ts';
import { ensureStaging, prepareStaging } from '../../apply/export.ts';
import { sweepTempFiles } from '../../apply/writer.ts';
import { profileStateDir } from '../../config/load.ts';
import { fileLink } from '../../report/printer.ts';
import { buildSyncReport, describeChanges, type SyncReport } from '../../report/sync-report.ts';
import { acquireLock } from '../../state/lock.ts';
import { type ExitCode as Code, ExitCode } from '../../util/errors.ts';
import type { Session } from '../context.ts';
import { computePlan } from './planning.ts';

export interface SyncFlags {
  readonly dryRun?: boolean | undefined;
  readonly full?: boolean | undefined;
  readonly force?: boolean | undefined;
  readonly rebuild?: boolean | undefined;
}

export const LAST_SEQ = 'last_seq';
export const LAST_REPORT = 'last_report';

/** Mirrors Inkdrop changes into the local state db; returns the server version. */
export async function pull(
  s: Session,
  full: boolean,
): Promise<{ version: string; fetched: number }> {
  const { signal } = s.deps;
  const db = s.db();
  const source = s.source();
  const { version } = await source.probe(signal);
  let fetched = 0;
  for await (const batch of source.changes(full ? null : db.getMeta(LAST_SEQ), signal)) {
    db.upsertDocs(batch.changes);
    db.setMeta(LAST_SEQ, batch.lastSeq);
    fetched += batch.changes.length;
    s.printer.progress('fetching changes', fetched, fetched);
  }
  s.printer.debug(`fetched ${fetched} changes from ${source.describe}`);
  return { version, fetched };
}

function summarize(s: Session, r: SyncReport): void {
  const p = s.printer;
  const c = r.counts;
  const ok = p.c.green('✓');
  p.line(
    `${ok} Inkdrop ${r.inkdropVersion}: ${c.notes} notes (${c.live} live, ${c.retired} deleted)`,
  );
  const target = fileLink(r.staging, r.staging, s.deps.stdoutTTY);
  p.line(
    `${ok} ${r.dryRun ? 'Would apply' : 'Applied'}: ${describeChanges(r.changes)} → ${target}`,
  );
  for (const x of r.conflicts) p.warn(`conflict (${x.reason}): ${x.path}`);
  if (r.conflicts.length > 0) {
    p.info(
      p.c.dim(
        'conflicting files were left untouched; `sync --force` overwrites them after a backup',
      ),
    );
  }
  if (r.backups.length > 0) p.info(`backed up ${r.backups.length} files`);
  if (r.unresolved.length + r.renames.length > 0) {
    p.warn(
      `${r.unresolved.length} unresolved references, ${r.renames.length} renamed titles — see \`ink2miao report\``,
    );
  }
  for (const f of r.attachmentFailures) p.error(`attachment ${f.path}: ${f.error}`);
  if (r.metadataFailures.length > 0) p.warn(`${r.metadataFailures.length} files without dates/pin`);
  if (!r.dryRun) p.info(p.c.dim('next: ink2miao verify'));
}

export async function syncCommand(s: Session, flags: SyncFlags): Promise<Code> {
  const stateDir = profileStateDir(s.loaded);
  const lock = acquireLock(join(stateDir, 'lock'));
  try {
    const rebuild = flags.rebuild === true;
    const { version } = await pull(s, flags.full === true || rebuild);
    const { staging, target, concurrency } = s.loaded.config;
    if (!flags.dryRun) {
      if (rebuild) {
        await prepareStaging(staging, target);
        s.db().clearOutputs();
      } else {
        await ensureStaging(staging, target);
      }
      await sweepTempFiles(staging);
    }
    const planned = computePlan(s, { fresh: rebuild, force: flags.force === true });
    const runId = new Date(s.deps.now()).toISOString().replaceAll(':', '-');
    const exec = flags.dryRun
      ? null
      : await executePlan(planned.plan, {
          root: staging,
          store: s.db(),
          source: s.source(),
          platform: s.deps.platform,
          signal: s.deps.signal,
          concurrency,
          backupDir: join(stateDir, 'backups', runId),
          onProgress: (done, total, phase) => s.printer.progress(`writing ${phase}`, done, total),
        });
    const report = buildSyncReport({
      render: planned.render,
      plan: planned.plan,
      exec,
      source: s.source().describe,
      inkdropVersion: version,
      staging,
      invalidDocs: planned.invalidDocs,
      now: s.deps.now(),
    });
    s.db().setMeta(LAST_REPORT, JSON.stringify(report));
    s.printer.event('sync', { report });
    summarize(s, report);
    if (s.deps.signal.aborted) return ExitCode.Interrupted;
    if (report.conflicts.length > 0) return ExitCode.Conflict;
    return report.attachmentFailures.length > 0 ? ExitCode.Internal : ExitCode.Ok;
  } finally {
    lock.release();
  }
}
