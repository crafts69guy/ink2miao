import type { ExecResult, Failure } from '../apply/executor.ts';
import type { ActionKind, SyncPlan } from '../plan/planner.ts';
import type { RenderPlan } from '../plan/render.ts';
import type { UnresolvedKind } from '../transform/index.ts';

export interface SyncReport {
  readonly finishedAt: string;
  readonly source: string;
  readonly inkdropVersion: string;
  readonly staging: string;
  readonly dryRun: boolean;
  readonly counts: {
    readonly notes: number;
    readonly live: number;
    readonly retired: number;
    readonly attachments: number;
    readonly unreferencedFiles: number;
    readonly folders: number;
    readonly skippedTemplates: number;
    readonly skippedTrash: number;
    readonly invalidDocs: number;
  };
  readonly changes: Readonly<Partial<Record<ActionKind, number>>>;
  readonly conflicts: readonly { path: string; reason: string }[];
  readonly backups: readonly string[];
  readonly unresolved: readonly { path: string; kind: UnresolvedKind; raw: string }[];
  readonly renames: readonly { path: string; from: string | null; to: string; reason: string }[];
  readonly folderRenames: readonly { name: string; folder: string }[];
  readonly attachmentFailures: readonly Failure[];
  readonly metadataFailures: readonly Failure[];
}

export interface ReportInput {
  readonly render: RenderPlan;
  readonly plan: SyncPlan;
  readonly exec: ExecResult | null;
  readonly source: string;
  readonly inkdropVersion: string;
  readonly staging: string;
  readonly invalidDocs: number;
  readonly now: number;
}

export function buildSyncReport(input: ReportInput): SyncReport {
  const { render, plan, exec } = input;
  const pathOf = new Map(render.notes.map((n) => [n.id, n.path]));
  const retired = render.notes.filter((n) => n.retired).length;
  return {
    finishedAt: new Date(input.now).toISOString(),
    source: input.source,
    inkdropVersion: input.inkdropVersion,
    staging: input.staging,
    dryRun: exec === null,
    counts: {
      notes: render.notes.length,
      live: render.notes.length - retired,
      retired,
      attachments: render.attachments.reduce((n, a) => n + a.paths.length, 0),
      unreferencedFiles: render.unreferencedFiles,
      folders: render.folders.length,
      skippedTemplates: render.skipped.filter((s) => s.reason === 'template').length,
      skippedTrash: render.skipped.filter((s) => s.reason === 'trash').length,
      invalidDocs: input.invalidDocs,
    },
    changes: plan.stats,
    conflicts: plan.notes.flatMap((a) =>
      a.kind === 'conflict' ? [{ path: a.path, reason: a.reason }] : [],
    ),
    backups: exec?.backups ?? [],
    unresolved: render.notes.flatMap((n) =>
      n.unresolved.map((u) => ({ path: n.path, kind: u.kind, raw: u.raw })),
    ),
    renames: render.renames.map((r) => ({
      path: pathOf.get(r.id) ?? r.id,
      from: r.from,
      to: r.to,
      reason: r.reason,
    })),
    folderRenames: render.folderRenames.map((f) => ({ name: f.name, folder: f.folder })),
    attachmentFailures: exec?.attachmentFailures ?? [],
    metadataFailures: exec?.metadataFailures ?? [],
  };
}

const CHANGE_LABELS: readonly [ActionKind, string][] = [
  ['create', 'created'],
  ['update', 'updated'],
  ['move', 'moved'],
  ['restore', 'restored'],
  ['adopt', 'adopted'],
  ['retire', 'retired'],
  ['conflict', 'conflicts'],
  ['skip', 'unchanged'],
  ['attachment:fetch', 'attachments fetched'],
  ['attachment:record', 'attachments recorded'],
  ['attachment:gc', 'attachments removed'],
  ['attachment:forget', 'attachments forgotten'],
];

/** "3 created, 1 moved, 559 unchanged" (only non-zero kinds). */
export function describeChanges(changes: SyncReport['changes']): string {
  const parts = CHANGE_LABELS.flatMap(([k, label]) => {
    const n = changes[k] ?? 0;
    return n > 0 ? [`${n} ${label}`] : [];
  });
  return parts.length > 0 ? parts.join(', ') : 'nothing to do';
}

function section<T>(title: string, rows: readonly T[], fmt: (row: T) => string): string[] {
  if (rows.length === 0) return [];
  return ['', `## ${title} (${rows.length})`, '', ...rows.map((r) => `- ${fmt(r)}`)];
}

export function formatReportMarkdown(r: SyncReport): string {
  const c = r.counts;
  const lines = [
    `# ink2miao report — ${r.finishedAt}${r.dryRun ? ' (dry run)' : ''}`,
    '',
    `Source: ${r.source} (Inkdrop ${r.inkdropVersion}) → ${r.staging}`,
    '',
    `Changes: ${describeChanges(r.changes)}`,
    '',
    '| Notes | Live | Deleted | Attachments | Unreferenced files | Folders | Templates skipped | Trash skipped | Invalid docs |',
    '|---|---|---|---|---|---|---|---|---|',
    `| ${c.notes} | ${c.live} | ${c.retired} | ${c.attachments} | ${c.unreferencedFiles} | ${c.folders} | ${c.skippedTemplates} | ${c.skippedTrash} | ${c.invalidDocs} |`,
    ...section('Conflicts', r.conflicts, (x) => `\`${x.path}\` — ${x.reason}`),
    ...section('Backups', r.backups, (b) => `\`${b}\``),
    ...section(
      'Unresolved references',
      r.unresolved,
      (u) => `\`${u.path}\` — ${u.kind}: \`${u.raw}\``,
    ),
    ...section(
      'Renamed titles',
      r.renames,
      (x) => `\`${x.path}\` — ${x.reason}${x.from ? ` (was \`${x.from}\`)` : ''}`,
    ),
    ...section('Renamed notebooks', r.folderRenames, (f) => `${f.name} → \`${f.folder}\``),
    ...section('Attachment failures', r.attachmentFailures, (f) => `\`${f.path}\` — ${f.error}`),
    ...section('Metadata failures', r.metadataFailures, (f) => `\`${f.path}\` — ${f.error}`),
  ];
  return `${lines.join('\n')}\n`;
}
