import { prepareStaging, writePlan } from '../../apply/export.ts';
import { buildSnapshot } from '../../domain/snapshot.ts';
import { renderAll } from '../../plan/render.ts';
import { fileLink } from '../../report/printer.ts';
import { buildSyncReport, type SyncReport } from '../../report/sync-report.ts';
import { type ExitCode as Code, ExitCode } from '../../util/errors.ts';
import type { Session } from '../context.ts';

export interface SyncFlags {
  readonly dryRun?: boolean | undefined;
  readonly full?: boolean | undefined;
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
  const verb = r.dryRun ? 'Would write' : 'Wrote';
  p.line(
    `${ok} ${verb} ${c.notes} notes, ${c.attachments} attachments, ${c.folders} folders → ${target}`,
  );
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
  const { version } = await pull(s, flags.full === true);
  const { snapshot, invalid } = buildSnapshot(s.db().liveDocs());
  const plan = renderAll(snapshot, s.renderOptions());
  const { staging, target, concurrency } = s.loaded.config;

  let result = null;
  if (!flags.dryRun) {
    await prepareStaging(staging, target);
    result = await writePlan(staging, plan, {
      source: s.source(),
      platform: s.deps.platform,
      signal: s.deps.signal,
      concurrency,
      onProgress: (done, total, phase) => s.printer.progress(`writing ${phase}`, done, total),
    });
  }
  const report = buildSyncReport({
    plan,
    result,
    source: s.source().describe,
    inkdropVersion: version,
    staging,
    invalidDocs: invalid.length,
    now: s.deps.now(),
  });
  s.db().setMeta(LAST_REPORT, JSON.stringify(report));
  s.printer.event('sync', { report });
  summarize(s, report);
  return report.attachmentFailures.length > 0 ? ExitCode.Internal : ExitCode.Ok;
}
