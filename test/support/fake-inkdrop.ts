import type { Server } from 'bun';
import { PNG_BYTES } from './fixtures.ts';

type Doc = Record<string, unknown>;

interface Entry {
  seq: number;
  doc: Doc | null;
}

export interface FakeInkdrop {
  readonly url: string;
  readonly server: Server<unknown>;
  readonly requests: string[];
  /** Status to return for the next N requests (e.g. 500 to exercise retries). */
  failNext: { status: number; count: number };
  /** Attachment payload override per file id. */
  readonly attachments: Map<string, Uint8Array>;
  /** Creates or updates a doc with a new sequence number (like a CouchDB write). */
  put(doc: Doc): void;
  /** Deletes a doc (tombstone with a new sequence number). */
  remove(id: string): void;
  get(id: string): Doc | undefined;
  stop(): void;
}

export const USER = 'user';
export const PASS = 'pass';

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** Minimal stand-in for Inkdrop's local HTTP server: `/`, `/_changes`, `/<docid>`. */
export function startFakeInkdrop(initial: Doc[]): FakeInkdrop {
  const log = new Map<string, Entry>();
  let seq = 0;
  const put = (doc: Doc) => {
    const id = String(doc['_id']);
    log.delete(id);
    log.set(id, { seq: ++seq, doc });
  };
  for (const doc of [{ _id: '_design/index' }, { _id: 'activity:x' }, ...initial]) put(doc);

  const state = {
    failNext: { status: 0, count: 0 },
    attachments: new Map<string, Uint8Array>(),
    requests: [] as string[],
    put,
    remove(id: string) {
      log.delete(id);
      log.set(id, { seq: ++seq, doc: null });
    },
    get: (id: string) => log.get(id)?.doc ?? undefined,
  };
  const expected = `Basic ${btoa(`${USER}:${PASS}`)}`;

  const changes = (url: URL) => {
    const since = Number(url.searchParams.get('since') ?? '0');
    const limit = Number(url.searchParams.get('limit') ?? '1000');
    const page = [...log.entries()]
      .filter(([, e]) => e.seq > since)
      .sort(([, a], [, b]) => a.seq - b.seq)
      .slice(0, limit)
      .map(([id, e]) => ({
        id,
        seq: e.seq,
        changes: [{ rev: `${e.seq}-x` }],
        ...(e.doc ? { doc: e.doc } : { deleted: true }),
      }));
    return json({ results: page, last_seq: page.at(-1)?.seq ?? since });
  };

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      state.requests.push(`${url.pathname}${url.search}`);
      if (req.headers.get('authorization') !== expected)
        return json({ error: 'unauthorized' }, 401);
      if (state.failNext.count > 0) {
        state.failNext.count--;
        return json({ error: 'boom' }, state.failNext.status);
      }
      if (url.pathname === '/') return json({ version: '6.1.4', ok: true });
      if (url.pathname === '/_changes') return changes(url);
      const id = decodeURIComponent(url.pathname.slice(1));
      const doc = state.get(id);
      if (!doc) return json({ ok: false, error: 'missing' }, 404);
      if (id.startsWith('file:') && url.searchParams.get('attachments') === 'true') {
        const bytes = state.attachments.get(id) ?? PNG_BYTES;
        const data = Buffer.from(bytes).toString('base64');
        return json({ ...doc, _attachments: { index: { content_type: 'image/png', data } } });
      }
      return json(doc);
    },
  });

  return Object.assign(state, {
    url: `http://127.0.0.1:${server.port}`,
    server,
    stop: () => server.stop(true),
  });
}
