import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecOptions } from '../../src/cli/io/exec.ts';
import { ExitCode } from '../../src/util/errors.ts';
import { type Harness, harness } from '../support/cli.ts';
import { type FakeInkdrop, startFakeInkdrop } from '../support/fake-inkdrop.ts';
import { sampleDocs } from '../support/fixtures.ts';
import { tempDir } from '../support/tmp.ts';
import { writeBackup } from '../unit/backup-source.test.ts';

let fake: FakeInkdrop;
let tmp: ReturnType<typeof tempDir>;
let h: Harness;
let calls: { cmd: readonly string[]; opts: ExecOptions | undefined }[];

function tools(installed: string[], stdout = '', exitCode = 0) {
  calls = [];
  return {
    which: (bin: string) => (installed.includes(bin) ? `/usr/local/bin/${bin}` : null),
    exec: async (cmd: readonly string[], opts?: ExecOptions) => {
      calls.push({ cmd, opts });
      return { exitCode, stdout };
    },
  };
}

beforeEach(async () => {
  fake = startFakeInkdrop(sampleDocs());
  tmp = tempDir();
  h = harness(tmp.path, fake.url);
  await h.run('sync');
});
afterEach(() => {
  fake.stop();
  tmp.cleanup();
});

describe('show', () => {
  test('plain output with attachment links when not on a terminal', async () => {
    h.deps = tools(['glow', 'chafa']);
    const r = await h.run('show', 'Alpha: intro');
    expect(r.stdout).toContain('See [[Beta]]');
    expect(r.stdout).toContain('attachment: Main/i/clipboard-img1.png');
    expect(calls).toEqual([]);
    const plain = await h.run('show', '--plain', 'note:a');
    expect(plain.stdout).not.toContain('attachment:');
    const source = await h.run('show', '--source', 'a');
    expect(source.stdout).toContain('[Beta](inkdrop://note/b)');
  });

  test('glow and chafa on a terminal', async () => {
    h.deps = { ...tools(['glow', 'chafa']), stdoutTTY: true };
    await h.run('show', 'Alpha꞉ intro');
    expect(calls[0]?.cmd).toEqual(['glow', '-p', '-']);
    expect(calls[0]?.opts?.input).toContain('[[Beta]]');
    expect(calls[1]?.cmd[0]).toBe('/usr/local/bin/chafa');
    expect(calls[1]?.cmd[2]).toEndWith('Main/i/clipboard-img1.png');
  });

  test('notes in the library root and without a trailing newline', async () => {
    fake.put({
      _id: 'note:root',
      _rev: '1',
      title: 'Rooted',
      body: 'no newline',
      bookId: 'book:none',
      createdAt: 1,
      updatedAt: 1,
    });
    await h.run('sync');
    expect((await h.run('show', 'Rooted')).stdout).toEndWith('no newline\n');
  });

  test('ambiguous and unknown queries', async () => {
    const amb = await h.run('show', 'Beta');
    expect(amb.code).toBe(ExitCode.Usage);
    expect(amb.stderr).toContain('ambiguous');
    expect(amb.stderr).toContain('note:c');
    expect((await h.run('show', 'nothing-like-this')).stderr).toContain('no note matches');

    h.deps = {
      stdinTTY: true,
      prompter: { confirm: async () => false, choose: async () => ['note:c'] },
    };
    expect((await h.run('show', 'Beta')).stdout).toContain('slug: keep-me');
    h.deps = { stdinTTY: true, prompter: { confirm: async () => false, choose: async () => null } };
    expect((await h.run('show', 'Beta')).stderr).toContain('cancelled');
  });

  test('needs data', async () => {
    const other = harness(join(tmp.path, 'empty'), fake.url);
    expect((await other.run('show', 'x')).stderr).toContain('run `ink2miao sync` first');
  });
});

describe('diff', () => {
  test('no differences, plain patch, delta, --library and --source', async () => {
    expect((await h.run('diff', 'note:b')).stdout).toContain('no differences');

    fake.put({ ...fake.get('note:b'), body: 'changed upstream', _rev: '9' });
    await h.run('sync', '--dry-run');
    const patch = await h.run('diff', 'note:b');
    expect(patch.stdout).toContain('--- staging/Main/Child/Beta.md');
    expect(patch.stdout).toContain('+changed upstream');

    h.deps = { ...tools(['delta']), stdoutTTY: true };
    await h.run('diff', 'note:b');
    expect(calls[0]?.cmd).toEqual(['delta']);
    expect(calls[0]?.opts?.input).toContain('+changed upstream');

    h.deps = {};
    const lib = join(tmp.path, 'library');
    mkdirSync(join(lib, 'Main/Child'), { recursive: true });
    writeFileSync(join(lib, 'Main/Child/Beta.md'), 'library copy');
    expect((await h.run('diff', '--library', 'note:b')).stdout).toContain('+library copy');
    rmLibrary(lib);
    expect((await h.run('diff', '--library', 'note:b')).stdout).toContain('--- staging/');

    const src = await h.run('diff', '--source', 'note:a');
    expect(src.stdout).toContain('-See [Beta](inkdrop://note/b)');
    expect(src.stdout).toContain('+See [[Beta]]');
  });
});

function rmLibrary(dir: string) {
  Bun.spawnSync(['rm', '-rf', dir]);
}

describe('pick', () => {
  test('fzf with preview; paths by default', async () => {
    h.deps = tools(['fzf'], 'Beta\tMain/Child/Beta.md\tnote:b\n');
    const r = await h.run('pick', '--multi', '--query', 'bet');
    expect(r.stdout.trim()).toBe(join(h.staging, 'Main/Child/Beta.md'));
    const [call] = calls;
    expect(call?.cmd).toEqual([
      'fzf',
      '--delimiter=\t',
      '--with-nth=1,2',
      '--preview',
      'ink2miao show --plain {3}',
      '--multi',
      '--query',
      'bet',
    ]);
    expect(call?.opts?.input).toContain('Alpha꞉ intro\tMain/Alpha꞉ intro.md\tnote:a');
  });

  test('then show / diff / open, and cancellation', async () => {
    h.deps = tools(['fzf'], 'Beta\tMain/Child/Beta.md\tnote:b\n');
    expect((await h.run('pick', '--then', 'show')).stdout).toContain('Body of b');
    expect((await h.run('pick', '--then', 'diff')).stdout).toContain('no differences');
    await h.run('pick', '--then', 'open');
    expect(calls.at(-1)?.cmd).toEqual(['open', 'miaoyan://goto/Beta']);
    h.deps = tools(['fzf'], '', 130);
    expect((await h.run('pick')).code).toBe(ExitCode.Interrupted);
  });

  test('built-in prompt without fzf, error without a terminal', async () => {
    h.deps = {
      ...tools([]),
      stdinTTY: true,
      prompter: {
        confirm: async () => false,
        choose: async (_m, _c, multi) => (multi ? ['note:a', 'note:b'] : null),
      },
    };
    const r = await h.run('pick', '-m');
    expect(r.stdout.trim().split('\n')).toHaveLength(2);
    expect((await h.run('pick')).code).toBe(ExitCode.Interrupted);
    h.deps = tools([]);
    expect((await h.run('pick')).stderr).toContain('pick needs fzf');
  });
});

describe('completion, titles, renormalize', () => {
  test('fish completion and hidden titles helper', async () => {
    const fish = await h.run('completion', 'fish');
    expect(fish.stdout).toContain("-a promote -d 'copy staging into the MiaoYan library");
    expect(fish.stdout).toContain("-xa '(ink2miao titles 2>/dev/null)'");
    expect(fish.stdout).not.toContain('-a titles');
    expect((await h.run('completion', 'zsh')).code).toBe(ExitCode.Usage);
    const titles = await h.run('titles');
    expect(titles.stdout.split('\n')).toContain('Alpha꞉ intro');
  });

  test('--renormalize reassigns names from scratch', async () => {
    fake.put({ ...fake.get('note:b'), title: 'Gamma', _rev: '9' });
    await h.run('sync');
    // "Beta" is free now, but c keeps "Beta (2)" so its file is not renamed behind your back.
    expect(readdirSync(join(h.staging, 'idea (2)'))).toEqual(['Beta (2).md']);
    const r = await h.run('sync', '--renormalize');
    expect(r.stdout).toContain('1 moved');
    expect(readdirSync(join(h.staging, 'idea (2)'))).toEqual(['Beta.md']);
  });
});

describe('backup source', () => {
  test('sync, switch back to the server (full refetch) and doctor', async () => {
    const backup = join(tmp.path, 'inkdrop-backup');
    writeBackup(
      backup,
      sampleDocs().filter((d) => d['_id'] !== 'note:c'),
    );
    const env = { INK2MIAO_SOURCE: 'backup', INK2MIAO_BACKUP_DIR: backup };
    h.deps = { env: { ...(await baseEnv()), ...env } };
    const r = await h.run('sync');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('1 retired');
    const doctor = await h.run('doctor');
    expect(doctor.stdout).toContain(`✓ inkdrop backup       backup:${backup}`);

    h.deps = {};
    fake.requests.length = 0;
    await h.run('sync');
    expect(fake.requests.some((q) => q.includes('since=0'))).toBe(true);
  });

  test('backup dir from Inkdrop config, or a clear error', async () => {
    const backup = join(tmp.path, 'from-config');
    writeBackup(backup, sampleDocs());
    const cfg = join(tmp.path, 'inkdrop-config.json');
    writeFileSync(cfg, JSON.stringify({ '*': { core: { db: { backupPath: backup } } } }));
    h.deps = { env: { ...(await baseEnv()), INK2MIAO_SOURCE: 'backup' } };
    expect((await h.run('sync')).code).toBe(0);
    writeFileSync(cfg, JSON.stringify({ '*': { core: {} } }));
    const r = await h.run('sync');
    expect(r.stderr).toContain('no Inkdrop backup folder configured');
    const doctor = await h.run('doctor');
    expect(doctor.stdout).toContain('✗ inkdrop backup');
  });
});

async function baseEnv(): Promise<Record<string, string>> {
  return {
    XDG_CONFIG_HOME: join(tmp.path, 'config'),
    XDG_STATE_HOME: join(tmp.path, 'state'),
    XDG_DATA_HOME: join(tmp.path, 'data'),
    INK2MIAO_STAGING: h.staging,
    INK2MIAO_TARGET: join(tmp.path, 'library'),
    INK2MIAO_INKDROP_CONFIG: join(tmp.path, 'inkdrop-config.json'),
  };
}
