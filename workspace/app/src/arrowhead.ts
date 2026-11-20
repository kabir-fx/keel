import type { XY } from './geometry';
import { ARROWHEAD, ARROWHEAD_ANGLE, ARROWHEAD_WIDEST_ANGLE, ARROWHEAD_WIDEST_SIZE } from './input/constants';

/**
 * What sits along an arrow's line, as plain geometry in board units: its head, and its label.
 *
 * The head is an open chevron at the `to` end, drawn as a path with the line's own stroke. On a
 * short arrow it shrinks to half the arrow, and opens wider as it shrinks, so it never folds into
 * the line. The label sits at a share of the line's length, and is dragged along it.
 *
 * Adapted from Excalidraw (MIT licence, copyright 2020 Excalidraw), at commit 9fbeaed:
 * packages/element/src/bounds.ts (`getArrowheadSize`, `getArrowheadAngle`,
 * `getArrowheadPoints`), for a straight arrow with a head at its end only.
 */

/** How long each side of the head is, on an arrow this long: the full size, or half the arrow when that is less. */
export function headSize(length: number): number {
  return Math.min(ARROWHEAD, length / 2);
}

/** How far the head opens either side of the line, in degrees, at this size: wider as it shrinks, up to the widest at `ARROWHEAD_WIDEST_SIZE`. */
export function headAngle(size: number): number {
  const shrunk = Math.min(1, Math.max(0, (ARROWHEAD - size) / (ARROWHEAD - ARROWHEAD_WIDEST_SIZE)));
  return ARROWHEAD_ANGLE + (ARROWHEAD_WIDEST_ANGLE - ARROWHEAD_ANGLE) * shrunk;
}

/** The two ends of the head's sides, and its tip, for an arrow from `from` to `to`. Nothing for an arrow with no length. */
export function headPoints(from: XY, to: XY): [[number, number], [number, number], [number, number]] | undefined {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy);
  if (length === 0) return undefined;
  const size = headSize(length);
  const angle = (headAngle(size) * Math.PI) / 180;
  // Back along the line from the tip, turned either way about it.
  const bx = (-dx / length) * size;
  const by = (-dy / length) * size;
  const side = (turn: number): [number, number] => [to[0] + bx * Math.cos(turn) - by * Math.sin(turn), to[1] + bx * Math.sin(turn) + by * Math.cos(turn)];
  return [side(angle), [to[0], to[1]], side(-angle)];
}

/**
 * The lines an arrow is drawn with, from `from` to `to`: its line, and the two sides of its head
 * as one line through the tip. What a press on the arrow, and the eraser, reach.
 */
export function arrowLines(from: XY, to: XY): XY[][] {
  const head = headPoints(from, to);
  return head ? [[from, to], head] : [[from, to]];
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** A line through points as a path, each point to a tenth of a unit. */
export const linePath = (pts: readonly XY[]): string => `M ${pts.map((p) => `${r1(p[0])} ${r1(p[1])}`).join(' L ')}`;

/** The head as a path, for an arrow from `from` to `to`: empty for an arrow with no length. */
export function headPath(from: XY, to: XY): string {
  const pts = headPoints(from, to);
  return pts ? linePath(pts) : '';
}

/** A label with no place of its own sits in the middle of the line. */
export const LABEL_MIDDLE = 0.5;

/** Where a label sits on the line from `from` to `to`, at a share `at` of its length. */
export function labelPoint(from: XY, to: XY, at = LABEL_MIDDLE): [number, number] {
  return [from[0] + (to[0] - from[0]) * at, from[1] + (to[1] - from[1]) * at];
}

/** The share of the line from `from` to `to` nearest a point: where a label dragged to it sits. */
export function shareAlong(from: XY, to: XY, p: XY): number {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length2 = dx * dx + dy * dy;
  if (length2 === 0) return LABEL_MIDDLE;
  const t = ((p[0] - from[0]) * dx + (p[1] - from[1]) * dy) / length2;
  return Math.round(Math.min(1, Math.max(0, t)) * 1000) / 1000;
}
