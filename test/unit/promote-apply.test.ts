import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileId, NoteId } from '../../src/domain/model.ts';
import { buildSnapshot } from '../../src/domain/snapshot.ts';
import { renderAll } from '../../src/plan/render.ts';
import { portablePlatform } from '../../src/platform/darwin.ts';
import { executePromote } from '../../src/promote/apply.ts';
import type { PromotePlan } from '../../src/promote/planner.ts';
import { StateDb } from '../../src/state/db.ts';
import { sha256Hex } from '../../src/util/hash.ts';
import { verifyTree } from '../../src/verify/rules.ts';
import { memoryDb, syncInto } from '../support/apply.ts';
import { change, sampleDocs } from '../support/fixtures.ts';
import { tempDir } from '../support/tmp.ts';

let tmp: ReturnType<typeof tempDir>;
let staging: string;
let target: string;
let db: StateDb;
beforeEach(() => {
  tmp = tempDir();
  staging = join(tmp.path, 'stage');
  target = join(tmp.path, 'lib');
  mkdirSync(staging);
  mkdirSync(target);
  db = StateDb.open(':memory:');
});
afterEach(() => {
  db.close();
  tmp.cleanup();
});

const put = (root: string, rel: string, text: string) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const note = (id: string, path: string, text: string) => ({
  noteId: `note:${id}` as NoteId,
  sourceTitle: id,
  stem: id,
  path,
  hash: sha256Hex(text),
});
const deps = (signal = new AbortController().signal) => ({
  staging,
  target,
  store: db,
  platform: portablePlatform(),
  signal,
  backupDir: join(tmp.path, 'backups'),
});

test('adopt, delete with backup, keep/forget, attachment record/remove/forget/conflict', async () => {
  put(staging, 'A.md', 'a');
  put(target, 'A.md', 'a');
  put(target, 'Old/Gone.md', 'gone');
  put(target, 'i/old.png', 'o');
  const plan: PromotePlan = {
    notes: [
      { kind: 'adopt', staged: note('a', 'A.md', 'a') },
      {
        kind: 'retire',
        row: { noteId: 'note:g', path: 'Old/Gone.md', hash: 'x' },
        to: null,
        mode: 'delete',
      },
      {
        kind: 'retire',
        row: { noteId: 'note:k', path: 'K.md', hash: 'x' },
        to: null,
        mode: 'keep',
      },
      { kind: 'skip', staged: note('s', 'S.md', 's') },
      { kind: 'conflict', noteId: 'note:c', path: 'C.md', reason: 'edited' },
    ],
    files: [
      { kind: 'record', staged: { path: 'i/r.png', fileId: 'file:r' as FileId, md5: 'mr' } },
      { kind: 'remove', row: { path: 'i/old.png', md5: 'o' } },
      { kind: 'forget', row: { path: 'i/f.png', md5: 'f' } },
      { kind: 'conflict', path: 'i/c.png', reason: 'edited' },
    ],
    stats: {},
  };
  db.putPromotedNote(target, { noteId: 'note:g', path: 'Old/Gone.md', hash: 'x' });
  db.putPromotedFile(target, { path: 'i/f.png', md5: 'f' });
  const r = await executePromote(plan, deps());
  expect(r).toMatchObject({
    copied: 0,
    retired: 2,
    filesRemoved: 1,
    filesCopied: 0,
    backups: ['Old/Gone.md'],
  });
  expect(readFileSync(join(tmp.path, 'backups/Old/Gone.md'), 'utf8')).toBe('gone');
  expect(existsSync(join(target, 'Old'))).toBe(false);
  expect(existsSync(join(target, 'i'))).toBe(false);
  expect(db.promotedNotes(target)).toEqual([
    { noteId: 'note:a', path: 'A.md', hash: sha256Hex('a') },
  ]);
  expect(db.promotedFiles(target)).toEqual([{ path: 'i/r.png', md5: 'mr' }]);
});

test('forced copy backs up, abort stops before non-parked work', async () => {
  put(staging, 'A.md', 'new');
  put(target, 'A.md', 'user');
  put(staging, 'i/x.png', 'x');
  put(target, 'i/x.png', 'user-x');
  const r = await executePromote(
    {
      notes: [{ kind: 'copy', staged: note('a', 'A.md', 'new'), backup: true }],
      files: [
        {
          kind: 'copy',
          staged: { path: 'i/x.png', fileId: 'file:x' as FileId, md5: 'm' },
          backup: true,
        },
      ],
      stats: {},
    },
    deps(),
  );
  expect(r.backups).toEqual(['A.md', 'i/x.png']);
  expect(readFileSync(join(target, 'A.md'), 'utf8')).toBe('new');

  const ctl = new AbortController();
  ctl.abort();
  put(staging, 'B.md', 'b');
  const aborted = await executePromote(
    {
      notes: [{ kind: 'copy', staged: note('b', 'B.md', 'b'), backup: false }],
      files: [
        { kind: 'record', staged: { path: 'i/y.png', fileId: 'file:y' as FileId, md5: 'm' } },
      ],
      stats: {},
    },
    deps(ctl.signal),
  );
  expect(aborted.copied).toBe(0);
  expect(existsSync(join(target, 'B.md'))).toBe(false);
});

test('library verification warns about dates and pins', async () => {
  const opts = {
    linkMode: 'auto' as const,
    includeTrash: true,
    deletedFolder: '_Inkdrop Deleted',
    trashReplacement: 'Bin',
  };
  const render = renderAll(buildSnapshot(sampleDocs().map((d) => change(d))).snapshot, opts);
  const root = join(tmp.path, 'libcheck');
  await syncInto(root, render, memoryDb());
  writeFileSync(join(root, 'Main/Child/Beta.md'), readFileSync(join(root, 'Main/Child/Beta.md')));
  const r = await verifyTree(root, render, { library: true, platform: portablePlatform() });
  expect(r.errors).toEqual([]);
  const codes = r.warnings.map((w) => `${w.code}:${w.path}`);
  expect(codes).toContain('dates_differ:Main/Child/Beta.md');
  expect(codes).toContain('pin_differs:Main/Alpha꞉ intro.md');
});
