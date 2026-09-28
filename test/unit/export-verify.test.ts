import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isStaging, prepareStaging, STAGING_MARKER, writePlan } from '../../src/apply/export.ts';
import type { FileMeta } from '../../src/domain/model.ts';
import { buildSnapshot } from '../../src/domain/snapshot.ts';
import { renderAll } from '../../src/plan/render.ts';
import { portablePlatform } from '../../src/platform/darwin.ts';
import type { Platform } from '../../src/platform/types.ts';
import type { Source } from '../../src/source/types.ts';
import { verifyTree } from '../../src/verify/rules.ts';
import { change, noteDoc, PNG_BYTES, sampleDocs, T0 } from '../support/fixtures.ts';
import { tempDir } from '../support/tmp.ts';

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp.cleanup());

const opts = {
  linkMode: 'auto' as const,
  includeTrash: true,
  deletedFolder: '_Inkdrop Deleted',
  trashReplacement: 'Bin',
};
const plan = () => renderAll(buildSnapshot(sampleDocs().map((d) => change(d))).snapshot, opts);
const fakeSource = (fail = false): Source => ({
  describe: 'fake',
  probe: async () => ({ version: '1' }),
  async *changes() {},
  attachment: async (f: FileMeta) => {
    if (fail) throw new Error(`boom ${f.id}`);
    return PNG_BYTES;
  },
});
const signal = new AbortController().signal;

describe('prepareStaging', () => {
  test('creates, marks and wipes only owned directories', async () => {
    const dir = join(tmp.path, 'stage');
    await prepareStaging(dir, join(tmp.path, 'lib'));
    expect(isStaging(dir)).toBe(true);
    writeFileSync(join(dir, 'old.md'), 'x');
    await prepareStaging(dir, join(tmp.path, 'lib'));
    expect(isStaging(dir)).toBe(true);
    expect(() => statSync(join(dir, 'old.md'))).toThrow();
  });

  test('accepts an empty dir (ignoring .DS_Store) but refuses foreign content or the library', async () => {
    const empty = join(tmp.path, 'empty');
    mkdirSync(empty);
    writeFileSync(join(empty, '.DS_Store'), '');
    await prepareStaging(empty, '/lib');
    expect(readFileSync(join(empty, STAGING_MARKER), 'utf8')).toContain('ink2miao');

    const foreign = join(tmp.path, 'foreign');
    mkdirSync(foreign);
    writeFileSync(join(foreign, 'mine.md'), 'x');
    await expect(prepareStaging(foreign, '/lib')).rejects.toThrow('refusing to wipe');
    await expect(prepareStaging(foreign, foreign)).rejects.toThrow(
      'must not be the MiaoYan library',
    );
  });
});

describe('writePlan + verifyTree', () => {
  test('writes everything, applies metadata and verifies clean', async () => {
    const root = join(tmp.path, 'stage');
    await prepareStaging(root, '/lib');
    const progress: string[] = [];
    const p = plan();
    const result = await writePlan(root, p, {
      source: fakeSource(),
      platform: portablePlatform(),
      signal,
      concurrency: 2,
      onProgress: (done, total, phase) => progress.push(`${phase}:${done}/${total}`),
    });
    expect(result).toMatchObject({
      notesWritten: 4,
      attachmentsWritten: 2,
      attachmentFailures: [],
    });
    expect(progress).toContain('attachments:1/1');
    const st = statSync(join(root, 'Main/Alpha꞉ intro.md'));
    expect(st.birthtime.getTime()).toBe(T0);
    expect(st.mtime.getTime()).toBe(T0 + 1000);

    const report = await verifyTree(root, p);
    expect(report.errors).toEqual([]);
    expect(report.stats).toEqual({ notes: 4, attachments: 2, folders: 4 });
  });

  test('collects attachment and metadata failures', async () => {
    const root = join(tmp.path, 'stage');
    const failing: Platform = {
      ...portablePlatform(),
      setTimes: () => {
        throw new Error('no times');
      },
    };
    const result = await writePlan(root, plan(), {
      source: fakeSource(true),
      platform: failing,
      signal,
      concurrency: 1,
    });
    expect(result.attachmentFailures).toEqual([
      { path: 'Main/i/clipboard-img1.png', error: 'boom file:img1' },
    ]);
    expect(result.metadataFailures).toHaveLength(4);
  });

  test('a note write failure aborts', async () => {
    const root = join(tmp.path, 'stage');
    mkdirSync(join(root, 'Main/Alpha꞉ intro.md/child'), { recursive: true });
    await expect(
      writePlan(root, plan(), {
        source: fakeSource(),
        platform: portablePlatform(),
        signal,
        concurrency: 1,
      }),
    ).rejects.toThrow('cannot write Main/Alpha꞉ intro.md');
  });

  test('verify reports every kind of problem', async () => {
    const root = join(tmp.path, 'stage');
    const p = plan();
    await writePlan(root, p, {
      source: fakeSource(),
      platform: portablePlatform(),
      signal,
      concurrency: 2,
    });
    const w = (rel: string, text: string) => {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    w(
      'Main/Alpha꞉ intro.md',
      `${readFileSync(join(root, 'Main/Alpha꞉ intro.md'), 'utf8')}\ninkdrop://note/x`,
    );
    w(
      'Main/Child/Beta.md',
      '---\ninkdrop:\n  id: note:wrong\n---\n![](/i/nope.png) [[Nowhere]] [x](miaoyan://goto/Nobody)',
    );
    w('Extra.md', 'extra');
    w('stray.txt', 'x');
    w('Trash Can/x.md', 'x');
    w('i/x.md', 'inside an attachment folder');
    w('_Inkdrop Deleted/i/clipboard-img1.png', 'corrupt');
    w('Decomposed/Tiếng.md', 'nfd');
    const nfd = 'Tiếng';
    const r = await verifyTree(root, p);
    const codes = [...r.errors.map((e) => e.code), ...r.warnings.map((e) => e.code)].sort();
    expect(codes).toEqual(
      [
        'content_mismatch',
        'content_mismatch',
        'dangling_goto',
        'dangling_wikilink',
        'front_matter_id',
        'hidden_folder',
        'inkdrop_leftover',
        'md5_mismatch',
        'missing_attachment',
        'not_nfc',
        'stray_file',
        'unexpected_note',
        'unexpected_note',
        'unexpected_note',
        'unexpected_note',
      ].sort(),
    );
    expect(r.errors.some((e) => e.path.includes(nfd))).toBe(true);
  });

  test('verify flags missing notes/attachments, bad front matter and too many folders', async () => {
    const root = join(tmp.path, 'stage');
    const docs = [noteDoc('bad', { bookId: 'book:x', body: '---\n: [\n---\nx' })];
    const p = renderAll(buildSnapshot(docs.map((d) => change(d))).snapshot, opts);
    await writePlan(root, p, {
      source: fakeSource(),
      platform: portablePlatform(),
      signal,
      concurrency: 1,
    });
    for (let i = 0; i < 101; i++) mkdirSync(join(root, `f${i}`));
    let r = await verifyTree(root, p);
    expect(r.errors.map((e) => e.code)).toEqual(['too_many_folders']);
    expect(r.warnings.map((e) => e.code)).toEqual(['bad_front_matter']);

    const full = plan();
    r = (await verifyTree(join(tmp.path, 'emptyroot'), full).catch(() => null)) ?? r;
    mkdirSync(join(tmp.path, 'emptyroot'));
    r = await verifyTree(join(tmp.path, 'emptyroot'), full);
    expect(new Set(r.errors.map((e) => e.code))).toEqual(
      new Set(['missing_note', 'missing_attachment']),
    );
  });
});
