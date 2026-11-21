import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSetup, LinkSetup } from '@keel/protocol';

/**
 * What the hosted agent needs on this machine: Claude Code, installed and signed in. The
 * owner's first page asks here, and each step is Claude Code's own: Anthropic's installer,
 * `claude auth status`, `claude auth login`.
 */

export const CLAUDE_NAME = 'Claude Code';
export const CLAUDE_INSTALLER = 'https://claude.ai/install.sh';

const STATUS_MS = 10_000;
const INSTALL_MS = 15 * 60_000;
const SIGN_IN_MS = 10 * 60_000;
/** How long a new sign-in is given to print its page's address before the answer goes back without one. */
const ADDRESS_MS = 5_000;
/** How long a pasted code is given to end the sign-in. */
const CODE_MS = 60_000;

function executable(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where the program is: a path as it is given, else the first on PATH, else `~/.local/bin`,
 * where Anthropic's installer puts it. That folder is on no PATH until the owner's next
 * terminal, so a Claude Code installed a minute ago is found there.
 */
export function findClaude(bin: string, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string | undefined {
  if (bin.includes('/') || bin.includes(path.sep)) return executable(bin) ? bin : undefined;
  for (const dir of [...(env.PATH ?? '').split(path.delimiter), path.join(home, '.local', 'bin')]) {
    if (dir && executable(path.join(dir, bin))) return path.join(dir, bin);
  }
  return undefined;
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');

/** What a program printed, as one plain line the page can show. */
function sentence(text: string, max = 300): string {
  const flat = text
    .replace(ANSI, '')
    .replace(/[^\P{Cc}\n\t]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

interface Ended {
  code: number | null;
  out: string;
  err: string;
}

interface SignIn {
  proc: ChildProcessWithoutNullStreams;
  url?: string;
  ended: Promise<Ended>;
}

export interface ClaudeSetupOptions {
  /** The `claude` command, as the link runs it. */
  bin: string;
  /** The environment Claude Code runs in: the one the agent gets, so the sign-in found is the agent's own. */
  env: () => NodeJS.ProcessEnv;
  log(message: string): void;
  home?: string;
  /** Fetch the installer's text. Default: `CLAUDE_INSTALLER`. */
  installer?: () => Promise<string>;
}

async function fetchInstaller(): Promise<string> {
  const res = await fetch(CLAUDE_INSTALLER, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${CLAUDE_INSTALLER} answered ${res.status}`);
  return res.text();
}

const within = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve(undefined), ms);
    t.unref();
    void p.then((v) => {
      clearTimeout(t);
      resolve(v);
    });
  });

export class ClaudeSetup implements LinkSetup {
  private installing: Promise<void> | undefined;
  private signing: SignIn | undefined;
  private note: string | undefined;

  constructor(private readonly opts: ClaudeSetupOptions) {}

  private find(): string | undefined {
    return findClaude(this.opts.bin, this.opts.env(), this.opts.home);
  }

  /** Run to the end, with a limit. It never rejects: a program that cannot start ends with its error as `err`. */
  private run(bin: string, args: string[], ms: number, input?: string): Promise<Ended> {
    return new Promise((resolve) => {
      const proc = spawn(bin, args, { env: this.opts.env(), stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => proc.kill('SIGKILL'), ms);
      proc.stdout.setEncoding('utf8').on('data', (c: string) => (out = (out + c).slice(-20_000)));
      proc.stderr.setEncoding('utf8').on('data', (c: string) => (err = (err + c).slice(-20_000)));
      proc.stdin.on('error', () => {});
      proc.on('error', (e) => (err = `${err}\n${e.message}`));
      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, out, err });
      });
      proc.stdin.end(input ?? '');
    });
  }

  /** False only when Claude Code says it is signed out. One too old to say is taken as signed in: its first turn will tell. */
  private async signedIn(bin: string): Promise<boolean> {
    const r = await this.run(bin, ['auth', 'status', '--json'], STATUS_MS);
    try {
      return (JSON.parse(r.out) as { loggedIn?: unknown }).loggedIn !== false;
    } catch {
      return true;
    }
  }

  async look(): Promise<AgentSetup> {
    const name = CLAUDE_NAME;
    const bin = this.find();
    if (!bin) return { name, state: 'missing', ...(this.installing ? { installing: true } : {}), ...(this.note ? { note: this.note } : {}) };
    if (await this.signedIn(bin)) {
      this.note = undefined;
      return { name, state: 'ready' };
    }
    const s = this.signing;
    return { name, state: 'signed-out', ...(s ? { signIn: s.url ? { url: s.url } : {} } : {}), ...(this.note ? { note: this.note } : {}) };
  }

  async install(): Promise<AgentSetup> {
    if (!this.find()) {
      this.installing ??= this.runInstaller().finally(() => {
        this.installing = undefined;
      });
      await this.installing;
    }
    return this.look();
  }

  private async runInstaller(): Promise<void> {
    this.note = undefined;
    let script: string;
    try {
      script = await (this.opts.installer ?? fetchInstaller)();
    } catch (e) {
      this.note = sentence(`The installer could not be fetched: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    this.opts.log(`installing ${CLAUDE_NAME} with Anthropic's installer`);
    const r = await this.run('bash', ['-s'], INSTALL_MS, script);
    if (this.find()) return;
    const said = sentence(r.err || r.out).slice(-200);
    this.note = sentence(`The installer ended (exit ${r.code ?? 'killed'}) and ${CLAUDE_NAME} is still not there${said ? `: ${said}` : '.'}`);
    this.opts.log(this.note);
  }

  async signIn(): Promise<AgentSetup> {
    this.stopSignIn();
    const bin = this.find();
    if (!bin) return this.look();
    this.note = undefined;
    const proc = spawn(bin, ['auth', 'login'], { env: this.opts.env(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let gotUrl: () => void = () => {};
    const address = new Promise<void>((resolve) => (gotUrl = resolve));
    const timer = setTimeout(() => {
      if (this.signing === s) this.note = 'The sign-in was not finished within ten minutes. Press Sign in again.';
      proc.kill('SIGTERM');
    }, SIGN_IN_MS);
    timer.unref();
    const ended = new Promise<Ended>((resolve) => {
      proc.on('error', (e) => (err = `${err}\n${e.message}`));
      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, out, err });
      });
    });
    const s: SignIn = { proc, ended };
    this.signing = s;
    proc.stdout.setEncoding('utf8').on('data', (c: string) => {
      out = (out + c).slice(-20_000);
      const url = /https:\/\/[^\s"'<>]+/.exec(out.replace(ANSI, ''))?.[0];
      if (url && !s.url) {
        s.url = url;
        gotUrl();
      }
    });
    proc.stderr.setEncoding('utf8').on('data', (c: string) => (err = (err + c).slice(-20_000)));
    proc.stdin.on('error', () => {});
    void ended.then((r) => {
      // One this object stopped itself, to start another or because the board closes, says nothing.
      if (this.signing !== s) return;
      this.signing = undefined;
      if (r.code !== 0 && !this.note) this.note = sentence(r.err || r.out) || `The sign-in ended (exit ${r.code ?? 'killed'}). Press Sign in again.`;
    });
    this.opts.log(`started a ${CLAUDE_NAME} sign-in, pid ${proc.pid ?? '?'}`);
    await within(Promise.race([address, ended]), ADDRESS_MS);
    return this.look();
  }

  async code(code: string): Promise<AgentSetup> {
    const s = this.signing;
    if (!s) {
      this.note = 'No sign-in is running. Press Sign in first.';
      return this.look();
    }
    s.proc.stdin.write(`${code.trim()}\n`);
    await within(s.ended, CODE_MS);
    return this.look();
  }

  private stopSignIn(): void {
    const s = this.signing;
    this.signing = undefined;
    s?.proc.kill('SIGTERM');
  }

  /** A sign-in that still runs ends with the board: the server's close waits until it is gone. */
  async close(): Promise<void> {
    const s = this.signing;
    this.stopSignIn();
    if (s && !(await within(s.ended, 3000))) s.proc.kill('SIGKILL');
  }
}
