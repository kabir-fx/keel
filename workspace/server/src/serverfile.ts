import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BoardInfo } from '@keel/protocol';
import { BOARD_DIR, ROUTES, SERVER_FILE, ServerFile } from '@keel/protocol';
import { appendNoFollow, lstatOf, readNoFollow, replaceFile } from './files';
import { readPrivate } from './private';

/**
 * `.keel/board/server.json`: a note that a server is up, and nothing more. It holds no token:
 * the code a build runs can read anything inside the repository, and the repository itself
 * can forge the file. Everything that finds the server goes through the board's private file
 * (`private.ts`), and checks that the server at its port answers as this board's own.
 */

export function serverFilePath(boardDir: string): string {
  return path.join(boardDir, SERVER_FILE);
}

/** Read `server.json` as it is, whether or not a server still runs. A link is not followed. */
export function readServerFile(boardDir: string): ServerFile | undefined {
  let text: string | undefined;
  try {
    text = readNoFollow(serverFilePath(boardDir));
  } catch {
    return undefined;
  }
  if (text === undefined) return undefined;
  try {
    const r = ServerFile.safeParse(JSON.parse(text));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

/** The header `keel-board` sends with a challenge, and the one the server answers with. */
export const CHALLENGE_HEADER = 'x-keel-challenge';
export const PROOF_HEADER = 'x-keel-proof';

/** What a server that knows the board's key answers to a challenge. The key itself never travels. */
export function proofOf(boardKey: string, challenge: string): string {
  return crypto.createHmac('sha256', boardKey).update(`keel-board:${challenge}`).digest('base64url');
}

export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export interface ProbeOptions {
  /** `KEEL_STATE_DIR`, for tests. */
  stateRoot?: string;
  timeoutMs?: number;
}

/** A server found through the private file, that answered as this board's own. */
export interface FoundServer {
  pid: number;
  port: number;
  startedAt: string;
  tokens: { owner: string; agent: string; system: string };
}

/**
 * The server that runs this board now, or undefined. Its port and tokens come from the
 * board's private file. It runs only when the server at that port answers `ROUTES.board` with
 * the system token, as the system, and proves that it knows the board's key.
 */
export async function findServer(boardDir: string, opts: ProbeOptions = {}): Promise<FoundServer | undefined> {
  const priv = readPrivate(boardDir, opts.stateRoot);
  const run = priv?.running;
  if (!priv || !run) return undefined;
  const challenge = crypto.randomBytes(18).toString('base64url');
  try {
    const res = await fetch(`http://127.0.0.1:${priv.port}${ROUTES.board}`, {
      headers: { authorization: `Bearer ${run.systemToken}`, [CHALLENGE_HEADER]: challenge },
      redirect: 'error',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 2000),
    });
    const proof = res.headers.get(PROOF_HEADER);
    const body = (await res.json().catch(() => undefined)) as Partial<BoardInfo> | undefined;
    if (res.status !== 200 || body?.role !== 'system' || !proof || !sameSecret(proof, proofOf(priv.boardKey, challenge))) return undefined;
  } catch {
    return undefined;
  }
  return { pid: run.pid, port: priv.port, startedAt: run.startedAt, tokens: { owner: run.ownerToken, agent: run.agentToken, system: run.systemToken } };
}

/** Write `server.json`: through a new file and a rename, so a link or a forged file at the path is replaced. */
export function writeServerFile(boardDir: string, data: ServerFile): void {
  replaceFile(serverFilePath(boardDir), `${JSON.stringify(ServerFile.parse(data), null, 2)}\n`, 0o600);
}

/** Remove `server.json`, but only when it is the one this server wrote. */
export function removeServerFile(boardDir: string, mine: ServerFile): void {
  const f = readServerFile(boardDir);
  if (f && f.pid === mine.pid && f.port === mine.port && f.startedAt === mine.startedAt) {
    fs.rmSync(serverFilePath(boardDir), { force: true });
  }
}

/** Remove a `server.json` no live server answers for. Only ever the file: a link is removed, not followed. */
export function removeStaleServerFile(boardDir: string): boolean {
  const file = serverFilePath(boardDir);
  if (!lstatOf(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

/** Files in `.keel/board/` that belong to this machine only. The log is meant to be committed. */
export const LOCAL_FILES = [SERVER_FILE, 'agent.json'] as const;

/** `.keel/board/.gitignore` keeps what belongs to this machine out of git. Written without following a link. */
export function ensureGitignore(boardDir: string): void {
  const file = path.join(boardDir, '.gitignore');
  const text = readNoFollow(file) ?? '';
  const have = new Set(text.split(/\r?\n/).map((l) => l.trim().replace(/^\//, '')));
  const missing = LOCAL_FILES.filter((name) => !have.has(name));
  if (missing.length === 0) return;
  const lead = text.length > 0 && !text.endsWith('\n') ? '\n' : '';
  appendNoFollow(file, `${lead}${missing.join('\n')}\n`);
}

/** The board folder for a command run in `start`: the nearest real `.keel/board` above it, else one in `start`. */
export function findBoardDir(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    const keel = lstatOf(path.join(dir, '.keel'));
    const board = keel?.isDirectory() ? lstatOf(path.join(dir, BOARD_DIR)) : undefined;
    if (board?.isDirectory()) return path.join(dir, BOARD_DIR);
    const up = path.dirname(dir);
    if (up === dir) return path.join(path.resolve(start), BOARD_DIR);
    dir = up;
  }
}
