import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Start the real board server on a fresh repository folder, for a browser test. */

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export const BIN = here('../server/bin/keel-board.mjs');
export const APP = here('../app/dist');
export const ECHO = here('./agents/echo.mjs');
/** A stand-in agent that draws a model from a note and reads a solidified idea back as a blueprint. */
export const PLANNER = here('./agents/planner.mjs');
/** A scripted builder that commits each part in its own git worktree. */
export const BUILDER = here('./agents/builder.mjs');
export const HOSTED = here('../plugin/dist/hosted-link.js');
export const SHOTS = here('./shots');

export const appIsBuilt = () => existsSync(join(APP, 'index.html'));

export interface RunningBoard {
  /** An address for the owner's page, with a code that works once. Each read gives a fresh one. It holds no token. */
  readonly url: string;
  /** The repository folder the board lives in. */
  repo: string;
  /** What the server has printed so far. */
  output: () => string;
  /** Stop the server, wait until it has closed (a running agent turn is let to finish), and remove its folders. */
  stop: () => Promise<void>;
}

export async function startBoard(opts: {
  link: string;
  /** A module that exports createBuilder, for "Build this". */
  builder?: string;
  /** Make the folder a git repository with one commit, so a builder's commits are real. */
  git?: boolean;
  name?: string;
  linkOptions?: Record<string, string>;
  files?: Record<string, string>;
}): Promise<RunningBoard> {
  mkdirSync(SHOTS, { recursive: true });
  const repo = join(mkdtempSync(join(tmpdir(), 'keel-live-')), opts.name ?? 'demo-repo');
  mkdirSync(repo);
  // The server keeps the owner's token in a private folder under the home directory unless
  // told otherwise: each run gets its own, and leaves none behind.
  const stateDir = mkdtempSync(join(tmpdir(), 'keel-state-'));
  const env = { ...process.env, KEEL_STATE_DIR: stateDir };
  for (const [name, text] of Object.entries(opts.files ?? {})) {
    mkdirSync(dirname(join(repo, name)), { recursive: true });
    (await import('node:fs')).writeFileSync(join(repo, name), text);
  }
  if (opts.git) {
    const git = (...args: string[]) => {
      const r = spawnSync('git', ['-c', 'user.name=Keel test', '-c', 'user.email=test@keel.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    };
    (await import('node:fs')).writeFileSync(join(repo, 'README.md'), '# demo\n');
    git('init', '-q', '-b', 'main');
    git('add', 'README.md');
    git('commit', '-q', '-m', 'The first commit');
  }
  const linkOpts = Object.entries(opts.linkOptions ?? {}).flatMap(([k, v]) => ['--link-opt', `${k}=${v}`]);
  const builderOpts = opts.builder ? ['--builder', opts.builder] : [];
  const server: ChildProcess = spawn('node', [BIN, 'open', repo, '--no-browser', '--port', '0', '--app-dir', APP, '--link', opts.link, ...builderOpts, ...linkOpts], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  let out = '';
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the server printed no address:\n${out}`)), 20_000);
    const read = (d: Buffer) => {
      out += String(d);
      // The address holds a code that works once: the page that opens it trades it for the owner's token.
      const m = out.match(/http:\/\/127\.0\.0\.1:\d+\/\?code=\S+/);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    };
    server.stdout!.on('data', read);
    server.stderr!.on('data', read);
    server.on('exit', (code) => reject(new Error(`the server stopped with code ${code}:\n${out}`)));
  });
  let printed: string | undefined = url;
  return {
    // The printed address works once. After that, each read asks the running server for a fresh one.
    get url(): string {
      if (printed !== undefined) {
        const first = printed;
        printed = undefined;
        return first;
      }
      const r = spawnSync('node', [BIN, 'link', repo], { env, encoding: 'utf8' });
      const fresh = r.stdout.trim();
      if (r.status !== 0 || !fresh.includes('?code=')) throw new Error(`keel-board link gave no address:\n${r.stdout}${r.stderr}`);
      return fresh;
    },
    repo,
    output: () => out,
    stop: async () => {
      const exited = new Promise<void>((resolve) => (server.exitCode !== null ? resolve() : server.once('exit', () => resolve())));
      spawnSync('node', [BIN, 'stop', repo], { env });
      // Closing waits for a running agent turn. Give it time before a signal, and more before a kill.
      const within = (ms: number) => Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))]);
      if (!(await within(30_000))) {
        server.kill('SIGTERM');
        if (!(await within(10_000))) server.kill('SIGKILL');
      }
      rmSync(dirname(repo), { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}
