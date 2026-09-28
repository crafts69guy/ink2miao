import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { FileId, NoteId } from '../../src/domain/model.ts';
import { type LinkMode, type TransformInput, transform } from '../../src/transform/index.ts';

const DIR = join(import.meta.dir, '../golden/transform');
const UPDATE = process.env['UPDATE_GOLDEN'] === '1';

const TITLES: Record<string, string> = {
  'note:a': 'Alpha',
  'note:b': 'Beta/Gamma',
  'note:c': 'Weird [x]',
  'note:v': 'Tài liệu – Kiến trúc',
};
const FILES: Record<string, { name: string; image: boolean }> = {
  'file:img1': { name: 'clipboard-img1.png', image: true },
  'file:doc1': { name: 'spec (v2)-doc1.pdf', image: false },
};

export function goldenInput(body: string, linkMode: LinkMode = 'auto'): TransformInput {
  return {
    body,
    linkMode,
    resolveNote: (id: NoteId) => TITLES[id] ?? null,
    resolveFile: (id: FileId) => FILES[id] ?? null,
    frontMatter: {
      id: 'note:self',
      title: 'Original: title',
      notebook: 'Projects/Child',
      tags: ['alpha', 'zeta'],
      status: 'active',
      pinned: true,
      trashed: false,
      created: '2024-01-15T08:30:00.123Z',
      updated: '2024-01-16T08:30:00.123Z',
    },
  };
}

const cases = readdirSync(DIR)
  .filter((f) => f.endsWith('.in.md'))
  .map((f) => f.slice(0, -'.in.md'.length))
  .sort();

describe('golden transform', () => {
  test('has cases', () => expect(cases.length).toBeGreaterThan(5));

  for (const name of cases) {
    test(name, async () => {
      const input = await Bun.file(join(DIR, `${name}.in.md`)).text();
      const result = transform(goldenInput(input));
      const snapshot = `${result.body}\n<!-- unresolved: ${JSON.stringify(result.unresolved)} -->\n`;
      const outPath = join(DIR, `${name}.out.md`);
      if (UPDATE) await Bun.write(outPath, snapshot);
      expect(snapshot).toBe(await Bun.file(outPath).text());

      const again = transform(goldenInput(result.body));
      expect(again.body).toBe(result.body);
    });
  }
});
