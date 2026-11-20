import { useEffect, useMemo, useRef, useState } from 'react';
import type { DraftKind, Orphan } from '../noteDraft';
import { draftKeeper, draftKey, dropDraft, flushOnLeave, holdLock, newPageName, orphansHeld, orphansNow, pageLocks } from '../noteDraft';
import type { BoardCtx } from '../tools/types';
import type { Board } from './context';

/**
 * One field at a time, and the owner's words kept whatever happens to it. The notes and the
 * labels each have one of these. It holds what both need and neither posts with:
 *
 * - the field that is open, each opening a field of its own;
 * - those on their way back to the owner's hand (the board refused them, Undo brought them
 *   back, a reload did), which open one after the other, each when no field is open and no
 *   press is under way on the board;
 * - the words of the open field, written to the browser a little after each key and at once
 *   when the owner looks away, under this page's own key, and read back by the next page when
 *   this one is gone (`noteDraft.ts`).
 *
 * `T` is what a field is of (a note being written, a mark being labelled), and `D` is what is
 * kept in the browser for it.
 */

/** What the board says when it already had what the owner posted: its answer to the first post was lost, and nothing is posted twice. */
export const HAD_IT = 'The board had it already, so it was not posted twice.';

/** A field that is open. */
export interface Opening<T> {
  /** What it is a field of. */
  of: T;
  /** The words it opened with. */
  text: string;
  /** Each opening has a number of its own, so it is a new field and never takes over another's words. */
  n: number;
  /** Undo opened it: the step that brought it back is on the redo list now. */
  byUndo: boolean;
}

/**
 * Is this the field Undo opened, with its words as Undo brought them? Then Esc only puts it
 * away: its step stays on the redo list, and the next Undo goes on to the step before. A step
 * recorded again here would open the same field at every Undo, and empty the redo list each time.
 */
export const asUndoLeftIt = (o: Opening<unknown>, text: string): boolean => o.byUndo && text === o.text;

/** What a field needs of the board: a tool's, and whether a press is under way. */
export type FieldBoard = BoardCtx & Pick<Board, 'pressOpen'>;

/** What one kind of field needs to be kept one at a time, with its words. */
export interface OneFieldNeeds<T, D> {
  board: FieldBoard;
  kind: DraftKind;
  /** The board's name, where drafts are kept for it. Nothing where none is kept (a fixture), or before the board has its name. */
  draftBoard(): string | undefined;
  /** What is kept in the browser for these words. Nothing when they are not worth keeping. */
  draftOf(of: T, text: string): D | undefined;
  /** A kept draft read back, as a field to open. Nothing when it is not sound, or when the board has what it holds already: it is let go. */
  readDraft(key: string): { of: T; text: string } | undefined;
  /** What the board says when a reload brings a field back: why something the owner did not just open is in front of them. */
  backLine: string;
  /** May a field that waits open now? Asked after every render, with no field of this kind open. */
  free(): boolean;
  /** What the field is of, as the board is now. Asked when it opens: it may have waited. */
  asNow?(of: T): T;
}

/** The one field of its kind, and what waits behind it. */
export interface OneField<T> {
  /** The field that is open, as React has drawn it; null when none is. */
  open: Opening<T> | null;
  /** Is a field open, as of the last opening or closing, also before React has drawn it? */
  isOpen(): boolean;
  /** Open a field now, for the owner's own doing (a tool, a double click). A field that is open goes back in line, with its words. */
  show(of: T, text: string): void;
  close(): void;
  /** Hand something back to the owner with its words: now, or once the field that is open has closed. */
  bringBack(of: T, text: string): void;
  /** The same, for Undo: the field it opens knows that Undo opened it (`asUndoLeftIt`). */
  bringBackByUndo(of: T, text: string): void;
  /** These are the words of this opening now, of `of` (what it was, unless it has changed on its way): they are kept in the browser, when they are worth it. */
  keep(o: Opening<T>, text: string, of?: T): void;
  /** Let the draft go, if it is still this opening's: a later field may have taken its place. */
  forget(o: Opening<T>): void;
  /** Write the draft now: what it is of is on its way to the board, and is the owner's alone until the board has it. */
  flush(): void;
}

/**
 * One on its way back. `line` is said when it opens; `from` is the draft of a page that is gone,
 * which becomes this page's when it opens; `byUndo` says Undo brought it.
 */
interface Waiting<T> {
  of: T;
  text: string;
  line?: string;
  from?: Orphan;
  byUndo?: boolean;
}

export function useOneField<T, D>(needs: OneFieldNeeds<T, D>): OneField<T> {
  const { board, kind } = needs;
  const [open, setOpen] = useState<Opening<T> | null>(null);
  /** The open field as of the last opening or closing. */
  const now = useRef<Opening<T> | null>(null);
  const openings = useRef(0);
  /** Those on their way back, first to open first. */
  const waiting = useRef<Array<Waiting<T>>>([]);
  const [, setWakes] = useState(0);
  const wake = () => setWakes((n) => n + 1);
  /** The opening whose words are the draft in storage; 0 when none is kept. */
  const keptOf = useRef(0);
  /** The words of the open field as last typed. */
  const typed = useRef<{ n: number; text: string }>({ n: 0, text: '' });
  const latest = useRef(needs);
  latest.current = needs;

  /** The board's name, where this page keeps its draft, once it is known. */
  const [name, setName] = useState<string>();
  const page = useMemo(newPageName, []);
  const keeper = useMemo(
    () =>
      draftKeeper<D>(() => {
        const n = latest.current.board.isOwner ? latest.current.draftBoard() : undefined;
        return n === undefined ? undefined : draftKey(kind, n, page);
      }),
    [kind, page],
  );
  /** The key the wake at the end of a press runs under, in the board's frame loop. */
  const pressWatch = useMemo(() => ({}), []);

  const forget = (o: Opening<T>) => {
    if (keptOf.current !== o.n) return;
    keptOf.current = 0;
    keeper.keep(undefined);
  };

  const keep = (o: Opening<T>, text: string, of: T = o.of) => {
    if (now.current?.n === o.n) typed.current = { n: o.n, text };
    const draft = latest.current.draftOf(of, text);
    if (draft === undefined) {
      forget(o);
      return;
    }
    keptOf.current = o.n;
    keeper.keep(draft);
  };

  const openNow = (w: Waiting<T>) => {
    const o: Opening<T> = { of: latest.current.asNow ? latest.current.asNow(w.of) : w.of, text: w.text, n: ++openings.current, byUndo: w.byUndo === true };
    now.current = o;
    setOpen(o);
    keep(o, w.text);
    if (!w.from) return;
    // A draft taken over from a page that is gone is this page's now: written here, then let go there.
    keeper.flush();
    dropDraft(w.from.key);
    w.from.release();
  };

  const show = (of: T, text: string) => {
    const was = now.current;
    // The field that is open is not dropped: it waits, with its words, for the new one to close.
    // Its words may have changed, so it no longer counts as Undo's: Esc on it then records a step.
    if (was) waiting.current.unshift({ of: was.of, text: typed.current.n === was.n ? typed.current.text : was.text });
    openNow({ of, text });
  };

  // The words wait to be written a little after each key. When the owner looks away, or the
  // board goes, they are written at once. Nothing is ever posted from here.
  useEffect(() => {
    const off = flushOnLeave(keeper.flush);
    return () => {
      off();
      keeper.flush();
      board.frames.cancel(pressWatch);
    };
  }, [keeper, board, pressWatch]);

  // The board's name is known once its log has been read: it is asked for after a render.
  useEffect(() => {
    if (name === undefined && board.isOwner) setName(latest.current.draftBoard());
  });

  // Once the board's name is known: this page holds its own key for as long as it is open, and
  // takes over what pages that are gone were typing (after a reload, that is this tab's own).
  useEffect(() => {
    if (name === undefined) return;
    const own = draftKey(kind, name, page);
    const locks = pageLocks();
    let live = true;
    const letGo: Array<() => void> = [];
    const taken: Array<Waiting<T>> = [];
    const take = (found: Orphan[]) => {
      for (const from of found) {
        // A page that has gone meanwhile takes nothing over: it is left for the next.
        const draft = live ? latest.current.readDraft(from.key) : undefined;
        if (!draft) {
          // Not sound, or the board has it already: nobody's to open, so it is cleared.
          if (live) dropDraft(from.key);
          from.release();
          continue;
        }
        const w: Waiting<T> = { ...draft, line: latest.current.backLine, from };
        taken.push(w);
        waiting.current.push(w);
      }
      if (live && found.length > 0) wake();
    };
    if (locks) {
      void holdLock(locks, own).then((release) => release && (live ? letGo.push(release) : release()));
      void orphansHeld(kind, name, own, locks).then(take);
    } else {
      take(orphansNow(kind, name, own));
    }
    return () => {
      live = false;
      keeper.flush();
      // What was taken over and has not opened is let go, still in storage, for the next page.
      waiting.current = waiting.current.filter((w) => !taken.includes(w));
      for (const w of taken) w.from?.release();
      for (const release of letGo) release();
    };
  }, [name, kind, page, keeper]);

  // One field at a time: what is on its way back opens when nothing else is open, and not in
  // the middle of a press on the board. A press that ends opens it on the next frame.
  useEffect(() => {
    if (now.current || waiting.current.length === 0 || !needs.free()) return;
    if (board.pressOpen()) {
      board.frames.start(pressWatch, () => {
        if (board.pressOpen()) return true;
        wake();
        return false;
      });
      return;
    }
    const next = waiting.current.shift();
    if (!next) return;
    openNow(next);
    if (next.line) board.say(next.line);
  });

  return {
    open,
    isOpen: () => now.current !== null,
    show,
    close: () => {
      now.current = null;
      setOpen(null);
    },
    bringBack: (of, text) => {
      waiting.current.push({ of, text });
      wake();
    },
    bringBackByUndo: (of, text) => {
      waiting.current.push({ of, text, byUndo: true });
      wake();
    },
    keep,
    forget,
    flush: keeper.flush,
  };
}
