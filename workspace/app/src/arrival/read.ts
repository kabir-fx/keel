import type { Box } from '@keel/protocol';
import type { BuildPart } from '@keel/pictures';
import { buildParts } from '@keel/pictures';
import type { Point } from '../motion/path';
import type { PlanPart } from './plan';

/**
 * Reading an arriving picture off the page, before anything on it moves: its parts in the order
 * they are drawn on, where its root is drawn, and the route of its arrow. What the plan is made
 * from. It reads the layout, so it runs once per arrival, as its turn comes.
 */

/** A picture on the page, ready to be planned and played. */
export interface Reading {
  /** The picture's root: the first part, the one that is pulled out. */
  root: HTMLElement;
  /** Where the root is drawn, in board units: the picture at the size it is drawn now. */
  card: Box;
  /** Whether the root has paper of its own: a background, a border or a shadow. */
  paper: boolean;
  /** The parts, in the order they are drawn on; the root first. */
  parts: BuildPart[];
  /** The same, as the plan needs them. */
  planned: PlanPart[];
}

/** The picture's root in the element the board draws it in: the first marked part. */
export function rootOf(itemEl: Element): HTMLElement | null {
  const el = itemEl.querySelector('[data-build]');
  return el instanceof HTMLElement ? el : null;
}

/**
 * Read the picture drawn in `itemEl`, whose box is `box`, at zoom `z`. Undefined when the
 * picture says nothing of what it is made of: it then simply lands.
 */
export function readPicture(itemEl: HTMLElement, box: Box, z: number): Reading | undefined {
  const root = rootOf(itemEl);
  if (!root) return undefined;
  const parts = buildParts(root);
  if (parts.length === 0) return undefined;
  const origin = itemEl.getBoundingClientRect();
  const r = root.getBoundingClientRect();
  // A page with no layout (a test's) has no size to read: the box is the picture's own then.
  const card: Box = r.width > 0 && r.height > 0 ? [box[0] + (r.left - origin.left) / z, box[1] + (r.top - origin.top) / z, r.width / z, r.height / z] : box;
  const planned = parts.map((p): PlanPart => {
    const length = p.kind === 'line' ? lengthOf(p.el) : undefined;
    return { kind: p.kind, depth: p.depth, dashed: p.dashed, ...(length !== undefined ? { length } : {}) };
  });
  return { root, card, paper: hasPaper(root), parts, planned };
}

/** Whether an element draws a surface of its own: a background that is not clear, a border, or a shadow. */
function hasPaper(el: HTMLElement): boolean {
  const s = getComputedStyle(el);
  const clear = /^(transparent|rgba\(.*,\s*0\))$/.test(s.backgroundColor) || s.backgroundColor === '';
  return !clear || parseFloat(s.borderTopWidth) > 0 || (s.boxShadow !== '' && s.boxShadow !== 'none');
}

/**
 * A line's length in its own units, what its dash is counted in. None for an element that is not
 * a shape the page can measure, or one whose stroke does not scale with it: that line is brought
 * in by a fade.
 */
function lengthOf(el: Element): number | undefined {
  if (!(el instanceof SVGGeometryElement) || typeof el.getTotalLength !== 'function' || el.getAttribute('vector-effect')) return undefined;
  const length = el.getTotalLength();
  return length > 0 ? length : undefined;
}

/** The route of a lineage arrow, from its path's `d` (`M x y L x y …`, in board units); none when it has fewer than two points. */
export function routeOf(arrow: SVGPathElement): Point[] | undefined {
  const n = (arrow.getAttribute('d') ?? '').match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  const pts: Point[] = [];
  for (let i = 0; i + 1 < n.length; i += 2) pts.push([n[i]!, n[i + 1]!]);
  return pts.length > 1 ? pts : undefined;
}
