import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BuildEnv } from '../src/build-tools';
import { CHECKS_DIR, buildEnvFrom, createBuilderMcp, gitPin, runCheck, stopAllChecks, stopLeftoverChecks, tailOf } from '../src/build-tools';
import { ENV_ALLOWED, bwrapArgs, defaultDenyRead, sandboxKind, seatbeltProfile } from '../src/sandbox';
import { BoardClient } from '../src/client';
import { readStarts } from '../src/starts';
import { BCH, buildBoard, makeRepo, sh } from './build-board';
import type { FakeBoard } from './fake-board';

/**
 * The builder's board tools. `board_check` is the one that matters: it is our code, not the
 * model's word. It runs the board's agreed command and no other, on a new commit, and only
 * then posts "built" as the system.
 */

let tmp: string;
let repo: string;
let own: string;
let board: FakeBoard;
let client: Client;

async function connect(b: FakeBoard, build: BuildEnv | undefined, system = true): Promise<Client> {
  const agent = new BoardClient(() => ({ url: b.url, token: b.tokens.agent }));
  const sys = system ? new BoardClient(() => ({ url: b.url, token: b.tokens.system })) : undefined;
  const server = createBuilderMcp(agent, build, sys);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const c = new Client({ name: 'test', version: '0.0.0' });
  await c.connect(clientSide);
  return c;
}

async function call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
  return { text: r.content.map((c) => c.text).join('\n'), isError: r.isError === true };
}

const env = (o: Partial<BuildEnv> = {}): BuildEnv => ({ chapter: BCH, workdir: repo, stateDir: own, systemToken: 'system-token', checkTimeoutMs: 20_000, ...o });

function commit(file: string, text: string): string {
  fs.writeFileSync(path.join(repo, file), text);
  sh(repo, 'git', 'add', file);
  sh(repo, 'git', 'commit', '--quiet', '-m', `add ${file}`);
  return sh(repo, 'git', 'rev-parse', '--short', 'HEAD');
}

/** A board whose agreed check is `check`, and the builder's tools, handed the same check. */
async function setup(check: string, build: Partial<BuildEnv> = {}): Promise<void> {
  board = await buildBoard({ check });
  client = await connect(board, env({ check, ...build }));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-check-'));
  repo = makeRepo(path.join(tmp, 'tree'));
  own = path.join(tmp, 'own');
});

afterEach(async () => {
  await client?.close();
  await board?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the builder\'s tools', () => {
  it('are six: read, part, update, post a choice, try the check, and the check', async () => {
    await setup('true');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['board_check', 'board_part', 'board_post', 'board_read', 'board_try', 'board_update']);
    const check = tools.find((t) => t.name === 'board_check')!;
    expect(Object.keys((check.inputSchema as { properties: object }).properties)).toEqual(['part']);
  });

  it('board_part says "building" only, and remembers the commit the part started at', async () => {
    await setup('true');
    const built = await call('board_part', { part: 'sum', state: 'built' });
    expect(built.isError).toBe(true);
    const r = await call('board_part', { part: 'sum', state: 'building' });
    expect(r.isError).toBe(false);
    expect(board.state.model.parts.sum?.state).toBe('building');
    expect(board.events.at(-1)?.by).toBe('agent');
    expect(readStarts(own).sum?.start).toBe(sh(repo, 'git', 'rev-parse', 'HEAD'));
  });

  it('a check that passes on a new commit makes the part built, as the system, with the commit and the check', async () => {
    const mark = path.join(repo, 'ran');
    await setup(`touch '${mark}' && test -f sum.txt`);
    await call('board_part', { part: 'sum', state: 'building' });
    const hash = commit('sum.txt', 'one plus one\n');
    const r = await call('board_check', { part: 'sum' });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toContain(`passed at ${hash}`);
    expect(fs.existsSync(mark)).toBe(true);
    const last = board.events.at(-1)!;
    expect(last).toMatchObject({ by: 'system', type: 'part.state', part: 'sum', state: 'built', commit: hash, check: { cmd: `touch '${mark}' && test -f sum.txt`, passed: true } });
    expect(board.state.model.parts.sum).toMatchObject({ state: 'built', commit: hash });
  });

  it('a check that fails posts a problem with the end of its output, and hands the output back', async () => {
    await setup('echo first line; echo "expected 3, got 4" >&2; exit 2');
    await call('board_part', { part: 'sum', state: 'building' });
    const hash = commit('sum.txt', 'wrong\n');
    const r = await call('board_check', { part: 'sum' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('exit 2');
    expect(r.text).toContain('expected 3, got 4');
    expect(board.state.model.parts.sum?.state).toBe('building');
    const last = board.events.at(-1)!;
    expect(last).toMatchObject({ by: 'system', type: 'feed.add', kind: 'problem', part: 'sum', commit: hash, check: { passed: false } });
    expect((last as { text: string }).text).toContain('expected 3, got 4');
  });

  it('a failing check whose output the board will not take is still reported as failed, without the output', async () => {
    // The check prints something shaped like a token, put together as it runs, so the command
    // itself holds no such shape. The board refuses words that hold one (R9).
    const shaped = `ghp_${'abcdefghijklmnopqrstuvwxyz0123456789AB'}`;
    await setup(`printf 'ghp_%s\\n' abcdefghijklmnopqrstuvwxyz0123456789AB; exit 3`);
    await call('board_part', { part: 'sum', state: 'building' });
    const hash = commit('sum.txt', 'wrong\n');
    const r = await call('board_check', { part: 'sum' });
    expect(r.isError).toBe(true);
    // The builder still gets the output, to fix what failed.
    expect(r.text).toContain('exit 3');
    const last = board.events.at(-1)!;
    expect(last).toMatchObject({ by: 'system', type: 'feed.add', kind: 'problem', part: 'sum', commit: hash, check: { passed: false } });
    expect((last as { text: string }).text).toContain('Its output is not shown here: the board refused it (R9).');
    expect(r.text).toContain(shaped);
    expect(JSON.stringify(board.events)).not.toContain(shaped);
  });

  it('refuses with no new commit since the part started, and runs nothing', async () => {
    const mark = path.join(repo, 'ran');
    await setup(`touch '${mark}'`);
    await call('board_part', { part: 'sum', state: 'building' });
    const before = board.events.length;
    const r = await call('board_check', { part: 'sum' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('no new commit');
    expect(fs.existsSync(mark)).toBe(false);
    expect(board.events.length).toBe(before);
  });

  it('refuses a part that is not building', async () => {
    const mark = path.join(repo, 'ran');
    await setup(`touch '${mark}'`);
    commit('sum.txt', 'x\n');
    const r = await call('board_check', { part: 'sum' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Part "sum" is solid');
    expect(fs.existsSync(mark)).toBe(false);
  });

  it('runs the board\'s check, never one the model gives', async () => {
    const mark = path.join(repo, 'ran');
    const pwned = path.join(repo, 'pwned');
    await setup(`touch '${mark}'`);
    await call('board_part', { part: 'sum', state: 'building' });
    commit('sum.txt', 'x\n');
    for (const extra of [{ check: `touch '${pwned}'` }, { cmd: `touch '${pwned}'` }, { command: `touch '${pwned}'` }]) {
      const r = await call('board_check', { part: 'sum', ...extra });
      expect(r.isError, JSON.stringify(extra)).toBe(true);
    }
    expect(fs.existsSync(pwned)).toBe(false);
    expect(fs.existsSync(mark)).toBe(false);
    const r = await call('board_check', { part: 'sum' });
    expect(r.isError).toBe(false);
    expect(fs.existsSync(mark)).toBe(true);
    expect(fs.existsSync(pwned)).toBe(false);
  });

  it('refuses uncommitted changes: the check runs on the commit', async () => {
    await setup('true');
    await call('board_part', { part: 'sum', state: 'building' });
    commit('sum.txt', 'x\n');
    fs.writeFileSync(path.join(repo, 'loose.txt'), 'not committed\n');
    const r = await call('board_check', { part: 'sum' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('loose.txt');
  });

  it('works only inside the builder: no system token, no check', async () => {
    board = await buildBoard({ check: 'true' });
    client = await connect(board, env({ check: 'true', systemToken: undefined }), false);
    await call('board_part', { part: 'sum', state: 'building' });
    commit('sum.txt', 'x\n');
    const r = await call('board_check', { part: 'sum' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('works only inside the builder');
    expect(board.state.model.parts.sum?.state).toBe('building');
  });

  it('a check past its time limit is stopped and counts as failed', async () => {
    await setup('sleep 20', { checkTimeoutMs: 400 });
    await call('board_part', { part: 'sum', state: 'building' });
    commit('sum.txt', 'x\n');
    const t0 = Date.now();
    const r = await call('board_check', { part: 'sum' });
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('stopped after');
  });

  it('board_update writes to the build chapter\'s feed, and board_post takes only a choice', async () => {
    await setup('true');
    const u = await call('board_update', { text: 'The sum is in.', part: 'sum' });
    expect(u.isError).toBe(false);
    expect(board.events.at(-1)).toMatchObject({ by: 'agent', type: 'feed.add', chapter: BCH, kind: 'update', part: 'sum' });
    const text = await call('board_post', { pictures: [{ picture: { kind: 'text', title: 'hello' } }] });
    expect(text.isError).toBe(true);
    const choice = await call('board_post', {
      pictures: [{ picture: { kind: 'choice', title: 'Integers only', options: [{ id: 'int', label: 'Integers' }, { id: 'float', label: 'Floats too' }], chosen: 'int', part: 'sum' } }],
    });
    expect(choice.isError, choice.text).toBe(false);
    // With no "from", the choice grows out of the chapter's blueprint.
    expect(board.events.at(-1)).toMatchObject({ by: 'agent', type: 'item.add', chapter: BCH, item: { kind: 'picture', from: ['bp'] } });
  });
});

const BOXED = sandboxKind().kind !== 'none';

describe('the box, as this machine has it', () => {
  it('is there on a Mac, and on Linux with a bwrap that works: the tests below never pass by being skipped there', () => {
    if (process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')) expect(sandboxKind().kind).toBe('seatbelt');
    if (process.env.CI && process.platform === 'linux') expect(['bwrap', 'none']).toContain(sandboxKind().kind);
  });

  it('closes, by default, the folders that hold the board\'s tokens and the owner\'s keys', () => {
    const deny = defaultDenyRead({ stateRoot: '/state', ownerRepo: '/repo', home: '/home/owner' });
    for (const d of ['/state', '/repo/.keel', '/home/owner/.ssh', '/home/owner/.aws', '/home/owner/.claude', '/home/owner/.gnupg', '/home/owner/.config/gh', '/home/owner/.docker', '/home/owner/.kube']) {
      expect(deny, d).toContain(d);
    }
  });

  it('lets nothing ask a program outside the box to do its work, and gives the Linux box its own process numbers', () => {
    const profile = seatbeltProfile({ workdir: '/state/tree', tmp: '/tmp/x', denyRead: [] });
    for (const line of ['(deny network*)', '(deny lsopen)', '(deny appleevent-send)', '(deny job-creation)', '(deny file-write*)']) expect(profile).toContain(line);
    const args = bwrapArgs({ workdir: tmp, tmp, denyRead: [] }, 'true');
    for (const a of ['--unshare-net', '--unshare-pid', '--die-with-parent']) expect(args).toContain(a);
  });
});

describe.runIf(BOXED)('the box the check runs in', () => {
  it('writes only inside its folder and its temp folder', async () => {
    const outside = path.join(tmp, 'outside.txt');
    const r = await runCheck(`echo in > inside.txt && echo "$TMPDIR" > tmp.txt && echo x > "$TMPDIR/t" && echo out > '${outside}'`, repo, 10_000);
    expect(r.code).not.toBe(0);
    expect(fs.existsSync(path.join(repo, 'inside.txt'))).toBe(true);
    expect(fs.existsSync(outside)).toBe(false);
    // The temp folder is its own, and goes when the check ends.
    expect(fs.existsSync(fs.readFileSync(path.join(repo, 'tmp.txt'), 'utf8').trim())).toBe(false);
  });

  it('cannot change what it is told to leave alone inside its folder: the worktree\'s link to its git folder', async () => {
    // A stand-in for a worktree's `.git` file, which names where git keeps the worktree's own folder.
    const link = path.join(repo, 'link.txt');
    fs.writeFileSync(link, 'gitdir: /the/real/place\n');
    const r = await runCheck(`echo 'gitdir: ./mine' > link.txt; rm -f link.txt; mv link.txt gone.txt; mkdir -p link.txt/x; echo ok > beside.txt`, repo, 10_000, { denyWrite: [link] });
    expect(fs.readFileSync(link, 'utf8')).toBe('gitdir: /the/real/place\n');
    expect(fs.existsSync(path.join(repo, 'gone.txt'))).toBe(false);
    // The rest of the folder is still the check's to write.
    expect(fs.readFileSync(path.join(repo, 'beside.txt'), 'utf8')).toBe('ok\n');
    expect(r.output).toMatch(/not permitted|denied|Read-only|busy/i);
  });

  it('reads nothing in the denied folders, the builder\'s private folder among them', async () => {
    const secret = path.join(tmp, 'state', 'board.json');
    fs.mkdirSync(path.dirname(secret), { recursive: true });
    fs.writeFileSync(secret, '{"systemToken":"CANARY"}');
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, 'mcp.json'), 'CANARY-OWN');
    const r = await runCheck(`cat '${secret}'; cat '${path.join(own, 'mcp.json')}'; cat README.md`, repo, 10_000, { stateDir: own, denyRead: [path.dirname(secret)] });
    expect(r.output).not.toContain('CANARY');
    expect(r.output).toContain('# toy');
  });

  it('has no network', async () => {
    const http = await import('node:http');
    const srv = http.createServer((_q, s) => s.end('reached')).listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const port = (srv.address() as { port: number }).port;
    try {
      const r = await runCheck(`node -e "require('http').get('http://127.0.0.1:${port}', (s) => { s.on('data', (d) => process.stdout.write(d)); }).on('error', (e) => { console.log('refused', e.code); process.exit(7); })"`, repo, 10_000);
      expect(r.output).not.toContain('reached');
      expect(r.code).toBe(7);
    } finally {
      srv.close();
    }
  });
});

describe('the tools\' own process', () => {
  it('takes its checks with it when it ends: the whole process group, with nothing left running', async () => {
    const { Client: McpClient } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    board = await buildBoard({ check: 'sleep 60 & echo $! > bg.pid; wait' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'mcp-src.mjs')],
      env: { ...(process.env as Record<string, string>), KEEL_BOARD_URL: board.url, KEEL_BOARD_TOKEN: board.tokens.agent, KEEL_BOARD_ROLE: 'builder', KEEL_BUILD_CHAPTER: BCH, KEEL_BUILD_CHECK: 'sleep 60 & echo $! > bg.pid; wait', KEEL_BUILD_WORKDIR: repo, KEEL_BUILD_STATE: own },
      stderr: 'ignore',
    });
    const c = new McpClient({ name: 'test', version: '0.0.0' });
    await c.connect(transport);
    void c.callTool({ name: 'board_try', arguments: {} }).catch(() => undefined);
    const pidFile = path.join(repo, 'bg.pid');
    for (let i = 0; i < 200 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
    const bg = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(bg, 0)).not.toThrow();
    await c.close();
    for (let i = 0; i < 100; i++) {
      try {
        process.kill(bg, 0);
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(() => process.kill(bg, 0)).toThrow();
  }, 30_000);
});

describe('the check the owner agreed to', () => {
  it('board_check runs the check it was handed, and refuses when the board names another', async () => {
    const mark = path.join(repo, 'ran');
    board = await buildBoard({ check: `touch '${mark}'` });
    client = await connect(board, env({ check: 'make check' }));
    await call('board_part', { part: 'sum', state: 'building' });
    commit('sum.txt', 'x\n');
    const before = board.events.length;
    const r = await call('board_check', { part: 'sum' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('the owner agreed to "make check" here. Nothing was run.');
    expect(fs.existsSync(mark)).toBe(false);
    expect(board.events.length).toBe(before);
    expect(board.state.model.parts.sum?.state).toBe('building');
  });

  it('board_try runs it on the files as they are: no commit needed, nothing posted, nothing built', async () => {
    await setup('test -f sum.txt && echo found it');
    await call('board_part', { part: 'sum', state: 'building' });
    const before = board.events.length;
    const no = await call('board_try', {});
    expect(no.isError).toBe(true);
    expect(no.text).toContain('fails on the files as they are');
    fs.writeFileSync(path.join(repo, 'sum.txt'), 'not committed\n');
    const yes = await call('board_try', {});
    expect(yes.isError, yes.text).toBe(false);
    expect(yes.text).toContain('found it');
    expect(board.events.length).toBe(before);
    expect(board.state.model.parts.sum?.state).toBe('building');
    // board_try takes no command either.
    expect((await call('board_try', { check: 'true' })).isError).toBe(true);
  });
});

describe('the check itself', () => {
  it('gets the allow-listed environment only: no token, no agent session, no SSH agent', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, { KEEL_BOARD_SYSTEM_TOKEN: 's', CLAUDECODE: '1', ANTHROPIC_API_KEY: 'k', SSH_AUTH_SOCK: '/x', MY_SECRET: 'y' });
    try {
      const r = await runCheck('env', repo, 10_000);
      const names = r.output.split('\n').map((l) => l.split('=')[0]).filter(Boolean);
      for (const n of names) expect([...ENV_ALLOWED, 'TMPDIR', 'PWD', 'SHLVL', 'OLDPWD', '_', '__CF_USER_TEXT_ENCODING']).toContain(n);
      expect(r.output).toContain('PATH=');
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it('stops the whole process group: from this process, and from the pid files a builder reads', async () => {
    const run = runCheck('sleep 60 & echo $! > bg.pid; wait', repo, 60_000, { stateDir: own });
    const pidFile = path.join(repo, 'bg.pid');
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
    const bg = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(fs.readdirSync(path.join(own, CHECKS_DIR))).toHaveLength(1);
    stopLeftoverChecks(own);
    const r = await run;
    expect(r.code).not.toBe(0);
    expect(() => process.kill(bg, 0)).toThrow();
    expect(fs.readdirSync(path.join(own, CHECKS_DIR))).toHaveLength(0);
    const again = runCheck('sleep 60', repo, 60_000);
    await new Promise((r) => setTimeout(r, 200));
    stopAllChecks();
    expect((await again).code).not.toBe(0);
  });


  it('keeps the end of a long output', async () => {
    const r = await runCheck('for i in $(seq 1 200); do echo line $i; done; exit 3', os.tmpdir(), 10_000);
    expect(r.code).toBe(3);
    const tail = tailOf(r.output, 5);
    expect(tail.split('\n')).toEqual(['line 196', 'line 197', 'line 198', 'line 199', 'line 200']);
  });

  it('is told to leave the worktree\'s `.git` alone, and git in the tools is pinned to the worktree\'s own git folder', () => {
    const profile = seatbeltProfile({ workdir: '/state/tree', tmp: '/tmp/x', denyRead: [], denyWrite: ['/state/tree/.git'] });
    const lines = profile.trim().split('\n');
    // Last, so it wins over the worktree's allow.
    expect(lines.at(-1)).toBe('(deny file-write* (literal "/state/tree/.git") (subpath "/state/tree/.git"))');
    const tree = fs.mkdtempSync(path.join(tmp, 'tree-'));
    fs.writeFileSync(path.join(tree, '.git'), 'gitdir: x\n');
    const args = bwrapArgs({ workdir: tree, tmp: tree, denyRead: [], denyWrite: [path.join(tree, '.git')] }, 'true');
    const at = args.indexOf('--ro-bind', args.indexOf('--bind'));
    expect(args.slice(at, at + 3)).toEqual(['--ro-bind', fs.realpathSync(path.join(tree, '.git')), fs.realpathSync(path.join(tree, '.git'))]);
    expect(gitPin({ gitDir: '/repo/.git/worktrees/t', tree: '/state/tree', workdir: '/state/tree/sub' })).toMatchObject({ GIT_DIR: '/repo/.git/worktrees/t', GIT_WORK_TREE: '/state/tree' });
    expect(gitPin({ workdir: '/state/tree' })).toEqual({});
    expect(buildEnvFrom({ KEEL_BOARD_ROLE: 'builder', KEEL_BUILD_GIT_DIR: '/repo/.git/worktrees/t', KEEL_BUILD_TREE: '/state/tree', KEEL_BUILD_WORKDIR: '/state/tree' })).toMatchObject({ gitDir: '/repo/.git/worktrees/t' });
  });

  it('reads its place from the environment only in the builder\'s role', () => {
    expect(buildEnvFrom({ KEEL_BUILD_CHAPTER: 'x' })).toBeUndefined();
    expect(
      buildEnvFrom({
        KEEL_BOARD_ROLE: 'builder',
        KEEL_BUILD_CHAPTER: 'x',
        KEEL_BUILD_CHECK: 'make check',
        KEEL_BUILD_WORKDIR: '/w',
        KEEL_BUILD_TREE: '/t',
        KEEL_BUILD_STATE: '/s',
        KEEL_BUILD_DENY_READ: JSON.stringify(['/a', 'relative']),
        KEEL_BOARD_SYSTEM_TOKEN: 't',
        KEEL_BUILD_CHECK_TIMEOUT: '5',
      }),
    ).toEqual({ chapter: 'x', check: 'make check', workdir: '/w', tree: '/t', stateDir: '/s', denyRead: ['/a'], systemToken: 't', checkTimeoutMs: 5000 });
    expect(buildEnvFrom({ KEEL_BOARD_ROLE: 'builder', KEEL_BUILD_SETUPS: JSON.stringify(['npm ci', 3, '']) })?.setups).toEqual(['npm ci']);
  });
});
