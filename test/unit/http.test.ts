import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { FileMeta } from '../../src/domain/model.ts';
import { HttpSource, HttpStatusError } from '../../src/source/http.ts';
import { docTypeOf } from '../../src/source/types.ts';
import { CliError } from '../../src/util/errors.ts';
import { type FakeInkdrop, PASS, startFakeInkdrop, USER } from '../support/fake-inkdrop.ts';
import { fileDoc, noteDoc, PNG_BYTES, PNG_MD5 } from '../support/fixtures.ts';

let fake: FakeInkdrop;
const signal = new AbortController().signal;
const source = (over: Partial<ConstructorParameters<typeof HttpSource>[0]> = {}) =>
  new HttpSource({ url: `${fake.url}/`, username: USER, password: PASS, retryBaseMs: 1, ...over });
const meta = (id: string, md5: string | null = PNG_MD5): FileMeta => ({
  id: `file:${id}`,
  rev: '1',
  name: 'x.png',
  contentType: 'image/png',
  contentLength: 1,
  md5hex: md5,
  createdAt: 0,
});

beforeEach(() => {
  fake = startFakeInkdrop([noteDoc('a'), noteDoc('b'), fileDoc('f')]);
});
afterEach(() => fake.stop());

describe('HttpSource', () => {
  test('probe returns the version', async () => {
    const s = source();
    expect(s.describe).toBe(fake.url);
    expect(await s.probe(signal)).toEqual({ version: '6.1.4' });
  });

  test('changes pages through results and skips non-doc ids', async () => {
    fake.remove('note:gone');
    const batches = [];
    for await (const b of source({ pageSize: 2 }).changes(null, signal)) batches.push(b);
    const ids = batches.flatMap((b) => b.changes.map((c) => c.id));
    expect(ids).toEqual(['note:a', 'note:b', 'file:f', 'note:gone']);
    expect(batches.flatMap((b) => b.changes).find((c) => c.id === 'note:gone')?.deleted).toBe(true);
    expect(batches.at(-1)?.lastSeq).toBe('6');
    expect(fake.requests.some((r) => r.includes('since=4'))).toBe(true);
  });

  test('changes resumes from a cursor', async () => {
    const batches = [];
    for await (const b of source().changes('4', signal)) batches.push(b);
    expect(batches[0]?.changes.map((c) => c.id)).toEqual(['file:f']);
  });

  test('attachment decodes base64 and verifies md5', async () => {
    expect(await source().attachment(meta('f'), signal)).toEqual(PNG_BYTES);
    fake.attachments.set('file:f', new Uint8Array([1, 2, 3]));
    await expect(source().attachment(meta('f'), signal)).rejects.toThrow('md5 mismatch');
    expect(await source().attachment(meta('f', null), signal)).toEqual(new Uint8Array([1, 2, 3]));
  });

  test('attachment without data fails', async () => {
    await expect(source({ attempts: 1 }).attachment(meta('missing'), signal)).rejects.toThrow(
      'HTTP 404',
    );
  });

  test('retries 5xx then succeeds', async () => {
    fake.failNext = { status: 503, count: 2 };
    expect(await source().probe(signal)).toEqual({ version: '6.1.4' });
  });

  test('persistent 5xx becomes a source error', async () => {
    fake.failNext = { status: 500, count: 5 };
    await expect(source().probe(signal)).rejects.toBeInstanceOf(CliError);
  });

  test('401 fails fast with a hint', async () => {
    const s = new HttpSource({ url: fake.url, username: 'x', password: 'y' });
    const err = await s.probe(signal).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toContain('credentials');
    expect(fake.requests).toHaveLength(1);
  });

  test('unreachable server is reported', async () => {
    const s = new HttpSource({
      url: 'http://127.0.0.1:1',
      username: 'u',
      password: 'p',
      retryBaseMs: 1,
    });
    await expect(s.probe(signal)).rejects.toThrow('cannot reach Inkdrop');
  });

  test('malformed responses are rejected', async () => {
    const bad = (body: unknown) =>
      new HttpSource({
        url: 'http://x',
        username: 'u',
        password: 'p',
        fetch: (async () => Response.json(body)) as unknown as typeof fetch,
      });
    await expect(bad({ nope: 1 }).probe(signal)).rejects.toThrow('unexpected response');
    const gen = bad({ nope: 1 }).changes(null, signal);
    await expect(gen.next()).rejects.toThrow('unexpected /_changes');
    await expect(bad({}).attachment(meta('f'), signal)).rejects.toThrow('no attachment data');
  });

  test('aborts propagate without wrapping', async () => {
    const ctl = new AbortController();
    ctl.abort(new Error('stop'));
    await expect(source().probe(ctl.signal)).rejects.toThrow();
  });

  test('HttpStatusError and docTypeOf', () => {
    expect(new HttpStatusError(418, '/x').message).toBe('HTTP 418 for /x');
    expect(docTypeOf('note:1')).toBe('note');
    expect(docTypeOf('activity:1')).toBeNull();
    expect(docTypeOf('config')).toBeNull();
  });
});
