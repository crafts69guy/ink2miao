import { nameKey } from '../../naming/sanitize.ts';
import type { RenderedNote } from '../../plan/render.ts';
import { CliError, ExitCode } from '../../util/errors.ts';
import type { Session } from '../context.ts';

/** Exact id, path or title matches win; otherwise a case-insensitive substring search. */
export function findNotes(notes: readonly RenderedNote[], query: string): RenderedNote[] {
  const q = query.trim();
  const key = nameKey(q);
  const exact = notes.filter(
    (n) =>
      n.id === q ||
      n.id === `note:${q}` ||
      n.path === q ||
      nameKey(n.title) === key ||
      nameKey(n.sourceTitle) === key,
  );
  if (exact.length > 0) return exact;
  return notes.filter((n) => nameKey(n.title).includes(key) || nameKey(n.path).includes(key));
}

/** Resolves a query to one note, asking interactively when it is ambiguous on a TTY. */
export async function resolveNote(
  s: Session,
  notes: readonly RenderedNote[],
  query: string,
): Promise<RenderedNote> {
  const matches = findNotes(notes, query);
  if (matches.length === 1) return matches[0] as RenderedNote;
  if (matches.length === 0) {
    throw new CliError(`no note matches "${query}"`, ExitCode.Usage, 'try `ink2miao pick`');
  }
  if (s.deps.stdinTTY && !s.printer.opts.json) {
    const picked = await s.deps.prompter.choose(
      `${matches.length} notes match "${query}"`,
      matches.map((n) => ({ value: n.id, label: n.title, hint: n.path })),
      false,
    );
    const note = matches.find((n) => n.id === picked?.[0]);
    if (note) return note;
    throw new CliError('cancelled', ExitCode.Usage);
  }
  const list = matches
    .slice(0, 10)
    .map((n) => `${n.id}  ${n.path}`)
    .join('\n  ');
  throw new CliError(`"${query}" is ambiguous (${matches.length} notes)`, ExitCode.Usage, list);
}
