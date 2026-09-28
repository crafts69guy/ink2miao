import { Command, CommanderError, Option } from '@commander-js/extra-typings';
import pkg from '../../package.json' with { type: 'json' };
import type { ConfigKey } from '../config/schema.ts';
import { CliError, ExitCode, errorMessage } from '../util/errors.ts';
import { diffCommand, pickCommand, showCommand, titlesCommand } from './commands/browse.ts';
import { doctorCommand } from './commands/doctor.ts';
import { promoteCommand } from './commands/promote.ts';
import { reportCommand } from './commands/report.ts';
import { statusCommand } from './commands/status.ts';
import { syncCommand } from './commands/sync.ts';
import { verifyCommand } from './commands/verify.ts';
import { fishCompletion } from './completion.ts';
import { type Deps, type GlobalFlags, makePrinter, openSession, type Session } from './context.ts';

type Flags = Partial<Record<ConfigKey, unknown>>;

const HIDDEN: ReadonlySet<string> = new Set(['titles', 'help']);

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
    .option('--renormalize', 'recompute every filename from scratch (renames files)')
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
          syncCommand(s, {
            dryRun: o.dryRun,
            full: o.full,
            force: o.force,
            rebuild: o.rebuild,
            renormalize: o.renormalize,
          }),
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
    .command('promote')
    .description('copy staging into the MiaoYan library (refuses while MiaoYan runs)')
    .addOption(stagingOption())
    .option('--target <dir>', 'MiaoYan library folder')
    .option('-n, --dry-run', 'show what would change')
    .option(
      '-f, --force',
      'overwrite changes made in MiaoYan (a backup is kept); ignore a running MiaoYan',
    )
    .option('--wait', 'wait for MiaoYan to quit instead of failing')
    .option('--watch', 'keep running and promote whenever staging changes')
    .addOption(
      new Option('--deletions <mode>', 'notes deleted in Inkdrop').choices([
        'move',
        'keep',
        'delete',
      ] as const),
    )
    .action(async (o) =>
      exec({ staging: o.staging, target: o.target, deletions: o.deletions }, (s) =>
        promoteCommand(s, { dryRun: o.dryRun, force: o.force, wait: o.wait, watch: o.watch }),
      ),
    );

  program
    .command('verify')
    .description('check staging (or, with --target, the MiaoYan library) against Inkdrop')
    .addOption(stagingOption())
    .option('--target [dir]', 'verify the MiaoYan library instead of staging')
    .action(async (o) =>
      exec(
        { staging: o.staging, target: typeof o.target === 'string' ? o.target : undefined },
        (s) => verifyCommand(s, { library: o.target !== undefined }),
      ),
    );

  program
    .command('show')
    .alias('preview')
    .description('print a note (glow on a terminal) and its attachments')
    .argument('<note>', 'id, exact title, path or search text')
    .option('--plain', 'raw markdown only (for previews and pipes)')
    .option('--source', 'the original Inkdrop body instead of the rewritten one')
    .action(async (note, o) => exec({}, (s) => showCommand(s, note, o)));

  program
    .command('diff')
    .description('diff the next sync against staging (delta when available)')
    .argument('<note>', 'id, exact title, path or search text')
    .option('--library', 'staging vs. the MiaoYan library instead')
    .option('--source', 'original Inkdrop body vs. the rewritten one instead')
    .action(async (note, o) => exec({}, (s) => diffCommand(s, note, o)));

  program
    .command('pick')
    .description('fuzzy-pick notes (fzf with preview) and print or act on them')
    .option('-m, --multi', 'select several notes')
    .option('-q, --query <text>', 'initial query')
    .addOption(
      new Option('--then <action>', 'what to do with the selection')
        .choices(['path', 'show', 'diff', 'open'] as const)
        .default('path' as const),
    )
    .action(async (o) => exec({}, (s) => pickCommand(s, o)));

  program
    .command('completion')
    .description('print shell completion (fish)')
    .argument('<shell>', 'fish')
    .action((shell) => {
      if (shell !== 'fish')
        throw new CliError(
          `unsupported shell "${shell}"`,
          ExitCode.Usage,
          'only fish is supported',
        );
      deps.stdout.write(fishCompletion(program, HIDDEN));
    });

  program
    .command('titles', { hidden: true })
    .description('list exported note titles (for shell completion)')
    .action(async () => exec({}, titlesCommand));

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
