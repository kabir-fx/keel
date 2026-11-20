import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { WebSocket } from 'ws';
import type { BoardEvent, DigestReply, Refusal, ServerMessage } from '@keel/protocol';
import { BOARD_DIR, ROUTES, formatEvent } from '@keel/protocol';
import type { BuildInfo } from './build';
import { parseLinkOptions } from './link';
import { BoardBusyError, lockHolder, privatePlace } from './private';
import type { BoardInfoReply, RunningServer } from './server';
import { startServer } from './server';
import type { FoundServer } from './serverfile';
import { findBoardDir, findServer, removeStaleServerFile } from './serverfile';
import { oneLine, plain } from './text';

/**
 * keel-board: one command per board.
 *
 *   [open] [dir] [--port n] [--link x] [--link-opt k=v] [--builder x] [--no-browser] [--app-dir d] [--dev-origin o]
 *   status [dir] · stop [dir] · read [dir] [--since n] · tail [dir]
 *   post --as agent|system <json | @file | ->   (the board is found from --dir, else from here)
 */

export interface Io {
  out(line: string): void;
  err(line: string): void;
  /** Standard input, for `post -`. */
  stdin?(): Promise<string>;
}

/** What the command reaches outside itself, so a test can stand in for it. */
export interface RunDeps {
  /**
   * Open an address in the owner's browser. `background`: leave it behind what the owner is
   * doing, where the system allows. Default: the system's opener.
   */
  browse?: (url: string, background: boolean) => void;
  /** The owner's home folder, where `open` refuses to start. Default: `os.homedir()`. */
  home?: string;
  /** The `PATH` to look for Claude Code on. Default: `$PATH`. */
  searchPath?: string;
}

export interface RunResult {
  code: number;
  /** Set by `open` when it started a server: the caller keeps it running and stops it. */
  server?: RunningServer;
}

const consoleIo: Io = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  stdin: async () => {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  },
};

/**
 * The link when the owner names none: `$KEEL_BOARD_LINK`, else the hosted agent that ships
 * beside this server when it is built, else none. So one command gives a board with an agent.
 */
export function defaultLink(env: NodeJS.ProcessEnv = process.env): string {
  if (env.KEEL_BOARD_LINK) return env.KEEL_BOARD_LINK;
  const bundled = hostedLink();
  return fs.existsSync(bundled) ? bundled : 'none';
}

/** The hosted agent that ships beside this server when it is built. */
function hostedLink(): string {
  return fileURLToPath(new URL('../../plugin/dist/hosted-link.js', import.meta.url));
}

/**
 * The first executable file called `name` in a `PATH` string, or undefined. A plain scan of
 * the folders: no process is started. An empty entry is skipped.
 */
export function findOnPath(name: string, searchPath: string | undefined): string | undefined {
  for (const dir of (searchPath ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try {
      if (!fs.statSync(file).isFile()) continue;
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

export const NO_CLAUDE =
  'keel-board: Claude Code was not found on your PATH. The board opens, but the agent will not answer until Claude Code is installed and signed in. Get it from https://claude.com/claude-code';

/** Why a board cannot be opened in this folder, or undefined when it can. */
function tooWide(realDir: string, home: string): string | undefined {
  let realHome = path.resolve(home);
  try {
    realHome = fs.realpathSync(home);
  } catch {
    // A home that is not there matches nothing.
  }
  const what = realDir === realHome ? 'your home folder' : path.parse(realDir).root === realDir ? 'the root of the file system' : undefined;
  if (!what) return undefined;
  return `keel-board: this is ${what}. The agent can read every file in the folder a board is opened in, so open the board in a folder for the idea: mkdir my-idea && cd my-idea && keel-board`;
}

const USAGE = `keel-board: the board server for one repository.
With no command, keel-board opens a board for the folder you are in, like "keel-board open".

  keel-board [open] [dir] [--port n] [--link none|script:<module>|<module>] [--link-opt key=value]
                    [--builder none|<module>] [--no-browser] [--app-dir <folder>] [--dev-origin <origin>]
  keel-board status [dir]
  keel-board link [dir]
  keel-board stop [dir]
  keel-board post --as agent|system <json | @file | ->  [--dir <dir>]
  keel-board read [dir] [--since n]
  keel-board tail [dir]

The board lives in <dir>/.keel/board. The owner works through the page that "open" prints.
The address it prints works once, for five minutes: the page trades it for a token that
lasts until the server stops. "link" prints a fresh address, for a second tab or a new start.
With no --link, the agent is the one that ships with keel (a headless Claude Code process on
your own sign-in), or $KEEL_BOARD_LINK when that is set. --link none runs no agent.
The builder writes the code when the owner presses "Build this": the --link module's
createBuilder, or the module --builder names. --builder none runs no builder.
A finished build with a page to show opens it in your browser, from an address of its own;
with --no-browser, nothing opens by itself.
The tokens and the port stay outside the repository, in ~/.keel/boards/ (or
$KEEL_STATE_DIR/boards/). The tokens are new for each start. Without --port, the board
takes the port it had last time. A build runs only after you press "Build this" or Resume
on this machine: a log that came with the repository starts nothing.`;

export async function run(argv: readonly string[], raw: Io = consoleIo, deps: RunDeps = {}): Promise<RunResult> {
  // What the command prints can come from a board, a folder name or the agent: no control characters.
  const io: Io = { out: (l) => raw.out(plain(l)), err: (l) => raw.err(plain(l)), ...(raw.stdin ? { stdin: raw.stdin } : {}) };
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    return { code: 2 };
  }
  const { values, positionals } = parsed;
  // No command word means "open": `keel-board` alone opens the folder it runs in.
  const [command = 'open', ...rest] = positionals;
  if (values.help || command === 'help') {
    io.out(USAGE);
    return { code: 0 };
  }
  try {
    switch (command) {
      case 'open':
        return await open(rest[0] ?? values.dir ?? '.', values, io, deps);
      case 'status':
        return { code: await status(boardDirOf(rest[0] ?? values.dir), io) };
      case 'link':
        return { code: await link(boardDirOf(rest[0] ?? values.dir), io) };
      case 'stop':
        return { code: await stop(boardDirOf(rest[0] ?? values.dir), io) };
      case 'post':
        return { code: await post(boardDirOf(values.dir), values.as ?? 'agent', rest[0], io) };
      case 'read':
        return { code: await read(boardDirOf(rest[0] ?? values.dir), values.since, io) };
      case 'tail':
        return { code: await tail(boardDirOf(rest[0] ?? values.dir), io) };
      default:
        io.err(`Unknown command "${command}".\n\n${USAGE}`);
        return { code: 2 };
    }
  } catch (e) {
    io.err(`keel-board ${command}: ${e instanceof Error ? e.message : String(e)}`);
    return { code: 1 };
  }
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      port: { type: 'string' },
      link: { type: 'string' },
      'link-opt': { type: 'string', multiple: true },
      builder: { type: 'string' },
      'no-browser': { type: 'boolean' },
      'app-dir': { type: 'string' },
      'dev-origin': { type: 'string' },
      as: { type: 'string' },
      since: { type: 'string' },
      dir: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}

type Values = ReturnType<typeof parse>['values'];

function boardDirOf(dir: string | undefined): string {
  return findBoardDir(dir ?? process.cwd());
}

/* ---------------------------------------------------------------- open */

/**
 * A fresh address for the owner's page, asked of the running server with the system token
 * from the board's private file. The address holds a code that works once, never a token.
 */
async function freshLink(f: FoundServer): Promise<string | undefined> {
  try {
    const { status, body } = await call<{ url?: string }>(f, f.tokens.system, ROUTES.link, { method: 'POST', body: '{}' });
    return status === 200 && typeof body.url === 'string' ? body.url : undefined;
  } catch {
    return undefined;
  }
}

/** The owner's page on a server that already runs: a fresh address, when the server answers as this board's own. */
async function alreadyRuns(repoDir: string, port: number | undefined, io: Io, found?: FoundServer): Promise<RunResult> {
  io.err(port ? `A board server already runs for ${oneLine(repoDir)}, on port ${port}.` : `A board server is starting for ${oneLine(repoDir)}.`);
  const f = found ?? (await findServer(path.join(repoDir, BOARD_DIR)));
  const url = f ? await freshLink(f) : undefined;
  if (url) io.out(url);
  return { code: 0 };
}

/** `keel-board link`: a fresh address for the owner's page, for a second tab or after the first one was closed. */
async function link(boardDir: string, io: Io): Promise<number> {
  const f = await need(boardDir, io);
  if (!f) return 1;
  const url = await freshLink(f);
  if (!url) {
    io.err(`The board server on port ${f.port} gave no address.`);
    return 1;
  }
  io.err('This address works once, for five minutes. The page keeps you signed in until the server stops.');
  io.out(url);
  return 0;
}

async function open(dir: string, values: Values, io: Io, deps: RunDeps): Promise<RunResult> {
  const browse = deps.browse ?? openBrowser;
  const repoDir = path.resolve(dir);
  if (!fs.statSync(repoDir, { throwIfNoEntry: false })?.isDirectory()) {
    io.err(`keel-board open: ${oneLine(repoDir)} is not a folder.`);
    return { code: 1 };
  }
  // The agent reads the whole folder: never the home folder or the root.
  const wide = tooWide(fs.realpathSync(repoDir), deps.home ?? os.homedir());
  if (wide) {
    io.err(wide);
    return { code: 2 };
  }
  const running = await findServer(path.join(repoDir, BOARD_DIR));
  if (running) return alreadyRuns(repoDir, running.port, io, running);

  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    io.err(`keel-board open: --port takes a number from 0 to 65535.`);
    return { code: 2 };
  }

  const linkSpec = values.link ?? defaultLink();
  const linkOptions = parseLinkOptions(values['link-opt'] ?? []);
  // The hosted agent runs `claude`. Without it the board still opens: say so once, before the address.
  if (path.resolve(linkSpec) === hostedLink() && linkOptions.bin === undefined && !findOnPath('claude', deps.searchPath ?? process.env.PATH)) {
    io.err(NO_CLAUDE);
  }

  let server: RunningServer;
  try {
    server = await startServer({
      repoDir,
      port,
      link: linkSpec,
      linkOptions,
      builder: values.builder,
      appDir: values['app-dir'],
      devOrigin: values['dev-origin'],
      log: (m) => io.err(`keel-board: ${m}`),
      // A finished build's page opens by itself, behind what the owner is doing. Not with --no-browser.
      ...(values['no-browser'] ? {} : { openShow: (url: string) => browse(url, true) }),
    });
  } catch (e) {
    if (e instanceof BoardBusyError) return alreadyRuns(repoDir, e.port, io);
    throw e;
  }

  const s = server.board.state;
  io.err(`Board "${oneLine(s.name)}" · e${s.seq} · agent: ${oneLine(server.linkName)} · builder: ${oneLine(server.builderName)} · ${oneLine(server.board.dir)}`);
  io.out(server.url);
  if (!values['no-browser']) browse(server.url, false);
  return { code: 0, server };
}

/** Open an address with the system's opener. On macOS, `background` keeps the browser from coming to the front (`open -g`). */
function openBrowser(url: string, background = false): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', background ? ['-g', url] : [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // No browser: the URL is printed.
  }
}

/* ---------------------------------------------------- the other commands */

/** The board's server, found through the board's private file, when it answers as this board's own. */
async function need(boardDir: string, io: Io): Promise<FoundServer | undefined> {
  const f = await findServer(boardDir);
  if (!f) io.err(`No board server runs for ${oneLine(path.dirname(path.dirname(boardDir)))}. Start one with "keel-board open".`);
  return f;
}

function originOf(f: { port: number }): string {
  return `http://127.0.0.1:${f.port}`;
}

async function call<T>(f: { port: number }, token: string, route: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${originOf(f)}${route}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function status(boardDir: string, io: Io): Promise<number> {
  const f = await need(boardDir, io);
  if (!f) return 1;
  const { body: b } = await call<BoardInfoReply>(f, f.tokens.system, ROUTES.board);
  const p = b.presence;
  // Each field on its one line: a board's name or the agent's words cannot add a line of their own.
  io.out(`running  pid ${f.pid} · ${originOf(f)} · since ${oneLine(f.startedAt)}`);
  io.out(`board    ${oneLine(b.name)} · e${b.seq} · ${b.open} open`);
  io.out(`agent    ${oneLine(b.link)} · ${p.state}${p.note ? ` (${oneLine(p.note)})` : ''}`);
  io.out(`builder  ${oneLine(b.builder ?? 'none')} · ${oneLine(buildLine(b.build, b.builder ?? 'none'))}`);
  // No token and no code here: "link" prints an address that works once.
  io.out(`page     ${originOf(f)}/  ("keel-board link" prints an address that opens it)`);
  return 0;
}

/** How far the build is, in one line. */
export function buildLine(b: BuildInfo | undefined, builder: string): string {
  if (!b) return 'nothing to build';
  const tally = `${b.built} of ${b.total} parts built`;
  if (builder === 'none') return `"${b.title}" is building, ${tally}, but no builder is linked`;
  switch (b.state) {
    case 'running':
      return `building "${b.title}": ${tally}${b.part ? `, now ${b.part}` : ''}`;
    case 'queued':
      return `"${b.title}" waits its turn: ${tally}`;
    case 'waiting':
      return `"${b.title}" waits for you: a part on its track is an idea again. ${tally}`;
    case 'paused':
      return `"${b.title}" is paused: ${tally}`;
    case 'stopped':
      return `"${b.title}" stopped: ${tally}. Pause and resume it to try again`;
    case 'unagreed':
      return `"${b.title}" is building in the log, but you have not agreed to it on this machine: nothing runs until you press Resume${b.check ? `. Its check: ${b.check}` : ''}`;
  }
}

/**
 * Ask the server to stop, over `ROUTES.stop` with the system token from the private file. A
 * pid read from `server.json` is never signalled: the file can be forged. When no server
 * answers and none holds the lock, a `server.json` left behind is removed.
 */
async function stop(boardDir: string, io: Io): Promise<number> {
  const f = await findServer(boardDir);
  if (!f) {
    const place = privatePlace(boardDir);
    const holder = place ? lockHolder(place) : undefined;
    if (holder === undefined && removeStaleServerFile(boardDir)) io.out('No board server runs for this board. Removed a stale server.json.');
    else io.out('No board server runs for this board.');
    return 0;
  }
  let code = 0;
  try {
    ({ status: code } = await call<{ stopping?: boolean }>(f, f.tokens.system, ROUTES.stop, { method: 'POST', body: '{}' }));
  } catch (e) {
    io.err(`The board server on port ${f.port} did not take the stop: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (code !== 200) {
    io.err(`The board server on port ${f.port} refused to stop (HTTP ${code}).`);
    return 1;
  }
  const place = privatePlace(boardDir);
  for (let i = 0; i < 100; i++) {
    const held = place ? lockHolder(place) !== undefined : false;
    if (!held && !(await findServer(boardDir, { timeoutMs: 500 }))) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (await findServer(boardDir, { timeoutMs: 500 })) {
    io.err(`The board server on port ${f.port} did not stop within 5 s.`);
    return 1;
  }
  io.out(`Stopped the board server on port ${f.port}.`);
  return 0;
}

async function post(boardDir: string, as: string, input: string | undefined, io: Io): Promise<number> {
  if (as !== 'agent' && as !== 'system') {
    io.err(as === 'owner' ? 'The owner posts through the page, not from the command line.' : '--as takes agent or system.');
    return 2;
  }
  if (input === undefined) {
    io.err('Give the drafts: a JSON value, @file, or - for standard input.');
    return 2;
  }
  let text: string;
  if (input === '-') text = (await io.stdin?.()) ?? '';
  else if (input.startsWith('@')) text = fs.readFileSync(path.resolve(input.slice(1)), 'utf8');
  else text = input;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    io.err('The drafts are not JSON.');
    return 2;
  }
  const drafts = Array.isArray(value)
    ? value
    : typeof value === 'object' && value !== null && Array.isArray((value as { drafts?: unknown }).drafts)
      ? (value as { drafts: unknown[] }).drafts
      : [value];

  const f = await need(boardDir, io);
  if (!f) return 1;
  const { status: code, body } = await call<{ events?: BoardEvent[]; error?: string } & Partial<Refusal>>(
    f,
    f.tokens[as],
    ROUTES.events,
    { method: 'POST', body: JSON.stringify({ drafts }) },
  );
  if (code === 200) {
    for (const ev of body.events ?? []) io.out(`${ev.id} ${ev.type}`);
    return 0;
  }
  if (body.rule) io.err(`Refused under ${body.rule}${body.index !== undefined ? ` (draft ${body.index})` : ''}: ${oneLine(body.reason ?? '')}`);
  else io.err(`Refused: ${oneLine(body.error ?? `HTTP ${code}`)}`);
  return 1;
}

async function read(boardDir: string, since: string | undefined, io: Io): Promise<number> {
  const f = await need(boardDir, io);
  if (!f) return 1;
  const q = since !== undefined ? `?since=${encodeURIComponent(since)}` : '';
  const { body } = await call<DigestReply>(f, f.tokens.agent, `${ROUTES.digest}${q}`);
  io.out(body.text);
  return 0;
}

async function tail(boardDir: string, io: Io): Promise<number> {
  const f = await need(boardDir, io);
  if (!f) return 1;
  const ws = new WebSocket(`ws://127.0.0.1:${f.port}${ROUTES.ws}?token=${encodeURIComponent(f.tokens.system)}`);
  return new Promise<number>((resolve) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ServerMessage;
      if (msg.t === 'init') {
        for (const ev of msg.events.slice(-10)) io.out(formatEvent(ev));
        io.err(`# following ${oneLine(msg.name)}. Stop with Ctrl-C.`);
      } else if (msg.t === 'event') {
        io.out(formatEvent(msg.event));
      } else if (msg.t === 'presence') {
        io.err(`# presence ${msg.presence.state}${msg.presence.note ? `: ${oneLine(msg.presence.note)}` : ''}`);
      }
    });
    ws.on('close', () => resolve(0));
    ws.on('error', (e) => {
      io.err(`keel-board tail: ${e.message}`);
      resolve(1);
    });
  });
}
