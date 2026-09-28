import { describe, expect, test } from 'bun:test';
import { isInkdropUrl, parseFileUrl, parseNoteUrl, stripPrefix } from '../../src/domain/ids.ts';
import { emptySnapshot, isRetired } from '../../src/domain/model.ts';

describe('parseNoteUrl', () => {
  test.each([
    ['inkdrop://note/abc_D-1', { id: 'note:abc_D-1', fragment: null }],
    ['inkdrop://note:abc', { id: 'note:abc', fragment: null }],
    ['  inkdrop://note/abc#heading ', { id: 'note:abc', fragment: 'heading' }],
    ['inkdrop://note/abc?x=1', { id: 'note:abc', fragment: 'x=1' }],
    ['inkdrop://note/abc#', { id: 'note:abc', fragment: null }],
  ])('%s', (url, expected) => {
    expect(parseNoteUrl(url)).toEqual(expected as never);
  });

  test.each(['inkdrop://file:abc', 'https://x', 'inkdrop://note/', 'inkdrop://note/a b'])(
    'rejects %s',
    (url) => {
      expect(parseNoteUrl(url)).toBeNull();
    },
  );
});

describe('parseFileUrl', () => {
  test('both separators and query are accepted', () => {
    expect(parseFileUrl('inkdrop://file:-7RuviIs')).toBe('file:-7RuviIs');
    expect(parseFileUrl('inkdrop://file/abc?x')).toBe('file:abc');
    expect(parseFileUrl('inkdrop://note/abc')).toBeNull();
  });
});

test('isInkdropUrl and stripPrefix', () => {
  expect(isInkdropUrl(' inkdrop://anything')).toBe(true);
  expect(isInkdropUrl('miaoyan://goto/x')).toBe(false);
  expect(stripPrefix('note:abc')).toBe('abc');
  expect(stripPrefix('plain')).toBe('plain');
});

test('model helpers', () => {
  const s = emptySnapshot();
  expect(s.notes.size + s.books.size + s.tags.size + s.files.size).toBe(0);
  const base = {
    id: 'note:x',
    rev: '1',
    title: '',
    body: '',
    tagIds: [],
    status: 'none',
    pinned: false,
    createdAt: 0,
    updatedAt: 0,
  } as const;
  expect(isRetired({ ...base, bookId: 'trash' })).toBe(true);
  expect(isRetired({ ...base, bookId: 'book:a' })).toBe(false);
});
