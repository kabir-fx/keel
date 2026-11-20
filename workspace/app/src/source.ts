import type { Actor, BoardEvent, BoardInfo, BoardState, ForeignRange, Id, Presence, PresenceUpdate, RuleId, ServerMessage } from '@keel/protocol';
import { ROUTES, admit, isMark, reduce, replay } from '@keel/protocol';
import type { Draft } from './drafts';
import { cleanAssetName } from './marks';

/**
 * Where the board comes from. The app only reads `state` and `presence`, and only changes the
 * board through `post`. Two kinds: `serverSource` speaks the websocket of the contract, and
 * `localSource` holds the log in memory for fixtures and tests.
 */
export interface BoardSource {
  readonly state: BoardState;
  readonly presence: Presence;
  /** Who this connection is. It sets `by` on every event the app posts. */
  readonly role: Actor;
  readonly connection: Connection;
  /**
   * What the server says about the build it drives: running, queued, waiting, paused or
   * stopped. It comes on the websocket, in `init` and in a `build` message whenever it changes.
   * Undefined when no build goes, or where no server drives one (a fixture).
   */
  readonly build?: BuildInfo | undefined;
  /**
   * What the owner can look at: for each built chapter that has something to show, the address
   * of its page. It comes in `init` and in a `shows` message whenever it changes, and is said to
   * the owner's page only. Every address here passed `safeShowUrl`. Empty when there is nothing.
   */
  readonly shows: ReadonlyMap<string, string>;
  /**
   * The runs of events that came with the log from outside (a clone, a pull, a change to the
   * file outside the board) and that the owner has not kept yet. Undefined when there are none,
   * and always for a board in memory.
   */
  readonly foreign?: readonly ForeignRange[] | undefined;
  /** The owner keeps what came from outside. Resolves true when the server took it. */
  keep?(): Promise<boolean>;
  /** True when the board keeps files the app uploads where the agent can read them: snapshots are worth taking. */
  readonly snapshots: boolean;
  /**
   * Read a stored file back, with the page's token: never by a bare address, so no cookie is
   * needed and the token never sits in a link. Undefined when it cannot be read.
   */
  readAsset(asset: string): Promise<Blob | undefined>;
  post(draft: Draft): Promise<PostResult>;
  /** Store a file in the board's `assets/`. Resolves to its `AssetPath`. */
  upload(name: string, body: Blob): Promise<UploadResult>;
  /** Called after every change of state, presence or connection. Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /**
   * Called with each mark of the owner's that reaches the board as made on this page, though it
   * was not posted through `post`: the owner's marks a played fixture feeds in, which stand for
   * the owner at this page. Returns the unsubscribe. Left out where the page posts all its own.
   */
  onOwnMark?(listener: (mark: Id) => void): () => void;
  close(): void;
}

/** `refused`: the server did not accept this page's session (a 401). It will not come back by itself. */
export type Connection = 'connecting' | 'open' | 'closed' | 'refused';

export type PostResult =
  | { ok: true; event: BoardEvent }
  | { ok: false; rule: RuleId | 'offline'; reason: string };

export type UploadResult = { ok: true; asset: string } | { ok: false; reason: string };

/** What the server says about the build it drives (`BoardInfo.build`). */
export type BuildInfo = NonNullable<BoardInfo['build']>;

/** No page to show: one map, so a page that shows nothing keeps the same value. */
const NO_SHOWS: ReadonlyMap<string, string> = new Map();

/**
 * The address of a built page, when it is one the board may link to: plain http on this
 * machine, where the board server serves it. Anything else is dropped, so an address from the
 * wire (a `javascript:` one, or another site) never becomes a link on the page.
 */
export function safeShowUrl(address: unknown): string | undefined {
  if (typeof address !== 'string') return undefined;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:') return undefined;
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return undefined;
  return url.href;
}

/**
 * The map the server sent, with only the addresses `safeShowUrl` keeps. A `Map`, not an object,
 * so a chapter named like an object's own key (`constructor`) finds nothing it was not given.
 */
function keptShows(shows: Record<string, string> | undefined): ReadonlyMap<string, string> {
  const kept = new Map<string, string>();
  if (shows && typeof shows === 'object') {
    for (const [chapter, address] of Object.entries(shows)) {
      const safe = safeShowUrl(address);
      if (safe) kept.set(chapter, safe);
    }
  }
  return kept.size > 0 ? kept : NO_SHOWS;
}

/** The largest file the board server takes. */
export const MAX_UPLOAD = 20 * 1024 * 1024;

const OFFLINE: PostResult = {
  ok: false,
  rule: 'offline',
  reason: 'The board server is not connected, so this was not saved. It reconnects by itself: try again in a moment.',
};

/** What to do when the server no longer knows this page: it started again, and its tokens are new each time. */
export const REOPEN = 'Open the board again from your terminal: keel-board open. When it already runs, keel-board link prints a new address.';
/** What to do when the page has no token at all. */
export const OPEN_FROM_TERMINAL = 'Open the board from your terminal: keel-board open. When it already runs, keel-board link prints a new address.';
/** What to do when the address held a code that no longer works. */
export const CODE_SPENT = 'This address was used already, or is more than five minutes old. Get a new one from your terminal: keel-board link';

const REFUSED: PostResult = {
  ok: false,
  rule: 'offline',
  reason: `The board did not accept this page, so this was not saved. ${REOPEN}`,
};

/** Why a socket closed: the server refused the session, it answered, or it is not there. */
export type Probe = 'refused' | 'ok' | 'down';

class Listeners {
  private readonly set = new Set<() => void>();
  add = (l: () => void) => {
    this.set.add(l);
    return () => {
      this.set.delete(l);
    };
  };
  emit = () => {
    for (const l of this.set) l();
  };
}

const nowIso = () => new Date().toISOString();

/* ------------------------------------------------------------------- local */

export interface LocalOptions {
  events?: readonly BoardEvent[];
  role?: Actor;
  presence?: PresenceUpdate;
  /** The time for the next event. The default never runs behind the log's last event. */
  clock?: () => string;
  /** Called with each event the source admits. */
  onAdmit?: (event: BoardEvent) => void;
}

/** A board in memory. Every post goes through `admit`, so it obeys the same rules as the server. */
export class LocalSource implements BoardSource {
  state: BoardState;
  presence: Presence;
  readonly role: Actor;
  readonly connection: Connection = 'open';
  readonly snapshots = false;
  readonly events: BoardEvent[];
  /** Files uploaded in memory, by asset path. */
  readonly assets = new Map<string, Blob>();
  private readonly listeners = new Listeners();
  private readonly clock: () => string;
  private readonly onAdmit?: (event: BoardEvent) => void;

  constructor(opts: LocalOptions = {}) {
    this.events = [...(opts.events ?? [])];
    this.state = replay(this.events);
    this.role = opts.role ?? 'owner';
    this.presence = { state: 'listening', ...opts.presence, since: nowIso() };
    this.onAdmit = opts.onAdmit;
    this.clock = opts.clock ?? (() => this.after(nowIso()));
  }

  /** A time no earlier than the last event, so the log stays in order. */
  private after(t: string): string {
    const last = this.events[this.events.length - 1]?.at;
    if (!last || last < t) return t;
    return new Date(Date.parse(last) + 1000).toISOString();
  }

  post = (draft: Draft): Promise<PostResult> => this.postAs(this.role, draft);

  /** Post as another actor: how a fixture or a test plays the agent on a board in memory. */
  postAs = (by: Actor, draft: Draft): Promise<PostResult> => {
    // While a recorded log is fed in, what the page posts is numbered after the last recorded
    // event, so it never takes an id the recording still holds.
    const numbered = this.state.seq < this.recordedUpTo ? { ...this.state, seq: this.recordedUpTo } : this.state;
    const r = admit(numbered, draft, by, this.clock());
    if (!r.ok) return Promise.resolve({ ok: false, rule: r.rule, reason: r.reason });
    this.state = r.state;
    this.events.push(r.event);
    this.onAdmit?.(r.event);
    this.listeners.emit();
    return Promise.resolve({ ok: true, event: r.event });
  };

  /** Keep the file in memory under a name no other asset has, as the server would on disk. */
  upload = async (name: string, body: Blob): Promise<UploadResult> => {
    if (body.size > MAX_UPLOAD) return { ok: false, reason: `The file is larger than ${MAX_UPLOAD / 1024 / 1024} MB.` };
    const clean = cleanAssetName(name);
    const dot = clean.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, ''];
    let asset = `assets/${clean}`;
    for (let i = 2; this.assets.has(asset); i++) asset = `assets/${stem}-${i}${ext}`;
    this.assets.set(asset, body);
    return { ok: true, asset };
  };

  /** A file kept in memory. */
  readAsset = async (asset: string): Promise<Blob | undefined> => this.assets.get(asset);

  build: BuildInfo | undefined = undefined;
  foreign: readonly ForeignRange[] | undefined = undefined;
  /** A played fixture has nothing to show: no server built anything. */
  shows: ReadonlyMap<string, string> = NO_SHOWS;

  /** Say which events came from outside, as a server would: for tests. A fixture has none. */
  setForeign(ranges: readonly ForeignRange[] | undefined): void {
    this.foreign = ranges && ranges.length > 0 ? ranges : undefined;
    this.listeners.emit();
  }

  /** Keep what came from outside: in memory, they are simply the board's own from now on. */
  keep = async (): Promise<boolean> => {
    this.setForeign(undefined);
    return true;
  };

  /** Say what the server would say about the build: how a test plays the server on a board in memory. */
  setBuild(info: BuildInfo | undefined): void {
    this.build = info;
    this.listeners.emit();
  }

  /** Say what the server would say there is to show, checked as the server's would be: for tests. */
  setShows(shows: Record<string, string> | undefined): void {
    this.shows = keptShows(shows);
    this.listeners.emit();
  }

  /** The number of the last event a recorded log will feed in: see `expectRecorded`. */
  private recordedUpTo = 0;

  /**
   * Say that a recorded log will be fed in up to the event numbered `seq`. Until it has been, the
   * page's own posts are numbered after it. A played fixture holds every `item.place` and hands
   * each one in with the picture it places, so the page posts nothing during a play. A
   * placeholder the agent is still drawing gets a spot on this page only, as on a live board, and
   * is placed in the log once it is finished (`board/placement.ts`), and that `item.place` comes
   * from the fixture too. This keeps the ids apart anyway, for a log that leaves placing to the
   * page (the golden fixture) and for an owner who draws while it plays.
   */
  expectRecorded(seq: number): void {
    this.recordedUpTo = seq;
  }

  /**
   * Take events as they were recorded: their own ids, times and actors, applied with the
   * contract's `reduce` and not admitted again, since the log already passed the rules once.
   * Several events are one change, told to the listeners once.
   */
  feed(events: readonly BoardEvent[]): void {
    if (events.length === 0) return;
    let state = this.state;
    for (const ev of events) state = reduce(state, ev);
    this.state = state;
    this.events.push(...events);
    this.listeners.emit();
    // A mark fed in as this page's own was made here, as far as the page can tell.
    for (const ev of events) if (ev.type === 'item.add' && ev.by === this.role && isMark(ev.item)) for (const l of this.ownMarks) l(ev.item.id);
  }

  private readonly ownMarks = new Set<(mark: Id) => void>();

  onOwnMark = (listener: (mark: Id) => void): (() => void) => {
    this.ownMarks.add(listener);
    return () => this.ownMarks.delete(listener);
  };

  /** Set what the agent is doing, as the server would on a presence report. */
  setPresence(p: PresenceUpdate): void {
    this.presence = { ...p, since: nowIso() };
    this.listeners.emit();
  }

  subscribe = (l: () => void) => this.listeners.add(l);

  close(): void {}
}

export function localSource(opts: LocalOptions = {}): LocalSource {
  return new LocalSource(opts);
}

/* ------------------------------------------------------------------ server */

/** The parts of a WebSocket this source uses, so tests can pass a fake. */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface ServerOptions {
  /** The websocket address, with the owner's token: `ws://127.0.0.1:4790/ws?token=...`. */
  url: string;
  /** Where the HTTP routes are, and the token every call carries. No cookie is ever sent. */
  http?: { base: string; token: string };
  /** Called when the server refuses the token: the page forgets it. */
  onRefused?: () => void;
  fetch?: typeof fetch;
  /** Ask the server why the socket closed. The default asks `ROUTES.board` with the same credentials. */
  probe?: () => Promise<Probe>;
  socket?: (url: string) => SocketLike;
  /** Waits between reconnects, in ms. The last one repeats. */
  backoff?: readonly number[];
  pingEvery?: number;
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void };
}

export const BACKOFF = [500, 1000, 2000, 4000, 8000, 15000] as const;
const OPEN = 1;

/** The board as the server holds it. Reconnects with backoff, and resyncs from `init` each time. */
export class ServerSource implements BoardSource {
  state: BoardState = replay([]);
  presence: Presence = { state: 'away', note: 'connecting to the board', since: nowIso() };
  role: Actor = 'owner';
  connection: Connection = 'connecting';
  build: BuildInfo | undefined = undefined;
  foreign: readonly ForeignRange[] | undefined = undefined;
  shows: ReadonlyMap<string, string> = NO_SHOWS;
  readonly snapshots = true;
  /** How many reconnects have been tried since the last good `init`. */
  attempts = 0;
  private ws: SocketLike | undefined;
  private readonly listeners = new Listeners();
  private readonly pending = new Map<string, (r: PostResult) => void>();
  private refs = 0;
  private retry: unknown;
  private ping: unknown;
  private closed = false;
  private readonly opts: Required<Omit<ServerOptions, 'url' | 'http' | 'onRefused'>> & Pick<ServerOptions, 'url' | 'http' | 'onRefused'>;

  constructor(opts: ServerOptions) {
    const fetcher: typeof fetch = opts.fetch ?? ((...args) => fetch(...args));
    this.opts = {
      socket: (url) => new WebSocket(url) as unknown as SocketLike,
      backoff: BACKOFF,
      pingEvery: 25_000,
      timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
      fetch: fetcher,
      probe: () => probeBoard(fetcher, opts.http),
      ...opts,
    };
    this.connect();
  }

  /** The header that carries who this page is. Only the token does: the page sends no cookie. */
  private auth(): Record<string, string> {
    const token = this.opts.http?.token;
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  private connect(): void {
    if (this.closed) return;
    // A retry stays 'closed' until the server answers, so the page does not flicker between the two.
    this.connection = this.attempts > 0 ? 'closed' : 'connecting';
    const ws = this.opts.socket(this.opts.url);
    this.ws = ws;
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      this.receive(msg);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.lost();
    };
    ws.onerror = () => {
      // A close always follows an error.
    };
    this.listeners.emit();
  }

  private receive(msg: ServerMessage): void {
    switch (msg.t) {
      case 'init':
        this.state = replay(msg.events);
        if (!this.state.name) this.state = { ...this.state, name: msg.name };
        this.role = msg.role;
        this.presence = msg.presence;
        // A page that (re)connects learns the build from `init`: none there means none goes.
        this.build = msg.build ?? undefined;
        // And what there is to show: none there means nothing.
        this.shows = keptShows(msg.shows);
        this.connection = 'open';
        this.attempts = 0;
        this.startPing();
        // What came from outside is in `BoardInfo`, not on the socket: ask once per (re)connect.
        void this.askForeign();
        break;
      case 'event':
        this.apply(msg.event);
        break;
      case 'ok':
        this.apply(msg.event);
        this.settle(msg.ref, { ok: true, event: msg.event });
        break;
      case 'refused':
        this.settle(msg.ref, { ok: false, rule: msg.rule, reason: msg.reason });
        break;
      case 'presence':
        this.presence = msg.presence;
        break;
      case 'build':
        // The server's build driver changed what it does: `null` when no build goes any more.
        this.build = msg.build ?? undefined;
        break;
      case 'shows':
        // What there is to show changed: the whole map comes each time, empty when nothing is left.
        this.shows = keptShows(msg.shows);
        break;
      case 'pong':
        return;
      default:
        // A message this page does not know: an older page on a newer server. Nothing changed.
        return;
    }
    this.listeners.emit();
  }

  /** Apply one event in order. A repeat is skipped; a gap means we missed one, so resync. */
  private apply(ev: BoardEvent): void {
    const n = Number(ev.id.slice(1));
    if (n <= this.state.seq) return;
    if (n !== this.state.seq + 1) {
      this.ws?.close();
      return;
    }
    this.state = reduce(this.state, ev);
  }

  private settle(ref: string, r: PostResult): void {
    const done = this.pending.get(ref);
    if (!done) return;
    this.pending.delete(ref);
    done(r);
  }

  private startPing(): void {
    if (this.ping !== undefined) this.opts.timers.clear(this.ping);
    const tick = () => {
      if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify({ t: 'ping' }));
      this.ping = this.opts.timers.set(tick, this.opts.pingEvery);
    };
    this.ping = this.opts.timers.set(tick, this.opts.pingEvery);
  }

  /**
   * The socket closed. Try again with backoff, so a server that comes back at the same address
   * is found by itself, and meanwhile ask the server why: a refused session (a 401) will not
   * come back, so the retries stop and the page says how to open the board again.
   */
  private lost(): void {
    this.ws = undefined;
    if (this.connection === 'refused') return;
    this.connection = 'closed';
    this.presence = { state: 'away', note: 'the board server is not reachable', since: nowIso() };
    // What a build shows is served by that server, at an address that is new for each start:
    // a link to it now may lead nowhere. The next `init` says what there is to show.
    this.shows = NO_SHOWS;
    for (const done of this.pending.values()) done(OFFLINE);
    this.pending.clear();
    if (this.ping !== undefined) this.opts.timers.clear(this.ping);
    this.ping = undefined;
    this.listeners.emit();
    if (this.closed) return;
    const b = this.opts.backoff;
    const wait = b[Math.min(this.attempts, b.length - 1)] ?? 1000;
    this.attempts += 1;
    const retry = this.opts.timers.set(() => {
      if (this.retry === retry) this.retry = undefined;
      this.connect();
    }, wait);
    this.retry = retry;
    void this.opts.probe().then(
      (why) => {
        if (why === 'refused' && !this.closed && this.retry === retry && this.connection === 'closed') this.refuse();
      },
      () => undefined,
    );
  }

  /** The server does not know this page any more. Stop trying, and say what to do. */
  private refuse(): void {
    if (this.retry !== undefined) this.opts.timers.clear(this.retry);
    this.retry = undefined;
    this.connection = 'refused';
    this.presence = { state: 'away', note: 'the board did not accept this page', since: nowIso() };
    this.opts.onRefused?.();
    this.listeners.emit();
  }

  post = (draft: Draft): Promise<PostResult> => {
    const ws = this.ws;
    if (this.connection === 'refused') return Promise.resolve(REFUSED);
    if (!ws || this.connection !== 'open' || ws.readyState !== OPEN) return Promise.resolve(OFFLINE);
    const ref = `r${++this.refs}`;
    return new Promise<PostResult>((resolve) => {
      this.pending.set(ref, resolve);
      ws.send(JSON.stringify({ t: 'post', ref, draft }));
    });
  };

  /** Ask the board which events came from outside and are not kept yet. */
  private askForeign = async (): Promise<void> => {
    const http = this.opts.http;
    if (!http || this.closed) return;
    try {
      const res = await this.opts.fetch(`${http.base}${ROUTES.board}`, { credentials: 'omit', cache: 'no-store', headers: this.auth() });
      if (!res.ok) return;
      const info = (await res.json()) as Partial<BoardInfo>;
      const next = info.foreign && info.foreign.length > 0 ? info.foreign : undefined;
      if (JSON.stringify(next) !== JSON.stringify(this.foreign)) {
        this.foreign = next;
        this.listeners.emit();
      }
    } catch {
      // No answer: the socket says the server is gone, and the next connect asks again.
    }
  };

  /** The owner keeps what came from outside. On success the board has nothing foreign any more. */
  keep = async (): Promise<boolean> => {
    const http = this.opts.http;
    if (!http) return false;
    try {
      const res = await this.opts.fetch(`${http.base}${ROUTES.keep}`, { method: 'POST', credentials: 'omit', cache: 'no-store', headers: this.auth() });
      const json = (await res.json().catch(() => ({}))) as { kept?: boolean };
      if (!res.ok || json.kept !== true) return false;
      this.foreign = undefined;
      this.listeners.emit();
      void this.askForeign();
      return true;
    } catch {
      return false;
    }
  };

  /** A stored file, read back at `/api/assets/<name>` with the token in a header. */
  readAsset = async (asset: string): Promise<Blob | undefined> => {
    const http = this.opts.http;
    const name = /^assets\/(.+)$/.exec(asset)?.[1];
    if (!http || !name) return undefined;
    try {
      const res = await this.opts.fetch(`${http.base}${ROUTES.assets}/${encodeURIComponent(name)}`, { credentials: 'omit', cache: 'no-store', headers: this.auth() });
      return res.ok ? await res.blob() : undefined;
    } catch {
      return undefined;
    }
  };

  /** POST the bytes to the assets route, with the owner's token. */
  upload = async (name: string, body: Blob): Promise<UploadResult> => {
    const http = this.opts.http;
    if (!http) return { ok: false, reason: 'This board has no address for files.' };
    if (body.size > MAX_UPLOAD) return { ok: false, reason: `The file is larger than ${MAX_UPLOAD / 1024 / 1024} MB.` };
    try {
      const res = await this.opts.fetch(`${http.base}${ROUTES.assets}?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        credentials: 'omit',
        headers: { ...this.auth(), 'content-type': body.type || 'application/octet-stream' },
        body,
      });
      const json = (await res.json().catch(() => ({}))) as { asset?: string; error?: string };
      if (res.status === 401) return { ok: false, reason: `The board did not accept this page. ${REOPEN}` };
      if (!res.ok || !json.asset) return { ok: false, reason: json.error ?? `The board server answered ${res.status}.` };
      return { ok: true, asset: json.asset };
    } catch {
      return { ok: false, reason: 'The board server is not reachable, so the file was not saved.' };
    }
  };

  subscribe = (l: () => void) => this.listeners.add(l);

  close(): void {
    this.closed = true;
    if (this.retry !== undefined) this.opts.timers.clear(this.retry);
    if (this.ping !== undefined) this.opts.timers.clear(this.ping);
    this.ws?.close();
  }
}

export function serverSource(opts: ServerOptions): ServerSource {
  return new ServerSource(opts);
}

/** Ask the board who this page is. A 401 means the session is gone; no answer means the server is. */
export async function probeBoard(fetcher: typeof fetch, http: ServerOptions['http']): Promise<Probe> {
  if (!http) return 'down';
  try {
    const res = await fetcher(`${http.base}${ROUTES.board}`, {
      credentials: 'omit',
      cache: 'no-store',
      headers: http.token ? { authorization: `Bearer ${http.token}` } : {},
    });
    return res.status === 401 ? 'refused' : 'ok';
  } catch {
    return 'down';
  }
}

/* ------------------------------------------------------------------- token */

const TOKEN_KEY = 'keel.board.token';

type TokenWindow = Pick<Window, 'location' | 'history' | 'localStorage'>;

/**
 * The owner's token, from this page's own storage. A board's server has its own port, so its
 * own origin, so each board keeps its own token, and a bookmark of the bare address works in
 * the same browser while that server runs. The token is the server's for one run: when the
 * server stops, it opens nothing, whoever holds it. No cookie is ever used: a cookie for
 * 127.0.0.1 would go to every local port.
 *
 * The address the command prints holds a one-time code, not a token (`takeCode`). A token in
 * `?token=` is still taken, for a test or a tool that has one, and is removed from the
 * address bar the same way.
 */
export function takeToken(win: TokenWindow = window): string | undefined {
  const url = new URL(win.location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    url.searchParams.delete('token');
    win.history.replaceState(win.history.state, '', url.pathname + url.search + url.hash);
    try {
      win.localStorage.setItem(TOKEN_KEY, fromUrl);
    } catch {
      // Storage can be blocked. The token still works for this page.
    }
    return fromUrl;
  }
  try {
    return win.localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The code in the address `keel-board open` prints. It is taken out of the address bar at
 * once. It works one time, so what the browser's history keeps is a spent code, never a token.
 */
export function takeCode(win: Pick<Window, 'location' | 'history'> = window): string | undefined {
  const url = new URL(win.location.href);
  const code = url.searchParams.get('code');
  if (!code) return undefined;
  url.searchParams.delete('code');
  win.history.replaceState(win.history.state, '', url.pathname + url.search + url.hash);
  return code;
}

/**
 * Trade the one-time code for the owner's token, and keep the token for this page. The
 * token lasts as long as the server that gave it: after a restart the page needs a new
 * address. `spent`: the server knows no such code. `down`: no server answered.
 */
export async function tradeCode(
  code: string,
  opts: { base: string; route: string; fetch?: typeof fetch; win?: Pick<Window, 'localStorage'> },
): Promise<{ ok: true; token: string } | { ok: false; why: 'spent' | 'down' }> {
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(opts.base + opts.route, {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
  } catch {
    return { ok: false, why: 'down' };
  }
  if (!res.ok) return { ok: false, why: res.status === 401 ? 'spent' : 'down' };
  let token: unknown;
  try {
    token = ((await res.json()) as { token?: unknown }).token;
  } catch {
    return { ok: false, why: 'down' };
  }
  if (typeof token !== 'string' || token === '') return { ok: false, why: 'down' };
  try {
    (opts.win ?? window).localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Storage can be blocked. The token still works for this page.
  }
  return { ok: true, token };
}

/** Forget the token: the server refused it, so it opens nothing any more. */
export function forgetToken(win: Pick<Window, 'localStorage'> = window): void {
  try {
    win.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing kept, nothing to forget.
  }
}

/** The websocket address on the server that served this page, with the token: a socket cannot carry a header. */
export function socketUrl(loc: Pick<Location, 'protocol' | 'host'>, token: string, path = '/ws'): string {
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${loc.host}${path}?token=${encodeURIComponent(token)}`;
}
