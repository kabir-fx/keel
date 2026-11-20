import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ROUTES } from '@keel/protocol';
import type { Io, RunDeps, RunResult } from '../src/cli';
import { NO_CLAUDE, defaultLink, findOnPath, run } from '../src/cli';
import type { RunningServer } from '../src/server';
import { call, chapter, note, tempRepo, until, own } from './helpers';

const servers: RunningServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function cli(...argv: string[]): Promise<RunResult & { out: string[]; err: string[] }> {
  return cliWith({}, ...argv);
}

async function cliWith(deps: RunDeps, ...argv: string[]): Promise<RunResult & { out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l), stdin: async () => '' };
  const r = await run(argv, io, deps);
  if (r.server) servers.push(r.server);
  return { ...r, out, err };
}

describe('the agent the command starts when none is named', () => {
  it('is $KEEL_BOARD_LINK when that is set', () => {
    expect(defaultLink({ KEEL_BOARD_LINK: 'none' })).toBe('none');
    expect(defaultLink({ KEEL_BOARD_LINK: 'script:./agent.mjs' })).toBe('script:./agent.mjs');
  });

  it('else is the hosted agent that ships beside the server, when it is built', () => {
    const bundled = fileURLToPath(new URL('../../plugin/dist/hosted-link.js', import.meta.url));
    expect(defaultLink({})).toBe(fs.existsSync(bundled) ? bundled : 'none');
  });
});

describe('keel-board', () => {
  it('opens a board, and a second open finds the first server', async () => {
    const repo = tempRepo();
    const noApp = path.join(repo, 'no-app');
    const first = await cli('open', repo, '--no-browser', '--port', '0', '--app-dir', noApp);
    expect(first.code).toBe(0);
    expect(first.server).toBeDefined();
    expect(first.out).toEqual([first.server!.url]);
    // The address holds a code that works once, never a token.
    expect(first.out[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?code=[\w-]{32}$/);
    expect(first.out[0]).not.toContain(first.server!.tokens.owner);

    const second = await cli('open', repo, '--no-browser', '--port', '0');
    expect(second.code).toBe(0);
    expect(second.server).toBeUndefined();
    // A fresh address from the server that runs: the same place, another code.
    expect(second.out).toHaveLength(1);
    expect(second.out[0]).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${first.server!.port}/\\?code=[\\w-]{32}$`));
    expect(second.out[0]).not.toBe(first.out[0]);
    expect(second.err.join('\n')).toMatch(/already runs/);

    // "link" gives one more, and each code opens the owner's page once.
    const third = await cli('link', repo);
    expect(third.code).toBe(0);
    expect(third.out[0]).toMatch(/\?code=[\w-]{32}$/);
    const origin = first.server!.origin;
    const trade = (url: string) => fetch(`${origin}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: new URL(url).searchParams.get('code') }) });
    const got = await trade(third.out[0]!);
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual({ token: first.server!.tokens.owner, role: 'owner' });
    expect((await trade(third.out[0]!)).status).toBe(401);
  });

  it('reports status, reads the digest, and posts as the agent or the system only', async () => {
    const repo = tempRepo('ullm');
    const { server } = await cli('open', repo, '--no-browser', '--app-dir', path.join(repo, 'no-app'));
    const s = server!;
    await call(s.origin, s.tokens.owner, ROUTES.events, { method: 'POST', json: { drafts: [chapter(), note('m1', 'one engine, many requests')] } });

    const status = await cli('status', repo);
    expect(status.code).toBe(0);
    expect(status.out.join('\n')).toMatch(/board {4}ullm · e3 · 1 open/);
    expect(status.out.join('\n')).toMatch(/agent {4}none · away/);
    expect(status.out.join('\n')).toMatch(new RegExp(`page {5}${s.origin}/ `));
    expect([...status.out, ...status.err].join('\n')).not.toContain(s.tokens.owner);

    const read = await cli('read', repo);
    expect(read.out.join('\n')).toMatch(/^BOARD ullm · e3 · 1 items · 1 open/);
    expect(read.out.join('\n')).toMatch(/m1 note "one engine, many requests"/);

    // From a folder inside the repository, the board is found above.
    fs.mkdirSync(path.join(repo, 'src'));
    const answer = JSON.stringify({ type: 'answer', answers: ['m1'], read: 'One engine thread, many clients.' });
    const posted = await cli('post', '--dir', path.join(repo, 'src'), '--as', 'agent', answer);
    expect(posted.code).toBe(0);
    expect(posted.out).toEqual(['e4 answer']);

    const file = path.join(repo, 'drafts.json');
    fs.writeFileSync(file, JSON.stringify({ drafts: [note('m2', 'from the agent')] }));
    const refused = await cli('post', '--dir', repo, '--as', 'agent', `@${file}`);
    expect(refused.code).toBe(1);
    expect(refused.err.join('\n')).toMatch(/Refused under R6/);

    expect((await cli('post', '--dir', repo, '--as', 'owner', answer)).code).toBe(2);
    expect((await cli('read', repo)).out.join('\n')).toMatch(/0 open/);
  });

  it('says so when no server runs', async () => {
    const repo = tempRepo();
    expect((await cli('status', repo)).code).toBe(1);
    expect((await cli('read', repo)).code).toBe(1);
    expect((await cli('stop', repo)).out).toEqual(['No board server runs for this board.']);
    expect((await cli('nonsense')).code).toBe(2);
    expect((await cli('open', repo, '--bogus')).code).toBe(2);
  });

  it('stops a server that runs in another process, which removes its server.json', async () => {
    const repo = tempRepo();
    const bin = fileURLToPath(new URL('../bin/keel-board.mjs', import.meta.url));
    const child = own(spawn(process.execPath, [bin, 'open', repo, '--no-browser', '--port', '0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, KEEL_BOARD_SOURCE: '1' },
    }));
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    const file = path.join(repo, '.keel/board/server.json');
    await until(() => out.includes('code=') && fs.existsSync(file), 15_000);

    const status = await cli('status', repo);
    expect(status.out.join('\n')).toMatch(new RegExp(`pid ${child.pid}`));

    const stopped = await cli('stop', repo);
    expect(stopped.code).toBe(0);
    expect(await exited).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
  }, 30_000);
});

describe('keel-board with no command word', () => {
  it('opens the board, the same as "open"', async () => {
    const repo = tempRepo();
    const r = await cli('--no-browser', '--port', '0', '--dir', repo, '--app-dir', path.join(repo, 'no-app'));
    expect(r.code).toBe(0);
    expect(r.server).toBeDefined();
    expect(r.out).toEqual([r.server!.url]);
    expect(fs.existsSync(path.join(repo, '.keel/board'))).toBe(true);
  });

  it('prints the usage for --help and help, and fails on a word it does not know', async () => {
    for (const argv of [['--help'], ['-h'], ['help']]) {
      const r = await cli(...argv);
      expect(r.code).toBe(0);
      expect(r.server).toBeUndefined();
      expect(r.out.join('\n')).toMatch(/^keel-board: the board server for one repository\.\nWith no command, keel-board opens a board for the folder you are in/);
    }
    const unknown = await cli('nonsense', '--no-browser');
    expect(unknown.code).toBe(2);
    expect(unknown.err.join('\n')).toMatch(/Unknown command "nonsense"/);
  });
});

describe('the folders a board is not opened in', () => {
  const HOME_SAYS = 'keel-board: this is your home folder. The agent can read every file in the folder a board is opened in, so open the board in a folder for the idea: mkdir my-idea && cd my-idea && keel-board';

  it('refuses the home folder, also through a link and with no command word, and writes nothing there', async () => {
    const home = tempRepo('home');
    const alias = path.join(path.dirname(tempRepo()), 'alias');
    fs.symlinkSync(home, alias);
    for (const argv of [['open', home], ['open', alias], ['--dir', home]]) {
      const r = await cliWith({ home }, ...argv, '--no-browser', '--port', '0');
      expect(r.code).toBe(2);
      expect(r.server).toBeUndefined();
      expect(r.err).toEqual([HOME_SAYS]);
    }
    // A home given through a link is the same folder.
    expect((await cliWith({ home: alias }, 'open', home, '--no-browser', '--port', '0')).code).toBe(2);
    expect(fs.existsSync(path.join(home, '.keel'))).toBe(false);

    // A folder inside the home is fine.
    const inside = path.join(home, 'my-idea');
    fs.mkdirSync(inside);
    const ok = await cliWith({ home }, 'open', inside, '--no-browser', '--port', '0', '--app-dir', path.join(inside, 'no-app'));
    expect(ok.code).toBe(0);
  });

  it('refuses the root of the file system', async () => {
    const r = await cli('open', path.parse(process.cwd()).root, '--no-browser', '--port', '0');
    expect(r.code).toBe(2);
    expect(r.err).toEqual([HOME_SAYS.replace('your home folder', 'the root of the file system')]);
  });
});

describe('looking for Claude Code', () => {
  const hosted = fileURLToPath(new URL('../../plugin/dist/hosted-link.js', import.meta.url));

  it('finds an executable file by its name on a PATH, without starting it', () => {
    const root = path.dirname(tempRepo());
    const [none, plainFile, folder, real] = ['none', 'plain', 'folder', 'real'].map((d) => {
      fs.mkdirSync(path.join(root, d));
      return path.join(root, d);
    });
    fs.writeFileSync(path.join(plainFile!, 'claude'), 'not executable', { mode: 0o644 });
    fs.mkdirSync(path.join(folder!, 'claude'));
    fs.writeFileSync(path.join(real!, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    expect(findOnPath('claude', undefined)).toBeUndefined();
    expect(findOnPath('claude', '')).toBeUndefined();
    expect(findOnPath('claude', [none, plainFile, folder].join(path.delimiter))).toBeUndefined();
    expect(findOnPath('claude', ['', none, plainFile, folder, real].join(path.delimiter))).toBe(path.join(real!, 'claude'));
  });

  // Only the hosted agent needs Claude Code. An empty board wakes no one, so nothing is started here.
  it.skipIf(!fs.existsSync(hosted))('warns before the address when the hosted agent cannot find it, and still opens', async () => {
    const empty = path.dirname(tempRepo());
    const repo = tempRepo();
    const base = ['--no-browser', '--port', '0', '--app-dir', path.join(repo, 'no-app'), '--builder', 'none'];
    const warned = await cliWith({ searchPath: empty }, 'open', repo, '--link', hosted, ...base);
    expect(warned.code).toBe(0);
    expect(warned.err[0]).toBe(NO_CLAUDE);
    expect(warned.err.filter((l) => l === NO_CLAUDE)).toHaveLength(1);
    expect(warned.out).toEqual([warned.server!.url]);
    await warned.server!.close();
    servers.splice(servers.indexOf(warned.server!), 1);

    // No warning with bin=, or with another link.
    const named = await cliWith({ searchPath: empty }, 'open', tempRepo(), '--link', hosted, '--link-opt', 'bin=/usr/bin/false', ...base);
    expect(named.code).toBe(0);
    expect(named.err).not.toContain(NO_CLAUDE);
    const other = await cliWith({ searchPath: empty }, 'open', tempRepo(), '--link', 'none', ...base);
    expect(other.code).toBe(0);
    expect(other.err).not.toContain(NO_CLAUDE);
  });

  it('says so in plain words', () => {
    expect(NO_CLAUDE).toBe(
      'keel-board: Claude Code was not found on your PATH. The board opens, but the agent will not answer until Claude Code is installed and signed in. Get it from https://claude.com/claude-code',
    );
  });
});

describe('the launcher', () => {
  it('stops on a Node older than 22, before it loads anything', () => {
    const bin = fileURLToPath(new URL('../bin/keel-board.mjs', import.meta.url));
    const fake = 'data:text/javascript,Object.defineProperty(process,"versions",{value:{...process.versions,node:"18.19.0"}})';
    const r = spawnSync(process.execPath, ['--import', fake, bin, '--help'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toBe('keel-board needs Node 22 or newer. This is Node 18.19.0. Get it from https://nodejs.org.\n');
    expect(r.stdout).toBe('');
  });
});
