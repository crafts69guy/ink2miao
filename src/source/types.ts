import type { FileMeta } from '../domain/model.ts';

export type DocType = 'note' | 'book' | 'tag' | 'file';

/** One document change as stored locally (raw JSON, validated when the snapshot is built). */
export interface DocChange {
  readonly id: string;
  readonly type: DocType;
  readonly rev: string;
  readonly deleted: boolean;
  readonly doc: unknown;
}

export interface ChangeBatch {
  readonly changes: readonly DocChange[];
  readonly lastSeq: string;
}

export interface Source {
  readonly describe: string;
  probe(signal: AbortSignal): Promise<{ version: string }>;
  /** Pages through every change after `since` (null = from the beginning). */
  changes(since: string | null, signal: AbortSignal): AsyncGenerator<ChangeBatch>;
  /** Downloads an attachment binary and verifies its md5 when one is known. */
  attachment(file: FileMeta, signal: AbortSignal): Promise<Uint8Array>;
}

export function docTypeOf(id: string): DocType | null {
  const prefix = id.slice(0, id.indexOf(':'));
  return prefix === 'note' || prefix === 'book' || prefix === 'tag' || prefix === 'file'
    ? prefix
    : null;
}
