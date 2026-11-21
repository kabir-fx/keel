import type { BoardState, Box, Id, PictureItem, PictureKind, Place, Point } from '@keel/protocol';
import { isMark, targetsOf } from '@keel/protocol';
import { overlaps, padBox } from './geometry';

/**
 * Placement: where a picture goes when the agent posts it with no box. Pure, so the same log
 * and the same measured sizes always give the same layout.
 *
 * Each picture has one lane beside its anchor: one start spot and one direction it slides in
 * when that spot is taken, so the owner can tell where the next picture will land.
 *
 * - A small picture (a text card, a mini, a choice) starts right of its anchor, top edges
 *   level, and slides down that column. Its anchor is `place.near`, else the first mark it
 *   answers, else its first `from`, else the chapter's last placed item. A mark counts where it
 *   is drawn now: a note stuck on a part of a picture is where that part is, not where the note
 *   was first made.
 * - A wide picture with something it belongs to starts below it, left edges level, and slides
 *   down. What it belongs to is `place.near`, else the first `from`, else what the first mark
 *   it answers points at, else that mark.
 * - `place.side` names another lane: right, left and below slide down, above slides up.
 * - A picture with nothing to be placed against starts at `firstSpot` and slides down: a wide
 *   picture that belongs to nothing on the board (it answers an act, such as a solidify) goes
 *   below the lowest item of the chapter, left-aligned with its first item.
 * - The lanes place a picture the first time only. A finished placeholder keeps the top left
 *   corner it stood at, and slides from there in its lane's direction: a `place` the agent's
 *   finishing update carries does not move it.
 * - Nothing overlaps.
 */

export const SMALL_KINDS: readonly PictureKind[] = ['text', 'mini', 'choice'];
export const GAP_RIGHT = 48;
export const GAP_BELOW = 64;
export const STEP = 24;
/** Room kept clear round every item, so two items never touch. */
export const CLEAR = 16;

export type Size = readonly [w: number, h: number];
export type Side = NonNullable<Place['side']>;

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
 * A box of `size` on one side of `a`, `gap` away. Beside it, the two top edges line up; above or
 * below it, the two left edges.
 */
function beside(a: Box, side: Side, size: Size, gap: number): Box {
  const [w, h] = size;
  switch (side) {
    case 'right':
      return [a[0] + a[2] + gap, a[1], w, h];
    case 'left':
      return [a[0] - gap - w, a[1], w, h];
    case 'below':
      return [a[0], a[1] + a[3] + gap, w, h];
    case 'above':
      return [a[0], a[1] - gap - h, w, h];
  }
}

/** True when `box`, with the room kept round it, touches none of `others`. */
export function isClear(box: Box, others: readonly Box[]): boolean {
  const padded = padBox(box, CLEAR);
  return !others.some((o) => overlaps(padded, o));
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

/** Slide a box in steps of `dy` until it is clear of every box in `others`. */
export function slideClear(box: Box, others: readonly Box[], dy = STEP): Box {
  let [x, y] = box;
  const [, , w, h] = box;
  for (let i = 0; i < 4000; i++) {
    const b: Box = [x, y, w, h];
    if (isClear(b, others)) return b;
    y += dy;
  }
  return [x, y, w, h];
}

/** The box for one picture of the measured `size`. `stood` is the top left corner it stood at as a placeholder, when it stood somewhere. */
export function place(state: BoardState, id: Id, size: Size, boxOf: BoxOf, stood?: Point): Box {
  const others: Box[] = [];
  for (const other of state.itemOrder) {
    if (other === id) continue;
    const b = boxOf(other);
    if (b) others.push(b);
  }
  const s = state.items[id];
  // Every lane slides down but the one above, which slides up.
  const dy = s?.item.kind === 'picture' && s.item.place?.side === 'above' ? -STEP : STEP;
  if (stood) return slideClear([round(stood[0]), round(stood[1]), round(size[0]), round(size[1])], others, dy);
  if (s?.item.kind === 'picture') {
    const small = isSmall(s.item.picture.kind);
    // A small picture always has somewhere to sit; a wide one only when it belongs to something.
    const anchor = anchorOf(state, id, boxOf, small);
    const a = anchor ? boxOf(anchor) : undefined;
    if (a) {
      const b = beside(a, s.item.place?.side ?? (small ? 'right' : 'below'), size, small ? GAP_RIGHT : GAP_BELOW);
      return slideClear([round(b[0]), round(b[1]), round(size[0]), round(size[1])], others, dy);
    }
  }
  const [x, y] = firstSpot(state, id, size, boxOf);
  return slideClear([round(x), round(y), round(size[0]), round(size[1])], others, dy);
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
 * the spot of an earlier one. `stood` holds the corner each finished placeholder stood at.
 */
export function placeAll(
  state: BoardState,
  sizes: ReadonlyMap<Id, Size>,
  boxOfWith: (placed: ReadonlyMap<Id, Box>) => BoxOf,
  stood?: ReadonlyMap<Id, Point>,
): Map<Id, Box> {
  const placed = new Map<Id, Box>();
  const seen = boxOfWith(placed);
  // The list is taken once, before anything is placed; `seen` then grows with each picture.
  for (const id of unplaced(state, seen)) {
    const size = sizes.get(id);
    if (!size) break;
    placed.set(id, place(state, id, size, seen, stood?.get(id)));
  }
  return placed;
}

const round = (n: number) => Math.round(n);
