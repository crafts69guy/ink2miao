import { describe, expect, test } from 'bun:test';
import type { NoteId } from '../../src/domain/model.ts';
import { assignTitles, type TitleCandidate } from '../../src/naming/titles.ts';

const c = (id: string, title: string, createdAt = 0, retired = false): TitleCandidate => ({
  id: `note:${id}` as NoteId,
  title,
  createdAt,
  retired,
});

describe('assignTitles', () => {
  test('unique titles pass through untouched', () => {
    const r = assignTitles([c('a', 'One'), c('b', 'Two')]);
    expect([...r.stems.values()].sort()).toEqual(['One', 'Two']);
    expect(r.renames).toEqual([]);
  });

  test('collisions: live before retired, older before newer, then id', () => {
    const r = assignTitles([
      c('z', 'Same', 5, true),
      c('y', 'same', 9),
      c('x', 'Same', 1),
      c('w', 'Same', 9),
    ]);
    expect(r.stems.get('note:x')).toBe('Same');
    expect(r.stems.get('note:w')).toBe('Same (2)');
    expect(r.stems.get('note:y')).toBe('same (3)');
    expect(r.stems.get('note:z')).toBe('Same (4)');
    expect(r.renames.map((x) => x.reason)).toEqual(['collision', 'collision', 'collision']);
  });

  test('visible sanitization is reported, `/` → `:` is not', () => {
    const r = assignTitles([c('a', 'A: b'), c('b', 'x/y'), c('c', ' spaced ')]);
    expect(r.renames).toEqual([{ id: 'note:a', from: null, to: 'A꞉ b', reason: 'sanitized' }]);
  });

  test('incumbents keep their stem; changed titles are re-claimed', () => {
    const prior = new Map([
      ['note:a' as NoteId, { sourceTitle: 'Same', stem: 'Same (2)' }],
      ['note:b' as NoteId, { sourceTitle: 'Old', stem: 'Old' }],
    ]);
    const r = assignTitles([c('a', 'Same', 9), c('b', 'New', 0), c('n', 'Same', 1)], prior);
    expect(r.stems.get('note:a')).toBe('Same (2)');
    expect(r.stems.get('note:n')).toBe('Same');
    expect(r.stems.get('note:b')).toBe('New');
    expect(r.renames).toContainEqual({ id: 'note:b', from: 'Old', to: 'New', reason: 'changed' });
  });

  test('an incumbent whose stem is already taken re-claims', () => {
    const prior = new Map([
      ['note:a' as NoteId, { sourceTitle: 'T', stem: 'T' }],
      ['note:b' as NoteId, { sourceTitle: 'T', stem: 'T' }],
    ]);
    const r = assignTitles([c('a', 'T', 0), c('b', 'T', 1)], prior);
    expect(r.stems.get('note:a')).toBe('T');
    expect(r.stems.get('note:b')).toBe('T (2)');
  });

  test('unchanged prior with same stem produces no rename', () => {
    const prior = new Map([['note:a' as NoteId, { sourceTitle: 'Old', stem: 'X' }]]);
    const r = assignTitles([c('a', 'X')], prior);
    expect(r.renames).toEqual([]);
  });
});
