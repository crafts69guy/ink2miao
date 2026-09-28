import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { sweepTempFiles, writeAtomic } from '../../src/apply/writer.ts';
import { tempDir } from '../support/tmp.ts';

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp.cleanup());

test('writes atomically, creating parents and replacing content', async () => {
  const p = join(tmp.path, 'a/b/c.md');
  await writeAtomic(p, 'one');
  await writeAtomic(p, new TextEncoder().encode('two'));
  expect(readFileSync(p, 'utf8')).toBe('two');
  expect(readdirSync(join(tmp.path, 'a/b'))).toEqual(['c.md']);
});

test('cleans the temp file when rename fails', async () => {
  const p = join(tmp.path, 'dir-target');
  mkdirSync(join(p, 'child'), { recursive: true });
  await expect(writeAtomic(p, 'x')).rejects.toThrow();
  expect(readdirSync(tmp.path)).toEqual(['dir-target']);
});

test('closes the handle when the write fails', async () => {
  const spy = spyOn(fsp, 'open');
  await expect(
    writeAtomic(join(tmp.path, 'x.md'), Symbol('bad') as unknown as string),
  ).rejects.toThrow();
  spy.mockRestore();
});

test('sweeps leftover temp files recursively', async () => {
  mkdirSync(join(tmp.path, 'd'));
  writeFileSync(join(tmp.path, '.ink2miao-abc.tmp'), '');
  writeFileSync(join(tmp.path, 'd/.ink2miao-def.tmp'), '');
  writeFileSync(join(tmp.path, 'd/keep.md'), '');
  expect(await sweepTempFiles(tmp.path)).toBe(2);
  expect(existsSync(join(tmp.path, 'd/keep.md'))).toBe(true);
  expect(await sweepTempFiles(join(tmp.path, 'missing'))).toBe(0);
});
