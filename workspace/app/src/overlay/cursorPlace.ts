import type { Box, Id, Presence } from '@keel/protocol';
import type { Camera } from '../camera/camera';
import { worldToScreen } from '../camera/camera';
import { leftToCursor } from '../chrome';

/**
 * Where the agent's cursor is drawn and how it looks, as plain maths: `cursor.tsx` writes it to
 * the page.
 *
 * The rules are Excalidraw's for the other people on a board (packages/excalidraw/clients.ts,
 * `renderRemoteCursors`, commit 9fbeaed): drawn in screen space at one size at any zoom, kept
 * inside the board's edge and faint while its place is off screen, and faint, not hidden, when
 * the agent is away.
 */

/** Where the agent's cursor points: a point of the board, or a spot on an item. */
export function cursorPoint(presence: Presence, boxOf: (id: Id) => Box | undefined): [number, number] | undefined {
  const c = presence.cursor;
  if (!c) return undefined;
  if (c.at) return [c.at[0], c.at[1]];
  if (c.item) {
    const b = boxOf(c.item);
    if (b) return [b[0] + b[2] - 28, b[1] + b[3] - 18];
  }
  return undefined;
}

/**
 * What the cursor says beside it: a note too long for the presence pill, while the agent is
 * there. Away, the pill says why. `titles` are the chapters' titles: a note that is only one of
 * them is not said.
 */
export function cursorSays(presence: Presence, titles: readonly string[]): string | undefined {
  return leftToCursor(presence, true, titles);
}

/** How far the cursor's arrow reaches from its point, in screen pixels: it is kept this far inside the board's right and bottom edges, so it is seen whole. */
export const CURSOR_SIZE = 22;

/** Where the cursor is drawn, in board pixels, and whether its own place is off the board. */
export interface CursorPlace {
  x: number;
  y: number;
  off: boolean;
}

/** The cursor for a world point, through the camera, on a board of this size: kept inside the board, and `off` when the point is not on it. */
export function placeCursor([wx, wy]: readonly [number, number], cam: Camera, size: { w: number; h: number }): CursorPlace {
  const [sx, sy] = worldToScreen(cam, wx, wy);
  const off = sx < 0 || sy < 0 || sx > size.w || sy > size.h;
  const x = Math.max(0, Math.min(sx, size.w - CURSOR_SIZE));
  const y = Math.max(0, Math.min(sy, size.h - CURSOR_SIZE));
  return { x, y, off };
}

/** The point a share `f` of the way from `a` to `b`. */
export function towards(a: readonly [number, number], b: readonly [number, number], f: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}
