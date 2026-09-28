import { describe, expect, test } from 'bun:test';
import type { FileMeta } from '../../src/domain/model.ts';
import { buildSnapshot } from '../../src/domain/snapshot.ts';
import { extensionFor, renderAll, resolvedFile, withAncestors } from '../../src/plan/render.ts';
import { change, fileDoc, noteDoc, sampleDocs } from '../support/fixtures.ts';

const opts = {
  linkMode: 'auto' as const,
  includeTrash: true,
  deletedFolder: '_Inkdrop Deleted',
  trashReplacement: 'Bin',
};
const snapshotOf = (docs: Record<string, unknown>[]) =>
  buildSnapshot(docs.map((d) => change(d))).snapshot;

describe('renderAll', () => {
  const plan = renderAll(snapshotOf(sampleDocs()), opts);
  const byId = new Map(plan.notes.map((n) => [n.id, n]));

  test('places notes into folders with unique titles', () => {
    expect(byId.get('note:a')?.path).toBe('Main/Alpha꞉ intro.md');
    expect(byId.get('note:b')?.path).toBe('Main/Child/Beta.md');
    expect(byId.get('note:c')?.path).toBe('idea (2)/Beta (2).md');
    expect(byId.get('note:d')?.path).toBe('_Inkdrop Deleted/Gone.md');
    expect(byId.has('note:tpl')).toBe(false);
    expect(plan.skipped).toEqual([{ id: 'note:tpl', reason: 'template' }]);
    expect(plan.renames.map((r) => r.reason).sort()).toEqual(['collision', 'sanitized']);
    expect(plan.folderRenames.map((f) => f.folder)).toEqual(['idea (2)', 'Old Bin Can']);
    expect(plan.folders).toEqual(['Main', 'Main/Child', '_Inkdrop Deleted', 'idea (2)']);
  });

  test('rewrites links against assigned titles and records metadata', () => {
    const a = byId.get('note:a');
    expect(a?.content).toContain('See [[Beta]] and [the beta note](miaoyan://goto/Beta).');
    expect(a?.content).toContain('![](/i/clipboard-img1.png)');
    expect(a?.content).toContain('[code](inkdrop://note/b)');
    expect(a?.content).toContain('title: "Alpha: intro"');
    expect(a?.content).toContain('tags:\n    - alpha\n    - zeta');
    expect(a?.content).toContain('notebook: Main');
    expect(a?.pinned).toBe(true);
    expect(a?.unresolved).toEqual([{ kind: 'note', raw: 'inkdrop://note/zzz' }]);
    const c = byId.get('note:c');
    expect(c?.content).toContain('slug: keep-me # comment');
    expect(c?.content).toContain('[Alpha/intro](miaoyan://goto/Alpha%EA%9E%89%20intro)');
    const d = byId.get('note:d');
    expect(d?.content).toContain('trashed: true');
    expect(d?.content).not.toContain('notebook:');
  });

  test('copies shared attachments into every folder that uses them', () => {
    expect(plan.attachments).toHaveLength(1);
    expect(plan.attachments[0]?.paths).toEqual([
      'Main/i/clipboard-img1.png',
      '_Inkdrop Deleted/i/clipboard-img1.png',
    ]);
    expect(plan.unreferencedFiles).toBe(1);
  });

  test('excluding trash leaves links to trashed notes unresolved', () => {
    const docs = [
      ...sampleDocs(),
      noteDoc('e', {
        title: 'Root note',
        bookId: 'book:unknown',
        body: '[Gone](inkdrop://note/d)',
      }),
    ];
    const p = renderAll(snapshotOf(docs), { ...opts, includeTrash: false });
    const e = p.notes.find((n) => n.id === 'note:e');
    expect(e?.path).toBe('Root note.md');
    expect(e?.unresolved).toEqual([{ kind: 'note', raw: 'inkdrop://note/d' }]);
    expect(p.skipped.map((s) => s.reason).sort()).toEqual(['template', 'trash']);
  });

  test('keeps prior titles stable', () => {
    const prior = new Map([['note:c' as const, { sourceTitle: 'Beta', stem: 'Beta (kept)' }]]);
    const p = renderAll(snapshotOf(sampleDocs()), opts, prior);
    expect(p.notes.find((n) => n.id === 'note:c')?.path).toBe('idea (2)/Beta (kept).md');
  });
});

describe('attachments', () => {
  const meta = (over: Partial<FileMeta>): FileMeta => ({
    id: 'file:x',
    rev: '1',
    name: 'photo.JPEG',
    contentType: 'image/jpeg',
    contentLength: 1,
    md5hex: null,
    createdAt: 0,
    ...over,
  });

  test('extension from content type, then name, then bin', () => {
    expect(extensionFor(meta({}))).toBe('jpg');
    expect(extensionFor(meta({ contentType: 'application/x-foo', name: 'a.PDF' }))).toBe('pdf');
    expect(extensionFor(meta({ contentType: 'application/x-foo', name: 'noext' }))).toBe('bin');
  });

  test('non-image files go to files/', () => {
    expect(resolvedFile(meta({ contentType: 'application/pdf', name: 'spec.pdf' }))).toEqual({
      name: 'spec-x.pdf',
      image: false,
    });
    const plan = renderAll(
      snapshotOf([
        fileDoc('pdf', { contentType: 'application/pdf', name: 'spec.pdf' }),
        noteDoc('n', { bookId: 'book:none', body: '[spec](inkdrop://file:pdf)' }),
      ]),
      opts,
    );
    expect(plan.attachments[0]?.paths).toEqual(['files/spec-pdf.pdf']);
    expect(plan.notes[0]?.content).toContain('[spec](files/spec-pdf.pdf)');
  });
});

test('withAncestors', () => {
  expect(withAncestors(['a/b/c', '', 'a/d'])).toEqual(['a', 'a/b', 'a/b/c', 'a/d']);
});

test('attachments are ordered by file id', () => {
  const plan = renderAll(
    snapshotOf([
      fileDoc('b2'),
      fileDoc('a1'),
      noteDoc('n', { bookId: 'book:none', body: '![](inkdrop://file:b2) ![](inkdrop://file:a1)' }),
    ]),
    opts,
  );
  expect(plan.attachments.map((a) => a.file.id)).toEqual(['file:a1', 'file:b2']);
});
