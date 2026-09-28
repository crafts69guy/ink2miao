import { describe, expect, test } from 'bun:test';
import type { FileId, NoteId } from '../../src/domain/model.ts';
import type { DiskState } from '../../src/plan/planner.ts';
import { type PromoteOptions, planPromote } from '../../src/promote/planner.ts';
import type { OutAttachment, OutNote, PromotedNote } from '../../src/state/db.ts';
import { sha256Hex } from '../../src/util/hash.ts';

const OPTS: PromoteOptions = { force: false, deletions: 'move', deletedFolder: '_Deleted' };
const h = (s: string) => sha256Hex(s);
const staged = (id: string, path: string, content = `c${id}`): OutNote => ({
  noteId: `note:${id}` as NoteId,
  sourceTitle: id,
  stem: id,
  path,
  hash: h(content),
});
const promoted = (id: string, path: string, content = `c${id}`): PromotedNote => ({
  noteId: `note:${id}` as NoteId,
  path,
  hash: h(content),
});
const disk = (files: Record<string, string>, md5s: Record<string, string> = {}): DiskState => ({
  sha256: (p) => (p in files ? h(files[p] as string) : null),
  md5: (p) => md5s[p] ?? null,
});
const plan = (
  s: OutNote[],
  p: PromotedNote[],
  stagingFiles: Record<string, string>,
  targetFiles: Record<string, string>,
  opts: Partial<PromoteOptions> = {},
) =>
  planPromote(
    s,
    [],
    p,
    [],
    { staging: disk(stagingFiles), target: disk(targetFiles) },
    {
      ...OPTS,
      ...opts,
    },
  );

describe('notes', () => {
  test('copy, adopt, occupied, owned-by-other and staging-dirty', () => {
    const r = plan(
      [
        staged('a', 'A.md'),
        staged('b', 'B.md'),
        staged('c', 'C.md'),
        staged('d', 'D.md'),
        staged('e', 'E.md'),
      ],
      [promoted('x', 'D.md', 'cx')],
      { 'A.md': 'ca', 'B.md': 'cb', 'C.md': 'cc', 'D.md': 'cd', 'E.md': 'dirty' },
      { 'B.md': 'cb', 'C.md': 'mine', 'D.md': 'cx' },
    );
    expect(r.notes.map((a) => a.kind)).toEqual([
      'copy',
      'adopt',
      'conflict',
      'copy',
      'conflict',
      'retire',
    ]);
    expect(r.notes[2]).toMatchObject({ reason: 'occupied', path: 'C.md' });
    expect(r.notes[4]).toMatchObject({ reason: 'staging-dirty' });
    const forced = plan(
      [staged('c', 'C.md')],
      [],
      { 'C.md': 'cc' },
      { 'C.md': 'mine' },
      { force: true },
    );
    expect(forced.notes[0]).toMatchObject({ kind: 'copy', backup: true });
  });

  test('known notes: skip, update, move, deleted and edited in MiaoYan', () => {
    const s = { 'A.md': 'ca', 'B.md': 'cb2', 'x/C.md': 'cc', 'D.md': 'cd', 'E.md': 'ce' };
    const r = plan(
      [
        staged('a', 'A.md'),
        staged('b', 'B.md', 'cb2'),
        staged('c', 'x/C.md'),
        staged('d', 'D.md'),
        staged('e', 'E.md'),
      ],
      [
        promoted('a', 'A.md'),
        promoted('b', 'B.md'),
        promoted('c', 'C.md'),
        promoted('d', 'D.md'),
        promoted('e', 'E.md'),
      ],
      s,
      { 'A.md': 'ca', 'B.md': 'cb', 'C.md': 'cc', 'E.md': 'edited in miaoyan' },
    );
    expect(r.notes).toMatchObject([
      { kind: 'skip' },
      { kind: 'copy', backup: false },
      { kind: 'move', from: 'C.md', rewrite: false, backup: false },
      { kind: 'conflict', reason: 'deleted', path: 'D.md' },
      { kind: 'conflict', reason: 'edited', path: 'E.md' },
    ]);
    const forced = plan(
      [staged('d', 'D.md'), staged('e', 'y/E.md'), staged('f', 'F.md')],
      [promoted('d', 'D.md'), promoted('e', 'E.md'), promoted('f', 'F.md')],
      { 'D.md': 'cd', 'y/E.md': 'ce', 'F.md': 'cf' },
      { 'E.md': 'edited', 'F.md': 'edited' },
      { force: true },
    );
    expect(forced.notes).toMatchObject([
      { kind: 'copy', backup: false },
      { kind: 'move', rewrite: true, backup: true },
      { kind: 'copy', backup: true },
    ]);
  });

  test('retire modes', () => {
    const retire = (
      target: Record<string, string>,
      opts: Partial<PromoteOptions> = {},
      extra: OutNote[] = [],
    ) =>
      plan(
        extra,
        [promoted('a', 'Main/A.md')],
        Object.fromEntries(extra.map((e) => [e.path, `c${e.noteId.slice(5)}`])),
        target,
        opts,
      ).notes.at(-1);
    expect(retire({})).toMatchObject({ mode: 'forget' });
    expect(retire({ 'Main/A.md': 'ca' })).toMatchObject({ mode: 'move', to: '_Deleted/A.md' });
    expect(retire({ 'Main/A.md': 'ca', '_Deleted/A.md': 'x' })).toMatchObject({ mode: 'keep' });
    expect(retire({ 'Main/A.md': 'ca' }, {}, [staged('z', '_Deleted/A.md')])).toMatchObject({
      mode: 'keep',
    });
    expect(retire({ 'Main/A.md': 'edited' })).toMatchObject({ mode: 'keep' });
    expect(retire({ 'Main/A.md': 'ca' }, { deletions: 'keep' })).toMatchObject({ mode: 'keep' });
    expect(retire({ 'Main/A.md': 'ca' }, { deletions: 'delete' })).toMatchObject({ mode: 'keep' });
    expect(retire({ 'Main/A.md': 'ca' }, { deletions: 'delete', force: true })).toMatchObject({
      mode: 'delete',
    });
    expect(retire({ 'Main/A.md': 'edited' }, { deletions: 'delete' })).toMatchObject({
      kind: 'conflict',
    });
    expect(retire({ 'Main/A.md': 'edited' }, { deletions: 'delete', force: true })).toMatchObject({
      mode: 'delete',
    });
    const already = plan([], [promoted('a', '_Deleted/A.md')], {}, { '_Deleted/A.md': 'ca' });
    expect(already.notes[0]).toMatchObject({ mode: 'keep' });
  });
});

test('attachments', () => {
  const f = (path: string, md5: string): OutAttachment => ({
    path,
    fileId: 'file:x' as FileId,
    md5,
  });
  const r = planPromote(
    [],
    [
      f('i/new.png', 'm'),
      f('i/same.png', 'm'),
      f('i/known.png', 'm'),
      f('i/changed.png', 'm2'),
      f('i/edited.png', 'm'),
      f('i/foreign.png', 'm'),
      f('i/dirty.png', 'm'),
    ],
    [],
    [
      { path: 'i/known.png', md5: 'm' },
      { path: 'i/changed.png', md5: 'm1' },
      { path: 'i/edited.png', md5: 'm' },
      { path: 'i/old.png', md5: 'o' },
      { path: 'i/kept.png', md5: 'k' },
    ],
    {
      staging: disk(
        {},
        {
          'i/new.png': 'm',
          'i/same.png': 'm',
          'i/known.png': 'm',
          'i/changed.png': 'm2',
          'i/edited.png': 'm',
          'i/foreign.png': 'm',
          'i/dirty.png': 'zz',
        },
      ),
      target: disk(
        {},
        {
          'i/same.png': 'm',
          'i/known.png': 'm',
          'i/changed.png': 'm1',
          'i/edited.png': 'user',
          'i/foreign.png': 'other',
          'i/old.png': 'o',
          'i/kept.png': 'changed',
        },
      ),
    },
    OPTS,
  );
  expect(r.files.map((a) => (a.kind === 'conflict' ? `conflict:${a.reason}` : a.kind))).toEqual([
    'copy',
    'record',
    'copy',
    'conflict:edited',
    'conflict:occupied',
    'remove',
    'forget',
  ]);
  expect(r.stats).toEqual({
    'file:copy': 2,
    'file:record': 1,
    'file:conflict': 2,
    'file:remove': 1,
    'file:forget': 1,
  });
  const forced = planPromote(
    [],
    [f('i/foreign.png', 'm')],
    [],
    [],
    {
      staging: disk({}, { 'i/foreign.png': 'm' }),
      target: disk({}, { 'i/foreign.png': 'other' }),
    },
    { ...OPTS, force: true },
  );
  expect(forced.files).toMatchObject([{ kind: 'copy', backup: true }]);
});
