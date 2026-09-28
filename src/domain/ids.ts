import type { FileId, NoteId } from './model.ts';

export interface NoteRef {
  readonly id: NoteId;
  readonly fragment: string | null;
}

const NOTE_URL = /^inkdrop:\/\/note[/:]([A-Za-z0-9_-]+)(?:[?#](.*))?$/;
const FILE_URL = /^inkdrop:\/\/file[/:]([A-Za-z0-9_-]+)(?:[?#].*)?$/;

/** Parses both `inkdrop://note/<id>` (v5+/v6) and the legacy `inkdrop://note:<id>` form. */
export function parseNoteUrl(url: string): NoteRef | null {
  const m = NOTE_URL.exec(url.trim());
  if (!m?.[1]) return null;
  const fragment = m[2] && m[2].length > 0 ? m[2] : null;
  return { id: `note:${m[1]}`, fragment };
}

export function parseFileUrl(url: string): FileId | null {
  const m = FILE_URL.exec(url.trim());
  return m?.[1] ? `file:${m[1]}` : null;
}

export function isInkdropUrl(url: string): boolean {
  return url.trim().startsWith('inkdrop://');
}

export function stripPrefix(id: string): string {
  const i = id.indexOf(':');
  return i === -1 ? id : id.slice(i + 1);
}
