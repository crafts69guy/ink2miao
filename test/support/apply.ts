import { diskState } from '../../src/apply/disk.ts';
import { type ExecDeps, executePlan } from '../../src/apply/executor.ts';
import type { FileMeta } from '../../src/domain/model.ts';
import { type PlanOptions, planSync } from '../../src/plan/planner.ts';
import type { RenderPlan } from '../../src/plan/render.ts';
import { portablePlatform } from '../../src/platform/darwin.ts';
import type { Source } from '../../src/source/types.ts';
import { StateDb } from '../../src/state/db.ts';
import { PNG_BYTES } from './fixtures.ts';

export const PLAN_OPTS: PlanOptions = {
  force: false,
  deletions: 'move',
  deletedFolder: '_Inkdrop Deleted',
};

export function fakeSource(fail: (f: FileMeta) => boolean = () => false): Source {
  return {
    describe: 'fake',
    probe: async () => ({ version: '1' }),
    async *changes() {},
    attachment: async (f: FileMeta) => {
      if (fail(f)) throw new Error(`boom ${f.id}`);
      return PNG_BYTES;
    },
  };
}

/** Plans `render` against `db`'s previous outputs and the files under `root`, then applies it. */
export async function syncInto(
  root: string,
  render: RenderPlan,
  db: StateDb,
  opts: Partial<PlanOptions> = {},
  deps: Partial<ExecDeps> = {},
) {
  const plan = planSync(render, db.outNotes(), db.outAttachments(), diskState(root), {
    ...PLAN_OPTS,
    ...opts,
  });
  const result = await executePlan(plan, {
    root,
    store: db,
    source: fakeSource(),
    platform: portablePlatform(),
    signal: new AbortController().signal,
    concurrency: 2,
    backupDir: `${root}.backups`,
    ...deps,
  });
  return { plan, result };
}

export function memoryDb(): StateDb {
  return StateDb.open(':memory:');
}
