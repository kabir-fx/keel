import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The real board server joined to the real builder, with no browser: the server's built
 * bundle, the plugin's hosted builder module, and the plugin's fake `claude` in place of the
 * model, so nothing costs money. Each world is a bare repository as the remote, the owner's
 * clone of it, another clone where "someone else" pushes, and a private state folder of its
 * own. Everything lives in one temp folder, which `cleanUp` takes away.
 *
 * Needs the server and plugin bundles: `npm run build -w @keel/board-server -w @keel/board-plugin`.
 */

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export const SERVER_BIN = here('../server/bin/keel-board.mjs');
export const HOSTED_BUILDER = here('../plugin/dist/hosted-builder.js');
export const FAKE_CLAUDE = here('../plugin/test/fake-builder-claude.mjs');
const NEEDED = [SERVER_BIN, here('../server/dist/keel-board.js'), HOSTED_BUILDER, here('../plugin/dist/board-mcp.js')];

/** What is missing before the server can run with the hosted builder, if anything. */
export const missingBundles = (): string | undefined => NEEDED.find((f) => !fs.existsSync(f));

/** The agreed check: every part's file is there and none says FAIL. */
export const CHECK = '! grep -rqs FAIL parts';
export const NODE = process.execPath;

export type Git = (...args: string[]) => string;

export interface World {
  root: string;
  remote: string;
  /** The owner's folder: a clone of the remote, on main, which follows origin/main. */
  repo: string;
  git: Git;
  other: string;
  otherGit: Git;
  stateDir: string;
  /** What the fake `claude` records, one JSON line per start, turn and tool call. */
  claudeLog: string;
  /** The `claude` the builder starts: the fake. */
  bin: string;
  /** The environment every git call and the server run with: no git config of the owner's. */
  env: NodeJS.ProcessEnv;
}

const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];

export function makeWorld(): World {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keel-join-')));
  const gitConfig = path.join(root, 'gitconfig');
  fs.writeFileSync(gitConfig, '');
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' };
  for (const k of Object.keys(env)) if (k.startsWith('KEEL_') || k.startsWith('FAKE_')) delete env[k];
  const gitIn = (dir: string): Git => (...args) => execFileSync('git', [...ID, ...args], { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  const remote = path.join(root, 'remote.git');
  fs.mkdirSync(remote);
  gitIn(remote)('init', '-q', '--bare', '-b', 'main');
  const other = path.join(root, 'other');
  fs.mkdirSync(other);
  const otherGit = gitIn(other);
  otherGit('init', '-q', '-b', 'main');
  writeFiles(other, { 'README.md': '# toy\n', '.gitignore': 'deps/\n' });
  otherGit('add', '.');
  otherGit('commit', '-q', '-m', 'first');
  otherGit('remote', 'add', 'origin', remote);
  otherGit('push', '-q', '-u', 'origin', 'main');
  const repo = path.join(root, 'demo');
  gitIn(root)('clone', '-q', remote, repo);

  const stateDir = path.join(root, 'state');
  const claudeLog = path.join(root, 'claude.log');
  const bin = path.join(root, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${NODE}" "${FAKE_CLAUDE}" "$@"\n`, { mode: 0o755 });
  return { root, remote, repo, git: gitIn(repo), other, otherGit, stateDir, claudeLog, bin, env };
}

export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
}

/** Someone else commits these files and pushes them to the remote. Returns the commit. */
export function remoteMoves(w: World, files: Record<string, string>, message = 'from elsewhere'): string {
  writeFiles(w.other, files);
  w.otherGit('add', '--', ...Object.keys(files));
  w.otherGit('commit', '-q', '-m', message);
  w.otherGit('push', '-q', 'origin', 'main');
  return w.otherGit('rev-parse', 'HEAD');
}

/** Is the process alive that said this is its pid? A process the board runs is in the box, where bwrap gives it a pid of its own. */
export { aliveInBox as alive } from '../plugin/test/box';

/** The processes whose command line names this world's folder. */
export function leftovers(w: World): string[] {
  const out = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout;
  return out.split('\n').filter((l) => l.includes(w.root) && !l.includes(' ps -axo'));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v !== undefined && v !== false) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`gave up waiting for ${what}${last ? `: ${last instanceof Error ? last.message : String(last)}` : ''}`);
    await sleep(100);
  }
}

/* ------------------------------------------------------------- the board */

export type Ev = { id: string; seq?: number; type: string; by: string; chapter?: string; canvas?: string; commit?: string; into?: string; kind?: string; text?: string; part?: string; state?: string };
export type ShowInfo = { kind: 'page'; url: string } | { kind: 'app'; run: string; state: string; url?: string; note?: string } | { kind: 'terminal'; run: string; state: string; code?: number | null };
export type Info = {
  builder?: string;
  build?: { chapter: string; state: string };
  works?: Record<string, { branch?: string; ahead?: number; behind?: number; busy?: string }>;
  shows?: Record<string, ShowInfo>;
  home?: { branch: string; commit?: string; upstream?: string; sync: string; ahead?: number; behind?: number; note?: string };
};
type Chapter = { id: string; state: string; canvas: string; merged?: { commit: string; into: string } };
export type State = { chapters: Record<string, Chapter>; canvasOrder: string[]; removedCanvases: Record<string, unknown>; feed: Array<{ chapter: string; kind: string; text: string; by: string }>; model: { parts: Record<string, { state: string }> } };

export interface Board {
  url: string;
  tokens: { owner: string; agent: string; system: string };
  /** What the server printed. */
  output(): string;
  info(): Promise<Info>;
  state(): Promise<State>;
  /** Post drafts as an actor. `ok` false with the refusal when a rule says no. */
  post(by: 'owner' | 'agent' | 'system', ...drafts: object[]): Promise<{ ok: boolean; status: number; body: { events?: Ev[]; rule?: string; reason?: string } }>;
  /** Post, and fail the test when it is refused. */
  must(by: 'owner' | 'agent' | 'system', ...drafts: object[]): Promise<Ev[]>;
  call(route: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
  log(): Ev[];
  stop(): Promise<void>;
}

/**
 * Start the real server on the world's folder, with the hosted builder and the fake `claude`.
 * `env` is added to the server's environment: the fake reads its `FAKE_*` settings from there.
 * `linkOpts` are the builder's options over the defaults, such as `app-wait` in seconds.
 */
export async function openBoard(w: World, env: Record<string, string> = {}, linkOpts: Record<string, string> = {}): Promise<Board> {
  const opts = { bin: w.bin, 'app-wait': '15', ...linkOpts };
  const args = [SERVER_BIN, 'open', w.repo, '--no-browser', '--port', '0', '--link', 'none', '--builder', HOSTED_BUILDER, ...Object.entries(opts).flatMap(([k, v]) => ['--link-opt', `${k}=${v}`])];
  const serverEnv = { ...w.env, KEEL_STATE_DIR: w.stateDir, FAKE_CLAUDE_LOG: w.claudeLog, ...env };
  const server: ChildProcess = spawn(NODE, args, { cwd: w.root, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stdout!.on('data', (d) => (out += String(d)));
  server.stderr!.on('data', (d) => (out += String(d)));
  const exited = new Promise<void>((r) => server.once('exit', () => r()));
  const page = await until('the server to print its address', () => {
    if (server.exitCode !== null) throw new Error(`the server stopped (${server.exitCode}):\n${out}`);
    return /http:\/\/127\.0\.0\.1:(\d+)\/\?code=([\w-]+)/.exec(out) ?? undefined;
  }, 30_000).catch(async (e: unknown) => {
    server.kill('SIGKILL');
    throw e;
  });
  const url = `http://127.0.0.1:${page[1]}`;
  const session = await fetch(`${url}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: page[2] }) });
  const owner = ((await session.json()) as { token: string }).token;
  const boards = path.join(w.stateDir, 'boards');
  const priv = JSON.parse(fs.readFileSync(path.join(boards, fs.readdirSync(boards)[0]!, 'board.json'), 'utf8')) as { running: { agentToken: string; systemToken: string } };
  const tokens = { owner, agent: priv.running.agentToken, system: priv.running.systemToken };

  const call = async (route: string, body?: unknown, token = owner) => {
    const r = await fetch(`${url}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await r.text();
    return { status: r.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
  };
  const post: Board['post'] = async (by, ...drafts) => {
    const r = await call('/api/events', { drafts }, tokens[by]);
    return { ok: r.status === 200, status: r.status, body: r.body as { events?: Ev[]; rule?: string; reason?: string } };
  };
  let stopped = false;
  return {
    url,
    tokens,
    output: () => out,
    info: async () => (await call('/api/board')).body as Info,
    state: async () => (await call('/api/state')).body as unknown as State,
    post,
    must: async (by, ...drafts) => {
      const r = await post(by, ...drafts);
      if (!r.ok) throw new Error(`refused (${r.status}): ${JSON.stringify(r.body)}`);
      return r.body.events ?? [];
    },
    call: (route, body) => call(route, body),
    log: () => readLog(w.repo),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (server.exitCode === null) {
        spawnSync(NODE, [SERVER_BIN, 'stop', w.repo], { env: serverEnv, encoding: 'utf8' });
        const within = (ms: number) => Promise.race([exited.then(() => true), sleep(ms).then(() => false)]);
        if (!(await within(30_000))) {
          server.kill('SIGTERM');
          if (!(await within(10_000))) server.kill('SIGKILL');
        }
      }
    },
  };
}

export function readLog(repo: string): Ev[] {
  const file = path.join(repo, '.keel', 'board', 'log.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Ev);
}

/** The private folder the builder keeps a canvas's copy in. */
export function copyOf(w: World, canvas: string): string {
  const boards = path.join(w.stateDir, 'boards');
  return path.join(boards, fs.readdirSync(boards)[0]!, 'builder', 'build', canvas, 'tree');
}

export interface IdeaPlan {
  chapter: string;
  title: string;
  /** The canvas it goes on. Opened first when `newCanvas`. Left out: the board's first canvas. */
  canvas?: string;
  newCanvas?: boolean;
  parts: string[];
  setup?: string;
  show?: { kind: 'app'; run: string } | { kind: 'terminal'; run: string } | { kind: 'page' };
}

/**
 * An idea, from a note to the owner's "Build this", posted live as the page and the agent
 * would: the note, the agent's parts and blueprint, Solidify, and the press with the check,
 * the setup and the show word for word.
 */
export async function buildIdea(b: Board, p: IdeaPlan): Promise<void> {
  const ch = p.chapter;
  if (p.newCanvas) await b.must('owner', { type: 'canvas.open', canvas: p.canvas });
  await b.must(
    'owner',
    { type: 'chapter.open', chapter: ch, title: p.title, ...(p.canvas ? { canvas: p.canvas } : {}) },
    { type: 'item.add', chapter: ch, item: { id: `${ch}-note`, kind: 'note', box: [0, 0, 200, 100], text: `I want ${p.title.toLowerCase()}` } },
  );
  await b.must('agent', { type: 'model.patch', chapter: ch, ops: p.parts.map((id) => ({ op: 'part.set', part: { id, name: `The ${id}`, plain: `the ${id} part` } })) });
  const terms = { check: CHECK, ...(p.setup ? { setup: p.setup } : {}), ...(p.show ? { show: p.show } : {}) };
  await b.must('agent', {
    type: 'item.add',
    chapter: ch,
    item: {
      id: `${ch}-bp`,
      kind: 'picture',
      answers: [`${ch}-note`],
      picture: { kind: 'blueprint', title: 'The blueprint', picks: [{ text: p.title, from: { item: `${ch}-note` } }], proof: ['It answers.'], parts: p.parts, ...terms },
    },
  });
  await b.must('owner', { type: 'solidify', chapter: ch, picks: [`${ch}-bp`], parts: p.parts });
  await b.must('owner', { type: 'build.start', chapter: ch, track: p.parts, blueprint: `${ch}-bp`, ...terms });
}

/** Wait until the chapter is built and the server's run has ended. */
export async function built(b: Board, chapter: string, ms = 90_000): Promise<void> {
  await until(`"${chapter}" to be built`, async () => {
    const s = await b.state();
    const c = s.chapters[chapter];
    const problem = s.feed.find((f) => f.chapter === chapter && f.kind === 'problem');
    if (problem) throw new Error(`the build of "${chapter}" said a problem: ${problem.text}`);
    if (c?.state !== 'built') return false;
    const i = await b.info();
    return i.build === undefined || i.build.chapter !== chapter;
  }, ms);
}

/** A websocket to the server, as the owner, that collects every message. */
export async function listen(b: Board, route: string): Promise<{ messages: Array<Record<string, unknown>>; ws: WebSocket; closed: Promise<void> }> {
  const ws = new WebSocket(`${b.url.replace('http', 'ws')}${route}${route.includes('?') ? '&' : '?'}token=${b.tokens.owner}`);
  const messages: Array<Record<string, unknown>> = [];
  ws.addEventListener('message', (e) => messages.push(JSON.parse(String(e.data)) as Record<string, unknown>));
  const closed = new Promise<void>((r) => ws.addEventListener('close', () => r()));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error(`the websocket ${route} did not open`)));
  });
  return { messages, ws, closed };
}

export function cleanUp(w: World): void {
  fs.rmSync(w.root, { recursive: true, force: true });
}
