import type { Id } from '@keel/protocol';
import type { PictureView } from '@keel/pictures';
import { useRef, useState } from 'react';
import type { ToolId, ViewMode } from '../chrome';
import type { Want } from '../focus';
import type { BoardCtx } from '../tools/types';

/**
 * The whole board, as its own parts see it: what a tool may read and do (`BoardCtx`), and what
 * only the parts round the tools may (the keys, talk, drop-in, the focus view, the story).
 *
 * It is one object per board, made once by `useBoard`: every function on it answers from the
 * latest render. So a part that outlives a render (a tool, a listener on the window, a timer, a
 * speech recogniser) keeps this object, or a function of it, and never a value it once read.
 */
export interface Board extends BoardCtx {
  /* ---- reading */

  /** The Board, or the Story of every chapter. */
  mode(): ViewMode;
  /** How the owner looks at the pictures: the walk being played, the pipeline view. Not in the log. */
  view(): PictureView;
  /** The size of the window. */
  viewport(): { w: number; h: number };
  /** Where the pointer last was over the board, in page pixels. */
  pointer(): { x: number; y: number } | null;
  /** True while a press is open on the board: a key that would change the tool or undo a step waits. */
  pressOpen(): boolean;
  /** Is the owner drawing or typing? Then the view never moves by itself. */
  busy(): boolean;
  /** The element the items are drawn in, once it is on the page. */
  layerEl(): HTMLElement | null;

  /* ---- doing */

  /** Hand the open press every pointer move that still waits for its frame. Call it before moving the camera by the wheel. */
  flushMoves(): void;
  /** Take a tool in hand. A go of the pen that waits is made into marks first. */
  setTool(tool: ToolId): void;
  setMode(mode: ViewMode): void;
  /** Space went down or came up: while it is held, a drag pans. */
  holdSpace(held: boolean): void;
  /** Undo the owner's last step. */
  undo(): void;
  /** Do again the step Undo last took back. */
  redo(): void;
  /** Take what is selected off the board. */
  removeSelected(): void;
  /** Solidify what the open lasso holds. */
  solidify(): void;
  /** One step of the selected walk, on or back. False when no walk is selected. */
  stepWalk(dir: 1 | -1): boolean;
  /**
   * Move what is selected by an arrow key, in world units. A run of presses is posted once the
   * keys rest, as one step. False when nothing selected can move: the key stays the browser's.
   */
  nudge(dx: number, dy: number): boolean;
  /** Open the focus view of a part or a lane, or ask the agent to draw it. */
  openFocus(want: Want): void;
  /** Leave the focus view and go back where the camera was. False when none is open. */
  closeFocus(): boolean;
  /** Open the browser's file picker, to drop a file in. */
  openPicker(): void;
  /** Take the "drop here" overlay off. False when it was not showing. */
  endDrop(): boolean;
  startTalk(): void;
  stopTalk(): void;
  /** Zoom by a factor about the middle of the screen. */
  zoomBy(factor: number): void;
  /** Fit the whole board in view. */
  fitAll(): void;
  /** Make items blink once, so the eye finds them. */
  flash(ids: readonly Id[]): void;
}

/** What is fixed for the life of the page: taken once, when the board is made. */
export type BoardFixed = Pick<Board, 'isOwner' | 'camera' | 'hand' | 'frames' | 'moving'>;

/** The board's functions, as one render makes them. */
export type BoardNow = Omit<Board, keyof BoardFixed>;

/** Every function of the board, by name. The compiler keeps this list whole: a function added to `Board` must be added here. */
const FUNCTIONS: Record<keyof BoardNow, true> = {
  state: true,
  boxes: true,
  where: true,
  tool: true,
  spaceHeld: true,
  editing: true,
  selected: true,
  selection: true,
  rect: true,
  toBoard: true,
  toWorld: true,
  itemEl: true,
  hitAt: true,
  reachable: true,
  measure: true,
  measureAll: true,
  targetBox: true,
  outlines: true,
  noteTarget: true,
  capture: true,
  showPressing: true,
  select: true,
  say: true,
  send: true,
  postMark: true,
  postNew: true,
  newId: true,
  freeId: true,
  setPendingBox: true,
  setPendingArrow: true,
  recordStep: true,
  dragEnded: true,
  openLabel: true,
  openNote: true,
  showPending: true,
  hidePending: true,
  snapshot: true,
  mode: true,
  view: true,
  viewport: true,
  pointer: true,
  pressOpen: true,
  busy: true,
  layerEl: true,
  flushMoves: true,
  setTool: true,
  setMode: true,
  holdSpace: true,
  undo: true,
  redo: true,
  together: true,
  notComing: true,
  removeSelected: true,
  solidify: true,
  stepWalk: true,
  nudge: true,
  openFocus: true,
  closeFocus: true,
  openPicker: true,
  endDrop: true,
  startTalk: true,
  stopTalk: true,
  zoomBy: true,
  fitAll: true,
  flash: true,
};

/**
 * Make the board's one object. It is the same object on every render, and so is each function
 * on it: a function called on it runs the one of that name from the render that ran last.
 *
 * `fill` is called in every render with that render's functions. A function of the board may
 * be handed on at any time, but none may be called before the first render has called `fill`.
 */
export function useBoard(fixed: BoardFixed): readonly [board: Board, fill: (now: BoardNow) => void] {
  const latest = useRef<BoardNow | null>(null);
  const [pair] = useState(() => {
    const board: Record<string, unknown> = { ...fixed };
    for (const key of Object.keys(FUNCTIONS) as Array<keyof BoardNow>) {
      board[key] = (...args: unknown[]) => {
        const now = latest.current;
        if (!now) throw new Error(`The board was asked for "${key}" before its first render had finished.`);
        return (now[key] as (...a: unknown[]) => unknown)(...args);
      };
    }
    const fill = (now: BoardNow) => {
      latest.current = now;
    };
    return [board as unknown as Board, fill] as const;
  });
  return pair;
}
