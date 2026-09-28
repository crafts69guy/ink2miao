import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { darwinPlatform, portablePlatform } from '../../src/platform/darwin.ts';
import { ExitCode } from '../../src/util/errors.ts';
import { type Harness, harness } from '../support/cli.ts';
import { type FakeInkdrop, startFakeInkdrop } from '../support/fake-inkdrop.ts';
import { noteDoc, sampleDocs } from '../support/fixtures.ts';
import { tempDir } from '../support/tmp.ts';

let fake: FakeInkdrop;
let tmp: ReturnType<typeof tempDir>;
let h: Harness;

beforeEach(() => {
  fake = startFakeInkdrop(sampleDocs());
  tmp = tempDir();
  h = harness(tmp.path, fake.url);
});
afterEach(() => {
  fake.stop();
  tmp.cleanup();
});

const jsonLines = (s: string) =>
  s
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe('program', () => {
  test('help, version and usage errors', async () => {
    expect((await h.run('--help')).code).toBe(0);
    const v = await h.run('--version');
    expect(v.stdout.trim()).toBe('0.1.0');
    const bad = await h.run('nope');
    expect(bad.code).toBe(ExitCode.Usage);
    expect(bad.stderr).toContain("unknown command 'nope'");
    expect((await h.run('sync', '--link-mode', 'weird')).code).toBe(ExitCode.Usage);
  });

  test('invalid configuration is a usage error', async () => {
    const r = await h.run('sync', '--concurrency', '99');
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.stderr).toContain('invalid configuration');
  });
});

describe('sync → verify → report', () => {
  test('full round trip', async () => {
    const sync = await h.run('sync');
    expect(sync.code).toBe(0);
    expect(sync.stdout).toContain('4 notes (3 live, 1 deleted)');
    expect(sync.stdout).toContain('Applied: 4 created, 1 attachments fetched');
    expect(sync.stderr).toContain('next: ink2miao verify');
    expect(sync.stderr).toContain('1 unresolved references');
    const alpha = readFileSync(join(h.staging, 'Main/Alpha꞉ intro.md'), 'utf8');
    expect(alpha).toContain('[[Beta]]');

    const verify = await h.run('verify');
    expect(verify.code).toBe(0);
    expect(verify.stdout).toContain('0 errors');

    const md = await h.run('report');
    expect(md.stdout).toContain('## Unresolved references (1)');
    expect(md.stdout).toContain('## Renamed titles (2)');
    expect(md.stdout).toContain('## Renamed notebooks (2)');
    const json = JSON.parse((await h.run('report', '--format', 'json')).stdout) as {
      counts: { notes: number };
    };
    expect(json.counts.notes).toBe(4);
    expect(JSON.parse((await h.run('--json', 'report')).stdout)).toMatchObject({ dryRun: false });
  });

  test('second sync only fetches new changes', async () => {
    await h.run('sync');
    fake.put(noteDoc('new', { title: 'Fresh', bookId: 'book:main' }));
    fake.requests.length = 0;
    const r = await h.run('sync', '--verbose');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('5 notes');
    expect(fake.requests.some((q) => q.includes('since=16'))).toBe(true);
    expect(r.stderr).toContain('fetched 1 changes');
    await h.run('sync', '--full');
    expect(fake.requests.some((q) => q.includes('since=0'))).toBe(true);
  });

  test('dry run writes nothing', async () => {
    const r = await h.run('sync', '--dry-run', '--no-include-trash');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Would apply: 3 created, 1 attachments fetched');
    expect(r.stderr).not.toContain('next:');
    expect((await h.run('verify')).code).toBe(ExitCode.Usage);
  });

  test('json mode emits events only', async () => {
    const r = await h.run('--json', 'sync');
    const events = jsonLines(r.stdout);
    expect(events.map((e) => e['type'])).toEqual(['sync']);
    expect(r.stderr).toBe('');
    const v = jsonLines((await h.run('--json', 'verify')).stdout);
    expect(v[0]).toMatchObject({ type: 'verify', errors: [] });
  });

  test('attachment failures exit 1 and are reported', async () => {
    fake.attachments.set('file:img1', new Uint8Array([9]));
    const r = await h.run('sync');
    expect(r.code).toBe(ExitCode.Internal);
    expect(r.stderr).toContain('md5 mismatch');
    expect((await h.run('report')).stdout).toContain('## Attachment failures (1)');
  });

  test('metadata failures are summarized', async () => {
    h.deps = {
      platform: {
        ...portablePlatform(),
        setPinned: () => {
          throw new Error('no xattr');
        },
      },
    };
    const r = await h.run('sync');
    expect(r.stderr).toContain('4 files without dates/pin');
    expect((await h.run('report')).stdout).toContain('## Metadata failures (4)');
  });

  test('verify detects tampering; lists warnings with --verbose', async () => {
    fake.put(noteDoc('w', { bookId: 'book:main', body: '[[Nowhere]]' }));
    await h.run('sync');
    writeFileSync(join(h.staging, 'Main/Child/Beta.md'), 'edited');
    const quiet = await h.run('verify');
    expect(quiet.code).toBe(ExitCode.VerifyFailed);
    expect(quiet.stderr).toContain('content_mismatch');
    expect(quiet.stderr).toContain('use --verbose');
    const verbose = await h.run('verify', '-v');
    expect(verbose.stderr).toContain('dangling_wikilink');
  });

  test('verify and report need a prior sync', async () => {
    const report = await h.run('report');
    expect(report.code).toBe(ExitCode.Usage);
    expect(report.stderr).toContain('no report yet');
    mkdirSync(h.staging, { recursive: true });
    writeFileSync(join(h.staging, '.ink2miao-staging'), '');
    const verify = await h.run('verify');
    expect(verify.stderr).toContain('no Inkdrop data');
  });

  test('refuses to wipe a foreign staging directory', async () => {
    mkdirSync(h.staging, { recursive: true });
    writeFileSync(join(h.staging, 'precious.md'), 'x');
    const r = await h.run('sync');
    expect(r.code).toBe(ExitCode.Usage);
    expect(r.stderr).toContain('refusing to use');
    expect(r.stderr).toContain('--staging');
  });

  test('source errors map to exit 3', async () => {
    fake.stop();
    const r = await h.run('sync');
    expect(r.code).toBe(ExitCode.Source);
    expect(r.stderr).toContain('cannot reach Inkdrop');
  });

  test('interruption exits 130', async () => {
    const ctl = new AbortController();
    ctl.abort(new Error('interrupted'));
    h.deps = { signal: ctl.signal };
    const r = await h.run('sync');
    expect(r.code).toBe(ExitCode.Interrupted);
    expect(r.stderr).toContain('interrupted');
  });
});

describe('doctor', () => {
  test('healthy setup with warnings', async () => {
    mkdirSync(join(tmp.path, 'library'));
    h.deps = { platform: darwinPlatform(undefined, () => true) };
    const r = await h.run('doctor');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`inkdrop server       ${fake.url}`);
    expect(r.stdout).toContain('5 notebooks, 2 tags, 2 files');
    expect(r.stdout).toContain('dates ok, pin ok');
    expect(r.stdout).toContain('running — quit it before promoting');
    expect(r.stdout).toContain('missing: delta, glow, chafa');
    expect(r.stdout).toContain('1 duplicate titles');
    expect(r.stdout).toContain('✓ miaoyan library');
  });

  test('failures: server down, unwritable staging, library permissions, metadata', async () => {
    fake.stop();
    const lib = join(tmp.path, 'library');
    mkdirSync(lib);
    chmodSync(lib, 0o000);
    h.deps = {
      platform: {
        ...portablePlatform(),
        setTimes: () => {
          throw new Error('nope');
        },
      },
    };
    try {
      const r = await h.run('doctor', '--staging', '/nonexistent-root/stage');
      expect(r.code).toBe(ExitCode.Internal);
      expect(r.stdout).toContain('✗ inkdrop server');
      expect(r.stdout).toContain('✗ staging');
      expect(r.stdout).toContain('permission denied');
      expect(r.stdout).toContain('Full Disk Access');
      expect(r.stdout).toContain('✗ dates & pins');
    } finally {
      chmodSync(lib, 0o755);
    }
  });

  test('missing credentials, portable platform, json output and config provenance', async () => {
    writeFileSync(join(tmp.path, 'inkdrop-config.json'), JSON.stringify({ '*': { core: {} } }));
    const env = {
      XDG_STATE_HOME: join(tmp.path, 'state'),
      INK2MIAO_STAGING: h.staging,
      INK2MIAO_INKDROP_CONFIG: join(tmp.path, 'inkdrop-config.json'),
      INK2MIAO_TARGET: join(tmp.path, 'nolib'),
    };
    h.deps = { env, platform: portablePlatform(), which: () => '/bin/x' };
    const r = await h.run('--json', 'doctor');
    const checks = jsonLines(r.stdout);
    const by = (name: string) => checks.find((c) => c['name'] === name);
    expect(by('config')?.['detail']).toContain('staging←env');
    expect(by('inkdrop credentials')?.['status']).toBe('fail');
    expect(by('dates & pins')?.['detail']).toContain('pin unsupported');
    expect(by('miaoyan library')?.['status']).toBe('warn');
    expect(by('optional tools')?.['status']).toBe('ok');
  });

  test('too many folders fails', async () => {
    for (let i = 0; i < 100; i++) {
      fake.put({ _id: `book:x${i}`, _rev: '1', name: `Book ${i}`, createdAt: i });
    }
    const r = await h.run('doctor');
    expect(r.stdout).toContain('✗ folders');
  });

  test('invalid docs are flagged', async () => {
    fake.put({ _id: 'note:broken' });
    const r = await h.run('doctor');
    expect(r.stdout).toContain('1 invalid');
  });

  test('unexpected errors exit 1 and show the stack with --verbose', async () => {
    h.deps = {
      which: () => {
        throw new Error('which exploded');
      },
    };
    const r = await h.run('--verbose', 'doctor');
    expect(r.code).toBe(ExitCode.Internal);
    expect(r.stderr).toContain('unexpected error: which exploded');
    expect(r.stderr).toContain('at ');
    const quiet = await h.run('doctor');
    expect(quiet.stderr).not.toContain('    at ');
  });
});
