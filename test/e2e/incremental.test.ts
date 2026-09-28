import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ExitCode } from '../../src/util/errors.ts';
import { type Harness, harness } from '../support/cli.ts';
import { type FakeInkdrop, startFakeInkdrop } from '../support/fake-inkdrop.ts';
import { sampleDocs } from '../support/fixtures.ts';
import { tempDir } from '../support/tmp.ts';

let fake: FakeInkdrop;
let tmp: ReturnType<typeof tempDir>;
let h: Harness;

beforeEach(async () => {
  fake = startFakeInkdrop(sampleDocs());
  tmp = tempDir();
  h = harness(tmp.path, fake.url);
  expect((await h.run('sync')).code).toBe(0);
});
afterEach(() => {
  fake.stop();
  tmp.cleanup();
});

const read = (rel: string) => readFileSync(join(h.staging, rel), 'utf8');
const edit = (id: string, patch: Record<string, unknown>) => {
  const doc = fake.get(id);
  fake.put({ ...doc, ...patch, _rev: `${Date.now()}` });
};

describe('incremental sync', () => {
  test('a second run is a no-op', async () => {
    const r = await h.run('sync');
    expect(r.stdout).toContain('Applied: 4 unchanged');
    expect((await h.run('status', '--exit-code')).code).toBe(0);
  });

  test('renaming a note moves it and rewrites notes linking to it', async () => {
    edit('note:b', { title: 'Beta Prime' });
    const r = await h.run('sync');
    expect(r.stdout).toContain('1 updated, 1 moved');
    expect(existsSync(join(h.staging, 'Main/Child/Beta Prime.md'))).toBe(true);
    expect(existsSync(join(h.staging, 'Main/Child/Beta.md'))).toBe(false);
    expect(read('Main/Alpha꞉ intro.md')).toContain('[Beta](miaoyan://goto/Beta%20Prime)');
    expect((await h.run('verify')).code).toBe(0);
  });

  test('trashing and purging notes', async () => {
    edit('note:b', { bookId: 'trash' });
    fake.remove('note:c');
    const r = await h.run('sync');
    expect(r.stdout).toContain('moved');
    expect(r.stdout).toContain('1 retired');
    const deleted = readdirSync(join(h.staging, '_Inkdrop Deleted')).sort();
    expect(deleted).toEqual(['Beta (2).md', 'Beta.md', 'Gone.md', 'i']);
    expect(existsSync(join(h.staging, 'idea (2)'))).toBe(false);
  });

  test('--deletions keep leaves purged notes in place', async () => {
    fake.remove('note:c');
    await h.run('sync', '--deletions', 'keep');
    expect(existsSync(join(h.staging, 'idea (2)/Beta (2).md'))).toBe(true);
  });

  test('conflicts exit 4 until forced; status reports them', async () => {
    writeFileSync(join(h.staging, 'Main/Child/Beta.md'), 'my local edit');
    edit('note:b', { body: 'new upstream body' });
    const status = await h.run('status', '--exit-code');
    expect(status.code).toBe(ExitCode.Pending);
    expect(status.stdout).toContain('conflict (edited) Main/Child/Beta.md');

    const blocked = await h.run('sync');
    expect(blocked.code).toBe(ExitCode.Conflict);
    expect(blocked.stderr).toContain('conflict (edited): Main/Child/Beta.md');
    expect(read('Main/Child/Beta.md')).toBe('my local edit');
    expect((await h.run('report')).stdout).toContain('## Conflicts (1)');

    const forced = await h.run('sync', '--force');
    expect(forced.code).toBe(0);
    expect(forced.stderr).toContain('backed up 1 files');
    expect(read('Main/Child/Beta.md')).toContain('new upstream body');
    expect((await h.run('report')).stdout).toContain('## Backups (1)');
    const backups = join(tmp.path, 'state/ink2miao/default/backups');
    const [run] = readdirSync(backups);
    expect(readFileSync(join(backups, run as string, 'Main/Child/Beta.md'), 'utf8')).toBe(
      'my local edit',
    );
  });

  test('--rebuild rewrites staging from scratch', async () => {
    writeFileSync(join(h.staging, 'Main/Child/Beta.md'), 'local edit');
    const r = await h.run('sync', '--rebuild');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('4 created');
    expect(read('Main/Child/Beta.md')).toContain('Body of b');
  });

  test('status --remote counts upstream changes; json output', async () => {
    edit('note:a', { body: 'changed' });
    const r = await h.run('status', '--remote', '--exit-code');
    expect(r.code).toBe(ExitCode.Pending);
    expect(r.stdout).toContain('inkdrop: 1 new changes');
    const json = await h.run('--json', 'status', '--remote');
    expect(JSON.parse(json.stdout.trim())).toMatchObject({
      type: 'status',
      remote: 1,
      pending: true,
    });
    await h.run('sync');
    const clean = await h.run('status', '--remote', '--exit-code');
    expect(clean.code).toBe(0);
    expect(clean.stdout).toContain('inkdrop: 0 new changes');
  });

  test('status needs data', async () => {
    const fresh = harness(join(tmp.path, 'other'), fake.url);
    const r = await fresh.run('status');
    expect(r.code).toBe(ExitCode.Usage);
  });

  test('a concurrent run is refused by the lock', async () => {
    const lock = join(tmp.path, 'state/ink2miao/default/lock');
    const other = Bun.spawn(['sleep', '5']);
    try {
      writeFileSync(lock, String(other.pid));
      const r = await h.run('sync');
      expect(r.code).toBe(ExitCode.Usage);
      expect(r.stderr).toContain('another ink2miao run');
    } finally {
      other.kill();
    }
  });

  test('interrupting mid-run exits 130 after placing parked files', async () => {
    edit('note:b', { title: 'Renamed' });
    const ctl = new AbortController();
    h.deps = {
      signal: ctl.signal,
      platform: {
        ...(await import('../../src/platform/darwin.ts')).portablePlatform(),
        setTimes: () => ctl.abort(new Error('interrupted')),
      },
    };
    const r = await h.run('sync');
    expect(r.code).toBe(ExitCode.Interrupted);
  });
});
