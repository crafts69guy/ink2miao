import { isStaging } from '../../apply/export.ts';
import { CliError, type ExitCode as Code, ExitCode } from '../../util/errors.ts';
import { verifyTree } from '../../verify/rules.ts';
import type { Session } from '../context.ts';
import { computePlan } from './planning.ts';

export async function verifyCommand(s: Session): Promise<Code> {
  const { staging } = s.loaded.config;
  if (!isStaging(staging)) {
    throw new CliError(
      `${staging} is not an ink2miao staging directory`,
      ExitCode.Usage,
      'run `ink2miao sync` first',
    );
  }
  const { render, hasData } = computePlan(s, { fresh: false, force: false });
  if (!hasData) {
    throw new CliError(
      'no Inkdrop data in the local state',
      ExitCode.Usage,
      'run `ink2miao sync` first',
    );
  }
  const report = await verifyTree(staging, render);
  const p = s.printer;
  p.event('verify', { ...report });
  for (const w of report.warnings) p.debug(`warn ${w.code} ${w.path}: ${w.detail}`);
  for (const e of report.errors) p.error(`${e.code} ${e.path}: ${e.detail}`);
  const { notes, attachments, folders } = report.stats;
  const mark = report.errors.length === 0 ? p.c.green('✓') : p.c.red('✗');
  p.line(
    `${mark} ${notes} notes, ${attachments} attachments, ${folders} folders — ${report.errors.length} errors, ${report.warnings.length} warnings`,
  );
  if (report.warnings.length > 0) p.info(p.c.dim('use --verbose to list warnings'));
  return report.errors.length === 0 ? ExitCode.Ok : ExitCode.VerifyFailed;
}
