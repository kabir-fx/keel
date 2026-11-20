import type { BoardState, Box, Id, PictureItem, PictureKind, Place } from '@keel/protocol';
import { isMark, targetsOf } from '@keel/protocol';
import { overlaps, padBox } from './geometry';

/**
 * Placement: where a picture goes when the agent posts it with no box. Pure, so the same log
 * and the same measured sizes always give the same layout.
 *
 * - A small picture (a text card, a mini, a choice) goes to the nearest clear spot round its
 *   anchor: right, below, left and above it, the side `place.side` names first, at growing
 *   distances. Its anchor is `place.near`, else the first mark it answers, else its first
 *   `from`, else the chapter's last placed item. A mark counts where it is drawn now: a note
 *   stuck on a part of a picture is where that part is, not where the note was first made.
 * - A wide picture with something it belongs to goes beside it too, at the nearest clear spot:
 *   the side `place.side` names first, else below it first. What it belongs to is `place.near`,
 *   else the first `from`, else what the first mark it answers points at, else that mark.
 * - Only a wide picture that belongs to nothing on the board (it answers an act, such as a
 *   solidify) goes below the lowest item of the chapter, left-aligned with its first item.
 * - Nothing overlaps. A picture with no clear spot within `REACH` slides down in steps from
 *   beside its anchor until it is clear of every other item.
 */

export const SMALL_KINDS: readonly PictureKind[] = ['text', 'mini', 'choice'];
export const GAP_RIGHT = 48;
export const GAP_BELOW = 64;
export const STEP = 24;
/** Room kept clear round every item, so two items never touch. */
export const CLEAR = 16;
/** How much further out than the gap a small picture looks for a clear spot round its anchor. */
export const REACH = 1200;

export type Size = readonly [w: number, h: number];
export type Side = NonNullable<Place['side']>;
/** The order a small picture tries the sides of its anchor in. */
export const SIDES: readonly Side[] = ['right', 'below', 'left', 'above'];

/** Where each item is drawn now, or undefined for one with no box or not drawn. */
export type BoxOf = (id: Id) => Box | undefined;

export function isSmall(kind: PictureKind): boolean {
  return SMALL_KINDS.includes(kind);
}

/**
 * The item a picture is placed against, if there is one. With `fallback` (the default), a
 * picture that belongs to nothing is placed against the chapter's last placed item.
 */
export function anchorOf(state: BoardState, id: Id, boxOf: BoxOf, fallback = true): Id | undefined {
  const s = state.items[id];
  if (!s || s.item.kind !== 'picture') return undefined;
  const item = s.item;
  const has = (x: Id | undefined): x is Id => x !== undefined && x !== id && boxOf(x) !== undefined;

  const near = item.place?.near;
  if (has(near)) return near;
  if (isSmall(item.picture.kind)) {
    // A reply sits by the mark it answers, wherever that mark is drawn now.
    const mark = answeredMarks(state, item).find(has);
    if (mark) return mark;
  }
  const from = item.from?.[0];
  if (has(from)) return from;

  const mark = answeredMarks(state, item)[0];
  if (mark) {
    const t = targetsOf(state.items[mark]!.item)[0]?.item;
    if (has(t)) return t;
    if (has(mark)) return mark;
  }
  return fallback ? lastPlacedInChapter(state, s.chapter, id, boxOf) : undefined;
}

/** The owner's marks a picture answers, in the order it names them. */
function answeredMarks(state: BoardState, item: PictureItem): Id[] {
  return (item.answers ?? []).filter((a) => {
    const m = state.items[a];
    return !!m && m.by === 'owner' && isMark(m.item);
  });
}

function lastPlacedInChapter(state: BoardState, chapter: Id, except: Id, boxOf: BoxOf): Id | undefined {
  for (let i = state.itemOrder.length - 1; i >= 0; i--) {
    const x = state.itemOrder[i]!;
    if (x !== except && state.items[x]?.chapter === chapter && boxOf(x)) return x;
  }
  return undefined;
}

/** The placed items of a chapter, in the order they were added. */
function chapterBoxes(state: BoardState, chapter: Id, except: Id, boxOf: BoxOf): Box[] {
  const out: Box[] = [];
  for (const x of state.itemOrder) {
    if (x === except || state.items[x]?.chapter !== chapter) continue;
    const b = boxOf(x);
    if (b) out.push(b);
  }
  return out;
}

/**
 * A box of `size` on one side of `a`: `gap` away, and `d` further out. Beside it, the two top
 * edges line up; above or below it, the two left edges.
 */
export function beside(a: Box, side: Side, size: Size, gap: number, d = 0): Box {
  const [w, h] = size;
  switch (side) {
    case 'right':
      return [a[0] + a[2] + gap + d, a[1], w, h];
    case 'left':
      return [a[0] - gap - d - w, a[1], w, h];
    case 'below':
      return [a[0], a[1] + a[3] + gap + d, w, h];
    case 'above':
      return [a[0], a[1] - gap - d - h, w, h];
  }
}

/** The sides to try, the one asked for first. */
export function sidesFrom(first?: Side): Side[] {
  return first ? [first, ...SIDES.filter((s) => s !== first)] : [...SIDES];
}

/** True when `box`, with the room kept round it, touches none of `others`. */
export function isClear(box: Box, others: readonly Box[]): boolean {
  const padded = padBox(box, CLEAR);
  return !others.some((o) => overlaps(padded, o));
}

/**
 * The nearest clear spot round `a` for a box of `size`: every side in `sides` at the gap, then
 * every side a step further out, and so on. The first spot that is clear of `others` wins.
 * Undefined when nothing within `REACH` is clear.
 */
export function nearestClear(a: Box, size: Size, others: readonly Box[], sides: readonly Side[] = SIDES, gap = GAP_RIGHT): Box | undefined {
  const s: Size = [round(size[0]), round(size[1])];
  for (let d = 0; d <= REACH; d += STEP) {
    for (const side of sides) {
      const b = beside(a, side, s, gap, d);
      const spot: Box = [round(b[0]), round(b[1]), b[2], b[3]];
      if (isClear(spot, others)) return spot;
    }
  }
  return undefined;
}

/** The first spot a picture of `size` tries, before it slides clear of the others. */
export function firstSpot(state: BoardState, id: Id, size: Size, boxOf: BoxOf): [number, number] {
  const s = state.items[id];
  if (!s || s.item.kind !== 'picture') return [0, 0];
  const item = s.item;
  const small = isSmall(item.picture.kind);
  const anchorId = anchorOf(state, id, boxOf);
  const a = anchorId ? boxOf(anchorId) : undefined;

  const side = item.place?.side;
  if (a && side) {
    const b = beside(a, side, size, small ? GAP_RIGHT : GAP_BELOW);
    return [b[0], b[1]];
  }

  if (small) return a ? [a[0] + a[2] + GAP_RIGHT, a[1]] : [0, 0];

  const own = chapterBoxes(state, s.chapter, id, boxOf);
  if (own.length > 0) {
    const lowest = Math.max(...own.map((b) => b[1] + b[3]));
    return [own[0]![0], lowest + GAP_BELOW];
  }
  return a ? [a[0], a[1] + a[3] + GAP_BELOW] : [0, 0];
}

/** Slide a box down in steps until it is clear of every box in `others`. */
export function slideClear(box: Box, others: readonly Box[]): Box {
  let [x, y] = box;
  const [, , w, h] = box;
  for (let i = 0; i < 4000; i++) {
    const b: Box = [x, y, w, h];
    if (isClear(b, others)) return b;
    y += STEP;
  }
  return [x, y, w, h];
}

/** The box for one picture of the measured `size`. */
export function place(state: BoardState, id: Id, size: Size, boxOf: BoxOf): Box {
  const others: Box[] = [];
  for (const other of state.itemOrder) {
    if (other === id) continue;
    const b = boxOf(other);
    if (b) others.push(b);
  }
  const s = state.items[id];
  if (s?.item.kind === 'picture') {
    const small = isSmall(s.item.picture.kind);
    // A small picture always has somewhere to sit; a wide one only when it belongs to something.
    const anchor = anchorOf(state, id, boxOf, small);
    const a = anchor ? boxOf(anchor) : undefined;
    if (a) {
      const side = s.item.place?.side;
      const gap = small ? GAP_RIGHT : GAP_BELOW;
      const spot = nearestClear(a, size, others, sidesFrom(side ?? (small ? undefined : 'below')), gap);
      if (spot) return spot;
      const b = beside(a, side ?? (small ? 'right' : 'below'), size, gap);
      return slideClear([round(b[0]), round(b[1]), round(size[0]), round(size[1])], others);
    }
  }
  const [x, y] = firstSpot(state, id, size, boxOf);
  return slideClear([round(x), round(y), round(size[0]), round(size[1])], others);
}

/** The live pictures that wait for a box, in the order they were added. */
export function unplaced(state: BoardState, boxOf: BoxOf = (id) => state.items[id]?.item.box): Id[] {
  const out: Id[] = [];
  for (const id of state.itemOrder) {
    const s = state.items[id];
    if (s && !s.removed && s.item.kind === 'picture' && !boxOf(id)) out.push(id);
  }
  return out;
}

/**
 * Place every picture that waits for a box, in log order, each one seeing the ones before it.
 * `boxOfWith(placed)` says where items are drawn once the pictures in `placed` have their boxes,
 * so a mark anchored to a picture placed a moment ago is seen where it will be drawn.
 * It stops at the first picture whose size is not measured yet, so a later picture never takes
 * the spot of an earlier one.
 */
export function placeAll(
  state: BoardState,
  sizes: ReadonlyMap<Id, Size>,
  boxOfWith: (placed: ReadonlyMap<Id, Box>) => BoxOf,
): Map<Id, Box> {
  const placed = new Map<Id, Box>();
  const seen = boxOfWith(placed);
  // The list is taken once, before anything is placed; `seen` then grows with each picture.
  for (const id of unplaced(state, seen)) {
    const size = sizes.get(id);
    if (!size) break;
    placed.set(id, place(state, id, size, seen));
  }
  return placed;
}

const round = (n: number) => Math.round(n);
