import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CliError, ExitCode } from '../util/errors.ts';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface Lock {
  release(): void;
}

/**
 * Exclusive per-profile run lock (`wx` create). A lock whose owner process is gone is stale
 * and taken over (atomically, via rename), so a crash never blocks the next run.
 */
export function acquireLock(path: string, pid: number = process.pid): Lock {
  mkdirSync(dirname(path), { recursive: true });
  const release = () => rmSync(path, { force: true });
  try {
    writeFileSync(path, String(pid), { flag: 'wx' });
    return { release };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const owner = Number.parseInt(readFileSync(path, 'utf8'), 10);
  if (Number.isFinite(owner) && owner !== pid && alive(owner)) {
    throw new CliError(`another ink2miao run (pid ${owner}) holds ${path}`, ExitCode.Usage);
  }
  const tmp = `${path}.${pid}.tmp`;
  writeFileSync(tmp, String(pid));
  renameSync(tmp, path);
  return { release };
}
