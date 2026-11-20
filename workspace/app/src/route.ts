// The geometry of a lineage arrow: where it leaves each box, and the route it takes round the
// cards in its way. Pure: the lineage layer draws what it works out.

import type { Box } from '@keel/protocol';
import { overlaps } from './geometry';

/** The middle of a box. */
export const centre = (b: Box): [number, number] => [b[0] + b[2] / 2, b[1] + b[3] / 2];

/** Where the line from the centre of `box` towards (tx, ty) leaves the box. */
function exitPoint([x, y, w, h]: Box, tx: number, ty: number): [number, number] {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const kx = dx === 0 ? Infinity : w / 2 / Math.abs(dx);
  const ky = dy === 0 ? Infinity : h / 2 / Math.abs(dy);
  const k = Math.min(kx, ky);
  return [cx + dx * k, cy + dy * k];
}

/** The two ends of an arrow between two boxes, each on its box's edge, with a small gap. */
export function edgeEnds(a: Box, b: Box, gap = 6): [[number, number], [number, number]] {
  const ca = centre(a);
  const cb = centre(b);
  const p = exitPoint(a, cb[0], cb[1]);
  const q = exitPoint(b, ca[0], ca[1]);
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
  const ux = (q[0] - p[0]) / len;
  const uy = (q[1] - p[1]) / len;
  return [
    [p[0] + ux * gap, p[1] + uy * gap],
    [q[0] - ux * gap, q[1] - uy * gap],
  ];
}

type Pt = [number, number];

/** Does the segment p-q pass through the box? (Liang-Barsky clipping.) */
export function segmentHits(p: Pt, q: Pt, [x, y, w, h]: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const edges: Array<[number, number]> = [
    [-dx, p[0] - x],
    [dx, x + w - p[0]],
    [-dy, p[1] - y],
    [dy, y + h - p[1]],
  ];
  for (const [pp, qq] of edges) {
    if (pp === 0) {
      if (qq < 0) return false;
      continue;
    }
    const r = qq / pp;
    if (pp < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
  }
  return t1 - t0 > 1e-9;
}

const lengthOf = (pts: readonly Pt[]) => pts.slice(1).reduce((n, p, i) => n + Math.hypot(p[0] - pts[i]![0], p[1] - pts[i]![1]), 0);

/** How many of the obstacles a polyline passes through. */
function crossings(pts: readonly Pt[], obstacles: readonly Box[]): number {
  let n = 0;
  for (const o of obstacles) {
    for (let i = 0; i + 1 < pts.length; i++) {
      if (segmentHits(pts[i]!, pts[i + 1]!, o)) {
        n += 1;
        break;
      }
    }
  }
  return n;
}

/** A route this much longer than the straight line is not a short route: the line goes straight. */
export const DETOUR_MAX = 2.5;

/**
 * The route of a lineage arrow from box `a` to box `b`. Straight when nothing is in the way.
 * When cards are in the way, the shortest route with right angles that passes none of them,
 * if one is short enough; else straight after all. Cards that touch either end do not count:
 * a mark sitting on a picture is inside it.
 */
export function routeEdge(a: Box, b: Box, obstacles: readonly Box[], gap = 6): Pt[] {
  const straight = edgeEnds(a, b, gap);
  const inWay = obstacles.filter((o) => !overlaps(o, a) && !overlaps(o, b)).map((o): Box => [o[0] - 4, o[1] - 4, o[2] + 8, o[3] + 8]);
  if (crossings(straight, inWay) === 0) return straight;
  const [ax, ay] = centre(a);
  const [bx, by] = centre(b);
  const [aL, aT, aR, aB] = [a[0], a[1], a[0] + a[2], a[1] + a[3]];
  const [bL, bT, bR, bB] = [b[0], b[1], b[0] + b[2], b[1] + b[3]];
  const routes: Pt[][] = [];
  // Across, then up or down into the target.
  if ((bx > aR || bx < aL) && (ay < bT || ay > bB)) {
    const sx = bx > aR ? aR + gap : aL - gap;
    const ey = ay < bT ? bT - gap : bB + gap;
    routes.push([[sx, ay], [bx, ay], [bx, ey]]);
  }
  // Up or down, then across into the target.
  if ((by > aB || by < aT) && (ax < bL || ax > bR)) {
    const sy = by > aB ? aB + gap : aT - gap;
    const ex = ax < bL ? bL - gap : bR + gap;
    routes.push([[ax, sy], [ax, by], [ex, by]]);
  }
  // Across, through the gap between the two, and across again.
  if (bL > aR || bR < aL) {
    const right = bL > aR;
    const mx = right ? (aR + bL) / 2 : (bR + aL) / 2;
    routes.push([[right ? aR + gap : aL - gap, ay], [mx, ay], [mx, by], [right ? bL - gap : bR + gap, by]]);
  }
  // Down or up, through the gap between the two, and down or up again.
  if (bT > aB || bB < aT) {
    const below = bT > aB;
    const my = below ? (aB + bT) / 2 : (bB + aT) / 2;
    routes.push([[ax, below ? aB + gap : aT - gap], [ax, my], [bx, my], [bx, below ? bT - gap : bB + gap]]);
  }
  // Over, under, or round either side of what blocks the straight line.
  const blocking = inWay.filter((o) => segmentHits(straight[0], straight[1], o));
  if (blocking.length > 0) {
    const top = Math.min(aT, bT, ...blocking.map((o) => o[1])) - 16;
    const bottom = Math.max(aB, bB, ...blocking.map((o) => o[1] + o[3])) + 16;
    const left = Math.min(aL, bL, ...blocking.map((o) => o[0])) - 16;
    const right = Math.max(aR, bR, ...blocking.map((o) => o[0] + o[2])) + 16;
    routes.push([[ax, aT - gap], [ax, top], [bx, top], [bx, bT - gap]]);
    routes.push([[ax, aB + gap], [ax, bottom], [bx, bottom], [bx, bB + gap]]);
    routes.push([[aL - gap, ay], [left, ay], [left, by], [bL - gap, by]]);
    routes.push([[aR + gap, ay], [right, ay], [right, by], [bR + gap, by]]);
  }
  const limit = lengthOf(straight) * DETOUR_MAX;
  const best = routes
    .filter((r) => crossings(r, inWay) === 0 && lengthOf(r) <= limit)
    .sort((x, y) => lengthOf(x) - lengthOf(y))[0];
  return best ?? straight;
}
