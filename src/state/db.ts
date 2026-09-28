import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
];

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

  close(): void {
    this.#db.close();
  }
}
