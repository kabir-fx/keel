import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrivateBoardFile, ROUTES, ServerFile, privateBoardKey } from '@keel/protocol';
import { Board } from '../src/board';
import type { Io, RunResult } from '../src/cli';
import { run } from '../src/cli';
import { readPrivate } from '../src/private';
import type { RunningServer, ServerOptions } from '../src/server';
import { startServer } from '../src/server';
import { readServerFile } from '../src/serverfile';
import { CH, Client, STATE_ROOT, call, chapter, note, raw, tempRepo, until, own } from './helpers';

const running: RunningServer[] = [];
const clients: Client[] = [];
const others: http.Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of clients.splice(0)) c.close();
  for (const s of running.splice(0)) await s.close();
  for (const o of others.splice(0)) await new Promise((r) => o.close(r));
});

async function start(opts: Partial<ServerOptions> = {}): Promise<RunningServer> {
  const repoDir = opts.repoDir ?? tempRepo();
  const s = await startServer({ port: 0, appDir: path.join(repoDir, 'no-app-here'), log: () => {}, ...opts, repoDir });
  running.push(s);
  return s;
}

async function cli(...argv: string[]): Promise<RunResult & { out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l), stdin: async () => '' };
  const r = await run(argv, io);
  if (r.server) running.push(r.server);
  return { ...r, out, err };
}

/** An HTTP server on a free port that is not a board server. */
async function foreign(handler: http.RequestListener): Promise<{ port: number; seen: string[] }> {
  const seen: string[] = [];
  const srv = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  others.push(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { port: (srv.address() as AddressInfo).port, seen };
}

/** Every file under `dir`, as text. */
function allText(dir: string): string {
  let text = '';
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) text += fs.readFileSync(path.join(e.parentPath, e.name), 'utf8');
  }
  return text;
}

const appDirWithPage = (repoDir: string) => {
  const appDir = path.join(path.dirname(repoDir), 'app-dist');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'index.html'), '<!doctype html><title>app</title>');
  return appDir;
};

/* ------------------------------------------------------------------ 1 */

describe('1. the owner\'s token rests outside the repository', () => {
  it('keeps it in a private folder, and a restart keeps the same token and port', async () => {
    const repoDir = tempRepo();
    const a = await start({ repoDir, port: undefined });
    const st = fs.statSync(path.join(repoDir, '.keel/board'), { bigint: true });
    expect(path.relative(STATE_ROOT, a.stateDir)).toBe(`boards/${privateBoardKey(st.dev, st.ino)}`);
    expect(fs.statSync(a.stateDir).mode & 0o777).toBe(0o700);
    const priv = path.join(a.stateDir, 'board.json');
    expect(fs.statSync(priv).mode & 0o777).toBe(0o600);
    const running = { pid: process.pid, ownerToken: a.tokens.owner, agentToken: a.tokens.agent, systemToken: a.tokens.system, startedAt: a.file.startedAt };
    // The seal of the log as this server wrote it: its size and the SHA-256 of its bytes.
    const logBytes = fs.readFileSync(path.join(repoDir, '.keel/board/log.jsonl'));
    expect(PrivateBoardFile.parse(JSON.parse(fs.readFileSync(priv, 'utf8')))).toEqual({
      boardDir: fs.realpathSync.native(path.join(repoDir, '.keel/board')),
      boardKey: expect.stringMatching(/^[\w-]{32}$/),
      port: a.port,
      running,
      log: { bytes: logBytes.length, sha256: crypto.createHash('sha256').update(logBytes).digest('hex') },
    });
    // No token of any kind rests inside the repository.
    for (const t of Object.values(a.tokens)) expect(allText(repoDir)).not.toContain(t);
    await a.close();
    // The running server's tokens leave with it.
    expect(JSON.parse(fs.readFileSync(priv, 'utf8')).running).toBeUndefined();

    // The board's own key stays, the port stays, and every token is new.
    const key = JSON.parse(fs.readFileSync(priv, 'utf8')).boardKey;
    const b = await start({ repoDir, port: undefined });
    expect(b.port).toBe(a.port);
    expect(JSON.parse(fs.readFileSync(priv, 'utf8')).boardKey).toBe(key);
    expect(b.tokens.owner).not.toBe(a.tokens.owner);
    expect(b.url).not.toBe(a.url);
    // A tab left open from the run before holds a token that opens nothing now: over HTTP, and over the websocket.
    expect((await raw(b.port, ROUTES.board, { headers: { authorization: `Bearer ${a.tokens.owner}` } })).status).toBe(401);
    await expect(Client.connect(`ws://127.0.0.1:${b.port}${ROUTES.ws}?token=${a.tokens.owner}`)).rejects.toThrow(/401/);
    // The board's key is no token either.
    expect((await raw(b.port, ROUTES.board, { headers: { authorization: `Bearer ${key}` } })).status).toBe(401);
    const tab = await Client.connect(`ws://127.0.0.1:${b.port}${ROUTES.ws}?token=${b.tokens.owner}`);
    clients.push(tab);
    expect(tab.messages[0]).toMatchObject({ t: 'init', role: 'owner' });
  });

  it('the printed address holds a code that works once and for five minutes, and no token', async () => {
    let clock = Date.parse('2026-11-18T10:00:00Z');
    const s = await start({ now: () => new Date(clock) });
    const trade = (code: unknown) => call(s.origin, undefined, ROUTES.session, { method: 'POST', json: { code } });
    const codeOf = (url: string) => new URL(url).searchParams.get('code')!;
    expect(s.url).toBe(`${s.origin}/?code=${codeOf(s.url)}`);
    for (const t of Object.values(s.tokens)) expect(s.url).not.toContain(t);
    // A wrong code, an empty one, and none at all.
    for (const bad of ['nope', '', undefined, 7, 'x'.repeat(300)]) expect((await trade(bad)).status).toBe(401);
    // The code from the address: once.
    const first = await trade(codeOf(s.url));
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ token: s.tokens.owner, role: 'owner' });
    expect((await trade(codeOf(s.url))).status).toBe(401);
    // A fresh one works, until it is five minutes old.
    const fresh = codeOf(s.link());
    const stale = codeOf(s.link());
    expect((await trade(fresh)).status).toBe(200);
    clock += 5 * 60_000 + 1;
    expect((await trade(stale)).status).toBe(401);
    // Only the system asks for a new address, and only by POST.
    expect((await call(s.origin, s.tokens.owner, ROUTES.link, { method: 'POST' })).status).toBe(403);
    expect((await call(s.origin, s.tokens.agent, ROUTES.link, { method: 'POST' })).status).toBe(403);
    expect((await call(s.origin, undefined, ROUTES.link, { method: 'POST' })).status).toBe(401);
    const made = await call(s.origin, s.tokens.system, ROUTES.link, { method: 'POST' });
    expect((await trade(codeOf(made.body.url))).body).toEqual({ token: s.tokens.owner, role: 'owner' });
    // A page from another origin cannot trade a code it found.
    const other = await call(s.origin, undefined, ROUTES.session, { method: 'POST', json: { code: codeOf(s.link()) }, headers: { origin: 'http://evil.example' } });
    expect(other.status).toBe(403);
  });

  it('moves to another port when its port is taken, and says so', async () => {
    const repoDir = tempRepo();
    const a = await start({ repoDir, port: undefined });
    const p = a.port;
    await a.close();
    const blocker = http.createServer();
    others.push(blocker);
    await new Promise<void>((r) => blocker.listen(p, '127.0.0.1', r));

    const said: string[] = [];
    const b = await start({ repoDir, port: undefined, log: (m) => said.push(m) });
    expect(b.port).not.toBe(p);
    expect(said.join('\n')).toContain(`port ${p} is taken, so the board moved to port ${b.port}`);
    expect(readPrivate(b.board.dir)?.port).toBe(b.port);
    await b.close();
    await expect(start({ repoDir, port: p })).rejects.toThrow(`Port ${p} is taken`);
  });

  it('prints no token in status, and open prints the address from the private folder', async () => {
    const repo = tempRepo();
    const first = await cli('open', repo, '--no-browser', '--app-dir', path.join(repo, 'no-app'));
    const s = first.server!;
    const status = await cli('status', repo);
    expect(status.code).toBe(0);
    expect(status.out.join('\n')).not.toContain(s.tokens.owner);
    expect(status.out.join('\n')).not.toContain('token=');
    expect(status.out.join('\n')).not.toContain('code=');
    const again = await cli('open', repo, '--no-browser');
    // A fresh address, asked of the running server: a new code, never a token.
    expect(again.out).toHaveLength(1);
    expect(again.out[0]).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${s.port}/\\?code=[\\w-]{32}$`));
    expect(again.out[0]).not.toBe(s.url);
    expect(again.out[0]).not.toContain(s.tokens.owner);
  });
});

/* ------------------------------------------------------------------ 2 */

describe('2. no cookie: the token, and the headers', () => {
  it('sets no cookie, refuses a request that has only a cookie, and serves the shell with no token', async () => {
    const repoDir = tempRepo();
    const s = await start({ repoDir, appDir: appDirWithPage(repoDir) });
    const name = `keel_board_${s.port}`;

    const first = await raw(s.port, `/?token=${s.tokens.owner}`);
    expect(first.status).toBe(200);
    expect(first.body).toMatch(/<title>app/);
    expect(first.headers['set-cookie']).toBeUndefined();
    // The shell and its files hold nothing: they need no token.
    const bare = await raw(s.port, '/');
    expect(bare.status).toBe(200);
    expect(bare.body).toMatch(/<title>app/);
    expect((await raw(s.port, '/story/engine-loop')).body).toMatch(/<title>app/);
    fs.mkdirSync(path.join(path.dirname(repoDir), 'app-dist', 'assets'));
    fs.writeFileSync(path.join(path.dirname(repoDir), 'app-dist', 'assets', 'main.js'), '1');
    expect((await raw(s.port, '/assets/main.js')).status).toBe(200);

    // Every route and the websocket need the token. A cookie, even the owner's token in one, is nothing.
    const cookie = `${name}=${s.tokens.owner}`;
    for (const site of [undefined, 'same-origin', 'none']) {
      const headers: Record<string, string> = { cookie, origin: s.origin, ...(site ? { 'sec-fetch-site': site } : {}) };
      expect((await raw(s.port, ROUTES.board, { headers })).status, site).toBe(401);
      expect((await raw(s.port, ROUTES.events, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ drafts: [chapter()] }) })).status, site).toBe(401);
    }
    await expect(Client.connect(`ws://127.0.0.1:${s.port}${ROUTES.ws}`, { cookie, origin: s.origin })).rejects.toThrow(/401/);
    expect(s.board.state.seq).toBe(1);
    expect(JSON.parse((await raw(s.port, `${ROUTES.board}?token=${s.tokens.owner}`)).body).role).toBe('owner');
    const ws = await Client.connect(`ws://127.0.0.1:${s.port}${ROUTES.ws}`, { authorization: `Bearer ${s.tokens.owner}`, origin: s.origin });
    clients.push(ws);
    expect(ws.messages[0]).toMatchObject({ t: 'init', role: 'owner' });
  });

  it('puts the security headers on every response, and keeps the sandbox on a dropped file', async () => {
    const repoDir = tempRepo();
    const s = await start({ repoDir, appDir: appDirWithPage(repoDir) });
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      `connect-src 'self' ws://127.0.0.1:${s.port} ws://localhost:${s.port}`,
      'frame-src http://127.0.0.1:*',
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'none'",
    ].join('; ');
    const up = await call(s.origin, s.tokens.owner, `${ROUTES.assets}?name=a.png`, { method: 'POST', body: 'PNG' });
    expect(up.status).toBe(200);
    const auth = { authorization: `Bearer ${s.tokens.owner}` };
    const cases: Array<[string, Record<string, string>]> = [
      ['/', {}],
      ['/no-such.js', {}],
      [ROUTES.board, {}],
      [ROUTES.board, auth],
      [`${ROUTES.items}?ids=nope`, auth],
    ];
    for (const [route, headers] of cases) {
      const r = await raw(s.port, route, { headers });
      expect(r.headers['content-security-policy'], route).toBe(csp);
      expect(r.headers['x-content-type-options'], route).toBe('nosniff');
      expect(r.headers['referrer-policy'], route).toBe('no-referrer');
      expect(r.headers['cross-origin-resource-policy'], route).toBe('same-origin');
    }
    const file = await raw(s.port, `${ROUTES.assets}/a.png`, { headers: auth });
    expect(file.headers['content-security-policy']).toBe("default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
    expect(file.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
  });
});

/* ------------------------------------------------------------------ 3 */

describe('3. server.json is a hint, never a fact', () => {
  it('a forged server.json (pid 1, a foreign port) neither blocks open nor gets a signal from stop', async () => {
    const repo = tempRepo();
    // A board server ran here once, so the board has a private folder and an owner's token.
    const first = await cli('open', repo, '--no-browser');
    await first.server!.close();
    running.splice(0);

    // Something else listens on another port, and says yes to anything.
    const other = await foreign((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'mine', seq: 1, role: 'system', open: 0 }));
    });
    const file = path.join(repo, '.keel/board/server.json');
    const forged = { pid: 1, port: other.port, startedAt: '2026-11-17T00:00:00Z' };
    fs.writeFileSync(file, JSON.stringify(forged));
    const kill = vi.spyOn(process, 'kill');

    const stopped = await cli('stop', repo);
    expect(stopped.code).toBe(0);
    expect(stopped.out).toEqual(['No board server runs for this board. Removed a stale server.json.']);
    expect(fs.existsSync(file)).toBe(false);
    expect(other.seen.some((r) => r.startsWith('POST'))).toBe(false);

    fs.writeFileSync(file, JSON.stringify(forged));
    const opened = await cli('open', repo, '--no-browser');
    expect(opened.code).toBe(0);
    expect(opened.server).toBeDefined();
    expect(opened.out).toEqual([opened.server!.url]);
    expect(readServerFile(path.join(repo, '.keel/board'))).toMatchObject({ pid: process.pid, port: opened.server!.port });
    // The owner's address went only to the board's own server.
    expect(other.seen.join('\n')).not.toContain(opened.server!.tokens.owner);

    // The real server stops over HTTP, in this same process.
    const stop = await cli('stop', repo);
    expect(stop.out).toEqual([`Stopped the board server on port ${opened.server!.port}.`]);
    await opened.server!.closed;
    expect(fs.existsSync(file)).toBe(false);
    // Nothing was signalled: at most a pid from the private lock was asked whether it lives.
    expect(kill.mock.calls.filter(([pid, signal]) => pid === 1 || (signal !== undefined && signal !== 0))).toEqual([]);
  });

  it('stops only for the system token', async () => {
    const s = await start();
    expect((await call(s.origin, s.tokens.owner, ROUTES.stop, { method: 'POST' })).status).toBe(403);
    expect((await call(s.origin, s.tokens.agent, ROUTES.stop, { method: 'POST' })).status).toBe(403);
    expect((await call(s.origin, s.tokens.system, ROUTES.stop)).status).toBe(405);
    const r = await call(s.origin, s.tokens.system, ROUTES.stop, { method: 'POST' });
    expect(r.body).toEqual({ stopping: true });
    await s.closed;
  });
});

/* ------------------------------------------------------------------ 4 */

describe('4. symbolic links', () => {
  const cases = [
    ['.keel', 'folder'],
    ['.keel/board', 'folder'],
    ['.keel/board/assets', 'folder'],
    ['.keel/board/log.jsonl', 'file'],
    ['.keel/board/.gitignore', 'file'],
  ] as const;

  for (const [rel, kind] of cases) {
    it(`refuses to open a board when ${rel} is a symbolic link`, async () => {
      const repo = tempRepo();
      const outside = path.join(path.dirname(repo), 'outside');
      if (kind === 'folder') fs.mkdirSync(outside);
      else fs.writeFileSync(outside, 'not yours\n');
      fs.mkdirSync(path.join(repo, path.dirname(rel)), { recursive: true });
      if (rel !== '.keel' && rel !== '.keel/board') fs.mkdirSync(path.join(repo, '.keel/board'), { recursive: true });
      fs.symlinkSync(outside, path.join(repo, rel));

      expect(() => Board.open(repo)).toThrow(`${rel} is a symbolic link`);
      await expect(start({ repoDir: repo })).rejects.toThrow(`${rel} is a symbolic link`);
      const r = await cli('open', repo, '--no-browser');
      expect(r.code).toBe(1);
      expect(r.err.join('\n')).toContain(`${rel} is a symbolic link, so the board will not open`);
      if (kind === 'folder') expect(fs.readdirSync(outside)).toEqual([]);
      else expect(fs.readFileSync(outside, 'utf8')).toBe('not yours\n');
    });
  }

  it('reads and writes assets only inside the real assets folder', async () => {
    const s = await start();
    const outside = path.join(path.dirname(s.board.repoDir), 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.png'), 'SECRET');
    // A link planted at a name is neither read nor written through.
    fs.symlinkSync(path.join(outside, 'secret.png'), path.join(s.board.assetsDir, 'planted.png'));
    expect((await call(s.origin, s.tokens.owner, `${ROUTES.assets}/planted.png`)).status).toBe(404);
    const up = await call(s.origin, s.tokens.owner, `${ROUTES.assets}?name=planted.png`, { method: 'POST', body: 'NEW' });
    expect(up.body).toEqual({ asset: 'assets/planted-2.png' });
    expect(fs.readFileSync(path.join(outside, 'secret.png'), 'utf8')).toBe('SECRET');
    // A hard link would make a file elsewhere look local.
    fs.linkSync(path.join(outside, 'secret.png'), path.join(s.board.assetsDir, 'hard.png'));
    expect((await call(s.origin, s.tokens.owner, `${ROUTES.assets}/hard.png`)).status).toBe(404);

    // The folder swapped for a link while the server runs: nothing is read or written.
    fs.renameSync(s.board.assetsDir, `${s.board.assetsDir}-old`);
    fs.symlinkSync(outside, s.board.assetsDir);
    expect((await call(s.origin, s.tokens.owner, `${ROUTES.assets}/secret.png`)).status).toBe(404);
    const write = await call(s.origin, s.tokens.owner, `${ROUTES.assets}?name=x.png`, { method: 'POST', body: 'X' });
    expect(write.status).toBe(409);
    expect(fs.readdirSync(outside).sort()).toEqual(['secret.png']);
  });
});

/* ------------------------------------------------------------------ 5 */

describe('5. the log on load', () => {
  const at = '2026-11-17T13:00:00.000Z';

  function threeEvents(): string {
    const repo = tempRepo();
    const a = Board.open(repo);
    a.post([chapter(), note('m1', 'one engine')], 'owner');
    a.close();
    return repo;
  }

  it('leaves out a solidify the agent forged in the log, reports it, and never rewrites the file', async () => {
    const repo = threeEvents();
    const file = path.join(repo, '.keel/board/log.jsonl');
    fs.appendFileSync(file, `${JSON.stringify({ id: 'e4', at, by: 'agent', type: 'solidify', chapter: CH, picks: ['m1'], parts: [] })}\n`);
    const before = fs.readFileSync(file, 'utf8');

    const b = Board.open(repo);
    expect(b.problems).toEqual([{ line: 4, reason: expect.stringMatching(/^e4 breaks R6: agent may not send "solidify"/) }]);
    expect(b.events.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
    expect(b.state.chapters[CH]!.state).toBe('idea');
    expect(Object.values(b.state.acts)).toEqual([]);
    // The id the forged line took is not used again.
    const r = b.post([note('m2', 'next')], 'owner');
    expect(r.ok && r.events[0]!.id).toBe('e5');
    b.close();
    expect(fs.readFileSync(file, 'utf8').startsWith(before)).toBe(true);

    const said: string[] = [];
    await start({ repoDir: repo, log: (m) => said.push(m) });
    expect(said).toContain('log.jsonl: 4 events read, 1 line left out. The file is left as it is.');
    expect(said.some((m) => /^log\.jsonl line 4 was skipped \(e4 breaks R6/.test(m))).toBe(true);
  });

  it('a huge event id does not poison later ids', () => {
    const repo = threeEvents();
    const file = path.join(repo, '.keel/board/log.jsonl');
    const huge = { id: 'e9999999999', at, by: 'owner', type: 'item.add', chapter: CH, item: { id: 'm9', kind: 'note', box: [0, 0, 10, 10], text: 'far' } };
    fs.appendFileSync(file, `${JSON.stringify(huge)}\n{"id":"e8888888888","at":"broken\n`);
    const b = Board.open(repo);
    expect(b.problems.map((p) => p.reason)).toEqual([
      'e9999999999 jumps ahead: after e3 the next event is e4',
      'not JSON',
    ]);
    expect(b.state.items.m9).toBeUndefined();
    const r = b.post([note('m4', 'after')], 'owner');
    expect(r.ok && r.events[0]!.id).toBe('e4');
    b.close();
  });

  it('leaves out an event that repeats an id, and allows the gap a broken line leaves', () => {
    const repo = threeEvents();
    const file = path.join(repo, '.keel/board/log.jsonl');
    const lines = fs.readFileSync(file, 'utf8');
    const second = lines.split('\n')[1]!;
    const later = { id: 'e5', at, by: 'owner', type: 'item.add', chapter: CH, item: { id: 'm5', kind: 'note', box: [0, 0, 10, 10], text: 'after a gap' } };
    fs.appendFileSync(file, `${second}\nnot an event\n${JSON.stringify(later)}\n`);
    const b = Board.open(repo);
    expect(b.problems.map((p) => [p.line, p.reason])).toEqual([
      [4, 'e2 is not after e3, the event before it'],
      [5, 'not JSON'],
    ]);
    expect(b.state.items.m5).toBeDefined();
    expect(b.state.seq).toBe(5);
    b.close();
  });

  it('refuses to append when the next id would not be a valid event id', () => {
    const b = Board.open(tempRepo());
    const internal = b as unknown as { current: Board['state'] };
    internal.current = { ...internal.current, seq: 9_999_999_999 };
    const before = fs.readFileSync(b.logPath, 'utf8');
    const r = b.post([chapter()], 'owner');
    expect(r).toMatchObject({ ok: false, rule: 'shape', index: 0, reason: expect.stringMatching(/not a valid event id|log is full/) });
    expect(fs.readFileSync(b.logPath, 'utf8')).toBe(before);
    b.close();
  });
});

/* ------------------------------------------------------------------ 6 */

describe('6. the Host header', () => {
  it('answers only to 127.0.0.1:<port> and localhost:<port>, over HTTP and on the websocket', async () => {
    const s = await start();
    const auth = { authorization: `Bearer ${s.tokens.owner}` };
    for (const host of ['evil.example', `evil.example:${s.port}`, `127.0.0.1:${s.port + 1}`, 'localhost', '127.0.0.1']) {
      const r = await raw(s.port, ROUTES.board, { headers: { ...auth, host } });
      expect(r.status, host).toBe(403);
      expect(r.body, host).toContain(`answers only to 127.0.0.1:${s.port} and localhost:${s.port}`);
    }
    expect((await raw(s.port, '/', { headers: { host: 'evil.example' } })).status).toBe(403);
    for (const host of [`127.0.0.1:${s.port}`, `localhost:${s.port}`, `LOCALHOST:${s.port}`]) {
      expect((await raw(s.port, ROUTES.board, { headers: { ...auth, host } })).status, host).toBe(200);
    }
    await expect(Client.connect(`ws://127.0.0.1:${s.port}${ROUTES.ws}?token=${s.tokens.owner}`, { host: 'evil.example' })).rejects.toThrow(/403/);
    const ok = await Client.connect(`ws://127.0.0.1:${s.port}${ROUTES.ws}?token=${s.tokens.owner}`, { host: `localhost:${s.port}` });
    clients.push(ok);
  });
});

/* ------------------------------------------------------------------ 7 */

describe('7. built needs a real commit', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Keel Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' }).trim();

  /** A board with one part, solid, on a started build track. */
  function building(repo: string): Board {
    const b = Board.open(repo);
    const must = (r: ReturnType<Board['post']>) => {
      if (!r.ok) throw new Error(`${r.rule}: ${r.reason}`);
    };
    must(b.post([chapter()], 'owner'));
    must(b.post([{ type: 'model.patch', chapter: CH, ops: [{ op: 'part.set', part: { id: 'door', name: 'The door' } }] }], 'agent'));
    must(b.post([{ type: 'solidify', chapter: CH, picks: [], parts: ['door'] }, { type: 'build.start', chapter: CH, track: ['door'], check: 'npm test' }], 'owner'));
    // A part is built from "building".
    must(b.post([{ type: 'part.state', part: 'door', state: 'building' }], 'agent'));
    return b;
  }
  const built = (commit: string) => ({ type: 'part.state', part: 'door', state: 'built', commit, check: { cmd: 'npm test', passed: true } });

  it('refuses a made-up commit, and admits a real one in the repository', () => {
    const repo = tempRepo();
    git(repo, 'init', '-q');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'the door');
    const sha = git(repo, 'rev-parse', 'HEAD');
    const b = building(repo);

    const madeUp = b.post([built('deadbeef1234')], 'system');
    expect(madeUp).toMatchObject({ ok: false, rule: 'R2', index: 0, reason: 'There is no commit deadbeef1234 in this repository. Report "built" with the id of a commit that exists.' });
    expect(b.post([built('HEAD')], 'system')).toMatchObject({ ok: false, rule: 'R2', reason: expect.stringContaining('"HEAD" is not a commit id') });
    expect(b.post([built('--output=/tmp/x')], 'system')).toMatchObject({ ok: false, rule: 'R2' });
    expect(b.state.model.parts.door!.state).not.toBe('built');

    const real = b.post([built(sha.slice(0, 7))], 'system');
    expect(real.ok).toBe(true);
    expect(b.state.model.parts.door).toMatchObject({ state: 'built', commit: sha.slice(0, 7) });
    b.close();
  });

  it('refuses when the folder is not a git repository, and the check can be turned off for a fixture', () => {
    const repo = tempRepo();
    const b = building(repo);
    expect(b.post([built('eb39c5b')], 'system')).toMatchObject({
      ok: false,
      rule: 'R2',
      reason: "The board's folder is not a git repository, so commit eb39c5b cannot be checked. A part is built only by a commit in this repository.",
    });
    b.close();
    const c = Board.open(repo, { checkCommits: false });
    expect(c.post([built('eb39c5b')], 'system').ok).toBe(true);
    c.close();
  });

  it('refuses over HTTP under R2 with the sentence', async () => {
    const repoDir = tempRepo();
    const s = await start({ repoDir });
    await call(s.origin, s.tokens.owner, ROUTES.events, { method: 'POST', json: { drafts: [chapter()] } });
    await call(s.origin, s.tokens.agent, ROUTES.events, { method: 'POST', json: { drafts: [{ type: 'model.patch', chapter: CH, ops: [{ op: 'part.set', part: { id: 'door', name: 'The door' } }] }] } });
    await call(s.origin, s.tokens.owner, ROUTES.events, { method: 'POST', json: { drafts: [{ type: 'solidify', chapter: CH, picks: [], parts: ['door'] }, { type: 'build.start', chapter: CH, track: ['door'], check: 'npm test' }] } });
    await call(s.origin, s.tokens.agent, ROUTES.events, { method: 'POST', json: { drafts: [{ type: 'part.state', part: 'door', state: 'building' }] } });
    const r = await call(s.origin, s.tokens.system, ROUTES.events, { method: 'POST', json: { drafts: [built('eb39c5b')] } });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ rule: 'R2', reason: expect.stringContaining('not a git repository') });
  });
});

/* ------------------------------------------------------------------ 9 */

describe('9. what the command prints has no control characters', () => {
  it('strips them from the board name, the folder, the marks and the agent\'s words', async () => {
    const repo = tempRepo('evil\u001b[2Jname');
    const opened = await cli('open', repo, '--no-browser');
    expect(opened.code).toBe(0);
    const s = opened.server!;
    const all = (r: { out: string[]; err: string[] }) => [...r.out, ...r.err].join('\n');
    expect(all(opened)).toContain('Board "evil[2Jname"');
    expect(all(opened)).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);

    await call(s.origin, s.tokens.owner, ROUTES.events, { method: 'POST', json: { drafts: [chapter(), note('m1', 'look\u001b]0;pwned\u0007 here\u009b')] } });
    await call(s.origin, s.tokens.agent, ROUTES.presence, { method: 'POST', json: { state: 'drawing', note: 'busy\u001b[1A\rnow\u202E' } });

    for (const r of [await cli('read', repo), await cli('status', repo)]) {
      expect(r.code).toBe(0);
      expect(all(r)).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202E]/);
    }
    expect((await cli('read', repo)).out.join('\n')).toContain('look]0;pwned here');
    expect((await cli('status', repo)).out.join('\n')).toContain('busy[1A now');
    // Newlines and tabs stay.
    const out: string[] = [];
    await run(['nonsense\tcommand'], { out: (l) => out.push(l), err: (l) => out.push(l) });
    expect(out.join('')).toContain('Unknown command "nonsense\tcommand".\n\nkeel-board');
  });
});

/* ------------------------------------------------------- the stop route */

describe('ROUTES.stop', () => {
  it('ends the keel-board process that runs the server', async () => {
    const repo = tempRepo();
    const { spawn } = await import('node:child_process');
    const bin = fileURLToPath(new URL('../bin/keel-board.mjs', import.meta.url));
    const child = own(spawn(process.execPath, [bin, 'open', repo, '--no-browser'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, KEEL_BOARD_SOURCE: '1' } }));
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    const file = path.join(repo, '.keel/board/server.json');
    await until(() => out.includes('code=') && fs.existsSync(file), 15_000);
    const f = ServerFile.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    const priv = readPrivate(path.join(repo, '.keel/board'))!;
    expect(priv.port).toBe(f.port);
    const r = await call(`http://127.0.0.1:${f.port}`, priv.running!.systemToken, ROUTES.stop, { method: 'POST' });
    expect(r.body).toEqual({ stopping: true });
    expect(await exited).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  }, 30_000);
});

