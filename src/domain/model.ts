export type NoteId = `note:${string}`;
export type BookId = `book:${string}`;
export type TagId = `tag:${string}`;
export type FileId = `file:${string}`;

export const NOTE_STATUSES = ['none', 'active', 'onHold', 'completed', 'dropped'] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

/** Inkdrop puts trashed notes in the pseudo-book `trash`; templates live in `template`. */
export type NoteLocation = BookId | 'trash' | 'template';

export interface Note {
  readonly id: NoteId;
  readonly rev: string;
  readonly title: string;
  readonly body: string;
  readonly bookId: NoteLocation;
  readonly tagIds: readonly TagId[];
  readonly status: NoteStatus;
  readonly pinned: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface Book {
  readonly id: BookId;
  readonly name: string;
  readonly parentId: BookId | null;
  readonly createdAt: number;
}

export interface Tag {
  readonly id: TagId;
  readonly name: string;
}

export interface FileMeta {
  readonly id: FileId;
  readonly rev: string;
  readonly name: string;
  readonly contentType: string;
  readonly contentLength: number;
  /** Lowercase hex md5 of the binary, when Inkdrop recorded one. */
  readonly md5hex: string | null;
  readonly createdAt: number;
}

export interface Snapshot {
  readonly notes: ReadonlyMap<NoteId, Note>;
  readonly books: ReadonlyMap<BookId, Book>;
  readonly tags: ReadonlyMap<TagId, Tag>;
  readonly files: ReadonlyMap<FileId, FileMeta>;
}

export function isRetired(note: Note): boolean {
  return note.bookId === 'trash';
}

export function emptySnapshot(): Snapshot {
  return { notes: new Map(), books: new Map(), tags: new Map(), files: new Map() };
}
