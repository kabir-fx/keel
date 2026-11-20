import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * A stand-in board server for browser tests that need the server's side of the wire and not
 * its rules: it answers the page's websocket and HTTP calls, admits every post the owner makes,
 * and lets the test play the agent and the server. It records what the page sent, with the
 * address and the headers, so a test can see that the token went and no cookie did.
 */

export type Ev = { id: string; type: string; by: string; at: string; [k: string]: unknown };

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export const GOLDEN: Ev[] = readFileSync(here('../protocol/fixtures/engine-loop/log.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as Ev);

/** The golden log up to and with event `id`. */
export const upTo = (id: string) => GOLDEN.slice(0, GOLDEN.findIndex((e) => e.id === id) + 1);

export interface StandIn {
  /** What the page posted, in order. */
  posts: Array<{ ref: string; draft: Record<string, unknown> }>;
  /** Every websocket address the page opened. */
  sockets: string[];
  /** Every HTTP call the page made to `/api/`, with its headers. */
  calls: Array<{ url: string; method: string; headers: Record<string, string> }>;
  /** The agent posts: every page gets the event. */
  agent: (draft: Record<string, unknown>) => Ev;
  /** The server says something on the websocket. */
  send: (msg: unknown) => void;
  /** An event by anyone reaches every page, as the server would broadcast it. */
  emit: (draft: Record<string, unknown>, by: string) => Ev;
  /** The server goes away for a moment: every socket closes, and the page reconnects. */
  drop: () => void;
  /** Whether the owner kept what came from outside. */
  kept: () => boolean;
}

export async function standIn(
  page: Page,
  events: Ev[],
  opts: { build?: unknown; files?: Record<string, string>; foreign?: Array<{ from: number; to: number }>; codes?: Record<string, string> } = {},
): Promise<StandIn> {
  let foreign = opts.foreign;
  /** One-time codes and the token each is traded for. A code works once. */
  const codes = new Map(Object.entries(opts.codes ?? {}));
  const log = [...events];
  let last = Date.parse(log[log.length - 1]!.at);
  const stamp = (draft: Record<string, unknown>, by: string): Ev => {
    last += 1000;
    const ev = { ...draft, by, id: `e${log.length + 1}`, at: new Date(last).toISOString().replace(/\.\d+Z$/, 'Z') } as Ev;
    log.push(ev);
    return ev;
  };
  const posts: StandIn['posts'] = [];
  const sockets: string[] = [];
  const calls: StandIn['calls'] = [];
  const open = new Set<{ send: (m: string) => void; close: () => Promise<void> | void }>();
  await page.routeWebSocket(/\/ws/, (ws) => {
    sockets.push(ws.url());
    open.add(ws);
    ws.onClose(() => open.delete(ws));
    ws.send(JSON.stringify({ t: 'init', name: 'uLLM', role: 'owner', events: log, presence: { state: 'listening', since: '2026-11-17T13:00:00Z' }, ...(opts.build ? { build: opts.build } : {}) }));
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw)) as { t: string; ref: string; draft: Record<string, unknown> };
      if (msg.t !== 'post') return;
      posts.push(msg);
      ws.send(JSON.stringify({ t: 'ok', ref: msg.ref, event: stamp(msg.draft, 'owner') }));
    });
  });
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    calls.push({ url: req.url(), method: req.method(), headers: await req.allHeaders() });
    const path = new URL(req.url()).pathname;
    const file = /^\/api\/assets\/(.+)$/.exec(path)?.[1];
    if (file && opts.files?.[decodeURIComponent(file)] !== undefined) {
      return route.fulfill({ status: 200, contentType: 'text/plain', body: opts.files[decodeURIComponent(file)]! });
    }
    if (path === '/api/board') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ name: 'uLLM', seq: log.length, role: 'owner', open: 0, ...(foreign ? { foreign } : {}) }) });
    }
    if (path === '/api/session' && req.method() === 'POST') {
      const code = (req.postDataJSON() as { code?: string } | null)?.code ?? '';
      const token = codes.get(code);
      codes.delete(code);
      return token
        ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token, role: 'owner' }) })
        : route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"used"}' });
    }
    if (path === '/api/keep' && req.method() === 'POST') {
      foreign = undefined;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"kept":true}' });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not here"}' });
  });
  return {
    posts,
    sockets,
    calls,
    agent: (draft) => {
      const ev = stamp(draft, 'agent');
      for (const ws of open) ws.send(JSON.stringify({ t: 'event', event: ev }));
      return ev;
    },
    send: (msg) => {
      for (const ws of open) ws.send(JSON.stringify(msg));
    },
    emit: (draft, by) => {
      const ev = stamp(draft, by);
      for (const ws of open) ws.send(JSON.stringify({ t: 'event', event: ev }));
      return ev;
    },
    drop: () => {
      for (const ws of [...open]) {
        open.delete(ws);
        void ws.close();
      }
    },
    kept: () => opts.foreign !== undefined && foreign === undefined,
  };
}
