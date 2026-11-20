import type { Box, Id, ItemKind } from '@keel/protocol';

/**
 * What a press lands on, as plain rules: one ranking for everything under the pointer, HTML
 * items and the marks drawn as lines alike, by the order the board stacks them in.
 *
 * The rule that a near miss on top gives way to a square hit below is Excalidraw's (its App.tsx,
 * `getElementAtPosition`, commit 9fbeaed), written again for the board.
 */

/**
 * The layer each kind is drawn on: the `z-index` of its kind in `styles/canvas.css`, which a
 * test reads to keep the two the same. Within a layer, what came later in the log is on top.
 */
export const KIND_LAYER: Readonly<Record<ItemKind, number>> = {
  lasso: 0,
  picture: 1,
  note: 2,
  file: 2,
  box: 2,
  voice: 2,
  ink: 3,
  arrow: 3,
  pin: 4,
};

/** One thing under the pointer. */
export interface Hit {
  id: Id;
  /** Its layer (`KIND_LAYER`). */
  layer: number;
  /** Its place in the log: a later one is drawn over an earlier one on the same layer. */
  order: number;
  /** True when the pointer is on the thing itself; false when it is only near it, within the slop. */
  square: boolean;
}

/** Is `a` drawn over `b`? */
const above = (a: Hit, b: Hit): boolean => a.layer > b.layer || (a.layer === b.layer && a.order > b.order);

/**
 * What a press lands on, of everything under the pointer. The thing on top wins. When the thing
 * on top is only near the pointer and one below is under it squarely, the one below wins: a
 * line that passes close by does not take a press meant for the card it lies on.
 */
export function rankHits(hits: readonly Hit[]): Id | undefined {
  let top: Hit | undefined;
  let topSquare: Hit | undefined;
  for (const h of hits) {
    if (!top || above(h, top)) top = h;
    if (h.square && (!topSquare || above(h, topSquare))) topSquare = h;
  }
  return (topSquare ?? top)?.id;
}

/**
 * How far a point is from the outline of a box, inside or out. A box the owner drew is hit on its
 * outline only, so a press inside it reaches what it was drawn round.
 */
export function distToOutline(x: number, y: number, [bx, by, bw, bh]: Box): number {
  const dx = Math.max(bx - x, 0, x - (bx + bw));
  const dy = Math.max(by - y, 0, y - (by + bh));
  if (dx > 0 || dy > 0) return Math.hypot(dx, dy);
  return Math.min(x - bx, bx + bw - x, y - by, by + bh - y);
}
