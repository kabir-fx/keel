import { ARC_BEND, ARC_BEND_MAX, ARC_STEPS } from './timing';

/**
 * The paths the agent's cursor travels: a gentle curve from one place to another, or the route
 * of a line it draws. Plain maths, in whatever units the points are in (the board's, for the
 * cursor). No randomness: the same trip is always the same path.
 *
 * Every path is a line through points, measured along its length, so a share of the way is a
 * share of the distance: the easing alone says how fast the cursor goes.
 */

export type Point = readonly [number, number];

/** A path: the points it passes through, in order, and how far along it each one is. */
export interface Path {
  readonly points: readonly Point[];
  /** The distance from the start to each point, along the path: 0 first, the path's length last. */
  readonly along: readonly number[];
}

/** The straight distance between two points. */
export function distance(a: Point, b: Point): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** The path through these points in order, as straight lines: the route of an arrow. One point is a path that goes nowhere. */
export function polyline(points: readonly [Point, ...Point[]]): Path {
  const along = [0];
  for (let i = 1; i < points.length; i++) along.push(along[i - 1]! + distance(points[i - 1]!, points[i]!));
  return { points: points.map(([x, y]) => [x, y] as const), along };
}

/**
 * A trip from `from` to `to` on a gentle curve, as a hand moves: a quadratic curve whose middle
 * is pushed to the left of the way it goes (up, on a trip to the right) by a share of the trip's
 * length, never more than a cap. A trip of no length is a point.
 */
export function arc(from: Point, to: Point): Path {
  const length = distance(from, to);
  if (length === 0) return polyline([from]);
  const bend = Math.min(ARC_BEND * length, ARC_BEND_MAX);
  const [dx, dy] = [(to[0] - from[0]) / length, (to[1] - from[1]) / length];
  // The control point: twice the bend out from the middle, so the curve itself passes `bend` out.
  const c: Point = [(from[0] + to[0]) / 2 + dy * bend * 2, (from[1] + to[1]) / 2 - dx * bend * 2];
  const points: [Point, ...Point[]] = [from];
  for (let i = 1; i < ARC_STEPS; i++) {
    const s = i / ARC_STEPS;
    const [a, b, d] = [(1 - s) ** 2, 2 * (1 - s) * s, s ** 2];
    points.push([a * from[0] + b * c[0] + d * to[0], a * from[1] + b * c[1] + d * to[1]]);
  }
  points.push(to);
  return polyline(points);
}

/** How long a path is. */
export function lengthOf(path: Path): number {
  return path.along[path.along.length - 1]!;
}

/** The point a share `f` of the way along a path: exactly its first point at or before 0, exactly its last at or past 1. */
export function at(path: Path, f: number): [number, number] {
  const { points, along } = path;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (f <= 0) return [first[0], first[1]];
  if (f >= 1) return [last[0], last[1]];
  const s = f * lengthOf(path);
  // The last point not past `s`: the segment from it holds the point.
  let lo = 0;
  let hi = along.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (along[mid]! <= s) lo = mid;
    else hi = mid;
  }
  const span = along[hi]! - along[lo]!;
  const k = span === 0 ? 0 : (s - along[lo]!) / span;
  const [a, b] = [points[lo]!, points[hi]!];
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
}
