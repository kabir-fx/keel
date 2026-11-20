import type { Box } from '@keel/protocol';
import { EDGE_BAND, HANDLE_SIZE, SELECT_PAD } from '../input/constants';

/**
 * Resizing the owner's boxes and notes, as plain geometry: where the handles are, which one the
 * pointer is on, and the box a drag of one gives.
 *
 * The rules are Excalidraw's (packages/element/src/transformHandles.ts, resizeTest.ts and
 * resizeElements.ts, commit 9fbeaed), written again for boxes that never turn: each frame of a
 * resize starts from the box at the press, Shift keeps the ratio, Option resizes from the
 * centre. Excalidraw lets a box flip and has no smallest size; here a box never flips and never
 * goes under its smallest size.
 */

/** A handle: a corner, or the middle of a side, by the way it faces. */
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** The corners, drawn and tried first: a corner wins over the edges that meet at it. */
export const CORNERS: readonly Handle[] = ['nw', 'ne', 'se', 'sw'];

const EDGES: readonly Handle[] = ['n', 'e', 's', 'w'];

/** Which handles a thing can be resized by: a box by all of them, a note by those that change its width. */
export function handlesOf(widthOnly: boolean): readonly Handle[] {
  return widthOnly ? [...CORNERS, 'e', 'w'] : [...CORNERS, ...EDGES];
}

/**
 * The square a corner handle is drawn in, in screen pixels, for a thing drawn at `box` on the
 * screen: centred on the corner of the line round it.
 */
export function cornerSquare(box: Box, corner: Handle): Box {
  const [x, y, w, h] = box;
  const cx = corner.includes('w') ? x - SELECT_PAD : x + w + SELECT_PAD;
  const cy = corner.includes('n') ? y - SELECT_PAD : y + h + SELECT_PAD;
  return [cx - HANDLE_SIZE / 2, cy - HANDLE_SIZE / 2, HANDLE_SIZE, HANDLE_SIZE];
}

const inside = (px: number, py: number, [x, y, w, h]: Box) => px >= x && px <= x + w && py >= y && py <= y + h;

/** Is a point in the band along one edge of the line round a thing drawn at `box` on the screen? */
function onEdge(px: number, py: number, box: Box, edge: Handle): boolean {
  const [x, y, w, h] = box;
  const half = EDGE_BAND / 2;
  const [left, top, right, bottom] = [x - SELECT_PAD, y - SELECT_PAD, x + w + SELECT_PAD, y + h + SELECT_PAD];
  if (edge === 'n' || edge === 's') {
    const line = edge === 'n' ? top : bottom;
    return Math.abs(py - line) <= half && px >= left && px <= right;
  }
  const line = edge === 'w' ? left : right;
  return Math.abs(px - line) <= half && py >= top && py <= bottom;
}

/**
 * The handle under a point of the screen, for a thing drawn at `box` on the screen that can be
 * resized by `handles`. A corner wins over an edge.
 */
export function handleAt(px: number, py: number, box: Box, handles: readonly Handle[]): Handle | undefined {
  for (const c of CORNERS) if (handles.includes(c) && inside(px, py, cornerSquare(box, c))) return c;
  for (const e of EDGES) if (handles.includes(e) && onEdge(px, py, box, e)) return e;
  return undefined;
}

/** How a resize is done. */
export interface ResizeRules {
  /** Shift: the box keeps the ratio of its sides. */
  keepRatio: boolean;
  /** Option: the box grows or shrinks about its centre. */
  fromCentre: boolean;
  /** A note: only its width changes, and its height is left to its words. */
  widthOnly: boolean;
  /** The smallest width and height. */
  min: readonly [number, number];
}

/** Where a side of the box is held still: at its near edge, its far edge, or its middle. */
type Hold = 'start' | 'end' | 'middle';

function holdOf(handle: Handle, near: 'w' | 'n', far: 'e' | 's', fromCentre: boolean): Hold {
  if (fromCentre) return 'middle';
  if (handle.includes(far)) return 'start';
  if (handle.includes(near)) return 'end';
  return 'middle';
}

/** Where a side of a new size begins, for one that began at `from` with `size0` and is held still at `hold`. */
const place = (from: number, size0: number, size: number, hold: Hold): number => (hold === 'start' ? from : hold === 'end' ? from + size0 - size : from + (size0 - size) / 2);

/**
 * The box a resize gives: `start` is the box at the press, and the pointer has gone `dx`, `dy`
 * from where it went down, in world units. Always worked out from `start`, never from the last
 * frame, so a key pressed in the middle of a drag changes the box at once and the way back.
 */
export function resized(start: Box, handle: Handle, dx: number, dy: number, rules: ResizeRules): Box {
  const [x0, y0, w0, h0] = start;
  const grow = rules.fromCentre ? 2 : 1;
  const alongX = handle.includes('e') ? dx : handle.includes('w') ? -dx : 0;
  const alongY = rules.widthOnly ? 0 : handle.includes('s') ? dy : handle.includes('n') ? -dy : 0;
  let w = w0 + grow * alongX;
  let h = h0 + grow * alongY;
  const [minW, minH] = rules.min;
  if (rules.keepRatio && !rules.widthOnly && w0 > 0 && h0 > 0) {
    const corner = CORNERS.includes(handle);
    let s = corner ? Math.max(w / w0, h / h0) : handle === 'e' || handle === 'w' ? w / w0 : h / h0;
    s = Math.max(s, minW / w0, minH / h0);
    w = w0 * s;
    h = h0 * s;
  } else {
    w = Math.max(w, minW);
    h = rules.widthOnly ? h0 : Math.max(h, minH);
  }
  return [place(x0, w0, w, holdOf(handle, 'w', 'e', rules.fromCentre)), place(y0, h0, h, holdOf(handle, 'n', 's', rules.fromCentre)), w, h];
}

/**
 * The box a resize lands on, from the box it began with and the size the pointer left it at: a
 * size that changed comes to a whole number of units, and whatever the resize held still stays
 * exactly where it was, also when the box began on a fraction. So nothing but the dragged edges
 * moves as the pointer lifts. A size that did not change, or that comes back to what it was, is
 * left as it was, and its side with it, to the last digit.
 */
export function landed(start: Box, handle: Handle, size: readonly [number, number], fromCentre: boolean): Box {
  const along = (from: number, size0: number, to: number, hold: Hold): [number, number] => {
    const whole = to === size0 ? size0 : Math.round(to);
    return whole === size0 ? [from, size0] : [place(from, size0, whole, hold), whole];
  };
  const [x, w] = along(start[0], start[2], size[0], holdOf(handle, 'w', 'e', fromCentre));
  const [y, h] = along(start[1], start[3], size[1], holdOf(handle, 'n', 's', fromCentre));
  return [x, y, w, h];
}

/** The cursor for a handle: the two-headed arrow along which it resizes. A note's corner changes its width only. */
export function handleCursor(handle: Handle, widthOnly: boolean): string {
  if (widthOnly || handle === 'e' || handle === 'w') return 'ew-resize';
  if (handle === 'n' || handle === 's') return 'ns-resize';
  return handle === 'nw' || handle === 'se' ? 'nwse-resize' : 'nesw-resize';
}
