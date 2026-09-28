import { formatReportMarkdown, type SyncReport } from '../../report/sync-report.ts';
import { CliError, type ExitCode as Code, ExitCode } from '../../util/errors.ts';
import type { Session } from '../context.ts';
import { LAST_REPORT } from './sync.ts';

export function reportCommand(s: Session, format: 'md' | 'json'): Code {
  const raw = s.db().getMeta(LAST_REPORT);
  if (raw === null) {
    throw new CliError('no report yet', ExitCode.Usage, 'run `ink2miao sync` first');
  }
  const report = JSON.parse(raw) as SyncReport;
  if (format === 'json' || s.printer.opts.json) {
    s.deps.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    s.deps.stdout.write(formatReportMarkdown(report));
  }
  return ExitCode.Ok;
}
