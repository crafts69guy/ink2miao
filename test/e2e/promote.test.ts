import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { darwinPlatform, portablePlatform } from '../../src/platform/darwin.ts';
import { ExitCode } from '../../src/util/errors.ts';
import { type Harness, harness } from '../support/cli.ts';
import { type FakeInkdrop, startFakeInkdrop } from '../support/fake-inkdrop.ts';
import { sampleDocs, T0 } from '../support/fixtures.ts';
import { tempDir } from '../support/tmp.ts';

let fake: FakeInkdrop;
let tmp: ReturnType<typeof tempDir>;
let h: Harness;
let lib: string;

beforeEach(() => {
  fake = startFakeInkdrop(sampleDocs());
  tmp = tempDir();
  h = harness(tmp.path, fake.url);
  lib = join(tmp.path, 'library');
  mkdirSync(join(lib, 'Ideas'), { recursive: true });
  writeFileSync(join(lib, 'Ideas/Brainstorming.md'), '# my own MiaoYan note');
});
afterEach(() => {
  fake.stop();
  tmp.cleanup();
});

const inLib = (rel: string) => join(lib, rel);
const edit = (id: string, patch: Record<string, unknown>) =>
  fake.put({ ...fake.get(id), ...patch, _rev: `${Date.now()}` });

describe('promote', () => {
  test('needs a staging directory and an existing library', async () => {
    expect((await h.run('promote')).stderr).toContain('run `ink2miao sync` first');
    await h.run('sync');
    rmSync(lib, { recursive: true });
    const r = await h.run('promote');
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.stderr).toContain('MiaoYan library not found');
    expect((await h.run('promote', '--target', h.staging)).stderr).toContain(
      'must not be the staging directory',
    );
  });

  test('copies notes with dates and pins, leaves the user notes alone, verifies clean', async () => {
    h.deps = { platform: darwinPlatform(undefined, () => false) };
    await h.run('sync');
    const dry = await h.run('promote', '--dry-run');
    expect(dry.stdout).toContain('Would promote: 4 copied, 2 attachments copied');
    expect(existsSync(inLib('Main'))).toBe(false);

    const r = await h.run('promote');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Promoted: 4 copied, 2 attachments copied');
    expect(readFileSync(inLib('Main/Alpha꞉ intro.md'), 'utf8')).toContain('[[Beta]]');
    expect(statSync(inLib('Main/Alpha꞉ intro.md')).birthtime.getTime()).toBe(T0);
    expect(darwinPlatform().isPinned(inLib('Main/Alpha꞉ intro.md'))).toBe(true);
    expect(existsSync(inLib('_Inkdrop Deleted/i/clipboard-img1.png'))).toBe(true);
    expect(readFileSync(inLib('Ideas/Brainstorming.md'), 'utf8')).toBe('# my own MiaoYan note');

    const verify = await h.run('verify', '--target', '-v');
    expect(verify.code).toBe(0);
    expect(verify.stderr).toContain('unexpected_note Ideas/Brainstorming.md');
    expect((await h.run('promote')).stdout).toContain('Promoted: 4 unchanged');
  });

  test('refuses while MiaoYan runs; --wait waits; --force ignores it', async () => {
    await h.run('sync');
    let running = true;
    h.deps = { platform: { ...portablePlatform(), isMiaoYanRunning: () => running } };
    const refused = await h.run('promote');
    expect(refused.code).toBe(ExitCode.MiaoYanRunning);
    expect(refused.stderr).toContain('quit MiaoYan, or use --wait');

    setTimeout(() => {
      running = false;
    }, 30);
    const waited = await h.run('promote', '--wait');
    expect(waited.code).toBe(0);
    expect(waited.stderr).toContain('waiting for MiaoYan to quit');

    running = true;
    edit('note:b', { body: 'changed' });
    await h.run('sync');
    expect((await h.run('promote', '--force')).stdout).toContain('1 copied');
  });

  test('edits and deletions made in MiaoYan are conflicts until forced', async () => {
    await h.run('sync');
    await h.run('promote');
    writeFileSync(inLib('Main/Child/Beta.md'), 'edited in MiaoYan');
    rmSync(inLib('idea (2)/Beta (2).md'));
    edit('note:b', { body: 'upstream change' });
    await h.run('sync');

    const r = await h.run('promote');
    expect(r.code).toBe(ExitCode.Conflict);
    expect(r.stderr).toContain('conflict (edited): Main/Child/Beta.md');
    expect(r.stderr).toContain('conflict (deleted): idea (2)/Beta (2).md');
    expect(readFileSync(inLib('Main/Child/Beta.md'), 'utf8')).toBe('edited in MiaoYan');

    const forced = await h.run('promote', '--force');
    expect(forced.code).toBe(0);
    expect(forced.stderr).toContain('backed up 1 files');
    expect(readFileSync(inLib('Main/Child/Beta.md'), 'utf8')).toContain('upstream change');
    expect(existsSync(inLib('idea (2)/Beta (2).md'))).toBe(true);
  });

  test('renames and purges are mirrored as moves', async () => {
    await h.run('sync');
    await h.run('promote');
    edit('note:b', { title: 'Beta Prime' });
    fake.remove('note:c');
    await h.run('sync');
    const r = await h.run('promote');
    expect(r.stdout).toContain('1 moved');
    expect(r.stdout).toContain('1 retired');
    expect(existsSync(inLib('Main/Child/Beta Prime.md'))).toBe(true);
    expect(existsSync(inLib('Main/Child/Beta.md'))).toBe(false);
    expect(existsSync(inLib('_Inkdrop Deleted/Beta (2).md'))).toBe(true);
    expect(existsSync(inLib('idea (2)'))).toBe(false);
    expect(readFileSync(inLib('Main/Alpha꞉ intro.md'), 'utf8')).toContain('Beta%20Prime');
  });

  test('a dirty staging file is not promoted', async () => {
    await h.run('sync');
    writeFileSync(join(h.staging, 'Main/Child/Beta.md'), 'staging edit');
    const r = await h.run('promote');
    expect(r.code).toBe(ExitCode.Conflict);
    expect(r.stderr).toContain('conflict (staging-dirty)');
  });

  test('metadata failures are reported', async () => {
    await h.run('sync');
    h.deps = {
      platform: {
        ...portablePlatform(),
        setTimes: () => {
          throw new Error('nope');
        },
      },
    };
    expect((await h.run('promote')).stderr).toContain('files without dates/pin');
  });

  test('watch promotes again whenever staging changes', async () => {
    await h.run('sync');
    const ctl = new AbortController();
    h.deps = { signal: ctl.signal };
    const watching = h.run('promote', '--watch');
    for (let i = 0; i < 100 && !existsSync(inLib('Main')); i++) await Bun.sleep(10);
    await Bun.sleep(30);
    edit('note:b', { title: 'Watched' });
    h.deps = {};
    await h.run('sync');
    for (let i = 0; i < 200 && !existsSync(inLib('Main/Child/Watched.md')); i++)
      await Bun.sleep(10);
    expect(existsSync(inLib('Main/Child/Watched.md'))).toBe(true);
    ctl.abort();
    const r = await watching;
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('watching staging for changes');
  });

  test('uses MiaoYan’s configured library when no target is configured', async () => {
    await h.run('sync');
    const own = join(tmp.path, 'configured');
    mkdirSync(own);
    const { INK2MIAO_TARGET: _, ...env } = {
      XDG_CONFIG_HOME: join(tmp.path, 'config'),
      XDG_STATE_HOME: join(tmp.path, 'state'),
      XDG_DATA_HOME: join(tmp.path, 'data'),
      INK2MIAO_STAGING: h.staging,
      INK2MIAO_TARGET: '',
      INKDROP_LOCAL_SERVER_URL: fake.url,
      INKDROP_LOCAL_USERNAME: 'user',
      INKDROP_LOCAL_PASSWORD: 'pass',
    };
    h.deps = { env, miaoyanLibrary: () => own };
    expect((await h.run('promote')).code).toBe(0);
    expect(readdirSync(own)).toContain('Main');
    rmSync(own, { recursive: true });
    expect((await h.run('verify', '--target')).stderr).toContain('MiaoYan library not found');
  });
});
