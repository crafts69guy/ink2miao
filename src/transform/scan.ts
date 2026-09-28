import type { Nodes, Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { mathFromMarkdown } from 'mdast-util-math';
import { toString as nodeText } from 'mdast-util-to-string';
import { parse, postprocess, preprocess } from 'micromark';
import { frontmatter } from 'micromark-extension-frontmatter';
import { gfm } from 'micromark-extension-gfm';
import { math } from 'micromark-extension-math';
import type { Event, Token } from 'micromark-util-types';

export interface Range {
  readonly start: number;
  readonly end: number;
}

/** A place in the document where a URL lives, with exact UTF-16 offsets into the source. */
export type UrlSite =
  | {
      readonly site: 'resource';
      readonly owner: 'link' | 'image';
      readonly node: Range;
      readonly url: Range;
      /** Raw label content between `[`/`![` and `]`. */
      readonly label: Range;
    }
  | { readonly site: 'definition' | 'autolink' | 'html'; readonly url: Range };

export interface MarkdownScan {
  readonly sites: readonly UrlSite[];
  /** Plain text of the link label / image alt of the node starting at `offset` (lazy mdast). */
  readonly textAt: (offset: number) => string;
  readonly yaml: Range | null;
  /** Code, math and front matter: regions no rewrite may touch. */
  readonly protectedRanges: readonly Range[];
}

const PROTECTED = new Set([
  'codeFenced',
  'codeIndented',
  'codeText',
  'mathFlow',
  'mathText',
  'yaml',
]);
const HTML_URL = /\b(?:src|href)\s*=\s*(["'])(.*?)\1/gi;

function tokenize(doc: string): Event[] {
  const extensions = [gfm(), frontmatter(['yaml']), math()];
  return postprocess(
    parse({ extensions })
      .document()
      .write(preprocess()(doc, undefined, true)),
  );
}

function parseTree(doc: string): Root {
  return fromMarkdown(doc, {
    extensions: [gfm(), frontmatter(['yaml']), math()],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(['yaml']), mathFromMarkdown()],
  });
}

function range(t: Token): Range {
  return { start: t.start.offset, end: t.end.offset };
}

/** start offset → label text of the link/image node starting there. */
function nodeTexts(tree: Root): Map<number, string> {
  const out = new Map<number, string>();
  const visit = (n: Nodes): void => {
    const start = n.position?.start.offset;
    if (start !== undefined && (n.type === 'link' || n.type === 'image')) {
      out.set(start, n.type === 'image' ? (n.alt ?? '') : nodeText(n));
    }
    if ('children' in n) for (const c of n.children) visit(c);
  };
  visit(tree);
  return out;
}

function htmlSites(doc: string, r: Range): UrlSite[] {
  const sites: UrlSite[] = [];
  const slice = doc.slice(r.start, r.end);
  for (const m of slice.matchAll(HTML_URL)) {
    const value = m[2] ?? '';
    const valueStart = r.start + m.index + m[0].length - 1 - value.length;
    sites.push({ site: 'html', url: { start: valueStart, end: valueStart + value.length } });
  }
  return sites;
}

interface OpenOwner {
  readonly token: Token;
  labelStart: number;
  labelEnd: number;
  url: Range | null;
}

interface ScanState {
  readonly doc: string;
  readonly sites: UrlSite[];
  readonly protectedRanges: Range[];
  readonly stack: OpenOwner[];
  yaml: Range | null;
}

function closeOwner(state: ScanState, token: Token): void {
  const top = state.stack.at(-1);
  if (top?.token !== token) return;
  state.stack.pop();
  if (!top.url || (token.type !== 'link' && token.type !== 'image')) return;
  const node = range(token);
  state.sites.push({
    site: 'resource',
    owner: token.type,
    node,
    url: top.url,
    label: { start: top.labelStart, end: top.labelEnd },
  });
}

type EnterHandler = (state: ScanState, token: Token) => void;

const openOwner: EnterHandler = (state, token) => {
  const at = token.start.offset;
  state.stack.push({ token, labelStart: at, labelEnd: at, url: null });
};

const ENTER: Readonly<Record<string, EnterHandler>> = {
  link: openOwner,
  image: openOwner,
  label: (state, token) => {
    // `[`…`]` or `![`…`]`: the label of the owner that starts at the same offset.
    const top = state.stack.at(-1);
    if (top && top.token.start.offset === token.start.offset) {
      top.labelStart = token.start.offset + (top.token.type === 'image' ? 2 : 1);
      top.labelEnd = token.end.offset - 1;
    }
  },
  resourceDestinationString: (state, token) => {
    const top = state.stack.at(-1);
    if (top) top.url = range(token);
  },
  definitionDestinationString: (state, token) => {
    state.sites.push({ site: 'definition', url: range(token) });
  },
  autolinkProtocol: (state, token) => {
    state.sites.push({ site: 'autolink', url: range(token) });
  },
  htmlFlow: (state, token) => {
    state.sites.push(...htmlSites(state.doc, range(token)));
  },
  htmlText: (state, token) => {
    state.sites.push(...htmlSites(state.doc, range(token)));
  },
};

function enter(state: ScanState, token: Token): void {
  const type: string = token.type;
  const handler = ENTER[type];
  if (handler) {
    handler(state, token);
  } else if (PROTECTED.has(type)) {
    state.protectedRanges.push(range(token));
    if (type === 'yaml') state.yaml = range(token);
  }
}

/** Walks micromark events once and reports every URL site plus protected regions. */
export function scanMarkdown(doc: string): MarkdownScan {
  const state: ScanState = {
    doc,
    sites: [],
    protectedRanges: [],
    stack: [],
    yaml: null,
  };
  for (const [kind, token] of tokenize(doc)) {
    if (kind === 'enter') enter(state, token);
    else closeOwner(state, token);
  }
  state.sites.sort((a, b) => a.url.start - b.url.start);
  let texts: Map<number, string> | null = null;
  const textAt = (offset: number): string => {
    texts ??= nodeTexts(parseTree(doc));
    return texts.get(offset) ?? '';
  };
  return { sites: state.sites, textAt, yaml: state.yaml, protectedRanges: state.protectedRanges };
}

/** Replaces protected regions with spaces (same length) so regex scans skip code and math. */
export function maskProtected(doc: string, ranges: readonly Range[]): string {
  let out = doc;
  for (const r of ranges) {
    out = out.slice(0, r.start) + ' '.repeat(r.end - r.start) + out.slice(r.end);
  }
  return out;
}
