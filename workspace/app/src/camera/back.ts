/**
 * Finding the way back when the owner has panned away from everything. Plain maths, so it can be
 * tested alone.
 *
 * Adapted from Excalidraw (MIT licence, copyright 2020 Excalidraw), at commit 9fbeaed: the
 * "scroll back to content" rule and `getClosestElementBounds` in packages/excalidraw/viewport.ts.
 */

import type { Box, Id } from '@keel/protocol';
import { MIN_ZOOM, unionBox } from './camera';

const meets = (a: Box, b: Box) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

/** True when there are items and none of them is in the view (in world units). */
export function lostFrom(boxes: ReadonlyMap<Id, Box>, view: Box): boolean {
  if (boxes.size === 0) return false;
  for (const b of boxes.values()) if (meets(b, view)) return false;
  return true;
}

/**
 * Where "back to the board" goes: the whole board when it fits in `room` above the smallest
 * zoom (an empty list), else the one item nearest the middle of the view.
 */
export function wayBack(boxes: ReadonlyMap<Id, Box>, view: Box, room: Box): readonly Id[] {
  const all = unionBox([...boxes.values()]);
  if (!all) return [];
  const fits = Math.min(room[2] / Math.max(all[2], 1), room[3] / Math.max(all[3], 1)) >= MIN_ZOOM;
  if (fits) return [];
  const cx = view[0] + view[2] / 2;
  const cy = view[1] + view[3] / 2;
  let best: Id | undefined;
  let bestD = Infinity;
  for (const [id, [x, y, w, h]] of boxes) {
    const d = Math.hypot(x + w / 2 - cx, y + h / 2 - cy);
    if (d < bestD) {
      bestD = d;
      best = id;
    }
  }
  return best === undefined ? [] : [best];
}
