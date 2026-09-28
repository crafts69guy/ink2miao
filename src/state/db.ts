import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FileId, NoteId } from '../domain/model.ts';
import type { StoredDoc } from '../domain/snapshot.ts';
import type { DocChange, DocType } from '../source/types.ts';

const MIGRATIONS: readonly string[] = [
  `CREATE TABLE docs (
     id TEXT PRIMARY KEY,
     type TEXT NOT NULL,
     rev TEXT NOT NULL,
     json TEXT NOT NULL,
     deleted INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX docs_type ON docs(type);
   CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  `CREATE TABLE notes_out (
     note_id TEXT PRIMARY KEY,
     source_title TEXT NOT NULL,
     stem TEXT NOT NULL,
     path TEXT NOT NULL,
     hash TEXT NOT NULL
   );
   CREATE TABLE attachments_out (
     path TEXT PRIMARY KEY,
     file_id TEXT NOT NULL,
     md5 TEXT NOT NULL
   );`,
];

/** What ink2miao last wrote for a note (the basis for incremental planning). */
export interface OutNote {
  readonly noteId: NoteId;
  readonly sourceTitle: string;
  readonly stem: string;
  readonly path: string;
  /** sha256 of the bytes written. */
  readonly hash: string;
}

export interface OutAttachment {
  readonly path: string;
  readonly fileId: FileId;
  readonly md5: string;
}

interface DocRow {
  id: string;
  type: DocType;
  json: string;
}

/** Local state: a mirror of Inkdrop docs plus run metadata (`bun:sqlite`, WAL). */
export class StateDb {
  readonly #db: Database;

  private constructor(db: Database) {
    this.#db = db;
  }

  static open(path: string): StateDb {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path, { create: true, strict: true });
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA foreign_keys = ON');
    const state = new StateDb(db);
    state.#migrate();
    return state;
  }

  #migrate(): void {
    const row = this.#db.query<{ user_version: number }, []>('PRAGMA user_version').get();
    const current = row?.user_version ?? 0;
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.#db.transaction(() => {
        this.#db.run(MIGRATIONS[v] as string);
        this.#db.run(`PRAGMA user_version = ${v + 1}`);
      })();
    }
  }

  get schemaVersion(): number {
    return (
      this.#db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0
    );
  }

  upsertDocs(changes: readonly DocChange[]): void {
    const upsert = this.#db.query(
      `INSERT INTO docs (id, type, rev, json, deleted) VALUES ($id, $type, $rev, $json, $deleted)
       ON CONFLICT(id) DO UPDATE SET rev = $rev, json = $json, deleted = $deleted, type = $type`,
    );
    this.#db.transaction(() => {
      for (const c of changes) {
        upsert.run({
          id: c.id,
          type: c.type,
          rev: c.rev,
          json: JSON.stringify(c.doc ?? null),
          deleted: c.deleted ? 1 : 0,
        });
      }
    })();
  }

  /** Live (non-deleted) docs, ready for `buildSnapshot`. */
  liveDocs(): StoredDoc[] {
    return this.#db
      .query<DocRow, []>('SELECT id, type, json FROM docs WHERE deleted = 0 ORDER BY id')
      .all()
      .map((r) => ({ id: r.id, type: r.type, doc: JSON.parse(r.json) as unknown }));
  }

  countDocs(): Record<DocType | 'deleted', number> {
    const out: Record<DocType | 'deleted', number> = {
      note: 0,
      book: 0,
      tag: 0,
      file: 0,
      deleted: 0,
    };
    const rows = this.#db
      .query<{ type: DocType; deleted: number; n: number }, []>(
        'SELECT type, deleted, COUNT(*) AS n FROM docs GROUP BY type, deleted',
      )
      .all();
    for (const r of rows) {
      if (r.deleted) out.deleted += r.n;
      else out[r.type] += r.n;
    }
    return out;
  }

  getMeta(key: string): string | null {
    return (
      this.#db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?').get(key)
        ?.value ?? null
    );
  }

  setMeta(key: string, value: string): void {
    this.#db
      .query(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  outNotes(): OutNote[] {
    return this.#db
      .query<OutNote, []>(
        'SELECT note_id AS noteId, source_title AS sourceTitle, stem, path, hash FROM notes_out ORDER BY note_id',
      )
      .all();
  }

  putOutNote(row: OutNote): void {
    this.#db
      .query(
        `INSERT INTO notes_out (note_id, source_title, stem, path, hash)
         VALUES ($noteId, $sourceTitle, $stem, $path, $hash)
         ON CONFLICT(note_id) DO UPDATE SET source_title = $sourceTitle, stem = $stem,
           path = $path, hash = $hash`,
      )
      .run({ ...row });
  }

  deleteOutNote(noteId: NoteId): void {
    this.#db.query('DELETE FROM notes_out WHERE note_id = ?').run(noteId);
  }

  outAttachments(): OutAttachment[] {
    return this.#db
      .query<OutAttachment, []>(
        'SELECT path, file_id AS fileId, md5 FROM attachments_out ORDER BY path',
      )
      .all();
  }

  putOutAttachment(row: OutAttachment): void {
    this.#db
      .query(
        `INSERT INTO attachments_out (path, file_id, md5) VALUES ($path, $fileId, $md5)
         ON CONFLICT(path) DO UPDATE SET file_id = $fileId, md5 = $md5`,
      )
      .run({ ...row });
  }

  deleteOutAttachment(path: string): void {
    this.#db.query('DELETE FROM attachments_out WHERE path = ?').run(path);
  }

  /** Forgets everything written to staging (used by `sync --rebuild`). */
  clearOutputs(): void {
    this.#db.transaction(() => {
      this.#db.run('DELETE FROM notes_out');
      this.#db.run('DELETE FROM attachments_out');
    })();
  }

  close(): void {
    this.#db.close();
  }
}
