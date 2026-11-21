import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ROUTES } from '@keel/protocol';
import type { SyncOptions } from '../src/home';
import { HOME_NOTES, filesInTheWay, syncHome } from '../src/home';
import type { RunningServer, ServerOptions } from '../src/server';
import { OPEN_SYNC_MS, startServer } from '../src/server';
import { run } from '../src/cli';
import { CH, Client, call, tempRepo, until } from './helpers';
import { commitFiles, gitIn, remoteMoves, withRemote } from './gitfix';

/**
 * The home branch (plan 5.1, record 0014): found, brought level with its remote by
 * fast-forward only, and never moved over the owner's changes. Real repositories, with a bare
 * one as the remote.
 */

const running: RunningServer[] = [];
const sockets: net.Server[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  for (const s of sockets.splice(0)) await new Promise<void>((r) => s.close(() => r()));
});

const opts = (over: Partial<SyncOptions> = {}): SyncOptions => ({ fetch: true, protectLog: () => false, logPath: '/nowhere/log.jsonl', now: () => new Date(), ...over });

async function start(repoDir: string, over: Partial<ServerOptions> = {}): Promise<RunningServer> {
  const s = await startServer({ repoDir, port: 0, appDir: path.join(repoDir, 'no-app'), log: () => {}, builder: 'none', ...over });
  running.push(s);
  return s;
}

/** A remote that takes the connection and never answers. */
async function silentRemote(): Promise<string> {
  const held: net.Socket[] = [];
  const srv = net.createServer((c) => held.push(c));
  srv.on('close', () => held.forEach((c) => c.destroy()));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  sockets.push(srv);
  const close = srv.close.bind(srv);
  srv.close = ((cb?: (err?: Error) => void) => {
    held.forEach((c) => c.destroy());
    return close(cb);
  }) as typeof srv.close;
  return `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}/repo.git`;
}

describe('finding the home branch', () => {
  it('has none in a folder that is no repository, and has no commit yet in a new one', async () => {
    expect(await syncHome(tempRepo(), opts())).toBeUndefined();
    const fresh = tempRepo();
    gitIn(fresh)('init', '-q', '-b', 'main');
    expect((await syncHome(fresh, opts()))?.info).toEqual({ branch: 'main', sync: 'local' });
  });

  it('takes the branch origin/HEAD names, else main, else master, else the folder\'s', async () => {
    const f = withRemote();
    f.git('checkout', '-q', '-b', 'feat/x');
    expect((await syncHome(f.repo, opts()))?.info).toMatchObject({ branch: 'main', folderOn: 'feat/x' });

    const plain = tempRepo();
    const g = gitIn(plain);
    g('init', '-q', '-b', 'trunk');
    commitFiles(plain, { 'a.txt': 'a' });
    expect((await syncHome(plain, opts()))?.info.branch).toBe('trunk');
    g('branch', 'master');
    expect((await syncHome(plain, opts()))?.info).toMatchObject({ branch: 'master', folderOn: 'trunk' });
    g('branch', 'main');
    expect((await syncHome(plain, opts()))?.info.branch).toBe('main');
  });

  it('says it follows no remote', async () => {
    const plain = tempRepo();
    gitIn(plain)('init', '-q', '-b', 'main');
    const c = commitFiles(plain, { 'a.txt': 'a' });
    expect((await syncHome(plain, opts()))?.info).toEqual({ branch: 'main', commit: c.slice(0, 7), sync: 'local' });
  });
});

describe('bringing it level with its remote', () => {
  it('is level when nothing moved', async () => {
    const f = withRemote();
    const r = await syncHome(f.repo, opts());
    expect(r?.info).toMatchObject({ branch: 'main', upstream: 'origin/main', sync: 'level', checkedAt: expect.any(String) });
  });

  it('fast-forwards a checked-out home branch in its folder when the remote is ahead', async () => {
    const f = withRemote();
    const c = remoteMoves(f, { 'b.txt': 'new\n' });
    fs.writeFileSync(path.join(f.repo, 'mine.txt'), 'untouched');
    const r = await syncHome(f.repo, opts());
    expect(r?.info).toMatchObject({ sync: 'level', commit: c.slice(0, 7) });
    expect(f.git('rev-parse', 'main')).toBe(c);
    expect(fs.readFileSync(path.join(f.repo, 'b.txt'), 'utf8')).toBe('new\n');
    expect(fs.readFileSync(path.join(f.repo, 'mine.txt'), 'utf8')).toBe('untouched');
  });

  it('moves nothing when the owner\'s changes are in the way, names the files, and stashes nothing', async () => {
    const f = withRemote();
    const before = f.git('rev-parse', 'main');
    remoteMoves(f, { 'a.txt': 'theirs\n' });
    fs.writeFileSync(path.join(f.repo, 'a.txt'), 'mine\n');
    const r = await syncHome(f.repo, opts());
    expect(r?.info).toMatchObject({ sync: 'behind', behind: 1, note: HOME_NOTES.inTheWay('origin', 1, ['a.txt']) });
    expect(f.git('rev-parse', 'main')).toBe(before);
    expect(fs.readFileSync(path.join(f.repo, 'a.txt'), 'utf8')).toBe('mine\n');
    expect(f.git('stash', 'list')).toBe('');
  });

  it('says how many commits are to push when home is ahead', async () => {
    const f = withRemote();
    commitFiles(f.repo, { 'c.txt': 'c' });
    commitFiles(f.repo, { 'd.txt': 'd' });
    expect((await syncHome(f.repo, opts()))?.info).toMatchObject({ sync: 'ahead', ahead: 2 });
  });

  it('moves nothing when the two have diverged', async () => {
    const f = withRemote();
    const mine = commitFiles(f.repo, { 'c.txt': 'c' });
    remoteMoves(f, { 'b.txt': 'b' });
    const r = await syncHome(f.repo, opts());
    expect(r?.info).toMatchObject({ sync: 'diverged', ahead: 1, behind: 1, note: HOME_NOTES.diverged('main', 'origin/main') });
    expect(f.git('rev-parse', 'main')).toBe(mine);
  });

  it('fast-forwards home in the other worktree it is checked out in', async () => {
    const f = withRemote();
    f.git('checkout', '-q', '-b', 'feat/x');
    const wt = path.join(path.dirname(f.repo), 'main-wt');
    f.git('worktree', 'add', '-q', wt, 'main');
    const c = remoteMoves(f, { 'b.txt': 'b\n' });
    const r = await syncHome(f.repo, opts());
    expect(r?.info).toMatchObject({ sync: 'level', folderOn: 'feat/x' });
    expect(f.git('rev-parse', 'main')).toBe(c);
    expect(fs.readFileSync(path.join(wt, 'b.txt'), 'utf8')).toBe('b\n');
    expect(fs.existsSync(path.join(f.repo, 'b.txt'))).toBe(false);
  });

  it('moves the ref when home is checked out nowhere: the folder on another branch, or detached', async () => {
    for (const away of [['checkout', '-q', '-b', 'feat/x'], ['checkout', '-q', '--detach']]) {
      const f = withRemote();
      f.git(...away);
      const c = remoteMoves(f, { 'b.txt': 'b' });
      const r = await syncHome(f.repo, opts());
      expect(r?.info.sync).toBe('level');
      expect(f.git('rev-parse', 'main')).toBe(c);
      expect(fs.existsSync(path.join(f.repo, 'b.txt'))).toBe(false);
    }
  });

  it('is unreachable when the fetch fails, with no prompt, or runs past its limit', async () => {
    const f = withRemote();
    f.git('remote', 'set-url', 'origin', path.join(path.dirname(f.remote), 'gone.git'));
    expect((await syncHome(f.repo, opts()))?.info).toMatchObject({ sync: 'unreachable', note: HOME_NOTES.unreachable('origin', 'main') });

    f.git('remote', 'set-url', 'origin', await silentRemote());
    const t0 = Date.now();
    expect((await syncHome(f.repo, opts({ fetchMs: 700 })))?.info.sync).toBe('unreachable');
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('reads git\'s list of files in the way', () => {
    const said = 'error: Your local changes to the following files would be overwritten by merge:\n\ta.ts\n\tsrc/b.ts\nPlease commit your changes or stash them before you merge.\nAborting\n';
    expect(filesInTheWay(said)).toEqual(['a.ts', 'src/b.ts']);
  });
});

describe('the board server and the home branch', () => {
  it('brings home level at open, before the log is loaded, so a newer log from the remote is taken', async () => {
    const f = withRemote();
    // The remote's board, with one note in it.
    const s0 = await start(f.other);
    s0.board.post([{ type: 'chapter.open', chapter: CH, title: 'Shared' }], 'owner');
    await s0.close();
    running.splice(0);
    commitFiles(f.other, { '.keel/board/log.jsonl': fs.readFileSync(s0.board.logPath, 'utf8') }, 'board');
    f.otherGit('push', '-q', 'origin', 'main');

    const s = await start(f.repo);
    expect(s.board.state.chapters[CH]?.title).toBe('Shared');
    expect(s.home()).toMatchObject({ branch: 'main', sync: 'level' });
  });

  it('does not rewrite the log under a running board: it says to open the board again', async () => {
    const f = withRemote();
    const s0 = await start(f.other);
    await s0.close();
    running.splice(0);
    commitFiles(f.other, { '.keel/board/log.jsonl': fs.readFileSync(s0.board.logPath, 'utf8') }, 'board');
    f.otherGit('push', '-q', 'origin', 'main');

    const s = await start(f.repo);
    const before = f.git('rev-parse', 'main');
    const s1 = await start(f.other);
    s1.board.post([{ type: 'chapter.open', chapter: CH, title: 'Later' }], 'owner');
    await s1.close();
    commitFiles(f.other, { '.keel/board/log.jsonl': fs.readFileSync(s1.board.logPath, 'utf8') }, 'board again');
    f.otherGit('push', '-q', 'origin', 'main');

    const r = await call(s.origin, s.tokens.owner, ROUTES.sync, { method: 'POST', json: {} });
    expect(r.body.home).toMatchObject({ sync: 'behind', note: HOME_NOTES.newerLog('origin') });
    expect(f.git('rev-parse', 'main')).toBe(before);
  });

  it('does not hold the board up past a few seconds when the remote does not answer', async () => {
    const f = withRemote();
    f.git('remote', 'set-url', 'origin', await silentRemote());
    const t0 = Date.now();
    const s = await start(f.repo);
    expect(Date.now() - t0).toBeLessThan(OPEN_SYNC_MS + 2000);
    expect(s.board.state.seq).toBeGreaterThan(0);
  });

  it('says home to the owner only: on the board, at init, and in the works message', async () => {
    const f = withRemote();
    const s = await start(f.repo);
    expect((await call(s.origin, s.tokens.owner, ROUTES.board)).body.home).toMatchObject({ branch: 'main', sync: 'level' });
    for (const t of [s.tokens.agent, s.tokens.system]) expect((await call(s.origin, t, ROUTES.board)).body).not.toHaveProperty('home');
    const owner = await Client.connect(`ws://127.0.0.1:${s.port}${ROUTES.ws}?token=${s.tokens.owner}`);
    expect(owner.messages[0]).toMatchObject({ t: 'init', home: { branch: 'main' } });
    const agent = await Client.connect(`ws://127.0.0.1:${s.port}${ROUTES.ws}?token=${s.tokens.agent}`);
    expect(agent.messages[0]).not.toHaveProperty('home');

    remoteMoves(f, { 'b.txt': 'b' });
    expect((await call(s.origin, s.tokens.agent, ROUTES.sync, { method: 'POST', json: {} })).status).toBe(403);
    const r = await call(s.origin, s.tokens.owner, ROUTES.sync, { method: 'POST', json: {} });
    expect(r.body.home).toMatchObject({ sync: 'level', commit: f.git('rev-parse', '--short=7', 'main') });
    await owner.next((m) => m.t === 'works' && m.home?.commit === r.body.home.commit);
    await new Promise((res) => setTimeout(res, 50));
    expect(agent.messages.some((m) => m.t === 'works')).toBe(false);
    owner.close();
    agent.close();
  });
});

describe('push (plan 5.5)', () => {
  const pushOn = (s: RunningServer, token = s.tokens.owner) => call(s.origin, token, ROUTES.push, { method: 'POST', json: {} });

  it('pushes home to its remote, never forced, says so, and reads home again', async () => {
    const f = withRemote();
    const s = await start(f.repo);
    const c = commitFiles(f.repo, { 'c.txt': 'c' });
    await call(s.origin, s.tokens.owner, ROUTES.sync, { method: 'POST', json: {} });
    expect(s.home()?.sync).toBe('ahead');
    const r = await pushOn(s);
    expect(r.body).toEqual({ ok: true, note: 'Pushed main to origin.', home: expect.objectContaining({ sync: 'level' }) });
    expect(gitIn(f.remote)('rev-parse', 'main')).toBe(c);
    expect(s.home()?.sync).toBe('level');
    expect(s.board.state.feed).toEqual([]);
  });

  it('says why in a sentence, then git\'s own line, reads the remote again, and forces nothing', async () => {
    const f = withRemote();
    const s = await start(f.repo);
    commitFiles(f.repo, { 'c.txt': 'c' });
    await call(s.origin, s.tokens.owner, ROUTES.sync, { method: 'POST', json: {} });
    expect(s.home()?.sync).toBe('ahead');
    const theirs = remoteMoves(f, { 'b.txt': 'b' });
    const r = await pushOn(s);
    expect(r.body).toMatchObject({
      ok: false,
      note: 'origin has commits that main here does not have, so it did not take the push. ! [rejected] main -> main (fetch first)',
      home: { sync: 'diverged', ahead: 1, behind: 1, note: "main and origin/main have both moved, so the board did not pull. Run git pull in the board's folder, then look again." },
    });
    expect(s.home()?.sync).toBe('diverged');
    expect(gitIn(f.remote)('rev-parse', 'main')).toBe(theirs);
  });

  it('has nowhere to push when home follows no remote, and is the owner\'s alone', async () => {
    const plain = tempRepo();
    gitIn(plain)('init', '-q', '-b', 'main');
    commitFiles(plain, { 'a.txt': 'a' });
    const s = await start(plain);
    expect((await pushOn(s, s.tokens.system)).status).toBe(403);
    const r = await pushOn(s);
    expect(r.body).toEqual({ ok: false, note: 'main follows no remote, so there is nowhere to push it.', home: { branch: 'main', commit: expect.any(String), sync: 'local' } });
  });
});

describe('keel-board status', () => {
  it('says the home branch', async () => {
    const f = withRemote();
    const opened = await run(['open', f.repo, '--no-browser', '--port', '0', '--app-dir', path.join(f.repo, 'no-app'), '--builder', 'none', '--link', 'none'], { out: () => {}, err: () => {} });
    running.push(opened.server!);
    const out: string[] = [];
    await until(() => opened.server!.home() !== undefined);
    expect((await run(['status', f.repo], { out: (l) => out.push(l), err: () => {} })).code).toBe(0);
    expect(out.find((l) => l.startsWith('home'))).toMatch(/^home\s+main · [0-9a-f]{7} · level with origin\/main$/);
  });
});
