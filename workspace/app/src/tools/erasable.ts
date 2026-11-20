/**
 * What the eraser can take off, and what one piece of its path reaches: plain geometry, in
 * board units, with no page under it.
 *
 * Only the newest piece of the path is tested, segment against segment, so a sweep that covers
 * a long way between two frames still meets what it crossed; and the eraser reaches
 * `max(2.25, 5 / zoom)` past a line. Ink is tested against the centre line of its strokes, as the
 * log keeps them, with half the stroke's width added; a box on its border, an arrow on its line
 * and the sides of its head, a pin on its icon.
 *
 * Adapted from Excalidraw (MIT licence, copyright 2020 Excalidraw), at commit 9fbeaed:
 * - the test of the newest piece, and the reach, from packages/excalidraw/eraser/index.ts
 *   (`eraserTest`);
 * - `segmentsApart` from packages/math/src/segment.ts (`lineSegmentsDistance`).
 * Changed for the board: ink is tested on the centre line the log keeps, not on its outline,
 * with half its width added, and what is reached is decided by the board's own kinds of mark.
 *
 * Only the owner's own drawing is erased: ink, boxes, arrows and pins. A picture, a note, a file,
 * a remark and a lasso go with Delete.
 */

import type { Box, Id, Item } from '@keel/protocol';
import { liveItems } from '@keel/protocol';
import { arrowLines } from '../arrowhead';
import type { XY } from '../geometry';
import { distToSegment, inBox } from '../geometry';
import { inkWidth, PEN, samples } from '../ink/stroke';
import { ERASER_REACH, ERASER_REACH_MIN } from '../input/constants';
import type { Where } from '../layout';
import { arrowEnds, markScale } from '../layout';
import { ARROW_LINE, BOX_LINE, pinIcon } from '../markSizes';

/** One line a thing is drawn with, in board units, and half the width it is drawn at. */
export interface Line {
  readonly pts: readonly XY[];
  readonly half: number;
}

/** One thing the eraser can take off, as it is drawn now, in board units. */
export interface Erasable {
  readonly id: Id;
  readonly lines: readonly Line[];
  /** For a pin, its icon: the eraser that comes inside it reaches the pin. */
  readonly icon?: Box;
  /** The box round all of it, the width of its lines included: the quick first test. */
  readonly bounds: Box;
}

/** How far past a line's edge the eraser reaches at zoom `z`, in board units. */
export function reachAt(z: number): number {
  return Math.max(ERASER_REACH_MIN, ERASER_REACH / z);
}

const closed = ([x, y, w, h]: Box): XY[] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
  [x, y],
];

function boundsOf(lines: readonly Line[]): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const { pts, half } of lines) {
    for (const [x, y] of pts) {
      x0 = Math.min(x0, x - half);
      y0 = Math.min(y0, y - half);
      x1 = Math.max(x1, x + half);
      y1 = Math.max(y1, y + half);
    }
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

/**
 * The lines of a thing as it is drawn now, at `shown`: ink, a box, an arrow or a pin. Any other
 * kind is none, and the eraser leaves it be.
 */
function linesOf(where: Where, it: Item, shown: Box, z: number): { lines: Line[]; icon?: Box } | undefined {
  switch (it.kind) {
    case 'ink': {
      const [sx, sy] = markScale(it.box, shown);
      return {
        lines: it.strokes.map((s) => ({
          pts: samples(s.pts, sx, sy).map(([x, y]): XY => [shown[0] + x, shown[1] + y]),
          half: inkWidth(s.w ?? PEN.size, sx, sy) / 2,
        })),
      };
    }
    case 'box': {
      // The middle of its line runs half the line's width in from the box's edge.
      const i = BOX_LINE / 2;
      return { lines: [{ pts: closed([shown[0] + i, shown[1] + i, shown[2] - BOX_LINE, shown[3] - BOX_LINE]), half: i }] };
    }
    case 'arrow': {
      const [from, to] = arrowEnds(where, it, shown);
      return { lines: arrowLines(from, to).map((pts) => ({ pts, half: ARROW_LINE / 2 / z })) };
    }
    case 'pin': {
      const icon = pinIcon(shown, it.at);
      return { lines: [{ pts: closed(icon), half: 0 }], icon };
    }
    default:
      return undefined;
  }
}

/**
 * Everything the eraser can take off, as it is drawn now: the owner's ink, boxes, arrows and
 * pins, at `shown`, the boxes they are drawn at. Measured once when a press starts: `z` is the
 * zoom then, which an arrow's width on screen is counted in.
 */
export function erasables(where: Where, shown: ReadonlyMap<Id, Box>, z: number): Erasable[] {
  const out: Erasable[] = [];
  for (const s of liveItems(where.state)) {
    const box = shown.get(s.item.id);
    const drawn = box && linesOf(where, s.item, box, z);
    if (!drawn) continue;
    out.push({ id: s.item.id, ...drawn, bounds: boundsOf(drawn.lines) });
  }
  return out;
}

/** Do two segments cross, each passing between the ends of the other? */
function cross(a: XY, b: XY, c: XY, d: XY): boolean {
  const side = (p: XY, q: XY, r: XY) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
}

/** How far apart two segments are: none when they cross, else the nearest any end of one comes to the other. */
export function segmentsApart(a: XY, b: XY, c: XY, d: XY): number {
  if (cross(a, b, c, d)) return 0;
  return Math.min(distToSegment(a[0], a[1], c, d), distToSegment(b[0], b[1], c, d), distToSegment(c[0], c[1], a, b), distToSegment(d[0], d[1], a, b));
}

/** The segments of a path. A path of one point is one segment of no length: a click. */
function segmentsOf(pts: readonly XY[]): Array<readonly [XY, XY]> {
  const out: Array<readonly [XY, XY]> = [];
  for (let i = 1; i < pts.length; i++) out.push([pts[i - 1]!, pts[i]!]);
  const only = pts[0];
  if (out.length === 0 && only) out.push([only, only]);
  return out;
}

/** Do two boxes meet, edges that touch included? */
const meet = (a: Box, b: Box): boolean => a[0] <= b[0] + b[2] && b[0] <= a[0] + a[2] && a[1] <= b[1] + b[3] && b[1] <= a[1] + a[3];

/** Does the eraser's piece come within `reach` of this thing? */
function touches(thing: Erasable, piece: ReadonlyArray<readonly [XY, XY]>, reach: number): boolean {
  const { icon } = thing;
  if (icon && piece.some(([a]) => inBox(a[0], a[1], icon))) return true;
  for (const line of thing.lines) {
    const far = reach + line.half;
    for (const [c, d] of segmentsOf(line.pts)) {
      for (const [a, b] of piece) if (segmentsApart(a, b, c, d) <= far) return true;
    }
  }
  return false;
}

/**
 * The things the eraser reaches with one piece of its path: the points it went through since the
 * last frame, from the last point it was tested at, in board units. One point alone is a click,
 * which reaches what is under it. `z` is the zoom now: the eraser's reach is kept on screen.
 */
export function reached(piece: readonly XY[], things: readonly Erasable[], z: number): Id[] {
  const reach = reachAt(z);
  const segs = segmentsOf(piece);
  const xs = piece.map((p) => p[0]);
  const ys = piece.map((p) => p[1]);
  const x0 = Math.min(...xs) - reach;
  const y0 = Math.min(...ys) - reach;
  const around: Box = [x0, y0, Math.max(...xs) + reach - x0, Math.max(...ys) + reach - y0];
  return things.filter((t) => meet(around, t.bounds) && touches(t, segs, reach)).map((t) => t.id);
}
