import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import type {
  Actor,
  AgentLink,
  BoardInfo,
  Builder,
  BuilderContext,
  DigestReply,
  LinkContext,
  Refusal,
  ServerFile,
  ServerMessage,
} from '@keel/protocol';
import type { SessionReply } from '@keel/protocol';
import { ASSETS_DIR, ClientMessage, ONE_TIME_CODE_MS, PresenceUpdate, ROUTES, digest, isForeign, openCount, openThings, renderDigest } from '@keel/protocol';
import { AssetPlaceError, assetFile, assetsUsage, contentTypeOf, openAsset, saveAsset } from './assets';
import { Board } from './board';
import type { BuildInfo } from './build';
import { BuildRunner } from './build';
import { errCode } from './files';
import { MAX_ITEMS, idsParam, itemViews } from './items';
import { loadBuilder, loadLink } from './link';
import { PresenceHub } from './presence';
import { PrivateBoard, takeLock } from './private';
import { CHALLENGE_HEADER, PROOF_HEADER, ensureGitignore, proofOf, removeServerFile, sameSecret, writeServerFile } from './serverfile';
import { plain } from './text';
import type { Clock } from './wake';
import { WakeScheduler } from './wake';

/**
 * The board server: owns the log, refuses what breaks a rule, feeds the browser and the agent,
 * and wakes the agent when the owner pauses. It listens on 127.0.0.1 only.
 */

export const LIMITS = {
  /** A POST of drafts. A long ink stroke is the largest thing a draft carries. */
  events: 8 * 1024 * 1024,
  presence: 16 * 1024,
  asset: 20 * 1024 * 1024,
  /** All the board's files together, in bytes, and in number. */
  assetsTotal: 200 * 1024 * 1024,
  assetsCount: 2000,
  /** One websocket message. */
  ws: 8 * 1024 * 1024,
  /** Drafts in one POST. */
  drafts: 500,
  /** Ids in one GET of `ROUTES.items`. */
  items: MAX_ITEMS,
  /** The POST that trades a one-time code for the owner's token. */
  session: 4 * 1024,
} as const;

/** The most one-time codes that work at once. Each `keel-board link` makes one. */
const MAX_CODES = 8;

/** `BoardInfo`, with the names of the agent link and the builder, and how far the build is, for `keel-board status`. */
export type BoardInfoReply = BoardInfo & { link: string; builder: string; build?: BuildInfo };

/**
 * The three tokens. Each is made new when the server starts and is worth nothing once it
 * stops. None is written in the repository: they live in the board's private file while the
 * server runs.
 */
export interface Tokens {
  owner: string;
  agent: string;
  system: string;
}

/** The Content-Security-Policy of the app's shell, for a server on this port. */
export function shellPolicy(port: number): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}`,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** What a dropped file is served with: shown, never run, in an origin of its own. */
export const ASSET_POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";

export interface ServerOptions {
  /** The repository folder. The board lives in `.keel/board/` inside it. */
  repoDir: string;
  /**
   * Left out: the port this board used last time, so an open tab reconnects, or a free one.
   * When that port is taken, another is picked and the log says so. 0 picks a free port.
   * Any other number is that port, or an error when it is taken.
   */
  port?: number;
  /** Where the board's private folder lives, in place of `~/.keel`. Default: `KEEL_STATE_DIR`, else `~/.keel`. */
  stateRoot?: string;
  /** Check with git that a `built` part's commit exists. Default true. Off only for tests and fixtures. */
  checkCommits?: boolean;
  /** The built canvas app. Default: `workspace/app/dist`. */
  appDir?: string;
  /** One more origin allowed to call the server, for the app's dev server. */
  devOrigin?: string;
  /** `none`, `script:<module>`, or a module that exports `createLink`. */
  link?: string;
  linkOptions?: Record<string, string>;
  /**
   * `none`, or a module that exports `createBuilder`. Left out: the `link` module's
   * `createBuilder`, when it exports one.
   */
  builder?: string;
  clock?: Clock;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface RunningServer {
  readonly board: Board;
  readonly port: number;
  /** `http://127.0.0.1:<port>` */
  readonly origin: string;
  /** The page to open: an address with a one-time code, which the page trades for the owner's token. It holds no token. */
  readonly url: string;
  /** A fresh address for the owner's page, with a new one-time code. */
  link(): string;
  readonly tokens: Tokens;
  /** What `.keel/board/server.json` holds. */
  readonly file: ServerFile;
  /** The board's private folder, outside the repository. */
  readonly stateDir: string;
  /** The board's private file: the tokens and the owner's consents. */
  readonly private: PrivateBoard;
  readonly presence: PresenceHub;
  readonly linkName: string;
  readonly scheduler: WakeScheduler | undefined;
  /** The builder's name, or "none". */
  readonly builderName: string;
  /** The build's life on this board. */
  readonly builds: BuildRunner;
  close(): Promise<void>;
  /** Resolves when the server has closed, for any reason: `close`, or a stop over `ROUTES.stop`. */
  readonly closed: Promise<void>;
  /** Give the board back now: the tokens, `server.json`, the lock. For process exit, when nothing asynchronous can run. */
  releaseSync(): void;
}

/** `workspace/app/dist`, from either `src/` or the bundle in `dist/`. */
export function defaultAppDir(): string {
  return fileURLToPath(new URL('../../app/dist', import.meta.url));
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const ACTORS = ['owner', 'agent', 'system'] as const satisfies readonly Actor[];
const NO_AGENT = 'no agent is linked';

/** At most this many left-out lines are listed when a board opens. The rest are counted. */
const PROBLEMS_SHOWN = 5;
/** How long the log's seal waits for more events before it is written to the private file. */
const SEAL_DELAY_MS = 200;

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const log = opts.log ?? ((m: string) => process.stderr.write(`keel-board: ${plain(m)}\n`));
  const now = opts.now ?? (() => new Date());
  const repoDir = path.resolve(opts.repoDir);

  // The board's folders first, then its private file and its lock, and only then the log:
  // a second server for the same folder, however its path is spelled, stops here.
  const boardDir = Board.prepare(repoDir);
  const own = PrivateBoard.open(boardDir, opts.stateRoot);
  const unlock = takeLock(own.place, () => own.savedPort);
  let board: Board;
  try {
    board = Board.open(repoDir, { now, checkCommits: opts.checkCommits ?? true, sealed: own.logSeal, log });
  } catch (e) {
    unlock();
    throw e;
  }
  try {
    summarise(board, log);
    ensureGitignore(board.dir);
  } catch (e) {
    board.close();
    unlock();
    throw e;
  }
  // A log this machine's server did not write is history only: it came with a clone, a pull
  // or a checkout, or someone edited it. What the owner agreed to here was the board as it
  // stood then, so no agreement holds. And the lines this server did not write are marked as
  // from outside: the agent does not act on them until the owner keeps them.
  const ours = own.wrote(board.loaded);
  /** The log holds lines this server did not write. An empty log holds nothing to distrust. */
  const foreign = board.loaded.bytes > 0 && !ours;
  if (!ours && !own.firstOpen) {
    // Also when the log is gone: an agreement to a board that is no longer there holds for nothing.
    let dropped = 0;
    try {
      dropped = own.dropConsents();
    } catch (e) {
      log(`could not write the board's private file: ${e instanceof Error ? e.message : String(e)}`);
    }
    const lost = dropped === 0 ? '' : dropped === 1 ? ' One build you agreed to waits for your agreement again.' : ` ${dropped} builds you agreed to wait for your agreement again.`;
    if (foreign || dropped > 0) log(`log.jsonl is not as this server left it: it changed outside the board.${lost}`);
  }
  // Which lines came from outside: all of them, or the ones after what this server wrote.
  // They stay marked, across restarts, until the owner keeps them.
  if (foreign && board.state.seq > board.ownSeq) own.addForeign({ from: board.ownSeq + 1, to: board.state.seq });
  let sealTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Keep the log's seal in the private file, soon: one write for a burst of events. The seal
   * always follows the log as this server writes it, so the next start can tell every line
   * that came another way.
   */
  const keepSeal = (): void => {
    if (sealTimer !== undefined) return;
    sealTimer = setTimeout(() => {
      sealTimer = undefined;
      try {
        own.setLogSeal(board.seal());
      } catch (e) {
        log(`could not keep the log's seal: ${e instanceof Error ? e.message : String(e)}`);
      }
    }, SEAL_DELAY_MS);
    sealTimer.unref();
  };
  const tokens: Tokens = { owner: newToken(), agent: newToken(), system: newToken() };
  /**
   * The codes that open the owner's page: each is in an address the command printed, works
   * once, and stops working after `ONE_TIME_CODE_MS`. The page trades one for the owner's
   * token, so no token is ever in an address, a history or a bookmark.
   */
  const codes = new Map<string, number>();
  const mintCode = (): string => {
    const at = now().getTime();
    for (const [c, until] of codes) if (until <= at) codes.delete(c);
    // A handful at most: the newest ones win.
    while (codes.size >= MAX_CODES) codes.delete(codes.keys().next().value as string);
    const code = newToken();
    codes.set(code, at + ONE_TIME_CODE_MS);
    return code;
  };
  /** Spend a code. True when it was a live one. Whatever the answer, it is gone after this. */
  const spendCode = (code: string): boolean => {
    let found: string | undefined;
    // Compared in a way that takes the same time whether or not a code matches.
    for (const c of codes.keys()) if (sameSecret(code, c)) found = c;
    if (found === undefined) return false;
    const until = codes.get(found)!;
    codes.delete(found);
    return until > now().getTime();
  };
  const presence = new PresenceHub({ state: 'away', note: NO_AGENT }, now);
  const appDir = path.resolve(opts.appDir ?? defaultAppDir());
  const devOrigin = opts.devOrigin ? new URL(opts.devOrigin).origin : undefined;
  const allowed = new Set<string>();
  /** The Host headers this server answers to. Anything else is a page that rebinds a name to 127.0.0.1. */
  const hosts = new Set<string>();
  const clients = new Map<WebSocket, Actor>();
  const alive = new WeakSet<WebSocket>();
  let origin = 'http://127.0.0.1';
  const pageUrlOf = (code: string): string => origin + '/?code=' + code;
  let policy = shellPolicy(0);
  let linkName = 'none';
  let builderName = 'none';
  let builds: BuildRunner | undefined;

  /* ---------------------------------------------------------- helpers */

  /**
   * Who sent this request: a bearer token, else `?token=`. There is no cookie: a browser sends
   * a cookie for 127.0.0.1 to every port, so any local page could act as the owner with it.
   */
  const actorOf = (req: http.IncomingMessage, url: URL): Actor | undefined => {
    const auth = req.headers.authorization;
    let t = typeof auth === 'string' && /^Bearer /i.test(auth) ? auth.slice(7).trim() : undefined;
    if (!t) t = url.searchParams.get('token') ?? undefined;
    if (!t) return undefined;
    for (const actor of ACTORS) if (sameSecret(t, tokens[actor])) return actor;
    return undefined;
  };

  const hostOk = (req: http.IncomingMessage): boolean => {
    const host = req.headers.host;
    return typeof host === 'string' && hosts.has(host.toLowerCase());
  };

  const info = (role: Actor): BoardInfoReply => {
    const build = builds?.status();
    return {
      name: board.state.name,
      seq: board.state.seq,
      role,
      open: openCount(board.state),
      presence: presence.get(),
      link: linkName,
      builder: builderName,
      ...(own.foreign ? { foreign: [...own.foreign] } : {}),
      ...(build ? { build } : {}),
    };
  };

  const send = (ws: WebSocket, msg: ServerMessage): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const broadcast = (msg: ServerMessage): void => {
    const text = JSON.stringify(msg);
    for (const ws of clients.keys()) if (ws.readyState === WebSocket.OPEN) ws.send(text);
  };

  /* ------------------------------------------------------------- http */

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    // On every response. The route for a dropped file puts its own, stricter policy in place.
    res.setHeader('content-security-policy', policy);
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('cross-origin-resource-policy', 'same-origin');
    res.setHeader('x-frame-options', 'DENY');
    if (!hostOk(req)) {
      res.setHeader('connection', 'close');
      return json(res, 403, { error: `This server answers only to 127.0.0.1:${port} and localhost:${port}.` });
    }
    const reqOrigin = req.headers.origin;
    if (reqOrigin !== undefined && !allowed.has(reqOrigin)) {
      return json(res, 403, { error: `Requests from ${reqOrigin} are refused. Open the board from ${origin}.` });
    }
    if (reqOrigin !== undefined && reqOrigin === devOrigin) {
      res.setHeader('access-control-allow-origin', devOrigin);
      res.setHeader('vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      res.setHeader('access-control-max-age', '600');
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url ?? '/', origin);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return api(req, res, url);
    if (url.pathname === ROUTES.ws) return json(res, 426, { error: 'This is the websocket. Connect with a websocket client.' });
    return serveApp(req, res, url);
  };

  const api = async (req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> => {
    res.setHeader('cache-control', 'no-store');
    const route = url.pathname;
    const method = req.method ?? 'GET';

    // The one route with no token: the page trades the code from its address for the owner's token.
    if (route === ROUTES.session) {
      if (method !== 'POST') return notAllowed(res, 'POST');
      const body = await readJson(req, LIMITS.session);
      const code = typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;
      if (typeof code !== 'string' || code.length === 0 || code.length > 200 || !spendCode(code)) {
        return json(res, 401, { error: 'This address was used already, or is more than five minutes old. Run "keel-board link" for a new one.' });
      }
      return json(res, 200, { token: tokens.owner, role: 'owner' } satisfies SessionReply);
    }

    const actor = actorOf(req, url);
    if (!actor) return json(res, 401, { error: 'A token is needed: "Authorization: Bearer <token>", or "?token=".' });

    if (route === ROUTES.link) {
      if (method !== 'POST') return notAllowed(res, 'POST');
      if (actor !== 'system') return json(res, 403, { error: 'Only the system asks for a new address: run "keel-board link".' });
      return json(res, 200, { url: pageUrlOf(mintCode()) });
    }

    if (route === ROUTES.board) {
      if (method !== 'GET') return notAllowed(res, 'GET');
      const challenge = req.headers[CHALLENGE_HEADER];
      if (actor === 'system' && typeof challenge === 'string' && challenge.length > 0 && challenge.length <= 128) {
        // keel-board checks that this is the board's own server before it trusts what it says.
        res.setHeader(PROOF_HEADER, proofOf(own.boardKey, challenge));
      }
      return json(res, 200, info(actor));
    }

    if (route === ROUTES.keep) {
      if (method !== 'POST') return notAllowed(res, 'POST');
      if (actor !== 'owner') return json(res, 403, { error: 'Only the owner keeps what came with the log.' });
      const kept = own.keepForeign();
      // What was held back is the board's own now: the agent may answer it.
      if (kept) scheduler?.start();
      return json(res, 200, { kept });
    }

    if (route === ROUTES.stop) {
      if (method !== 'POST') return notAllowed(res, 'POST');
      if (actor !== 'system') return json(res, 403, { error: 'Only the system stops the board server: run "keel-board stop".' });
      res.once('finish', () => {
        void close();
      });
      return json(res, 200, { stopping: true });
    }

    if (route === ROUTES.events) {
      if (method === 'GET') return json(res, 200, { events: board.eventsAfter(intParam(url, 'after')) });
      if (method !== 'POST') return notAllowed(res, 'GET, POST');
      const body = await readJson(req, LIMITS.events);
      const drafts = typeof body === 'object' && body !== null ? (body as { drafts?: unknown }).drafts : undefined;
      if (!Array.isArray(drafts)) return json(res, 400, { error: 'Send { "drafts": [ ... ] }.' });
      if (drafts.length > LIMITS.drafts) return json(res, 400, { error: `At most ${LIMITS.drafts} drafts at once.` });
      const r = board.post(drafts, actor);
      if (!r.ok) return json(res, 422, { rule: r.rule, reason: r.reason, index: r.index } satisfies Refusal);
      return json(res, 200, { events: r.events });
    }

    if (route === ROUTES.digest) {
      if (method !== 'GET') return notAllowed(res, 'GET');
      const d = digest(board.state, { since: intParam(url, 'since'), foreign: own.foreign });
      return json(res, 200, { digest: d, text: renderDigest(d) } satisfies DigestReply);
    }

    if (route === ROUTES.state) {
      if (method !== 'GET') return notAllowed(res, 'GET');
      return json(res, 200, board.state);
    }

    if (route === ROUTES.items) {
      if (method !== 'GET') return notAllowed(res, 'GET');
      const ids = idsParam(url.searchParams.get('ids'));
      if (ids === undefined) return json(res, 400, { error: 'An item id is 1 to 48 characters of a-z, 0-9 and "-": ?ids=a,b.' });
      if (ids.length === 0) return json(res, 400, { error: 'Name the items: ?ids=a,b.' });
      if (ids.length > LIMITS.items) return json(res, 400, { error: `At most ${LIMITS.items} items at once.` });
      return json(res, 200, { items: itemViews(board.state, ids) });
    }

    if (route === ROUTES.presence) {
      if (method !== 'POST') return notAllowed(res, 'POST');
      if (actor === 'owner') return json(res, 403, { error: 'Presence is what the agent does. The agent or the system reports it.' });
      const parsed = PresenceUpdate.safeParse(await readJson(req, LIMITS.presence));
      if (!parsed.success) return json(res, 400, { error: parsed.error.issues.map((i) => `${i.path.join('.') || 'presence'}: ${i.message}`).join('; ') });
      // The system's tools are the build's: what they say shows while the build runs, and not after it.
      if (actor === 'system') {
        builds?.builderPresence(parsed.data);
        return json(res, 200, { presence: presence.get() });
      }
      return json(res, 200, { presence: presence.set(parsed.data) });
    }

    if (route === ROUTES.assets) {
      if (method !== 'POST') return notAllowed(res, 'POST');
      if (actor !== 'owner') return json(res, 403, { error: 'Only the owner drops files on the board.' });
      const raw = url.searchParams.get('name');
      if (!raw) return json(res, 400, { error: 'Name the file: ?name=<file name>.' });
      const before = assetsUsage(board.realAssetsDir);
      if (before.count >= LIMITS.assetsCount) {
        res.setHeader('connection', 'close');
        return json(res, 413, { error: `The board holds ${LIMITS.assetsCount} files already, the most it takes. Nothing was saved.` });
      }
      const bytes = await readBody(req, LIMITS.asset);
      if (before.bytes + bytes.length > LIMITS.assetsTotal) {
        return json(res, 413, { error: `The board's files would pass ${LIMITS.assetsTotal / (1024 * 1024)} MB together, the most it keeps. Nothing was saved.` });
      }
      let name: string;
      try {
        name = saveAsset(board.assetsDir, raw, bytes, board.realAssetsDir);
      } catch (e) {
        if (e instanceof AssetPlaceError) return json(res, 409, { error: e.message });
        throw e;
      }
      return json(res, 200, { asset: `${ASSETS_DIR}/${name}` });
    }

    if (route.startsWith(`${ROUTES.assets}/`)) {
      if (method !== 'GET' && method !== 'HEAD') return notAllowed(res, 'GET');
      let name: string;
      try {
        name = decodeURIComponent(route.slice(ROUTES.assets.length + 1));
      } catch {
        return json(res, 400, { error: 'The asset name is not valid.' });
      }
      if (!assetFile(board.realAssetsDir, name)) return json(res, 400, { error: 'An asset is one file name inside assets/.' });
      const opened = openAsset(board.assetsDir, board.realAssetsDir, name);
      if (!opened) return json(res, 404, { error: `No asset "${name}".` });
      // A dropped file is shown, never run: it gets an origin of its own.
      res.setHeader('content-security-policy', ASSET_POLICY);
      res.setHeader('cache-control', 'private, max-age=3600');
      return sendFd(req, res, opened.fd, opened.size, name);
    }

    return json(res, 404, { error: `There is no route ${route}.` });
  };

  /** The app's shell and its files. They hold nothing of the board, so they need no token: every route and the websocket do. */
  const serveApp = (req: http.IncomingMessage, res: http.ServerResponse, url: URL): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return notAllowed(res, 'GET');
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return json(res, 400, { error: 'The path is not valid.' });
    }
    if (rel.includes('\0')) return json(res, 400, { error: 'The path is not valid.' });
    const ext = path.posix.extname(rel);
    // The shell may carry the token in its address: never kept by a cache.
    if (!ext || ext === '.html') res.setHeader('cache-control', 'no-store');
    if (!statOf(appDir)?.isDirectory()) return buildPage(res, appDir);
    let file = path.resolve(appDir, `.${path.posix.normalize(rel)}`);
    if (file !== appDir && !file.startsWith(appDir + path.sep)) return json(res, 404, { error: 'Not found.' });
    let st = statOf(file);
    if (st?.isDirectory()) {
      file = path.join(file, 'index.html');
      st = statOf(file);
    }
    if (!st?.isFile()) {
      // A path with an extension is a missing file. Anything else is a page of the app.
      if (path.posix.extname(rel)) return json(res, 404, { error: 'Not found.' });
      file = path.join(appDir, 'index.html');
      st = statOf(file);
      if (!st?.isFile()) return buildPage(res, appDir);
    }
    if (!file.endsWith('.html')) res.setHeader('cache-control', 'public, max-age=3600');
    return sendFile(req, res, file, st.size);
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (e instanceof HttpError) {
        if (e.status === 413) res.setHeader('connection', 'close');
        return json(res, e.status, { error: e.message });
      }
      log(`error on ${req.method} ${req.url?.split('?')[0]}: ${e instanceof Error ? e.message : String(e)}`);
      json(res, 500, { error: 'The board server failed on this request.' });
    });
  });

  /* -------------------------------------------------------- websocket */

  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.ws });

  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => {});
    const deny = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (!hostOk(req)) return deny(403, 'Forbidden');
    const url = new URL(req.url ?? '/', origin);
    if (url.pathname !== ROUTES.ws) return deny(404, 'Not Found');
    const reqOrigin = req.headers.origin;
    if (reqOrigin !== undefined && !allowed.has(reqOrigin)) return deny(403, 'Forbidden');
    const actor = actorOf(req, url);
    if (!actor) return deny(401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, actor));
  });

  const onSocket = (ws: WebSocket, actor: Actor): void => {
    clients.set(ws, actor);
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    const build = builds?.status();
    send(ws, { t: 'init', name: board.state.name, role: actor, events: [...board.events], presence: presence.get(), ...(build ? { build } : {}) });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return send(ws, { t: 'refused', ref: '', rule: 'shape', reason: 'Send JSON text.' });
      let value: unknown;
      try {
        value = JSON.parse(String(data));
      } catch {
        return send(ws, { t: 'refused', ref: '', rule: 'shape', reason: 'The message is not JSON.' });
      }
      const m = ClientMessage.safeParse(value);
      if (!m.success) {
        const ref = (value as { ref?: unknown } | null)?.ref;
        return send(ws, {
          t: 'refused',
          ref: typeof ref === 'string' ? ref.slice(0, 64) : '',
          rule: 'shape',
          reason: 'A message is {"t":"post","ref":"...","draft":{...}} or {"t":"ping"}.',
        });
      }
      if (m.data.t === 'ping') return send(ws, { t: 'pong' });
      const { ref, draft } = m.data;
      let r: ReturnType<Board['post']>;
      try {
        r = board.post([draft], actor);
      } catch (e) {
        log(`could not write the log: ${e instanceof Error ? e.message : String(e)}`);
        return send(ws, { t: 'refused', ref, rule: 'shape', reason: 'The server could not write the log. Nothing was saved.' });
      }
      // Every client, the sender too, has already had the event. `ok` settles the sender's post.
      if (r.ok && r.events[0]) send(ws, { t: 'ok', ref, event: r.events[0] });
      else if (!r.ok) send(ws, { t: 'refused', ref, rule: r.rule, reason: r.reason });
    });
  };

  const heartbeat = setInterval(() => {
    for (const ws of clients.keys()) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  // What the build driver does now, pushed to the page when it changes. Some changes come
  // with no event (a run that ends, a build that waits its turn), so it is also looked at
  // once a second.
  let lastBuild = 'null';
  const pushBuild = (): void => {
    const build = builds?.status() ?? null;
    const json = JSON.stringify(build);
    if (json === lastBuild) return;
    lastBuild = json;
    broadcast({ t: 'build', build });
  };
  const buildWatch = setInterval(pushBuild, 1000);
  buildWatch.unref();

  /* ------------------------------------------------------------ start */

  const listen = (p: number) =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(p, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  const saved = own.savedPort;
  const want = opts.port ?? saved ?? 0;
  try {
    try {
      await listen(want);
    } catch (e) {
      // The port this board had last time is taken: take another, and say so.
      if (opts.port !== undefined || want === 0 || errCode(e) !== 'EADDRINUSE') throw e;
      await listen(0);
      log(`port ${want} is taken, so the board moved to port ${(server.address() as AddressInfo).port}. A tab open at the old address must be opened again.`);
    }
  } catch (e) {
    clearInterval(heartbeat);
    clearInterval(buildWatch);
    board.close();
    unlock();
    if (errCode(e) === 'EADDRINUSE') throw new Error(`Port ${want} is taken. Leave out --port to let the board pick one.`);
    throw e;
  }
  const port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  policy = shellPolicy(port);
  allowed.add(origin);
  allowed.add(`http://localhost:${port}`);
  hosts.add(`127.0.0.1:${port}`);
  hosts.add(`localhost:${port}`);
  if (devOrigin) {
    allowed.add(devOrigin);
    // The app's dev server proxies to this one and keeps its own Host.
    hosts.add(new URL(devOrigin).host.toLowerCase());
  }
  const startedAt = now().toISOString();
  try {
    // The tokens live here, outside the repository, while the server runs.
    own.setRunning(port, { pid: process.pid, ownerToken: tokens.owner, agentToken: tokens.agent, systemToken: tokens.system, startedAt }, board.seal());
  } catch (e) {
    clearInterval(heartbeat);
    clearInterval(buildWatch);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    board.close();
    unlock();
    throw e;
  }

  // The seal follows every event this server writes.
  board.subscribe(() => keepSeal());

  // The owner's consent to a build, recorded only for a press the server admits live. Events
  // read from disk never reach a listener, so a log a repository ships grants nothing.
  board.subscribe((events, state) => {
    for (const ev of events) {
      if (ev.by !== 'owner' || (ev.type !== 'build.start' && ev.type !== 'build.resume')) continue;
      const c = state.chapters[ev.chapter];
      const check = ev.type === 'build.start' ? ev.check : c?.check;
      const track = ev.type === 'build.start' ? ev.track : c?.track;
      if (check === undefined || !track) continue;
      try {
        own.addConsent({ chapter: ev.chapter, event: ev.id, check, track: [...track], at: ev.at });
      } catch (e) {
        log(`could not keep the owner's consent to build "${ev.chapter}": ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  });

  board.subscribe((events) => {
    for (const event of events) broadcast({ t: 'event', event });
    // After the build driver has heard the same events.
    queueMicrotask(pushBuild);
  });
  presence.subscribe((p) => broadcast({ t: 'presence', presence: p }));

  const file: ServerFile = { pid: process.pid, port, startedAt };
  const pageUrl = pageUrlOf(mintCode());

  let link: AgentLink | undefined;
  let builder: Builder | undefined;
  let scheduler: WakeScheduler | undefined;
  let closing: Promise<void> | undefined;
  let markClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });

  const close = (): Promise<void> =>
    (closing ??= (async () => {
      scheduler?.close();
      // The builder pauses and closes while the server still listens: it may report as it stops.
      try {
        if (builds) await builds.close();
        else await builder?.close();
      } catch (e) {
        log(`the builder did not close cleanly: ${e instanceof Error ? e.message : String(e)}`);
      }
      clearInterval(heartbeat);
      clearInterval(buildWatch);
      for (const ws of clients.keys()) ws.close(1001, 'The board server stopped.');
      try {
        await link?.close();
      } catch (e) {
        log(`the link did not close cleanly: ${e instanceof Error ? e.message : String(e)}`);
      }
      for (const ws of clients.keys()) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      board.close();
      release();
    })().finally(() => markClosed()));

  /** Give the board back: the tokens out of the private file, the note out of the repository, the lock. All synchronous, for process exit too. */
  const release = (): void => {
    if (sealTimer !== undefined) clearTimeout(sealTimer);
    sealTimer = undefined;
    try {
      own.clearRunning(board.seal());
    } catch {
      // The tokens die with the process anyway. A seal that was not kept only makes the next start ask again.
    }
    try {
      removeServerFile(board.dir, file);
    } catch {
      // A note only.
    }
    unlock();
  };

  try {
    writeServerFile(board.dir, file);
    const ctx: LinkContext = {
      repoDir,
      boardDir: board.dir,
      stateDir: own.place.linkDir,
      serverUrl: origin,
      agentToken: tokens.agent,
      options: opts.linkOptions ?? {},
      presence: (u) => {
        presence.set(u);
      },
      log: (m) => log(`link: ${m}`),
    };
    link = await loadLink(opts.link ?? 'none', ctx);
    const bctx: BuilderContext = {
      ...ctx,
      stateDir: own.place.builderDir,
      systemToken: tokens.system,
      presence: (u) => builds?.builderPresence(u),
      log: (m) => log(`builder: ${m}`),
    };
    const loaded = await loadBuilder(opts.builder, opts.link ?? 'none', bctx);
    if (loaded) {
      builder = loaded.builder;
      builderName = loaded.name;
    }
  } catch (e) {
    await close();
    throw e;
  }

  /** What the pill says when the agent is not in a wake and nothing builds. */
  const rest = (): PresenceUpdate => (link ? { state: 'listening' } : { state: 'away', note: NO_AGENT });
  const runner = new BuildRunner({
    builder,
    consent: (chapter, check, track) => own.consentFor(chapter, check, track),
    state: () => board.state,
    post: (drafts) => {
      const r = board.post(drafts, 'system');
      if (!r.ok) log(`build: the feed refused an update (${r.rule}: ${r.reason})`);
    },
    presence,
    inWake: () => scheduler?.busy ?? false,
    rest,
    log: (m) => log(`build: ${m}`),
  });
  builds = runner;

  if (link) {
    linkName = link.name;
    // An agent is linked now. Keep what the link said while it started, if it said anything.
    if (presence.get().note === NO_AGENT) presence.set({ state: 'listening' });
    const s = new WakeScheduler({
      link,
      state: () => board.state,
      presence,
      clock: opts.clock,
      log: (m) => log(`wake: ${m}`),
      resting: () => runner.resting(),
      foreign: () => own.foreign,
    });
    scheduler = s;
    board.subscribe((events) => s.notify(events));
    // Marks that waited are answered at start. Marks that came with a log from outside, a
    // cloned repository's say, are nobody's here: they wake no one until the owner keeps them.
    s.start();
    const outside = own.foreign;
    const held = outside ? openThings(board.state).filter((o) => isForeign(outside, o.seq)).length : 0;
    if (held > 0) {
      const what = held === 1 ? 'One open mark came' : `${held} open marks came`;
      log(`${own.firstOpen ? 'this board is new to this machine. ' : ''}${what} with the log from outside: the agent leaves ${held === 1 ? 'it' : 'them'} until you keep ${held === 1 ? 'it' : 'them'} on the board.`);
    }
  }
  board.subscribe((events) => runner.notify(events));
  // A build that was going when the server stopped carries on.
  runner.start();

  return {
    board,
    port,
    origin,
    url: pageUrl,
    link: () => pageUrlOf(mintCode()),
    tokens,
    file,
    stateDir: own.place.dir,
    private: own,
    presence,
    linkName,
    scheduler,
    builderName,
    builds: runner,
    close,
    closed,
    releaseSync: release,
  };
}

/** Say what was left out of the log when the board opened, and what it says was built with no commit to show for it. */
function summarise(board: Board, log: (m: string) => void): void {
  const n = board.problems.length;
  if (n > 0) {
    log(`log.jsonl: ${board.events.length} events read, ${n} line${n === 1 ? '' : 's'} left out. The file is left as it is.`);
    for (const p of board.problems.slice(0, PROBLEMS_SHOWN)) log(`log.jsonl line ${p.line} was skipped (${p.reason}).`);
    if (n > PROBLEMS_SHOWN) log(`log.jsonl: and ${n - PROBLEMS_SHOWN} more lines left out.`);
  }
  const u = board.unproven.length;
  if (u > 0) {
    log(`log.jsonl: ${u} line${u === 1 ? ' says' : 's say'} a part was built at a commit this repository does not have. The board shows ${u === 1 ? 'it' : 'them'} as the log says.`);
    for (const p of board.unproven.slice(0, PROBLEMS_SHOWN)) log(`log.jsonl line ${p.line}: ${p.reason}.`);
    if (u > PROBLEMS_SHOWN) log(`log.jsonl: and ${u - PROBLEMS_SHOWN} more.`);
  }
}

/* ---------------------------------------------------------------- helpers */

function newToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function intParam(url: URL, name: string): number {
  const n = Number(url.searchParams.get(name) ?? 0);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function notAllowed(res: http.ServerResponse, allow: string): void {
  res.setHeader('allow', allow);
  json(res, 405, { error: `Use ${allow}.` });
}

function statOf(file: string, noFollow = false): fs.Stats | undefined {
  try {
    return noFollow ? fs.lstatSync(file) : fs.statSync(file);
  } catch {
    return undefined;
  }
}

function sendFile(req: http.IncomingMessage, res: http.ServerResponse, file: string, size: number): void {
  res.writeHead(200, { 'content-type': contentTypeOf(file), 'content-length': size });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/** Send a file that is already open. The descriptor is closed when the send ends. */
function sendFd(req: http.IncomingMessage, res: http.ServerResponse, fd: number, size: number, name: string): void {
  res.writeHead(200, { 'content-type': contentTypeOf(name), 'content-length': size });
  if (req.method === 'HEAD') {
    fs.closeSync(fd);
    res.end();
    return;
  }
  const stream = fs.createReadStream('', { fd, autoClose: true });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    return Promise.reject(new HttpError(413, `The body is larger than ${limit} bytes.`));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(new HttpError(413, `The body is larger than ${limit} bytes.`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (e) => {
      if (done) return;
      done = true;
      reject(e);
    });
  });
}

async function readJson(req: http.IncomingMessage, limit: number): Promise<unknown> {
  const bytes = await readBody(req, limit);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new HttpError(400, 'The body is not JSON.');
  }
}

function buildPage(res: http.ServerResponse, appDir: string): void {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Keel board</title></head>
<body style="font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem">
<h1>The board server runs.</h1>
<p>The canvas app is not built yet. In <code>workspace/</code>, run:</p>
<pre>npm run build -w @keel/board-app</pre>
<p>Then reload this page. The server looked for the app in <code>${escapeHtml(appDir)}</code>.
To serve it from somewhere else, start the server with <code>--app-dir &lt;folder&gt;</code>.</p>
</body></html>
`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'content-length': Buffer.byteLength(html) });
  res.end(html);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
