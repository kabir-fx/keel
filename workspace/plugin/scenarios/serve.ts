import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BoardEvent } from '@keel/protocol';
import { privateBoardPath } from '../src/client';
import type { TranscriptLine } from './check';

/**
 * The real board server with the hosted link, for one recorded turn: start it on a seeded
 * repository, wait for the agent's turn to end in the transcript, stop it.
 */

export const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
export const WORKSPACE = path.join(PLUGIN, '..');
export const SERVER_BIN = path.join(WORKSPACE, 'server', 'bin', 'keel-board.mjs');
export const HOSTED = path.join(PLUGIN, 'dist', 'hosted-link.js');
export const RUNS = path.join(PLUGIN, 'scenarios', 'runs');
const TURN_LIMIT_MS = 12 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What is missing before a real run can start, if anything. */
export function missingBuild(): string | undefined {
  for (const f of [SERVER_BIN, HOSTED, path.join(WORKSPACE, 'server', 'dist', 'keel-board.js')]) {
    if (!fs.existsSync(f)) return `Missing ${f}. Build first, from workspace/: npm run build`;
  }
  return undefined;
}

/**
 * Post the board's last moves live, in order, each with its actor's token: the owner's from the
 * address the server prints, the agent's and the system's from the board's private file. The
 * server wakes the agent only for what reaches it live.
 */
/** Trade the one-time code from a printed address for the owner's token: what the page does when it opens. */
export async function ownerToken(url: string, code: string): Promise<string> {
  const r = await fetch(`${url}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  const body = (await r.json()) as { token?: string };
  if (!r.ok || !body.token) throw new Error(`the board server did not take the code from its own address (HTTP ${r.status})`);
  return body.token;
}

async function postLive(repo: string, stateDir: string, live: readonly BoardEvent[], log: () => string, server: ChildProcess): Promise<void> {
  const t0 = Date.now();
  let page: RegExpExecArray | null = null;
  while (!(page = /http:\/\/127\.0\.0\.1:(\d+)\/\?code=([\w-]+)/.exec(log()))) {
    if (server.exitCode !== null) throw new Error(`the board server exited (${server.exitCode})`);
    if (Date.now() - t0 > 30_000) throw new Error('the board server printed no address in 30 s');
    await sleep(100);
  }
  const url = `http://127.0.0.1:${page[1]}`;
  const priv = JSON.parse(fs.readFileSync(privateBoardPath(path.join(repo, '.keel', 'board'), { KEEL_STATE_DIR: stateDir }), 'utf8')) as {
    running: { agentToken: string; systemToken: string };
  };
  // The printed address holds a code that works once. The scenario trades it for the owner's token, as the page does.
  const tokens: Record<string, string> = { owner: await ownerToken(url, page[2]!), agent: priv.running.agentToken, system: priv.running.systemToken };
  for (const ev of live) {
    const { id, at: _at, by, ...draft } = ev as BoardEvent & Record<string, unknown>;
    const r = await fetch(`${url}/api/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens[by]}`, 'content-type': 'application/json' },
      body: JSON.stringify({ drafts: [draft] }),
    });
    if (!r.ok) throw new Error(`the live event ${id} was refused: ${await r.text()}`);
  }
}

export function readTranscript(file: string): TranscriptLine[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as TranscriptLine];
      } catch {
        return [];
      }
    });
}

/**
 * Start the server on `repo`, let the agent answer the wake that opening it sends, stop the
 * server. Returns the server's output and an error, if the turn did not end.
 */
export async function oneTurn(repo: string, transcript: string, opts: Record<string, string>, live: readonly BoardEvent[] = []): Promise<{ serverLog: string; error?: string }> {
  // No builder in a recorded board: the turn is the board agent's. The server's private folder is a temporary one.
  const linkOpts = Object.entries({ transcript, timeout: '660', builder: 'none', ...opts }).flatMap(([k, v]) => ['--link-opt', `${k}=${v}`]);
  const stateDir = fs.mkdtempSync(path.join(path.dirname(path.resolve(repo)), 'keel-state-'));
  const server = spawn(process.execPath, [SERVER_BIN, 'open', repo, '--port', '0', '--no-browser', '--link', HOSTED, ...linkOpts], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, KEEL_STATE_DIR: stateDir },
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += String(d)));
  server.stderr.on('data', (d) => (serverLog += String(d)));
  const exited = new Promise<void>((r) => server.on('exit', () => r()));

  let error: string | undefined;
  try {
    if (live.length) await postLive(repo, stateDir, live, () => serverLog, server);
    const t0 = Date.now();
    for (;;) {
      if (readTranscript(transcript).some((l) => l.type === 'result')) break;
      if (server.exitCode !== null) throw new Error(`the board server exited (${server.exitCode})`);
      if (Date.now() - t0 > TURN_LIMIT_MS) throw new Error(`no turn end in ${TURN_LIMIT_MS / 60_000} minutes`);
      await sleep(500);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    if (server.exitCode === null) {
      server.kill('SIGTERM');
      await Promise.race([exited, sleep(30_000)]);
    }
  }
  return error === undefined ? { serverLog } : { serverLog, error };
}
