import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DiskState } from '../plan/planner.ts';
import { md5Hex, sha256Hex } from '../util/hash.ts';

/** Marker hash for paths that exist but cannot be read as a file (e.g. a directory). */
export const UNREADABLE = 'unreadable';

/** Lazily hashes files under `root`, caching each path's bytes once. */
export function diskState(root: string): DiskState {
  const cache = new Map<string, Uint8Array | null | typeof UNREADABLE>();
  const bytes = (path: string) => {
    if (!cache.has(path)) {
      try {
        cache.set(path, readFileSync(join(root, path)));
      } catch (e) {
        cache.set(path, (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : UNREADABLE);
      }
    }
    return cache.get(path) ?? null;
  };
  const hash = (path: string, fn: (b: Uint8Array) => string) => {
    const b = bytes(path);
    return b === null || b === UNREADABLE ? b : fn(b);
  };
  return {
    sha256: (path) => hash(path, sha256Hex),
    md5: (path) => hash(path, md5Hex),
  };
}
