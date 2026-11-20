import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterAll, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import type { AgentLink, ServerMessage, Wake, WakeResult } from '@keel/protocol';
import type { Clock } from '../src/wake';

// No test starts the real agent by leaving `--link` out: the command's default is the hosted one.
process.env.KEEL_BOARD_LINK = 'none';

const made: string[] = [];
// Tests leave nothing behind in the temp folder. Each test file that uses this helper gets the hook.
afterAll(() => {
  for (const root of made.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** Board servers a test started in a child process. Each is killed when the tests end, even after a failed assertion. */
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
});

/** Remember a child process, so it never outlives the test that started it. */
export function own<T extends ChildProcess>(child: T): T {
  children.push(child);
  return child;
}

/** The boards' private folders (the owner's token, the port) go to a temp folder, never to ~/.keel. */
export const STATE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-state-'));
made.push(STATE_ROOT);
process.env.KEEL_STATE_DIR = STATE_ROOT;

/** A fresh repository folder named `name`, inside its own temp folder. It is removed when the tests end. */
export function tempRepo(name = 'demo'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-board-'));
  made.push(root);
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  return dir;
}

export const CH = 'first-idea';

export const chapter = (id = CH) => ({ type: 'chapter.open', chapter: id, title: 'The first idea' });

export const note = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  type: 'item.add',
  chapter: CH,
  item: { id, kind: 'note', box: [100, 100, 300, 120], text, ...extra },
});

export const ink = (id: string, extra: Record<string, unknown> = {}) => ({
  type: 'item.add',
  chapter: CH,
  item: { id, kind: 'ink', box: [0, 0, 50, 50], strokes: [{ pts: [0, 0, 10, 10, 20, 5] }], targets: [], hint: 'none', ...extra },
});

/** Call the server over HTTP and read the JSON reply. */
export async function call(
  base: string,
  token: string | undefined,
  route: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  if (token) headers.authorization = `Bearer ${token}`;
  let body = init.body;
  if (init.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  const res = await fetch(`${base}${route}`, { ...init, headers, body });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: keep the text.
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

/** A websocket client that keeps every message, and can wait for one. */
export class Client {
  readonly messages: ServerMessage[] = [];
  private waiters: Array<() => void> = [];

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      this.messages.push(JSON.parse(String(data)) as ServerMessage);
      for (const w of this.waiters.splice(0)) w();
    });
  }

  static connect(url: string, headers: Record<string, string> = {}): Promise<Client> {
    const ws = new WebSocket(url, { headers });
    const client = new Client(ws);
    return new Promise((resolve, reject) => {
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      client.next((m) => m.t === 'init').then(() => resolve(client), reject);
    });
  }

  /** The first message (seen or still to come) that matches. */
  async next<T extends ServerMessage>(match: (m: ServerMessage) => boolean, ms = 3000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = this.messages.find(match);
      if (found) return found as T;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('timed out waiting for a websocket message');
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.ws.terminate();
  }
}

/** A clock the test moves by hand. */
export class FakeClock implements Clock {
  now = 0;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Move time on, running each timer that comes due, in order. */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      this.timers.delete(next[0]);
      this.now = next[1].at;
      next[1].fn();
    }
    this.now = end;
  }

  get pending(): number {
    return this.timers.size;
  }
}

/** A link the test answers by hand, or that answers every wake with `auto`. */
export class FakeLink implements AgentLink {
  readonly name = 'fake';
  readonly wakes: Wake[] = [];
  active = 0;
  maxActive = 0;
  auto: WakeResult | undefined;
  private readonly pending: Array<(r: WakeResult) => void> = [];

  wake(w: Wake): Promise<WakeResult> {
    this.wakes.push(w);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    return new Promise((resolve) => {
      const done = (r: WakeResult) => {
        this.active -= 1;
        resolve(r);
      };
      if (this.auto) done(this.auto);
      else this.pending.push(done);
    });
  }

  /** Finish the oldest wake still running. */
  finish(r: WakeResult = { ok: true }): void {
    const f = this.pending.shift();
    if (!f) throw new Error('no wake is running');
    f(r);
  }

  async close(): Promise<void> {}
}

/** Let promise callbacks run. */
export const flush = () => new Promise<void>((r) => setImmediate(r));

/** Wait until `test` is true, polling. */
export async function until(test: () => boolean | Promise<boolean>, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await test())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** One raw HTTP request, so a test can set Host, Cookie and Sec-Fetch-Site as a browser would. */
export function raw(
  port: number,
  route: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: opts.method ?? 'GET', path: route, headers: opts.headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}
