export interface Settled<T, R> {
  readonly item: T;
  readonly ok: boolean;
  readonly value?: R;
  readonly error?: unknown;
}

/**
 * Runs `fn` over `items` with at most `limit` in flight. Never rejects for item failures;
 * stops scheduling new work once `signal` aborts.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  signal: AbortSignal,
  fn: (item: T) => Promise<R>,
): Promise<Settled<T, R>[]> {
  const results: Settled<T, R>[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length && !signal.aborted) {
      const item = items[next++] as T;
      try {
        results.push({ item, ok: true, value: await fn(item) });
      } catch (error) {
        results.push({ item, ok: false, error });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
