// Engine-free geometry: what a mark covers (its targets) and what it is anchored to.
// Carried from spike S2. All coordinates are world coordinates. What a stroke is (its hint) is
// read in `ink/recognise.ts`; its names are handed on from here, where they used to live.

import type { Box, InkHint, Sub } from '@keel/protocol';
import { UNDER_ACROSS, UNDER_GAP, UNDER_INTO, UNDER_INTO_SHARE } from './input/constants';
import { readHint } from './ink/recognise';

export { isClosedLoop, isCross, isFlat, isStraight, readHint } from './ink/recognise';

export type XY = readonly [number, number] | readonly [number, number, number];
/** A pen sample: x, y and pressure. */
export type Pt = [x: number, y: number, pressure: number];

/** A tap target measured from the DOM: an item, or one `data-sub` inside an item. */
export interface TargetRect {
  /** `item` for an item, `item/sub` for a thing inside it. */
  id: string;
  item: string;
  sub?: Sub;
  parent?: string;
  box: Box;
}

export function bboxOf(pts: readonly XY[]): Box {
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
  return [x0, y0, x1 - x0, y1 - y0];
}

/** A box on whole world units: how the page rounds a box it worked out before it posts it. */
export function wholeBox(b: Box): Box {
  return [Math.round(b[0]), Math.round(b[1]), Math.round(b[2]), Math.round(b[3])];
}

/** The smallest box on whole world units that holds a box: its near edges rounded down, its far edges up. */
export function wholeBoxAround([x, y, w, h]: Box): Box {
  const left = Math.floor(x);
  const top = Math.floor(y);
  return [left, top, Math.ceil(x + w) - left, Math.ceil(y + h) - top];
}

/** Room left round a line in its SVG, in world units, for its width and an arrow's head. */
const LINE_ROOM = 12;

/**
 * The box of the SVG that draws a line through these points (an arrow, a lasso's path): whole
 * units round the points and the room about them. The line being drawn and the line once it is
 * saved both take their box from here, so Chrome draws the two on the same pixels.
 */
export function lineBox(pts: readonly XY[]): Box {
  return wholeBoxAround(padBox(bboxOf(pts), LINE_ROOM));
}

export function padBox([x, y, w, h]: Box, p: number): Box {
  return [x - p, y - p, w + 2 * p, h + 2 * p];
}

/** Do two boxes overlap? Boxes that only touch do not. */
export function overlaps(a: Box, b: Box): boolean {
  return a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
}

const at = <T>(xs: readonly T[], i: number): T => xs[i] as T;
const dist = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function segmentsCross(a: XY, b: XY, c: XY, d: XY): boolean {
  const o = (p: XY, q: XY, r: XY) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

function pointInPolygon(x: number, y: number, poly: readonly XY[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = at(poly, i);
    const [xj, yj] = at(poly, j);
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function inBox(x: number, y: number, [bx, by, bw, bh]: Box) {
  return x >= bx && x <= bx + bw && y >= by && y <= by + bh;
}

function segmentHitsBox(a: XY, b: XY, box: Box): boolean {
  if (inBox(a[0], a[1], box) || inBox(b[0], b[1], box)) return true;
  const [x, y, w, h] = box;
  const c: XY[] = [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
  for (let i = 0; i < 4; i++) if (segmentsCross(a, b, at(c, i), at(c, (i + 1) % 4))) return true;
  return false;
}

function pathHitsBox(pts: readonly XY[], box: Box): boolean {
  if (pts.length === 1) return inBox(at(pts, 0)[0], at(pts, 0)[1], box);
  for (let i = 1; i < pts.length; i++) if (segmentHitsBox(at(pts, i - 1), at(pts, i), box)) return true;
  return false;
}

/** Share of a 5 by 5 grid of the box that lies inside the loop. */
export function enclosedShare(box: Box, loop: readonly XY[]): number {
  const [x, y, w, h] = box;
  let n = 0;
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) if (pointInPolygon(x + (w * (i + 0.5)) / 5, y + (h * (j + 0.5)) / 5, loop)) n++;
  return n / 25;
}

function iou(a: Box, b: Box): number {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]);
  const y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter / (a[2] * a[3] + b[2] * b[3] - inter);
}

function ancestors(id: string, byId: Map<string, TargetRect>): string[] {
  const out: string[] = [];
  for (let p = byId.get(id)?.parent; p; p = byId.get(p)?.parent) out.push(p);
  return out;
}

/**
 * Which targets a mark covers, by target id.
 * - circle: targets at least 60% inside the loop; an enclosed parent swallows its children.
 * - cross: the one touched target whose box best matches the cross's box.
 * - underline or none: the innermost targets the stroke passes through.
 */
export function hitTest(strokes: readonly (readonly XY[])[], hint: InkHint, targets: readonly TargetRect[]): string[] {
  const byId = new Map(targets.map((t) => [t.id, t]));
  const all = strokes.flat();
  if (all.length === 0) return [];
  if (hint === 'circle') {
    const loop = strokes[strokes.length - 1] ?? [];
    const hit = targets.filter((t) => enclosedShare(t.box, loop) >= 0.6).map((t) => t.id);
    return hit.filter((id) => !ancestors(id, byId).some((a) => hit.includes(a)));
  }
  const touched = targets.filter((t) => strokes.some((s) => pathHitsBox(s, t.box)));
  if (hint === 'cross') {
    const box = bboxOf(all);
    const best = touched.map((t) => ({ id: t.id, s: iou(box, t.box) })).sort((p, q) => q.s - p.s)[0];
    return best ? [best.id] : [];
  }
  const ids = touched.map((t) => t.id);
  return ids.filter((id) => !ids.some((other) => other !== id && ancestors(other, byId).includes(id)));
}

/** Round samples to a tenth of a unit, so a stroke stays small in the log. */
export function toPts(pts: readonly XY[]): Pt[] {
  return pts.map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10, p[2] ?? 0.5]);
}

/* ------------------------------------------------------------ what a mark points at */

/** How much of box `a` lies inside box `b`, from 0 to 1. */
export function shareInside(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const area = a[2] * a[3];
  return area > 0 ? (w * h) / area : inBox(a[0], a[1], b) ? 1 : 0;
}

function intersection(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  return w * h;
}

/** Keep the innermost of a set of target ids: drop any that is an ancestor of another. */
function innermost(ids: readonly string[], byId: Map<string, TargetRect>): string[] {
  return ids.filter((id) => !ids.some((other) => other !== id && ancestors(other, byId).includes(id)));
}

/** Keep the outermost: drop any whose ancestor is in the set too. */
function outermost(ids: readonly string[], byId: Map<string, TargetRect>): string[] {
  return ids.filter((id) => !ancestors(id, byId).some((a) => ids.includes(a)));
}

const area = (b: Box) => b[2] * b[3];

/** The one deepest target, smallest first among equals. */
function deepest(ids: readonly string[], byId: Map<string, TargetRect>): string | undefined {
  return [...innermost(ids, byId)].sort((p, q) => area(byId.get(p)!.box) - area(byId.get(q)!.box))[0];
}

/**
 * What an underline is under: the targets whose bottom edge sits just above the line (or
 * a little into it) and that share most of its width. The nearest wins; inner before outer.
 * How near is judged on screen, at `zoom`, the camera's when the line was drawn.
 */
export function underTargets(line: readonly XY[], targets: readonly TargetRect[], zoom = 1): string[] {
  const byId = new Map(targets.map((t) => [t.id, t]));
  const [lx, ly, lw, lh] = bboxOf(line);
  const y = ly + lh / 2;
  const near = targets
    .map((t) => {
      const [tx, ty, tw, th] = t.box;
      const gap = y - (ty + th);
      const across = Math.max(0, Math.min(lx + lw, tx + tw) - Math.max(lx, tx));
      const into = Math.min(th * UNDER_INTO_SHARE, UNDER_INTO / zoom);
      const ok = gap >= -into && gap * zoom <= UNDER_GAP && across >= UNDER_ACROSS * Math.min(lw, tw);
      return ok ? { id: t.id, gap: Math.abs(gap) } : undefined;
    })
    .filter((n): n is { id: string; gap: number } => n !== undefined);
  if (near.length === 0) return [];
  const inner = innermost(
    near.map((n) => n.id),
    byId,
  );
  const best = near.filter((n) => inner.includes(n.id)).sort((p, q) => p.gap - q.gap)[0]!;
  return [best.id];
}

/**
 * What a lasso holds: each item mostly inside the loop (half of it or more). For an item that
 * is not, the things inside it that are, outermost first. So a loop round one approach of a
 * spread picks that approach, and a loop round the whole spread picks the spread.
 */
export function lassoTargets(loop: readonly XY[], targets: readonly TargetRect[]): string[] {
  if (loop.length < 3) return [];
  const byId = new Map(targets.map((t) => [t.id, t]));
  const out: string[] = [];
  for (const it of targets) {
    if (it.parent) continue;
    if (enclosedShare(it.box, loop) >= 0.5) {
      out.push(it.id);
      continue;
    }
    const subs = targets.filter((t) => t.item === it.id && t.parent && enclosedShare(t.box, loop) >= 0.5).map((t) => t.id);
    out.push(...outermost(subs, byId));
  }
  return out;
}

/** The deepest target under a point, if any. */
export function targetAtPoint(x: number, y: number, targets: readonly TargetRect[]): string | undefined {
  const byId = new Map(targets.map((t) => [t.id, t]));
  return deepest(
    targets.filter((t) => inBox(x, y, t.box)).map((t) => t.id),
    byId,
  );
}

/** The targets mostly inside a box: what a drawn box is drawn round. Outermost first. */
export function enclosedBy(box: Box, targets: readonly TargetRect[]): string[] {
  const byId = new Map(targets.map((t) => [t.id, t]));
  return outermost(
    targets.filter((t) => shareInside(t.box, box) >= 0.6).map((t) => t.id),
    byId,
  );
}

/**
 * The target a mark is anchored to, so it follows what it is on.
 * - One target: that one.
 * - Several inside one item: the item, so the mark moves and scales with all of them.
 * - Several in different items: the one the mark overlaps most.
 * - None: the deepest target that holds most of the mark, so a sketch on a picture stays on it.
 */
export function chooseAnchor(mark: Box, chosen: readonly string[], targets: readonly TargetRect[]): string | undefined {
  const byId = new Map(targets.map((t) => [t.id, t]));
  const known = chosen.filter((id) => byId.has(id));
  if (known.length === 1) return known[0];
  if (known.length > 1) {
    const items = new Set(known.map((id) => byId.get(id)!.item));
    if (items.size === 1) {
      const item = [...items][0]!;
      return byId.has(item) ? item : known[0];
    }
    return [...known].sort((p, q) => intersection(mark, byId.get(q)!.box) - intersection(mark, byId.get(p)!.box))[0];
  }
  return deepest(
    targets.filter((t) => shareInside(mark, t.box) >= 0.6).map((t) => t.id),
    byId,
  );
}

export interface InkReading {
  hint: InkHint;
  /** Target ids, as in `TargetRect.id`. */
  targets: string[];
  /** The target id to anchor to, if any. */
  anchor?: string;
}

/**
 * Read the strokes of one mark against what is on the board: the hint, what the mark points
 * at, and what it is anchored to. An underline with nothing above it is a sketch. `zoom` is the
 * camera's when the strokes were drawn: how big a stroke is, is judged on screen.
 */
export function readInk(strokes: readonly (readonly XY[])[], targets: readonly TargetRect[], zoom = 1): InkReading {
  const all = strokes.flat();
  if (all.length === 0) return { hint: 'none', targets: [] };
  let hint = readHint(strokes, zoom);
  let hit: string[];
  if (hint === 'underline') {
    hit = underTargets(strokes[0]!, targets, zoom);
    if (hit.length === 0) {
      hint = 'none';
      hit = hitTest(strokes, 'none', targets);
    }
  } else if (hint === 'circle') {
    hit = hitTest(strokes, 'circle', targets);
    // A loop drawn inside a big thing with nothing small enough in it: it rings that thing.
    if (hit.length === 0) {
      const holder = chooseAnchor(bboxOf(all), [], targets);
      hit = holder ? [holder] : [];
    }
  } else {
    hit = hitTest(strokes, hint, targets);
  }
  const hits = hit.slice(0, 24);
  const anchor = chooseAnchor(bboxOf(all), hits, targets);
  return anchor ? { hint, targets: hits, anchor } : { hint, targets: hits };
}

/** Distance from a point to a segment. */
export function distToSegment(px: number, py: number, a: XY, b: XY): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / len2));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

/** Distance from a point to a polyline. */
export function distToPath(px: number, py: number, pts: readonly XY[]): number {
  if (pts.length === 0) return Infinity;
  if (pts.length === 1) return dist([px, py], at(pts, 0));
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) best = Math.min(best, distToSegment(px, py, at(pts, i - 1), at(pts, i)));
  return best;
}

/** Flat x,y pairs as points. */
export function pairs(flat: readonly number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i]!, flat[i + 1]!]);
  return out;
}

/** Points as flat x,y pairs, rounded to a tenth. */
export function toFlat(pts: readonly XY[]): number[] {
  const out: number[] = [];
  for (const p of pts) out.push(Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10);
  return out;
}

/**
 * Thin a stroke for the log: drop samples closer than `minGap` to the last kept one, and keep
 * at most `max` points by taking every n-th. The ends are always kept.
 */
export function thin(pts: readonly XY[], minGap = 1.5, max = 3000): XY[] {
  if (pts.length <= 2) return [...pts];
  const out: XY[] = [at(pts, 0)];
  for (let i = 1; i < pts.length - 1; i++) {
    if (dist(at(pts, i), out[out.length - 1]!) >= minGap) out.push(at(pts, i));
  }
  out.push(at(pts, pts.length - 1));
  if (out.length <= max) return out;
  const step = (out.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => out[Math.round(i * step)]!);
}
