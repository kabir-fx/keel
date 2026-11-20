import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import type { BoardEvent, LinkContext } from '@keel/protocol';
import { ROUTES, ServerFile } from '@keel/protocol';
import type { RunningServer, ServerOptions } from '../src/server';
import { startServer } from '../src/server';
import { BoardBusyError } from '../src/private';
import { CH, Client, call, chapter, note, tempRepo, until } from './helpers';

const running: RunningServer[] = [];
const clients: Client[] = [];

async function start(opts: Partial<ServerOptions> = {}): Promise<RunningServer> {
  const repoDir = opts.repoDir ?? tempRepo();
  const s = await startServer({
    port: 0,
    appDir: path.join(repoDir, 'no-app-here'),
    log: () => {},
    ...opts,
    repoDir,
  });
  running.push(s);
  return s;
}

async function connect(s: RunningServer, token: string, headers: Record<string, string> = {}): Promise<Client> {
  const c = await Client.connect(`ws://127.0.0.1:${s.port}${ROUTES.ws}?token=${token}`, headers);
  clients.push(c);
  return c;
}

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of running.splice(0)) await s.close();
});

describe('events', () => {
  it('sends an event posted over HTTP to every websocket client', async () => {
    const s = await start();
    const app = await connect(s, s.tokens.owner);
    const second = await connect(s, s.tokens.agent);
    expect(app.messages[0]).toMatchObject({ t: 'init', role: 'owner', name: 'demo' });
    expect(second.messages[0]).toMatchObject({ t: 'init', role: 'agent' });

    const r = await call(s.origin, s.tokens.owner, ROUTES.events, { method: 'POST', json: { drafts: [chapter(), note('m1', 'hello')] } });
    expect(r.status).toBe(200);
    expect(r.body.events.map((e: BoardEvent) => e.id)).toEqual(['e2', 'e3']);

    for (const c of [app, second]) {
      const got = await c.next((m) => m.t === 'event' && m.event.id === 'e3');
      expect(got).toMatchObject({ t: 'event', event: { by: 'owner', type: 'item.add', item: { id: 'm1' } } });
    }
    const after = await call(s.origin, s.tokens.agent, `${ROUTES.events}?after=2`);
    expect(after.body.events.map((e: BoardEvent) => e.id)).toEqual(['e3']);
  });

  it('answers a websocket post with the event to all, then ok to the sender', async () => {
    const s = await start();
    const app = await connect(s, s.tokens.owner);
    const other = await connect(s, s.tokens.system);
    app.send({ t: 'post', ref: 'r1', draft: chapter() });
    const ok = await app.next((m) => m.t === 'ok');
    expect(ok).toMatchObject({ t: 'ok', ref: 'r1', event: { id: 'e2', by: 'owner' } });
    const iEvent = app.messages.findIndex((m) => m.t === 'event' && m.event.id === 'e2');
    expect(iEvent).toBeGreaterThan(0);
    expect(iEvent).toBeLessThan(app.messages.indexOf(ok));
    await other.next((m) => m.t === 'event' && m.event.id === 'e2');

    app.send({ t: 'post', ref: 'r2', draft: { ...note('m1', 'x'), chapter: 'nowhere' } });
    expect(await app.next((m) => m.t === 'refused')).toMatchObject({ ref: 'r2', rule: 'R7' });
    app.send({ t: 'ping' });
    await app.next((m) => m.t === 'pong');
  });

  it('refuses a bad event with its rule and leaves the log as it was', async () => {
    const s = await start();
    await call(s.origin, s.tokens.owner, ROUTES.events, { method: 'POST', json: { drafts: [chapter()] } });
    const log = s.board.logPath;
    const before = fs.readFileSync(log, 'utf8');

    const missing = await call(s.origin, s.tokens.owner, ROUTES.events, {
      method: 'POST',
      json: { drafts: [note('m1', 'fine'), { ...note('m2', 'lost'), chapter: 'nowhere' }] },
    });
    expect(missing.status).toBe(422);
    expect(missing.body).toMatchObject({ rule: 'R7', index: 1 });
    expect(missing.body.reason).toMatch(/nowhere/);

    const reused = await call(s.origin, s.tokens.owner, ROUTES.events, { method: 'POST', json: { drafts: [chapter()] } });
    expect(reused.body).toMatchObject({ rule: 'R4' });

    const shape = await call(s.origin, s.tokens.owner, ROUTES.events, { method: 'POST', json: { drafts: [{ type: 'nonsense' }] } });
    expect(shape.body).toMatchObject({ rule: 'shape' });

    const notJson = await call(s.origin, s.tokens.owner, ROUTES.events, { method: 'POST', body: '{"drafts": [', headers: { 'content-type': 'application/json' } });
    expect(notJson.status).toBe(400);

    expect(fs.readFileSync(log, 'utf8')).toBe(before);
    expect(s.board.state.seq).toBe(2);
  });

  it('takes the actor from the token: the agent cannot solidify, whatever the draft says', async () => {
    const s = await start();
    await call(s.origin, s.tokens.owner, ROUTES.events, { method: 'POST', json: { drafts: [chapter()] } });
    const before = fs.readFileSync(s.board.logPath, 'utf8');

    const solidify = { type: 'solidify', chapter: CH, picks: [], parts: [], by: 'owner' };
    const asAgent = await call(s.origin, s.tokens.agent, ROUTES.events, { method: 'POST', json: { drafts: [solidify] } });
    expect(asAgent.status).toBe(422);
    expect(asAgent.body.rule).toBe('R6');

    const markAsAgent = await call(s.origin, s.tokens.agent, ROUTES.events, { method: 'POST', json: { drafts: [{ ...note('m1', 'mine'), by: 'owner' }] } });
    expect(markAsAgent.body.rule).toBe('R6');
    expect(fs.readFileSync(s.board.logPath, 'utf8')).toBe(before);

    const asOwner = await call(s.origin, s.tokens.owner, ROUTES.events, { method: 'POST', json: { drafts: [{ ...solidify, by: 'agent' }] } });
    expect(asOwner.status).toBe(200);
    expect(asOwner.body.events[0]).toMatchObject({ type: 'solidify', by: 'owner' });
  });

  it('reads back the same state after a restart', async () => {
    const repoDir = tempRepo();
    const a = await start({ repoDir });
    await call(a.origin, a.tokens.owner, ROUTES.events, { method: 'POST', json: { drafts: [chapter(), note('m1', 'kept')] } });
    const before = (await call(a.origin, a.tokens.agent, ROUTES.state)).body;
    await a.close();
    expect(fs.existsSync(path.join(repoDir, '.keel/board/server.json'))).toBe(false);

    const b = await start({ repoDir });
    // Every token is new for each start, the owner's too: one from the run before opens nothing.
    expect(b.tokens.owner).not.toBe(a.tokens.owner);
    expect(b.tokens.agent).not.toBe(a.tokens.agent);
    expect((await call(b.origin, a.tokens.owner, ROUTES.board)).status).toBe(401);
    const after = (await call(b.origin, b.tokens.agent, ROUTES.state)).body;
    expect(after).toEqual(before);
    expect(after.items.m1.item.text).toBe('kept');
  });

  it('opens a board with a broken line, and says so', async () => {
    const repoDir = tempRepo();
    const a = await start({ repoDir });
    await call(a.origin, a.tokens.owner, ROUTES.events, { method: 'POST', json: { drafts: [chapter()] } });
    await a.close();
    fs.appendFileSync(path.join(repoDir, '.keel/board/log.jsonl'), 'this is not an event\n');

    const said: string[] = [];
    const b = await start({ repoDir, log: (m) => said.push(m) });
    expect(said.some((m) => /line 3 was skipped/.test(m))).toBe(true);
    const r = await call(b.origin, b.tokens.owner, ROUTES.events, { method: 'POST', json: { drafts: [note('m1', 'still works')] } });
    expect(r.body.events[0].id).toBe('e3');
  });

  it('serves the digest, the state and the board info', async () => {
    const s = await start();
    await call(s.origin, s.tokens.owner, ROUTES.events, { method: 'POST', json: { drafts: [chapter(), note('m1', 'one engine')] } });
    const d = await call(s.origin, s.tokens.agent, `${ROUTES.digest}?since=0`);
    expect(d.body.digest.open).toHaveLength(1);
    expect(d.body.text).toMatch(/1 open/);
    const info = await call(s.origin, s.tokens.owner, ROUTES.board);
    expect(info.body).toMatchObject({ name: 'demo', seq: 3, role: 'owner', open: 1, link: 'none', presence: { state: 'away' } });
  });
});

describe('the token, the origin and the files', () => {
  it('needs a token', async () => {
    const s = await start();
    expect((await call(s.origin, undefined, ROUTES.board)).status).toBe(401);
    expect((await call(s.origin, 'wrong', ROUTES.board)).status).toBe(401);
    expect((await call(s.origin, undefined, `${ROUTES.board}?token=${s.tokens.agent}`)).body.role).toBe('agent');
    await expect(Client.connect(`ws://127.0.0.1:${s.port}${ROUTES.ws}`)).rejects.toThrow(/401/);
  });

  it('refuses a browser request from another origin', async () => {
    const s = await start({ devOrigin: 'http://localhost:5173' });
    const from = (origin: string) => call(s.origin, s.tokens.owner, ROUTES.board, { headers: { origin } });
    expect((await from('http://evil.example')).status).toBe(403);
    expect((await from('null')).status).toBe(403);
    expect((await from(`http://127.0.0.1:${s.port + 1}`)).status).toBe(403);
    expect((await from(s.origin)).status).toBe(200);
    expect((await from(`http://localhost:${s.port}`)).status).toBe(200);
    const dev = await from('http://localhost:5173');
    expect(dev.status).toBe(200);
    expect(dev.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect((await from(s.origin)).headers.get('access-control-allow-origin')).toBeNull();

    await expect(connect(s, s.tokens.owner, { origin: 'http://evil.example' })).rejects.toThrow(/403/);
    await connect(s, s.tokens.owner, { origin: s.origin });
  });

  it('cleans asset names, keeps them unique, and never reads outside assets/', async () => {
    const s = await start();
    const up = (name: string, bytes: string) =>
      call(s.origin, s.tokens.owner, `${ROUTES.assets}?name=${encodeURIComponent(name)}`, { method: 'POST', body: bytes });

    const a = await up('../../my sketch (1).png', 'PNG1');
    expect(a.body).toEqual({ asset: 'assets/my-sketch-1.png' });
    const b = await up('../../my sketch (1).png', 'PNG2');
    expect(b.body).toEqual({ asset: 'assets/my-sketch-1-2.png' });
    expect(fs.readFileSync(path.join(s.board.assetsDir, 'my-sketch-1.png'), 'utf8')).toBe('PNG1');
    expect(fs.readdirSync(path.dirname(s.board.dir)).sort()).toEqual(['board']);
    expect((await up('..', 'x')).body).toEqual({ asset: 'assets/file' });

    const got = await call(s.origin, s.tokens.owner, `${ROUTES.assets}/my-sketch-1-2.png`);
    expect(got.status).toBe(200);
    expect(got.body).toBe('PNG2');
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(got.headers.get('content-security-policy')).toMatch(/sandbox/);

    for (const bad of ['..%2Flog.jsonl', '%2e%2e%2f%2e%2e%2fserver.json', '.hidden', 'a%2Fb', 'a%5C..%5Clog.jsonl', 'a%00b']) {
      const r = await call(s.origin, s.tokens.owner, `${ROUTES.assets}/${bad}`);
      expect(r.status, bad).toBe(400);
    }
    // A raw request, so no client tidies the dots first.
    const raw = await rawGet(s.port, `${ROUTES.assets}/../log.jsonl?token=${s.tokens.owner}`);
    expect(raw.status).not.toBe(200);
    expect(raw.body).not.toMatch(/board\.open/);

    // A link inside assets/ that points out of it is not followed.
    fs.symlinkSync(s.board.logPath, path.join(s.board.assetsDir, 'link.txt'));
    expect((await call(s.origin, s.tokens.owner, `${ROUTES.assets}/link.txt`)).status).toBe(404);
    expect((await call(s.origin, s.tokens.owner, `${ROUTES.assets}/missing.png`)).status).toBe(404);
  });

  it('refuses a body over the limit', async () => {
    const s = await start();
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: s.port,
        method: 'POST',
        path: `${ROUTES.assets}?name=big.bin`,
        headers: { authorization: `Bearer ${s.tokens.owner}`, 'content-length': String(21 * 1024 * 1024) },
      });
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.flushHeaders();
    });
    expect(status).toBe(413);
    expect(fs.readdirSync(s.board.assetsDir)).toEqual([]);
  });

  it('writes server.json with mode 0600, ignores it in git, and removes it on close', async () => {
    const repoDir = tempRepo();
    const s = await start({ repoDir });
    const file = path.join(repoDir, '.keel/board/server.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const text = fs.readFileSync(file, 'utf8');
    const parsed = ServerFile.parse(JSON.parse(text));
    expect(parsed).toEqual({ pid: process.pid, port: s.port, startedAt: expect.any(String) });
    // No token is written in the repository: a check the builder runs could read it there.
    for (const t of Object.values(s.tokens)) expect(text).not.toContain(t);
    expect(fs.readFileSync(path.join(repoDir, '.keel/board/.gitignore'), 'utf8')).toBe('server.json\nagent.json\n');

    await expect(start({ repoDir })).rejects.toBeInstanceOf(BoardBusyError);
    await s.close();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('replaces a server.json whose process is gone', async () => {
    const repoDir = tempRepo();
    const dead = spawnSync(process.execPath, ['-e', '']).pid!;
    fs.mkdirSync(path.join(repoDir, '.keel/board'), { recursive: true });
    const stale = { pid: dead, port: 1, startedAt: 'then' };
    fs.writeFileSync(path.join(repoDir, '.keel/board/server.json'), JSON.stringify(stale));
    const s = await start({ repoDir });
    expect(JSON.parse(fs.readFileSync(path.join(repoDir, '.keel/board/server.json'), 'utf8')).pid).toBe(process.pid);
    expect(s.port).not.toBe(1);
  });

  it('serves the app, falls back to index.html, and says how to build it when it is missing', async () => {
    const repoDir = tempRepo();
    const appDir = path.join(repoDir, 'dist');
    const s1 = await start({ repoDir });
    const missing = await call(s1.origin, undefined, `/?token=${s1.tokens.owner}`);
    expect(missing.status).toBe(200);
    expect(missing.body).toMatch(/npm run build -w @keel\/board-app/);
    await s1.close();

    fs.mkdirSync(path.join(appDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'index.html'), '<!doctype html><title>app</title>');
    fs.writeFileSync(path.join(appDir, 'assets', 'main.js'), 'console.log(1)');
    const s = await start({ repoDir, appDir });
    const t = `?token=${s.tokens.owner}`;
    expect((await call(s.origin, undefined, `/${t}`)).body).toMatch(/<title>app/);
    expect((await call(s.origin, undefined, `/story/engine-loop${t}`)).body).toMatch(/<title>app/);
    const js = await call(s.origin, undefined, '/assets/main.js');
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    expect((await call(s.origin, undefined, '/assets/gone.js')).status).toBe(404);
    const up = await rawGet(s.port, '/..%2f..%2fdemo%2f.keel%2fboard%2flog.jsonl');
    expect(up.status).toBe(404);
    expect((await call(s.origin, undefined, '/api/nothing')).status).toBe(401);
    expect((await call(s.origin, s.tokens.owner, '/api/nothing')).status).toBe(404);
  });
});

describe('presence', () => {
  it('is away with no link, changes on the agent\'s word, and reaches the app', async () => {
    const s = await start();
    const app = await connect(s, s.tokens.owner);
    expect(app.messages[0]).toMatchObject({ t: 'init', presence: { state: 'away' } });

    const r = await call(s.origin, s.tokens.agent, ROUTES.presence, { method: 'POST', json: { state: 'drawing', note: 'three approaches' } });
    expect(r.status).toBe(200);
    const p = await app.next((m) => m.t === 'presence');
    expect(p).toMatchObject({ presence: { state: 'drawing', note: 'three approaches' } });

    expect((await call(s.origin, s.tokens.owner, ROUTES.presence, { method: 'POST', json: { state: 'listening' } })).status).toBe(403);
    expect((await call(s.origin, s.tokens.agent, ROUTES.presence, { method: 'POST', json: { state: 'dancing' } })).status).toBe(400);
  });
});

describe('the script link', () => {
  it('wakes the script after a pause, and its answer closes the mark', async () => {
    const repoDir = tempRepo();
    const script = path.join(path.dirname(repoDir), 'agent.mjs');
    fs.writeFileSync(
      script,
      `export async function answer(wake, post) {
        const ids = wake.digest.open.map((o) => o.id);
        if (ids.length) {
          const r = await post({ type: 'answer', answers: ids, read: 'Read ' + ids.join(' ') });
          if (!r.ok) throw new Error(r.reason);
        }
      }\n`,
    );
    const s = await start({ repoDir, link: `script:${script}` });
    expect(s.linkName).toBe('script:agent.mjs');
    expect(s.presence.get().state).toBe('listening');

    await call(s.origin, s.tokens.owner, ROUTES.events, { method: 'POST', json: { drafts: [chapter(), note('m1', 'answer me')] } });
    await until(() => s.board.state.answered.m1 !== undefined);
    expect(s.scheduler?.wakes).toBe(1);
    const last = s.board.events.at(-1)!;
    expect(last).toMatchObject({ type: 'answer', by: 'agent', answers: ['m1'] });
  });
});

describe('a link module', () => {
  it('loads createLink with the context and options, and wakes it', async () => {
    const repoDir = tempRepo();
    const mod = path.join(path.dirname(repoDir), 'my-link.mjs');
    fs.writeFileSync(
      mod,
      `export const seen = { wakes: [] };
      export function createLink(ctx) {
        seen.ctx = ctx;
        ctx.presence({ state: 'waiting', note: 'ready' });
        return { name: 'my-link', async wake(w) { seen.wakes.push(w.reason); return { ok: true }; }, async close() { seen.closed = true; } };
      }\n`,
    );
    const s = await start({ repoDir, link: mod, linkOptions: { model: 'sonnet' } });
    const { seen } = (await import(pathToFileURL(mod).href)) as { seen: { ctx: LinkContext; wakes: string[]; closed?: boolean } };
    expect(s.linkName).toBe('my-link');
    expect(seen.ctx).toMatchObject({ repoDir, boardDir: s.board.dir, serverUrl: s.origin, agentToken: s.tokens.agent, options: { model: 'sonnet' } });
    // The link's own folder is private and outside the repository.
    expect(seen.ctx.stateDir).toBe(path.join(s.stateDir, 'link'));
    expect(fs.statSync(seen.ctx.stateDir!).mode & 0o777).toBe(0o700);
    expect(path.relative(repoDir, seen.ctx.stateDir!).startsWith('..')).toBe(true);
    // What the link said while it started stands.
    expect(s.presence.get()).toMatchObject({ state: 'waiting', note: 'ready' });

    await call(s.origin, s.tokens.owner, ROUTES.events, { method: 'POST', json: { drafts: [chapter(), note('m1', 'hi')] } });
    await until(() => seen.wakes.length === 1);
    await s.close();
    expect(seen.closed).toBe(true);
  });

  it('fails to start, and frees the board, when the module has no createLink', async () => {
    const repoDir = tempRepo();
    const mod = path.join(path.dirname(repoDir), 'not-a-link.mjs');
    fs.writeFileSync(mod, 'export const nothing = 1;\n');
    await expect(start({ repoDir, link: mod })).rejects.toThrow(/does not export createLink/);
    expect(fs.existsSync(path.join(repoDir, '.keel/board/server.json'))).toBe(false);
    await expect(start({ repoDir, link: 'no-such-package-anywhere' })).rejects.toThrow(/Cannot find the link module/);
  });
});

function rawGet(port: number, route: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: route }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
