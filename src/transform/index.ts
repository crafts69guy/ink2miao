import { isInkdropUrl, parseFileUrl, parseNoteUrl } from '../domain/ids.ts';
import type { FileId, NoteId } from '../domain/model.ts';
import { encodeComponent } from '../util/percent.ts';
import { applyFrontMatter, type FrontMatterMeta } from './frontmatter.ts';
import {
  type MarkdownScan,
  maskProtected,
  type Range,
  scanMarkdown,
  type UrlSite,
} from './scan.ts';

export type LinkMode = 'auto' | 'wikilink' | 'goto';

export interface ResolvedFile {
  /** File name inside the attachment folder, e.g. `clipboard-7RuviIs.png`. */
  readonly name: string;
  readonly image: boolean;
}

export interface TransformInput {
  readonly body: string;
  readonly linkMode: LinkMode;
  /** Target note's MiaoYan display title, or null when the note does not exist. */
  readonly resolveNote: (id: NoteId) => string | null;
  readonly resolveFile: (id: FileId) => ResolvedFile | null;
  readonly frontMatter: FrontMatterMeta;
}

export type UnresolvedKind = 'note' | 'file' | 'scheme' | 'bare' | 'badFrontMatter';

export interface Unresolved {
  readonly kind: UnresolvedKind;
  readonly raw: string;
}

export interface Edit extends Range {
  readonly text: string;
}

export interface TransformResult {
  readonly body: string;
  readonly noteRefs: readonly NoteId[];
  readonly fileRefs: readonly FileId[];
  readonly unresolved: readonly Unresolved[];
  readonly edits: number;
}

/** Bump whenever output for identical input changes; forces a full re-render. */
export const TRANSFORM_VERSION = 1;

const WIKILINK_UNSAFE = /[[\]|#]/;
const SIZE_TOKEN = /\s*\b(?:w|h|width|height)\s*[:=]\s*\d+(?:\.\d+)?(?:px|%)?/gi;
const BARE_URL = /inkdrop:\/\/[^\s)"'<>\]]*/g;

export function gotoUrl(title: string): string {
  return `miaoyan://goto/${encodeComponent(title)}`;
}

export function attachmentHref(file: ResolvedFile, html: boolean): string {
  const dir = file.image ? 'i' : 'files';
  // MiaoYan writes `/i/<name>` (resolved against the note's folder); raw HTML gets a relative path.
  return `${html || !file.image ? '' : '/'}${dir}/${encodeComponent(file.name)}`;
}

function sameText(a: string, b: string): boolean {
  return a.normalize('NFC').trim() === b.normalize('NFC').trim();
}

function wantsWikilink(
  site: UrlSite,
  scan: MarkdownScan,
  mode: LinkMode,
  title: string,
  fragment: string | null,
): boolean {
  if (site.site !== 'resource' || site.owner !== 'link') return false;
  if (mode === 'goto' || fragment !== null || WIKILINK_UNSAFE.test(title)) return false;
  return mode === 'wikilink' || sameText(scan.textAt(site.node.start), title);
}

interface Collector {
  readonly scan: MarkdownScan;
  readonly edits: Edit[];
  readonly noteRefs: Set<NoteId>;
  readonly fileRefs: Set<FileId>;
  readonly unresolved: Unresolved[];
}

function rewriteNote(site: UrlSite, raw: string, input: TransformInput, out: Collector): boolean {
  const ref = parseNoteUrl(raw);
  if (!ref) return false;
  const title = input.resolveNote(ref.id);
  if (title === null) {
    out.unresolved.push({ kind: 'note', raw });
    return true;
  }
  out.noteRefs.add(ref.id);
  if (
    site.site === 'resource' &&
    wantsWikilink(site, out.scan, input.linkMode, title, ref.fragment)
  ) {
    out.edits.push({ ...site.node, text: `[[${title}]]` });
  } else {
    out.edits.push({ ...site.url, text: gotoUrl(title) });
  }
  return true;
}

function rewriteFile(
  site: UrlSite,
  raw: string,
  doc: string,
  input: TransformInput,
  out: Collector,
): boolean {
  const id = parseFileUrl(raw);
  if (!id) return false;
  const file = input.resolveFile(id);
  if (!file) {
    out.unresolved.push({ kind: 'file', raw });
    return true;
  }
  out.fileRefs.add(id);
  out.edits.push({ ...site.url, text: attachmentHref(file, site.site === 'html') });
  if (site.site === 'resource' && site.owner === 'image') {
    const alt = doc.slice(site.label.start, site.label.end);
    const cleaned = alt.replace(SIZE_TOKEN, '').trim();
    if (cleaned !== alt && !/[[\]]/.test(alt)) out.edits.push({ ...site.label, text: cleaned });
  }
  return true;
}

export function applyEdits(doc: string, edits: readonly Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = doc;
  let floor = Number.POSITIVE_INFINITY;
  for (const e of sorted) {
    if (e.end > floor) throw new Error(`overlapping edits at ${e.start}-${e.end}`);
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    floor = e.start;
  }
  return out;
}

function bareUrls(doc: string, protectedRanges: readonly Range[], sites: readonly UrlSite[]) {
  const masked = maskProtected(doc, protectedRanges);
  const found: Unresolved[] = [];
  for (const m of masked.matchAll(BARE_URL)) {
    const inSite = sites.some((s) => m.index >= s.url.start && m.index < s.url.end);
    if (!inSite) found.push({ kind: 'bare', raw: m[0] });
  }
  return found;
}

/** Normalizes line endings; MiaoYan writes LF and front matter parsing assumes it. */
export function normalizeEol(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

/**
 * Pure rewrite of one note body: only URL bytes (and whole nodes for wikilinks) change;
 * code, math and everything else stays byte-identical.
 */
export function transform(input: TransformInput): TransformResult {
  const doc = normalizeEol(input.body);
  const scan = scanMarkdown(doc);
  const out: Collector = {
    scan,
    edits: [],
    noteRefs: new Set(),
    fileRefs: new Set(),
    unresolved: [],
  };

  for (const site of scan.sites) {
    const raw = doc.slice(site.url.start, site.url.end);
    if (!isInkdropUrl(raw)) continue;
    if (rewriteNote(site, raw, input, out) || rewriteFile(site, raw, doc, input, out)) continue;
    out.unresolved.push({ kind: 'scheme', raw });
  }
  out.unresolved.push(...bareUrls(doc, scan.protectedRanges, scan.sites));

  const rewritten = applyEdits(doc, out.edits);
  const fm = applyFrontMatter(rewritten, scan.yaml, input.frontMatter);
  if (fm.bad) out.unresolved.push({ kind: 'badFrontMatter', raw: '' });

  return {
    body: fm.body,
    noteRefs: [...out.noteRefs],
    fileRefs: [...out.fileRefs],
    unresolved: out.unresolved,
    edits: out.edits.length,
  };
}
