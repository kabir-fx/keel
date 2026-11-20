import type { BoardState, Box, Id } from '@keel/protocol';
import { isAnswered } from '@keel/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Camera, CameraStore } from '../camera/camera';
import { fitBox, unionBox } from '../camera/camera';
import { FOCUS_TOP } from '../camera/fit';
import type { Crumb, Want } from '../focus';
import { crumbOf, raisedOf, wantName } from '../focus';
import { focusFor, openAsk } from '../marks';
import type { BoardSource } from '../source';
import type { Board } from './context';

/** How often a wait for the owner to finish drawing or typing looks again, in ms. */
const IDLE_CHECK = 400;

/** The focus picture that is open, and the camera to go back to. */
export interface FocusView {
  id: Id;
  back: Camera;
}

/** A focus the owner asked for that the agent has not drawn yet. */
export type Opening = Want & { name: string; asked?: string };

/** The focus view of one board. */
export interface Focus {
  focusView: FocusView | null;
  opening: Opening | null;
  /** What stays above the dim while the focus view is open; undefined when none is. */
  raised: ReadonlySet<Id> | undefined;
  crumb: Crumb | undefined;
  /** Is a focus view open now? True from the call that opens it, before the next render. */
  isOpen(): boolean;
  /** A mark was made: while the focus view is open, it stays above the dim with it. */
  made(id: Id): void;
  /** Open one part's focus picture large over the dimmed board, fitted to it or to `fit`. */
  openView(id: Id, fit?: readonly Id[]): void;
  /** A part or a lane: open its focus view if the agent drew one, else ask for it and wait. */
  open(want: Want): void;
  /** Leave the focus view and go back where the camera was. False when none is open. */
  close(): boolean;
  /** Leave the focus view and stay where the camera is. */
  leave(): void;
  /** Stop waiting for a focus that was asked for. */
  stopOpening(): void;
}

/** What the focus view needs of the render it runs in. */
export interface FocusNeeds {
  board: Pick<Board, 'send' | 'busy' | 'say' | 'select'>;
  source: BoardSource;
  camera: CameraStore;
  viewport: { w: number; h: number };
  state: BoardState;
  boxes: ReadonlyMap<Id, Box>;
  watchFolded: boolean;
  setWatchFolded: (folded: boolean) => void;
}

/**
 * The focus view: one part opened large over the dimmed board. It keeps which picture is open
 * and the camera to go back to, asks the agent for a focus that is not drawn yet, and opens it
 * when it arrives.
 */
export function useFocusView({ board, source, camera, viewport, state, boxes, watchFolded, setWatchFolded }: FocusNeeds): Focus {
  const [focusView, setFocusView] = useState<FocusView | null>(null);
  const [opening, setOpening] = useState<Opening | null>(null);
  /** A wait for the owner to finish drawing or typing: bumped to look again. */
  const [idleTick, setIdleTick] = useState(0);
  /** Marks made while the focus view is open: they stay above the dim with it. */
  const madeInFocus = useRef(new Set<Id>());
  const focusRef = useRef(focusView);
  focusRef.current = focusView;
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;
  /** Whether the build was folded before the focus view folded it; null while no view has. */
  const foldBeforeFocus = useRef<boolean | null>(null);

  const raised = useMemo(() => (focusView ? raisedOf(state, focusView.id, madeInFocus.current) : undefined), [state, focusView]);
  const crumb = useMemo(() => (focusView ? crumbOf(state, focusView.id) : undefined), [state, focusView]);

  /**
   * Open one part's focus picture large over the dimmed board. The camera fits it and what
   * hangs on it, and goes back where it was on Esc or the crumb.
   */
  const openView = (id: Id, fit?: readonly Id[]) => {
    const back = focusRef.current?.back ?? camera.goal();
    madeInFocus.current = new Set();
    const up = raisedOf(source.state, id);
    const list = (fit?.length ? fit : [...up]).map((x) => boxesRef.current.get(x)).filter((b): b is Box => !!b);
    const all = unionBox(list.length ? list : [boxesRef.current.get(id)!].filter(Boolean));
    const next = { id, back };
    focusRef.current = next;
    setFocusView(next);
    setOpening(null);
    board.select(undefined);
    if (all) camera.glide(fitBox(all, [48, FOCUS_TOP, Math.max(200, viewport.w - 96), Math.max(200, viewport.h - FOCUS_TOP - 104)], 1.25));
  };

  /**
   * The view closes: the build comes back as it was, in the render that closes the view and
   * not a later one. A fit made for that render then keeps clear of the build where it is.
   */
  const unfold = () => {
    if (foldBeforeFocus.current === null) return;
    setWatchFolded(foldBeforeFocus.current);
    foldBeforeFocus.current = null;
  };

  const close = (): boolean => {
    const f = focusRef.current;
    if (!f) return false;
    focusRef.current = null;
    setFocusView(null);
    madeInFocus.current = new Set();
    unfold();
    camera.glide(f.back);
    return true;
  };

  const leave = () => {
    focusRef.current = null;
    setFocusView(null);
    unfold();
  };

  /**
   * A part or a lane: open its focus view if the agent drew one, else ask for it and say that
   * the agent is opening it. It opens by itself when the picture arrives.
   */
  const open = (want: Want) => {
    const st = source.state;
    const what = want.part !== undefined ? { part: want.part } : want.lane !== undefined ? { lane: want.lane } : undefined;
    if (!what) return;
    const f = focusFor(st, what);
    if (f && boxes.get(f)) {
      openView(f);
      return;
    }
    const already = openAsk(st, what);
    const waiting = { ...what, ...(want.item ? { item: want.item } : {}), name: wantName(st, what), ...(already ? { asked: already } : {}) };
    setOpening(waiting);
    if (f || already) return;
    void board.send({ type: 'ask', what: 'focus', ...what, ...(want.item ? { item: want.item } : {}) }).then((r) => {
      setOpening((o) => (o !== waiting ? o : r.ok ? { ...waiting, asked: r.event.id } : null));
    });
  };

  // A focus picture taken off the board closes its view.
  useEffect(() => {
    if (focusView && (!state.items[focusView.id] || state.items[focusView.id]!.removed)) close();
  });

  // The focus the owner asked for has arrived and has a place: open it, once the owner is not
  // in the middle of drawing or typing.
  useEffect(() => {
    if (!opening) return;
    const f = focusFor(state, opening);
    // The agent answered the ask without a focus picture: stop waiting, and say so.
    if (!f && opening.asked && isAnswered(state, opening.asked)) {
      setOpening(null);
      const read = state.reads.find((r) => r.answers.includes(opening.asked!))?.read;
      board.say(`The agent did not open ${opening.name}${read ? `: ${read}` : '.'}`);
      return;
    }
    if (!f || !boxes.get(f)) return;
    if (board.busy()) {
      const t = setTimeout(() => setIdleTick((n) => n + 1), IDLE_CHECK);
      return () => clearTimeout(t);
    }
    openView(f);
    return undefined;
  }, [opening, state, boxes, idleTick]);

  // The focus view is about one part: the build folds to its one line while it is open. It
  // comes back as it was when the view closes (`unfold`).
  useEffect(() => {
    if (focusView && foldBeforeFocus.current === null) {
      foldBeforeFocus.current = watchFolded;
      setWatchFolded(true);
    }
  }, [focusView, watchFolded, setWatchFolded]);

  const [fixed] = useState(() => ({
    isOpen: () => focusRef.current !== null,
    made: (id: Id) => {
      if (focusRef.current) madeInFocus.current.add(id);
    },
    stopOpening: () => setOpening(null),
  }));

  return { focusView, opening, raised, crumb, openView, open, close, leave, ...fixed };
}
