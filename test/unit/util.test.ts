import { describe, expect, test } from 'bun:test';
import { CliError, ExitCode, errorMessage } from '../../src/util/errors.ts';
import { couchDigestToHex, md5Hex, sha256Hex } from '../../src/util/hash.ts';
import { decodeComponent, encodeComponent } from '../../src/util/percent.ts';
import { mapLimit } from '../../src/util/pool.ts';
import { sleep, withRetry } from '../../src/util/retry.ts';

test('percent encoding is safe inside markdown destinations', () => {
  expect(encodeComponent("a b(c)!'*/ệ")).toBe('a%20b%28c%29%21%27%2A%2F%E1%BB%87');
  expect(decodeComponent('a%20b')).toBe('a b');
  expect(decodeComponent('%E0%A4%A')).toBe('%E0%A4%A');
});

test('hashes and couch digests', () => {
  const bytes = new TextEncoder().encode('hello');
  expect(md5Hex(bytes)).toBe('5d41402abc4b2a76b9719d911017c592');
  expect(sha256Hex('hello')).toHaveLength(64);
  const b64 = Buffer.from('5d41402abc4b2a76b9719d911017c592', 'hex').toString('base64');
  expect(couchDigestToHex(`md5-${b64}`)).toBe('5d41402abc4b2a76b9719d911017c592');
  expect(couchDigestToHex('sha1-xyz')).toBeNull();
  expect(couchDigestToHex('md5-AAAA')).toBeNull();
});

test('errors', () => {
  const e = new CliError('nope', ExitCode.Usage, 'try again');
  expect(e.name).toBe('CliError');
  expect(e.hint).toBe('try again');
  expect(new CliError('x', ExitCode.Internal).hint).toBeNull();
  expect(errorMessage(new Error('m'))).toBe('m');
  expect(errorMessage('s')).toBe('s');
});

describe('withRetry', () => {
  const signal = new AbortController().signal;

  test('retries retryable failures with backoff', async () => {
    const waits: number[] = [];
    let calls = 0;
    const value = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('flaky');
        return 'ok';
      },
      {
        attempts: 3,
        baseMs: 100,
        signal,
        retryable: () => true,
        random: () => 1,
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    expect(value).toBe('ok');
    expect(waits).toEqual([100, 200]);
  });

  test('gives up on non-retryable errors and after the last attempt', async () => {
    const opts = { baseMs: 1, signal, sleep: async () => {} };
    await expect(
      withRetry(() => Promise.reject(new Error('fatal')), {
        ...opts,
        attempts: 5,
        retryable: () => false,
      }),
    ).rejects.toThrow('fatal');
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls++;
          return Promise.reject(new Error('x'));
        },
        { ...opts, attempts: 2, retryable: () => true },
      ),
    ).rejects.toThrow('x');
    expect(calls).toBe(2);
  });

  test('uses real sleep and Math.random by default', async () => {
    let calls = 0;
    const r = await withRetry(
      async () => {
        if (++calls === 1) throw new Error('once');
        return calls;
      },
      { attempts: 2, baseMs: 1, signal, retryable: () => true },
    );
    expect(r).toBe(2);
  });
});

describe('sleep', () => {
  test('resolves after the delay', async () => {
    await sleep(1, new AbortController().signal);
  });

  test('rejects when already aborted or aborted while waiting', async () => {
    const pre = new AbortController();
    pre.abort(new Error('pre'));
    await expect(sleep(10, pre.signal)).rejects.toThrow('pre');
    const mid = new AbortController();
    const p = sleep(1000, mid.signal);
    mid.abort(new Error('mid'));
    await expect(p).rejects.toThrow('mid');
  });
});

describe('mapLimit', () => {
  test('bounds concurrency and settles failures', async () => {
    let inFlight = 0;
    let peak = 0;
    const r = await mapLimit([1, 2, 3, 4, 5], 2, new AbortController().signal, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(1);
      inFlight--;
      if (n === 3) throw new Error('three');
      return n * 2;
    });
    expect(peak).toBe(2);
    expect(
      r
        .filter((x) => x.ok)
        .map((x) => x.value)
        .sort(),
    ).toEqual([10, 2, 4, 8]);
    expect(r.find((x) => !x.ok)?.item).toBe(3);
  });

  test('stops scheduling after abort and handles empty input', async () => {
    const ctl = new AbortController();
    const seen: number[] = [];
    await mapLimit([1, 2, 3], 1, ctl.signal, async (n) => {
      seen.push(n);
      ctl.abort();
    });
    expect(seen).toEqual([1]);
    expect(await mapLimit([], 4, ctl.signal, async () => 1)).toEqual([]);
  });
});
