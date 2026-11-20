import type { Anchor, ArrowEnd, ArrowItem, BoardState, Box, Id, ItemPatch, Target } from '@keel/protocol';
import { withAnchor, withArrowEnd } from '@keel/protocol';
import { unplaceFromAnchor } from '../anchor';
import { LABEL_MIDDLE } from '../arrowhead';
import type { TargetBoxNow, TiedEnd } from '../binding';
import type { Ends } from '../board/shown';
import type { XY } from '../geometry';
import { ARROW_LET_GO } from '../input/constants';
import type { Where } from '../layout';
import { anchorBox, arrowEnds, pointOn, shownBoxOf, targetBoxNow } from '../layout';
import { arrowHangsOn, boxFromDrag, roundBox } from '../marks';

/**
 * Changing an arrow by hand, as plain rules on the board's state: an end put somewhere else and
 * tied again, and an arrow moved whole that lets go of what it pointed at. Each gives the arrow
 * to draw while the pointer is down and the one change that posts it, and the change is applied
 * to the arrow just as the board applies it, so what is drawn is what lands.
 *
 * An arrow hangs on the thing it points at, else on the thing it starts from (`arrowHangsOn`),
 * and goes where that thing goes. So an end that takes hold of another thing, or lets go, can
 * hang the arrow on another thing, or on none: the change then says so, and counts the arrow's
 * box and both its ends from there.
 *
 * That an arrow moved whole lets go of what stays behind, and only once it has gone
 * `ARROW_LET_GO` when it is moved by itself, is Excalidraw's rule
 * (packages/element/src/dragElements.ts, commit 9fbeaed).
 */

/** One end of an arrow. */
export type Which = 'from' | 'to';

/** An arrow as the hand has changed it: what to draw, and what to post. */
export interface ArrowChange {
  item: ArrowItem;
  patch: ItemPatch;
}

const ENDS: readonly Which[] = ['from', 'to'];
const keyOf = (w: Which) => (w === 'from' ? 'arrowFrom' : 'arrowTo');
const r1 = (n: number) => Math.round(n * 10) / 10;
const sameNumbers = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((n, i) => n === b[i]);
const sameThing = (a: Target | undefined, b: Target | undefined) => a?.item === b?.item && a?.sub === b?.sub;

/** One end of an arrow as it is, in the shape a change sets it again. */
function endNow(arrow: ArrowItem, which: Which): ArrowEnd {
  const target = which === 'from' ? arrow.fromTarget : arrow.toTarget;
  const tie = which === 'from' ? arrow.fromTie : arrow.toTie;
  return { at: arrow[which], ...(target ? { target } : {}), ...(tie ? { tie } : {}) };
}

/** What an end holds on to: its target and its tie, without its point. */
type Holds = Omit<ArrowEnd, 'at'>;

const holdsOf = (end: ArrowEnd): Holds => ({ ...(end.target ? { target: end.target } : {}), ...(end.tie ? { tie: end.tie } : {}) });

/* ------------------------------------------------------------ what an arrow is counted from */

/**
 * What an arrow's box and ends are counted from: its anchor, and where the anchor's thing is
 * drawn now. With no anchor, or a thing that is gone, they are counted on the board itself.
 */
interface Frame {
  anchor: Anchor | undefined;
  now: Box | undefined;
}

/** A world point as a frame counts it, to a tenth of a unit. */
function counted(p: XY, frame: Frame): [number, number] {
  const [x, y] = frame.anchor && frame.now ? unplaceFromAnchor([p[0], p[1], 0, 0], frame.anchor.box, frame.now, 'scale') : p;
  return [r1(x), r1(y)];
}

/** What the arrow is counted from as it is. */
const ownFrame = (where: Where, arrow: ArrowItem): Frame => ({ anchor: arrow.anchor, now: arrow.anchor && anchorBox(where, arrow.anchor) });

/**
 * What an arrow whose ends hold `holds` is counted from, when that is no longer what it has: the
 * thing it hangs on now (`arrowHangsOn`), where `boxOf` says that thing is drawn, or the board
 * itself when it hangs on nothing. A thing that is not drawn (it has been taken off the board)
 * holds nothing up: the arrow hangs on what its other end holds. Nothing when it hangs on what
 * it hung on.
 */
function hungAnew(arrow: ArrowItem, holds: Readonly<Record<Which, Holds>>, boxOf: TargetBoxNow): Frame | undefined {
  const drawn = (t: Target | undefined) => (t && boxOf(t) ? t : undefined);
  const on = arrowHangsOn(drawn(holds.from.target), drawn(holds.to.target));
  const now = on && boxOf(on);
  const anchor: Anchor | undefined = on && now ? { ...on, box: roundBox(now) } : undefined;
  return sameThing(anchor, arrow.anchor) ? undefined : { anchor, now };
}

/** An arrow end's own point, as its own frame counts it. */
const ownPoint = (arrow: ArrowItem, which: Which): [number, number] => [r1(arrow.box[0] + arrow[which][0]), r1(arrow.box[1] + arrow[which][1])];

/** The arrow as the board has it once it has taken `patch`, in the board's own order: the box, then each end, the label, and what it hangs on. */
export function applied(arrow: ArrowItem, patch: ItemPatch): ArrowItem {
  let item: ArrowItem = patch.box ? { ...arrow, box: patch.box } : arrow;
  if (patch.arrowFrom) item = withArrowEnd(item, 'from', patch.arrowFrom);
  if (patch.arrowTo) item = withArrowEnd(item, 'to', patch.arrowTo);
  if (patch.labelAt !== undefined) item = { ...item, labelAt: patch.labelAt };
  if (patch.anchor !== undefined) item = withAnchor(item, patch.anchor);
  return item;
}

/** Do two ends say the same: the same point, the same thing, the same spot on it? */
function sameEnd(a: ArrowEnd, b: ArrowEnd): boolean {
  const sameTie = a.tie === b.tie || (!!a.tie && !!b.tie && a.tie.mode === b.tie.mode && sameNumbers(a.tie.at, b.tie.at));
  return sameNumbers(a.at, b.at) && sameThing(a.target, b.target) && sameTie;
}

/** Does a change leave the arrow as it was? Then nothing is posted, and Undo gets no step. */
export function changesNothing(arrow: ArrowItem, patch: ItemPatch): boolean {
  if (patch.box && !sameNumbers(patch.box, arrow.box)) return false;
  if (patch.labelAt !== undefined && patch.labelAt !== (arrow.labelAt ?? LABEL_MIDDLE)) return false;
  // A change names an anchor only when the arrow hangs on another thing than before, or on none.
  if (patch.anchor !== undefined) return false;
  return ENDS.every((w) => {
    const end = patch[keyOf(w)];
    return !end || sameEnd(end, endNow(arrow, w));
  });
}

/**
 * Both ends of an arrow at points as its frame counts them, each holding on to what it holds:
 * the box round them, on tenths of a unit, and each end counted from it.
 */
function placedAt(from: readonly [number, number], to: readonly [number, number], holds: Readonly<Record<Which, Holds>>): { box: Box } & Record<Which, ArrowEnd> {
  const box = roundBox(boxFromDrag(from, to));
  const at = (p: readonly [number, number]): [number, number] => [r1(p[0] - box[0]), r1(p[1] - box[1])];
  return { box, from: { ...holds.from, at: at(from) }, to: { ...holds.to, at: at(to) } };
}

/**
 * The arrow with one end put at world point `p`, holding on to `tied`, or to nothing. An end
 * that still holds the same spot of the same thing keeps its own point: it is drawn from its
 * tie, so where the pointer let go of it shows nowhere, and a drag back to where it began
 * changes nothing. The other end stays where it is. When the box round the two ends changes,
 * the other end is set again in the same change, counted from the new box, so it does not move.
 * When the arrow hangs on another thing for it (`hungAnew`, with `boxOf` for where things are
 * drawn), the change says so and sets the box and both ends, counted from there.
 */
export function withEndAt(where: Where, arrow: ArrowItem, which: Which, p: XY, tied: TiedEnd | undefined, boxOf: TargetBoxNow): ArrowChange {
  const other: Which = which === 'from' ? 'to' : 'from';
  const holds: Record<Which, Holds> = { from: holdsOf(endNow(arrow, 'from')), to: holdsOf(endNow(arrow, 'to')) };
  const was = endNow(arrow, which);
  holds[which] = tied ? { target: tied.target, tie: tied.tie } : {};
  const moved = !tied || !sameEnd({ ...holds[which], at: was.at }, was);
  const anew = hungAnew(arrow, holds, boxOf);
  if (anew) {
    const shown = shownBoxOf(where, arrow.id) ?? arrow.box;
    const drawn = (w: Which): XY => (w === which && moved ? p : pointOn(arrow[w], arrow.box, shown));
    const set = placedAt(counted(drawn('from'), anew), counted(drawn('to'), anew), holds);
    const patch: ItemPatch = { box: set.box, arrowFrom: set.from, arrowTo: set.to, anchor: anew.anchor ?? null };
    return { item: applied(arrow, patch), patch };
  }
  const points: Record<Which, [number, number]> = { from: ownPoint(arrow, 'from'), to: ownPoint(arrow, 'to') };
  if (moved) points[which] = counted(p, ownFrame(where, arrow));
  const set = placedAt(points.from, points.to, holds);
  const patch: ItemPatch = { [keyOf(which)]: set[which] };
  if (!sameNumbers(set.box, arrow.box)) {
    patch.box = set.box;
    patch[keyOf(other)] = set[other];
  }
  return { item: applied(arrow, patch), patch };
}

/* ------------------------------------------------------------ moved whole */

/** Does a move this far (world units, at `zoom`) leave a lone tied arrow where it is, still tied? */
export const holdsStill = (dx: number, dy: number, zoom: number): boolean => Math.max(Math.abs(dx), Math.abs(dy)) * zoom <= ARROW_LET_GO;

/**
 * The ends of an arrow that hold a thing a move of `moving` leaves behind: a thing on the board
 * that does not move. An end whose thing has been taken off the board is left behind by nothing:
 * it is drawn free, and keeps its hold for when the thing is put back.
 */
export function leftBehind(state: BoardState, arrow: ArrowItem, moving: ReadonlySet<Id>): Which[] {
  return ENDS.filter((w) => {
    const t = w === 'from' ? arrow.fromTarget : arrow.toTarget;
    const s = t && state.items[t.item];
    return !!s && !s.removed && !moving.has(s.item.id);
  });
}

/**
 * The arrow moved whole by `dx`, `dy` with `moving`, letting go of what the ends in `free` held.
 * Those ends go on from where they were drawn (`ends`), so nothing jumps as it lets go; an end
 * still tied keeps its hold. The arrow hangs on what it still holds, or on nothing (`hungAnew`).
 * Hung on a thing that moves too, that thing takes the arrow along, so its own points are counted
 * where they were; else they are counted moved. The change sets the box and both ends.
 */
export function letGo(where: Where, arrow: ArrowItem, ends: Ends, free: readonly Which[], dx: number, dy: number, moving: ReadonlySet<Id>): ArrowChange {
  const shown = shownBoxOf(where, arrow.id) ?? arrow.box;
  const held = (w: Which): Holds => (free.includes(w) ? {} : holdsOf(endNow(arrow, w)));
  const holds = { from: held('from'), to: held('to') };
  const anew = hungAnew(arrow, holds, (t) => targetBoxNow(where, t));
  const frame = anew ?? ownFrame(where, arrow);
  const carried = !!frame.anchor && moving.has(frame.anchor.item);
  const [mx, my] = carried ? [0, 0] : [dx, dy];
  const point = (w: Which, i: 0 | 1): [number, number] => {
    const at = free.includes(w) ? ends[i] : pointOn(arrow[w], arrow.box, shown);
    return counted([at[0] + mx, at[1] + my], frame);
  };
  const set = placedAt(point('from', 0), point('to', 1), holds);
  const patch: ItemPatch = { box: set.box, arrowFrom: set.from, arrowTo: set.to, ...(anew ? { anchor: anew.anchor ?? null } : {}) };
  return { item: applied(arrow, patch), patch };
}

/** What a move does to the arrows it moves whole. */
export interface LetGo {
  /**
   * True while a lone tied arrow has not yet gone far enough to let go (`dx`, `dy` in world
   * units): it stays where it is. Once it has gone that far it has let go for the rest of the
   * move, wherever it is brought back to.
   */
  holds(dx: number, dy: number, zoom: number): boolean;
  /** The arrows that let go, as they are drawn moved by `dx`, `dy`, and the change that posts each. */
  changes(dx: number, dy: number): ReadonlyMap<Id, ArrowChange>;
}

/**
 * What a move does to the arrows among the things grabbed (`moving` is everything the move
 * takes): each end on a thing the move leaves behind lets go, whether the arrow moves itself or
 * hangs on a thing grabbed with it, so the same two things selected always do the same. An
 * arrow grabbed by itself lets go only once it has gone `ARROW_LET_GO`, so a click to select it
 * never does; one grabbed with other things does so at once.
 */
export function lettingGo(where: Where, grabbed: readonly Id[], moving: ReadonlySet<Id>): LetGo {
  const arrows: Array<{ arrow: ArrowItem; ends: Ends; free: Which[] }> = [];
  for (const id of grabbed) {
    const s = where.state.items[id];
    const shown = shownBoxOf(where, id);
    if (!s || s.item.kind !== 'arrow' || !shown) continue;
    const free = leftBehind(where.state, s.item, moving);
    if (free.length > 0) arrows.push({ arrow: s.item, ends: arrowEnds(where, s.item, shown), free });
  }
  /** A lone tied arrow holds on until it has once gone far enough. */
  let holding = grabbed.length === 1 && arrows.length === 1;
  return {
    holds: (dx, dy, zoom) => (holding &&= holdsStill(dx, dy, zoom)),
    changes: (dx, dy) => {
      const out = new Map<Id, ArrowChange>();
      if (dx === 0 && dy === 0) return out;
      for (const a of arrows) out.set(a.arrow.id, letGo(where, a.arrow, a.ends, a.free, dx, dy, moving));
      return out;
    },
  };
}
