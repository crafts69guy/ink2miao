import { BookDocSchema, FileDocSchema, NoteDocSchema, TagDocSchema } from '../source/schemas.ts';
import type { DocType } from '../source/types.ts';
import { couchDigestToHex } from '../util/hash.ts';
import type {
  Book,
  BookId,
  FileId,
  FileMeta,
  Note,
  NoteId,
  NoteLocation,
  Snapshot,
  Tag,
  TagId,
} from './model.ts';

export interface StoredDoc {
  readonly id: string;
  readonly type: DocType;
  readonly doc: unknown;
}

export interface SnapshotBuild {
  readonly snapshot: Snapshot;
  /** Ids whose JSON did not match the expected schema (skipped). */
  readonly invalid: readonly string[];
}

function location(bookId: string): NoteLocation {
  if (bookId === 'trash' || bookId === 'template') return bookId;
  return (bookId.startsWith('book:') ? bookId : `book:${bookId}`) as BookId;
}

function toNote(raw: unknown): Note | null {
  const r = NoteDocSchema.safeParse(raw);
  if (!r.success) return null;
  const d = r.data;
  return {
    id: d._id as NoteId,
    rev: d._rev,
    title: d.title,
    body: d.body,
    bookId: location(d.bookId),
    tagIds: d.tags.filter((t) => t.startsWith('tag:')) as TagId[],
    status: d.status,
    pinned: d.pinned,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

function toBook(raw: unknown): Book | null {
  const r = BookDocSchema.safeParse(raw);
  if (!r.success) return null;
  const parent = r.data.parentBookId;
  return {
    id: r.data._id as BookId,
    name: r.data.name,
    parentId: parent ? (parent as BookId) : null,
    createdAt: r.data.createdAt,
  };
}

function toTag(raw: unknown): Tag | null {
  const r = TagDocSchema.safeParse(raw);
  return r.success ? { id: r.data._id as TagId, name: r.data.name } : null;
}

function toFile(raw: unknown): FileMeta | null {
  const r = FileDocSchema.safeParse(raw);
  if (!r.success) return null;
  const d = r.data;
  const digest = d._attachments?.['index']?.digest;
  const md5 = d.md5digest?.toLowerCase() ?? (digest ? couchDigestToHex(digest) : null);
  return {
    id: d._id as FileId,
    rev: d._rev,
    name: d.name,
    contentType: d.contentType,
    contentLength: d.contentLength,
    md5hex: md5,
    createdAt: d.createdAt,
  };
}

interface Collections {
  readonly notes: Map<NoteId, Note>;
  readonly books: Map<BookId, Book>;
  readonly tags: Map<TagId, Tag>;
  readonly files: Map<FileId, FileMeta>;
}

const ADD: Readonly<Record<DocType, (c: Collections, raw: unknown) => boolean>> = {
  note: (c, raw) => {
    const n = toNote(raw);
    if (n) c.notes.set(n.id, n);
    return n !== null;
  },
  book: (c, raw) => {
    const b = toBook(raw);
    if (b) c.books.set(b.id, b);
    return b !== null;
  },
  tag: (c, raw) => {
    const t = toTag(raw);
    if (t) c.tags.set(t.id, t);
    return t !== null;
  },
  file: (c, raw) => {
    const f = toFile(raw);
    if (f) c.files.set(f.id, f);
    return f !== null;
  },
};

/** Validates stored raw docs into a typed snapshot; malformed docs are skipped and reported. */
export function buildSnapshot(docs: Iterable<StoredDoc>): SnapshotBuild {
  const c: Collections = { notes: new Map(), books: new Map(), tags: new Map(), files: new Map() };
  const invalid: string[] = [];
  for (const { id, type, doc } of docs) {
    if (!ADD[type](c, doc)) invalid.push(id);
  }
  return { snapshot: c, invalid };
}
