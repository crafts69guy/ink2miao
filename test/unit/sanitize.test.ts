import { describe, expect, test } from 'bun:test';
import {
  attachmentFileName,
  bookToFolderName,
  byteLength,
  COLON_SUBSTITUTE,
  capBytes,
  nameKey,
  normalizeTitle,
  stemToDisplayTitle,
  titleToStem,
  withSuffix,
} from '../../src/naming/sanitize.ts';

const opts = { trashReplacement: 'Bin' };

describe('titleToStem', () => {
  test.each([
    ['Plain title', 'Plain title'],
    ['a/b', 'a:b'],
    ['Phase 3: Auth', `Phase 3${COLON_SUBSTITUTE} Auth`],
    ['  many   spaces\n\tand\u0001control ', 'many spaces and control'],
    ['...hidden', 'hidden'],
    ['', 'Untitled'],
    ['...', 'Untitled'],
  ])('%j → %j', (title, stem) => {
    expect(titleToStem(title)).toBe(stem);
  });

  test('normalizes NFD Vietnamese to NFC', () => {
    const nfd = 'Tiếng Việt'.normalize('NFD');
    expect(titleToStem(nfd)).toBe('Tiếng Việt'.normalize('NFC'));
  });

  test('caps bytes on grapheme boundaries', () => {
    const stem = titleToStem('ệ'.repeat(200), 10);
    expect(byteLength(stem)).toBeLessThanOrEqual(10);
    expect(stem).toBe('ệ'.repeat(3));
  });
});

test('capBytes keeps short strings and trims the cut', () => {
  expect(capBytes('abc', 10)).toBe('abc');
  expect(capBytes('ab cd', 3)).toBe('ab');
  expect(capBytes('😀😀', 5)).toBe('😀');
});

test('display title, keys and suffixes', () => {
  expect(stemToDisplayTitle('a:b')).toBe('a/b');
  expect(nameKey('ÀBC'.normalize('NFD'))).toBe('àbc');
  expect(normalizeTitle(' a  b ')).toBe('a b');
  expect(withSuffix('Title', 2, 100)).toBe('Title (2)');
  expect(byteLength(withSuffix('x'.repeat(50), 12, 20))).toBe(20);
});

describe('bookToFolderName', () => {
  test.each([
    ['Projects', 'Projects'],
    ['a/b', 'a-b'],
    ['c: d', `c${COLON_SUBSTITUTE} d`],
    ['My Trash bin', 'My Bin bin'],
    ['.dot', 'dot'],
    ['', 'Untitled Notebook'],
    ['i', 'i (notebook)'],
    ['Files', 'Files (notebook)'],
  ])('%j → %j', (name, folder) => {
    expect(bookToFolderName(name, opts)).toBe(folder);
  });
});

describe('attachmentFileName', () => {
  test.each([
    ['clipboard.png', 'abc', 'png', 'clipboard-abc.png'],
    ['my (photo)!.JPG', 'x1', 'jpg', 'my-photo-x1.jpg'],
    ['.hidden', 'y', 'png', 'hidden-y.png'],
    ['***', 'z', 'gif', 'file-z.gif'],
    ['Ảnh cưới.jpeg', 'q', 'jpg', 'Ảnh-cưới-q.jpg'],
  ])('%j', (name, id, ext, expected) => {
    expect(attachmentFileName(name, id, ext)).toBe(expected);
  });
});
