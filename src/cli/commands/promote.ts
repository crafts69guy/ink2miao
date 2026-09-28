import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { diskState } from '../../apply/disk.ts';
import { isStaging } from '../../apply/export.ts';
import { profileStateDir } from '../../config/load.ts';
import { executePromote, type PromoteResult } from '../../promote/apply.ts';
import { type PromotePlan, planPromote } from '../../promote/planner.ts';
import { fileLink } from '../../report/printer.ts';
import { acquireLock } from '../../state/lock.ts';
import { CliError, type ExitCode as Code, ExitCode } from '../../util/errors.ts';
import { sleep } from '../../util/retry.ts';
import { waitForChange } from '../../util/watch.ts';
import type { Session } from '../context.ts';

export interface PromoteFlags {
  readonly dryRun?: boolean | undefined;
  readonly force?: boolean | undefined;
  readonly wait?: boolean | undefined;
  readonly watch?: boolean | undefined;
}

const LABELS: readonly [string, string][] = [
  ['copy', 'copied'],
  ['move', 'moved'],
  ['adopt', 'adopted'],
  ['retire', 'retired'],
  ['conflict', 'conflicts'],
  ['skip', 'unchanged'],
  ['file:copy', 'attachments copied'],
  ['file:record', 'attachments recorded'],
  ['file:remove', 'attachments removed'],
  ['file:forget', 'attachments forgotten'],
  ['file:conflict', 'attachment conflicts'],
];

export function describePromote(stats: Readonly<Record<string, number>>): string {
  const parts = LABELS.flatMap(([k, label]) =>
    (stats[k] ?? 0) > 0 ? [`${stats[k]} ${label}`] : [],
  );
  return parts.length > 0 ? parts.join(', ') : 'nothing to do';
}

async function waitForQuit(s: Session): Promise<void> {
  const { platform, pollMs, signal } = s.deps;
  if (!platform.isMiaoYanRunning()) return;
  s.printer.info('waiting for MiaoYan to quit…');
  while (platform.isMiaoYanRunning()) await sleep(pollMs, signal);
}

async function ensureNotRunning(s: Session, flags: PromoteFlags): Promise<void> {
  if (flags.dryRun || flags.force || !s.deps.platform.isMiaoYanRunning()) return;
  if (!flags.wait && !flags.watch) {
    throw new CliError(
      'MiaoYan is running; promoting now could race its file watcher',
      ExitCode.MiaoYanRunning,
      'quit MiaoYan, or use --wait',
    );
  }
  await waitForQuit(s);
}

function summarize(
  s: Session,
  target: string,
  plan: PromotePlan,
  result: PromoteResult | null,
): number {
  const p = s.printer;
  p.event('promote', { target, stats: plan.stats, result });
  const where = fileLink(target, target, s.deps.stdoutTTY);
  const verb = result === null ? 'Would promote' : 'Promoted';
  p.line(`${p.c.green('✓')} ${verb}: ${describePromote(plan.stats)} → ${where}`);
  let conflicts = 0;
  for (const c of [...plan.notes, ...plan.files]) {
    if (c.kind !== 'conflict') continue;
    conflicts++;
    p.warn(`conflict (${c.reason}): ${c.path}`);
  }
  if (conflicts > 0) {
    p.info(
      p.c.dim('changes made in MiaoYan are kept; `promote --force` overwrites them after a backup'),
    );
  }
  if (result && result.backups.length > 0) p.info(`backed up ${result.backups.length} files`);
  if (result && result.metadataFailures.length > 0) {
    p.warn(`${result.metadataFailures.length} files without dates/pin`);
  }
  return conflicts;
}

async function cycle(s: Session, flags: PromoteFlags, target: string): Promise<Code> {
  await ensureNotRunning(s, flags);
  const { staging, deletions, deletedFolder } = s.loaded.config;
  const db = s.db();
  const plan = planPromote(
    db.outNotes(),
    db.outAttachments(),
    db.promotedNotes(target),
    db.promotedFiles(target),
    { staging: diskState(staging), target: diskState(target) },
    { force: flags.force === true, deletions, deletedFolder },
  );
  const runId = new Date(s.deps.now()).toISOString().replaceAll(':', '-');
  const result = flags.dryRun
    ? null
    : await executePromote(plan, {
        staging,
        target,
        store: db,
        platform: s.deps.platform,
        signal: s.deps.signal,
        backupDir: join(profileStateDir(s.loaded), 'backups', `promote-${runId}`),
      });
  return summarize(s, target, plan, result) > 0 ? ExitCode.Conflict : ExitCode.Ok;
}

/** Copies staging into the MiaoYan library, keeping changes made in MiaoYan safe. */
export async function promoteCommand(s: Session, flags: PromoteFlags): Promise<Code> {
  const { staging } = s.loaded.config;
  const target = resolve(s.target());
  if (!isStaging(staging)) {
    throw new CliError(
      `${staging} is not an ink2miao staging directory`,
      ExitCode.Usage,
      'run `ink2miao sync` first',
    );
  }
  if (target === resolve(staging)) {
    throw new CliError('the MiaoYan library must not be the staging directory', ExitCode.Usage);
  }
  if (!existsSync(target)) {
    throw new CliError(
      `MiaoYan library not found: ${target}`,
      ExitCode.Usage,
      'open MiaoYan once, or set `target` / --target',
    );
  }
  const lock = acquireLock(join(profileStateDir(s.loaded), 'lock'));
  try {
    let code = await cycle(s, flags, target);
    while (flags.watch && !s.deps.signal.aborted) {
      s.printer.info(s.printer.c.dim('watching staging for changes… (Ctrl-C to stop)'));
      const changed = await waitForChange(staging, s.deps.debounceMs, s.deps.signal).then(
        () => true,
        () => false,
      );
      if (!changed) return ExitCode.Ok;
      code = await cycle(s, flags, target);
    }
    return code;
  } finally {
    lock.release();
  }
}
