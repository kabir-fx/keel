import type { BoardState, Box, Id, Presence } from '@keel/protocol';
import { isMark } from '@keel/protocol';
import type { Camera } from '../camera/camera';
import { worldToScreen } from '../camera/camera';
import { isOnlyTitle, leftToCursor, PILL_NOTE_MAX } from '../chrome';
import type { Point } from '../motion/path';

/**
 * Where the agent's cursor is drawn and how it looks, as plain maths: `cursor.tsx` and
 * `cursorStore.ts` write it to the page.
 *
 * The rules for the screen are Excalidraw's for the other people on a board
 * (packages/excalidraw/clients.ts, `renderRemoteCursors`, commit 9fbeaed): drawn in screen space
 * at one size at any zoom, kept inside the board's edge and faint while its place is off screen,
 * and faint, not hidden, when the agent is away.
 */

/** How far past a mark's right edge the cursor's point waits, in board units: inside the 48 a picture answering it is placed away (`place.ts`, `GAP_RIGHT`). */
export const CURSOR_BESIDE = 12;

/** How far down a mark the cursor's point waits, as a share of the mark's height: in its lower half, so the drop and its tag hang beside the mark's words, not over them. */
export const CURSOR_DOWN = 0.6;

/** Whether an item of this board is one of the owner's marks: the cursor waits beside a mark, and inside a picture's corner. */
export const markOf =
  (state: BoardState) =>
  (id: Id): boolean => {
    const s = state.items[id];
    return !!s && isMark(s.item);
  };

/**
 * Where presence puts the agent's cursor: a point of the board, or a spot by an item. Beside an
 * owner's mark (`isAMark`, as `markOf` says), just outside its right edge, so it never covers the
 * words it reads; on a picture, near its bottom right corner, inside. Undefined when presence
 * names no place, or an item that is not on the board.
 */
export function cursorPoint(presence: Presence, boxOf: (id: Id) => Box | undefined, isAMark: (id: Id) => boolean = () => false): [number, number] | undefined {
  const c = presence.cursor;
  if (!c) return undefined;
  if (c.at) return [c.at[0], c.at[1]];
  if (c.item) {
    const b = boxOf(c.item);
    if (!b) return undefined;
    if (isAMark(c.item)) return [b[0] + b[2] + CURSOR_BESIDE, b[1] + b[3] * CURSOR_DOWN];
    return [b[0] + b[2] - 28, b[1] + b[3] - 18];
  }
  return undefined;
}

/**
 * The drop's pose, each a state the board is really in. Led: something leads it, or cursors split
 * off it still draw or fly back to it; steady. Reading, thinking, drawing: what the agent's stream
 * says it does while it works; working with no word of what, it thinks, and writing words is drawn
 * as drawing. Asleep: listening, waiting or building, dimmed after a short hold with its eyes
 * closed. Away: faint. Every pose but asleep and away is working: at full strength, with what it
 * does in its tag.
 */
export type DropPose = 'led' | 'reading' | 'thinking' | 'drawing' | 'asleep' | 'away';

/** The drop's pose for this presence, whether something leads the cursor now, and how many cursors are drawn. */
export function dropPose(presence: Presence, shown: { led: boolean; count: number }): DropPose {
  if (shown.led || shown.count > 1) return 'led';
  if (presence.state === 'away') return 'away';
  if (presence.state !== 'drawing') return 'asleep';
  if (presence.doing === 'reading') return 'reading';
  if (presence.doing === 'drawing' || presence.doing === 'writing') return 'drawing';
  return 'thinking';
}

/**
 * The words in the cursor's tag beside its name while it works: the agent's note, when it is
 * short enough for the pill and is not only a chapter's title. A longer note is said in the
 * bubble beside the cursor (`cursorSays`).
 */
export function tagWords(presence: Presence, titles: readonly string[]): string | undefined {
  const note = presence.note;
  return note && note.length <= PILL_NOTE_MAX && !isOnlyTitle(note, titles) ? note : undefined;
}

/**
 * What the cursor says beside it: a note too long for the presence pill, while the agent is
 * there. Away, the pill says why. `titles` are the chapters' titles: a note that is only one of
 * them is not said.
 */
export function cursorSays(presence: Presence, titles: readonly string[]): string | undefined {
  return leftToCursor(presence, true, titles);
}

/** How far the drop reaches from its tip, in screen pixels: it is kept this far inside the board's right and bottom edges, so it is seen whole. */
export const CURSOR_SIZE = 30;

/** A droplet, a cursor split off the agent's own, is the drop at this share of its size. */
export const DROPLET_SHARE = 0.72;

/** Where the tag starts, right of the cursor's point, in screen pixels: past the drop and the gap after it. */
export const CURSOR_TAG_FROM = CURSOR_SIZE + 2;

/** Where the cursor is drawn, in board pixels, whether its own place is off the board, and whether its tag hangs left of the point. */
export interface CursorPlace {
  x: number;
  y: number;
  off: boolean;
  /** The tag, `tagWidth` wide, would pass the board's right edge on the right of the point: it hangs on the left, still below the tip. */
  flip: boolean;
}

/**
 * The cursor for a world point, through the camera, on a board of this size: kept inside the
 * board, and `off` when the point is not on it. Its tag, as wide as `tagWidth` in screen pixels,
 * hangs right of the point when there is room for it inside the board, and else left of it.
 */
export function placeCursor([wx, wy]: Point, cam: Camera, size: { w: number; h: number }, tagWidth = 0): CursorPlace {
  const [sx, sy] = worldToScreen(cam, wx, wy);
  const off = sx < 0 || sy < 0 || sx > size.w || sy > size.h;
  const x = Math.max(0, Math.min(sx, size.w - CURSOR_SIZE));
  const y = Math.max(0, Math.min(sy, size.h - CURSOR_SIZE));
  return { x, y, off, flip: tagWidth > 0 && x + CURSOR_TAG_FROM + tagWidth > size.w };
}

/**
 * Where the cursor comes in from the first time it goes to the board point at screen point
 * `[sx, sy]`: the nearest edge of the board, level with it, where the cursor is seen whole. None
 * when the point itself is off the board: the cursor then simply waits at the edge.
 */
export function entryPoint([sx, sy]: Point, size: { w: number; h: number }): [number, number] | undefined {
  if (sx < 0 || sy < 0 || sx > size.w || sy > size.h) return undefined;
  const right = size.w - CURSOR_SIZE;
  const bottom = size.h - CURSOR_SIZE;
  const ways: Array<[gap: number, at: [number, number]]> = [
    [sx, [0, sy]],
    [size.w - sx, [right, sy]],
    [sy, [sx, 0]],
    [size.h - sy, [sx, bottom]],
  ];
  // The first of the nearest wins a tie: left, then right, then top, then bottom.
  let best = ways[0]!;
  for (const w of ways) if (w[0] < best[0]) best = w;
  const [x, y] = best[1];
  return [Math.min(Math.max(x, 0), right), Math.min(Math.max(y, 0), bottom)];
}
