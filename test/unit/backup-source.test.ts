import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileMeta } from '../../src/domain/model.ts';
import { BackupSource } from '../../src/source/backup.ts';
import { CliError } from '../../src/util/errors.ts';
import { fileDoc, noteDoc, PNG_BYTES, PNG_MD5 } from '../support/fixtures.ts';
import { tempDir } from '../support/tmp.ts';

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp.cleanup());

export function writeBackup(
  root: string,
  docs: Record<string, unknown>[],
  deleted: Record<string, unknown>[] = [],
) {
  for (const [dir, list] of [
    ['data', docs],
    ['_deleted', deleted],
  ] as const) {
    for (const doc of list) {
      const id = String(doc['_id']);
      const [type, short] = id.split(':') as [string, string];
      mkdirSync(join(root, dir, type), { recursive: true });
      writeFileSync(join(root, dir, type, `${short}.json`), JSON.stringify(doc));
    }
  }
}

const meta = (id: string, md5: string | null = PNG_MD5): FileMeta => ({
  id: `file:${id}`,
  rev: '1',
  name: 'x.png',
  contentType: 'image/png',
  contentLength: 1,
  md5hex: md5,
  createdAt: 0,
});

test('reads data and _deleted docs in one batch', async () => {
  const b64 = Buffer.from(PNG_BYTES).toString('base64');
  writeBackup(
    tmp.path,
    [
      noteDoc('a'),
      fileDoc('f', { _attachments: { index: { data: b64, content_type: 'image/png' } } }),
    ],
    [noteDoc('gone')],
  );
  mkdirSync(join(tmp.path, 'data/note'), { recursive: true });
  writeFileSync(join(tmp.path, 'data/note/misplaced.json'), JSON.stringify({ _id: 'book:x' }));
  writeFileSync(join(tmp.path, 'data/note/noid.json'), JSON.stringify({ title: 'no id' }));
  writeFileSync(join(tmp.path, 'data/note/readme.txt'), 'ignored');
  const s = new BackupSource(tmp.path);
  expect(s.describe).toBe(`backup:${tmp.path}`);
  expect(await s.probe()).toEqual({ version: 'backup' });
  const batches = [];
  for await (const b of s.changes()) batches.push(b);
  expect(batches).toHaveLength(1);
  expect(batches[0]?.lastSeq).toBe('backup');
  expect(batches[0]?.changes.map((c) => `${c.id}:${c.deleted}`)).toEqual([
    'note:a:false',
    'file:f:false',
    'note:gone:true',
  ]);
  expect(await s.attachment(meta('f'))).toEqual(PNG_BYTES);
  await expect(s.attachment(meta('f', 'ffff'))).rejects.toThrow('md5 mismatch');
});

test('missing backup, missing attachment data, digest fallback', async () => {
  await expect(new BackupSource(join(tmp.path, 'none')).probe()).rejects.toBeInstanceOf(CliError);
  writeBackup(tmp.path, [
    fileDoc('empty'),
    fileDoc('dig', {
      _attachments: { index: { data: 'AAAA', digest: 'md5-AAAAAAAAAAAAAAAAAAAAAA==' } },
    }),
  ]);
  const s = new BackupSource(tmp.path);
  await expect(s.attachment(meta('empty'))).rejects.toThrow('no attachment data');
  await expect(s.attachment(meta('dig', null))).rejects.toThrow('md5 mismatch');
});
