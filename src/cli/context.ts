import { resolveInkdropServer } from '../config/inkdrop.ts';
import { type LoadedConfig, loadConfig, statePath } from '../config/load.ts';
import type { Env } from '../config/paths.ts';
import type { ConfigKey } from '../config/schema.ts';
import type { RenderOptions } from '../plan/render.ts';
import type { Platform } from '../platform/types.ts';
import { Printer, type Writer } from '../report/printer.ts';
import { HttpSource } from '../source/http.ts';
import type { Source } from '../source/types.ts';
import { StateDb } from '../state/db.ts';

/** Everything the CLI touches in the outside world, injectable for tests. */
export interface Deps {
  readonly env: Env;
  readonly home: string;
  readonly stdout: Writer;
  readonly stderr: Writer;
  readonly stdoutTTY: boolean;
  readonly stderrTTY: boolean;
  readonly platform: Platform;
  readonly fetch: typeof fetch;
  readonly signal: AbortSignal;
  readonly now: () => number;
  readonly which: (bin: string) => string | null;
  readonly tmpDir: string;
  /** MiaoYan's configured library folder (from its preferences), if any. */
  readonly miaoyanLibrary: () => string | null;
  /** Poll interval while waiting for MiaoYan to quit, and the watch debounce. */
  readonly pollMs: number;
  readonly debounceMs: number;
}

export interface GlobalFlags {
  readonly config?: string | undefined;
  readonly profile?: string | undefined;
  readonly json?: boolean | undefined;
  readonly quiet?: boolean | undefined;
  readonly verbose?: boolean | undefined;
  readonly color?: boolean | undefined;
}

export interface Session {
  readonly deps: Deps;
  readonly loaded: LoadedConfig;
  readonly printer: Printer;
  db(): StateDb;
  source(): Source;
  renderOptions(): RenderOptions;
  /** The MiaoYan library: explicit config wins, then MiaoYan's own setting, then the default. */
  target(): string;
  close(): void;
}

export function makePrinter(deps: Deps, g: GlobalFlags): Printer {
  const noColor = deps.env['NO_COLOR'] !== undefined && deps.env['NO_COLOR'] !== '';
  return new Printer(deps.stdout, deps.stderr, {
    json: g.json === true,
    quiet: g.quiet === true,
    verbose: g.verbose === true,
    color: g.color !== false && !noColor && deps.env['TERM'] !== 'dumb' && deps.stderrTTY,
    tty: deps.stderrTTY,
  });
}

export function openSession(
  deps: Deps,
  g: GlobalFlags,
  flags: Partial<Record<ConfigKey, unknown>>,
): Session {
  const printer = makePrinter(deps, g);
  const loaded = loadConfig({
    env: deps.env,
    home: deps.home,
    configFile: g.config,
    flags: { ...flags, profile: g.profile },
  });
  let db: StateDb | null = null;
  let source: Source | null = null;
  return {
    deps,
    loaded,
    printer,
    db() {
      db ??= StateDb.open(statePath(loaded));
      return db;
    },
    source() {
      if (!source) {
        const server = resolveInkdropServer(deps.env, loaded.config.inkdropConfig);
        source = new HttpSource({ ...server, fetch: deps.fetch });
      }
      return source;
    },
    renderOptions() {
      const c = loaded.config;
      return {
        linkMode: c.linkMode,
        includeTrash: c.includeTrash,
        deletedFolder: c.deletedFolder,
        trashReplacement: c.trashReplacement,
      };
    },
    target() {
      const explicit = loaded.origins.target !== 'default';
      return explicit ? loaded.config.target : (deps.miaoyanLibrary() ?? loaded.config.target);
    },
    close() {
      db?.close();
      db = null;
    },
  };
}
