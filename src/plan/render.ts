import { stripPrefix } from '../domain/ids.ts';
import type { BookId, FileId, FileMeta, Note, NoteId, Snapshot } from '../domain/model.ts';
import { isRetired } from '../domain/model.ts';
import { assignFolders, bookPath, type FolderOptions } from '../naming/folders.ts';
import { attachmentFileName, normalizeTitle, stemToDisplayTitle } from '../naming/sanitize.ts';
import { assignTitles, type PriorTitle, type TitleRename } from '../naming/titles.ts';
import type { FrontMatterMeta } from '../transform/frontmatter.ts';
import {
  type LinkMode,
  type ResolvedFile,
  transform,
  type Unresolved,
} from '../transform/index.ts';

export interface RenderOptions extends FolderOptions {
  readonly linkMode: LinkMode;
  readonly includeTrash: boolean;
}

export interface RenderedNote {
  readonly id: NoteId;
  /** MiaoYan display title (filename stem with `:` shown as `/`). */
  readonly title: string;
  /** Inkdrop title and the filename stem assigned to it (kept stable across runs). */
  readonly sourceTitle: string;
  readonly stem: string;
  /** Library-relative path, `/`-separated, NFC. */
  readonly path: string;
  readonly folder: string;
  readonly content: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly pinned: boolean;
  readonly retired: boolean;
  readonly noteRefs: readonly NoteId[];
  readonly fileRefs: readonly FileId[];
  readonly unresolved: readonly Unresolved[];
}

export interface AttachmentPlacement {
  readonly file: FileMeta;
  readonly name: string;
  /** Library-relative paths the binary must be written to (one per folder using it). */
  readonly paths: readonly string[];
}

export interface RenderPlan {
  readonly notes: readonly RenderedNote[];
  readonly attachments: readonly AttachmentPlacement[];
  readonly renames: readonly TitleRename[];
  readonly folderRenames: readonly { id: BookId; name: string; folder: string }[];
  readonly skipped: readonly { id: NoteId; reason: 'template' | 'trash' }[];
  /** Attachments no exported note references (not written). */
  readonly unreferencedFiles: number;
  /** Every folder the notes occupy, ancestors included (MiaoYan counts each as a project). */
  readonly folders: readonly string[];
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

export function extensionFor(file: FileMeta): string {
  const known = EXTENSIONS[file.contentType.toLowerCase()];
  if (known) return known;
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(file.name);
  return m?.[1] ? m[1].toLowerCase() : 'bin';
}

export function resolvedFile(file: FileMeta): ResolvedFile {
  return {
    name: attachmentFileName(file.name, stripPrefix(file.id), extensionFor(file)),
    image: file.contentType.toLowerCase().startsWith('image/'),
  };
}

function join(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function frontMatterFor(note: Note, snapshot: Snapshot, displayTitle: string): FrontMatterMeta {
  const tags = note.tagIds
    .map((t) => snapshot.tags.get(t)?.name)
    .filter((n): n is string => n !== undefined)
    .sort((a, b) => a.localeCompare(b));
  return {
    id: note.id,
    title: normalizeTitle(note.title) === displayTitle ? null : note.title,
    notebook: isRetired(note) ? null : bookPath(note.bookId as BookId, snapshot.books),
    tags,
    status: note.status,
    pinned: note.pinned,
    trashed: isRetired(note),
    created: iso(note.createdAt),
    updated: iso(note.updatedAt),
  };
}

function selectNotes(snapshot: Snapshot, opts: RenderOptions) {
  const included: Note[] = [];
  const skipped: { id: NoteId; reason: 'template' | 'trash' }[] = [];
  for (const note of snapshot.notes.values()) {
    if (note.bookId === 'template') skipped.push({ id: note.id, reason: 'template' });
    else if (isRetired(note) && !opts.includeTrash) skipped.push({ id: note.id, reason: 'trash' });
    else included.push(note);
  }
  included.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { included, skipped };
}

export function withAncestors(folders: Iterable<string>): string[] {
  const set = new Set<string>();
  for (const folder of folders) {
    const parts = folder ? folder.split('/') : [];
    for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('/'));
  }
  return [...set].sort();
}

/**
 * Pure: turns a snapshot into the complete set of files the library should contain.
 * Names are globally unique; links resolve only to notes that are part of the export.
 */
export function renderAll(
  snapshot: Snapshot,
  opts: RenderOptions,
  prior: ReadonlyMap<NoteId, PriorTitle> = new Map(),
): RenderPlan {
  const { included, skipped } = selectNotes(snapshot, opts);
  const folders = assignFolders(snapshot.books.values(), opts);
  const titles = assignTitles(
    included.map((n) => ({
      id: n.id,
      title: n.title,
      createdAt: n.createdAt,
      retired: isRetired(n),
    })),
    prior,
  );
  const display = new Map<NoteId, string>();
  for (const [id, stem] of titles.stems) display.set(id, stemToDisplayTitle(stem));

  const placements = new Map<FileId, Set<string>>();
  const notes: RenderedNote[] = [];
  for (const note of included) {
    const stem = titles.stems.get(note.id) as string;
    const title = display.get(note.id) as string;
    const retired = isRetired(note);
    const folder = retired ? opts.deletedFolder : (folders.paths.get(note.bookId as BookId) ?? '');
    const result = transform({
      body: note.body,
      linkMode: opts.linkMode,
      resolveNote: (id) => display.get(id) ?? null,
      resolveFile: (id) => {
        const f = snapshot.files.get(id);
        return f ? resolvedFile(f) : null;
      },
      frontMatter: frontMatterFor(note, snapshot, title),
    });
    for (const fileId of result.fileRefs) {
      const set = placements.get(fileId) ?? new Set<string>();
      set.add(folder);
      placements.set(fileId, set);
    }
    notes.push({
      id: note.id,
      title,
      sourceTitle: note.title,
      stem,
      path: join(folder, `${stem}.md`),
      folder,
      content: result.body,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      pinned: note.pinned,
      retired,
      noteRefs: result.noteRefs,
      fileRefs: result.fileRefs,
      unresolved: result.unresolved,
    });
  }

  const attachments: AttachmentPlacement[] = [];
  for (const [fileId, set] of [...placements].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const file = snapshot.files.get(fileId) as FileMeta;
    const r = resolvedFile(file);
    const dir = r.image ? 'i' : 'files';
    attachments.push({
      file,
      name: r.name,
      paths: [...set].sort().map((folder) => join(join(folder, dir), r.name)),
    });
  }

  return {
    notes,
    attachments,
    renames: titles.renames,
    folderRenames: folders.renamed,
    skipped,
    unreferencedFiles: snapshot.files.size - attachments.length,
    folders: withAncestors(notes.map((n) => n.folder)),
  };
}
