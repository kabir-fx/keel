import type { Anchor, Box, MarkKind } from '@keel/protocol';

/**
 * The anchor transform of the contract. An anchor is the thing a mark was drawn against, and
 * where that thing was then. The board draws the mark so that `anchor.box` lands on where the
 * thing is now. Ink, lassos, boxes and arrows move and scale with it. Notes, pins and files
 * keep their size and only move: their top-left corner goes where the same point of the thing
 * went. So a note written just right of a step stays just right of it when the step grows.
 */
export type AnchorMode = 'move' | 'scale';

export function anchorMode(kind: MarkKind): AnchorMode {
  return kind === 'ink' || kind === 'lasso' || kind === 'box' || kind === 'arrow' ? 'scale' : 'move';
}

interface Map2 {
  sx: number;
  sy: number;
  to: (x: number, y: number) => [number, number];
  from: (x: number, y: number) => [number, number];
}

/** The map that takes `then` onto `now`, axis by axis. A box with no width keeps the scale at 1. */
function mapping(then: Box, now: Box): Map2 {
  const sx = then[2] > 0 && now[2] > 0 ? now[2] / then[2] : 1;
  const sy = then[3] > 0 && now[3] > 0 ? now[3] / then[3] : 1;
  return {
    sx,
    sy,
    to: (x, y) => [now[0] + (x - then[0]) * sx, now[1] + (y - then[1]) * sy],
    from: (x, y) => [then[0] + (x - now[0]) / sx, then[1] + (y - now[1]) / sy],
  };
}

/** Where to draw a mark whose own box is `box`, when its anchor was at `then` and is at `now`. */
export function placeOnAnchor(box: Box, then: Box, now: Box, mode: AnchorMode): Box {
  const m = mapping(then, now);
  const [x, y, w, h] = box;
  if (mode === 'scale') {
    const [nx, ny] = m.to(x, y);
    return [nx, ny, w * m.sx, h * m.sy];
  }
  const [nx, ny] = m.to(x, y);
  return [nx, ny, w, h];
}

/**
 * The inverse: the box to store for a mark the owner dropped at `shown`, so that it is drawn
 * there while the anchor is at `now`. A moved note stays stuck to its thing.
 */
export function unplaceFromAnchor(shown: Box, then: Box, now: Box, mode: AnchorMode): Box {
  const m = mapping(then, now);
  const [x, y, w, h] = shown;
  if (mode === 'scale') {
    const [ox, oy] = m.from(x, y);
    return [ox, oy, w / m.sx, h / m.sy];
  }
  const [ox, oy] = m.from(x, y);
  return [ox, oy, w, h];
}

/**
 * Where a mark is drawn now. `boxOf` finds where the anchor's thing is now: the item's box,
 * or the box of the sub inside it. With no anchor, or a thing that is gone, the mark stays
 * where it was drawn.
 */
export function shownBox(
  mark: { kind: MarkKind; box: Box; anchor?: Anchor },
  boxOf: (anchor: Anchor) => Box | undefined,
): Box {
  if (!mark.anchor) return mark.box;
  const now = boxOf(mark.anchor);
  return now ? placeOnAnchor(mark.box, mark.anchor.box, now, anchorMode(mark.kind)) : mark.box;
}
