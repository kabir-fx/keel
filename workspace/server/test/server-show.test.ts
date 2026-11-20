import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Actor, BuildResult, BuilderContext, ServerMessage } from '@keel/protocol';
import { ROUTES } from '@keel/protocol';
import type { RunningServer, ServerOptions } from '../src/server';
import { SHOW_OPENED, SHOW_WAITS, startServer } from '../src/server';
import { readPrivate } from '../src/private';
import { CH, Client, call, raw, tempRepo, until } from './helpers';

/**
 * The server with a builder that hands over a show: the owner, and only the owner, learns its
 * address; it opens once; it is kept across a restart; and the board never takes it for itself.
 */

const FAKE = fileURLToPath(new URL('./fake-builder.mjs', import.meta.url));

interface Fake {
  ctx: BuilderContext;
  jobs: unknown[];
  finish(result?: BuildResult | Record<string, unknown>): void;
  post(drafts: unknown, as?: 'system' | 'agent'): Promise<unknown>;
}

let fakes: Fake[];
beforeAll(async () => {
  ({ fakes } = (await import(pathToFileURL(FAKE).href)) as { fakes: Fake[] });
});

const running: RunningServer[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of running.splice(0)) await s.close();
});

interface Started {
  s: RunningServer;
  fake: Fake;
  opened: string[];
  logged: string[];
}

async function start(opts: Partial<ServerOptions> & { open?: boolean } = {}): Promise<Started> {
  const { open = true, ...rest } = opts;
  const repoDir = rest.repoDir ?? tempRepo();
  const n = fakes.length;
  const opened: string[] = [];
  const logged: string[] = [];
  const s = await startServer({
    port: 0,
    appDir: path.join(repoDir, 'no-app'),
    log: (m) => logged.push(m),
    checkCommits: false,
    builder: FAKE,
    ...(open ? { openShow: (url: string) => opened.push(url) } : {}),
    ...rest,
    repoDir,
  });
  running.push(s);
  return { s, fake: fakes.length > n ? fakes.at(-1)! : (undefined as unknown as Fake), opened, logged };
}

const as =
  (s: RunningServer, by: Actor) =>
  (...drafts: unknown[]) => {
    const r = s.board.post(drafts, by);
    if (!r.ok) throw new Error(`${r.rule}: ${r.reason}`);
    return r.events;
  };

/** A folder the builder copied the built files to, inside its own private folder. */
function showFolder(fake: Fake, name = 'show-1', body = '<!doctype html><h1>Built</h1>'): string {
  const dir = path.join(fake.ctx.stateDir!, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), body);
  return dir;
}

/** Build the chapter from "Build this" to done, and end the run with this result. */
async function buildAll(s: RunningServer, fake: Fake, result: Record<string, unknown>): Promise<void> {
  const parts = ['door', 'bridge'];
  as(s, 'owner')({ type: 'chapter.open', chapter: CH, title: 'The idea' });
  as(s, 'agent')({ type: 'model.patch', chapter: CH, ops: [{ op: 'lane.set', lane: { id: 'main', name: 'Main' } }, ...parts.map((p) => ({ op: 'part.set', part: { id: p, name: `The ${p}`, lane: 'main' } }))] });
  as(s, 'owner')({ type: 'solidify', chapter: CH, picks: [], parts });
  as(s, 'owner')({ type: 'build.start', chapter: CH, track: parts, check: 'npm test' });
  await until(() => fake.jobs.length === 1);
  for (const part of parts) {
    await fake.post({ type: 'part.state', part, state: 'building' }, 'agent');
    await fake.post({ type: 'part.state', part, state: 'built', commit: 'abc1234', check: { cmd: 'npm test', passed: true } }, 'system');
  }
  fake.finish(result);
  await until(() => !s.builds.busy);
}

const feedTexts = (s: RunningServer) => s.board.state.feed.filter((f) => f.by === 'system' && f.kind === 'update').map((f) => f.text);
const settle = () => new Promise((r) => setTimeout(r, 50));
const connect = async (s: RunningServer, token: string, headers: Record<string, string> = {}) => {
  const c = await Client.connect(`ws://127.0.0.1:${s.port}${ROUTES.ws}?token=${token}`, headers);
  clients.push(c);
  return c;
};

describe('a finished build that has something to show', () => {
  it('is served from a port of its own, told to the owner only, opened once, and said in the feed with no address', async () => {
    const { s, fake, opened } = await start();
    const owner = await connect(s, s.tokens.owner);
    const agent = await connect(s, s.tokens.agent);
    const system = await connect(s, s.tokens.system);
    expect(owner.messages[0]).not.toHaveProperty('shows');
    expect(s.showOrigin()).toBeUndefined();

    const dir = showFolder(fake);
    await buildAll(s, fake, { outcome: 'done', show: { dir, page: 'index.html' } });
    await until(() => feedTexts(s).length === 1);

    const url = s.shows()[CH]!;
    const show = new URL(url);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[\w-]{32}\/first-idea\/index\.html$/);
    expect(Number(show.port)).not.toBe(s.port);
    expect(s.showOrigin()).toBe(show.origin);
    const page = await raw(Number(show.port), show.pathname);
    expect(page.status).toBe(200);
    expect(page.body).toBe('<!doctype html><h1>Built</h1>');

    // The owner's page hears it over the socket, and asks for it with the board's info.
    expect(await owner.next((m) => m.t === 'shows')).toEqual({ t: 'shows', shows: { [CH]: url } });
    expect((await call(s.origin, s.tokens.owner, ROUTES.board)).body.shows).toEqual({ [CH]: url });
    const late = await connect(s, s.tokens.owner);
    expect(late.messages[0]).toMatchObject({ t: 'init', shows: { [CH]: url } });

    // The agent and the system never learn it.
    for (const token of [s.tokens.agent, s.tokens.system]) {
      expect((await call(s.origin, token, ROUTES.board)).body).not.toHaveProperty('shows');
      const c = await connect(s, token);
      expect(c.messages[0]).not.toHaveProperty('shows');
    }
    await settle();
    for (const c of [agent, system]) {
      expect(c.messages.some((m: ServerMessage) => m.t === 'shows')).toBe(false);
      expect(JSON.stringify(c.messages)).not.toContain(show.pathname.split('/')[1]);
    }

    // Opened once, and the feed says so in plain words. The log holds no address and no key.
    expect(opened).toEqual([url]);
    expect(feedTexts(s)).toEqual([SHOW_OPENED]);
    const log = fs.readFileSync(s.board.logPath, 'utf8');
    expect(log).not.toContain(show.pathname.split('/')[1]);
    expect(log).not.toContain(String(show.port) + '/');
    expect(fs.readFileSync(path.join(s.board.dir, 'server.json'), 'utf8')).not.toContain(show.pathname.split('/')[1]);

    // Kept in the private file, by real path, and marked opened.
    expect(readPrivate(s.board.dir)?.shows).toEqual([{ chapter: CH, dir: fs.realpathSync(dir), page: 'index.html', at: expect.any(String), opened: true }]);
  });

  it('is refused by the board: a request from the show\'s origin gets nothing', async () => {
    const { s, fake } = await start();
    await buildAll(s, fake, { outcome: 'done', show: { dir: showFolder(fake), page: 'index.html' } });
    await until(() => s.showOrigin() !== undefined);
    const from = s.showOrigin()!;
    for (const route of [ROUTES.board, ROUTES.state, ROUTES.digest]) {
      const r = await call(s.origin, s.tokens.owner, route, { headers: { origin: from } });
      expect(r.status, route).toBe(403);
    }
    const post = await call(s.origin, s.tokens.owner, ROUTES.events, { method: 'POST', headers: { origin: from }, json: { drafts: [] } });
    expect(post.status).toBe(403);
    const local = await call(s.origin, s.tokens.owner, ROUTES.board, { headers: { origin: from.replace('127.0.0.1', 'localhost') } });
    expect(local.status).toBe(403);
    await expect(connect(s, s.tokens.owner, { origin: from })).rejects.toThrow(/403/);
  });

  it('says where to look when nothing opens it', async () => {
    const { s, fake, opened } = await start({ open: false });
    await buildAll(s, fake, { outcome: 'done', show: { dir: showFolder(fake), page: 'index.html' } });
    await until(() => feedTexts(s).length === 1);
    expect(feedTexts(s)).toEqual([SHOW_WAITS]);
    expect(opened).toEqual([]);
    expect(s.shows()[CH]).toBeDefined();
    expect(readPrivate(s.board.dir)?.shows?.[0]).not.toHaveProperty('opened');
  });

  it('refuses a show outside the builder\'s folder, or a page that is not one, with one log line and nothing shown', async () => {
    for (const bad of [
      (fake: Fake) => ({ dir: path.dirname(fake.ctx.repoDir), page: 'index.html' }),
      (fake: Fake) => ({ dir: showFolder(fake), page: '../index.html' }),
      (fake: Fake) => ({ dir: showFolder(fake), page: 'missing.html' }),
    ]) {
      const { s, fake, opened, logged } = await start();
      fs.writeFileSync(path.join(path.dirname(fake.ctx.repoDir), 'index.html'), 'not built here');
      await buildAll(s, fake, { outcome: 'done', show: bad(fake) });
      await until(() => logged.some((l) => /refused/.test(l)));
      await settle();
      expect(logged.filter((l) => /to show/.test(l))).toHaveLength(1);
      expect(s.shows()).toEqual({});
      expect(s.showOrigin()).toBeUndefined();
      expect(opened).toEqual([]);
      expect(feedTexts(s)).toEqual([]);
      expect(readPrivate(s.board.dir)?.shows).toBeUndefined();
      await s.close();
    }
  });

  it('has no address while the chapter is not built, and tells the owner so', async () => {
    const { s, fake } = await start();
    const owner = await connect(s, s.tokens.owner);
    await buildAll(s, fake, { outcome: 'done', show: { dir: showFolder(fake), page: 'index.html' } });
    await owner.next((m) => m.t === 'shows' && Object.keys(m.shows).length === 1);

    // The owner sends a built part back to an idea: the chapter is building again.
    as(s, 'owner')({ type: 'part.state', part: 'bridge', state: 'idea' });
    expect(s.board.state.chapters[CH]!.state).toBe('building');
    expect(await owner.next((m) => m.t === 'shows' && Object.keys(m.shows).length === 0)).toEqual({ t: 'shows', shows: {} });
    expect(s.shows()).toEqual({});
    expect((await call(s.origin, s.tokens.owner, ROUTES.board)).body).not.toHaveProperty('shows');
  });
});

describe('the shows across a restart', () => {
  it('serves the kept show again, on a new address, and does not open it again', async () => {
    const repoDir = tempRepo();
    const first = await start({ repoDir });
    await buildAll(first.s, first.fake, { outcome: 'done', show: { dir: showFolder(first.fake), page: 'index.html' } });
    await until(() => first.opened.length === 1);
    const before = new URL(first.s.shows()[CH]!);
    await first.s.close();
    await expect(raw(Number(before.port), before.pathname)).rejects.toThrow();

    const second = await start({ repoDir });
    const url = second.s.shows()[CH];
    expect(url).toBeDefined();
    const after = new URL(url!);
    // A new key for each start.
    expect(after.pathname.split('/')[1]).not.toBe(before.pathname.split('/')[1]);
    expect((await raw(Number(after.port), after.pathname)).body).toBe('<!doctype html><h1>Built</h1>');
    expect(second.opened).toEqual([]);
    expect(feedTexts(second.s)).toEqual([SHOW_OPENED]);
    const owner = await connect(second.s, second.s.tokens.owner);
    expect(owner.messages[0]).toMatchObject({ shows: { [CH]: url } });
  });

  it('drops a kept show whose folder or page is gone, or whose chapter is no longer built', async () => {
    const repoDir = tempRepo();
    const first = await start({ repoDir });
    const dir = showFolder(first.fake);
    await buildAll(first.s, first.fake, { outcome: 'done', show: { dir, page: 'index.html' } });
    await until(() => first.opened.length === 1);
    await first.s.close();

    fs.rmSync(path.join(dir, 'index.html'));
    const second = await start({ repoDir });
    expect(second.s.shows()).toEqual({});
    expect(second.s.showOrigin()).toBeUndefined();
    expect(readPrivate(second.s.board.dir)?.shows).toBeUndefined();
    await second.s.close();

    // A show kept for a chapter that is building again is dropped too.
    fs.writeFileSync(path.join(dir, 'index.html'), 'again');
    const third = await start({ repoDir, builder: 'none' });
    third.s.private.addShow({ chapter: CH, dir: fs.realpathSync(dir), page: 'index.html', at: new Date().toISOString() });
    as(third.s, 'owner')({ type: 'part.state', part: 'bridge', state: 'idea' });
    await third.s.close();
    const fourth = await start({ repoDir, builder: 'none' });
    expect(fourth.s.shows()).toEqual({});
    expect(readPrivate(fourth.s.board.dir)?.shows).toBeUndefined();
  });

  it('drops the shows when the log changed outside the board', async () => {
    const repoDir = tempRepo();
    const first = await start({ repoDir });
    await buildAll(first.s, first.fake, { outcome: 'done', show: { dir: showFolder(first.fake), page: 'index.html' } });
    await until(() => first.opened.length === 1);
    await first.s.close();
    expect(readPrivate(first.s.board.dir)?.shows).toHaveLength(1);

    // A pull, a checkout or an edit: the log is not as this machine's server left it.
    fs.appendFileSync(first.s.board.logPath, '\n');
    const second = await start({ repoDir });
    expect(second.s.board.state.chapters[CH]!.state).toBe('built');
    expect(second.s.shows()).toEqual({});
    expect(readPrivate(second.s.board.dir)?.shows).toBeUndefined();
  });
});
