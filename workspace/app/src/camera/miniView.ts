/**
 * The minimap's maths: how the board is drawn small, where the view box goes, and the camera a
 * drag in the minimap asks for. Plain maths, so it can be tested alone.
 *
 * Adapted from Excalidraw (MIT licence, copyright 2020 Excalidraw), at commit 9fbeaed:
 * `getTransform`, `getMinimapViewportRect` and the drag in
 * packages/excalidraw/components/Minimap/minimap-shared.chunk.ts and minimap-controller.chunk.ts.
 */

import type { Box } from '@keel/protocol';
import { MINI_VIEW_MIN } from '../input/constants';
import type { Camera } from './camera';
import { unionBox } from './camera';

/** The minimap's size and its padding, in pixels. */
export const MINI_W = 196;
export const MINI_H = 100;
const MINI_PAD = 8;

/** How the board is drawn small: minimap = world * s + (tx, ty). */
export interface MiniTransform {
  s: number;
  tx: number;
  ty: number;
}

/** A rectangle in the minimap, in its pixels. */
export interface MiniRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The transform that fits the content and the view together into the minimap, centred. */
export function miniTransform(content: Box | undefined, view: Box): MiniTransform {
  const [x0, y0, bw, bh] = unionBox(content ? [content, view] : [view]) ?? view;
  const s = Math.min((MINI_W - 2 * MINI_PAD) / Math.max(bw, 1), (MINI_H - 2 * MINI_PAD) / Math.max(bh, 1));
  return { s, tx: (MINI_W - bw * s) / 2 - x0 * s, ty: (MINI_H - bh * s) / 2 - y0 * s };
}

/** The view box, drawn about the view's middle and never smaller than `MINI_VIEW_MIN` a side. */
export function viewBoxOf(view: Box, t: MiniTransform): MiniRect {
  const [x, y, w, h] = view;
  const bw = Math.max(w * t.s, MINI_VIEW_MIN);
  const bh = Math.max(h * t.s, MINI_VIEW_MIN);
  return { x: (x + w / 2) * t.s + t.tx - bw / 2, y: (y + h / 2) * t.s + t.ty - bh / 2, w: bw, h: bh };
}

/** The world point under a minimap point. */
export function miniToWorld(t: MiniTransform, [mx, my]: readonly [number, number]): [number, number] {
  return [(mx - t.tx) / t.s, (my - t.ty) / t.s];
}

/** A press in the minimap: whether it landed on the view box, and where in the view it holds it, in world units from the view's corner. */
export interface Grab {
  inside: boolean;
  offset: readonly [number, number];
}

/** What a press at a minimap point holds: the point of the view box under it, or, outside the box, the view's middle. */
export function grabAt(view: Box, t: MiniTransform, at: readonly [number, number]): Grab {
  const b = viewBoxOf(view, t);
  const inside = at[0] >= b.x && at[0] <= b.x + b.w && at[1] >= b.y && at[1] <= b.y + b.h;
  if (!inside) return { inside, offset: [view[2] / 2, view[3] / 2] };
  const [wx, wy] = miniToWorld(t, at);
  return { inside, offset: [wx - view[0], wy - view[1]] };
}

/** The camera, at zoom `z`, that puts the held point of the view under a minimap point. */
export function cameraForGrab(t: MiniTransform, offset: readonly [number, number], at: readonly [number, number], z: number): Camera {
  const [wx, wy] = miniToWorld(t, at);
  return { z, x: -(wx - offset[0]) * z, y: -(wy - offset[1]) * z };
}
