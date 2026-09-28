export interface RetryOptions {
  readonly attempts: number;
  readonly baseMs: number;
  readonly signal: AbortSignal;
  readonly retryable: (e: unknown) => boolean;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly random?: () => number;
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Exponential backoff with full jitter; never retries once the signal is aborted. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
  attempt = 1,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (attempt >= opts.attempts || opts.signal.aborted || !opts.retryable(e)) throw e;
    const delay = Math.round((opts.random ?? Math.random)() * opts.baseMs * 2 ** (attempt - 1));
    await (opts.sleep ?? sleep)(delay, opts.signal);
    return withRetry(fn, opts, attempt + 1);
  }
}
