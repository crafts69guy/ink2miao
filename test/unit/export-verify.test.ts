import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ensureStaging,
  isStaging,
  prepareStaging,
  STAGING_MARKER,
} from '../../src/apply/export.ts';
import { buildSnapshot } from '../../src/domain/snapshot.ts';
import { renderAll } from '../../src/plan/render.ts';
import { portablePlatform } from '../../src/platform/darwin.ts';
import type { Platform } from '../../src/platform/types.ts';
import { verifyTree } from '../../src/verify/rules.ts';
import { fakeSource, memoryDb, syncInto } from '../support/apply.ts';
import { change, noteDoc, sampleDocs, T0 } from '../support/fixtures.ts';
import { tempDir } from '../support/tmp.ts';

let tmp: ReturnType<typeof tempDir>;
let root: string;
beforeEach(() => {
  tmp = tempDir();
  root = join(tmp.path, 'stage');
});
afterEach(() => tmp.cleanup());

const opts = {
  linkMode: 'auto' as const,
  includeTrash: true,
  deletedFolder: '_Inkdrop Deleted',
  trashReplacement: 'Bin',
};
const plan = () => renderAll(buildSnapshot(sampleDocs().map((d) => change(d))).snapshot, opts);

describe('prepareStaging', () => {
  test('creates, marks and wipes only owned directories', async () => {
    await prepareStaging(root, join(tmp.path, 'lib'));
    expect(isStaging(root)).toBe(true);
    writeFileSync(join(root, 'old.md'), 'x');
    await prepareStaging(root, join(tmp.path, 'lib'));
    expect(isStaging(root)).toBe(true);
    expect(() => statSync(join(root, 'old.md'))).toThrow();
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

describe('ensureStaging', () => {
  test('creates missing or empty dirs, accepts owned ones, refuses others', async () => {
    await ensureStaging(root, '/lib');
    writeFileSync(join(root, 'keep.md'), 'x');
    await ensureStaging(root, '/lib');
    expect(readFileSync(join(root, 'keep.md'), 'utf8')).toBe('x');
    const foreign = join(tmp.path, 'foreign');
    mkdirSync(foreign);
    writeFileSync(join(foreign, 'a.md'), 'x');
    await expect(ensureStaging(foreign, '/lib')).rejects.toThrow('refusing to use');
    await expect(ensureStaging(foreign, foreign)).rejects.toThrow(
      'must not be the MiaoYan library',
    );
  });
});

describe('executePlan + verifyTree', () => {
  test('writes everything, applies metadata and verifies clean', async () => {
    const progress: string[] = [];
    const p = plan();
    const { result } = await syncInto(
      root,
      p,
      memoryDb(),
      {},
      {
        onProgress: (done, total, phase) => progress.push(`${phase}:${done}/${total}`),
      },
    );
    expect(result).toMatchObject({ written: 4, attachmentsWritten: 2, attachmentFailures: [] });
    expect(progress).toContain('attachments:1/1');
    expect(progress).toContain('notes:4/4');
    const st = statSync(join(root, 'Main/Alpha꞉ intro.md'));
    expect(st.birthtime.getTime()).toBe(T0);
    expect(st.mtime.getTime()).toBe(T0 + 1000);

    const report = await verifyTree(root, p);
    expect(report.errors).toEqual([]);
    expect(report.stats).toEqual({ notes: 4, attachments: 2, folders: 4 });
  });

  test('collects attachment and metadata failures', async () => {
    const failing: Platform = {
      ...portablePlatform(),
      setTimes: () => {
        throw new Error('no times');
      },
    };
    const { result } = await syncInto(
      root,
      plan(),
      memoryDb(),
      {},
      {
        source: fakeSource(() => true),
        platform: failing,
      },
    );
    expect(result.attachmentFailures).toEqual([
      { path: 'Main/i/clipboard-img1.png', error: 'boom file:img1' },
    ]);
    expect(result.metadataFailures).toHaveLength(4);
  });

  test('a note write failure propagates', async () => {
    mkdirSync(join(root, 'Main/Alpha꞉ intro.md/child'), { recursive: true });
    await expect(syncInto(root, plan(), memoryDb(), { force: true })).rejects.toThrow();
  });

  test('verify reports every kind of problem', async () => {
    const p = plan();
    await syncInto(root, p, memoryDb());
    const w = (rel: string, text: string) => {
      mkdirSync(join(root, rel, '..'), { recursive: true });
      writeFileSync(join(root, rel), text);
    };
    const alpha = readFileSync(join(root, 'Main/Alpha꞉ intro.md'), 'utf8');
    w('Main/Alpha꞉ intro.md', `${alpha}\ninkdrop://note/x`);
    w(
      'Main/Child/Beta.md',
      '---\ninkdrop:\n  id: note:wrong\n---\n![](/i/nope.png) [[Nowhere]] [x](miaoyan://goto/Nobody)',
    );
    w('Extra.md', 'extra');
    w('stray.txt', 'x');
    w('Trash Can/x.md', 'x');
    w('i/x.md', 'inside an attachment folder');
    w('_Inkdrop Deleted/i/clipboard-img1.png', 'corrupt');
    const nfd = 'Tiếng';
    w(`Decomposed/${nfd}.md`, 'nfd');
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
    const docs = [noteDoc('bad', { bookId: 'book:x', body: '---\n: [\n---\nx' })];
    const p = renderAll(buildSnapshot(docs.map((d) => change(d))).snapshot, opts);
    await syncInto(root, p, memoryDb());
    for (let i = 0; i < 101; i++) mkdirSync(join(root, `f${i}`));
    let r = await verifyTree(root, p);
    expect(r.errors.map((e) => e.code)).toEqual(['too_many_folders']);
    expect(r.warnings.map((e) => e.code)).toEqual(['bad_front_matter']);

    mkdirSync(join(tmp.path, 'emptyroot'));
    r = await verifyTree(join(tmp.path, 'emptyroot'), plan());
    expect(new Set(r.errors.map((e) => e.code))).toEqual(
      new Set(['missing_note', 'missing_attachment']),
    );
  });
});
