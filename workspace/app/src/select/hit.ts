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
  /**
   * True when the pointer is inside a box the owner drew, off its line. The inside of a box is
   * the box's, but only where nothing else is: what the box was drawn round still takes a press
   * on it, so the box gives way to anything hit squarely, whatever lies on top.
   */
  inside?: boolean;
}

/** Is `a` drawn over `b`? */
const above = (a: Hit, b: Hit): boolean => a.layer > b.layer || (a.layer === b.layer && a.order > b.order);

/**
 * What a press lands on, of everything under the pointer, in three grades:
 *
 * 1. Squarely on a thing: the one on top. A line that passes close by does not take a press
 *    meant for the card it lies on.
 * 2. Inside a box the owner drew, and on nothing squarely: the box on top. A press inside a box
 *    takes the box, also where a line only passes near.
 * 3. Only near a thing: the one on top.
 */
export function rankHits(hits: readonly Hit[]): Id | undefined {
  let top: Hit | undefined;
  let topSquare: Hit | undefined;
  let topInside: Hit | undefined;
  for (const h of hits) {
    if (!top || above(h, top)) top = h;
    if (h.inside) {
      if (!topInside || above(h, topInside)) topInside = h;
    } else if (h.square && (!topSquare || above(h, topSquare))) topSquare = h;
  }
  return (topSquare ?? topInside ?? top)?.id;
}

/**
 * How far a point is from the outline of a box, inside or out: a box the owner drew is hit
 * squarely on its line, and its inside ranks below that (`Hit.inside`).
 */
export function distToOutline(x: number, y: number, [bx, by, bw, bh]: Box): number {
  const dx = Math.max(bx - x, 0, x - (bx + bw));
  const dy = Math.max(by - y, 0, y - (by + bh));
  if (dx > 0 || dy > 0) return Math.hypot(dx, dy);
  return Math.min(x - bx, bx + bw - x, y - by, by + bh - y);
}
