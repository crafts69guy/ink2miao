import type { ExportResult, Failure } from '../apply/export.ts';
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
  readonly unresolved: readonly { path: string; kind: UnresolvedKind; raw: string }[];
  readonly renames: readonly { path: string; from: string | null; to: string; reason: string }[];
  readonly folderRenames: readonly { name: string; folder: string }[];
  readonly attachmentFailures: readonly Failure[];
  readonly metadataFailures: readonly Failure[];
}

export interface ReportInput {
  readonly plan: RenderPlan;
  readonly result: ExportResult | null;
  readonly source: string;
  readonly inkdropVersion: string;
  readonly staging: string;
  readonly invalidDocs: number;
  readonly now: number;
}

export function buildSyncReport(input: ReportInput): SyncReport {
  const { plan, result } = input;
  const pathOf = new Map(plan.notes.map((n) => [n.id, n.path]));
  const retired = plan.notes.filter((n) => n.retired).length;
  return {
    finishedAt: new Date(input.now).toISOString(),
    source: input.source,
    inkdropVersion: input.inkdropVersion,
    staging: input.staging,
    dryRun: result === null,
    counts: {
      notes: plan.notes.length,
      live: plan.notes.length - retired,
      retired,
      attachments: plan.attachments.reduce((n, a) => n + a.paths.length, 0),
      unreferencedFiles: plan.unreferencedFiles,
      folders: plan.folders.length,
      skippedTemplates: plan.skipped.filter((s) => s.reason === 'template').length,
      skippedTrash: plan.skipped.filter((s) => s.reason === 'trash').length,
      invalidDocs: input.invalidDocs,
    },
    unresolved: plan.notes.flatMap((n) =>
      n.unresolved.map((u) => ({ path: n.path, kind: u.kind, raw: u.raw })),
    ),
    renames: plan.renames.map((r) => ({
      path: pathOf.get(r.id) ?? r.id,
      from: r.from,
      to: r.to,
      reason: r.reason,
    })),
    folderRenames: plan.folderRenames.map((f) => ({ name: f.name, folder: f.folder })),
    attachmentFailures: result?.attachmentFailures ?? [],
    metadataFailures: result?.metadataFailures ?? [],
  };
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
    '| Notes | Live | Deleted | Attachments | Unreferenced files | Folders | Templates skipped | Trash skipped | Invalid docs |',
    '|---|---|---|---|---|---|---|---|---|',
    `| ${c.notes} | ${c.live} | ${c.retired} | ${c.attachments} | ${c.unreferencedFiles} | ${c.folders} | ${c.skippedTemplates} | ${c.skippedTrash} | ${c.invalidDocs} |`,
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
