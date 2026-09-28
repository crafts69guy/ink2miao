import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CliError, ExitCode, errorMessage } from '../util/errors.ts';
import {
  type Env,
  expandHome,
  INKDROP_CONFIG,
  MIAOYAN_ICLOUD_LIBRARY,
  type Paths,
  xdgPaths,
} from './paths.ts';
import { CONFIG_KEYS, type Config, type ConfigKey, ConfigSchema } from './schema.ts';

export type Origin = 'default' | 'file' | 'env' | 'flag';

export interface LoadInput {
  readonly env: Env;
  readonly home: string;
  /** Explicit `--config`; when set, the file must exist. */
  readonly configFile?: string | undefined;
  readonly flags: Partial<Record<ConfigKey, unknown>>;
}

export interface LoadedConfig {
  readonly config: Config;
  readonly origins: Readonly<Record<ConfigKey, Origin>>;
  readonly file: string | null;
  readonly paths: Paths;
}

const PATH_KEYS: ReadonlySet<ConfigKey> = new Set(['staging', 'target', 'inkdropConfig']);

function readToml(path: string): Record<string, unknown> {
  try {
    return Bun.TOML.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    throw new CliError(`cannot read config ${path}: ${errorMessage(e)}`, ExitCode.Usage);
  }
}

function layer(input: LoadInput, toml: Record<string, unknown> | null) {
  const raw: Partial<Record<ConfigKey, unknown>> = {};
  const origins = {} as Record<ConfigKey, Origin>;
  for (const key of Object.keys(CONFIG_KEYS) as ConfigKey[]) {
    const { toml: tomlKey, env } = CONFIG_KEYS[key];
    const layers: [Origin, unknown][] = [
      ['flag', input.flags[key]],
      ['env', input.env[env]],
      ['file', toml?.[tomlKey]],
    ];
    const hit = layers.find(([, v]) => v !== undefined && v !== '');
    origins[key] = hit ? hit[0] : 'default';
    if (hit) raw[key] = hit[1];
  }
  return { raw, origins };
}

/** Resolves settings with precedence flags > env > config.toml > defaults. */
export function loadConfig(input: LoadInput): LoadedConfig {
  const paths = xdgPaths(input.env, input.home);
  const file = input.configFile ?? join(paths.configDir, 'config.toml');
  if (input.configFile && !existsSync(file)) {
    throw new CliError(`config file not found: ${file}`, ExitCode.Usage);
  }
  const toml = existsSync(file) ? readToml(file) : null;

  const { raw, origins } = layer(input, toml);
  const keys = Object.keys(CONFIG_KEYS) as ConfigKey[];

  const profile = typeof raw.profile === 'string' ? raw.profile : 'default';
  const defaults: Record<ConfigKey, unknown> = {
    profile,
    staging: join(paths.dataDir, profile, 'staging'),
    target: join(input.home, MIAOYAN_ICLOUD_LIBRARY),
    linkMode: 'auto',
    includeTrash: true,
    deletedFolder: '_Inkdrop Deleted',
    trashReplacement: 'Bin',
    concurrency: 4,
    inkdropConfig: join(input.home, INKDROP_CONFIG),
  };
  const merged: Record<string, unknown> = {};
  for (const key of keys) {
    const v = raw[key] ?? defaults[key];
    merged[key] = PATH_KEYS.has(key) && typeof v === 'string' ? expandHome(v, input.home) : v;
  }

  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new CliError(`invalid configuration: ${issues}`, ExitCode.Usage);
  }
  return { config: parsed.data, origins, file: toml ? file : null, paths };
}

export function statePath(loaded: LoadedConfig): string {
  return join(loaded.paths.stateDir, loaded.config.profile, 'state.db');
}
