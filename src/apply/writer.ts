import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const TEMP_PREFIX = '.ink2miao-';

/** Write-to-temp, fsync, rename: readers (MiaoYan, iCloud) never observe a partial file. */
export async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `${TEMP_PREFIX}${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(tmp, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** Removes temp files left behind by an interrupted run. */
export async function sweepTempFiles(root: string): Promise<number> {
  let removed = 0;
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.isFile() && e.name.startsWith(TEMP_PREFIX) && e.name.endsWith('.tmp')) {
      await rm(join(e.parentPath, e.name), { force: true });
      removed++;
    }
  }
  return removed;
}
