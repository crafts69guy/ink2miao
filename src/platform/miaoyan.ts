import { fileURLToPath } from 'node:url';

export type Spawn = (cmd: readonly string[]) => { success: boolean; stdout: string };

export function spawnText(cmd: readonly string[]): { success: boolean; stdout: string } {
  const r = Bun.spawnSync([...cmd], { stdout: 'pipe', stderr: 'ignore' });
  return { success: r.success, stdout: r.stdout.toString() };
}

/**
 * The library folder MiaoYan is configured to use (`storageUrl` in its preferences), or null
 * when unset (MiaoYan then uses its iCloud container). Values may be paths or file URLs.
 */
export function miaoyanLibrary(spawn: Spawn = spawnText): string | null {
  for (const domain of ['com.tw93.miaoyan', 'com.tw93.MiaoYan']) {
    const r = spawn(['defaults', 'read', domain, 'storageUrl']);
    const value = r.stdout.trim();
    if (!r.success || value.length === 0) continue;
    return value.startsWith('file://') ? fileURLToPath(value) : value;
  }
  return null;
}
