import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BOARD_DIR } from '@keel/protocol';
import type { LinkContext } from '@keel/protocol';
import { ClaudeSetup, findClaude } from '../src/claude-setup';
import { createLink } from '../src/hosted-link';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, 'fake-claude-auth.mjs');
const ADDRESS = 'https://claude.ai/oauth/authorize?code=true&client_id=fake';
const REFUSED =
  "Couldn't log in: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.";

let tmp: string;
let home: string;
let bin: string;
let auth: string;
let calls: string;
let made: ClaudeSetup[];

const env = () => ({ PATH: process.env.PATH, HOME: home, FAKE_CLAUDE_AUTH: auth, FAKE_CLAUDE_LOG: calls });
const bare = () => ({ ...env(), PATH: '/usr/bin:/bin' });
const started = () =>
  fs.existsSync(calls)
    ? fs
        .readFileSync(calls, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { args: string[]; pid: number; env: string[] })
    : [];
const logins = () => started().filter((c) => c.args.join(' ') === 'auth login');
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(ok: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function setup(over: Partial<ConstructorParameters<typeof ClaudeSetup>[0]> = {}): ClaudeSetup {
  const s = new ClaudeSetup({ bin, env, log: () => {}, home, ...over });
  made.push(s);
  return s;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-setup-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  bin = path.join(tmp, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  auth = path.join(tmp, 'signed-in');
  calls = path.join(tmp, 'calls.jsonl');
  made = [];
});

afterEach(async () => {
  for (const s of made) await s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('finding Claude Code', () => {
  it('takes a path as it is given, else the first on PATH, else where the installer puts it', () => {
    const dir = path.join(tmp, 'bin');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'plain'), 'not executable', { mode: 0o644 });
    const local = path.join(home, '.local', 'bin');

    expect(findClaude(bin, {}, home)).toBe(bin);
    expect(findClaude(path.join(tmp, 'none'), { PATH: dir }, home)).toBeUndefined();
    expect(findClaude('claude', { PATH: `${path.join(tmp, 'none')}${path.delimiter}${dir}` }, home)).toBe(path.join(dir, 'claude'));
    expect(findClaude('plain', { PATH: dir }, home)).toBeUndefined();
    expect(findClaude('claude', { PATH: '' }, home)).toBeUndefined();

    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    expect(findClaude('claude', { PATH: '' }, home)).toBe(path.join(local, 'claude'));
    expect(findClaude('claude', { PATH: dir }, home)).toBe(path.join(dir, 'claude'));
  });
});

describe('how Claude Code stands', () => {
  it('is missing when the command is not there', async () => {
    expect(await setup({ bin: path.join(tmp, 'none') }).look()).toEqual({ name: 'Claude Code', state: 'missing' });
  });

  it('is signed out or ready by what `claude auth status` says', async () => {
    const s = setup();
    expect(await s.look()).toEqual({ name: 'Claude Code', state: 'signed-out' });
    fs.writeFileSync(auth, '');
    expect(await s.look()).toEqual({ name: 'Claude Code', state: 'ready' });
    expect(started().map((c) => c.args.join(' '))).toEqual(['auth status --json', 'auth status --json']);
  });

  it('takes a Claude Code too old to say as ready', async () => {
    const s = setup({ env: () => ({ ...env(), FAKE_CLAUDE_STATUS: 'old' }) });
    expect(await s.look()).toEqual({ name: 'Claude Code', state: 'ready' });
  });
});

describe('signing in', () => {
  it('starts `claude auth login`, gives the page its address, and is ready once the browser approved', async () => {
    const s = setup();
    expect(await s.signIn()).toEqual({ name: 'Claude Code', state: 'signed-out', signIn: { url: ADDRESS } });
    const [login] = logins();
    expect(alive(login!.pid)).toBe(true);

    fs.writeFileSync(`${auth}.approve`, '');
    await until(() => !alive(login!.pid));
    expect(await s.look()).toEqual({ name: 'Claude Code', state: 'ready' });
  });

  it('hands over a pasted code, and says in the words of Claude Code why one was refused', async () => {
    const s = setup();
    await s.signIn();
    expect(await s.code('  wrong  ')).toEqual({ name: 'Claude Code', state: 'signed-out', note: REFUSED });

    // The next sign-in starts clean, and a good code ends it.
    expect(await s.signIn()).toEqual({ name: 'Claude Code', state: 'signed-out', signIn: { url: ADDRESS } });
    expect(await s.code('good')).toEqual({ name: 'Claude Code', state: 'ready' });
  });

  it('says so when a code comes with no sign-in running', async () => {
    expect(await setup().code('good')).toEqual({ name: 'Claude Code', state: 'signed-out', note: 'No sign-in is running. Press Sign in first.' });
  });

  it('a second press replaces the sign-in that runs, and closing ends the one left', async () => {
    const s = setup();
    await s.signIn();
    const again = await s.signIn();
    const pids = logins().map((c) => c.pid);
    expect(pids).toHaveLength(2);
    await until(() => !alive(pids[0]!));
    expect(alive(pids[1]!)).toBe(true);
    // The one that was replaced leaves no complaint behind.
    expect(again).toEqual({ name: 'Claude Code', state: 'signed-out', signIn: { url: ADDRESS } });

    await s.close();
    expect(alive(pids[1]!)).toBe(false);
  });
});

describe('installing', () => {
  const installer = () => `mkdir -p "$HOME/.local/bin" && cp "${bin}" "$HOME/.local/bin/claude"\n`;

  it('runs the installer and then finds Claude Code where it put it', async () => {
    const s = setup({ bin: 'claude', env: bare, installer: async () => installer() });
    expect(await s.look()).toEqual({ name: 'Claude Code', state: 'missing' });
    expect(await s.install()).toEqual({ name: 'Claude Code', state: 'signed-out' });
    expect(fs.existsSync(path.join(home, '.local', 'bin', 'claude'))).toBe(true);
  });

  it('says what the installer printed when Claude Code is still not there', async () => {
    const s = setup({ bin: 'claude', env: bare, installer: async () => 'echo "no room left" >&2\nexit 3\n' });
    expect(await s.install()).toEqual({ name: 'Claude Code', state: 'missing', note: 'The installer ended (exit 3) and Claude Code is still not there: no room left' });
  });

  it('says so when the installer cannot be fetched', async () => {
    const s = setup({
      bin: 'claude',
      env: bare,
      installer: async () => {
        throw new Error('offline');
      },
    });
    expect(await s.install()).toEqual({ name: 'Claude Code', state: 'missing', note: 'The installer could not be fetched: offline' });
  });

  it('says it is installing while the installer runs, and two presses start one installer', async () => {
    const ran = path.join(tmp, 'ran');
    const go = path.join(tmp, 'go');
    const slow = `echo x >> "${ran}"\nwhile [ ! -e "${go}" ]; do sleep 0.05; done\n${installer()}`;
    const s = setup({ bin: 'claude', env: bare, installer: async () => slow });
    const first = s.install();
    const second = s.install();
    await until(() => fs.existsSync(ran));
    expect(await s.look()).toEqual({ name: 'Claude Code', state: 'missing', installing: true });
    fs.writeFileSync(go, '');
    expect((await first).state).toBe('signed-out');
    expect((await second).state).toBe('signed-out');
    expect(fs.readFileSync(ran, 'utf8')).toBe('x\n');
  });
});

describe('the hosted link', () => {
  it('offers the setup of its own `claude`, in the environment the agent gets', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, { FAKE_CLAUDE_AUTH: auth, FAKE_CLAUDE_LOG: calls, CLAUDE_CONFIG_DIR: path.join(tmp, 'other'), ANTHROPIC_API_KEY: 'k', KEEL_STATE_DIR: tmp });
    try {
      const ctx: LinkContext = {
        repoDir: tmp,
        boardDir: path.join(tmp, BOARD_DIR),
        stateDir: path.join(tmp, 'state'),
        serverUrl: 'http://127.0.0.1:4999',
        agentToken: 't',
        options: { bin, mcp: FAKE },
        presence: () => {},
        log: () => {},
      };
      const link = await createLink(ctx);
      expect(await link.setup!.look()).toEqual({ name: 'Claude Code', state: 'signed-out' });
      const names = started()[0]!.env;
      expect(names).not.toContain('CLAUDE_CONFIG_DIR');
      expect(names).not.toContain('ANTHROPIC_API_KEY');
      expect(names).not.toContain('KEEL_STATE_DIR');
      await link.close();
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});
