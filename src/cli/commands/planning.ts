import { existsSync } from 'node:fs';
import { diskState } from '../../apply/disk.ts';
import type { NoteId } from '../../domain/model.ts';
import { buildSnapshot } from '../../domain/snapshot.ts';
import type { PriorTitle } from '../../naming/titles.ts';
import { type DiskState, planSync, type SyncPlan } from '../../plan/planner.ts';
import { type RenderPlan, renderAll } from '../../plan/render.ts';
import type { OutNote } from '../../state/db.ts';
import type { Session } from '../context.ts';

export const EMPTY_DISK: DiskState = { sha256: () => null, md5: () => null };

export interface Planned {
  readonly render: RenderPlan;
  readonly plan: SyncPlan;
  readonly invalidDocs: number;
  readonly hasData: boolean;
}

export function priorTitles(rows: readonly OutNote[]): Map<NoteId, PriorTitle> {
  return new Map(rows.map((r) => [r.noteId, { sourceTitle: r.sourceTitle, stem: r.stem }]));
}

/** Renders the local mirror and plans it against what was written before (pure apart from reads). */
export function computePlan(s: Session, opts: { fresh: boolean; force: boolean }): Planned {
  const db = s.db();
  const { snapshot, invalid } = buildSnapshot(db.liveDocs());
  const prior = opts.fresh ? [] : db.outNotes();
  const render = renderAll(snapshot, s.renderOptions(), priorTitles(prior));
  const { staging, deletions, deletedFolder } = s.loaded.config;
  const disk = opts.fresh || !existsSync(staging) ? EMPTY_DISK : diskState(staging);
  const plan = planSync(render, prior, opts.fresh ? [] : db.outAttachments(), disk, {
    force: opts.force,
    deletions,
    deletedFolder,
  });
  return { render, plan, invalidDocs: invalid.length, hasData: snapshot.notes.size > 0 };
}
