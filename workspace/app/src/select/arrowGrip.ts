import type { ArrowItem, Box, Id } from '@keel/protocol';
import { labelPoint, shareAlong } from '../arrowhead';
import type { EndAim, TargetBoxNow } from '../binding';
import { drawnEnds, keptBoxes, tieAt, tieReach } from '../binding';
import type { Ends } from '../board/shown';
import type { TargetRect, XY } from '../geometry';
import { END_HANDLE_REACH, MIN_ARROW } from '../input/constants';
import type { Where } from '../layout';
import { arrowAims, arrowAsStored } from '../layout';
import type { BoardCtx, Press } from '../tools/types';
import type { ArrowChange } from './arrowEdit';
import { applied, changesNothing, withEndAt } from './arrowEdit';
import { theOne, tiedTo } from './grab';
import { cmdHeld, followKeys, pointerNow } from './hand';

/**
 * The arrow selected, taken by one of its ends or by its label: a gesture of Select's, beside a
 * move and a resize. An end dragged by its handle goes with the pointer and ties again as it
 * goes, with the same reach, outline and Cmd as when the arrow was drawn. A label dragged slides
 * along the line. Either goes as far as the pointer goes, from where it was drawn: it does not
 * jump to the pointer when the drag begins, and a pointer back where it went down leaves the
 * arrow as it was. Each frame is written into the board's `moving` store, so the arrow is drawn
 * from there with no render of the board, and the lift posts one change of the arrow, which
 * stays drawn so until the board has answered.
 *
 * The handles on an arrow's ends, that a drag of one ties the end again, and the way the hand
 * keeps the offset it took the end by, are Excalidraw's (packages/element/src/
 * linearElementEditor.ts, `pointerOffset`, commit 9fbeaed); so is a label dragged along its arrow
 * (its textElement.ts).
 */

/** What of the arrow the hand holds: one of its ends, or its label. */
export type Grip = 'from' | 'to' | 'label';

/** What the board must give for the arrow selected and its handles. */
type Selected = Pick<BoardCtx, 'isOwner' | 'state' | 'selection' | 'where' | 'boxes'>;

/** The one thing selected, when it is an arrow, on the owner's page: the arrow its end handles and its label are for. Every arrow is the owner's. */
export function gripArrow(board: Pick<BoardCtx, 'isOwner' | 'state' | 'selection'>): ArrowItem | undefined {
  const id = theOne(board.selection());
  const s = id === undefined ? undefined : board.state().items[id];
  if (!board.isOwner || !s || s.removed || s.item.kind !== 'arrow') return undefined;
  return s.item;
}

/**
 * The arrow selected, how its two ends are aimed, and where they are drawn now, in world units.
 * It is the arrow as the page draws it (`where`), which is ahead of the log while a change of
 * it, or a move of it, is on its way: the hand takes what the owner sees.
 */
export function gripEnds(board: Selected): { arrow: ArrowItem; aims: [EndAim, EndAim]; ends: Ends } | undefined {
  const id = gripArrow(board)?.id;
  const where = board.where();
  const drawn = id === undefined ? undefined : where.state.items[id]?.item;
  const shown = id === undefined ? undefined : board.boxes().get(id);
  if (drawn?.kind !== 'arrow' || !shown) return undefined;
  const arrow = arrowAsStored(where, drawn);
  const aims = arrowAims(where, arrow, shown);
  return { arrow, aims, ends: drawnEnds(...aims) };
}

/**
 * The end handle under a point of the board (board pixels): an end of the arrow selected within
 * `END_HANDLE_REACH` of it on the screen. The head's end is tried first, as Excalidraw tries an
 * arrow's last point first.
 */
export function endUnder(board: Selected & Pick<BoardCtx, 'camera'>, x: number, y: number): 'from' | 'to' | undefined {
  const got = gripEnds(board);
  if (!got) return undefined;
  const cam = board.camera.get();
  const near = (p: readonly [number, number]) => Math.hypot(p[0] * cam.z + cam.x - x, p[1] * cam.z + cam.y - y) <= END_HANDLE_REACH;
  if (near(got.ends[1])) return 'to';
  return near(got.ends[0]) ? 'from' : undefined;
}

/** Is `target` (what the browser found under the pointer) the label of the arrow selected? */
export function onLabel(board: Pick<BoardCtx, 'isOwner' | 'state' | 'selection'>, target: Element | null): boolean {
  const arrow = gripArrow(board);
  const label = target?.closest('.line-mark__text');
  return !!arrow && !!label && label.closest<HTMLElement>('[data-item]')?.dataset.item === arrow.id;
}

/** A press of Select on an end handle or the label of the arrow selected. */
export interface ArrowGrip {
  arrow: ArrowItem;
  grip: Grip;
  /** Where the arrow's ends were drawn when the press went down: a label slides along the line between them. */
  ends: Ends;
  /** Where what the hand took was drawn then: the end, or the middle of the label. It goes from there as far as the pointer goes. */
  taken: XY;
  /** The spot the other end holds: an end that ties again is aimed from there, as when the arrow was drawn. */
  other: XY;
  where: Where;
  /** The arrow and the lassos round it: drawn again from what the hand holds. */
  redraw: ReadonlySet<Id>;
  /** What an end can tie to, measured once the press has become a drag; nothing until then. */
  rects: TargetRect[] | null;
  /** Where each thing an end has tied to is drawn, read once a thing. */
  boxOf: TargetBoxNow;
  /**
   * Where each part of a picture an end has tied to is drawn, by `item/sub`. The board measures
   * a part only once a mark holds on to it, so the arrow in the hand is drawn from these.
   */
  parts: Map<string, Box>;
  /** What the hand has made of the arrow in the last frame. */
  now: ArrowChange | undefined;
  /** Stop following the camera and the keys. */
  off: () => void;
}

/** What a press of Select at this point takes of the arrow selected: an end by its handle, else its label. Nothing when it is on neither. */
export function gripAt(press: Press, board: BoardCtx): ArrowGrip | undefined {
  const got = gripEnds(board);
  if (!got) return undefined;
  const grip = endUnder(board, press.down.x, press.down.y) ?? (onLabel(board, press.target) ? 'label' : undefined);
  if (!grip) return undefined;
  const { arrow, aims, ends } = got;
  const taken = grip === 'label' ? labelPoint(ends[0], ends[1], arrow.labelAt) : ends[grip === 'from' ? 0 : 1];
  const other = aims[grip === 'from' ? 1 : 0].spot;
  const parts = new Map<string, Box>();
  const seen = board.where();
  const where: Where = { ...seen, subs: { get: (key) => seen.subs.get(key) ?? parts.get(key) } };
  return { arrow, grip, ends, taken, other, where, redraw: tiedTo(board.state(), new Set([arrow.id])), rects: null, boxOf: () => undefined, parts, now: undefined, off: () => {} };
}

/** The box of the thing the end in the hand held when the press went down. */
function heldThen(g: ArrowGrip): Box | undefined {
  const target = g.grip === 'from' ? g.arrow.fromTarget : g.grip === 'to' ? g.arrow.toTarget : undefined;
  return target && g.boxOf(target);
}

/** The arrow as the hand has it now, and the box of the thing its end would tie to. */
function changeNow(press: Press, board: BoardCtx, g: ArrowGrip): { change: ArrowChange; tie?: Box } {
  const [wx, wy] = pointerNow(press, board);
  const dx = wx - press.down.wx;
  const dy = wy - press.down.wy;
  // Back where it went down, the arrow is as it was: an end drawn short of its thing would tie to another spot of it from there.
  if (dx === 0 && dy === 0) {
    const tie = heldThen(g);
    return { change: { item: g.arrow, patch: {} }, ...(tie ? { tie } : {}) };
  }
  const p: XY = [g.taken[0] + dx, g.taken[1] + dy];
  if (g.grip === 'label') {
    const patch = { labelAt: shareAlong(g.ends[0], g.ends[1], p) };
    return { change: { item: applied(g.arrow, patch), patch } };
  }
  // Cmd or Ctrl held, the end ties to nothing, as when the arrow was drawn.
  const tied = cmdHeld(press) ? undefined : tieAt(p, g.other, g.rects ?? [], tieReach(board.camera.get().z), g.boxOf);
  if (tied?.end.target.sub) g.parts.set(`${tied.end.target.item}/${tied.end.target.sub}`, tied.box);
  return { change: withEndAt(g.where, g.arrow, g.grip, p, tied?.end, g.boxOf), ...(tied ? { tie: tied.box } : {}) };
}

/** Draw the arrow as the hand has it now: in the `moving` store, and the thing its end would tie to outlined. */
function show(press: Press, board: BoardCtx, g: ArrowGrip): void {
  const { change, tie } = changeNow(press, board, g);
  g.now = change;
  board.hand.highlight.show(tie);
  const id = g.arrow.id;
  board.moving.set({ moved: new Set(), dx: 0, dy: 0, stored: new Map([[id, change.item.box]]), redraw: g.redraw, where: g.where, guides: [], drawnAs: new Map([[id, change.item]]), grip: g.grip });
}

/** The pointer moved: the first time, the press becomes a drag, measures what an end can tie to, and follows the camera and the keys. */
export function moveGrip(press: Press, board: BoardCtx, g: ArrowGrip): void {
  if (!g.rects) {
    board.capture(press.pointer);
    g.rects = g.grip === 'label' ? [] : board.measure();
    g.boxOf = keptBoxes(board.targetBox);
    const again = () => show(press, board, g);
    // A wheel in the middle of the drag moves the world under the pointer: what the hand holds goes with the pointer, not with the world.
    const offCamera = board.camera.onMove(again);
    const offKeys = followKeys(press, again);
    g.off = () => {
      offCamera();
      offKeys();
    };
  }
  show(press, board, g);
}

/** Put back what the drag drew: the arrow as the board has it, and no outline. */
function letDown(board: BoardCtx, g: ArrowGrip): void {
  g.off();
  board.hand.highlight.show(undefined);
  board.moving.set(null);
}

/** Is an arrow drawn between these ends too short on the screen to be meant, as one drawn that short is? */
const tooShort = ([a, b]: Ends, zoom: number): boolean => Math.hypot(b[0] - a[0], b[1] - a[1]) * zoom < MIN_ARROW;

/**
 * The pointer lifted: one change of the arrow, as it was drawn, and the arrow stays drawn so
 * until the board has answered. A press that never became a drag changes nothing, nor does a
 * drag that ends where it began, an end dragged until the arrow is too short to be meant, or an
 * arrow taken off the board meanwhile: nothing is posted, and Undo gets no step.
 */
export function dropGrip(press: Press, board: BoardCtx, g: ArrowGrip): void {
  if (!g.rects) return;
  show(press, board, g);
  const change = g.now;
  const id = g.arrow.id;
  const drawn = board.moving.drawn(id)?.ends;
  letDown(board, g);
  board.dragEnded();
  const s = board.state().items[id];
  if (!change || !s || s.removed || changesNothing(g.arrow, change.patch)) return;
  if (g.grip !== 'label' && drawn && tooShort(drawn, board.camera.get().z)) return;
  const arrow = change.item;
  board.setPendingArrow(id, arrow);
  void board.send({ type: 'item.update', item: id, patch: change.patch }).then(() => board.setPendingArrow(id, undefined, arrow));
}

/** The press ended some other way: the arrow is drawn as it was, and nothing is posted. */
export function cancelGrip(board: BoardCtx, g: ArrowGrip): void {
  if (g.rects) letDown(board, g);
}
