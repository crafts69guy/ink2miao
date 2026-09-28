import type { NoteId } from '../domain/model.ts';
import {
  MAX_STEM_BYTES,
  nameKey,
  normalizeTitle,
  stemToDisplayTitle,
  titleToStem,
  withSuffix,
} from './sanitize.ts';

export interface TitleCandidate {
  readonly id: NoteId;
  readonly title: string;
  readonly createdAt: number;
  readonly retired: boolean;
}

/** What a previous run assigned; lets names stay stable across runs. */
export interface PriorTitle {
  readonly sourceTitle: string;
  readonly stem: string;
}

export interface TitleRename {
  readonly id: NoteId;
  readonly from: string | null;
  readonly to: string;
  /** collision: got a ` (n)` suffix; sanitized: the visible title differs; changed: new title. */
  readonly reason: 'collision' | 'sanitized' | 'changed';
}

export interface TitleAssignment {
  readonly stems: ReadonlyMap<NoteId, string>;
  readonly renames: readonly TitleRename[];
}

function byPriority(a: TitleCandidate, b: TitleCandidate): number {
  if (a.retired !== b.retired) return a.retired ? 1 : -1;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Assigns every note a globally unique filename stem (MiaoYan wikilinks resolve by title,
 * so uniqueness must hold across folders, not just within one).
 *
 * Incumbents whose source title is unchanged keep their previous stem; everyone else claims a
 * name in priority order (live before retired, older before newer, then id).
 */
function claimStem(c: TitleCandidate, taken: Set<string>): { stem: string; base: string } {
  const base = titleToStem(c.title);
  let stem = base;
  for (let n = 2; taken.has(nameKey(stem)); n++) stem = withSuffix(base, n, MAX_STEM_BYTES);
  taken.add(nameKey(stem));
  return { stem, base };
}

function renameFor(
  c: TitleCandidate,
  previous: string | null,
  stem: string,
  base: string,
): TitleRename | null {
  if (previous === stem) return null;
  const visible = stemToDisplayTitle(base) !== normalizeTitle(c.title);
  const reason = stem !== base ? 'collision' : visible ? 'sanitized' : 'changed';
  if (previous === null && reason === 'changed') return null;
  return { id: c.id, from: previous, to: stem, reason };
}

/**
 * Assigns every note a globally unique filename stem (MiaoYan wikilinks resolve by title,
 * so uniqueness must hold across folders, not just within one).
 *
 * Incumbents whose source title is unchanged keep their previous stem; everyone else claims a
 * name in priority order (live before retired, older before newer, then id).
 */
export function assignTitles(
  candidates: readonly TitleCandidate[],
  prior: ReadonlyMap<NoteId, PriorTitle> = new Map(),
): TitleAssignment {
  const taken = new Set<string>();
  const stems = new Map<NoteId, string>();
  const renames: TitleRename[] = [];
  const claimants: TitleCandidate[] = [];

  for (const c of [...candidates].sort(byPriority)) {
    const p = prior.get(c.id);
    if (p && p.sourceTitle === c.title && !taken.has(nameKey(p.stem))) {
      taken.add(nameKey(p.stem));
      stems.set(c.id, p.stem);
    } else {
      claimants.push(c);
    }
  }

  for (const c of claimants) {
    const { stem, base } = claimStem(c, taken);
    stems.set(c.id, stem);
    const rename = renameFor(c, prior.get(c.id)?.stem ?? null, stem, base);
    if (rename) renames.push(rename);
  }
  return { stems, renames };
}
