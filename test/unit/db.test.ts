import { afterEach, beforeEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { StateDb } from '../../src/state/db.ts';
import { bookDoc, change, noteDoc } from '../support/fixtures.ts';
import { tempDir } from '../support/tmp.ts';

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp.cleanup());

test('migrates, upserts, counts and reopens', () => {
  const path = join(tmp.path, 'nested/state.db');
  const db = StateDb.open(path);
  expect(db.schemaVersion).toBe(1);
  db.upsertDocs([change(noteDoc('a')), change(bookDoc('b', 'B')), change(noteDoc('x'), true)]);
  db.upsertDocs([change({ ...noteDoc('a'), _rev: '2-z', title: 'Changed' })]);
  expect(db.countDocs()).toEqual({ note: 1, book: 1, tag: 0, file: 0, deleted: 1 });
  const live = db.liveDocs();
  expect(live.map((d) => d.id)).toEqual(['book:b', 'note:a']);
  expect(live[1]?.doc).toMatchObject({ title: 'Changed' });
  expect(db.getMeta('k')).toBeNull();
  db.setMeta('k', 'v1');
  db.setMeta('k', 'v2');
  expect(db.getMeta('k')).toBe('v2');
  db.close();

  const again = StateDb.open(path);
  expect(again.schemaVersion).toBe(1);
  expect(again.getMeta('k')).toBe('v2');
  again.close();
});

test('in-memory database and null docs', () => {
  const db = StateDb.open(':memory:');
  db.upsertDocs([{ id: 'note:n', type: 'note', rev: '1', deleted: true, doc: undefined }]);
  expect(db.countDocs().deleted).toBe(1);
  db.close();
});
