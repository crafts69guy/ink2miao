import { describe, expect, test } from 'bun:test';
import type { FileId, FileMeta, NoteId } from '../../src/domain/model.ts';
import {
  type DiskState,
  hasPendingWork,
  type PlanOptions,
  planSync,
} from '../../src/plan/planner.ts';
import type { RenderedNote, RenderPlan } from '../../src/plan/render.ts';
import type { OutAttachment, OutNote } from '../../src/state/db.ts';
import { sha256Hex } from '../../src/util/hash.ts';

const OPTS: PlanOptions = { force: false, deletions: 'move', deletedFolder: '_Deleted' };

function rn(id: string, path: string, content = `content ${id}`): RenderedNote {
  const stem = path.split('/').at(-1)?.replace(/\.md$/, '') ?? id;
  return {
    id: `note:${id}` as NoteId,
    title: stem,
    sourceTitle: stem,
    stem,
    path,
    folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
    content,
    createdAt: 0,
    updatedAt: 0,
    pinned: false,
    retired: false,
    noteRefs: [],
    fileRefs: [],
    unresolved: [],
  };
}

function row(id: string, path: string, content = `content ${id}`): OutNote {
  const stem = path.split('/').at(-1)?.replace(/\.md$/, '') ?? id;
  return {
    noteId: `note:${id}` as NoteId,
    sourceTitle: stem,
    stem,
    path,
    hash: sha256Hex(content),
  };
}

function disk(files: Record<string, string>, md5s: Record<string, string> = {}): DiskState {
  return {
    sha256: (p) => (p in files ? sha256Hex(files[p] as string) : null),
    md5: (p) => md5s[p] ?? null,
  };
}

function render(notes: RenderedNote[], attachments: RenderPlan['attachments'] = []): RenderPlan {
  return {
    notes,
    attachments,
    renames: [],
    folderRenames: [],
    skipped: [],
    unreferencedFiles: 0,
    folders: [],
  };
}

const kinds = (r: ReturnType<typeof planSync>) => r.notes.map((a) => a.kind);

describe('new notes', () => {
  test('free path → create; identical bytes → adopt', () => {
    const r = planSync(
      render([rn('a', 'A.md'), rn('b', 'B.md')]),
      [],
      [],
      disk({ 'B.md': 'content b' }),
      OPTS,
    );
    expect(kinds(r)).toEqual(['create', 'adopt']);
    expect(r.stats).toEqual({ create: 1, adopt: 1 });
  });

  test('foreign file → conflict, or create with backup when forced', () => {
    const d = disk({ 'A.md': 'mine' });
    expect(planSync(render([rn('a', 'A.md')]), [], [], d, OPTS).notes[0]).toMatchObject({
      kind: 'conflict',
      reason: 'occupied',
      path: 'A.md',
    });
    expect(
      planSync(render([rn('a', 'A.md')]), [], [], d, { ...OPTS, force: true }).notes[0],
    ).toMatchObject({
      kind: 'create',
      backup: true,
    });
  });

  test("another note's previous file does not block", () => {
    const r = planSync(
      render([rn('a', 'A.md'), rn('b', 'B2.md')]),
      [row('b', 'A.md')],
      [],
      disk({ 'A.md': 'content b' }),
      OPTS,
    );
    expect(kinds(r)).toEqual(['create', 'move']);
  });
});

describe('existing notes', () => {
  test('unchanged → skip, changed → update, missing → restore', () => {
    const r = planSync(
      render([rn('a', 'A.md'), rn('b', 'B.md', 'new b'), rn('c', 'C.md')]),
      [row('a', 'A.md'), row('b', 'B.md'), row('c', 'C.md')],
      [],
      disk({ 'A.md': 'content a', 'B.md': 'content b' }),
      OPTS,
    );
    expect(kinds(r)).toEqual(['skip', 'update', 'restore']);
  });

  test('edited → conflict; forced → update with backup', () => {
    const d = disk({ 'A.md': 'edited' });
    const prior = [row('a', 'A.md')];
    expect(planSync(render([rn('a', 'A.md')]), prior, [], d, OPTS).notes[0]).toMatchObject({
      kind: 'conflict',
      reason: 'edited',
    });
    expect(
      planSync(render([rn('a', 'A.md')]), prior, [], d, { ...OPTS, force: true }).notes[0],
    ).toMatchObject({
      kind: 'update',
      backup: true,
    });
  });

  test('moves with and without rewrite, case-only renames skip the occupancy check', () => {
    const r = planSync(
      render([rn('a', 'x/A.md'), rn('b', 'y/B.md', 'new'), rn('c', 'c.md')]),
      [row('a', 'A.md'), row('b', 'B.md'), row('c', 'C.md')],
      [],
      disk({ 'A.md': 'content a', 'B.md': 'content b', 'C.md': 'content c', 'c.md': 'content c' }),
      OPTS,
    );
    expect(r.notes).toMatchObject([
      { kind: 'move', from: 'A.md', rewrite: false, backup: false },
      { kind: 'move', from: 'B.md', rewrite: true, backup: false },
      { kind: 'move', from: 'C.md', rewrite: false, backup: false },
    ]);
  });

  test('move onto a foreign file → conflict; forced → move with backup', () => {
    const d = disk({ 'A.md': 'content a', 'x/A.md': 'someone else' });
    const prior = [row('a', 'A.md')];
    expect(planSync(render([rn('a', 'x/A.md')]), prior, [], d, OPTS).notes[0]).toMatchObject({
      kind: 'conflict',
      reason: 'occupied',
      path: 'x/A.md',
    });
    expect(
      planSync(render([rn('a', 'x/A.md')]), prior, [], d, { ...OPTS, force: true }).notes[0],
    ).toMatchObject({
      kind: 'move',
      backup: true,
    });
  });

  test('edited + moved + forced → rewrite with backup', () => {
    const r = planSync(
      render([rn('a', 'x/A.md')]),
      [row('a', 'A.md')],
      [],
      disk({ 'A.md': 'edited' }),
      { ...OPTS, force: true },
    );
    expect(r.notes[0]).toMatchObject({ kind: 'move', rewrite: true, backup: true });
  });
});

describe('retire', () => {
  const plan = (d: DiskState, opts: Partial<PlanOptions> = {}, notes: RenderedNote[] = []) =>
    planSync(render(notes), [row('a', 'Main/A.md')], [], d, { ...OPTS, ...opts }).notes.at(-1);

  test('missing file → forget', () => {
    expect(plan(disk({}))).toMatchObject({ kind: 'retire', mode: 'forget', to: null });
  });
  test('move into the deleted folder unless blocked', () => {
    expect(plan(disk({ 'Main/A.md': 'content a' }))).toMatchObject({
      mode: 'move',
      to: '_Deleted/A.md',
    });
    expect(plan(disk({ 'Main/A.md': 'content a', '_Deleted/A.md': 'x' }))).toMatchObject({
      mode: 'keep',
      to: null,
    });
    expect(plan(disk({ 'Main/A.md': 'content a' }), {}, [rn('z', '_Deleted/A.md')])).toMatchObject({
      mode: 'keep',
    });
  });
  test('keep mode and already-deleted notes stay', () => {
    expect(plan(disk({ 'Main/A.md': 'content a' }), { deletions: 'keep' })).toMatchObject({
      mode: 'keep',
    });
    const r = planSync(
      render([]),
      [row('a', '_Deleted/A.md')],
      [],
      disk({ '_Deleted/A.md': 'content a' }),
      OPTS,
    );
    expect(r.notes[0]).toMatchObject({ mode: 'keep' });
  });
  test('delete requires force and refuses edited files', () => {
    const clean = disk({ 'Main/A.md': 'content a' });
    expect(plan(clean, { deletions: 'delete' })).toMatchObject({ mode: 'keep' });
    expect(plan(clean, { deletions: 'delete', force: true })).toMatchObject({ mode: 'delete' });
    expect(plan(disk({ 'Main/A.md': 'edited' }), { deletions: 'delete' })).toMatchObject({
      kind: 'conflict',
      reason: 'edited',
    });
  });
});

describe('attachments', () => {
  const file = (id: string, md5: string | null): FileMeta => ({
    id: `file:${id}` as FileId,
    rev: '1',
    name: `${id}.png`,
    contentType: 'image/png',
    contentLength: 1,
    md5hex: md5,
    createdAt: 0,
  });
  const att = (f: FileMeta, ...paths: string[]) => ({ file: f, name: `${f.id}.png`, paths });
  const arow = (path: string, fileId: string, md5: string): OutAttachment => ({
    path,
    fileId: fileId as FileId,
    md5,
  });

  test('fetch, record, keep, gc and forget', () => {
    const f1 = file('f1', 'm1');
    const f2 = file('f2', null);
    const f3 = file('f3', null);
    const r = planSync(
      render(
        [],
        [
          att(f1, 'i/ok.png', 'i/missing.png', 'i/bad.png', 'i/norow.png'),
          att(f2, 'i/f2.png'),
          att(f3, 'i/f3.png'),
        ],
      ),
      [],
      [
        arow('i/ok.png', 'file:f1', 'm1'),
        arow('i/f2.png', 'file:f2', 'm2'),
        arow('i/old.png', 'file:x', 'mx'),
        arow('i/edited.png', 'file:y', 'my'),
        arow('i/gone.png', 'file:z', 'mz'),
      ],
      disk(
        {},
        {
          'i/ok.png': 'm1',
          'i/bad.png': 'zz',
          'i/norow.png': 'm1',
          'i/f2.png': 'm2',
          'i/f3.png': 'm3',
          'i/old.png': 'mx',
          'i/edited.png': 'changed',
        },
      ),
      OPTS,
    );
    expect(r.attachments).toEqual([
      { kind: 'record', file: f1, path: 'i/norow.png', md5: 'm1' },
      { kind: 'fetch', file: f1, paths: ['i/missing.png', 'i/bad.png'] },
      { kind: 'fetch', file: f3, paths: ['i/f3.png'] },
      { kind: 'gc', row: arow('i/old.png', 'file:x', 'mx') },
      { kind: 'forget', row: arow('i/edited.png', 'file:y', 'my'), reason: 'modified' },
      { kind: 'forget', row: arow('i/gone.png', 'file:z', 'mz'), reason: 'missing' },
    ]);
    expect(r.stats['attachment:fetch']).toBe(2);
  });
});

test('hasPendingWork', () => {
  const idle = planSync(
    render([rn('a', 'A.md')]),
    [row('a', 'A.md')],
    [],
    disk({ 'A.md': 'content a' }),
    OPTS,
  );
  expect(hasPendingWork(idle)).toBe(false);
  const conflictOnly = planSync(
    render([rn('a', 'A.md')]),
    [row('a', 'A.md')],
    [],
    disk({ 'A.md': 'x' }),
    OPTS,
  );
  expect(hasPendingWork(conflictOnly)).toBe(false);
  expect(hasPendingWork(planSync(render([rn('a', 'A.md')]), [], [], disk({}), OPTS))).toBe(true);
});
