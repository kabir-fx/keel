import { Anchor, Box, Id, PinItem, Point, Target } from '@keel/protocol';
import { NOTE_MAX, PIN_MAX } from './fieldText';
import { DRAFT_PAUSE_MS } from './input/constants';
import type { Label } from './tools/types';

/**
 * Words the owner is typing and has not posted, kept in the browser's storage per board (the
 * way `view.ts` keeps where the owner looks), so a reload, a crash or a closed tab does not
 * lose them. A draft is never posted from here: after a reload its field opens again, with the
 * words in it, and the owner decides.
 *
 * Each page keeps its own draft of each kind, under a key of its own, so two tabs on one board
 * never open or clear each other's words. A page holds a lock named for its key for as long as
 * it lives (the Web Locks API), and a draft whose lock nobody holds is one whose page is gone: a
 * crash, a closed tab, a reload. The next page that opens the board takes it over. A browser
 * without the API cannot say which pages live, so there every draft but a page's own is taken
 * over, as when a board had one draft for all its pages.
 */

/** A note being typed: a new one, or a change to one of the owner's. */
export interface NoteDraft {
  /** The words as last typed. A field with no words keeps no draft. */
  text: string;
  /** Where the field is open, in world units. */
  at: [number, number];
  /** A new note: the thing it was clicked on, and where that thing was then. */
  on?: Target;
  anchor?: Anchor;
  /** A new note that was posted once: the id it went with. The board may have it already. */
  id?: Id;
  /** A change to a note: the note. */
  edit?: Id;
}

/** The words being typed on a mark that is drawn and not posted, with the mark. */
export interface LabelDraft {
  label: Label;
  text: string;
  /** The id the mark was first posted with. The board may have it already. */
  mark?: Id;
}

/** The two kinds of field that keep a draft. Each page keeps one of each, apart. */
export type DraftKind = 'note' | 'label';

/** The start of every key a page keeps a draft of this kind under, for this board. The board's name is written so no other board's keys start the same. */
const draftPrefix = (kind: DraftKind, board: string) => `keel.draft.${kind}.${encodeURIComponent(board || 'board')}@`;

/** Where one page keeps its draft of this kind for this board. `page` is the page's own name. */
export const draftKey = (kind: DraftKind, board: string, page: string) => `${draftPrefix(kind, board)}${page}`;

/** Where a board kept its one draft of a kind before each page had its own. Such a draft is no live page's: the next page takes it over. */
export const oldDraftKey = (kind: DraftKind, board: string) => `keel.draft.${kind}.${board || 'board'}`;

/** A name for a new page's drafts. Each page makes its own, so two never share one, not even a tab duplicated with its session. */
export function newPageName(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Listing = Pick<Storage, 'key' | 'length'>;

function store(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** Every key a draft of this kind for this board is kept under, by any page: the old one too. */
export function draftKeys(kind: DraftKind, board: string, s: Listing | undefined = store()): string[] {
  const prefix = draftPrefix(kind, board);
  const old = oldDraftKey(kind, board);
  const keys: string[] = [];
  try {
    for (let i = 0; s && i < s.length; i++) {
      const key = s.key(i);
      if (key !== null && (key === old || key.startsWith(prefix))) keys.push(key);
    }
  } catch {
    // Blocked storage keeps no drafts.
  }
  return keys;
}

/** Take a draft out of storage: its words are posted, closed, or another page's own now. */
export function dropDraft(key: string, s: Store | undefined = store()): void {
  try {
    s?.removeItem(key);
  } catch {
    // Blocked storage kept nothing in the first place.
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What is kept under a key, if it is an object at all. Storage can hold anything: every field is checked by its reader. */
function kept(key: string, s: Store | undefined): Record<string, unknown> | undefined {
  try {
    const raw = s?.getItem(key);
    const v: unknown = raw ? JSON.parse(raw) : undefined;
    return isRecord(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Words worth bringing back: a string with something in it, cut to what its field holds. */
function words(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined;
}

/** The note kept for a board, if a sound one is kept. */
export function readNoteDraft(key: string, s: Store | undefined = store()): NoteDraft | undefined {
  const v = kept(key, s);
  const text = words(v?.text, NOTE_MAX);
  const at = Point.safeParse(v?.at);
  if (!v || !text || !at.success) return undefined;
  const on = Target.safeParse(v.on);
  const anchor = Anchor.safeParse(v.anchor);
  const id = Id.safeParse(v.id);
  const edit = Id.safeParse(v.edit);
  return {
    text,
    at: at.data,
    ...(on.success ? { on: on.data } : {}),
    ...(anchor.success ? { anchor: anchor.data } : {}),
    ...(id.success ? { id: id.data } : {}),
    ...(edit.success ? { edit: edit.data } : {}),
  };
}

function soundLabel(l: unknown): Label | undefined {
  if (!isRecord(l)) return undefined;
  const at = Point.safeParse(l.at);
  if (!at.success) return undefined;
  if (l.kind === 'box') {
    const box = Box.safeParse(l.box);
    return box.success ? { kind: 'box', box: box.data, at: at.data } : undefined;
  }
  if (l.kind === 'arrow') {
    const from = Point.safeParse(l.from);
    const to = Point.safeParse(l.to);
    return from.success && to.success ? { kind: 'arrow', from: from.data, to: to.data, at: at.data } : undefined;
  }
  if (l.kind === 'pin') {
    const pin = PinItem.safeParse(l.pin);
    return pin.success ? { kind: 'pin', pin: pin.data, at: at.data } : undefined;
  }
  return undefined;
}

/** The label kept for a board, with its mark, if a sound one is kept. */
export function readLabelDraft(key: string, s: Store | undefined = store()): LabelDraft | undefined {
  const v = kept(key, s);
  const text = words(v?.text, PIN_MAX);
  const label = soundLabel(v?.label);
  const mark = Id.safeParse(v?.mark);
  return text && label ? { label, text, ...(mark.success ? { mark: mark.data } : {}) } : undefined;
}

/** The locks of the pages open in this browser: `navigator.locks`, where there is one. */
export type Locks = Pick<LockManager, 'request' | 'query'>;

/** This browser's locks, or nothing where it has none (an old browser, a test page). */
export function pageLocks(): Locks | undefined {
  try {
    return typeof navigator === 'undefined' ? undefined : (navigator.locks ?? undefined);
  } catch {
    return undefined;
  }
}

/**
 * Hold the lock named `name` until the answer is called, if no other page holds it. It answers
 * with nothing when one does. A page that closes or crashes lets go of its locks by itself.
 */
export function holdLock(locks: Locks, name: string): Promise<(() => void) | undefined> {
  return new Promise((answer) => {
    locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          answer(undefined);
          return undefined;
        }
        return new Promise<void>((letGo) => answer(() => letGo()));
      })
      .catch(() => answer(undefined));
  });
}

/** A draft whose page is gone, held now by the page that takes it over, so no other page takes it too. */
export interface Orphan {
  key: string;
  /** Let it go: its words are this page's own draft now, or nobody's. Once is enough; more is nothing. */
  release(): void;
}

/** Call `f` once at most. */
function once(f: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    f();
  };
}

/** The drafts of this kind for this board that no live page holds, each now held by this page. `own` is this page's own key. */
export async function orphansHeld(kind: DraftKind, board: string, own: string, locks: Locks, s: Listing | undefined = store()): Promise<Orphan[]> {
  let live: Set<string | undefined>;
  try {
    live = new Set((await locks.query()).held?.map((l) => l.name));
  } catch {
    return [];
  }
  const found: Orphan[] = [];
  for (const key of draftKeys(kind, board, s)) {
    if (key === own || live.has(key)) continue;
    // Another page that opens just now may have taken it first.
    const release = await holdLock(locks, key);
    if (release) found.push({ key, release: once(release) });
  }
  return found;
}

/** Where the browser cannot say which pages live: every draft of this kind for this board but this page's own. */
export function orphansNow(kind: DraftKind, board: string, own: string, s: Listing | undefined = store()): Orphan[] {
  return draftKeys(kind, board, s)
    .filter((key) => key !== own)
    .map((key) => ({ key, release: () => {} }));
}

/** One draft in the page's storage: told every change, it writes a little after, not on every key. */
export interface DraftKeeper<T> {
  /** This is the draft now. Nothing (`undefined`) forgets it, at once: it was posted, or closed. */
  keep(draft: T | undefined): void;
  /** Write now what waits to be written: the page is being hidden or closed. */
  flush(): void;
}

/**
 * Keep one draft under `key()`. A change is written `pause` ms after the first one that is not
 * written yet, so typing writes a few times a second at most, and never waits for the owner to
 * stop. `key()` answers nothing where no draft is kept (a fixture, a board with no name yet).
 */
export function draftKeeper<T>(key: () => string | undefined, pause: number = DRAFT_PAUSE_MS, s: Store | undefined = store()): DraftKeeper<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waiting: { draft: T } | undefined;

  const settle = () => {
    clearTimeout(timer);
    timer = undefined;
    const w = waiting;
    waiting = undefined;
    return w;
  };

  const flush = () => {
    const w = settle();
    const k = key();
    if (!w || !k) return;
    try {
      s?.setItem(k, JSON.stringify(w.draft));
    } catch {
      // Storage can be full or blocked: the draft is simply not kept.
    }
  };

  return {
    keep(draft) {
      if (draft !== undefined) {
        waiting = { draft };
        timer ??= setTimeout(flush, pause);
        return;
      }
      settle();
      const k = key();
      try {
        if (k) s?.removeItem(k);
      } catch {
        // Blocked storage kept nothing in the first place.
      }
    },
    flush,
  };
}

/**
 * Call `flush` (a keeper's) when the owner looks away or the page goes: the window loses focus,
 * the tab is hidden, the page is left. Nothing is posted then, only kept. It answers with the
 * way to stop listening.
 */
export function flushOnLeave(flush: () => void): () => void {
  const hidden = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  window.addEventListener('blur', flush);
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', hidden);
  return () => {
    window.removeEventListener('blur', flush);
    window.removeEventListener('pagehide', flush);
    document.removeEventListener('visibilitychange', hidden);
  };
}
