import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BoardEvent, BoardState, DigestReply, PresenceUpdate, Refusal } from '@keel/protocol';
import { BOARD_DIR, PRIVATE_BOARD_FILE, PrivateBoardFile, ROUTES, RULES, STATE_DIR_ENV, privateBoardKey } from '@keel/protocol';

/**
 * How the board tools reach the board server: HTTP with the agent's token. The address and
 * the token come from `KEEL_BOARD_URL` and `KEEL_BOARD_TOKEN` (the hosted link sets them),
 * else from the board's private file, found from the board folder above the working folder.
 */

export interface BoardAddress {
  url: string;
  token: string;
}

/** A failure the agent should read as it is: the tool returns it as its error text. */
export class BoardError extends Error {
  override name = 'BoardError';
}

/** The board server refused the drafts. Nothing was written. */
export class RefusedError extends BoardError {
  constructor(readonly refusal: Refusal) {
    super(refusal.reason);
  }
}

/** The board folder (`.keel/board`) at or above `start`, as a real path. */
export function findBoardDir(start: string): string | undefined {
  let dir = path.resolve(start);
  for (;;) {
    const board = path.join(dir, BOARD_DIR);
    try {
      if (fs.statSync(board).isDirectory()) return fs.realpathSync(board);
    } catch {
      // Not here.
    }
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** The board's private file, outside its repository: `<state root>/boards/<key>/board.json`. */
export function privateBoardPath(boardDir: string, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const st = fs.statSync(boardDir, { bigint: true });
  const root = env[STATE_DIR_ENV] ? path.resolve(env[STATE_DIR_ENV]!) : path.join(home, '.keel');
  return path.join(root, 'boards', privateBoardKey(st.dev, st.ino), PRIVATE_BOARD_FILE);
}

/**
 * Where the board server is now. Read on every call: a restarted server has new tokens. The
 * repository's own `server.json` holds no token and is never trusted for one: the address and
 * the agent's token come from the board's private file, which nothing in a repository can write.
 */
export function locateBoard(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd(), home: string = os.homedir()): BoardAddress {
  const url = env.KEEL_BOARD_URL;
  const token = env.KEEL_BOARD_TOKEN;
  if (url && token) return { url: url.replace(/\/+$/, ''), token };

  const start = env.KEEL_BOARD_REPO ?? env.CLAUDE_PROJECT_DIR ?? cwd;
  const board = findBoardDir(start);
  if (!board) throw new BoardError(`There is no board above ${start}: no ${BOARD_DIR} folder. The owner starts one with "keel-board open".`);
  const file = privateBoardPath(board, env, home);
  let parsed: PrivateBoardFile;
  try {
    // A link in the file's place is not followed.
    if (!fs.lstatSync(file).isFile()) throw new Error('not a file');
    parsed = PrivateBoardFile.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    throw new BoardError(`No board server runs for ${board}: its private file cannot be read. The owner starts one with "keel-board open".`);
  }
  if (!parsed.running) throw new BoardError(`No board server runs for ${board} now. The owner starts one with "keel-board open".`);
  return { url: `http://127.0.0.1:${parsed.port}`, token: parsed.running.agentToken };
}

export class BoardClient {
  constructor(private readonly locate: () => BoardAddress = () => locateBoard()) {}

  private async call(route: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<{ status: number; body: unknown }> {
    const where = this.locate();
    let res: Response;
    try {
      res = await fetch(`${where.url}${route}`, {
        ...init,
        headers: { authorization: `Bearer ${where.token}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const why = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
      throw new BoardError(`The board server at ${where.url} does not answer (${why}). The owner restarts it with "keel-board open".`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    return { status: res.status, body };
  }

  async digest(): Promise<DigestReply> {
    const r = await this.call(ROUTES.digest);
    if (r.status !== 200) throw httpError(r);
    return r.body as DigestReply;
  }

  /** The whole board state, for opening one item or the whole model. */
  async state(): Promise<BoardState> {
    const r = await this.call(ROUTES.state);
    if (r.status !== 200) throw httpError(r);
    return r.body as BoardState;
  }

  /** Post drafts as one: all of them are admitted, or none. */
  async post(drafts: unknown[]): Promise<BoardEvent[]> {
    const r = await this.call(ROUTES.events, { method: 'POST', body: JSON.stringify({ drafts }) });
    if (r.status === 422) throw new RefusedError(r.body as Refusal);
    if (r.status !== 200) throw httpError(r);
    return (r.body as { events: BoardEvent[] }).events;
  }

  /** Tell the board what the agent does now. Best effort: a lost presence never fails a tool. */
  async presence(update: PresenceUpdate): Promise<void> {
    try {
      await this.call(ROUTES.presence, { method: 'POST', body: JSON.stringify(update) }, 2_000);
    } catch {
      // The pill is a courtesy. The event that follows is what counts.
    }
  }
}

function httpError(r: { status: number; body: unknown }): BoardError {
  const msg = (r.body as { error?: unknown } | undefined)?.error;
  return new BoardError(`The board server said ${r.status}${typeof msg === 'string' ? `: ${msg}` : '.'}`);
}

/**
 * A refusal as the agent reads it: the rule, and the reason word for word, so it can fix the
 * one thing and call again in the same turn.
 */
export function refusalText(r: Refusal, what?: (index: number) => string): string {
  const where = r.index !== undefined && what ? ` ${what(r.index)}` : '';
  const rule = r.rule in RULES ? `${r.rule}: ${RULES[r.rule]}` : r.rule;
  return [
    `Refused${where}. Nothing was posted.`,
    `Reason: ${r.reason}`,
    `Rule ${rule}`,
    'Fix that and call the tool again.',
  ].join('\n');
}
