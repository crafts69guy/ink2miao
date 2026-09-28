import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileMeta } from '../domain/model.ts';
import { CliError, ExitCode } from '../util/errors.ts';
import { couchDigestToHex, md5Hex } from '../util/hash.ts';
import { FileDocSchema } from './schemas.ts';
import { type ChangeBatch, type DocChange, type DocType, docTypeOf, type Source } from './types.ts';

const TYPES: readonly DocType[] = ['note', 'book', 'tag', 'file'];

async function readDocs(dir: string): Promise<{ id: string; doc: Record<string, unknown> }[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: { id: string; doc: Record<string, unknown> }[] = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const doc = JSON.parse(await readFile(join(dir, name), 'utf8')) as Record<string, unknown>;
    if (typeof doc['_id'] === 'string') out.push({ id: doc['_id'], doc });
  }
  return out;
}

/**
 * Inkdrop's continuous JSON backup (Preferences → Backup): `data/{note,book,tag,file}/*.json`
 * plus `_deleted/`. Offline alternative to the local server; always a full read.
 */
export class BackupSource implements Source {
  readonly describe: string;

  constructor(readonly dir: string) {
    this.describe = `backup:${dir}`;
  }

  async probe(): Promise<{ version: string }> {
    const entries = await readdir(join(this.dir, 'data')).catch(() => null);
    if (entries === null) {
      throw new CliError(
        `no Inkdrop backup at ${this.dir}`,
        ExitCode.Source,
        'expected a data/ folder',
      );
    }
    return { version: 'backup' };
  }

  async #collect(root: 'data' | '_deleted', type: DocType): Promise<DocChange[]> {
    const deleted = root === '_deleted';
    const out: DocChange[] = [];
    for (const { id, doc } of await readDocs(join(this.dir, root, type))) {
      if (docTypeOf(id) !== type) continue;
      const rev = typeof doc['_rev'] === 'string' ? doc['_rev'] : '';
      out.push({ id, type, rev, deleted, doc: deleted ? null : doc });
    }
    return out;
  }

  async *changes(): AsyncGenerator<ChangeBatch> {
    const changes: DocChange[] = [];
    for (const root of ['data', '_deleted'] as const) {
      for (const type of TYPES) changes.push(...(await this.#collect(root, type)));
    }
    yield { changes, lastSeq: 'backup' };
  }

  async attachment(file: FileMeta): Promise<Uint8Array> {
    const raw = await readFile(join(this.dir, 'data', 'file', `${file.id.slice(5)}.json`), 'utf8');
    const doc = FileDocSchema.safeParse(JSON.parse(raw));
    const att = doc.success ? doc.data._attachments?.['index'] : undefined;
    if (!att?.data) throw new Error(`no attachment data for ${file.id} in the backup`);
    const bytes = new Uint8Array(Buffer.from(att.data, 'base64'));
    const expected = file.md5hex ?? (att.digest ? couchDigestToHex(att.digest) : null);
    if (expected !== null && md5Hex(bytes) !== expected) {
      throw new Error(`md5 mismatch for ${file.id} (${file.name})`);
    }
    return bytes;
  }
}
