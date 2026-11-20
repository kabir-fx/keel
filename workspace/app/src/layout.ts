import type { Anchor, ArrowItem, ArrowTie, BoardState, Box, Id, LassoItem, Target } from '@keel/protocol';
import { shownBox } from './anchor';
import type { EndAim } from './binding';
import { drawnEnds, spotIn } from './binding';
import type { XY } from './geometry';
import { padBox } from './geometry';
import type { Loop } from './outline';
import { bridged, loopsBox, unionOutline } from './outline';

/**
 * Where every item is drawn. One pure function, so drawing, placement and lineage all agree.
 *
 * - A picture is drawn at its box.
 * - A mark is drawn at its box, moved (and for ink, lassos, boxes and arrows, scaled) so that
 *   its anchor's `box` lands on where the anchored thing is drawn now. The thing can be a
 *   picture, a sub inside one, or another mark (a note stuck on a lasso).
 * - A lasso is drawn as a tidy outline round where its targets are now, so its box is the box
 *   of that outline. With no target left on the board, it keeps its own box.
 * - A sub is where the DOM says it is. A sub inside a picture placed in this same pass is found
 *   from its offset in the picture, measured before the picture had a place.
 * - A sub the picture does not draw (its renderer is not built yet) falls back to the anchor's
 *   own box moved to the picture's corner, so the mark stays near its picture at its own size.
 */
export interface Where {
  state: BoardState;
  /** Boxes the app knows ahead of the log: posted and not back yet, or placed just now. */
  boxes: { get(id: Id): Box | undefined };
  /** Where each sub is now, in world units, keyed `item/sub`. */
  subs: { get(key: string): Box | undefined };
  /** Where each sub sits inside a picture that was just measured, from its top-left. */
  subOffsets?: { get(key: string): Box | undefined };
}

/** Room a lasso's outline keeps round each of its targets. */
export const LASSO_PAD = 14;
/** Anchors chain (a note on a lasso round a picture); a longer chain than this is cut. */
const MAX_DEPTH = 6;

/**
 * The board with each of these arrows as given, in place of the log's: an arrow the page has
 * ahead of the log, or one the hand is changing. Only the arrow itself is put in: one taken off
 * the board meanwhile stays off, and one the board does not have is not added.
 */
export function withArrowsAhead(state: BoardState, arrows: ReadonlyMap<Id, ArrowItem>): BoardState {
  let items: BoardState['items'] | undefined;
  for (const [id, arrow] of arrows) {
    const s = state.items[id];
    if (!s) continue;
    items ??= { ...state.items };
    items[id] = { ...s, item: arrow };
  }
  return items ? { ...state, items } : state;
}

/**
 * An arrow as the page has it: at the box of a move of it that is posted and not back yet. A
 * move changes an arrow's box alone, so this is the arrow the log will have once the move is in.
 */
export function arrowAsStored(w: Where, arrow: ArrowItem): ArrowItem {
  const box = w.boxes.get(arrow.id);
  return box ? { ...arrow, box } : arrow;
}

/** An item's own box: what the app knows ahead of the log, else the log. Removed items have none. */
export function storedBox(w: Where, id: Id): Box | undefined {
  const s = w.state.items[id];
  if (!s || s.removed) return undefined;
  return w.boxes.get(id) ?? s.item.box;
}

/** Where the thing an anchor names is now. */
export function anchorBox(w: Where, a: Anchor, depth = 0): Box | undefined {
  if (depth > MAX_DEPTH) return undefined;
  const s = w.state.items[a.item];
  if (!s || s.removed) return undefined;
  if (!a.sub) return s.item.kind === 'picture' ? storedBox(w, a.item) : shownBoxOf(w, a.item, depth + 1);
  const base = storedBox(w, a.item);
  if (!base) return undefined;
  const key = `${a.item}/${a.sub}`;
  const off = w.subOffsets?.get(key);
  if (off && w.boxes.get(a.item)) return [base[0] + off[0], base[1] + off[1], off[2], off[3]];
  return w.subs.get(key) ?? [base[0], base[1], a.box[2], a.box[3]];
}

/** Where each target of a lasso is now. A target sub that is not drawn stands for its item. */
export function lassoTargetBoxes(w: Where, lasso: LassoItem, depth = 0): Box[] {
  const out: Box[] = [];
  for (const t of lasso.targets) {
    if (t.item === lasso.id) continue;
    const s = w.state.items[t.item];
    if (!s || s.removed) continue;
    const sub = t.sub ? w.subs.get(`${t.item}/${t.sub}`) : undefined;
    const b = sub ?? shownBoxOf(w, t.item, depth + 1);
    if (b) out.push(b);
  }
  return out;
}

/**
 * The tidy outline of a lasso, round where its targets are now: one shape, joined by bands where
 * its targets do not touch. Empty when none is left.
 */
export function lassoOutline(w: Where, lasso: LassoItem, depth = 0): Loop[] {
  return unionOutline(bridged(lassoTargetBoxes(w, lasso, depth).map((b) => padBox(b, LASSO_PAD)), 4 * LASSO_PAD));
}

/** Where an item is drawn now, or undefined when it is not drawn. */
export function shownBoxOf(w: Where, id: Id, depth = 0): Box | undefined {
  if (depth > MAX_DEPTH) return undefined;
  const s = w.state.items[id];
  if (!s || s.removed) return undefined;
  const own = w.boxes.get(id) ?? s.item.box;
  if (!own) return undefined;
  const it = s.item;
  if (it.kind === 'picture') return own;
  if (it.kind === 'lasso') {
    const b = loopsBox(lassoOutline(w, it, depth));
    if (b) return b;
  }
  return shownBox({ kind: it.kind, box: own, anchor: it.anchor }, (a) => anchorBox(w, a, depth + 1));
}

/* ------------------------------------------------------- inside a mark */

/**
 * The scale a mark is drawn at, axis by axis: where it is drawn now over its own box. A box
 * with no width (a level line) keeps that axis at 1.
 */
export function markScale(box: Box, shown: Box): [number, number] {
  return [box[2] > 0 && shown[2] > 0 ? shown[2] / box[2] : 1, box[3] > 0 && shown[3] > 0 ? shown[3] / box[3] : 1];
}

/** A point inside a mark, counted from the top-left corner of its box, where it is drawn now. */
export function pointOn(p: XY, box: Box, shown: Box): [number, number] {
  const [sx, sy] = markScale(box, shown);
  return [shown[0] + p[0] * sx, shown[1] + p[1] * sy];
}

/** Where a target is drawn now: an item, or one thing inside it as last measured. */
export function targetBoxNow(w: Where, t: Target): Box | undefined {
  const s = w.state.items[t.item];
  if (!s || s.removed) return undefined;
  return t.sub ? w.subs.get(`${t.item}/${t.sub}`) : shownBoxOf(w, t.item);
}

/** The point of a box nearest to `p`: `p` itself when it is inside. */
export function clampInto(p: XY, b: Box): [number, number] {
  return [Math.min(b[0] + b[2], Math.max(b[0], p[0])), Math.min(b[1] + b[3], Math.max(b[1], p[1]))];
}

/**
 * How one end of an arrow is aimed now. A tied end holds its spot on where its target is now. An
 * end with a target and no tie (every arrow from before ties) is drawn into its target from
 * where the arrow's box puts it, as it always was. An end whose target is gone, or that has
 * none, is where the arrow's box puts it (`p`).
 */
function endAim(w: Where, target: Target | undefined, tie: ArrowTie | undefined, p: [number, number]): EndAim {
  const box = target ? targetBoxNow(w, target) : undefined;
  if (!box) return { spot: p };
  if (!tie) return { spot: clampInto(p, box) };
  return { spot: spotIn(tie.at, box), tie: { box, mode: tie.mode } };
}

/** How an arrow's two ends are aimed now, from where both its targets are now: its tail, then its head. */
export function arrowAims(w: Where, it: ArrowItem, shown: Box): [EndAim, EndAim] {
  return [endAim(w, it.fromTarget, it.fromTie, pointOn(it.from, it.box, shown)), endAim(w, it.toTarget, it.toTie, pointOn(it.to, it.box, shown))];
}

/**
 * Where an arrow's two ends are drawn now, worked out from where both its targets are now
 * (`drawnEnds`), so it stays on what it points at when either thing moves.
 */
export function arrowEnds(w: Where, it: ArrowItem, shown: Box): [[number, number], [number, number]] {
  return drawnEnds(...arrowAims(w, it, shown));
}
