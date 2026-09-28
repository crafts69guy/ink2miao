import { readdir, readFile, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { nameKey, RESERVED_FOLDER_NAMES, stemToDisplayTitle } from '../naming/sanitize.ts';
import type { RenderedNote, RenderPlan } from '../plan/render.ts';
import type { Platform } from '../platform/types.ts';
import { readFrontMatterId } from '../transform/frontmatter.ts';
import { maskProtected, scanMarkdown } from '../transform/scan.ts';
import { md5Hex } from '../util/hash.ts';
import { decodeComponent } from '../util/percent.ts';

export const MAX_FOLDERS = 100;

export interface Issue {
  readonly level: 'error' | 'warn';
  readonly code: string;
  readonly path: string;
  readonly detail: string;
}

export interface VerifyOptions {
  /**
   * The MiaoYan library rather than staging: the user's own notes and edits made in MiaoYan
   * are expected (warnings), and dates/pins are checked too.
   */
  readonly library: boolean;
  readonly platform: Platform | null;
}

/** Issues that are normal in a live library and only warnings there. */
const LIBRARY_WARNINGS: ReadonlySet<string> = new Set([
  'unexpected_note',
  'stray_file',
  'hidden_folder',
  'content_mismatch',
]);

export interface VerifyReport {
  readonly errors: readonly Issue[];
  readonly warnings: readonly Issue[];
  readonly stats: { notes: number; attachments: number; folders: number };
}

interface Tree {
  readonly markdown: string[];
  readonly folders: string[];
  readonly others: string[];
}

const ATTACHMENT_DIRS: ReadonlySet<string> = new Set(['i', 'files']);
const WIKILINK = /\[\[([^[\]\n]+?)\]\]/g;
const GOTO = /miaoyan:\/\/goto\/([^\s)"'<>]+)/g;
const INKDROP = /inkdrop:\/\//g;

async function walk(root: string): Promise<Tree> {
  const tree: Tree = { markdown: [], folders: [], others: [] };
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const e of entries) {
    const rel = posix.join(
      ...join(e.parentPath, e.name)
        .slice(root.length + 1)
        .split('/'),
    );
    if (rel.split('/').some((seg) => seg.startsWith('.'))) continue;
    if (e.isDirectory()) {
      if (!rel.split('/').some((seg) => ATTACHMENT_DIRS.has(seg))) tree.folders.push(rel);
    } else if (e.name.endsWith('.md')) {
      tree.markdown.push(rel);
    } else {
      tree.others.push(rel);
    }
  }
  return tree;
}

function checkNames(tree: Tree, issues: Issue[]): void {
  for (const path of [...tree.markdown, ...tree.folders]) {
    if (path !== path.normalize('NFC')) {
      issues.push({ level: 'error', code: 'not_nfc', path, detail: 'path is not NFC-normalized' });
    }
  }
  for (const folder of tree.folders) {
    const leaf = folder.split('/').at(-1) ?? folder;
    if (RESERVED_FOLDER_NAMES.has(nameKey(leaf)) || /trash/i.test(leaf)) {
      issues.push({
        level: 'error',
        code: 'hidden_folder',
        path: folder,
        detail: 'MiaoYan hides this folder name',
      });
    }
  }
  if (tree.folders.length > MAX_FOLDERS) {
    issues.push({
      level: 'error',
      code: 'too_many_folders',
      path: '.',
      detail: `${tree.folders.length} folders; MiaoYan loads about ${MAX_FOLDERS}`,
    });
  }
  const md = new Set(tree.markdown);
  for (const other of tree.others) {
    const inAttachments = other.split('/').some((seg) => ATTACHMENT_DIRS.has(seg));
    if (!inAttachments && !md.has(other)) {
      issues.push({ level: 'warn', code: 'stray_file', path: other, detail: 'not a note' });
    }
  }
}

function attachmentTarget(url: string, noteDir: string): string | null {
  const clean = decodeComponent(url.split(/[?#]/)[0] ?? url);
  const rel = clean.startsWith('/i/')
    ? clean.slice(1)
    : clean.startsWith('./')
      ? clean.slice(2)
      : clean;
  if (!rel.startsWith('i/') && !rel.startsWith('files/')) return null;
  return noteDir === '.' ? rel : `${noteDir}/${rel}`;
}

interface NoteContext {
  readonly path: string;
  readonly text: string;
  readonly expected: RenderedNote | undefined;
  readonly titles: ReadonlySet<string>;
  readonly present: ReadonlySet<string>;
}

type Scan = ReturnType<typeof scanMarkdown>;

function checkAttachmentLinks(ctx: NoteContext, scan: Scan, issues: Issue[]): void {
  const noteDir = posix.dirname(ctx.path);
  for (const site of scan.sites) {
    const target = attachmentTarget(ctx.text.slice(site.url.start, site.url.end), noteDir);
    if (target !== null && !ctx.present.has(target)) {
      issues.push({ level: 'error', code: 'missing_attachment', path: ctx.path, detail: target });
    }
  }
}

function checkTitleLinks(ctx: NoteContext, masked: string, issues: Issue[]): void {
  for (const m of masked.matchAll(WIKILINK)) {
    const title = (m[1] ?? '').trim();
    if (!ctx.titles.has(nameKey(title))) {
      issues.push({ level: 'warn', code: 'dangling_wikilink', path: ctx.path, detail: title });
    }
  }
  for (const m of masked.matchAll(GOTO)) {
    const title = decodeComponent(m[1] ?? '');
    if (!ctx.titles.has(nameKey(title))) {
      issues.push({ level: 'error', code: 'dangling_goto', path: ctx.path, detail: title });
    }
  }
}

function checkLeftovers(ctx: NoteContext, masked: string, issues: Issue[]): void {
  const leftovers = [...masked.matchAll(INKDROP)].length;
  const known = ctx.expected?.unresolved.filter((u) => u.kind !== 'badFrontMatter').length ?? 0;
  if (leftovers > known) {
    const detail = `${leftovers} inkdrop:// URLs, ${known} known unresolved`;
    issues.push({ level: 'error', code: 'inkdrop_leftover', path: ctx.path, detail });
  }
}

function checkFrontMatter(ctx: NoteContext, scan: Scan, issues: Issue[]): void {
  if (!ctx.expected) return;
  if (ctx.expected.unresolved.some((u) => u.kind === 'badFrontMatter')) {
    const detail = 'original front matter is invalid YAML; left untouched';
    issues.push({ level: 'warn', code: 'bad_front_matter', path: ctx.path, detail });
    return;
  }
  const id = scan.yaml ? readFrontMatterId(ctx.text.slice(scan.yaml.start, scan.yaml.end)) : null;
  if (id !== ctx.expected.id) {
    const detail = `front matter id ${id ?? 'missing'} ≠ ${ctx.expected.id}`;
    issues.push({ level: 'error', code: 'front_matter_id', path: ctx.path, detail });
  }
}

function checkLinks(ctx: NoteContext, issues: Issue[]): void {
  const scan = scanMarkdown(ctx.text);
  const masked = maskProtected(ctx.text, scan.protectedRanges);
  checkAttachmentLinks(ctx, scan, issues);
  checkTitleLinks(ctx, masked, issues);
  checkLeftovers(ctx, masked, issues);
  checkFrontMatter(ctx, scan, issues);
}

async function checkMetadata(root: string, n: RenderedNote, platform: Platform, issues: Issue[]) {
  const st = await stat(join(root, n.path));
  if (st.birthtime.getTime() !== n.createdAt || st.mtime.getTime() !== n.updatedAt) {
    const detail = `birth ${st.birthtime.toISOString()}, modified ${st.mtime.toISOString()}`;
    issues.push({ level: 'warn', code: 'dates_differ', path: n.path, detail });
  }
  if (platform.isPinned(join(root, n.path)) !== n.pinned) {
    const detail = n.pinned ? 'should be pinned' : 'should not be pinned';
    issues.push({ level: 'warn', code: 'pin_differs', path: n.path, detail });
  }
}

async function checkNotes(
  root: string,
  tree: Tree,
  plan: RenderPlan,
  opts: VerifyOptions,
  issues: Issue[],
) {
  const expected = new Map(plan.notes.map((n) => [n.path, n]));
  const present = new Set([...tree.markdown, ...tree.others]);
  const titles = new Set(
    tree.markdown.map((p) => nameKey(stemToDisplayTitle(posix.basename(p, '.md')))),
  );
  for (const n of plan.notes) {
    if (!present.has(n.path)) {
      issues.push({ level: 'error', code: 'missing_note', path: n.path, detail: n.id });
    }
  }
  for (const path of tree.markdown) {
    const text = await readFile(join(root, path), 'utf8');
    const exp = expected.get(path);
    if (!exp) {
      issues.push({ level: 'error', code: 'unexpected_note', path, detail: 'not in the export' });
      // The user's own MiaoYan notes are not ours to lint.
      if (opts.library) continue;
    } else if (exp.content !== text) {
      issues.push({ level: 'error', code: 'content_mismatch', path, detail: exp.id });
    }
    if (exp && opts.library && opts.platform) await checkMetadata(root, exp, opts.platform, issues);
    checkLinks({ path, text, expected: exp, titles, present }, issues);
  }
}

async function checkAttachments(root: string, plan: RenderPlan, issues: Issue[]) {
  let count = 0;
  for (const a of plan.attachments) {
    for (const path of a.paths) {
      count++;
      const bytes = await readFile(join(root, path)).catch(() => null);
      if (bytes === null) {
        issues.push({ level: 'error', code: 'missing_attachment', path, detail: a.file.id });
      } else if (a.file.md5hex !== null && md5Hex(bytes) !== a.file.md5hex) {
        issues.push({ level: 'error', code: 'md5_mismatch', path, detail: a.file.id });
      }
    }
  }
  return count;
}

/** Checks a written library tree against the plan it was rendered from. */
export async function verifyTree(
  root: string,
  plan: RenderPlan,
  opts: VerifyOptions = { library: false, platform: null },
): Promise<VerifyReport> {
  const tree = await walk(root);
  const issues: Issue[] = [];
  checkNames(tree, issues);
  await checkNotes(root, tree, plan, opts, issues);
  const attachments = await checkAttachments(root, plan, issues);
  const leveled = issues.map((i) =>
    opts.library && LIBRARY_WARNINGS.has(i.code) ? { ...i, level: 'warn' as const } : i,
  );
  const unique = [...new Map(leveled.map((i) => [`${i.code}|${i.path}|${i.detail}`, i])).values()];
  return {
    errors: unique.filter((i) => i.level === 'error'),
    warnings: unique.filter((i) => i.level === 'warn'),
    stats: { notes: tree.markdown.length, attachments, folders: tree.folders.length },
  };
}
