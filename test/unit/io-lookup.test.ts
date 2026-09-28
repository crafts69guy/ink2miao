import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { findNotes } from '../../src/cli/commands/lookup.ts';
import { bunExec, shellQuote } from '../../src/cli/io/exec.ts';
import { clackPrompter } from '../../src/cli/io/prompter.ts';
import type { NoteId } from '../../src/domain/model.ts';
import type { RenderedNote } from '../../src/plan/render.ts';

function prompter() {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  return {
    p: clackPrompter({ input, output }),
    type: (keys: string, ms = 20) => setTimeout(() => input.write(keys), ms),
  };
}

describe('clackPrompter', () => {
  test('confirm yes / cancel', async () => {
    const yes = prompter();
    yes.type('y');
    yes.type('\r', 40);
    expect(await yes.p.confirm('ok?')).toBe(true);
    const cancel = prompter();
    cancel.type('\x03');
    expect(await cancel.p.confirm('ok?')).toBe(false);
  });

  test('choose single, multiple and cancel', async () => {
    const choices = [
      { value: 'a', label: 'Alpha', hint: 'A.md' },
      { value: 'b', label: 'Beta' },
    ];
    const one = prompter();
    one.type('\r');
    expect(await one.p.choose('pick', choices, false)).toEqual(['a']);
    const many = prompter();
    many.type('\t');
    many.type('\r', 40);
    expect(await many.p.choose('pick', choices, true)).toBeArray();
    const cancel = prompter();
    cancel.type('\x03');
    expect(await cancel.p.choose('pick', choices, false)).toBeNull();
  });
});

describe('exec', () => {
  test('captures output, feeds input, inherits otherwise', async () => {
    expect(await bunExec(['echo', 'hi'], { capture: true })).toEqual({
      exitCode: 0,
      stdout: 'hi\n',
    });
    expect(await bunExec(['cat'], { input: 'piped', capture: true })).toEqual({
      exitCode: 0,
      stdout: 'piped',
    });
    expect((await bunExec(['false'])).exitCode).toBe(1);
  });

  test('shellQuote', () => {
    expect(shellQuote('/usr/bin/bun')).toBe('/usr/bin/bun');
    expect(shellQuote("/a b/it's")).toBe("'/a b/it'\\''s'");
  });
});

describe('findNotes', () => {
  const n = (id: string, title: string, path: string, sourceTitle = title): RenderedNote => ({
    id: `note:${id}` as NoteId,
    title,
    sourceTitle,
    stem: title,
    path,
    folder: '',
    content: '',
    createdAt: 0,
    updatedAt: 0,
    pinned: false,
    retired: false,
    noteRefs: [],
    fileRefs: [],
    unresolved: [],
  });
  const notes = [
    n('a1', 'Alpha', 'Main/Alpha.md'),
    n('b2', 'Beta', 'Main/Beta.md', 'Beta: old'),
    n('c3', 'Alphabet', 'Other/Alphabet.md'),
  ];
  test.each([
    ['note:a1', ['note:a1']],
    ['b2', ['note:b2']],
    ['Main/Beta.md', ['note:b2']],
    ['alpha', ['note:a1']],
    ['beta: OLD', ['note:b2']],
    ['alph', ['note:a1', 'note:c3']],
    ['other/', ['note:c3']],
    ['zzz', []],
  ])('%s', (q, ids) => {
    expect(findNotes(notes, q).map((x) => x.id)).toEqual(ids as NoteId[]);
  });
});
