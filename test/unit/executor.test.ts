import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { priorTitles } from '../../src/cli/commands/planning.ts';
import { buildSnapshot } from '../../src/domain/snapshot.ts';
import type { PlanOptions } from '../../src/plan/planner.ts';
import { renderAll } from '../../src/plan/render.ts';
import type { StateDb } from '../../src/state/db.ts';
import { memoryDb, syncInto } from '../support/apply.ts';
import { bookDoc, change, fileDoc, noteDoc } from '../support/fixtures.ts';
import { tempDir } from '../support/tmp.ts';

type Doc = Record<string, unknown>;

let tmp: ReturnType<typeof tempDir>;
let root: string;
let db: StateDb;
beforeEach(() => {
  tmp = tempDir();
  root = join(tmp.path, 'stage');
  db = memoryDb();
});
afterEach(() => {
  db.close();
  tmp.cleanup();
});

const OPTS = {
  linkMode: 'auto' as const,
  includeTrash: true,
  deletedFolder: '_Inkdrop Deleted',
  trashReplacement: 'Bin',
};

function sync(docs: Doc[], plan: Partial<PlanOptions> = {}, deps = {}) {
  const snapshot = buildSnapshot(docs.map((d) => change(d))).snapshot;
  const render = renderAll(snapshot, OPTS, priorTitles(db.outNotes()));
  return syncInto(root, render, db, { deletedFolder: OPTS.deletedFolder, ...plan }, deps);
}

const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
const body = (rel: string) => read(rel).split('---\n').at(-1);
const book = bookDoc('m', 'Main');

describe('moves', () => {
  test('two notes swapping titles end up in the right files', async () => {
    const a = noteDoc('a', { title: 'X', bookId: 'book:m', body: 'I am a', createdAt: 1 });
    const b = noteDoc('b', { title: 'Y', bookId: 'book:m', body: 'I am b', createdAt: 2 });
    await sync([book, a, b]);
    const { plan } = await sync([book, { ...a, title: 'Y' }, { ...b, title: 'X' }]);
    expect(plan.stats).toEqual({ move: 2 });
    expect(body('Main/Y.md')).toBe('\nI am a');
    expect(body('Main/X.md')).toBe('\nI am b');
    expect(readdirSync(join(root, 'Main')).sort()).toEqual(['X.md', 'Y.md']);
  });

  test('case-only renames and backlink updates', async () => {
    const a = noteDoc('a', { title: 'abc', bookId: 'book:m' });
    const b = noteDoc('b', { title: 'Linker', bookId: 'book:m', body: '[abc](inkdrop://note/a)' });
    await sync([book, a, b]);
    expect(body('Main/Linker.md')).toBe('\n[[abc]]');
    const { plan } = await sync([book, { ...a, title: 'ABC' }, b]);
    expect(plan.stats).toEqual({ move: 1, update: 1 });
    expect(readdirSync(join(root, 'Main')).sort()).toEqual(['ABC.md', 'Linker.md']);
    expect(body('Main/Linker.md')).toBe('\n[abc](miaoyan://goto/ABC)');
  });

  test('notebook moves carry attachments and prune empty folders', async () => {
    const sub = bookDoc('s', 'Sub', { parentBookId: 'book:m' });
    const img = fileDoc('img');
    const n = noteDoc('n', { title: 'Pic', bookId: 'book:s', body: '![](inkdrop://file:img)' });
    await sync([book, sub, img, n]);
    expect(existsSync(join(root, 'Main/Sub/i/clipboard-img.png'))).toBe(true);
    const { plan } = await sync([book, sub, img, { ...n, bookId: 'book:m' }]);
    expect(plan.stats).toMatchObject({ move: 1, 'attachment:fetch': 1, 'attachment:gc': 1 });
    expect(existsSync(join(root, 'Main/Pic.md'))).toBe(true);
    expect(existsSync(join(root, 'Main/i/clipboard-img.png'))).toBe(true);
    expect(existsSync(join(root, 'Main/Sub'))).toBe(false);
  });

  test('forced move of an edited file keeps a backup', async () => {
    const a = noteDoc('a', { title: 'A', bookId: 'book:m' });
    await sync([book, a]);
    writeFileSync(join(root, 'Main/A.md'), 'my edit');
    const { result } = await sync([book, { ...a, title: 'A2' }], { force: true });
    expect(result.backups).toEqual(['Main/A.md']);
    expect(readFileSync(join(`${root}.backups`, 'Main/A.md'), 'utf8')).toBe('my edit');
    expect(read('Main/A2.md')).toContain('Body of a');
  });
});

describe('retire', () => {
  const a = noteDoc('a', { title: 'Gone soon', bookId: 'book:s' });
  const sub = bookDoc('s', 'Sub');

  test('purged notes move into the deleted folder and empty folders are pruned', async () => {
    await sync([sub, a]);
    const { plan, result } = await sync([sub]);
    expect(plan.stats).toEqual({ retire: 1 });
    expect(result.retired).toBe(1);
    expect(existsSync(join(root, '_Inkdrop Deleted/Gone soon.md'))).toBe(true);
    expect(existsSync(join(root, 'Sub'))).toBe(false);
    expect(db.outNotes()).toEqual([]);
  });

  test('keep leaves the file; delete (forced) removes it after a backup', async () => {
    await sync([sub, a]);
    await sync([sub], { deletions: 'keep' });
    expect(existsSync(join(root, 'Sub/Gone soon.md'))).toBe(true);

    db.clearOutputs();
    await sync([sub, a], { force: true });
    const { result } = await sync([sub], { deletions: 'delete', force: true });
    expect(existsSync(join(root, 'Sub/Gone soon.md'))).toBe(false);
    expect(result.backups).toEqual(['Sub/Gone soon.md']);
  });

  test('a vanished file is simply forgotten', async () => {
    await sync([sub, a]);
    Bun.spawnSync(['rm', join(root, 'Sub/Gone soon.md')]);
    const { plan } = await sync([sub]);
    expect(plan.notes[0]).toMatchObject({ kind: 'retire', mode: 'forget' });
  });
});

describe('attachments and interruption', () => {
  test('recorded, forgotten when edited, re-fetched when missing', async () => {
    const img = fileDoc('img');
    const n = noteDoc('n', { bookId: 'book:m', body: '![](inkdrop://file:img)' });
    await sync([book, img, n]);
    db.clearOutputs();
    const adopt = await sync([book, img, n]);
    expect(adopt.plan.stats).toEqual({ adopt: 1, 'attachment:record': 1 });

    writeFileSync(join(root, 'Main/i/clipboard-img.png'), 'edited');
    const refetch = await sync([book, img, n]);
    expect(refetch.plan.stats).toEqual({ skip: 1, 'attachment:fetch': 1 });

    writeFileSync(join(root, 'Main/i/clipboard-img.png'), 'edited again');
    const drop = await sync([book, img, { ...n, body: 'no image' }]);
    expect(drop.plan.attachments).toMatchObject([{ kind: 'forget', reason: 'modified' }]);
    expect(existsSync(join(root, 'Main/i/clipboard-img.png'))).toBe(true);
    expect(db.outAttachments()).toEqual([]);
  });

  test('restores deleted staging files and reports attachment metadata failures', async () => {
    const img = fileDoc('img');
    const n = noteDoc('n', { title: 'N', bookId: 'book:m', body: '![](inkdrop://file:img)' });
    await sync([book, img, n]);
    Bun.spawnSync(['rm', join(root, 'Main/N.md'), join(root, 'Main/i/clipboard-img.png')]);
    const failing = {
      ...(await import('../../src/platform/darwin.ts')).portablePlatform(),
      setTimes: () => {
        throw new Error('no times');
      },
    };
    const { plan, result } = await sync([book, img, n], {}, { platform: failing });
    expect(plan.stats).toEqual({ restore: 1, 'attachment:fetch': 1 });
    expect(result.written).toBe(1);
    expect(result.metadataFailures.map((f) => f.path)).toEqual([
      'Main/N.md',
      'Main/i/clipboard-img.png',
    ]);
    expect(existsSync(join(root, 'Main/N.md'))).toBe(true);
  });

  test('an aborted run still places parked files but skips the rest', async () => {
    const a = noteDoc('a', { title: 'A', bookId: 'book:m' });
    await sync([book, a]);
    const ctl = new AbortController();
    ctl.abort();
    const { result } = await sync(
      [book, { ...a, title: 'Moved' }, noteDoc('new', { title: 'New', bookId: 'book:m' })],
      {},
      { signal: ctl.signal },
    );
    expect(result.moved).toBe(1);
    expect(result.written).toBe(0);
    expect(existsSync(join(root, 'Main/Moved.md'))).toBe(true);
    expect(existsSync(join(root, 'Main/New.md'))).toBe(false);
  });
});
