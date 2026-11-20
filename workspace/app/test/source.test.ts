import type { BoardEvent, ServerMessage } from '@keel/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { Probe, SocketLike } from '../src/source';
import { BACKOFF, forgetToken, localSource, probeBoard, REOPEN, safeShowUrl, serverSource, socketUrl, takeCode, takeToken, tradeCode } from '../src/source';
import { openBoard } from './helpers';

describe('the local source', () => {
  it('admits a legal draft as the owner, numbers it, and tells its listeners', async () => {
    const b = openBoard();
    const seen: BoardEvent[] = [];
    const src = localSource({ events: b.events, onAdmit: (e) => seen.push(e) });
    const heard = vi.fn();
    src.subscribe(heard);
    const r = await src.post({ type: 'item.add', chapter: 'engine-loop', item: { id: 'm1', kind: 'note', box: [0, 0, 320, 60], text: 'hello' } });
    expect(r.ok).toBe(true);
    expect(r.ok && r.event).toMatchObject({ id: 'e3', by: 'owner', type: 'item.add' });
    expect(seen.map((e) => e.id)).toEqual(['e3']);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(src.state.items.m1?.item.kind).toBe('note');
  });

  it('refuses what the rules refuse, with the rule and its reason, and changes nothing', async () => {
    const src = localSource({ events: openBoard().events });
    const before = src.state;
    const r = await src.post({ type: 'item.add', chapter: 'nope', item: { id: 'm1', kind: 'note', box: [0, 0, 1, 1], text: 'x' } });
    expect(r).toEqual({ ok: false, rule: 'R7', reason: 'There is no chapter "nope".' });
    expect(src.state).toBe(before);
  });

  it('has nothing to show until a test says so, keeps only safe addresses, and tells its listeners', () => {
    const src = localSource({ events: openBoard().events });
    expect(src.shows.size).toBe(0);
    const heard = vi.fn();
    src.subscribe(heard);
    src.setShows({ 'engine-loop': 'http://127.0.0.1:4791/', other: 'javascript:alert(1)' });
    expect([...src.shows]).toEqual([['engine-loop', 'http://127.0.0.1:4791/']]);
    expect(heard).toHaveBeenCalledTimes(1);
    src.setShows(undefined);
    expect(src.shows.size).toBe(0);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('never dates an event before the last one in the log', async () => {
    const b = openBoard();
    const future = b.events.map((e) => ({ ...e, at: '2099-01-01T00:00:00.000Z' }));
    const src = localSource({ events: future });
    const r = await src.post({ type: 'chapter.open', chapter: 'next', title: 'Next' });
    expect(r.ok && r.event.at > '2099-01-01T00:00:00.000Z').toBe(true);
  });
});

/** A fake websocket the test drives by hand. */
class FakeSocket implements SocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(msg: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

function harness(probe: () => Promise<Probe> = async () => 'down') {
  FakeSocket.all = [];
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const src = serverSource({
    url: 'ws://127.0.0.1:4790/ws?token=t',
    socket: (url) => new FakeSocket(url),
    probe,
    timers: {
      set: (fn, ms) => {
        const t = { fn, ms, live: true };
        timers.push(t);
        return t;
      },
      clear: (h) => {
        (h as { live: boolean }).live = false;
      },
    },
  });
  const sock = () => FakeSocket.all[FakeSocket.all.length - 1]!;
  const presence = { state: 'listening' as const, since: '2026-11-17T13:00:00Z' };
  const init = (events = openBoard().events) => {
    sock().open();
    sock().receive({ t: 'init', name: 'uLLM', role: 'owner', events, presence });
  };
  return { src, sock, init, timers, presence };
}

describe('the server source', () => {
  it('connects, and takes the board, the role and presence from init', () => {
    const h = harness();
    expect(h.src.connection).toBe('connecting');
    expect(h.src.presence.state).toBe('away');
    h.init();
    expect(h.src.connection).toBe('open');
    expect(h.src.state.name).toBe('uLLM');
    expect(h.src.state.seq).toBe(2);
    expect(h.src.role).toBe('owner');
    expect(h.src.presence.state).toBe('listening');
  });

  it('posts a draft with a ref, and resolves it with the event or the refusal', async () => {
    const h = harness();
    h.init();
    const draft = { type: 'chapter.open' as const, chapter: 'next', title: 'Next' };
    const p = h.src.post(draft);
    const sent = h.sock().sent[0] as { t: string; ref: string; draft: unknown };
    expect(sent).toEqual({ t: 'post', ref: 'r1', draft });
    const event = { ...draft, by: 'owner' as const, id: 'e3', at: '2026-11-17T13:01:00Z' };
    h.sock().receive({ t: 'ok', ref: 'r1', event });
    expect(await p).toEqual({ ok: true, event });
    expect(h.src.state.chapters.next?.title).toBe('Next');

    const q = h.src.post({ type: 'chapter.open', chapter: 'next', title: 'Again' });
    h.sock().receive({ t: 'refused', ref: 'r2', rule: 'R4', reason: 'Chapter "next" already exists. Use a new id.' });
    expect(await q).toEqual({ ok: false, rule: 'R4', reason: 'Chapter "next" already exists. Use a new id.' });
  });

  it('applies broadcast events in order, skips a repeat, and resyncs on a gap', () => {
    const h = harness();
    h.init();
    const ev = (n: number): BoardEvent => ({ type: 'chapter.open', chapter: `c${n}`, title: `C${n}`, by: 'owner', id: `e${n}`, at: '2026-11-17T13:01:00Z' });
    h.sock().receive({ t: 'event', event: ev(3) });
    h.sock().receive({ t: 'event', event: ev(3) });
    expect(h.src.state.seq).toBe(3);
    const first = h.sock();
    h.sock().receive({ t: 'event', event: ev(5) });
    expect(h.src.state.seq).toBe(3);
    expect(first.readyState).toBe(3);
    expect(h.src.connection).toBe('closed');
  });

  it('reconnects with backoff, and fails pending posts at once while away', async () => {
    const h = harness();
    h.init();
    const p = h.src.post({ type: 'chapter.open', chapter: 'next', title: 'Next' });
    h.sock().close();
    expect((await p).ok).toBe(false);
    expect(h.src.presence.state).toBe('away');
    const r = await h.src.post({ type: 'chapter.open', chapter: 'next', title: 'Next' });
    expect(r).toMatchObject({ ok: false, rule: 'offline' });

    const waits: number[] = [];
    for (let i = 0; i < BACKOFF.length + 1; i++) {
      const t = h.timers.filter((x) => x.live && x.ms !== 25_000).pop()!;
      waits.push(t.ms);
      t.live = false;
      t.fn();
      h.sock().close();
    }
    expect(waits).toEqual([...BACKOFF, BACKOFF[BACKOFF.length - 1]]);

    // A good init resets the backoff.
    const t = h.timers.filter((x) => x.live && x.ms !== 25_000).pop()!;
    t.fn();
    h.init();
    expect(h.src.attempts).toBe(0);
    expect(h.src.connection).toBe('open');
  });

  it('a refused session (401) stops the retries and says how to open the board again', async () => {
    const h = harness(async () => 'refused');
    h.init();
    h.sock().close();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.src.connection).toBe('refused');
    expect(h.src.presence).toMatchObject({ state: 'away', note: 'the board did not accept this page' });
    expect(h.timers.filter((x) => x.live && x.ms !== 25_000)).toHaveLength(0);
    const r = await h.src.post({ type: 'chapter.open', chapter: 'next', title: 'Next' });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.reason).toContain(REOPEN);
    expect(REOPEN).toBe('Open the board again from your terminal: keel-board open. When it already runs, keel-board link prints a new address.');
  });

  it('a server that is gone, then back at the same address, is found again by itself', async () => {
    const h = harness(async () => 'down');
    h.init();
    h.sock().close();
    await Promise.resolve();
    expect(h.src.connection).toBe('closed');
    const t = h.timers.filter((x) => x.live && x.ms !== 25_000).pop()!;
    t.fn();
    h.init();
    expect(h.src.connection).toBe('open');
  });

  it('carries the token on every call and never sends a cookie; a file is read back with the token', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/api/assets/')) return new Response('a,b\n1,2\n', { status: 200 });
      return new Response(JSON.stringify({ asset: 'assets/a.png' }), { status: 200 });
    }) as unknown as typeof fetch;
    const src = serverSource({ url: 'ws://x/ws?token=t1', http: { base: 'http://x', token: 't1' }, fetch: fetcher, socket: (u) => new FakeSocket(u), probe: async () => 'down' });
    expect(FakeSocket.all[FakeSocket.all.length - 1]!.url).toBe('ws://x/ws?token=t1');
    const r = await src.upload('a.png', new Blob(['x']));
    expect(r).toEqual({ ok: true, asset: 'assets/a.png' });
    const blob = await src.readAsset('assets/queue depth.csv');
    expect(await blob!.text()).toBe('a,b\n1,2\n');
    expect(calls.map((c) => c.url)).toEqual(['http://x/api/assets?name=a.png', 'http://x/api/assets/queue%20depth.csv']);
    for (const c of calls) {
      expect(c.init.credentials).toBe('omit');
      expect((c.init.headers as Record<string, string>).authorization).toBe('Bearer t1');
    }
    expect(await src.readAsset('elsewhere/x')).toBeUndefined();
    src.close();
  });

  it('forgets the token when the server refuses it', async () => {
    const refused = vi.fn();
    const timers: Array<() => void> = [];
    const src = serverSource({
      url: 'ws://x/ws?token=old',
      http: { base: 'http://x', token: 'old' },
      socket: (u) => new FakeSocket(u),
      probe: async () => 'refused',
      onRefused: refused,
      timers: { set: (fn) => (timers.push(fn), timers.length), clear: () => undefined },
    });
    FakeSocket.all[FakeSocket.all.length - 1]!.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(src.connection).toBe('refused');
    expect(refused).toHaveBeenCalledTimes(1);
    src.close();
  });

  it('asks the board why a socket closed: 401 is a refused session, no answer is a server that is gone', async () => {
    const answer = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof fetch;
    expect(await probeBoard(answer(401), { base: 'http://x', token: 't' })).toBe('refused');
    expect(await probeBoard(answer(200), { base: 'http://x', token: 't' })).toBe('ok');
    expect(await probeBoard((async () => Promise.reject(new Error('refused'))) as unknown as typeof fetch, { base: 'http://x', token: 't' })).toBe('down');
    expect(await probeBoard(answer(401), undefined)).toBe('down');
  });

  it('takes the build from init, follows each build message, and clears it on null', () => {
    const h = harness();
    const heard = vi.fn();
    h.src.subscribe(heard);
    const queued = { chapter: 'engine-loop', title: 'The engine loop', state: 'queued' as const, built: 0, total: 3 };
    h.sock().open();
    h.sock().receive({ t: 'init', name: 'uLLM', role: 'owner', events: openBoard().events, presence: h.presence, build: queued });
    expect(h.src.build).toEqual(queued);
    heard.mockClear();
    const running = { ...queued, state: 'running' as const, part: 'Scheduler' };
    h.sock().receive({ t: 'build', build: running });
    expect(h.src.build).toEqual(running);
    expect(heard).toHaveBeenCalledTimes(1);
    h.sock().receive({ t: 'build', build: null });
    expect(h.src.build).toBeUndefined();
    expect(heard).toHaveBeenCalledTimes(2);
    // Nothing is due later: no look at the board's info is waiting.
    expect(h.timers.filter((x) => x.live && x.ms !== 25_000)).toHaveLength(0);
  });

  it('takes what there is to show from init, follows each shows message, and an empty map clears it', () => {
    const h = harness();
    const heard = vi.fn();
    h.src.subscribe(heard);
    h.sock().open();
    h.sock().receive({ t: 'init', name: 'uLLM', role: 'owner', events: openBoard().events, presence: h.presence, shows: { 'engine-loop': 'http://127.0.0.1:4791/?key=k1' } });
    expect(h.src.shows.get('engine-loop')).toBe('http://127.0.0.1:4791/?key=k1');
    heard.mockClear();
    h.sock().receive({ t: 'shows', shows: { 'engine-loop': 'http://127.0.0.1:4791/?key=k1', next: 'http://localhost:4792/' } });
    expect([...h.src.shows]).toEqual([
      ['engine-loop', 'http://127.0.0.1:4791/?key=k1'],
      ['next', 'http://localhost:4792/'],
    ]);
    expect(heard).toHaveBeenCalledTimes(1);
    h.sock().receive({ t: 'shows', shows: {} });
    expect(h.src.shows.size).toBe(0);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('drops an address it may not link to, and keeps the rest of the map', () => {
    const h = harness();
    h.init();
    h.sock().receive({
      t: 'shows',
      shows: { a: 'javascript:alert(1)', b: 'https://example.com/', c: 'file:///etc/passwd', d: 'not a url', e: 'http://127.0.0.1:4791/' },
    });
    expect([...h.src.shows]).toEqual([['e', 'http://127.0.0.1:4791/']]);
  });

  it('an init with no shows means nothing to show, and a chapter named like an object key finds nothing', () => {
    const h = harness();
    h.init();
    h.sock().receive({ t: 'shows', shows: { 'engine-loop': 'http://127.0.0.1:4791/' } });
    expect(h.src.shows.size).toBe(1);
    h.sock().close();
    h.timers.filter((x) => x.live && x.ms !== 25_000).pop()!.fn();
    h.init();
    expect(h.src.shows.size).toBe(0);
    expect(h.src.shows.get('constructor')).toBeUndefined();
  });

  it('a lost connection takes the addresses away at once: the server that served them may be gone', () => {
    const h = harness();
    h.init();
    h.sock().receive({ t: 'shows', shows: { 'engine-loop': 'http://127.0.0.1:4791/k1/engine-loop/index.html' } });
    expect(h.src.shows.size).toBe(1);
    const heard = vi.fn();
    h.src.subscribe(heard);
    h.sock().close();
    expect(h.src.shows.size).toBe(0);
    expect(heard).toHaveBeenCalled();
    // The server is back, on a new port and with a new key: the page links to that one.
    h.timers.filter((x) => x.live && x.ms !== 25_000).pop()!.fn();
    h.sock().open();
    h.sock().receive({ t: 'init', name: 'uLLM', role: 'owner', events: openBoard().events, presence: h.presence, shows: { 'engine-loop': 'http://127.0.0.1:4802/k2/engine-loop/index.html' } });
    expect(h.src.shows.get('engine-loop')).toBe('http://127.0.0.1:4802/k2/engine-loop/index.html');
  });

  it('a page that reconnects gets the build again in init, and an init with none means none goes', () => {
    const h = harness();
    const stopped = { chapter: 'engine-loop', title: 'The engine loop', state: 'stopped' as const, built: 1, total: 3 };
    h.init();
    expect(h.src.build).toBeUndefined();
    h.sock().receive({ t: 'build', build: { ...stopped, state: 'running' } });
    h.sock().close();
    // Back: the server says the build stopped while the page was away.
    h.timers.filter((x) => x.live && x.ms !== 25_000).pop()!.fn();
    h.sock().open();
    h.sock().receive({ t: 'init', name: 'uLLM', role: 'owner', events: openBoard().events, presence: h.presence, build: stopped });
    expect(h.src.build).toEqual(stopped);
    // Away again, and back to a server with no build going.
    h.sock().close();
    h.timers.filter((x) => x.live && x.ms !== 25_000).pop()!.fn();
    h.init();
    expect(h.src.build).toBeUndefined();
  });

  it('asks the board’s info once per connect, for what came from outside, never for the build; a closed socket asks who the page is', async () => {
    FakeSocket.all = [];
    const calls: string[] = [];
    const fetcher = (async (url: string) => {
      calls.push(url);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const due: Array<() => void> = [];
    const src = serverSource({
      url: 'ws://x/ws?token=t',
      http: { base: 'http://x', token: 't' },
      fetch: fetcher,
      socket: (u) => new FakeSocket(u),
      timers: { set: (fn) => (due.push(fn), due.length), clear: () => undefined },
    });
    const sock = FakeSocket.all[0]!;
    sock.open();
    const events = openBoard().events;
    sock.receive({ t: 'init', name: 'uLLM', role: 'owner', events, presence: { state: 'listening', since: '2026-11-17T13:00:00Z' } });
    sock.receive({ t: 'event', event: { type: 'chapter.open', chapter: 'c3', title: 'C3', by: 'owner', id: 'e3', at: '2026-11-17T13:01:00Z' } });
    await new Promise((r) => setTimeout(r, 0));
    // Once, on init: `foreign` is in the board's info, not on the socket. Events never ask.
    expect(calls).toEqual(['http://x/api/board']);
    // The socket closes: the page asks the board who it is, once, to tell a refused session from a server that is gone.
    sock.close();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(['http://x/api/board', 'http://x/api/board']);
    src.close();
  });

  it('stops for good when closed', () => {
    const h = harness();
    h.init();
    h.src.close();
    expect(h.timers.filter((x) => x.live && x.ms !== 25_000)).toHaveLength(0);
  });
});

describe('the token', () => {
  const fakeWindow = (href: string) => {
    const store = new Map<string, string>();
    const win = {
      location: { href } as Location,
      history: {
        state: null,
        replaceState: (_s: unknown, _t: string, url: string) => {
          win.location = { href: new URL(url, href).href } as Location;
        },
      } as unknown as History,
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } as Storage,
    };
    return win;
  };

  it('is taken from ?token= and then removed from the address bar', () => {
    const win = fakeWindow('http://127.0.0.1:4790/?token=abc123&x=1#here');
    expect(takeToken(win)).toBe('abc123');
    expect(win.location.href).toBe('http://127.0.0.1:4790/?x=1#here');
    // A reload, or a bookmark of the bare address in the same browser, still has it.
    expect(takeToken(win)).toBe('abc123');
    // Once the server refused it, it is gone: the page says how to open the board.
    forgetToken(win);
    expect(takeToken(win)).toBeUndefined();
  });

  it('the one-time code is taken out of the address at once, and traded for the token with no credentials', async () => {
    const win = fakeWindow('http://127.0.0.1:4790/?code=c0de&x=1#here');
    expect(takeCode(win)).toBe('c0de');
    expect(win.location.href).toBe('http://127.0.0.1:4790/?x=1#here');
    expect(takeCode(win)).toBeUndefined();

    const calls: Array<{ url: string; init: RequestInit }> = [];
    const answer = (status: number, body: unknown) =>
      (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(body), { status });
      }) as unknown as typeof fetch;
    const got = await tradeCode('c0de', { base: 'http://127.0.0.1:4790', route: '/api/session', fetch: answer(200, { token: 'tok-run', role: 'owner' }), win });
    expect(got).toEqual({ ok: true, token: 'tok-run' });
    expect(calls[0]!.url).toBe('http://127.0.0.1:4790/api/session');
    expect(calls[0]!.init).toMatchObject({ method: 'POST', credentials: 'omit', body: JSON.stringify({ code: 'c0de' }) });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
    // Kept for a reload, in this origin's own storage.
    expect(takeToken(win)).toBe('tok-run');

    // A spent code, a server that is not there, and an answer with no token.
    const empty = fakeWindow('http://127.0.0.1:4790/');
    expect(await tradeCode('old', { base: 'http://x', route: '/api/session', fetch: answer(401, { error: 'used' }), win: empty })).toEqual({ ok: false, why: 'spent' });
    expect(await tradeCode('c', { base: 'http://x', route: '/api/session', fetch: (async () => Promise.reject(new Error('refused'))) as unknown as typeof fetch, win: empty })).toEqual({ ok: false, why: 'down' });
    expect(await tradeCode('c', { base: 'http://x', route: '/api/session', fetch: answer(200, {}), win: empty })).toEqual({ ok: false, why: 'down' });
    expect(takeToken(empty)).toBeUndefined();
  });

  it('goes on the websocket address of the page’s own server', () => {
    expect(socketUrl({ protocol: 'http:', host: '127.0.0.1:4790' }, 'a b')).toBe('ws://127.0.0.1:4790/ws?token=a%20b');
    expect(socketUrl({ protocol: 'https:', host: 'x.test' }, 't')).toBe('wss://x.test/ws?token=t');
  });
});

describe('what came with the log from outside', () => {
  it('is read from the board’s info on init, and Keep posts to the board and drops it', async () => {
    FakeSocket.all = [];
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let foreign: unknown = [{ from: 3, to: 9 }];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/api/keep')) {
        foreign = undefined;
        return new Response(JSON.stringify({ kept: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ name: 'uLLM', seq: 9, role: 'owner', open: 0, ...(foreign ? { foreign } : {}) }), { status: 200 });
    }) as unknown as typeof fetch;
    const src = serverSource({ url: 'ws://x/ws?token=t', http: { base: 'http://x', token: 't' }, fetch: fetcher, socket: (u) => new FakeSocket(u), probe: async () => 'ok' });
    const sock = FakeSocket.all[0]!;
    sock.open();
    sock.receive({ t: 'init', name: 'uLLM', role: 'owner', events: openBoard().events, presence: { state: 'listening', since: '2026-11-17T13:00:00Z' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(src.foreign).toEqual([{ from: 3, to: 9 }]);
    expect(await src.keep()).toBe(true);
    expect(src.foreign).toBeUndefined();
    const keep = calls.find((c) => c.url === 'http://x/api/keep')!;
    expect(keep.init.method).toBe('POST');
    expect((keep.init.headers as Record<string, string>).authorization).toBe('Bearer t');
    expect(keep.init.credentials).toBe('omit');
    src.close();
  });

  it('a keep the board did not take changes nothing', async () => {
    FakeSocket.all = [];
    const fetcher = (async (url: string) =>
      url.endsWith('/api/keep') ? new Response('{"error":"no"}', { status: 403 }) : new Response(JSON.stringify({ foreign: [{ from: 1, to: 2 }] }), { status: 200 })) as unknown as typeof fetch;
    const src = serverSource({ url: 'ws://x/ws?token=t', http: { base: 'http://x', token: 't' }, fetch: fetcher, socket: (u) => new FakeSocket(u), probe: async () => 'ok' });
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.receive({ t: 'init', name: 'uLLM', role: 'owner', events: openBoard().events, presence: { state: 'listening', since: '2026-11-17T13:00:00Z' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(await src.keep()).toBe(false);
    expect(src.foreign).toEqual([{ from: 1, to: 2 }]);
    src.close();
  });
});

describe('the address of a page to show', () => {
  it('keeps plain http on this machine', () => {
    expect(safeShowUrl('http://127.0.0.1:4791/?key=k1')).toBe('http://127.0.0.1:4791/?key=k1');
    expect(safeShowUrl('http://localhost:4791/index.html')).toBe('http://localhost:4791/index.html');
    // Written as the browser reads it, so the link is exactly what was checked.
    expect(safeShowUrl('http://LOCALHOST:4791')).toBe('http://localhost:4791/');
  });

  it('drops every other kind', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'https://example.com/',
      'http://example.com/',
      'https://127.0.0.1:4791/',
      'file:///etc/passwd',
      'ws://127.0.0.1:4791/',
      'http://127.0.0.2:4791/',
      'http://localhost.example.com/',
      'http://[::1]:4791/',
      '//127.0.0.1:4791/',
      '/relative',
      'not a url',
      '',
      undefined,
      42,
      { href: 'http://127.0.0.1/' },
    ]) {
      expect(safeShowUrl(bad)).toBeUndefined();
    }
  });
});
