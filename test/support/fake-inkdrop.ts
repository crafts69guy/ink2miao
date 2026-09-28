import type { Server } from 'bun';
import { PNG_BYTES } from './fixtures.ts';

type Doc = Record<string, unknown>;

export interface FakeInkdrop {
  readonly url: string;
  readonly server: Server<unknown>;
  readonly requests: string[];
  docs: Doc[];
  deleted: string[];
  /** Status to return for the next N requests (e.g. 500 to exercise retries). */
  failNext: { status: number; count: number };
  /** Attachment payload override per file id. */
  attachments: Map<string, Uint8Array>;
  stop(): void;
}

export const USER = 'user';
export const PASS = 'pass';

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** Minimal stand-in for Inkdrop's local HTTP server: `/`, `/_changes`, `/<docid>`. */
export function startFakeInkdrop(docs: Doc[]): FakeInkdrop {
  const state = {
    docs,
    deleted: [] as string[],
    failNext: { status: 0, count: 0 },
    attachments: new Map<string, Uint8Array>(),
    requests: [] as string[],
  };
  const expected = `Basic ${btoa(`${USER}:${PASS}`)}`;

  const changes = (url: URL) => {
    const since = Number(url.searchParams.get('since') ?? '0');
    const limit = Number(url.searchParams.get('limit') ?? '1000');
    const rows = [
      { id: '_design/index', doc: {} },
      { id: 'activity:x', doc: {} },
      ...state.docs.map((d) => ({ id: String(d['_id']), doc: d })),
      ...state.deleted.map((id) => ({ id, deleted: true })),
    ].map((r, i) => ({ ...r, seq: i + 1, changes: [{ rev: '1-x' }] }));
    const page = rows.filter((r) => r.seq > since).slice(0, limit);
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
      const doc = state.docs.find((d) => d['_id'] === id);
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
