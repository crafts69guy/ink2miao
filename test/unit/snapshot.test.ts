import { expect, test } from 'bun:test';
import { buildSnapshot, type StoredDoc } from '../../src/domain/snapshot.ts';
import { bookDoc, fileDoc, noteDoc, tagDoc } from '../support/fixtures.ts';

const stored = (type: StoredDoc['type'], doc: unknown): StoredDoc => ({
  id: String((doc as { _id?: string })._id ?? 'x'),
  type,
  doc,
});

test('builds a typed snapshot and reports invalid docs', () => {
  const b64 = Buffer.from('5d41402abc4b2a76b9719d911017c592', 'hex').toString('base64');
  const { snapshot, invalid } = buildSnapshot([
    stored(
      'note',
      noteDoc('a', { bookId: 'raw', tags: ['tag:t', 'bad'], status: 'weird', pinned: 'no' }),
    ),
    stored('note', noteDoc('t', { bookId: 'trash', createdAt: -1 })),
    stored('note', { _id: 'note:bad' }),
    stored('book', bookDoc('b', 'B', { parentBookId: 'book:p' })),
    stored('book', bookDoc('p', 'P', { parentBookId: null })),
    stored('book', { _id: 'book:bad' }),
    stored('tag', tagDoc('t', 'T')),
    stored('tag', { _id: 'tag:bad' }),
    stored('file', fileDoc('f1', { md5digest: 'ABCDEF' })),
    stored(
      'file',
      fileDoc('f2', { md5digest: undefined, _attachments: { index: { digest: `md5-${b64}` } } }),
    ),
    stored('file', fileDoc('f3', { md5digest: null })),
    stored('file', { _id: 'file:bad' }),
  ]);
  expect(invalid).toEqual(['note:bad', 'book:bad', 'tag:bad', 'file:bad']);
  const a = snapshot.notes.get('note:a');
  expect(a?.bookId).toBe('book:raw');
  expect(a?.tagIds).toEqual(['tag:t']);
  expect(a?.status).toBe('none');
  expect(a?.pinned).toBe(false);
  expect(snapshot.notes.get('note:t')?.bookId).toBe('trash');
  expect(snapshot.notes.get('note:t')?.createdAt).toBe(0);
  expect(snapshot.books.get('book:b')?.parentId).toBe('book:p');
  expect(snapshot.books.get('book:p')?.parentId).toBeNull();
  expect(snapshot.tags.get('tag:t')?.name).toBe('T');
  expect(snapshot.files.get('file:f1')?.md5hex).toBe('abcdef');
  expect(snapshot.files.get('file:f2')?.md5hex).toBe('5d41402abc4b2a76b9719d911017c592');
  expect(snapshot.files.get('file:f3')?.md5hex).toBeNull();
});
