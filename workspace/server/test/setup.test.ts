import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { SetupInfo } from '@keel/protocol';
import { ROUTES, setupDone } from '@keel/protocol';
import type { RunningServer } from '../src/server';
import { startServer } from '../src/server';
import { findOnPath, gitSetup, setupLines } from '../src/setup';
import { call, tempRepo } from './helpers';

const running: RunningServer[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
});

async function start(link: string): Promise<RunningServer> {
  const repoDir = tempRepo();
  const s = await startServer({ port: 0, appDir: path.join(repoDir, 'no-app-here'), log: () => {}, repoDir, link });
  running.push(s);
  return s;
}

/** A link whose setup answers from `seen.state`, and notes each step it was asked for. */
function linkWithSetup(): string {
  const mod = path.join(path.dirname(tempRepo()), 'setup-link.mjs');
  fs.writeFileSync(
    mod,
    `export const seen = { asked: [], state: { name: 'Claude Code', state: 'signed-out' } };
    const step = (what) => async (arg) => { seen.asked.push(arg === undefined ? what : what + ':' + arg); return seen.state; };
    export function createLink() {
      return { name: 'setup-link', async wake() { return { ok: true }; }, async close() {},
        setup: { look: step('look'), install: step('install'), signIn: step('sign-in'), code: step('code') } };
    }\n`,
  );
  return mod;
}

const dirs = (...names: string[]) => {
  const root = path.dirname(tempRepo());
  return names.map((n) => {
    fs.mkdirSync(path.join(root, n));
    return path.join(root, n);
  });
};

describe('finding a program', () => {
  it('finds an executable file by its name on a PATH, without starting it', () => {
    const [none, plainFile, folder, real] = dirs('none', 'plain', 'folder', 'real');
    fs.writeFileSync(path.join(plainFile!, 'claude'), 'not executable', { mode: 0o644 });
    fs.mkdirSync(path.join(folder!, 'claude'));
    fs.writeFileSync(path.join(real!, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    expect(findOnPath('claude', undefined)).toBeUndefined();
    expect(findOnPath('claude', '')).toBeUndefined();
    expect(findOnPath('claude', [none, plainFile, folder].join(path.delimiter))).toBeUndefined();
    expect(findOnPath('claude', ['', none, plainFile, folder, real].join(path.delimiter))).toBe(path.join(real!, 'claude'));
  });
});

describe('looking for git', () => {
  it('is ready when a git is on the PATH, and says how to get one when not', () => {
    const [empty, has] = dirs('empty', 'has');
    fs.writeFileSync(path.join(has!, 'git'), '#!/bin/sh\n', { mode: 0o755 });

    expect(gitSetup({ platform: 'linux', searchPath: has })).toEqual({ state: 'ready' });
    expect(gitSetup({ platform: 'linux', searchPath: empty })).toEqual({ state: 'missing', how: 'Install it with your package manager, for example "sudo apt install git".' });
    expect(gitSetup({ platform: 'darwin', searchPath: empty, devTools: () => true })).toEqual({
      state: 'missing',
      how: 'Run "xcode-select --install" in a terminal, and press Install in the window that opens.',
    });
    expect(gitSetup({ platform: 'freebsd', searchPath: empty })).toEqual({ state: 'missing', how: 'Get it from https://git-scm.com/downloads.' });
  });

  it.skipIf(!fs.existsSync('/usr/bin/git'))('on macOS, takes /usr/bin/git for a git only when the developer tools are installed', () => {
    let asked = 0;
    const tools = (there: boolean) => () => {
      asked += 1;
      return there;
    };
    expect(gitSetup({ platform: 'darwin', searchPath: '/usr/bin', devTools: tools(true) }).state).toBe('ready');
    expect(gitSetup({ platform: 'darwin', searchPath: '/usr/bin', devTools: tools(false) }).state).toBe('missing');
    expect(asked).toBe(2);
    // Another system's /usr/bin/git is a real one, and nothing is asked.
    expect(gitSetup({ platform: 'linux', searchPath: '/usr/bin', devTools: tools(false) }).state).toBe('ready');
    expect(asked).toBe(2);
  });
});

describe('what the command says before the address', () => {
  const ready = { state: 'ready' } as const;
  const missing = { state: 'missing', how: 'Get it.' } as const;

  it('says nothing when nothing is left to do', () => {
    expect(setupLines({ git: ready })).toEqual([]);
    expect(setupLines({ agent: { name: 'Claude Code', state: 'ready' }, git: ready })).toEqual([]);
  });

  it('says one line for each thing the page will ask for', () => {
    expect(setupLines({ agent: { name: 'Claude Code', state: 'missing' }, git: missing })).toEqual([
      'keel-board: Claude Code is not installed. The page that opens installs it and signs you in.',
      'keel-board: git was not found, and a build needs it. Get it.',
    ]);
    expect(setupLines({ agent: { name: 'Claude Code', state: 'signed-out' }, git: ready })).toEqual(['keel-board: Claude Code is not signed in. The page that opens signs you in.']);
    expect(setupLines({ agent: { name: 'Claude Code', state: 'outdated', found: '2.1.200', needs: '2.1.316' }, git: ready })).toEqual([
      'keel-board: Claude Code 2.1.200 is too old for the board, which needs 2.1.316 or newer. The page that opens updates it.',
    ]);
    expect(setupLines({ agent: { name: 'Claude Code', state: 'outdated', needs: '2.1.316' }, git: ready })).toEqual([
      'keel-board: Claude Code is too old for the board, which needs 2.1.316 or newer. The page that opens updates it.',
    ]);
  });
});

describe('when setup is done', () => {
  it('needs the agent ready, when one needs anything, and git', () => {
    const ready = { state: 'ready' } as const;
    expect(setupDone({ git: ready })).toBe(true);
    expect(setupDone({ agent: { name: 'x', state: 'ready' }, git: ready })).toBe(true);
    expect(setupDone({ agent: { name: 'x', state: 'signed-out' }, git: ready })).toBe(false);
    expect(setupDone({ agent: { name: 'x', state: 'missing' }, git: ready })).toBe(false);
    expect(setupDone({ agent: { name: 'x', state: 'ready' }, git: { state: 'missing', how: '' } })).toBe(false);
  });
});

describe('the setup route', () => {
  it('tells the owner how the machine stands, and no one else', async () => {
    const mod = linkWithSetup();
    const s = await start(mod);
    const { seen } = (await import(pathToFileURL(mod).href)) as { seen: { asked: string[]; state: SetupInfo['agent'] } };

    const got = await call(s.origin, s.tokens.owner, ROUTES.setup);
    expect(got.status).toBe(200);
    expect(got.body).toEqual({ agent: { name: 'Claude Code', state: 'signed-out' }, git: gitSetup() });
    expect(seen.asked).toEqual(['look']);
    expect(await s.setup()).toEqual(got.body);

    for (const token of [s.tokens.agent, s.tokens.system]) {
      expect((await call(s.origin, token, ROUTES.setup)).status).toBe(403);
      expect((await call(s.origin, token, ROUTES.setup, { method: 'POST', json: { action: 'install' } })).status).toBe(403);
    }
    expect((await call(s.origin, undefined, ROUTES.setup)).status).toBe(401);
    expect((await call(s.origin, s.tokens.owner, ROUTES.setup, { method: 'PUT' })).status).toBe(405);
  });

  it('takes the step the owner asks for, and answers with how things stand after it', async () => {
    const mod = linkWithSetup();
    const s = await start(mod);
    const { seen } = (await import(pathToFileURL(mod).href)) as { seen: { asked: string[]; state: SetupInfo['agent'] } };
    seen.asked.length = 0;
    const ask = (json: unknown) => call(s.origin, s.tokens.owner, ROUTES.setup, { method: 'POST', json });

    expect((await ask({ action: 'install' })).status).toBe(200);
    seen.state = { name: 'Claude Code', state: 'signed-out', signIn: { url: 'https://claude.ai/x' } };
    expect((await ask({ action: 'sign-in' })).body.agent).toEqual(seen.state);
    seen.state = { name: 'Claude Code', state: 'ready' };
    expect((await ask({ action: 'code', code: ' abc#def ' })).body.agent).toEqual({ name: 'Claude Code', state: 'ready' });
    expect(seen.asked).toEqual(['install', 'sign-in', 'code:abc#def']);

    for (const bad of [{}, { action: 'remove' }, { action: 'code' }, { action: 'code', code: '  ' }, { action: 'install', more: 1 }]) {
      expect((await ask(bad)).status).toBe(400);
    }
    expect(seen.asked).toHaveLength(3);
  });

  it('leaves the agent out when the link needs nothing, or none is linked', async () => {
    const s = await start('none');
    const got = await call(s.origin, s.tokens.owner, ROUTES.setup);
    expect(got.body).toEqual({ git: gitSetup() });
    expect((await call(s.origin, s.tokens.owner, ROUTES.setup, { method: 'POST', json: { action: 'sign-in' } })).body).toEqual({ git: gitSetup() });
  });
});
