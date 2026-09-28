import { hasPendingWork } from '../../plan/planner.ts';
import { describeChanges } from '../../report/sync-report.ts';
import { CliError, type ExitCode as Code, ExitCode } from '../../util/errors.ts';
import type { Session } from '../context.ts';
import { computePlan } from './planning.ts';
import { LAST_SEQ } from './sync.ts';

export interface StatusFlags {
  readonly remote?: boolean | undefined;
  readonly exitCode?: boolean | undefined;
}

async function remoteChanges(s: Session): Promise<number> {
  let n = 0;
  for await (const batch of s.source().changes(s.db().getMeta(LAST_SEQ), s.deps.signal)) {
    n += batch.changes.length;
  }
  return n;
}

/** Offline by default: what the next sync would do with the local mirror and staging. */
export async function statusCommand(s: Session, flags: StatusFlags): Promise<Code> {
  const planned = computePlan(s, { fresh: false, force: false });
  if (!planned.hasData) {
    throw new CliError(
      'no Inkdrop data in the local state',
      ExitCode.Usage,
      'run `ink2miao sync` first',
    );
  }
  const remote = flags.remote ? await remoteChanges(s) : null;
  const conflicts = planned.plan.notes.filter((a) => a.kind === 'conflict');
  const pending = hasPendingWork(planned.plan) || conflicts.length > 0 || (remote ?? 0) > 0;
  const p = s.printer;
  p.event('status', { changes: planned.plan.stats, remote, pending });
  p.line(
    `${pending ? p.c.yellow('●') : p.c.green('✓')} staging: ${describeChanges(planned.plan.stats)}`,
  );
  for (const c of conflicts) {
    if (c.kind === 'conflict') p.line(`  ${p.c.red('conflict')} (${c.reason}) ${c.path}`);
  }
  if (remote !== null)
    p.line(`${remote > 0 ? p.c.yellow('●') : p.c.green('✓')} inkdrop: ${remote} new changes`);
  return flags.exitCode && pending ? ExitCode.Pending : ExitCode.Ok;
}
