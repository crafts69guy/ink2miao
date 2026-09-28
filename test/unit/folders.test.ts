import { expect, test } from 'bun:test';
import type { Book, BookId } from '../../src/domain/model.ts';
import { assignFolders, bookPath } from '../../src/naming/folders.ts';

const b = (id: string, name: string, parent: string | null = null, createdAt = 0): Book => ({
  id: `book:${id}` as BookId,
  name,
  parentId: parent ? (`book:${parent}` as BookId) : null,
  createdAt,
});
const opts = { trashReplacement: 'Bin', deletedFolder: '_Inkdrop Deleted' };

test('nests folders and dedupes siblings case-insensitively in creation order', () => {
  const r = assignFolders(
    [b('p', 'Projects'), b('c', 'Child', 'p'), b('i2', 'idea', null, 2), b('i1', 'Idea', null, 1)],
    opts,
  );
  expect(r.paths.get('book:p')).toBe('Projects');
  expect(r.paths.get('book:c')).toBe('Projects/Child');
  expect(r.paths.get('book:i1')).toBe('Idea');
  expect(r.paths.get('book:i2')).toBe('idea (2)');
  expect(r.renamed).toEqual([{ id: 'book:i2', name: 'idea', folder: 'idea (2)' }]);
});

test('reserves the deleted folder at the root and sorts ties by id', () => {
  const r = assignFolders([b('y', '_inkdrop deleted'), b('x', 'Same'), b('w', 'Same')], opts);
  expect(r.paths.get('book:y')).toBe('_inkdrop deleted (2)');
  expect(r.paths.get('book:w')).toBe('Same');
  expect(r.paths.get('book:x')).toBe('Same (2)');
});

test('orphans and cycles attach to the root', () => {
  const r = assignFolders(
    [b('o', 'Orphan', 'missing'), b('c1', 'C1', 'c2'), b('c2', 'C2', 'c1')],
    opts,
  );
  expect(r.paths.get('book:o')).toBe('Orphan');
  expect(r.paths.get('book:c1')).toBe('C1');
  expect(r.paths.get('book:c2')).toBe('C2');
});

test('bookPath follows parents and stops at cycles or unknown ids', () => {
  const books = new Map(
    [b('p', 'Projects'), b('c', 'Child', 'p'), b('x', 'X', 'y'), b('y', 'Y', 'x')].map(
      (x) => [x.id, x] as const,
    ),
  );
  expect(bookPath('book:c', books)).toBe('Projects/Child');
  expect(bookPath('book:x', books)).toBe('Y/X');
  expect(bookPath('book:nope', books)).toBeNull();
});
