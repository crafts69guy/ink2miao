import { Document, isMap, isNode, isScalar, parseDocument } from 'yaml';
import type { NoteStatus } from '../domain/model.ts';
import type { Range } from './scan.ts';

/** Metadata ink2miao owns, written under a single `inkdrop:` key. */
export interface FrontMatterMeta {
  readonly id: string;
  /** Original Inkdrop title, only when it differs from the MiaoYan (filename) title. */
  readonly title: string | null;
  readonly notebook: string | null;
  readonly tags: readonly string[];
  readonly status: NoteStatus;
  readonly pinned: boolean;
  readonly trashed: boolean;
  readonly created: string;
  readonly updated: string;
}

export const FRONT_MATTER_KEY = 'inkdrop';
const STRINGIFY = { lineWidth: 0 } as const;

function metaObject(meta: FrontMatterMeta): Record<string, unknown> {
  const out: Record<string, unknown> = { id: meta.id };
  if (meta.title !== null) out['title'] = meta.title;
  if (meta.notebook !== null) out['notebook'] = meta.notebook;
  out['tags'] = [...meta.tags];
  out['status'] = meta.status;
  out['pinned'] = meta.pinned;
  if (meta.trashed) out['trashed'] = true;
  out['created'] = meta.created;
  out['updated'] = meta.updated;
  return out;
}

export interface FrontMatterResult {
  readonly body: string;
  /** Existing front matter was unparseable (or not a block mapping) and was left untouched. */
  readonly bad: boolean;
}

function innerYaml(block: string): string {
  const firstBreak = block.indexOf('\n');
  const lastBreak = block.lastIndexOf('\n');
  return firstBreak === lastBreak ? '' : block.slice(firstBreak + 1, lastBreak + 1);
}

/**
 * Removes a top-level `inkdrop:` entry by source range so every other byte of the user's YAML
 * (quoting, flow style, comments, key order) survives exactly. Returns null when the YAML is
 * not something we can safely edit.
 */
function withoutOwnKey(inner: string): string | null {
  const doc = parseDocument(inner);
  if (doc.errors.length > 0) return null;
  if (doc.contents === null) return inner;
  if (!isMap(doc.contents) || doc.contents.flow) return null;
  for (const pair of doc.contents.items) {
    if (!isScalar(pair.key) || pair.key.value !== FRONT_MATTER_KEY) continue;
    const start = pair.key.range?.[0] ?? 0;
    const valueEnd = isNode(pair.value) ? pair.value.range?.[2] : undefined;
    let end = valueEnd ?? pair.key.range?.[2] ?? start;
    if (inner[end] === '\n') end++;
    return inner.slice(0, start) + inner.slice(end);
  }
  return inner;
}

/**
 * Sets `inkdrop:` in the note's YAML front matter without re-serializing anything else:
 * an existing `inkdrop:` entry is cut out and a fresh block is appended. Adds a front matter
 * block when the note has none.
 */
export function applyFrontMatter(
  body: string,
  yaml: Range | null,
  meta: FrontMatterMeta,
): FrontMatterResult {
  const block = new Document({ [FRONT_MATTER_KEY]: metaObject(meta) }).toString(STRINGIFY);
  if (yaml === null) {
    const sep = body.length === 0 || body.startsWith('\n') ? '' : '\n';
    return { body: `---\n${block}---\n${sep}${body}`, bad: false };
  }
  const kept = withoutOwnKey(innerYaml(body.slice(yaml.start, yaml.end)));
  if (kept === null) return { body, bad: true };
  const prefix = kept.length === 0 || kept.endsWith('\n') ? kept : `${kept}\n`;
  const fm = `---\n${prefix}${block}---`;
  return { body: body.slice(0, yaml.start) + fm + body.slice(yaml.end), bad: false };
}

/** Reads `inkdrop.id` back from a written note (used by verify). */
export function readFrontMatterId(yamlBlock: string): string | null {
  const doc = parseDocument(innerYaml(yamlBlock));
  if (doc.errors.length > 0) return null;
  const id = doc.getIn([FRONT_MATTER_KEY, 'id']);
  return typeof id === 'string' ? id : null;
}
