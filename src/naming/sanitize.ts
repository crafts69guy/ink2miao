/**
 * Filename rules derived from MiaoYan's source:
 * - the note title is the filename without `.md`;
 * - a `:` in a filename is displayed as `/` (so `/` in a title round-trips through `:`);
 * - hidden entries (leading `.`) are ignored.
 */

/** U+A789 MODIFIER LETTER COLON: keeps a literal colon visible without meaning `/`. */
export const COLON_SUBSTITUTE = '꞉';
export const MAX_STEM_BYTES = 240;
export const MAX_FOLDER_BYTES = 200;

const encoder = new TextEncoder();
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]+/g;

export function byteLength(s: string): number {
  return encoder.encode(s).length;
}

/** Truncates on grapheme boundaries so Vietnamese diacritics and emoji are never split. */
export function capBytes(s: string, maxBytes: number): string {
  if (byteLength(s) <= maxBytes) return s;
  let out = '';
  let used = 0;
  for (const { segment } of segmenter.segment(s)) {
    const n = byteLength(segment);
    if (used + n > maxBytes) break;
    out += segment;
    used += n;
  }
  return out.trimEnd();
}

/** NFC, control characters and runs of whitespace collapsed to one space, trimmed. */
export function normalizeTitle(s: string): string {
  return s.normalize('NFC').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
}

const clean = normalizeTitle;

/** Title → filename stem (without extension). */
export function titleToStem(title: string, maxBytes = MAX_STEM_BYTES): string {
  const s = clean(title)
    .replaceAll(':', COLON_SUBSTITUTE)
    .replaceAll('/', ':')
    .replace(/^\.+/, '')
    .trim();
  const capped = capBytes(s, maxBytes);
  return capped.length > 0 ? capped : 'Untitled';
}

/** How MiaoYan displays a filename stem as a note title. */
export function stemToDisplayTitle(stem: string): string {
  return stem.replaceAll(':', '/');
}

/** Case- and normalization-insensitive identity (APFS is case-insensitive by default). */
export function nameKey(s: string): string {
  return s.normalize('NFC').toLowerCase();
}

/** Appends ` (n)` while keeping the result within the byte budget. */
export function withSuffix(base: string, n: number, maxBytes: number): string {
  const suffix = ` (${n})`;
  return `${capBytes(base, maxBytes - byteLength(suffix))}${suffix}`;
}

export interface FolderNameOptions {
  readonly trashReplacement: string;
}

/** Folder names MiaoYan treats as attachment/system folders and hides from the sidebar. */
export const RESERVED_FOLDER_NAMES: ReadonlySet<string> = new Set([
  'i',
  'files',
  'assets',
  '.cache',
]);

/** Book name → folder name that MiaoYan will actually show. */
export function bookToFolderName(name: string, opts: FolderNameOptions): string {
  let s = clean(name)
    .replaceAll('/', '-')
    .replaceAll(':', COLON_SUBSTITUTE)
    .replace(/trash/gi, opts.trashReplacement)
    .replace(/^\.+/, '')
    .trim();
  s = capBytes(s, MAX_FOLDER_BYTES);
  if (s.length === 0) return 'Untitled Notebook';
  return RESERVED_FOLDER_NAMES.has(nameKey(s)) ? `${s} (notebook)` : s;
}

const UNSAFE_FILE_CHARS = /[^\p{L}\p{N}._-]+/gu;

/** Attachment name → safe, deterministic `<stem>-<shortId>.<ext>`. */
export function attachmentFileName(name: string, shortId: string, ext: string): string {
  const dot = name.lastIndexOf('.');
  const rawStem = dot > 0 ? name.slice(0, dot) : name;
  const stem = capBytes(
    clean(rawStem)
      .replace(UNSAFE_FILE_CHARS, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|-+$/g, ''),
    80,
  );
  return `${stem.length > 0 ? stem : 'file'}-${shortId}.${ext}`;
}
