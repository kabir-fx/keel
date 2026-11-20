import type { InkHint } from '@keel/protocol';
import type { XY } from '../geometry';
import {
  CROSS_MAX_BEND,
  CROSS_MIDDLE,
  CROSS_MIN_DEG,
  CROSS_MIN_LENGTH,
  LINE_MAX_BACK,
  LINE_MAX_BEND,
  LINE_MAX_BOW,
  LINE_MIN_LENGTH,
  LOOP_MAX_GAP,
  LOOP_MIN_ASPECT,
  LOOP_MIN_DIAGONAL,
  LOOP_MIN_ROUND,
  LOOP_MIN_TURN,
  READ_POINTS,
  TIP_SHARE,
  TURN_SPAN,
  UNDERLINE_MAX_DEG,
} from '../input/constants';

/**
 * Reading ink: what the strokes of one mark are. One closed loop is a circle, two strokes that
 * cross are a cross, one level straight stroke is an underline, anything else is a sketch. The
 * ink stays as the hand drew it: it is read, never replaced by a clean shape.
 *
 * A stroke is read from `READ_POINTS` points spaced evenly along it, so a fast hand and a slow
 * one read alike, and its size is judged on screen (`zoom` is screen pixels a board unit), so
 * the same gesture reads alike at any zoom. Plain geometry: no React and no page.
 *
 * Adapted from Excalidraw (MIT licence, copyright 2020 Excalidraw), at commit 9fbeaed,
 * packages/element/src/convertToShape.ts: `resample`, and one measure of straightness
 * (`shaftDeviationRatio`: the largest distance from the chord, with the points near a tip left
 * out). Changed for the board: both tips are left out, not only the far one, and the board's
 * own older measure (how much longer the path is than its chord) still stands beside it, so a
 * stroke that read as a line before reads as one now.
 */

const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function pathLength(pts: readonly XY[]): number {
  let sum = 0;
  for (let i = 1; i < pts.length; i++) sum += dist(pts[i - 1]!, pts[i]!);
  return sum;
}

/**
 * A stroke again, as `n` points spaced evenly along it, its two ends among them. A stroke that
 * goes nowhere comes back as its one point, and no stroke as none.
 */
export function resample(stroke: readonly XY[], n: number = READ_POINTS): XY[] {
  const first = stroke[0];
  const last = stroke[stroke.length - 1];
  if (!first || !last) return [];
  const total = pathLength(stroke);
  if (total === 0) return [first];
  const step = total / (n - 1);
  const out: XY[] = [first];
  let walked = 0;
  for (let i = 1; i < stroke.length; i++) {
    const a = stroke[i - 1]!;
    const b = stroke[i]!;
    const piece = dist(a, b);
    // Every read point that falls on this piece of the stroke. The next one is `step` times its index along.
    while (out.length < n - 1 && walked + piece >= step * out.length) {
      const t = piece === 0 ? 0 : (step * out.length - walked) / piece;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
    walked += piece;
  }
  out.push(last);
  return out;
}

/** The width and height of the box round some points. */
function extent(pts: readonly XY[]): [number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x1 - x0, y1 - y0];
}

/**
 * How far a path of read points turns in all, in radians, left and right cancelling: about
 * 2 pi for one loop. Where it is heading at a point is taken across `TURN_SPAN` points, so the
 * wobble of a hand is not counted as turning.
 */
function turning(pts: readonly XY[]): number {
  let total = 0;
  let prev: number | undefined;
  for (let i = 0; i + TURN_SPAN < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + TURN_SPAN]!;
    if (a[0] === b[0] && a[1] === b[1]) continue;
    const heading = Math.atan2(b[1] - a[1], b[0] - a[0]);
    if (prev !== undefined) {
      let d = heading - prev;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      total += d;
    }
    prev = heading;
  }
  return total;
}

/**
 * A loop: a stroke that goes round once and comes back to where it began. Hand loops are
 * sloppy, so the ends need only come near each other (or the end runs past the start), the
 * loop may be long and flat (round a row of text), and a corner may close it (a box drawn in
 * one go).
 */
export function isClosedLoop(stroke: readonly XY[], zoom = 1): boolean {
  const pts = resample(stroke);
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (stroke.length < 3 || pts.length < READ_POINTS || !first || !last) return false;
  const [w, h] = extent(pts);
  const diag = Math.hypot(w, h);
  if (diag * zoom < LOOP_MIN_DIAGONAL || Math.min(w, h) / Math.max(w, h) < LOOP_MIN_ASPECT) return false;
  if (pathLength(pts) < LOOP_MIN_ROUND * diag) return false;
  // The ends pass each other: the end comes near the first quarter of the stroke, or the start near its last quarter.
  const quarter = Math.floor((pts.length - 1) / 4);
  const head = pts.slice(0, quarter + 1);
  const tail = pts.slice(pts.length - 1 - quarter);
  const gap = Math.min(...head.map((p) => dist(p, last)), ...tail.map((p) => dist(p, first)));
  if (gap > LOOP_MAX_GAP * diag) return false;
  // It turns round once, counting the turn that closes it: the path is followed on into its own beginning.
  const closed = [...pts, ...pts.slice(0, TURN_SPAN + 1)];
  return Math.max(Math.abs(turning(pts)), Math.abs(turning(closed))) > LOOP_MIN_TURN * 2 * Math.PI;
}

/** Distance from a point to the segment between two others. */
function offSegment(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** How straight a stroke must be to count: the limits of one use, an underline or a stroke of a cross. */
interface Limits {
  /** Longer than this from end to end, in screen pixels. */
  readonly minLength: number;
  /** A smooth stroke: its path is shorter than this many times its chord. */
  readonly maxBend: number;
}

const LINE: Limits = { minLength: LINE_MIN_LENGTH, maxBend: LINE_MAX_BEND };
const CROSS: Limits = { minLength: CROSS_MIN_LENGTH, maxBend: CROSS_MAX_BEND };

/** How a stroke lies against the chord between its ends: what its straightness is judged by. */
export interface Lie {
  /** From end to end, in board units. */
  chord: number;
  /** Its path over its chord: 1 for a stroke dead straight, more as it bends or wobbles. */
  bend: number;
  /** With its tips left out, how far it strays from the chord between what is left, as a share of that chord. */
  bow: number;
  /** With its tips left out, how far it comes back along that chord at most, as a share of it. */
  back: number;
}

/** How far points stray from the chord between the first and the last of them, and how far they come back along it, each as a share of the chord. */
function against(pts: readonly XY[]): Pick<Lie, 'bow' | 'back'> {
  const [c, d] = [pts[0], pts[pts.length - 1]];
  const span = c && d ? dist(c, d) : 0;
  if (!c || !d || span === 0) return { bow: Infinity, back: Infinity };
  let [bow, back, reached] = [0, 0, 0];
  for (const p of pts) {
    const along = ((p[0] - c[0]) * (d[0] - c[0]) + (p[1] - c[1]) * (d[1] - c[1])) / span;
    reached = Math.max(reached, along);
    back = Math.max(back, reached - along);
    bow = Math.max(bow, offSegment(p, c, d));
  }
  return { bow: bow / span, back: back / span };
}

/**
 * Measure how a stroke lies, from its read points. The tips are the first and the last
 * `TIP_SHARE` of its path, taken to the nearest whole read point (9 of the 63 steps at each end),
 * where a hand flicks or hooks as it lands or lifts: they are left out of the bow and of going
 * back, which they would upset, and kept in the bend, which they hardly lengthen. Undefined for a
 * stroke whose ends meet.
 */
export function lie(stroke: readonly XY[]): Lie | undefined {
  const pts = resample(stroke);
  const [a, b] = [pts[0], pts[pts.length - 1]];
  const chord = a && b ? dist(a, b) : 0;
  if (chord === 0) return undefined;
  const tip = Math.round(TIP_SHARE * (pts.length - 1));
  return { chord, bend: pathLength(pts) / chord, ...against(pts.slice(tip, pts.length - tip)) };
}

/**
 * Is a stroke straight enough? It is longer from end to end than the use's least length on
 * screen, and either it is smooth (its path is not much longer than its chord: a lazy arc, a
 * short hook) or, its tips left out, it keeps to its chord: it strays from it by no more than
 * `LINE_MAX_BOW` and never comes back along it by more than `LINE_MAX_BACK` (a wobbling hand, a
 * flick as it lands or lifts; going back and forth is a scratch, however near the chord it
 * stays). The first is the board's own rule from before, the second Excalidraw's: a stroke
 * either one calls straight is straight.
 */
function straightEnough(stroke: readonly XY[], zoom: number, use: Limits): boolean {
  const m = lie(stroke);
  if (!m || m.chord * zoom <= use.minLength) return false;
  return m.bend < use.maxBend || (m.bow <= LINE_MAX_BOW && m.back <= LINE_MAX_BACK);
}

/** A straight stroke, long enough to underline. */
export function isStraight(stroke: readonly XY[], zoom = 1): boolean {
  return straightEnough(stroke, zoom, LINE);
}

/** A stroke that runs across, not up or down, from its first point to its last. */
export function isFlat(stroke: readonly XY[]): boolean {
  const a = stroke[0];
  const b = stroke[stroke.length - 1];
  if (stroke.length < 2 || !a || !b) return false;
  const dx = Math.abs(b[0] - a[0]);
  const dy = Math.abs(b[1] - a[1]);
  return dx > 0 && dy / dx <= Math.tan((UNDERLINE_MAX_DEG * Math.PI) / 180);
}

/** The angle between two segments as lines, from 0 to a right angle, in radians. */
export function angleBetween(a: XY, b: XY, c: XY, d: XY): number {
  const u = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const v = Math.atan2(d[1] - c[1], d[0] - c[0]);
  let x = Math.abs(u - v) % Math.PI;
  if (x > Math.PI / 2) x = Math.PI - x;
  return x;
}

/** Where two segments meet, as the share of the way along each; undefined when they do not. */
function meeting(a: XY, b: XY, c: XY, d: XY): [number, number] | undefined {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (den === 0) return undefined;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den;
  const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [t, u] : undefined;
}

/**
 * Two roughly straight strokes that cross near the middle of each: an X. The angle between
 * them can be small, because an X over a wide, low row is flat; a T (one stroke meets the
 * other at its end) and an equals sign (they never meet) are not crosses.
 */
export function isCross(a: readonly XY[], b: readonly XY[], zoom = 1): boolean {
  const [a0, a1, b0, b1] = [a[0], a[a.length - 1], b[0], b[b.length - 1]];
  if (!a0 || !a1 || !b0 || !b1) return false;
  if (!straightEnough(a, zoom, CROSS) || !straightEnough(b, zoom, CROSS)) return false;
  const m = meeting(a0, a1, b0, b1);
  if (!m) return false;
  const mid = (t: number) => t >= CROSS_MIDDLE && t <= 1 - CROSS_MIDDLE;
  return mid(m[0]) && mid(m[1]) && angleBetween(a0, a1, b0, b1) >= (CROSS_MIN_DEG * Math.PI) / 180;
}

/**
 * How the strokes of one mark read, taken together: one closed loop is a `circle`, two crossed
 * strokes are a `cross`, one straight stroke that runs across is an `underline` (it stays one
 * only when something sits just above it, see `readInk`). Anything else is `none`: a sketch.
 */
export function readHint(strokes: readonly (readonly XY[])[], zoom = 1): InkHint {
  const [a, b] = strokes;
  if (a && strokes.length === 1) {
    if (isClosedLoop(a, zoom)) return 'circle';
    if (isStraight(a, zoom) && isFlat(a)) return 'underline';
    return 'none';
  }
  if (a && b && strokes.length === 2 && isCross(a, b, zoom)) return 'cross';
  return 'none';
}
