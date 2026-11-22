import type { Anchor, ArrowItem, Box, BoardState, Id, InkItem, MarkItem, PinItem, Target } from '@keel/protocol';
import type { Ties } from '../binding';
import type { CameraStore } from '../camera/camera';
import type { ToolId } from '../chrome';
import type { Draft } from '../drafts';
import type { FrameLoop } from '../frame';
import type { TargetRect } from '../geometry';
import type { Where } from '../layout';
import type { LiveStore } from '../live';
import type { TargetBox } from '../marks';
import type { MovingStore } from '../select/moving';
import type { PostResult } from '../source';

/**
 * The seam between the board and its tools.
 *
 * - A `Press` is one pointer going down on the board, moving, and ending.
 * - A `Tool` is four functions that are handed presses.
 * - The `BoardCtx` is everything a tool may read or do.
 *
 * A tool never reaches into React state and never reads the page layout: it goes through the
 * board context. A tool posts to the log in `up` and nowhere else, so a press that ends any
 * other way leaves the board as it was.
 *
 * So a tool can be tested alone, on a board laid out by hand (`test/fakeBoard.ts`), and the
 * board can change how it keeps its state without a tool knowing.
 */

/** A point: `[x, y]`. The name of the field says which space it is in. */
export type Point = readonly [number, number];

/**
 * The device behind a pointer. Only a mouse and a trackpad (which reports as a mouse) are
 * built for today; a pen and a finger are parked, and the type carries them so that work can
 * start from here.
 */
export type Device = 'mouse' | 'pen' | 'touch';

/** The modifier keys, read again from every pointer event: a key can change during a press. */
export interface Mods {
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
}

/**
 * Why a press ended. Only `up` is the owner lifting the pointer: it is the one ending that may
 * post to the log. Every other reason goes to the tool's `cancel`.
 *
 * - `cancel`: the browser took the pointer away (`pointercancel`).
 * - `lost`: the board lost its capture of the pointer before an up came.
 * - `blur`: the window lost focus, or got it back with a press still open.
 * - `escape`: the owner pressed Esc during the press.
 * - `superseded`: a new press began while this one was still open, so its up never came.
 */
export type EndReason = 'up' | 'cancel' | 'lost' | 'blur' | 'escape' | 'superseded';

/**
 * One position a pointer reported. A browser collects several between two frames, and a press
 * hands a tool all of them, so fast ink keeps its shape.
 */
export interface Sample {
  /** Board pixels: screen space, counted from the board's top-left corner. */
  readonly x: number;
  readonly y: number;
  /**
   * World units, by the camera as it was when the sample arrived. A wheel can move the camera
   * in the middle of a press, so a tool must use these and not convert `x` and `y` later.
   */
  readonly wx: number;
  readonly wy: number;
  /** 0 to 1. A mouse and a trackpad report 0.5 while a button is down. */
  readonly pressure: number;
  /** When the sample was taken, in the clock of `Event.timeStamp` (ms). */
  readonly t: number;
}

/** One pointer going down on the board, moving, and ending. */
export interface Press {
  /** The browser's pointer id. Events from any other pointer are not part of this press. */
  readonly pointer: number;
  readonly device: Device;
  /** The button that went down: 0 is the main one, 1 the middle one. */
  readonly button: number;
  /** What the press landed on. */
  readonly target: Element | null;
  /** Where it went down. `client` is the page's pixels, as `targetAt` and the DOM take them. */
  readonly down: Sample;
  readonly downClient: Point;
  /** Where the pointer is now: the last sample. Set before every call to a tool. */
  at: Sample;
  client: Point;
  mods: Mods;
  /**
   * True once the pointer has gone further from `down` than the click slop, in board pixels.
   * It never goes back to false: a press that left and came back is still a drag.
   */
  moved: boolean;
  /**
   * Every sample since the last call to `move`, oldest first. It is never empty when `move`
   * is called, and its last entry is `at`.
   */
  samples: readonly Sample[];
}

/**
 * A tool: what one kind of press does. Each board makes its own tools (a tool may keep the
 * state of the press it is handling), so two boards on one page never share a gesture.
 */
export interface Tool {
  /**
   * A press went down. False means "not mine": the press goes on to what it hit (a button in
   * a picture gets its click) and the tool hears no more of it.
   */
  down(press: Press, board: BoardCtx): boolean;
  /**
   * The pointer moved. Called with every sample since the last call, at most once a frame, and
   * once more just before `up` or `cancel` when samples are still waiting.
   */
  move(press: Press, board: BoardCtx): void;
  /** The owner lifted the pointer. The only place a tool posts to the log. */
  up(press: Press, board: BoardCtx): void;
  /**
   * The press ended some other way. The tool puts back everything it changed (styles, the live
   * layer, the selection it cleared) and posts nothing.
   */
  cancel(press: Press, board: BoardCtx, why: Exclude<EndReason, 'up'>): void;
}

/**
 * A mark that is drawn and waits for its words: a tool hands it to the board on `up`, and the
 * board posts it when the owner has typed, or left, its label. `at` is where the label's field
 * opens, in world units. An arrow carries what its ends tied to as it was drawn (`ties`).
 */
export type Label =
  | { kind: 'box'; box: Box; at: [number, number] }
  | { kind: 'arrow'; from: [number, number]; to: [number, number]; at: [number, number]; ties?: Ties }
  | { kind: 'pin'; pin: PinItem; at: [number, number] };

/** What a new note is put on: the thing it was clicked on, and where that thing was then. */
export interface NoteTarget {
  on?: Target;
  anchor?: Anchor;
}

/**
 * One step of the owner's that Undo can take back, recorded by whoever made it. Most steps are
 * recorded where the page posts to the log, with no help from a tool. This is for a step the
 * log does not show: a note closed with Esc, whose words Undo brings back.
 */
export interface UndoStep {
  /** A few words that name the step in a line to the owner: "the note you closed". */
  what: string;
  /**
   * Take the step back. False means it could not be (the thing has changed since, or the board
   * refused): the step is dropped, and the board says so.
   */
  undo(): boolean | Promise<boolean>;
  /** Do the step again after it was taken back. A step without it cannot be redone. */
  redo?(): boolean | Promise<boolean>;
}

/** The board's place on the page, measured on resize and scroll and read from memory after. */
export interface BoardRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * What a tool may read and do. One object per board, made once: every method reads the board
 * as it is now, so a tool that keeps the context never sees a stale value.
 *
 * The rules of this list: reads are functions, nothing here reads the page layout during a
 * press unless its name says so (`measure`), and nothing here is React state. What only the
 * parts round the tools need (the keys, talk, drop-in, the focus view) is on `Board`, in
 * `board/context.ts`. A new member goes in four places: here or there, the list of names in
 * `board/context.ts`, `fillBoard` in `App.tsx`, and the fake board in `test/fakeBoard.ts`.
 */
export interface BoardCtx {
  /** True when this page may mark the board. Fixed for the life of the page. */
  readonly isOwner: boolean;
  readonly camera: CameraStore;
  /** The live layer: what the owner's hand is drawing before it is a mark. */
  readonly hand: LiveStore;
  /**
   * The board's one frame loop. Everything that moves by itself (the camera's glide, a trail,
   * the agent's cursor) runs on it, and it stops when nothing moves.
   */
  readonly frames: FrameLoop;
  /**
   * What Select's hand holds now, frame by frame: what it moves or resizes and by how much. What
   * follows the hand (the line round the selection, the arrows tied to what moves) reads it.
   */
  readonly moving: MovingStore;

  /* ---- reading the board */

  /** The log, folded: the board as it is now. */
  state(): BoardState;
  /** Where every live item is drawn now, in world units. */
  boxes(): ReadonlyMap<Id, Box>;
  /** The board as it is drawn, for working out where things are: the log's, with what the page knows ahead of it (`setPendingBox`, `setPendingArrow`). */
  where(): Where;
  /** The tool in hand. */
  tool(): ToolId;
  /** True while Space is held: a drag pans, whatever the tool in hand. */
  spaceHeld(): boolean;
  /** True while a note or a label is open for typing: a press on the board then only closes it. */
  editing(): boolean;
  /** The one thing selected, when exactly one is: what a part about one thing (a walk, a lasso) acts on. Nothing when several are. */
  selected(): Id | undefined;
  /** Everything selected, in the order it was selected. */
  selection(): readonly Id[];
  /** The board's place on the page, from memory. */
  rect(): BoardRect;
  /** Page pixels to board pixels, with no layout read. */
  toBoard(clientX: number, clientY: number): [number, number];
  /** Page pixels to world units, by the camera as it is now, with no layout read. */
  toWorld(clientX: number, clientY: number): [number, number];
  /** The element an item is drawn in, if it is on the page. */
  itemEl(id: Id): HTMLElement | undefined;
  /**
   * What a press on `target` at a world point lands on: of the items under it (`target` is the
   * element the browser found) and the marks drawn as lines near it, the one the board stacks on
   * top, unless that one is only near and one below is under the point squarely.
   */
  hitAt(target: Element | null, wx: number, wy: number): Id | undefined;
  /** Can the pointer reach this thing? In a focus view only what stands above the dim: the rest is not there to point at. */
  reachable(id: Id): boolean;

  /* ---- measuring: these read the page layout, so a tool calls them once a gesture, not once a sample */

  /** What a mark can point at: every item with a box on the page, and the named parts inside it. */
  measure(): TargetRect[];
  /** What a lasso can hold: the same, and the line marks too. */
  measureAll(): TargetRect[];
  /** Where a target is drawn now. */
  targetBox: TargetBox;
  /** Where every item that can be pointed at is drawn, at the size it is drawn, in world units: what a gesture lines up with, or selects with a box. */
  outlines(): ReadonlyMap<Id, Box>;
  /** What a click at a page point lands on, for a note: a thing under it, else a lasso round it. */
  noteTarget(clientX: number, clientY: number): NoteTarget;

  /* ---- doing */

  /** Keep this pointer's events coming to the board, also outside it. */
  capture(pointer: number): void;
  /**
   * Tell the page whether a press is open on the board: the pointer went down on it and has not
   * ended. The page marks itself (`data-pressing` on the app's root), so its styles can keep
   * the chrome still while the owner draws or drags, with no render. Only the dispatcher calls it.
   */
  showPressing(open: boolean): void;
  /** Select one item, several, or nothing. An item that leaves the board leaves the selection. */
  select(what: Id | readonly Id[] | undefined): void;
  /** Say one line to the owner (the toast). */
  say(text: string): void;
  /** Post one event. A refusal is said to the owner. */
  send(draft: Draft): Promise<PostResult>;
  /** Post a new mark, opening a chapter first when none is in work. */
  postMark(item: MarkItem): Promise<boolean>;
  /**
   * Post the events that put one new thing on the board, in turn (its chapter first, when it
   * opens one). They are one step, which takes its place in Undo's list now. False when the
   * board refused one of them: the rest are not posted, and no step is left behind.
   */
  postNew(id: Id, drafts: readonly Draft[]): Promise<boolean>;
  /** An id for a new mark, held until `freeId` so two marks made at once never share one. */
  newId(): Id;
  freeId(id: Id): void;
  /**
   * Show an item at a box the log does not say yet (a move that is posted and not back), or
   * stop doing so. With `only`, the box is dropped only if it is still that one.
   */
  setPendingBox(id: Id, box: Box | undefined, only?: Box): void;
  /**
   * Show an arrow as the owner has just set it again (an end, its label, or the whole of it let
   * go of what it pointed at), until the log says so, or stop doing so. With `only`, the arrow
   * is dropped only if it is still that one. What is drawn from an arrow is drawn from this one:
   * `where().state` has it, and `state()` is still the log's. It carries its own box: a pending
   * box of the same arrow (a move of it still on its way) is let go when it is set.
   */
  setPendingArrow(id: Id, arrow: ArrowItem | undefined, only?: ArrowItem): void;
  /**
   * One gesture is about to post on these things: the next event the owner posts on each (an
   * add, a change or a take-off) is one step, which takes its place in Undo's list now. The
   * marks of one go of the pen, a drag of several things, one sweep of the eraser. Call it
   * before the first of them is posted.
   */
  together(ids: readonly Id[]): void;
  /** The event on this thing that `together` said was coming will not be posted. */
  notComing(id: Id): void;
  /**
   * Record a step of the owner's that the log does not show, so Undo can take it back. It becomes
   * the newest step. The answer takes the step out of the list again: for a step that turned out
   * to have nothing to bring back, so it never costs the owner a press of Undo.
   */
  recordStep(step: UndoStep): () => void;
  /** A drag just ended: a tap on a picture that comes right after is the end of the drag, not a tap. */
  dragEnded(): void;
  /** Open the field for the words of a mark that is drawn and not posted yet. */
  openLabel(label: Label): void;
  /** Open the editor for a new note at a world point, on what it was clicked on. */
  openNote(at: [number, number], target: NoteTarget): void;
  /**
   * Draw ink that is on its way to the log, at once and before this returns, so a snapshot
   * taken next can see it. `hidePending` takes one mark's ink off again, once it is posted.
   */
  showPending(items: readonly InkItem[]): void;
  hidePending(id: Id): void;
  /**
   * Take a picture of an ink mark and what it covers, and store it with the board. It answers
   * with the stored asset, or with nothing where the board keeps no snapshots, or when the
   * picture is slow or fails: the mark then goes without it.
   */
  snapshot(item: InkItem, rects: readonly TargetRect[]): Promise<string | undefined>;
}
