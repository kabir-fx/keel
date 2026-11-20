import { z } from 'zod';
import type { Digest } from './digest';
import type { BoardEvent } from './events';
import { Actor, Id, Point } from './ids';
import type { RuleId } from './rules';

/**
 * What travels between the board server, the canvas app and the plugin.
 * Events are the only thing that lasts. Presence is live and is never logged.
 */

/** What the agent does now. */
export const PresenceState = z.enum(['listening', 'drawing', 'waiting', 'building', 'away']);
export type PresenceState = z.infer<typeof PresenceState>;

export const Presence = z.strictObject({
  state: PresenceState,
  /** A few words: "drawing three approaches". */
  note: z.string().max(120).optional(),
  /** Where the agent's cursor is: on an item, or at a point of the board. */
  cursor: z.strictObject({ item: Id.optional(), at: Point.optional() }).optional(),
  /** When this state began, ISO 8601. */
  since: z.string(),
});
export type Presence = z.infer<typeof Presence>;

/** What the agent or the server reports. The server adds `since`. */
export const PresenceUpdate = Presence.omit({ since: true });
export type PresenceUpdate = z.infer<typeof PresenceUpdate>;

/** From the app to the server, over the websocket. */
export const ClientMessage = z.discriminatedUnion('t', [
  /** Post one draft. `ref` comes back in the reply, so the app can match it. */
  z.strictObject({ t: z.literal('post'), ref: z.string().min(1).max(64), draft: z.unknown() }),
  z.strictObject({ t: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** From the server to the app, over the websocket. */
export type ServerMessage =
  | { t: 'init'; name: string; role: z.infer<typeof Actor>; events: BoardEvent[]; presence: Presence; build?: BoardInfo['build']; shows?: BoardInfo['shows'] }
  | { t: 'event'; event: BoardEvent }
  | { t: 'ok'; ref: string; event: BoardEvent }
  | { t: 'refused'; ref: string; rule: RuleId; reason: string }
  | { t: 'presence'; presence: Presence }
  /** What the server's build driver does now, sent when it changes. `null` when no build is going. */
  | { t: 'build'; build: NonNullable<BoardInfo['build']> | null }
  /** Every built chapter the owner can look at now, sent to the owner's page when it changes. Empty when there is none. */
  | { t: 'shows'; shows: NonNullable<BoardInfo['shows']> }
  | { t: 'pong' };

/** The reply to a refused post, over HTTP. `index` is the draft that failed, when several were sent. */
export interface Refusal {
  rule: RuleId;
  reason: string;
  index?: number;
}

/**
 * The HTTP routes of the board server. Every one but `session` needs a token, as
 * `Authorization: Bearer` or `?token=`. There is no cookie: a cookie for 127.0.0.1 would go
 * to every local port. The page's shell and its static files need no token, because they
 * hold nothing.
 *
 * Every token lives only as long as the server that made it. So a tab left open after the
 * server stops, which keeps trying its address, hands whatever answers there next a token
 * that is worth nothing. The address `keel-board open` prints holds no token: it holds a
 * code that works once (`ONE_TIME_CODE_MS`), which the page trades for the owner's token.
 * What stays in the browser's history is a spent code.
 */
export const ROUTES = {
  /**
   * POST `{ code }`, with no token: `SessionReply`, the owner's token for this run of the
   * server. The code is the one in the address the command printed. It works once.
   */
  session: '/api/session',
  /** POST with the system token: `{ url }`, a fresh address for the owner's page, with a new one-time code. */
  link: '/api/link',
  /** GET: `BoardInfo`. */
  board: '/api/board',
  /** GET `?after=<seq>`: `{ events }`. POST `{ drafts }`: `{ events }`, or 422 with a `Refusal`. All or nothing. */
  events: '/api/events',
  /** GET `?since=<seq>`: `DigestReply`. */
  digest: '/api/digest',
  /** GET: the whole `BoardState`. */
  state: '/api/state',
  /** GET `?ids=a,b`: `{ items }`, each an `ItemState` in full with `marks`, the ids of the owner's marks on it. Ink strokes are left out. */
  items: '/api/items',
  /** POST a `PresenceUpdate`. */
  presence: '/api/presence',
  /** POST `?name=<file name>` with the bytes as the body: `{ asset }`. GET `/api/assets/<name>` reads one back. */
  assets: '/api/assets',
  /** POST with the system token: the server closes cleanly. This is how `keel-board stop` stops it. */
  stop: '/api/stop',
  /**
   * POST, the owner only: the owner keeps the lines that came with the log from outside
   * (`BoardInfo.foreign`). From then on they are the board's own, like any other.
   */
  keep: '/api/keep',
  /** The websocket. */
  ws: '/ws',
} as const;

/**
 * A run of events, by number and with both ends included, that came in a log this machine's
 * server did not write: with a clone, a pull or a checkout, or written into the file by hand.
 * The log says who made each one, and the log can say anything. So until the owner keeps
 * them, the page tags what they made as "not made here", and the agent does not act on them.
 */
export const ForeignRange = z.strictObject({ from: z.number().int().min(1), to: z.number().int().min(1) });
export type ForeignRange = z.infer<typeof ForeignRange>;
/** At most this many runs are kept apart. Past it, the two oldest are joined. */
export const MAX_FOREIGN_RANGES = 32;

/** The most built chapters whose result is kept to be shown. The oldest go first. */
export const MAX_SHOWS = 40;

/** Did this event, by its id or its number, come with a log from outside, and is not kept yet? */
export function isForeign(ranges: readonly ForeignRange[] | undefined, event: string | number): boolean {
  if (!ranges || ranges.length === 0) return false;
  const n = typeof event === 'number' ? event : Number(event.slice(1));
  return Number.isFinite(n) && ranges.some((r) => n >= r.from && n <= r.to);
}

export interface BoardInfo {
  name: string;
  seq: number;
  role: z.infer<typeof Actor>;
  open: number;
  presence: Presence;
  /** The events that came with the log from outside and that the owner has not kept yet. Left out when there are none. */
  foreign?: ForeignRange[];
  /** The name of the agent link the server loaded, or "none". */
  link?: string;
  /** The name of the builder the server loaded, or "none". */
  builder?: string;
  /**
   * The build the server is driving, when there is one. `running`: the builder works.
   * `queued`: it waits for another build. `waiting`: a decided part was reopened, and the
   * build waits for the owner. `paused`: the owner paused it. `stopped`: it ended without
   * finishing, and the feed says why. `unagreed`: the log says this chapter is building,
   * but nobody pressed "Build this" or Resume for it on this machine, so nothing runs
   * until the owner does. `check` is the command the owner would agree to.
   */
  build?: {
    chapter: string;
    title: string;
    state: 'running' | 'queued' | 'waiting' | 'paused' | 'stopped' | 'unagreed';
    built: number;
    total: number;
    part?: string;
    check?: string;
  };
  /**
   * What the owner can look at: for each built chapter that has something to show, the
   * address of its page. The address is on a port of its own, so the page shown is never in
   * the board's origin and cannot act as the owner. It holds a key made new for each start of
   * the server, and it is said to the owner only: never to the agent or the system, and never
   * in the log. Left out when there is nothing to show.
   */
  shows?: Record<string, string>;
}

/** How long a one-time code in a printed address works, in ms. It also stops working the first time it is used. */
export const ONE_TIME_CODE_MS = 5 * 60_000;

/** What `ROUTES.session` answers: the owner's token, for as long as this server runs. */
export interface SessionReply {
  token: string;
  role: 'owner';
}

export interface DigestReply {
  digest: Digest;
  /** The digest as text: what the agent reads. */
  text: string;
}

/**
 * The file a running server writes at `.keel/board/server.json`: a note that a server is
 * up, and nothing more. It holds no token. Anything inside the repository can be read by
 * the code a build runs, and can be forged by the repository itself, so the tokens and
 * everything the machine trusts live in the private file outside it (`PrivateBoardFile`).
 */
export const ServerFile = z.strictObject({
  pid: z.number().int(),
  port: z.number().int().min(1).max(65535),
  startedAt: z.string(),
});
export type ServerFile = z.infer<typeof ServerFile>;

/**
 * The file the server keeps for a board OUTSIDE its repository, at
 * `<state root>/boards/<key>/board.json`. The state root is `$KEEL_STATE_DIR`, else `~/.keel`.
 * Nothing a repository ships can write here, so this file is what the machine trusts:
 * who the owner is, where the server listens, and which builds the owner started here.
 */
export const PrivateBoardFile = z.strictObject({
  /** The board folder it belongs to, as a real path. */
  boardDir: z.string(),
  /**
   * The board's own secret on this machine. A running server proves with it that it is this
   * board's server (`x-keel-proof`), before the command or a tool trusts what it says. It
   * lets no request in: it is not a token, and it never travels.
   */
  boardKey: z.string().min(16),
  port: z.number().int().min(1).max(65535),
  /**
   * While a server runs: its tokens, made new for each run and gone when it stops. The
   * plugin's tools and hooks read theirs here, not from the repository.
   */
  running: z.strictObject({ pid: z.number().int(), ownerToken: z.string(), agentToken: z.string(), systemToken: z.string(), startedAt: z.string() }).optional(),
  /**
   * The builds the owner started or resumed on this machine, by a press the server admitted
   * live. Only these are ever run here, with exactly this check. A log read from disk grants
   * nothing: a repository can ship a log that says anything.
   */
  consents: z
    .array(z.strictObject({ chapter: Id, event: z.string(), check: z.string().min(1).max(300), track: z.array(Id).max(40), at: z.string() }))
    .optional(),
  /**
   * The log as this machine's server last wrote it: its size, and the SHA-256 of its bytes.
   * A log on disk that is not this one was changed outside the server: a clone, a pull, a
   * checkout, an edit. Such a log is history only. The consents no longer hold, and the lines
   * this server did not write are `foreign` until the owner keeps them.
   */
  log: z.strictObject({ bytes: z.number().int().min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).optional(),
  /** The events that came with a log from outside, until the owner keeps them (`ROUTES.keep`). */
  foreign: z.array(ForeignRange).max(MAX_FOREIGN_RANGES).optional(),
  /**
   * What the builds finished on this machine have to show (`BuildShow`), one per chapter, so a
   * built chapter can be looked at again after the server starts anew. It is kept here and
   * not in the log: a folder on this machine is nothing a repository may name. `opened` is
   * true once the page was opened for the owner, which happens once.
   */
  shows: z
    .array(z.strictObject({ chapter: Id, dir: z.string().min(1).max(4096), page: z.string().min(1).max(300), at: z.string(), opened: z.boolean().optional() }))
    .max(MAX_SHOWS)
    .optional(),
});
export type PrivateBoardFile = z.infer<typeof PrivateBoardFile>;

export const STATE_DIR_ENV = 'KEEL_STATE_DIR';
export const PRIVATE_BOARD_FILE = 'board.json';

/**
 * The name of a board's private folder, from the device and inode of its board folder.
 * The same folder gives the same name however its path is spelled.
 */
export function privateBoardKey(dev: number | bigint, ino: number | bigint): string {
  return `d${BigInt(dev).toString(36)}-i${BigInt(ino).toString(36)}`;
}

/** Where a board lives inside its repository. */
export const BOARD_DIR = '.keel/board';
export const LOG_FILE = 'log.jsonl';
export const ASSETS_DIR = 'assets';
export const SERVER_FILE = 'server.json';
