import { Command, CommanderError, Option } from '@commander-js/extra-typings';
import pkg from '../../package.json' with { type: 'json' };
import type { ConfigKey } from '../config/schema.ts';
import { CliError, ExitCode, errorMessage } from '../util/errors.ts';
import { doctorCommand } from './commands/doctor.ts';
import { reportCommand } from './commands/report.ts';
import { statusCommand } from './commands/status.ts';
import { syncCommand } from './commands/sync.ts';
import { verifyCommand } from './commands/verify.ts';
import { type Deps, type GlobalFlags, makePrinter, openSession, type Session } from './context.ts';

type Flags = Partial<Record<ConfigKey, unknown>>;

const stagingOption = () => new Option('--staging <dir>', 'staging directory');

function build(
  deps: Deps,
  exec: (flags: Flags, fn: (s: Session) => Promise<number> | number) => Promise<void>,
) {
  const program = new Command()
    .name('ink2miao')
    .description(pkg.description)
    .version(pkg.version)
    .option('--config <file>', 'config file (default: $XDG_CONFIG_HOME/ink2miao/config.toml)')
    .option('--profile <name>', 'state/staging profile')
    .option('--json', 'emit NDJSON events on stdout')
    .option('-q, --quiet', 'only print errors')
    .option('-v, --verbose', 'print debug details')
    .option('--no-color', 'disable colors')
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({
      writeOut: (s) => deps.stdout.write(s),
      writeErr: (s) => deps.stderr.write(s),
    });

  program
    .command('doctor')
    .description('check Inkdrop, MiaoYan, permissions and tooling')
    .addOption(stagingOption())
    .action(async (o) => exec({ staging: o.staging }, doctorCommand));

  program
    .command('sync')
    .alias('pull')
    .description('fetch Inkdrop changes and render every note into the staging directory')
    .addOption(stagingOption())
    .option('-n, --dry-run', 'render and report without writing files')
    .option('--full', 'refetch everything from Inkdrop instead of changes since the last run')
    .option('-f, --force', 'overwrite files edited in staging (a backup is kept)')
    .option('--rebuild', 'wipe staging and write everything again')
    .addOption(
      new Option('--deletions <mode>', 'notes deleted in Inkdrop').choices([
        'move',
        'keep',
        'delete',
      ] as const),
    )
    .addOption(
      new Option('--link-mode <mode>', 'note link style').choices([
        'auto',
        'wikilink',
        'goto',
      ] as const),
    )
    .option('--include-trash', 'export trashed notes (default)')
    .option('--no-include-trash', 'skip trashed notes')
    .option('--concurrency <n>', 'parallel attachment downloads')
    .action(async (o) =>
      exec(
        {
          staging: o.staging,
          linkMode: o.linkMode,
          includeTrash: o.includeTrash,
          concurrency: o.concurrency,
          deletions: o.deletions,
        },
        (s) =>
          syncCommand(s, { dryRun: o.dryRun, full: o.full, force: o.force, rebuild: o.rebuild }),
      ),
    );

  program
    .command('status')
    .alias('check')
    .description('show what the next sync would change, and conflicts in staging')
    .addOption(stagingOption())
    .option('--remote', 'also ask Inkdrop for changes since the last sync')
    .option('--exit-code', 'exit 10 when anything is pending')
    .action(async (o) =>
      exec({ staging: o.staging }, (s) =>
        statusCommand(s, { remote: o.remote, exitCode: o.exitCode }),
      ),
    );

  program
    .command('verify')
    .description('check the staging directory against the local Inkdrop mirror')
    .addOption(stagingOption())
    .action(async (o) => exec({ staging: o.staging }, verifyCommand));

  program
    .command('report')
    .description('show the last sync report (unresolved links, renames, failures)')
    .addOption(
      new Option('--format <format>', 'output format')
        .choices(['md', 'json'] as const)
        .default('md' as const),
    )
    .action(async (o) => exec({}, (s) => reportCommand(s, o.format)));

  return program;
}

/** Parses argv and runs one command; returns the process exit code. Never throws. */
export async function run(argv: readonly string[], deps: Deps): Promise<number> {
  let code: number = ExitCode.Ok;
  let globals: GlobalFlags = {};
  const exec = async (flags: Flags, fn: (s: Session) => Promise<number> | number) => {
    const s = openSession(deps, globals, flags);
    try {
      code = await fn(s);
    } finally {
      s.close();
    }
  };
  const program = build(deps, exec);
  program.hook('preAction', (cmd) => {
    globals = cmd.opts();
  });
  try {
    await program.parseAsync([...argv], { from: 'user' });
    return code;
  } catch (e) {
    return handleError(e, deps, globals);
  }
}

function handleError(e: unknown, deps: Deps, globals: GlobalFlags): number {
  if (e instanceof CommanderError) {
    return e.exitCode === 0 ? ExitCode.Ok : ExitCode.Usage;
  }
  const printer = makePrinter(deps, globals);
  if (deps.signal.aborted) {
    printer.error('interrupted');
    return ExitCode.Interrupted;
  }
  if (e instanceof CliError) {
    printer.error(e.message, e.hint);
    return e.exitCode;
  }
  printer.error(`unexpected error: ${errorMessage(e)}`, 'please report this with --verbose output');
  if (globals.verbose && e instanceof Error && e.stack) deps.stderr.write(`${e.stack}\n`);
  return ExitCode.Internal;
}
