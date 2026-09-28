import { watch } from 'node:fs';
import { TEMP_PREFIX } from '../apply/writer.ts';

/**
 * Resolves after something under `dir` changed and then stayed quiet for `debounceMs`;
 * rejects when `signal` aborts. Our own temp files are ignored.
 */
export function waitForChange(dir: string, debounceMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watcher = watch(dir, { recursive: true }, (_event, name) => {
      if (name?.split('/').at(-1)?.startsWith(TEMP_PREFIX)) return;
      clearTimeout(timer);
      timer = setTimeout(() => finish(null), debounceMs);
    });
    const onAbort = () => finish(signal.reason);
    const finish = (error: unknown) => {
      clearTimeout(timer);
      watcher.close();
      signal.removeEventListener('abort', onAbort);
      if (error === null) resolve();
      else reject(error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
