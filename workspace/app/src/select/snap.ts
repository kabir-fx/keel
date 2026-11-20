import type { Box } from '@keel/protocol';
import type { Handle } from './resize';

/**
 * Snapping, as plain geometry on boxes in world units: what is moved or resized lines up its
 * edges and its centre with those of the other things in view, and keeps an equal gap.
 *
 * Adapted from Excalidraw (MIT licence, copyright 2020 Excalidraw), at commit 9fbeaed:
 * packages/excalidraw/snapping.ts (`getVisibleGaps`, `getGapSnaps`, `getPointSnaps`,
 * `snapDraggedElements`, `snapResizingElements`). Changed for the board: a box's edges and
 * centre are taken as lines, where Excalidraw takes its corners and centre as points (the
 * snaps are the same for boxes that never turn); the guides are lines and gaps in world units,
 * for the overlay to draw.
 */

type Axis = 'x' | 'y';

/** Two values this near are the same line: Excalidraw rounds to 6 decimals. */
const SAME = 1e-6;

/** The three lines of a box along one axis: its near edge, its centre and its far edge. */
function linesOf(b: Box, axis: Axis): [number, number, number] {
  const [at, size] = axis === 'x' ? [b[0], b[2]] : [b[1], b[3]];
  return [at, at + size / 2, at + size];
}

/** Where a box spans across an axis: its extent on the other one. */
function across(b: Box, axis: Axis): [number, number] {
  return axis === 'x' ? [b[1], b[1] + b[3]] : [b[0], b[0] + b[2]];
}

const overlap = (a: readonly [number, number], b: readonly [number, number]): [number, number] | undefined => {
  const lo = Math.max(a[0], b[0]);
  const hi = Math.min(a[1], b[1]);
  return lo <= hi ? [lo, hi] : undefined;
};

/** An empty space between two things that face each other along an axis: `start` before it, `end` after. */
export interface Gap {
  axis: Axis;
  start: Box;
  end: Box;
  /** Where the space begins and ends along the axis. */
  from: number;
  to: number;
  /** The span the two things share across the axis: a box beside the gap must reach into it. */
  shared: [number, number];
}

/** What a gesture snaps to: the boxes of the other things in view, and the gaps between them. Collected once, when the gesture starts. */
export interface SnapTargets {
  boxes: readonly Box[];
  gaps: readonly Gap[];
}

function gapsAlong(boxes: readonly Box[], axis: Axis): Gap[] {
  const sorted = [...boxes].sort((a, b) => linesOf(a, axis)[0] - linesOf(b, axis)[0]);
  const out: Gap[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const start = sorted[i]!;
      const end = sorted[j]!;
      const from = linesOf(start, axis)[2];
      const to = linesOf(end, axis)[0];
      const shared = overlap(across(start, axis), across(end, axis));
      if (from < to && shared) out.push({ axis, start, end, from, to, shared });
    }
  }
  return out;
}

/** The targets for a gesture, from the boxes of the other things in view. */
export function snapTargets(boxes: readonly Box[]): SnapTargets {
  return { boxes, gaps: [...gapsAlong(boxes, 'x'), ...gapsAlong(boxes, 'y')] };
}

/** A guide the overlay draws, in world units: a line things line up on, or a gap that is the same as another. */
export type Guide = { kind: 'line'; axis: Axis; at: number; from: number; to: number } | { kind: 'gap'; axis: Axis; from: number; to: number; at: number };

/** The offset along one axis that would line something up, within `reach`, or undefined. */
function nearestLine(lines: readonly number[], boxes: readonly Box[], axis: Axis, reach: number): number | undefined {
  let best: number | undefined;
  for (const b of boxes) {
    for (const target of linesOf(b, axis)) {
      for (const line of lines) {
        const off = target - line;
        if (Math.abs(off) <= reach && (best === undefined || Math.abs(off) < Math.abs(best))) best = off;
      }
    }
  }
  return best;
}

/**
 * The places along an axis that keep a gap equal for a box `m`: in the middle of a gap wider than
 * it, or as far past either end of a gap as the gap is long. Each with the segments that show it.
 */
function gapPlaces(m: Box, gap: Gap): Array<{ off: number; marks: Array<[number, number]> }> {
  const axis = gap.axis;
  if (!overlap(across(m, axis), gap.shared)) return [];
  const [near, mid, far] = linesOf(m, axis);
  const size = far - near;
  const length = gap.to - gap.from;
  const out: Array<{ off: number; marks: Array<[number, number]> }> = [];
  if (length > size) {
    const off = (gap.from + gap.to) / 2 - mid;
    out.push({ off, marks: [[gap.from, near + off], [far + off, gap.to]] });
  }
  const after = linesOf(gap.end, axis)[2];
  out.push({ off: after + length - near, marks: [[gap.from, gap.to], [after, after + length]] });
  const before = linesOf(gap.start, axis)[0];
  out.push({ off: before - length - far, marks: [[before - length, before], [gap.from, gap.to]] });
  return out;
}

function nearestGap(m: Box, gaps: readonly Gap[], axis: Axis, reach: number): number | undefined {
  let best: number | undefined;
  for (const g of gaps) {
    if (g.axis !== axis) continue;
    for (const { off } of gapPlaces(m, g)) if (Math.abs(off) <= reach && (best === undefined || Math.abs(off) < Math.abs(best))) best = off;
  }
  return best;
}

const shifted = (b: Box, dx: number, dy: number): Box => [b[0] + dx, b[1] + dy, b[2], b[3]];

/** The guides for lines that already meet along an axis: where `lines` of the moved box lie on lines of the targets. */
function lineGuides(m: Box, lines: readonly number[], boxes: readonly Box[], axis: Axis): Guide[] {
  const spans = new Map<number, [number, number]>();
  for (const b of boxes) {
    for (const target of linesOf(b, axis)) {
      if (!lines.some((l) => Math.abs(target - l) < SAME)) continue;
      const a = across(m, axis);
      const c = across(b, axis);
      const was = spans.get(target);
      spans.set(target, [Math.min(a[0], c[0], was?.[0] ?? Infinity), Math.max(a[1], c[1], was?.[1] ?? -Infinity)]);
    }
  }
  return [...spans].map(([at, [from, to]]) => ({ kind: 'line', axis, at, from, to }));
}

/** The guides for gaps that are already equal along an axis. */
function gapGuides(m: Box, gaps: readonly Gap[], axis: Axis): Guide[] {
  const out: Guide[] = [];
  for (const g of gaps) {
    if (g.axis !== axis) continue;
    for (const { off, marks } of gapPlaces(m, g)) {
      if (Math.abs(off) >= SAME) continue;
      const shared = overlap(across(m, axis), g.shared) ?? g.shared;
      const at = (shared[0] + shared[1]) / 2;
      for (const [from, to] of marks) out.push({ kind: 'gap', axis, from, to, at });
    }
  }
  return out;
}

/** Where a gesture lands once snapped, and the guides that show why. */
export interface Snapped {
  dx: number;
  dy: number;
  guides: Guide[];
}

/** Round as Excalidraw does, so lines that meet are found to meet. */
const round = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Snap a move: `box` is what is moved, as it was when the press went down, and it has been
 * moved by `dx`, `dy`. An edge or the centre snaps to an edge or a centre of a target, and the
 * box snaps to keep a gap equal, whichever is nearest along each axis, within `reach` (world
 * units). The guides are worked out again where the box lands, so they show every line that
 * meets there.
 */
export function snapMove(box: Box, dx: number, dy: number, targets: SnapTargets, reach: number): Snapped {
  const moved = shifted(box, dx, dy);
  const off = (axis: Axis) => {
    const line = nearestLine(linesOf(moved, axis), targets.boxes, axis, reach);
    const gap = nearestGap(moved, targets.gaps, axis, reach);
    if (line === undefined) return gap ?? 0;
    return gap !== undefined && Math.abs(gap) < Math.abs(line) ? gap : line;
  };
  const sx = round(dx + off('x'));
  const sy = round(dy + off('y'));
  const landed = shifted(box, sx, sy);
  const guides = (axis: Axis) => [...lineGuides(landed, linesOf(landed, axis), targets.boxes, axis), ...gapGuides(landed, targets.gaps, axis)];
  return { dx: sx, dy: sy, guides: [...guides('x'), ...guides('y')] };
}

/** The edges of a resized box that move with its handle, along one axis. */
function movingEdges([x, y, w, h]: Box, handle: Handle, axis: Axis): number[] {
  if (axis === 'x') return handle.includes('w') ? [x] : handle.includes('e') ? [x + w] : [];
  return handle.includes('n') ? [y] : handle.includes('s') ? [y + h] : [];
}

/**
 * Snap a resize: `box` is the box the resize gives now, and `handle` is what is dragged. Only the
 * edges that move snap, and only to the edges and centres of the targets, within `reach` (world
 * units). The answer is how far the moving edges are to go along each axis.
 */
export function snapResize(box: Box, handle: Handle, targets: SnapTargets, reach: number): { dx: number; dy: number } {
  return {
    dx: round(nearestLine(movingEdges(box, handle, 'x'), targets.boxes, 'x', reach) ?? 0),
    dy: round(nearestLine(movingEdges(box, handle, 'y'), targets.boxes, 'y', reach) ?? 0),
  };
}

/** The guides for a resized box where it lands: the lines its moving edges meet. */
export function resizeGuides(box: Box, handle: Handle, targets: SnapTargets): Guide[] {
  return [...lineGuides(box, movingEdges(box, handle, 'x'), targets.boxes, 'x'), ...lineGuides(box, movingEdges(box, handle, 'y'), targets.boxes, 'y')];
}
