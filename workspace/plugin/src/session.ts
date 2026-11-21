import type { ChildProcess } from 'node:child_process';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { RunShow, ShowSession } from '@keel/protocol';
import { sandboxPlan } from './sandbox';

/**
 * A command that runs to show a built chapter (record 0013): an app, or a terminal. It runs in
 * the build's copy, boxed in like the check, with the network on. It starts only when the board
 * server asks, on the owner's press, and `stop` ends it with everything it started.
 *
 * The terminal needs a pty, and the package ships no native module: the system's `script`
 * makes one. On macOS `script` refuses a socket on its input, and the pipes Node gives a child
 * are sockets, so the input goes through `cat`, which hands `script` a real pipe. Where there is
 * no `script`, the shell runs on pipes, and its first line says so.
 */

export interface ShowPlaces {
  /** The board's folder in the copy: where the command runs. */
  workdir: string;
  /** The copy's top: what the command may write. */
  tree: string;
  denyRead: string[];
  /** A folder for the pid files of the shows that run, so a crash leaves none behind. */
  pids: string;
}

export interface ShowHandlers {
  onOutput(chunk: string): void;
  onExit(code: number | null): void;
}

/** How long an app has to answer on its port. */
export const APP_WAIT_MS = 60_000;

export const NO_PTY_LINE = 'No terminal program here (the system has no `script` command), so this runs on plain pipes: line tools work, full-screen ones do not.';

/* --------------------------------------------------------------- processes */

type Proc = { pid: number; ppid: number; pgid: number; tty: string };

function processes(): Promise<Proc[]> {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,pgid=,tty='], (err, out) => {
      if (err) return resolve([]);
      resolve(
        out
          .split('\n')
          .map((l) => l.trim().split(/\s+/))
          .filter((f) => f.length >= 3)
          .map(([pid, ppid, pgid, tty]) => ({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), tty: tty ?? '' })),
      );
    });
  });
}

/** A process and every process under it, and the groups they are in. */
async function treeOf(root: number): Promise<{ pids: Set<number>; groups: Set<number>; all: Proc[] }> {
  const all = await processes();
  const pids = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of all) {
      if (pids.has(p.ppid) && !pids.has(p.pid)) {
        pids.add(p.pid);
        grew = true;
      }
    }
  }
  const own = process.pid;
  const mine = all.find((p) => p.pid === own)?.pgid;
  const groups = new Set(all.filter((p) => pids.has(p.pid) && p.pgid > 1 && p.pgid !== mine).map((p) => p.pgid));
  groups.add(root);
  return { pids, groups, all };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const send = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(pid, signal);
  } catch {
    // Gone already.
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * End a process, everything under it and every process in their groups: `script` puts its
 * shell in a session of its own, and a dev server's children may leave their parent. It asks
 * first, then kills what is left after `graceMs`, and resolves when none of them is there.
 */
export async function endTree(root: number, graceMs = 3000): Promise<void> {
  const { pids, groups, all } = await treeOf(root);
  const members = () => new Set([...pids, ...all.filter((p) => groups.has(p.pgid)).map((p) => p.pid)]);
  const known = members();
  for (const g of groups) send(-g, 'SIGTERM');
  for (const p of known) send(p, 'SIGTERM');
  const gone = async (ms: number) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if ([...known].every((p) => !alive(p))) return true;
    return [...known].every((p) => !alive(p));
  };
  if (await gone(graceMs)) return;
  for (const g of groups) send(-g, 'SIGKILL');
  for (const p of known) send(p, 'SIGKILL');
  await gone(5000);
}

/** When a process started, as `ps` says it: a pid file names a process, and a pid is used again. */
function startedAt(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'lstart=', '-p', String(pid)], (err, out) => resolve(err ? undefined : out.trim() || undefined));
  });
}

async function writePid(dir: string, pid: number): Promise<string | undefined> {
  const file = path.join(dir, String(pid));
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, (await startedAt(pid)) ?? '', { mode: 0o600 });
    return file;
  } catch {
    return undefined;
  }
}

/** End the shows a crash left running, from their pid files in `dir`. A pid now used by another process is left alone. */
export async function endLeftoverShows(dir: string): Promise<number> {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  let ended = 0;
  for (const n of names) {
    const pid = Number(n);
    const file = path.join(dir, n);
    let was = '';
    try {
      was = fs.readFileSync(file, 'utf8').trim();
    } catch {
      // Read as empty: nothing to match, nothing is ended.
    }
    if (Number.isInteger(pid) && pid > 1 && was && (await startedAt(pid)) === was) {
      await endTree(pid);
      ended++;
    }
    fs.rmSync(file, { force: true });
  }
  return ended;
}

/* ------------------------------------------------------------------- ports */

/** Does something answer a connection on 127.0.0.1 at `port`? */
function connects(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.setTimeout(1000);
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
    s.once('timeout', () => {
      s.destroy();
      resolve(false);
    });
  });
}

/** Listen on 127.0.0.1 at `port` for a moment: the port it got, or undefined when it is taken. */
function bindOnce(port: number): Promise<number | undefined> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(undefined));
    s.listen(port, '127.0.0.1', () => {
      const got = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(got));
    });
  });
}

export class PortTakenError extends Error {
  override name = 'PortTakenError';
  constructor(readonly port: number) {
    super(`Port ${port} is in use by another program.`);
  }
}

/** The port the app gets: its fixed one when it is free, else a free one. */
async function portFor(fixed: number | undefined): Promise<number> {
  if (fixed !== undefined) {
    if ((await connects(fixed)) || (await bindOnce(fixed)) === undefined) throw new PortTakenError(fixed);
    return fixed;
  }
  const got = await bindOnce(0);
  if (got === undefined) throw new Error('No free port on 127.0.0.1.');
  return got;
}

/** Does an HTTP server answer at the address? Any answer counts, an error page too. */
function answers(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 1000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.once('error', () => resolve(false));
    req.once('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/* ---------------------------------------------------------------- sessions */

/** One running command: its process, its temp folder, its pid file, and one call of `onExit`. */
class Running {
  exited = false;
  code: number | null = null;
  private readonly done: Promise<void>;
  private told = false;
  private stopping: Promise<void> | undefined;

  constructor(
    readonly proc: ChildProcess,
    private readonly tmp: string,
    private readonly pidFile: Promise<string | undefined>,
    private readonly h: ShowHandlers,
  ) {
    this.done = new Promise((resolve) => {
      proc.once('error', (e) => {
        h.onOutput(`${e.message}\r\n`);
        this.end(127);
        resolve();
      });
      proc.once('close', (code) => {
        this.end(code);
        resolve();
      });
    });
  }

  /** The command is over: say so once, and take its files away. */
  end(code: number | null): void {
    this.exited = true;
    if (this.told) return;
    this.told = true;
    this.code = code;
    this.h.onExit(code);
    void this.pidFile.then((f) => f && fs.rmSync(f, { force: true }));
    fs.rmSync(this.tmp, { recursive: true, force: true });
  }

  wait(): Promise<void> {
    return this.done;
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      if (this.proc.pid) await endTree(this.proc.pid);
      await this.done;
    })();
    return this.stopping;
  }
}

function decoder(onText: (s: string) => void): (b: Buffer) => void {
  const d = new StringDecoder('utf8');
  return (b) => {
    const s = d.write(b);
    if (s) onText(s);
  };
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function onPath(bin: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return path.join(dir, bin);
    } catch {
      // Not here.
    }
  }
  return undefined;
}

/** The `script` this machine has: the BSD one on a Mac, util-linux elsewhere. */
function scriptKind(): { bin: string; kind: 'bsd' | 'linux' } | undefined {
  const bin = onPath('script');
  if (!bin) return undefined;
  return { bin, kind: process.platform === 'linux' ? 'linux' : 'bsd' };
}

const clampSize = (n: number | undefined, d: number) => (Number.isInteger(n) && n! >= 2 && n! <= 1000 ? n! : d);

function tempDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keel-show-')));
}

/**
 * Start an app: `run` with `PORT` set, boxed in with the network on, in the copy. `ready`
 * resolves with its address once it answers there. It rejects with a sentence for the owner
 * when the command ends first or the wait runs out, and then the app is stopped. A fixed port
 * that is taken is refused before anything starts (`PortTakenError`).
 */
export async function startApp(plan: Extract<RunShow, { kind: 'app' }>, places: ShowPlaces, h: ShowHandlers, waitMs = APP_WAIT_MS): Promise<ShowSession> {
  const port = await portFor(plan.port);
  const tmp = tempDir();
  const box = sandboxPlan(plan.run, { workdir: places.tree, tmp, denyRead: places.denyRead, denyWrite: [path.join(places.tree, '.git')], network: true });
  const env = { ...box.env, PORT: String(port), HOST: '127.0.0.1' };
  const proc = spawn(box.bin, box.args, { cwd: places.workdir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true });
  const run = new Running(proc, tmp, proc.pid ? writePid(places.pids, proc.pid) : Promise.resolve(undefined), h);
  const out = decoder(h.onOutput);
  proc.stdout!.on('data', out);
  proc.stderr!.on('data', out);
  const url = `http://127.0.0.1:${port}/`;
  const ready = (async () => {
    const end = Date.now() + waitMs;
    while (!run.exited) {
      if (await answers(url)) return url;
      if (Date.now() >= end) {
        await run.stop();
        throw new Error(`The app did not answer on port ${port} within ${Math.round(waitMs / 1000)} s.`);
      }
      await Promise.race([sleep(250), run.wait()]);
    }
    throw new Error(`The app ended before it answered (exit ${run.code ?? 'by a signal'}).`);
  })();
  ready.catch(() => undefined);
  return { ready, write: () => undefined, resize: () => undefined, stop: () => run.stop(), ...(box.kind === 'none' ? { boxed: false as const } : {}) };
}

/**
 * Open a terminal in the copy: an interactive shell, boxed in with the network on, with `run`
 * typed in once the shell has printed its prompt. Its size is set when it starts. A later
 * change of size is best effort: `stty` on its pty from outside, which the shell hears.
 */
export async function startTerminal(plan: Extract<RunShow, { kind: 'terminal' }>, places: ShowPlaces, h: ShowHandlers, size: { cols?: number; rows?: number } = {}): Promise<ShowSession> {
  const cols = clampSize(size.cols, 80);
  const rows = clampSize(size.rows, 24);
  const tmp = tempDir();
  const script = scriptKind();
  const shell = 'exec /bin/sh -i';
  const inner = script ? `stty rows ${rows} cols ${cols} 2>/dev/null; ${shell}` : shell;
  const box = sandboxPlan(inner, { workdir: places.tree, tmp, denyRead: places.denyRead, denyWrite: [path.join(places.tree, '.git')], network: true });
  const env: NodeJS.ProcessEnv = { ...box.env, PS1: '$ ', HISTFILE: '/dev/null', TERM: script ? 'xterm-256color' : 'dumb', COLUMNS: String(cols), LINES: String(rows) };

  let proc: ChildProcess;
  if (script) {
    const cmd = [box.bin, ...box.args];
    // `script`'s exit code comes back on fd 3, and then `cat` is let go.
    const pty = script.kind === 'bsd' ? `"$SCRIPT" -q /dev/null "$@"` : `"$SCRIPT" -qfec "$KEEL_CMD" /dev/null`;
    const wrap = `cat | { ${pty}; s=$?; printf '%s\\n' "$s" >&3; exit $s; }`;
    proc = spawn('/bin/sh', ['-c', wrap, 'sh', ...cmd], {
      cwd: places.workdir,
      env: { ...env, SCRIPT: script.bin, ...(script.kind === 'linux' ? { KEEL_CMD: cmd.map(quote).join(' ') } : {}) },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      detached: true,
      windowsHide: true,
    });
  } else {
    proc = spawn(box.bin, box.args, { cwd: places.workdir, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true, windowsHide: true });
  }
  const run = new Running(proc, tmp, proc.pid ? writePid(places.pids, proc.pid) : Promise.resolve(undefined), h);
  proc.stdin!.on('error', () => undefined);
  const crlf = (s: string) => (script ? s : s.replace(/\r?\n/g, '\r\n'));
  if (!script) h.onOutput(`${NO_PTY_LINE}\r\n`);

  let typed = false;
  const type = () => {
    if (typed || run.exited) return;
    typed = true;
    write(`${plan.run}\r`);
  };
  const out = decoder((s) => {
    h.onOutput(crlf(s));
    type();
  });
  proc.stdout!.on('data', out);
  proc.stderr!.on('data', out);
  setTimeout(type, 500).unref();
  if (script) {
    const code = decoder((s) => {
      const n = Number(s.trim());
      run.end(Number.isInteger(n) ? n : null);
      proc.stdin!.end();
    });
    (proc.stdio[3] as NodeJS.ReadableStream).on('data', code);
  }

  function write(data: string): void {
    if (run.exited) return;
    if (script) {
      proc.stdin!.write(data);
      return;
    }
    h.onOutput(data.replace(/\r\n?|\n/g, '\r\n'));
    proc.stdin!.write(data.replace(/\r\n?/g, '\n'));
  }

  const resize = (c: number, r: number) => {
    if (!script || run.exited || !proc.pid) return;
    void treeOf(proc.pid).then(({ pids, all }) => {
      const tty = all.find((p) => pids.has(p.pid) && p.tty && !p.tty.startsWith('?'))?.tty;
      if (!tty) return;
      const dev = tty.startsWith('/') ? tty : `/dev/${tty}`;
      execFile('stty', [process.platform === 'linux' ? '-F' : '-f', dev, 'rows', String(clampSize(r, rows)), 'cols', String(clampSize(c, cols))], () => undefined);
    });
  };
  return { write, resize, stop: () => run.stop(), ...(box.kind === 'none' ? { boxed: false as const } : {}) };
}
