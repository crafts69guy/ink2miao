import type { Book, BookId } from '../domain/model.ts';
import { bookToFolderName, type FolderNameOptions, nameKey, withSuffix } from './sanitize.ts';

export interface FolderOptions extends FolderNameOptions {
  /** Top-level folder that receives trashed/deleted notes; reserved at the root. */
  readonly deletedFolder: string;
}

export interface FolderAssignment {
  /** Book id → folder path relative to the library root, `/`-separated. */
  readonly paths: ReadonlyMap<BookId, string>;
  readonly renamed: readonly { id: BookId; name: string; folder: string }[];
}

function compareBooks(a: Book, b: Book): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Maps the Inkdrop notebook tree onto folders. Sibling name clashes (after sanitizing and
 * case-folding) get ` (2)`, ` (3)`… in creation order; orphans and cycles attach to the root.
 */
export function assignFolders(books: Iterable<Book>, opts: FolderOptions): FolderAssignment {
  const all = [...books].sort(compareBooks);
  const byId = new Map(all.map((b) => [b.id, b]));
  const children = new Map<BookId | null, Book[]>();

  const effectiveParent = (b: Book): BookId | null => {
    const seen = new Set<BookId>([b.id]);
    let p = b.parentId;
    while (p !== null) {
      const parent = byId.get(p);
      if (!parent || seen.has(p)) return null;
      seen.add(p);
      p = parent.parentId;
    }
    return b.parentId;
  };

  for (const b of all) {
    const parent = effectiveParent(b);
    const list = children.get(parent) ?? [];
    list.push(b);
    children.set(parent, list);
  }

  const paths = new Map<BookId, string>();
  const renamed: { id: BookId; name: string; folder: string }[] = [];

  const walk = (parent: BookId | null, prefix: string): void => {
    const taken = new Set<string>(parent === null ? [nameKey(opts.deletedFolder)] : []);
    for (const b of children.get(parent) ?? []) {
      const base = bookToFolderName(b.name, opts);
      let name = base;
      for (let n = 2; taken.has(nameKey(name)); n++) name = withSuffix(base, n, 200);
      taken.add(nameKey(name));
      const path = prefix ? `${prefix}/${name}` : name;
      paths.set(b.id, path);
      if (name !== b.name) renamed.push({ id: b.id, name: b.name, folder: path });
      walk(b.id, path);
    }
  };
  walk(null, '');
  return { paths, renamed };
}

/** Human-readable notebook path (original names) for front matter. */
export function bookPath(bookId: BookId, books: ReadonlyMap<BookId, Book>): string | null {
  const names: string[] = [];
  const seen = new Set<BookId>();
  let cur: BookId | null = bookId;
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const b = books.get(cur);
    if (!b) break;
    names.unshift(b.name);
    cur = b.parentId;
  }
  return names.length > 0 ? names.join('/') : null;
}
