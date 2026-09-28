import { describe, expect, test } from 'bun:test';
import { applyFrontMatter, readFrontMatterId } from '../../src/transform/frontmatter.ts';
import {
  applyEdits,
  attachmentHref,
  gotoUrl,
  normalizeEol,
  transform,
} from '../../src/transform/index.ts';
import { maskProtected, scanMarkdown } from '../../src/transform/scan.ts';
import { goldenInput } from './golden.test.ts';

describe('link modes', () => {
  const body = '[the alpha](inkdrop://note/a) [Alpha](inkdrop://note/a) [Weird](inkdrop://note/c)';
  const links = (mode: 'auto' | 'wikilink' | 'goto') =>
    transform(goldenInput(body, mode)).body.split('---\n').at(-1);

  test('auto keeps custom text', () => {
    expect(links('auto')).toBe(
      '\n[the alpha](miaoyan://goto/Alpha) [[Alpha]] [Weird](miaoyan://goto/Weird%20%5Bx%5D)',
    );
  });
  test('wikilink always uses [[title]] when safe', () => {
    expect(links('wikilink')).toBe('\n[[Alpha]] [[Alpha]] [Weird](miaoyan://goto/Weird%20%5Bx%5D)');
  });
  test('goto never uses wikilinks', () => {
    expect(links('goto')).toBe(
      '\n[the alpha](miaoyan://goto/Alpha) [Alpha](miaoyan://goto/Alpha) [Weird](miaoyan://goto/Weird%20%5Bx%5D)',
    );
  });
  test('an image pointing at a note becomes a goto URL', () => {
    const r = transform(goldenInput('![Alpha](inkdrop://note/a)'));
    expect(r.body.endsWith('![Alpha](miaoyan://goto/Alpha)')).toBe(true);
    expect(r.noteRefs).toEqual(['note:a']);
  });
  test('refs are deduplicated', () => {
    const r = transform(
      goldenInput('[Alpha](inkdrop://note/a) ![a](inkdrop://file:img1) ![b](inkdrop://file:img1)'),
    );
    expect(r.noteRefs).toEqual(['note:a']);
    expect(r.fileRefs).toEqual(['file:img1']);
    expect(r.edits).toBe(3);
  });
  test('alt text with nested brackets is not cleaned', () => {
    const r = transform(goldenInput('![w:3 [x](inkdrop://note/a)](inkdrop://file:img1)'));
    expect(r.body).toContain('![w:3 [x](miaoyan://goto/Alpha)](/i/clipboard-img1.png)');
  });
});

describe('helpers', () => {
  test('gotoUrl and attachmentHref', () => {
    expect(gotoUrl('A/B (1)')).toBe('miaoyan://goto/A%2FB%20%281%29');
    expect(attachmentHref({ name: 'a b.png', image: true }, false)).toBe('/i/a%20b.png');
    expect(attachmentHref({ name: 'a.png', image: true }, true)).toBe('i/a.png');
    expect(attachmentHref({ name: 'a.pdf', image: false }, false)).toBe('files/a.pdf');
  });

  test('applyEdits splices from the end and rejects overlaps', () => {
    expect(
      applyEdits('abcdef', [
        { start: 0, end: 1, text: 'X' },
        { start: 4, end: 6, text: 'YZ!' },
      ]),
    ).toBe('XbcdYZ!');
    expect(() =>
      applyEdits('abcdef', [
        { start: 0, end: 3, text: '' },
        { start: 2, end: 4, text: '' },
      ]),
    ).toThrow('overlapping');
  });

  test('normalizeEol', () => {
    expect(normalizeEol('a\r\nb\rc\n')).toBe('a\nb\nc\n');
  });

  test('maskProtected keeps length', () => {
    const doc = 'a `code` b';
    const scan = scanMarkdown(doc);
    const masked = maskProtected(doc, scan.protectedRanges);
    expect(masked).toHaveLength(doc.length);
    expect(masked).toBe('a        b');
  });

  test('scan reports label text lazily and definitions/autolinks', () => {
    const doc = '[**b** c](u)\n\n[r]: v\n\n<ab://x>';
    const scan = scanMarkdown(doc);
    const [link] = scan.sites;
    expect(link?.site).toBe('resource');
    if (link?.site === 'resource') expect(scan.textAt(link.node.start)).toBe('b c');
    expect(scan.textAt(999)).toBe('');
    expect(scan.sites.map((s) => s.site)).toEqual(['resource', 'definition', 'autolink']);
  });
});

describe('front matter', () => {
  const meta = goldenInput('').frontMatter;

  test('readFrontMatterId', () => {
    const out = applyFrontMatter('Body', null, meta).body;
    const end = out.indexOf('---', 3) + 3;
    expect(readFrontMatterId(out.slice(0, end))).toBe('note:self');
    expect(readFrontMatterId('---\n: [\n---')).toBeNull();
    expect(readFrontMatterId('---\nfoo: 1\n---')).toBeNull();
  });

  test('omits optional keys and marks trashed notes', () => {
    const out = applyFrontMatter('', null, {
      ...meta,
      title: null,
      notebook: null,
      trashed: true,
    }).body;
    expect(out).not.toContain('title:');
    expect(out).not.toContain('notebook:');
    expect(out).toContain('trashed: true');
    expect(out.endsWith('---\n')).toBe(true);
  });

  test('replaces an existing key with no value', () => {
    const body = '---\na: 1\ninkdrop:\n---\nx';
    const r = applyFrontMatter(body, { start: 0, end: body.indexOf('\nx') }, meta);
    expect(r.bad).toBe(false);
    expect(r.body.match(/inkdrop:/g)).toHaveLength(1);
  });

  test('keeps a front matter without a trailing newline intact', () => {
    const body = '---\na: 1\n---';
    const r = applyFrontMatter(body, { start: 0, end: body.length }, meta);
    expect(r.body.startsWith('---\na: 1\ninkdrop:\n')).toBe(true);
  });
});
