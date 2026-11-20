import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTE_MAX, PIN_MAX } from '../src/fieldText';
import { DRAFT_PAUSE_MS } from '../src/input/constants';
import type { LabelDraft, Locks, NoteDraft } from '../src/noteDraft';
import { draftKeeper, draftKey, draftKeys, flushOnLeave, holdLock, newPageName, oldDraftKey, orphansHeld, orphansNow, readLabelDraft, readNoteDraft } from '../src/noteDraft';

/** The words the owner is typing, kept in the browser: what is read back, and when it is written. */

/** A storage that counts what is done to it. */
function fakeStore(init: Record<string, string> = {}) {
  const map = new Map(Object.entries(init));
  const did = { sets: 0, removes: 0 };
  return {
    did,
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      did.sets += 1;
      map.set(k, v);
    },
    removeItem: (k: string) => {
      did.removes += 1;
      map.delete(k);
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

const KEY = 'k';
const holding = (v: unknown) => fakeStore({ [KEY]: typeof v === 'string' ? v : JSON.stringify(v) });

describe('where a draft is kept', () => {
  it('is a key per page, per board and per kind: a note and a label never share one, nor two pages', () => {
    expect(draftKey('note', 'uLLM', 'p1')).toBe('keel.draft.note.uLLM@p1');
    expect(draftKey('label', 'uLLM', 'p1')).toBe('keel.draft.label.uLLM@p1');
    expect(draftKey('note', 'uLLM', 'p2')).not.toBe(draftKey('note', 'uLLM', 'p1'));
    expect(draftKey('note', '', 'p1')).toBe('keel.draft.note.board@p1');
    expect(newPageName()).toMatch(/^[0-9a-f]{12}$/);
    expect(newPageName()).not.toBe(newPageName());
  });

  it('lists a board’s drafts of one kind, by every page, and the one kept the old way; no other board’s, even one whose name starts the same', () => {
    const s = fakeStore({
      [draftKey('note', 'uLLM', 'p1')]: 'a',
      [draftKey('note', 'uLLM', 'p2')]: 'b',
      [oldDraftKey('note', 'uLLM')]: 'c',
      [draftKey('label', 'uLLM', 'p1')]: 'd',
      [draftKey('note', 'uLLM@p3', 'p4')]: 'e',
      [draftKey('note', 'uLLM.v2', 'p5')]: 'f',
      'keel.view.uLLM': 'g',
    });
    expect(draftKeys('note', 'uLLM', s).sort()).toEqual([draftKey('note', 'uLLM', 'p1'), draftKey('note', 'uLLM', 'p2'), oldDraftKey('note', 'uLLM')].sort());
    expect(draftKeys('label', 'uLLM', s)).toEqual([draftKey('label', 'uLLM', 'p1')]);
    expect(draftKeys('note', 'uLLM', undefined)).toEqual([]);
  });
});

/** The browser's locks for a few pages: a lock is held until its holder lets go. */
function fakeLocks() {
  const held = new Set<string>();
  const locks = {
    request: (name: string, _options: LockOptions, granted: LockGrantedCallback<unknown>): Promise<unknown> => {
      if (held.has(name)) return Promise.resolve(granted(null));
      held.add(name);
      return Promise.resolve(granted({ name, mode: 'exclusive' })).finally(() => held.delete(name));
    },
    query: async (): Promise<LockManagerSnapshot> => ({ held: [...held].map((name) => ({ name, mode: 'exclusive' as const })), pending: [] }),
  };
  return { held, locks: locks as unknown as Locks };
}

describe('whose draft is it', () => {
  const own = draftKey('note', 'uLLM', 'mine');
  const live = draftKey('note', 'uLLM', 'live');
  const gone = draftKey('note', 'uLLM', 'gone');
  const old = oldDraftKey('note', 'uLLM');

  it('a lock is held by one page at a time, until it lets go', async () => {
    const { held, locks } = fakeLocks();
    const release = await holdLock(locks, 'a');
    expect(release).toBeDefined();
    expect(await holdLock(locks, 'a')).toBeUndefined();
    release?.();
    await Promise.resolve();
    expect(held.has('a')).toBe(false);
    expect(await holdLock(locks, 'a')).toBeDefined();
  });

  it('a draft no live page holds is taken over, and held, so no other page takes it too; this page’s own and a live page’s are not', async () => {
    const { held, locks } = fakeLocks();
    const s = fakeStore({ [own]: '1', [live]: '2', [gone]: '3', [old]: '4' });
    await holdLock(locks, live);
    await holdLock(locks, own);
    const found = await orphansHeld('note', 'uLLM', own, locks, s);
    expect(found.map((o) => o.key).sort()).toEqual([gone, old].sort());
    expect(held.has(gone)).toBe(true);
    expect(await orphansHeld('note', 'uLLM', 'another', locks, s)).toEqual([]);
    // Let go, twice: the second time is nothing.
    for (const o of found) o.release();
    for (const o of found) o.release();
    await Promise.resolve();
    expect(held.has(gone)).toBe(false);
  });

  it('a draft another page takes between the list of live pages and this page’s ask is not taken here too', async () => {
    const { held, locks } = fakeLocks();
    const s = fakeStore({ [gone]: '3' });
    // The list says nobody holds it; by the time this page asks, another page that opened just now does.
    const stale = await locks.query();
    await holdLock(locks, gone);
    const racing: Locks = { ...locks, query: async () => stale };
    expect(await orphansHeld('note', 'uLLM', own, racing, s)).toEqual([]);
    expect(held.has(gone)).toBe(true);
  });

  it('a browser that cannot say which pages live takes every draft but this page’s own', () => {
    const s = fakeStore({ [own]: '1', [live]: '2', [old]: '4' });
    expect(orphansNow('note', 'uLLM', own, s).map((o) => o.key).sort()).toEqual([live, old].sort());
  });

  it('locks that fail are no drafts to take, and nothing held', async () => {
    const broken = {
      request: () => Promise.reject(new Error('blocked')),
      query: () => Promise.reject(new Error('blocked')),
    } as unknown as Locks;
    expect(await holdLock(broken, 'a')).toBeUndefined();
    expect(await orphansHeld('note', 'uLLM', own, broken, fakeStore({ [gone]: '3' }))).toEqual([]);
  });
});

describe('a note read back', () => {
  it('a new note comes back with its words, its place and what it was on', () => {
    const draft: NoteDraft = { text: 'half a thought', at: [120, -40], on: { item: 'a1', sub: 'q:2' }, anchor: { item: 'a1', sub: 'q:2', box: [10, 20, 300, 40] } };
    expect(readNoteDraft(KEY, holding(draft))).toEqual(draft);
  });

  it('a new note that was posted once comes back with the id it went with', () => {
    const draft: NoteDraft = { text: 'on its way', at: [0, 0], id: 'm7' };
    expect(readNoteDraft(KEY, holding(draft))).toEqual(draft);
  });

  it('a change to a note comes back with the note it is of', () => {
    const draft: NoteDraft = { text: 'the note, changed', at: [0, 0], edit: 'm4' };
    expect(readNoteDraft(KEY, holding(draft))).toEqual(draft);
  });

  it('nothing kept, or nothing sound, is no draft', () => {
    expect(readNoteDraft(KEY, fakeStore())).toBeUndefined();
    expect(readNoteDraft(KEY, undefined)).toBeUndefined();
    for (const junk of ['{not json', '"words"', '[1,2]', 'null', '42']) expect(readNoteDraft(KEY, holding(junk)), junk).toBeUndefined();
    for (const bad of [
      { at: [0, 0] },
      { text: '', at: [0, 0] },
      { text: '   \n ', at: [0, 0] },
      { text: 7, at: [0, 0] },
      { text: 'words' },
      { text: 'words', at: [0] },
      { text: 'words', at: ['0', 0] },
      { text: 'words', at: [0, 1e9] },
      { text: 'words', at: [0, null] },
    ]) {
      expect(readNoteDraft(KEY, holding(bad)), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('a field that is not sound is left out, and the words still come back', () => {
    const got = readNoteDraft(KEY, holding({ text: 'words', at: [1, 2], on: { item: 'Not An Id' }, anchor: { item: 'a1', box: [0, 0] }, edit: '__proto__', extra: true }));
    expect(got).toEqual({ text: 'words', at: [1, 2] });
  });

  it('is cut to what a note holds', () => {
    const got = readNoteDraft(KEY, holding({ text: 'x'.repeat(NOTE_MAX + 50), at: [0, 0] }));
    expect(got?.text).toHaveLength(NOTE_MAX);
  });

  it('a storage that throws is no draft', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(readNoteDraft(KEY, broken)).toBeUndefined();
  });
});

describe('a label read back', () => {
  const pin = { id: 'm9', kind: 'pin' as const, box: [40, 50, 0, 0] as [number, number, number, number], at: [0, 0] as [number, number], on: { item: 'a1', sub: 'q:3' } };
  const sound: LabelDraft[] = [
    { label: { kind: 'box', box: [10, 20, 200, 100], at: [18, 52] }, text: 'where it starts' },
    { label: { kind: 'arrow', from: [0, 0], to: [300, 120], at: [90, 16] }, text: 'why?' },
    { label: { kind: 'pin', pin, at: [54, 16] }, text: 'this one' },
  ];

  it('a box, an arrow and a pin each come back with their words and the mark as drawn', () => {
    for (const draft of sound) expect(readLabelDraft(KEY, holding(draft)), draft.label.kind).toEqual(draft);
  });

  it('a mark that was posted once comes back with the id it went with; an id that is not sound is left out', () => {
    expect(readLabelDraft(KEY, holding({ ...sound[0], mark: 'm7' }))).toEqual({ ...sound[0], mark: 'm7' });
    expect(readLabelDraft(KEY, holding({ ...sound[0], mark: 'Not An Id' }))).toEqual(sound[0]);
  });

  it('a mark with no words, or one that is not sound, is no draft', () => {
    for (const draft of sound) expect(readLabelDraft(KEY, holding({ ...draft, text: '  ' })), draft.label.kind).toBeUndefined();
    for (const bad of [
      { text: 'words' },
      { text: 'words', label: 'box' },
      { text: 'words', label: { kind: 'box', box: [0, 0, 10], at: [0, 0] } },
      { text: 'words', label: { kind: 'box', box: [0, 0, 10, 10] } },
      { text: 'words', label: { kind: 'arrow', from: [0, 0], at: [0, 0] } },
      { text: 'words', label: { kind: 'pin', pin: { ...pin, kind: 'note' }, at: [0, 0] } },
      { text: 'words', label: { kind: 'pin', pin: { ...pin, sneaked: 'in' }, at: [0, 0] } },
      { text: 'words', label: { kind: 'lasso', at: [0, 0] } },
    ]) {
      expect(readLabelDraft(KEY, holding(bad)), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it('is cut to the most any mark holds', () => {
    const got = readLabelDraft(KEY, holding({ ...sound[2], text: 'x'.repeat(PIN_MAX + 9) }));
    expect(got?.text).toHaveLength(PIN_MAX);
  });
});

describe('when a draft is written', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const draft = (text: string): NoteDraft => ({ text, at: [0, 0] });

  it('not on the key: a pause after it, one millisecond either side', () => {
    const s = fakeStore();
    const k = draftKeeper<NoteDraft>(() => KEY, DRAFT_PAUSE_MS, s);
    k.keep(draft('h'));
    expect(s.did.sets).toBe(0);
    vi.advanceTimersByTime(DRAFT_PAUSE_MS - 1);
    expect(s.did.sets).toBe(0);
    vi.advanceTimersByTime(1);
    expect(s.did.sets).toBe(1);
    expect(readNoteDraft(KEY, s)).toEqual(draft('h'));
  });

  it('many keys in one pause are one write, of the last words', () => {
    const s = fakeStore();
    const k = draftKeeper<NoteDraft>(() => KEY, DRAFT_PAUSE_MS, s);
    for (const text of ['h', 'ha', 'hal', 'half']) {
      k.keep(draft(text));
      vi.advanceTimersByTime(50);
    }
    vi.advanceTimersByTime(DRAFT_PAUSE_MS);
    expect(s.did.sets).toBe(1);
    expect(readNoteDraft(KEY, s)?.text).toBe('half');
  });

  it('typing without a stop is still written, once a pause: it never waits for the owner to stop', () => {
    const s = fakeStore();
    const k = draftKeeper<NoteDraft>(() => KEY, DRAFT_PAUSE_MS, s);
    for (let i = 1; i <= 30; i++) {
      k.keep(draft('x'.repeat(i)));
      vi.advanceTimersByTime(100);
    }
    // Three seconds of keys, a key every 100 ms: a write every pause, not one a key and not none.
    expect(s.did.sets).toBe(Math.floor(3000 / DRAFT_PAUSE_MS));
    expect(readNoteDraft(KEY, s)?.text.length).toBeGreaterThan(24);
  });

  it('flush writes what waits at once, and then there is nothing left to write', () => {
    const s = fakeStore();
    const k = draftKeeper<NoteDraft>(() => KEY, DRAFT_PAUSE_MS, s);
    k.flush();
    expect(s.did.sets).toBe(0);
    k.keep(draft('half a thought'));
    k.flush();
    expect(readNoteDraft(KEY, s)?.text).toBe('half a thought');
    vi.advanceTimersByTime(DRAFT_PAUSE_MS * 2);
    k.flush();
    expect(s.did.sets).toBe(1);
  });

  it('forgetting takes the draft out at once, and what waited is never written', () => {
    const s = fakeStore();
    const k = draftKeeper<NoteDraft>(() => KEY, DRAFT_PAUSE_MS, s);
    k.keep(draft('posted in a moment'));
    k.flush();
    k.keep(draft('posted in a moment!'));
    k.keep(undefined);
    expect(readNoteDraft(KEY, s)).toBeUndefined();
    vi.advanceTimersByTime(DRAFT_PAUSE_MS * 2);
    k.flush();
    expect(readNoteDraft(KEY, s)).toBeUndefined();
    expect(s.did.sets).toBe(1);
  });

  it('with no key (a fixture, a board with no name yet) nothing is written and nothing removed', () => {
    const s = fakeStore({ other: 'kept' });
    const k = draftKeeper<NoteDraft>(() => undefined, DRAFT_PAUSE_MS, s);
    k.keep(draft('words'));
    vi.advanceTimersByTime(DRAFT_PAUSE_MS);
    k.flush();
    k.keep(undefined);
    expect(s.did).toEqual({ sets: 0, removes: 0 });
    expect(s.map.get('other')).toBe('kept');
  });

  it('the key is asked for when it writes, so a board that gets its name later is kept under it', () => {
    const s = fakeStore();
    let name: string | undefined;
    const k = draftKeeper<NoteDraft>(() => name, DRAFT_PAUSE_MS, s);
    k.keep(draft('words'));
    name = 'late';
    vi.advanceTimersByTime(DRAFT_PAUSE_MS);
    expect(readNoteDraft('late', s)?.text).toBe('words');
  });

  it('a storage that is full or blocked loses the draft and nothing else', () => {
    const broken = {
      getItem: () => null,
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    const k = draftKeeper<NoteDraft>(() => KEY, DRAFT_PAUSE_MS, broken);
    k.keep(draft('words'));
    expect(() => vi.advanceTimersByTime(DRAFT_PAUSE_MS)).not.toThrow();
    expect(() => k.keep(undefined)).not.toThrow();
  });
});

describe('when the owner looks away or the page goes', () => {
  /** Say how the page is seen, as the browser would, and tell the page it changed. */
  function seen(state: 'visible' | 'hidden') {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
  }

  afterEach(() => {
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('the draft is written: the window loses focus, the tab is hidden, the page is left', () => {
    const flush = vi.fn();
    const stop = flushOnLeave(flush);
    window.dispatchEvent(new Event('blur'));
    expect(flush).toHaveBeenCalledTimes(1);
    seen('hidden');
    expect(flush).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new Event('pagehide'));
    expect(flush).toHaveBeenCalledTimes(3);
    // Coming back is not leaving.
    seen('visible');
    window.dispatchEvent(new Event('focus'));
    expect(flush).toHaveBeenCalledTimes(3);
    stop();
    window.dispatchEvent(new Event('blur'));
    seen('hidden');
    window.dispatchEvent(new Event('pagehide'));
    expect(flush).toHaveBeenCalledTimes(3);
  });
});
