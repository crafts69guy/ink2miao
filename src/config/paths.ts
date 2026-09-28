import { join } from 'node:path';

export type Env = Readonly<Record<string, string | undefined>>;

export interface Paths {
  readonly home: string;
  readonly configDir: string;
  readonly stateDir: string;
  readonly dataDir: string;
}

export function xdgPaths(env: Env, home: string): Paths {
  const pick = (key: string, fallback: string) => {
    const v = env[key];
    return v && v.length > 0 ? v : join(home, fallback);
  };
  return {
    home,
    configDir: join(pick('XDG_CONFIG_HOME', '.config'), 'ink2miao'),
    stateDir: join(pick('XDG_STATE_HOME', '.local/state'), 'ink2miao'),
    dataDir: join(pick('XDG_DATA_HOME', '.local/share'), 'ink2miao'),
  };
}

export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  return p.startsWith('~/') ? join(home, p.slice(2)) : p;
}

export const MIAOYAN_ICLOUD_LIBRARY = 'Library/Mobile Documents/iCloud~com~tw93~miaoyan/Documents';
export const INKDROP_CONFIG = 'Library/Application Support/inkdrop/config.json';
