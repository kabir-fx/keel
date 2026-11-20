import type { Box, Stroke } from '@keel/protocol';
import { getStroke } from 'perfect-freehand';
import type { Pt, XY } from '../geometry';
import { INK_MIN_GAP, LOOP_CLOSE, LOOP_MIN_TRAVEL, STROKE_JOIN_POINTS, STROKE_MAX_POINTS } from '../input/constants';

/**
 * Ink as plain numbers, with no React and no page: how a stroke is kept while the hand draws
 * it, how it is kept in the log, and the one way it becomes the outline the board fills.
 *
 * The line under the pointer is the line that stays. That holds because of three things here:
 * - a stroke is thinned as its samples arrive, so the points on screen are the points the log
 *   will get (`drawing`);
 * - the live layer and a saved mark count those points from the box the same way (`keep`);
 * - both draw them with the same function, with the end closed (`inkPath`).
 *
 * The rules "one drawing function with the end always closed" and "a loop whose ends nearly meet
 * is closed" are Excalidraw's, read at commit 9fbeaed (packages/element/src/shape.ts,
 * packages/excalidraw/actions/actionFinalize.tsx, packages/element/src/utils.ts) and written
 * again for the board. No code is taken from there.
 */

/** How a line looks: what perfect-freehand is asked for. */
export interface Look {
  /**
   * The pen's width: this many pixels on screen when a stroke is drawn, at any zoom, and this
   * many board units for a stroke in a log that carries no width of its own.
   */
  readonly size: number;
  /** How much the speed of the hand thins the line. */
  readonly thinning: number;
  /** How much the edges of the line are softened. */
  readonly smoothing: number;
  /** How much the line lags the hand to lose its wobble. */
  readonly streamline: number;
  /** How the pressure worked out from the hand's speed becomes width. Left out, it does so evenly. */
  readonly easing?: (pressure: number) => number;
}

/** Keel's line. Every stroke in every log is drawn with it, so a change here changes how old ink looks. */
export const PEN: Look = { size: 4.5, thinning: 0.55, smoothing: 0.5, streamline: 0.45 };

const tenth = (n: number) => Math.round(n * 10) / 10;
const avg = (a: number, b: number) => (a + b) / 2;

const f = (n: number) => n.toFixed(2);

/** The outline polygon as a smooth closed path (the recipe from perfect-freehand's README). */
export function outlineToPath(pts: readonly (readonly number[])[]): string {
  const [a, b, c] = pts;
  if (pts.length < 4 || !a || !b || !c) return '';
  // The pieces are joined once at the end: adding to a string piece by piece leaves thousands
  // of short-lived strings for the garbage collector on every frame of a long stroke.
  const parts = [`M${f(a[0]!)},${f(a[1]!)} Q${f(b[0]!)},${f(b[1]!)} ${f(avg(b[0]!, c[0]!))},${f(avg(b[1]!, c[1]!))} T`];
  for (let i = 2; i < pts.length - 1; i++) {
    const p = pts[i]!;
    const q = pts[i + 1]!;
    parts.push(`${f(avg(p[0]!, q[0]!))},${f(avg(p[1]!, q[1]!))} `);
  }
  parts.push('Z');
  return parts.join('');
}

/** The longest gap between two pen samples. perfect-freehand rounds sparse strokes into blobs. */
const MAX_GAP = 6;

/**
 * A contract stroke's flat pairs as pen samples, scaled by `sx` and `sy`. A stroke stored
 * sparsely (a fast mouse, or ink written by a tool) gets points filled in along each segment,
 * so its corners stay corners. The pressure is a mouse's flat 0.5: the log keeps none.
 */
export function samples(flat: readonly number[], sx = 1, sy = 1): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const x = flat[i]! * sx;
    const y = flat[i + 1]! * sy;
    const prev = out[out.length - 1];
    if (prev) {
      const steps = Math.floor(Math.hypot(x - prev[0], y - prev[1]) / MAX_GAP);
      const [px, py] = prev;
      for (let k = 1; k < steps; k++) out.push([px + ((x - px) * k) / steps, py + ((y - py) * k) / steps, 0.5]);
    }
    out.push([x, y, 0.5]);
  }
  return out;
}

/** How much a stroke's width follows the mark's scale: some, so a pen line never turns into a band. */
export function inkWidth(w: number, sx: number, sy: number): number {
  return w * Math.min(1.5, Math.max(0.75, Math.sqrt(sx * sy)));
}

/**
 * The one way ink is drawn: a stroke as the log keeps it (flat x,y pairs counted from the corner
 * of its mark's box, and its width) to the path the board fills. The live layer and saved ink
 * both come through here, so a stroke looks the same before and after the pen lifts.
 *
 * `sx` and `sy` are how far the mark's anchor has scaled it: the points are scaled, not the
 * drawing, so a circle stretched round a wide lane keeps an even line. The end is always closed
 * (perfect-freehand's `last`), and the width always follows the hand's speed, since the log
 * keeps no pressure. `look` is keel's line unless another is being tried beside it.
 */
export function inkPath(pts: readonly number[], width: number = PEN.size, sx = 1, sy = 1, look: Look = PEN): string {
  return outlineToPath(getStroke(samples(pts, sx, sy), { ...look, size: inkWidth(width, sx, sy), simulatePressure: true, last: true }));
}

/** The strokes of one mark as the log keeps them, and the box they are counted from. */
export interface Kept {
  /** The box round every point, on tenths of a board unit. */
  box: Box;
  strokes: Stroke[];
}

/**
 * Strokes in board units as the log keeps them: the box round them all, and each stroke's
 * points as flat x,y pairs counted from the box's top-left corner, on tenths. A stroke of one
 * point gets a second beside it, so it stays a stroke. `width` is the pen's, in board units.
 *
 * The live layer keeps a stroke this way to draw it, and a mark is made this way to be posted:
 * for the same points, the same numbers.
 */
export function keep(strokes: readonly (readonly XY[])[], width?: number): Kept {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of strokes) {
    for (const [x, y] of s) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  const box: Box = [tenth(x0), tenth(y0), tenth(x1 - x0), tenth(y1 - y0)];
  const kept = strokes.map((s): Stroke => {
    const pts: number[] = [];
    // `+ 0` turns a rounded -0 into 0.
    for (const p of s) pts.push(tenth(p[0] - box[0]) + 0, tenth(p[1] - box[1]) + 0);
    const dot = s.length === 1 ? s[0] : undefined;
    if (dot) pts.push(tenth(dot[0] + 0.1 - box[0]) + 0, tenth(dot[1] - box[1]) + 0);
    return width === undefined ? { pts } : { pts, w: width };
  });
  return { box, strokes: kept };
}

/** A stroke while the hand draws it. */
export interface Drawing {
  /**
   * The stroke so far, in board units on tenths: what the log would keep if the pen lifted now.
   * It is one list for the whole stroke, added to in place and never copied, so a long stroke
   * costs no more to add to than a short one.
   */
  readonly pts: readonly Pt[];
  /**
   * Take the samples that came since the last call, oldest first, as the pointer reported them.
   * A stroke that is full takes no more: what it had no room for comes back, oldest first, for a
   * stroke that carries on from its last point. Empty when it took them all.
   */
  add(samples: readonly Pt[]): readonly Pt[];
  /**
   * The pen lifted. A stroke that went round and came back to within `LOOP_CLOSE` of where it
   * began is closed: its last point is put on its first. True when that moved its end. A stroke
   * that carries on from a full one began elsewhere, and is never closed.
   */
  lift(): boolean;
}

const far = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);

/** No samples: what a stroke hands back when it took them all. */
const NONE: readonly Pt[] = [];

/** How far a stroke travels, in its own units. */
function travel(pts: readonly XY[]): number {
  let sum = 0;
  for (let i = 1; i < pts.length; i++) sum += far(pts[i]![0], pts[i]![1], pts[i - 1]![0], pts[i - 1]![1]);
  return sum;
}

/**
 * Start a stroke at its first sample. `zoom` is the camera's when the pen went down: distances
 * on screen are judged by it for the whole stroke, so ink drawn zoomed in keeps its curves.
 *
 * The samples are thinned as they arrive, the way the log wants them: one nearer than
 * `INK_MIN_GAP` on screen to the last one kept is dropped. The newest sample is always in the
 * list, as the stroke's end, until the next one takes its place or joins it.
 *
 * A stroke holds at most `STROKE_MAX_POINTS`. A full one is not thinned again to make room: the
 * pen's width follows the spacing of the points, so the whole line would thin under the hand.
 * It ends where it is, and the pen carries on in a new stroke (`carriedOn`).
 */
export function drawing(first: Pt, zoom: number): Drawing {
  return growing([[tenth(first[0]), tenth(first[1]), first[2]]], first, zoom);
}

/**
 * The stroke that carries on from a full one. It begins with the full one's last
 * `STROKE_JOIN_POINTS + 1` points, as they are, so it comes out at the join as wide as the line
 * it carries on, and its ink there lies exactly under the ink it repeats. `zoom` is the full
 * one's.
 *
 * Its first point is in the middle of the hand's stroke, not where the hand began: a lift near
 * it closes nothing, and the end stays where the pen lifted.
 */
export function carriedOn(full: readonly Pt[], zoom: number): Drawing {
  const under = full.slice(-1 - STROKE_JOIN_POINTS);
  const end = under[under.length - 1];
  if (!end) throw new Error('a stroke carries on from a stroke with points');
  return { ...growing(under, end, zoom), lift: () => false };
}

/**
 * A stroke that grows from `pts`, the points it holds so far, each kept for good. `kept` is the
 * last of them as it was reported.
 */
function growing(pts: Pt[], kept: XY, zoom: number): Drawing {
  /** The least distance between two kept points, in board units. */
  const gap = INK_MIN_GAP / zoom;
  /** The last sample kept for good, as it was reported: distances are judged from it, not from its rounded copy. */
  let [keptX, keptY] = kept;
  /** True when the last point of the list is only where the pointer is for now. */
  let loose = false;

  return {
    pts,
    add(more) {
      for (const [i, p] of more.entries()) {
        // Full, and its end is a point kept for good: the stroke ends there.
        if (!loose && pts.length >= STROKE_MAX_POINTS) return more.slice(i);
        if (loose) pts.pop();
        loose = far(p[0], p[1], keptX, keptY) < gap;
        if (!loose) {
          keptX = p[0];
          keptY = p[1];
        }
        pts.push([tenth(p[0]), tenth(p[1]), p[2]]);
      }
      return NONE;
    },
    lift() {
      const start = pts[0];
      const end = pts[pts.length - 1];
      if (pts.length < 3 || !start || !end) return false;
      const apart = far(start[0], start[1], end[0], end[1]);
      if (apart === 0 || apart * zoom > LOOP_CLOSE || travel(pts) * zoom < LOOP_MIN_TRAVEL) return false;
      pts[pts.length - 1] = [start[0], start[1], end[2]];
      return true;
    },
  };
}

/**
 * One press of the pen as it is kept: the strokes it was cut into, oldest first. A press that
 * fills a stroke carries on in a new one (`carriedOn`), so a long press is kept in pieces the
 * log takes, though to the owner it is one stroke.
 */
export type Pieces = readonly (readonly XY[])[];

/**
 * The one stroke a press's pieces make, as the hand drew it: every point once. Each piece after
 * the first begins with the points it repeats under the one before, and those are left out.
 */
export function oneStroke(pieces: Pieces): XY[] {
  const [first = [], ...rest] = pieces;
  return [...first, ...rest.flatMap((piece) => piece.slice(STROKE_JOIN_POINTS + 1))];
}
