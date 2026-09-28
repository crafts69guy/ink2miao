import { readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { buildSnapshot } from '../../domain/snapshot.ts';
import type { RenderedNote, RenderPlan } from '../../plan/render.ts';
import { fileLink } from '../../report/printer.ts';
import { gotoUrl, normalizeEol } from '../../transform/index.ts';
import { CliError, type ExitCode as Code, ExitCode } from '../../util/errors.ts';
import type { Session } from '../context.ts';
import { shellQuote } from '../io/exec.ts';
import { resolveNote } from './lookup.ts';
import { computePlan } from './planning.ts';

function loadRender(s: Session): RenderPlan {
  const { render, hasData } = computePlan(s, { fresh: false, force: false });
  if (!hasData) {
    throw new CliError(
      'no Inkdrop data in the local state',
      ExitCode.Usage,
      'run `ink2miao sync` first',
    );
  }
  return render;
}

/** Staging-relative paths of the attachments a note uses, inside its own folder. */
function attachmentsOf(render: RenderPlan, note: RenderedNote): string[] {
  const refs = new Set<string>(note.fileRefs);
  const folder = note.folder || '.';
  return render.attachments
    .filter((a) => refs.has(a.file.id))
    .flatMap((a) => a.paths.filter((p) => posix.dirname(posix.dirname(p)) === folder));
}

const readOr = (path: string) => readFile(path, 'utf8').catch(() => null);

function sourceBody(s: Session, note: RenderedNote): string {
  const { snapshot } = buildSnapshot(s.db().liveDocs());
  return normalizeEol(snapshot.notes.get(note.id)?.body ?? '');
}

export interface ShowFlags {
  readonly plain?: boolean | undefined;
  readonly source?: boolean | undefined;
}

/** Prints a note: through glow on a terminal, raw otherwise; images via chafa or links. */
export async function showCommand(s: Session, query: string, flags: ShowFlags): Promise<Code> {
  const render = loadRender(s);
  const note = await resolveNote(s, render.notes, query);
  const content = flags.source ? sourceBody(s, note) : note.content;
  const { deps } = s;
  const rich = !flags.plain && deps.stdoutTTY;
  if (rich && deps.which('glow')) {
    await deps.exec(['glow', '-p', '-'], { input: content });
  } else {
    deps.stdout.write(content.endsWith('\n') ? content : `${content}\n`);
  }
  if (flags.plain) return ExitCode.Ok;
  const chafa = rich ? deps.which('chafa') : null;
  for (const rel of attachmentsOf(render, note)) {
    const abs = join(s.loaded.config.staging, rel);
    if (chafa) await deps.exec([chafa, '--size=60x20', abs]);
    else s.printer.line(`attachment: ${fileLink(abs, rel, deps.stdoutTTY)}`);
  }
  return ExitCode.Ok;
}

export interface DiffFlags {
  readonly library?: boolean | undefined;
  readonly source?: boolean | undefined;
}

/**
 * Default: what the next sync would write vs. staging. `--library`: staging vs. MiaoYan.
 * `--source`: the original Inkdrop body vs. the rewritten one.
 */
export async function diffCommand(s: Session, query: string, flags: DiffFlags): Promise<Code> {
  const note = await resolveNote(s, loadRender(s).notes, query);
  const staged = join(s.loaded.config.staging, note.path);
  let pair: [string, string, string, string];
  if (flags.source) {
    pair = [`inkdrop/${note.id}`, sourceBody(s, note), `rendered/${note.path}`, note.content];
  } else if (flags.library) {
    const lib = (await readOr(join(s.target(), note.path))) ?? '';
    pair = [`staging/${note.path}`, (await readOr(staged)) ?? '', `library/${note.path}`, lib];
  } else {
    pair = [
      `staging/${note.path}`,
      (await readOr(staged)) ?? '',
      `next-sync/${note.path}`,
      note.content,
    ];
  }
  const [aName, a, bName, b] = pair;
  if (a === b) {
    s.printer.line(s.printer.c.green('no differences'));
    return ExitCode.Ok;
  }
  const patch = createTwoFilesPatch(aName, bName, a, b);
  if (s.deps.stdoutTTY && s.deps.which('delta')) await s.deps.exec(['delta'], { input: patch });
  else s.deps.stdout.write(patch);
  return ExitCode.Ok;
}

export type PickAction = 'path' | 'show' | 'diff' | 'open';

export interface PickFlags {
  readonly multi?: boolean | undefined;
  readonly then?: PickAction | undefined;
  readonly query?: string | undefined;
}

async function pickWithFzf(s: Session, notes: readonly RenderedNote[], flags: PickFlags) {
  const lines = notes.map((n) => `${n.title}\t${n.path}\t${n.id}`).join('\n');
  const preview = [...s.deps.self, 'show', '--plain', '{3}'].map((a, i, all) =>
    i === all.length - 1 ? a : shellQuote(a),
  );
  const r = await s.deps.exec(
    [
      'fzf',
      '--delimiter=\t',
      '--with-nth=1,2',
      '--preview',
      preview.join(' '),
      ...(flags.multi ? ['--multi'] : []),
      ...(flags.query ? ['--query', flags.query] : []),
    ],
    { input: lines, capture: true },
  );
  if (r.exitCode !== 0) return [];
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t')[2] ?? '');
}

/** Fuzzy-picks notes (fzf with a live preview, or a built-in prompt) and acts on them. */
export async function pickCommand(s: Session, flags: PickFlags): Promise<Code> {
  const notes = [...loadRender(s).notes].sort((a, b) => a.path.localeCompare(b.path));
  const { deps } = s;
  let ids: string[];
  if (deps.which('fzf')) {
    ids = await pickWithFzf(s, notes, flags);
  } else if (deps.stdinTTY) {
    const choices = notes.map((n) => ({ value: n.id, label: n.title, hint: n.path }));
    ids = (await deps.prompter.choose('Pick notes', choices, flags.multi === true)) ?? [];
  } else {
    throw new CliError(
      'pick needs fzf or an interactive terminal',
      ExitCode.Usage,
      'brew install fzf',
    );
  }
  const picked = ids
    .map((id) => notes.find((n) => n.id === id))
    .filter((n): n is RenderedNote => n !== undefined);
  for (const note of picked) {
    switch (flags.then ?? 'path') {
      case 'show':
        await showCommand(s, note.id, {});
        break;
      case 'diff':
        await diffCommand(s, note.id, {});
        break;
      case 'open':
        await deps.exec(['open', gotoUrl(note.title)]);
        break;
      default:
        deps.stdout.write(`${join(s.loaded.config.staging, note.path)}\n`);
    }
  }
  return picked.length > 0 ? ExitCode.Ok : ExitCode.Interrupted;
}

/** One display title per line (fish completion helper). */
export function titlesCommand(s: Session): Code {
  for (const row of s.db().outNotes()) s.deps.stdout.write(`${row.stem.replaceAll(':', '/')}\n`);
  return ExitCode.Ok;
}
