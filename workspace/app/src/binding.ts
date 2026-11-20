import type { ArrowTie, Box, Target } from '@keel/protocol';
import type { TargetRect, XY } from './geometry';
import { inBox, padBox, targetAtPoint } from './geometry';
import { ANGLE_STEP, TIE_GAP, TIE_MIN_LENGTH, TIE_REACH } from './input/constants';
import { ARROW_LINE } from './markSizes';

/**
 * How an arrow holds on to what it points at, as plain geometry in board units: which thing an
 * end ties to, the spot it holds, and where each end is drawn from where its target is now.
 *
 * - An end that lands on a thing holds "this exact spot" (`inside`): it is drawn at the spot.
 * - An end that stops just short of a thing the arrow points at holds "this thing" (`outline`).
 *   Its spot is inside the thing, on the arrow's own line, so tying an end never turns the
 *   arrow. The end is drawn where the line between the two ends' spots comes to the thing's
 *   outline, a little short of it.
 *
 * Adapted from Excalidraw (MIT licence, copyright 2020 Excalidraw), at commit 9fbeaed:
 * packages/element/src/binding.ts (`maxBindingDistance_simple`, `getBindingGap`,
 * `updateBoundPoint` and its guards), packages/element/src/utils.ts
 * (`projectFixedPointOntoDiagonal`) and packages/element/src/sizeHelpers.ts
 * (`getLockedLinearCursorAlignSize`). Changed for the board: targets are boxes that never turn;
 * the spot of a tie is always inside its target's box, as the contract has it, so an end ties
 * only to a thing its arrow points at: the deepest thing under it, else the nearest such thing
 * within reach; an end does not snap to the middle of a side; and a tail gives up its outline
 * when the head is drawn on the tail's own thing, so that an arrow between two things laid one
 * over the other's edge is never drawn turned round.
 */

export type TieMode = ArrowTie['mode'];

/** One end of an arrow tied to a thing: the thing, and the spot it holds and how. */
export interface TiedEnd {
  target: Target;
  tie: ArrowTie;
}

/** What the two ends of a new arrow tie to. An end left out ties to nothing. */
export interface Ties {
  from?: TiedEnd;
  to?: TiedEnd;
}

/** An end tied as it is being drawn: its tie, and where its target is drawn now. */
export interface TieNow {
  end: TiedEnd;
  box: Box;
}

/** Where a target is drawn now, in board units. */
export type TargetBoxNow = (t: Target) => Box | undefined;

/**
 * `boxOf`, asked once a thing: for a gesture, which reads where a thing is drawn the first time
 * an end comes near it and keeps it, not once a sample (a part is read from the page).
 */
export function keptBoxes(boxOf: TargetBoxNow): TargetBoxNow {
  const kept = new Map<string, Box | undefined>();
  return (t) => {
    const key = t.sub ? `${t.item}/${t.sub}` : t.item;
    if (!kept.has(key)) kept.set(key, boxOf(t));
    return kept.get(key);
  };
}

/**
 * How near a thing an end must land to tie to it, in board units, at a zoom: `TIE_REACH` at 100%
 * and closer, growing as the board is zoomed out past two thirds, to twice that at a third and
 * further out.
 */
export function tieReach(zoom: number): number {
  return Math.min(2 * TIE_REACH, Math.max(TIE_REACH, TIE_REACH / (zoom * 1.5)));
}

/** How far a point is outside a box: 0 on it or inside it. */
export function outsideBy(p: XY, [x, y, w, h]: Box): number {
  return Math.hypot(Math.max(x - p[0], 0, p[0] - (x + w)), Math.max(y - p[1], 0, p[1] - (y + h)));
}

/** How many things a thing is inside of: none for an item, one for a part of it, and so on. */
function depthOf(rect: TargetRect, byId: ReadonlyMap<string, TargetRect>): number {
  let depth = 0;
  for (let p = rect.parent; p; p = byId.get(p)?.parent) depth++;
  return depth;
}

/** A thing an end could tie to, and how. */
export interface TieHit {
  rect: TargetRect;
  mode: TieMode;
}

/**
 * The things an end at `p` could tie to, and how, the first to try first. The deepest thing
 * under the point holds the spot it landed on, and is the only one. With nothing under it, each
 * thing within `reach` could hold the end on its outline: the nearest first, and of things
 * equally near the deeper one, so that a part comes before the picture it is in.
 */
export function tieTargets(p: XY, rects: readonly TargetRect[], reach: number): TieHit[] {
  const under = targetAtPoint(p[0], p[1], rects);
  const hit = under === undefined ? undefined : rects.find((r) => r.id === under);
  if (hit) return [{ rect: hit, mode: 'inside' }];
  const byId = new Map(rects.map((r) => [r.id, r]));
  const near: Array<{ rect: TargetRect; d: number; depth: number }> = [];
  for (const rect of rects) {
    const d = outsideBy(p, rect.box);
    if (d <= reach) near.push({ rect, d, depth: depthOf(rect, byId) });
  }
  near.sort((a, b) => a.d - b.d || b.depth - a.depth);
  return near.map(({ rect }) => ({ rect, mode: 'outline' }));
}

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** A point as shares of a box, kept inside it. A box with no width or height holds its middle on that axis. */
export function sharesOf(p: XY, [x, y, w, h]: Box): [number, number] {
  const share = (v: number, from: number, size: number) => (size > 0 ? r4(Math.min(1, Math.max(0, (v - from) / size))) : 0.5);
  return [share(p[0], x, w), share(p[1], y, h)];
}

/** The spot a tie holds, where its target is drawn now. */
export function spotIn(at: readonly [number, number], [x, y, w, h]: Box): [number, number] {
  return [x + at[0] * w, y + at[1] * h];
}

/**
 * Where the line from `from` through `p`, carried on past `p`, first meets one of a box's two
 * diagonals: the spot an end at `p` holds on a thing it stops just short of. It is inside the
 * box and on the arrow's own line. Nothing when the box does not lie ahead of the end: the line
 * passes beside it, has come through it already, or has no length.
 */
export function spotOnDiagonals(from: XY, p: XY, [x, y, w, h]: Box): [number, number] | undefined {
  const dx = p[0] - from[0];
  const dy = p[1] - from[1];
  const diagonals: ReadonlyArray<readonly [XY, XY]> = [
    [
      [x, y],
      [x + w, y + h],
    ],
    [
      [x + w, y],
      [x, y + h],
    ],
  ];
  let first: number | undefined;
  for (const [a, b] of diagonals) {
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const cross = dx * ey - dy * ex;
    // Level with the diagonal, or a line or a box with no length: they never meet at one point.
    if (cross === 0) continue;
    const qx = a[0] - from[0];
    const qy = a[1] - from[1];
    /** How far along the line, in lengths of `from` to `p`, and how far along the diagonal. */
    const along = (qx * ey - qy * ex) / cross;
    const across = (qx * dy - qy * dx) / cross;
    if (along > 1 && across >= 0 && across <= 1 && (first === undefined || along < first)) first = along;
  }
  return first === undefined ? undefined : [from[0] + first * dx, from[1] + first * dy];
}

const targetOf = (r: TargetRect): Target => (r.sub ? { item: r.item, sub: r.sub } : { item: r.item });

/**
 * The tie an end at `p` has, on an arrow whose other end is at `other`, on the first of the
 * things it could tie to (`hits`) that the arrow points at: the thing, the spot it holds as
 * shares of where that thing is drawn now (`boxOf`, else where it was measured), and that box.
 * An end on a thing holds the spot it is on. An end just outside one holds the spot the arrow
 * points at (`spotOnDiagonals`); a thing the arrow does not point at is passed over, however
 * near, and an end that points at none ties to nothing.
 */
export function tieOn(hits: readonly TieHit[], p: XY, other: XY, boxOf: TargetBoxNow): TieNow | undefined {
  for (const hit of hits) {
    const target = targetOf(hit.rect);
    const box = boxOf(target) ?? hit.rect.box;
    const spot = hit.mode === 'inside' ? p : spotOnDiagonals(other, p, box);
    if (spot) return { end: { target, tie: { at: sharesOf(spot, box), mode: hit.mode } }, box };
  }
  return undefined;
}

/**
 * What an end at `p` ties to, on an arrow whose other end is at `other`: `tieOn` the things
 * `tieTargets` finds. Nothing when it lands on no thing within `reach`, or points at none.
 */
export function tieAt(p: XY, other: XY, rects: readonly TargetRect[], reach: number, boxOf: TargetBoxNow): TieNow | undefined {
  return tieOn(tieTargets(p, rects, reach), p, other, boxOf);
}

/** What both ends of an arrow drawn from `from` to `to` tie to, with the reach at 100%. */
export function tiesAt(from: XY, to: XY, rects: readonly TargetRect[], boxOf: TargetBoxNow, reach = TIE_REACH): Ties {
  const f = tieAt(from, to, rects, reach, boxOf);
  const t = tieAt(to, from, rects, reach, boxOf);
  return { ...(f ? { from: f.end } : {}), ...(t ? { to: t.end } : {}) };
}

/* ------------------------------------------------------------ the ends as drawn */

/** One end of an arrow, as it is aimed: at its tie's spot, or where a free end is; and its target now, for a tied end. */
export interface EndAim {
  spot: XY;
  tie?: { box: Box; mode: TieMode };
}

/**
 * An end tied to a thing's outline stops this far short of it, in board units: the gap, and half
 * the arrow's line as it is drawn at 100%. The line keeps its width on the screen at any zoom
 * and the gap does not, so zoomed far out the line's round end comes up to the outline. An end's
 * place cannot follow the zoom: every arrow would be laid out again as the board zooms.
 */
export const TIE_SPACE = TIE_GAP + ARROW_LINE / 2;

const area = (b: Box) => b[2] * b[3];
const apart = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** What an end tied to a thing's outline keeps clear of: the thing's box, grown by `TIE_SPACE`. */
const clearOf = (box: Box) => padBox(box, TIE_SPACE);

/**
 * Where the line from `from` to `to` first comes into `box`: nothing when it begins inside it,
 * or never comes in. Liang and Barsky's clipping.
 */
export function entryInto(from: XY, to: XY, [x, y, w, h]: Box): [number, number] | undefined {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  let enter = 0;
  let leave = 1;
  const sides: Array<[number, number]> = [
    [-dx, from[0] - x],
    [dx, x + w - from[0]],
    [-dy, from[1] - y],
    [dy, y + h - from[1]],
  ];
  for (const [p, q] of sides) {
    if (p === 0) {
      if (q < 0) return undefined;
      continue;
    }
    const t = q / p;
    if (p < 0) enter = Math.max(enter, t);
    else leave = Math.min(leave, t);
    if (enter > leave) return undefined;
  }
  return enter > 0 ? [from[0] + enter * dx, from[1] + enter * dy] : undefined;
}

/**
 * Where an end tied to its thing's outline meets that outline: where the line between the two
 * ends' spots comes to the thing, `TIE_SPACE` short of it, on the other end's side. Nothing for
 * any other end, and when the other end's spot is already that near the thing.
 */
function rimOf(end: EndAim, other: EndAim): [number, number] | undefined {
  return end.tie?.mode === 'outline' ? entryInto(other.spot, end.spot, clearOf(end.tie.box)) : undefined;
}

/**
 * Where the head end is drawn: at its rim, when it has one. It is drawn at its spot instead when
 * the rim would turn the arrow back on itself (it lies on the tail's thing, and that thing is
 * not far bigger, as a picture round one of its own parts is), or would leave `TIE_MIN_LENGTH`
 * or less of the arrow to see, counted from where the line leaves the tail's thing, or from a
 * free tail.
 */
function headEnd(head: EndAim, tail: EndAim, rim: [number, number] | undefined): [number, number] {
  const spot: [number, number] = [head.spot[0], head.spot[1]];
  if (!rim || !head.tie) return spot;
  if (tail.tie && inBox(rim[0], rim[1], clearOf(tail.tie.box)) && area(tail.tie.box) < 2 * area(head.tie.box)) return spot;
  const begins = (tail.tie && entryInto(head.spot, tail.spot, clearOf(tail.tie.box))) ?? tail.spot;
  return apart(begins, rim) <= TIE_MIN_LENGTH ? spot : rim;
}

/**
 * Where the tail end is drawn: at its rim, when it has one. It has no head to keep clear of
 * anything, so it stays there but for two cases, where it begins at its spot. One: the head end
 * is free, and the rim would leave the arrow `TIE_MIN_LENGTH` long or shorter. Two: the head end
 * is drawn (`headAt`) on the tail's own thing, as when the head's thing lies over the edge of a
 * far bigger one. The rim is then past the head, and an arrow begun there would be drawn turned
 * round; begun at its spot it reads as one from a picture to a part of it does.
 */
function tailEnd(tail: EndAim, head: EndAim, rim: [number, number] | undefined, headAt: XY): [number, number] {
  const spot: [number, number] = [tail.spot[0], tail.spot[1]];
  if (!rim || !tail.tie) return spot;
  if (!head.tie && apart(head.spot, rim) <= TIE_MIN_LENGTH) return spot;
  return inBox(headAt[0], headAt[1], clearOf(tail.tie.box)) ? spot : rim;
}

/**
 * Where an arrow's two ends are drawn, from how each is aimed. A free end, and one tied to an
 * exact spot, is drawn at its spot. One tied to its thing's outline stops short of the outline,
 * on the line between the two spots (`rimOf`), but for the cases `headEnd` and `tailEnd` name.
 * The tail is never drawn past the head.
 */
export function drawnEnds(from: EndAim, to: EndAim): [[number, number], [number, number]] {
  const head = headEnd(to, from, rimOf(to, from));
  return [tailEnd(from, to, rimOf(from, to), head), head];
}

/** How an end is aimed: at its tie's spot on where its target is now, else at `p`. */
export function aimOf(p: XY, tied: TieNow | undefined): EndAim {
  return tied ? { spot: spotIn(tied.end.tie.at, tied.box), tie: { box: tied.box, mode: tied.end.tie.mode } } : { spot: p };
}

/* ------------------------------------------------------------ Shift */

/**
 * Shift holds an arrow to steps of `ANGLE_STEP` degrees: its end goes to the point on the
 * nearest such ray from `from` that is nearest the pointer.
 */
export function lockAngle(from: XY, to: XY): [number, number] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const step = (ANGLE_STEP * Math.PI) / 180;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  // A level or upright ray is exactly so: `Math.cos` of a right angle is not quite 0.
  const exact = (n: number) => (Math.abs(n) < 1e-12 ? 0 : n);
  const cos = exact(Math.cos(angle));
  const sin = exact(Math.sin(angle));
  const along = dx * cos + dy * sin;
  return [from[0] + along * cos, from[1] + along * sin];
}
