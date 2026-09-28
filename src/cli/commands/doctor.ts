import { constants } from 'node:fs';
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type InkdropServer, resolveInkdropServer } from '../../config/inkdrop.ts';
import { isRetired } from '../../domain/model.ts';
import type { StoredDoc } from '../../domain/snapshot.ts';
import { buildSnapshot } from '../../domain/snapshot.ts';
import { assignFolders } from '../../naming/folders.ts';
import { assignTitles } from '../../naming/titles.ts';
import { withAncestors } from '../../plan/render.ts';
import { HttpSource } from '../../source/http.ts';
import { type ExitCode as Code, ExitCode, errorMessage } from '../../util/errors.ts';
import { MAX_FOLDERS } from '../../verify/rules.ts';
import type { Session } from '../context.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly hint?: string;
}

const OPTIONAL_TOOLS = ['fzf', 'delta', 'glow', 'chafa'] as const;

function isWritable(path: string): Promise<boolean> {
  return access(path, constants.W_OK).then(
    () => true,
    () => false,
  );
}

async function nearestWritable(path: string): Promise<string | null> {
  let p = path;
  while (!(await isWritable(p))) {
    const parent = dirname(p);
    if (parent === p) return null;
    p = parent;
  }
  return p;
}

async function checkStaging(s: Session): Promise<Check> {
  const { staging } = s.loaded.config;
  const writable = await nearestWritable(staging);
  return writable
    ? { name: 'staging', status: 'ok', detail: staging }
    : { name: 'staging', status: 'fail', detail: `${staging} is not writable` };
}

async function checkTarget(s: Session): Promise<Check> {
  const target = s.target();
  try {
    const entries = await readdir(target);
    return {
      name: 'miaoyan library',
      status: 'ok',
      detail: `${target} (${entries.length} entries)`,
    };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') {
      return {
        name: 'miaoyan library',
        status: 'fail',
        detail: `${target}: permission denied`,
        hint: 'grant your terminal Full Disk Access (System Settings → Privacy & Security)',
      };
    }
    return { name: 'miaoyan library', status: 'warn', detail: `${target}: ${errorMessage(e)}` };
  }
}

async function checkMetadata(s: Session): Promise<Check> {
  const { platform, tmpDir } = s.deps;
  const dir = await mkdtemp(join(tmpDir, 'ink2miao-doctor-'));
  try {
    const file = join(dir, 'probe.md');
    await writeFile(file, 'probe');
    const created = Date.UTC(2020, 0, 2, 3, 4, 5, 678);
    platform.setTimes(file, created, created + 1000);
    platform.setPinned(file, true);
    const stat = await Bun.file(file).stat();
    const okTimes = stat.birthtime.getTime() === created && stat.mtime.getTime() === created + 1000;
    const pinned = platform.isPinned(file);
    const detail = `${platform.name}: dates ${okTimes ? 'ok' : 'not preserved'}, pin ${pinned ? 'ok' : 'unsupported'}`;
    return { name: 'dates & pins', status: okTimes && pinned ? 'ok' : 'warn', detail };
  } catch (e) {
    return { name: 'dates & pins', status: 'fail', detail: errorMessage(e) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function checkInkdrop(s: Session, checks: Check[]): Promise<void> {
  let server: InkdropServer;
  try {
    server = resolveInkdropServer(s.deps.env, s.loaded.config.inkdropConfig);
    checks.push({ name: 'inkdrop credentials', status: 'ok', detail: `from ${server.origin}` });
  } catch (e) {
    checks.push({ name: 'inkdrop credentials', status: 'fail', detail: errorMessage(e) });
    return;
  }
  const source = new HttpSource({ ...server, fetch: s.deps.fetch, attempts: 1 });
  try {
    const { version } = await source.probe(s.deps.signal);
    checks.push({ name: 'inkdrop server', status: 'ok', detail: `${server.url} (v${version})` });
    const docs: StoredDoc[] = [];
    for await (const batch of source.changes(null, s.deps.signal)) {
      for (const c of batch.changes) if (!c.deleted) docs.push(c);
    }
    checks.push(...libraryChecks(s, docs));
  } catch (e) {
    checks.push({ name: 'inkdrop server', status: 'fail', detail: errorMessage(e) });
  }
}

function libraryChecks(s: Session, docs: StoredDoc[]): Check[] {
  const { snapshot, invalid } = buildSnapshot(docs);
  const opts = s.renderOptions();
  const notes = [...snapshot.notes.values()].filter(
    (n) => n.bookId !== 'template' && (opts.includeTrash || !isRetired(n)),
  );
  const folders = assignFolders(snapshot.books.values(), opts);
  const titles = assignTitles(
    notes.map((n) => ({ id: n.id, title: n.title, createdAt: n.createdAt, retired: isRetired(n) })),
  );
  const count = withAncestors([...folders.paths.values(), opts.deletedFolder]).length;
  const collisions = titles.renames.filter((r) => r.reason === 'collision').length;
  return [
    {
      name: 'inkdrop data',
      status: invalid.length > 0 ? 'warn' : 'ok',
      detail: `${snapshot.notes.size} notes, ${snapshot.books.size} notebooks, ${snapshot.tags.size} tags, ${snapshot.files.size} files${invalid.length ? `, ${invalid.length} invalid` : ''}`,
    },
    {
      name: 'folders',
      status: count > MAX_FOLDERS ? 'fail' : 'ok',
      detail: `${count} of ~${MAX_FOLDERS} MiaoYan can show`,
    },
    {
      name: 'titles',
      status: collisions > 0 ? 'warn' : 'ok',
      detail: `${collisions} duplicate titles will get a " (n)" suffix`,
    },
  ];
}

function toolCheck(s: Session): Check {
  const found = OPTIONAL_TOOLS.filter((t) => s.deps.which(t) !== null);
  const missing = OPTIONAL_TOOLS.filter((t) => !found.includes(t));
  return {
    name: 'optional tools',
    status: missing.length > 0 ? 'warn' : 'ok',
    detail: `found: ${found.join(', ') || 'none'}${missing.length ? `; missing: ${missing.join(', ')}` : ''}`,
  };
}

export async function runChecks(s: Session): Promise<Check[]> {
  const cfg = s.loaded;
  const overridden = Object.entries(cfg.origins).filter(([, o]) => o !== 'default');
  const checks: Check[] = [
    {
      name: 'config',
      status: 'ok',
      detail: `${cfg.file ?? 'defaults'}${overridden.length ? ` (${overridden.map(([k, o]) => `${k}←${o}`).join(', ')})` : ''}`,
    },
  ];
  await checkInkdrop(s, checks);
  checks.push(await checkStaging(s), await checkTarget(s), await checkMetadata(s));
  const running = s.deps.platform.isMiaoYanRunning();
  checks.push({
    name: 'miaoyan app',
    status: running ? 'warn' : 'ok',
    detail: running ? 'running — quit it before promoting' : 'not running',
  });
  checks.push(toolCheck(s));
  return checks;
}

export async function doctorCommand(s: Session): Promise<Code> {
  const checks = await runChecks(s);
  const p = s.printer;
  const icon: Record<CheckStatus, string> = {
    ok: p.c.green('✓'),
    warn: p.c.yellow('!'),
    fail: p.c.red('✗'),
  };
  for (const c of checks) {
    p.event('check', { ...c });
    p.line(`${icon[c.status]} ${c.name.padEnd(20)} ${c.detail}`);
    if (c.hint) p.line(`  ${p.c.dim(c.hint)}`);
  }
  return checks.some((c) => c.status === 'fail') ? ExitCode.Internal : ExitCode.Ok;
}
