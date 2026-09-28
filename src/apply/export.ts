import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CliError, ExitCode } from '../util/errors.ts';

export const STAGING_MARKER = '.ink2miao-staging';

/**
 * Makes `dir` an empty staging directory. Only directories that are empty or that ink2miao
 * created (marker file) are ever wiped, and never the MiaoYan library itself.
 */
export async function prepareStaging(dir: string, target: string): Promise<void> {
  if (resolve(dir) === resolve(target)) {
    throw new CliError('staging must not be the MiaoYan library', ExitCode.Usage);
  }
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir);
  const owned = entries.includes(STAGING_MARKER);
  const visible = entries.filter((e) => e !== '.DS_Store');
  if (!owned && visible.length > 0) {
    throw new CliError(
      `refusing to wipe ${dir}: it is not empty and was not created by ink2miao`,
      ExitCode.Usage,
      'choose an empty directory with --staging',
    );
  }
  for (const e of entries) {
    if (e !== STAGING_MARKER) await rm(join(dir, e), { recursive: true, force: true });
  }
  await writeFile(join(dir, STAGING_MARKER), 'ink2miao staging directory\n');
}

export function isStaging(dir: string): boolean {
  return existsSync(join(dir, STAGING_MARKER));
}

/**
 * Makes sure `dir` can be used as staging without wiping it: creates it (with the marker) when
 * missing or empty, accepts it when it carries the marker, refuses anything else.
 */
export async function ensureStaging(dir: string, target: string): Promise<void> {
  if (resolve(dir) === resolve(target)) {
    throw new CliError('staging must not be the MiaoYan library', ExitCode.Usage);
  }
  await mkdir(dir, { recursive: true });
  const entries = (await readdir(dir)).filter((e) => e !== '.DS_Store');
  if (entries.includes(STAGING_MARKER)) return;
  if (entries.length > 0) {
    throw new CliError(
      `refusing to use ${dir}: it is not empty and was not created by ink2miao`,
      ExitCode.Usage,
      'choose an empty directory with --staging',
    );
  }
  await writeFile(join(dir, STAGING_MARKER), 'ink2miao staging directory\n');
}
