import type { FileMeta } from '../domain/model.ts';
import { CliError, ExitCode, errorMessage } from '../util/errors.ts';
import { couchDigestToHex, md5Hex } from '../util/hash.ts';
import { withRetry } from '../util/retry.ts';
import { ChangesSchema, FileDocSchema, RootSchema } from './schemas.ts';
import { type ChangeBatch, type DocChange, docTypeOf, type Source } from './types.ts';

export interface HttpSourceOptions {
  readonly url: string;
  readonly username: string;
  readonly password: string;
  readonly fetch?: typeof fetch;
  readonly pageSize?: number;
  readonly attempts?: number;
  readonly retryBaseMs?: number;
}

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    path: string,
  ) {
    super(`HTTP ${status} for ${path}`);
    this.name = 'HttpStatusError';
  }
}

function retryable(e: unknown): boolean {
  if (e instanceof HttpStatusError) return e.status >= 500 || e.status === 429;
  return !(e instanceof CliError) && !(e instanceof DOMException && e.name === 'AbortError');
}

/** Inkdrop's local HTTP server (Preferences → Local Server / MCP), Basic-auth protected. */
export class HttpSource implements Source {
  readonly describe: string;
  readonly #base: string;
  readonly #auth: string;
  readonly #fetch: typeof fetch;
  readonly #pageSize: number;
  readonly #attempts: number;
  readonly #retryBaseMs: number;

  constructor(opts: HttpSourceOptions) {
    this.#base = opts.url.replace(/\/+$/, '');
    this.describe = this.#base;
    this.#auth = `Basic ${Buffer.from(`${opts.username}:${opts.password}`).toString('base64')}`;
    this.#fetch = opts.fetch ?? fetch;
    this.#pageSize = opts.pageSize ?? 500;
    this.#attempts = opts.attempts ?? 3;
    this.#retryBaseMs = opts.retryBaseMs ?? 250;
  }

  async #get(path: string, signal: AbortSignal): Promise<unknown> {
    return withRetry(
      async () => {
        let res: Response;
        try {
          res = await this.#fetch(`${this.#base}${path}`, {
            headers: { authorization: this.#auth, accept: 'application/json' },
            signal,
          });
        } catch (e) {
          if (signal.aborted) throw e;
          throw new Error(`cannot reach Inkdrop at ${this.#base}: ${errorMessage(e)}`);
        }
        if (res.status === 401 || res.status === 403) {
          throw new CliError(
            'Inkdrop rejected the credentials',
            ExitCode.Source,
            'check Preferences → Local Server, or set INKDROP_LOCAL_USERNAME/PASSWORD',
          );
        }
        if (!res.ok) throw new HttpStatusError(res.status, path.split('?')[0] ?? path);
        return (await res.json()) as unknown;
      },
      { attempts: this.#attempts, baseMs: this.#retryBaseMs, signal, retryable },
    ).catch((e: unknown) => {
      if (e instanceof CliError || signal.aborted) throw e;
      throw new CliError(
        errorMessage(e),
        ExitCode.Source,
        'is Inkdrop running with the local server enabled?',
      );
    });
  }

  async probe(signal: AbortSignal): Promise<{ version: string }> {
    const root = RootSchema.safeParse(await this.#get('/', signal));
    if (!root.success) throw new CliError('unexpected response from Inkdrop /', ExitCode.Source);
    return { version: root.data.version };
  }

  async *changes(since: string | null, signal: AbortSignal): AsyncGenerator<ChangeBatch> {
    let cursor = since ?? '0';
    for (;;) {
      const qs = `include_docs=true&since=${encodeURIComponent(cursor)}&limit=${this.#pageSize}`;
      const parsed = ChangesSchema.safeParse(await this.#get(`/_changes?${qs}`, signal));
      if (!parsed.success) throw new CliError('unexpected /_changes response', ExitCode.Source);
      const changes: DocChange[] = [];
      for (const row of parsed.data.results) {
        const type = docTypeOf(row.id);
        if (type === null) continue;
        changes.push({
          id: row.id,
          type,
          rev: row.changes[0]?.rev ?? '',
          deleted: row.deleted === true,
          doc: row.doc ?? null,
        });
      }
      cursor = parsed.data.last_seq;
      yield { changes, lastSeq: cursor };
      if (parsed.data.results.length < this.#pageSize) return;
    }
  }

  async attachment(file: FileMeta, signal: AbortSignal): Promise<Uint8Array> {
    const raw = await this.#get(`/${file.id}?attachments=true`, signal);
    const doc = FileDocSchema.safeParse(raw);
    const att = doc.success ? doc.data._attachments?.['index'] : undefined;
    if (!att?.data) throw new Error(`no attachment data for ${file.id}`);
    const bytes = new Uint8Array(Buffer.from(att.data, 'base64'));
    const expected = file.md5hex ?? (att.digest ? couchDigestToHex(att.digest) : null);
    if (expected !== null && md5Hex(bytes) !== expected) {
      throw new Error(`md5 mismatch for ${file.id} (${file.name})`);
    }
    return bytes;
  }
}
