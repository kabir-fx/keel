import { z } from 'zod';
import type { Digest } from './digest';
import type { BoardEvent } from './events';
import { Actor, Id, Point } from './ids';
import { PICTURE_KINDS, ShowPlan } from './pictures';
import type { RuleId } from './rules';

/**
 * What travels between the board server, the canvas app and the plugin.
 * Events are the only thing that lasts. Presence is live and is never logged.
 */

/** What the agent does now. */
export const PresenceState = z.enum(['listening', 'drawing', 'waiting', 'building', 'away']);
export type PresenceState = z.infer<typeof PresenceState>;

/**
 * What the agent is busy with while it works, as its stream says: it reads (the owner's marks,
 * the board, the code), it thinks, it draws (a picture, the model), or it writes (an answer in
 * words, an update). The agent's figure on the board shows it. Left out when nobody knows.
 */
export const PresenceDoing = z.enum(['reading', 'thinking', 'drawing', 'writing']);
export type PresenceDoing = z.infer<typeof PresenceDoing>;

/**
 * The picture the agent is writing now, as far as its call says so far: the first picture of a
 * post. Its kind as soon as that is written, and its title once that is whole too.
 */
export const PresencePicture = z.strictObject({
  kind: z.enum(PICTURE_KINDS),
  title: z.string().max(120).optional(),
});
export type PresencePicture = z.infer<typeof PresencePicture>;

export const Presence = z.strictObject({
  state: PresenceState,
  /** A few words: "drawing three approaches". */
  note: z.string().max(120).optional(),
  /** What it is busy with while it works. */
  doing: PresenceDoing.optional(),
  /** The picture it is writing now. */
  picture: PresencePicture.optional(),
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
  | { t: 'init'; name: string; role: z.infer<typeof Actor>; events: BoardEvent[]; presence: Presence; build?: BoardInfo['build']; works?: BoardInfo['works']; shows?: BoardInfo['shows']; home?: BoardInfo['home'] }
  | { t: 'event'; event: BoardEvent }
  | { t: 'ok'; ref: string; event: BoardEvent }
  | { t: 'refused'; ref: string; rule: RuleId; reason: string }
  | { t: 'presence'; presence: Presence }
  /** What the server's build driver does now, sent when it changes. `null` when no build is going. */
  | { t: 'build'; build: NonNullable<BoardInfo['build']> | null }
  /**
   * What this machine's repository says about each canvas's branch, what each built chapter
   * has to try, and the home branch, sent to the owner's page whenever any of it changes.
   * `works` and `shows` are whole: a canvas or a chapter not in them has nothing here.
   * `home` is left out where there is no repository.
   */
  | { t: 'works'; works: NonNullable<BoardInfo['works']>; shows: NonNullable<BoardInfo['shows']>; home?: HomeInfo }
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
  /**
   * POST a `ShowAsk`, the owner only: start or stop what a built chapter shows. A start names
   * the command as the page showed it, and the server runs it only when it is the chapter's
   * own, word for word: that press is the owner's agreement to run it. 409 with `{ reason }`
   * when it cannot start.
   */
  show: '/api/show',
  /** POST, the owner only: push the home branch to the remote it follows. `{ ok, note, home }`. Never forced. */
  push: '/api/push',
  /** POST, the owner only: look at the remote again and bring the home branch level when that is a fast-forward. `{ home }`. */
  sync: '/api/sync',
  /**
   * The owner only. GET: `SetupInfo`, what this machine still needs. POST a `SetupAsk`: take
   * one step, then `SetupInfo` as it stands after it.
   */
  setup: '/api/setup',
  /** The websocket. */
  ws: '/ws',
  /**
   * A websocket for one running show, the owner only: `?chapter=<id>`. The server sends what
   * the command printed so far, then what it prints (`ShowServerMessage`); the page sends
   * what the owner types (`ShowClientMessage`). It closes when the show ends.
   */
  showWs: '/ws/show',
} as const;

/**
 * How the agent's harness stands on this machine. `name` is what the page calls it. `note`
 * says, in a sentence, why the last step failed.
 */
export type AgentSetup = { name: string } & (
  | { state: 'missing'; installing?: boolean; note?: string }
  /** `signIn` while a sign-in runs. Its `url` is the sign-in page, for a browser that did not open by itself. */
  | { state: 'signed-out'; signIn?: { url?: string }; note?: string }
  | { state: 'ready' }
);

/**
 * What this machine needs before an idea can go from a note to a build. Said to the owner's
 * page only, never in the log: it is a fact of this machine.
 */
export interface SetupInfo {
  /** Left out when the linked agent needs nothing, and when no agent is linked. */
  agent?: AgentSetup;
  /** A build needs git. `how` says how to get it on this system. */
  git: { state: 'ready' } | { state: 'missing'; how: string };
}

/** True when nothing is left to set up. */
export function setupDone(s: SetupInfo): boolean {
  return (s.agent === undefined || s.agent.state === 'ready') && s.git.state === 'ready';
}

/** What the owner's page asks of `ROUTES.setup`. */
export const SetupAsk = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('install') }),
  z.strictObject({ action: z.literal('sign-in') }),
  z.strictObject({ action: z.literal('code'), code: z.string().trim().min(1).max(2000) }),
]);
export type SetupAsk = z.infer<typeof SetupAsk>;

/** What the owner's page asks of `ROUTES.show`. */
export const ShowAsk = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('start'),
    chapter: Id,
    /** The command the page showed beside the button. */
    run: z.string().min(1).max(300),
    cols: z.number().int().min(20).max(400).optional(),
    rows: z.number().int().min(5).max(200).optional(),
  }),
  z.strictObject({ action: z.literal('stop'), chapter: Id }),
]);
export type ShowAsk = z.infer<typeof ShowAsk>;

/** From the page to a running show. */
export const ShowClientMessage = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('in'), data: z.string().max(65536) }),
  z.strictObject({ t: z.literal('size'), cols: z.number().int().min(20).max(400), rows: z.number().int().min(5).max(200) }),
]);
export type ShowClientMessage = z.infer<typeof ShowClientMessage>;

/** From a running show to the page. The first `out` holds what was printed before the page joined, as far as it is kept. */
export type ShowServerMessage = { t: 'out'; data: string } | { t: 'end'; code: number | null };

/** The most of a show's output the server keeps for a page that joins late, in characters. */
export const SHOW_OUTPUT_KEPT = 200_000;

/**
 * What the owner can try for a built chapter, and whether it runs now. Said to the owner's
 * page only, never in the log: an address and a command's state are facts of this machine.
 */
export type ShowInfo =
  /** A page that stands alone, served as files from an address of its own. */
  | { kind: 'page'; url: string }
  /**
   * An app a command serves. `url` once it answers. `note` says why it failed, in a sentence.
   * `boxed` is false when it runs with no box, on a machine that has none: the page says so.
   */
  | { kind: 'app'; run: string; state: 'off' | 'starting' | 'on' | 'failed'; url?: string; note?: string; boxed?: false }
  /** A terminal in the build's copy. `ended` once the shell is gone, with its exit code. `boxed` as for an app. */
  | { kind: 'terminal'; run: string; state: 'off' | 'on' | 'ended'; code?: number | null; boxed?: false };

/** What this machine's repository says about one canvas's build. */
export interface CanvasWork {
  /** The canvas's branch, while this machine has it. */
  branch?: string;
  /** Commits on the branch that the home branch does not have. */
  ahead?: number;
  /** Commits the home branch has gained since the branch left it. */
  behind?: number;
  /**
   * What is done with the branch right now. `building`: the builder's run on this canvas has
   * not ended, which outlasts the last part by the build's last commit. `joining` and
   * `merging`: an approve in two steps. `deleting`: a delete. Nothing is tried, approved or
   * built on a busy canvas, and the server refuses it.
   */
  busy?: 'building' | 'joining' | 'merging' | 'deleting';
}

/**
 * The home branch: where every build starts, and where an approved one goes. It is the
 * repository's main branch. The server brings it level with its remote when the board
 * opens and before each build, by fast-forward only.
 */
export interface HomeInfo {
  branch: string;
  /** Its commit here, short. Left out in a repository with no commit yet. */
  commit?: string;
  /** The remote branch it follows, such as `origin/main`. Left out when it follows none. */
  upstream?: string;
  /**
   * How it stands with what it follows, as last looked at. `level`: the same commit.
   * `ahead`: commits here to push. `behind`: the remote is ahead and the fast-forward was
   * refused, `note` says why. `diverged`: each has commits the other lacks, nothing was
   * moved. `unreachable`: the remote did not answer. `local`: it follows no remote.
   */
  sync: 'level' | 'ahead' | 'behind' | 'diverged' | 'unreachable' | 'local';
  ahead?: number;
  behind?: number;
  /** One sentence for the owner when something needs them. */
  note?: string;
  /** When the remote was last looked at, ISO 8601. */
  checkedAt?: string;
  /** The branch the owner's folder is on, when it is not the home branch. Builds still start from the home branch. */
  folderOn?: string;
}

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

/** The most canvases whose branch is kept track of. The oldest go first. */
export const MAX_WORKS = 200;

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
   * What this machine's repository holds for each canvas, by canvas id: its branch and how it
   * stands with the home branch. Said to the owner only, and never in the log. Left out when
   * no canvas has anything here.
   */
  works?: Record<string, CanvasWork>;
  /**
   * What the owner can try, by chapter id, for each built chapter that has something. An
   * address here is on a port of its own, so what it serves is never in the board's origin
   * and cannot act as the owner. Said to the owner only: never to the agent or the system,
   * and never in the log. Left out when there is nothing to try.
   */
  shows?: Record<string, ShowInfo>;
  /** The home branch, for the owner only. Left out where the board's folder is no repository. */
  home?: HomeInfo;
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
    .array(
      z.strictObject({
        chapter: Id,
        event: z.string(),
        check: z.string().min(1).max(300),
        track: z.array(Id).max(40),
        at: z.string(),
        /** The setup command agreed to with the same press, when there was one. */
        setup: z.string().min(1).max(300).optional(),
        /** How the result is tried, as the press agreed to it. */
        show: ShowPlan.optional(),
      }),
    )
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
  /**
   * Where each canvas's build lives in this machine's repository: its branch, as the builder
   * reported it. A branch is a fact of this machine, so it is kept here and not in the log.
   */
  works: z.array(z.strictObject({ canvas: Id, branch: z.string().min(1).max(200) })).max(MAX_WORKS).optional(),
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
