import { join } from 'node:path';
import type { Deps } from '../../src/cli/context.ts';
import { run } from '../../src/cli/run.ts';
import { portablePlatform } from '../../src/platform/darwin.ts';
import { PASS, USER } from './fake-inkdrop.ts';

export interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface Harness {
  readonly root: string;
  readonly staging: string;
  deps: Partial<Deps>;
  run(...argv: string[]): Promise<CliResult>;
}

/** In-process CLI runner with isolated XDG dirs and credentials for the fake server. */
export function harness(root: string, serverUrl: string): Harness {
  const h: Harness = {
    root,
    staging: join(root, 'stage'),
    deps: {},
    async run(...argv) {
      let stdout = '';
      let stderr = '';
      const deps: Deps = {
        env: {
          XDG_CONFIG_HOME: join(root, 'config'),
          XDG_STATE_HOME: join(root, 'state'),
          XDG_DATA_HOME: join(root, 'data'),
          INK2MIAO_STAGING: h.staging,
          INK2MIAO_TARGET: join(root, 'library'),
          INK2MIAO_INKDROP_CONFIG: join(root, 'inkdrop-config.json'),
          INKDROP_LOCAL_SERVER_URL: serverUrl,
          INKDROP_LOCAL_USERNAME: USER,
          INKDROP_LOCAL_PASSWORD: PASS,
        },
        home: root,
        stdout: {
          write: (s) => {
            stdout += s;
          },
        },
        stderr: {
          write: (s) => {
            stderr += s;
          },
        },
        stdoutTTY: false,
        stderrTTY: false,
        platform: portablePlatform(),
        fetch,
        signal: new AbortController().signal,
        now: () => Date.UTC(2026, 8, 28),
        which: (bin) => (bin === 'fzf' ? '/usr/bin/fzf' : null),
        tmpDir: root,
        miaoyanLibrary: () => null,
        pollMs: 5,
        debounceMs: 50,
        ...h.deps,
      };
      const code = await run(argv, deps);
      return { code, stdout, stderr };
    },
  };
  return h;
}
