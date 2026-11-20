import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Actor, BoardEvent, BoardState, PresenceUpdate, Refusal } from '@keel/protocol';
import { ROUTES, admitAll, digest, emptyState, renderDigest } from '@keel/protocol';

/**
 * The board server's HTTP routes, in process, built on the contract's `admit`: enough for
 * the board tools to talk to. Each token is an actor, as on the real server.
 */
export class FakeBoard {
  state: BoardState = emptyState();
  events: BoardEvent[] = [];
  /** Each presence report, with how many events the board had when it came. */
  presence: Array<PresenceUpdate & { seq: number }> = [];
  readonly tokens = { owner: 'owner-token', agent: 'agent-token', system: 'system-token' } as const;
  url = '';
  private clock = Date.parse('2026-11-17T13:00:00Z');
  private readonly server = http.createServer((req, res) => void this.handle(req, res));

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  /** Post drafts as an actor, as the routes do. */
  post(by: Actor, drafts: unknown[]) {
    this.clock += 1000;
    const r = admitAll(this.state, drafts, by, new Date(this.clock).toISOString());
    if (r.ok) {
      this.state = r.state;
      this.events.push(...r.events);
    }
    return r;
  }

  must(by: Actor, ...drafts: unknown[]): BoardEvent[] {
    const r = this.post(by, drafts);
    if (!r.ok) throw new Error(`refused under ${r.rule}: ${r.reason}`);
    return r.events;
  }

  private actor(req: http.IncomingMessage): Actor | undefined {
    const auth = req.headers.authorization ?? '';
    const t = auth.replace(/^Bearer /i, '');
    return (Object.keys(this.tokens) as Actor[]).find((a) => this.tokens[a] === t);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const by = this.actor(req);
    if (!by) return send(401, { error: 'A token is needed.' });
    const url = new URL(req.url ?? '/', this.url);
    let body: unknown;
    if (req.method === 'POST') {
      let text = '';
      for await (const c of req) text += c;
      body = JSON.parse(text);
    }
    if (url.pathname === ROUTES.digest) {
      const d = digest(this.state, { since: Number(url.searchParams.get('since') ?? 0) });
      return send(200, { digest: d, text: renderDigest(d) });
    }
    if (url.pathname === ROUTES.state) return send(200, this.state);
    if (url.pathname === ROUTES.events && req.method === 'POST') {
      const drafts = (body as { drafts?: unknown }).drafts;
      if (!Array.isArray(drafts)) return send(400, { error: 'Send { "drafts": [ ... ] }.' });
      const r = this.post(by, drafts);
      if (!r.ok) return send(422, { rule: r.rule, reason: r.reason, index: r.index } satisfies Refusal);
      return send(200, { events: r.events });
    }
    if (url.pathname === ROUTES.presence && req.method === 'POST') {
      this.presence.push({ ...(body as PresenceUpdate), seq: this.state.seq });
      return send(200, { presence: body });
    }
    return send(404, { error: `There is no route ${url.pathname}.` });
  }
}

export const CH = 'ch1';

/** A board with one chapter and one note from the owner, `m1`. */
export async function noteBoard(): Promise<FakeBoard> {
  const b = await new FakeBoard().start();
  b.must('system', { type: 'board.open', name: 'demo' });
  b.must(
    'owner',
    { type: 'chapter.open', chapter: CH, title: 'Weekly notes' },
    { type: 'item.add', chapter: CH, item: { id: 'm1', kind: 'note', box: [0, 0, 200, 100], text: 'Turn my notes into a weekly summary' } },
  );
  return b;
}
