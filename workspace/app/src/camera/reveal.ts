import type { Box } from '@keel/protocol';
import type { Camera } from './camera';
import { fitBox, zoomTo } from './camera';

/**
 * The smallest camera move that shows something whole: what the board does when it brings the
 * agent's answer into view by itself. Plain maths, so it can be tested alone.
 *
 * The room is the free room a fit uses (`Fit.room`, `Fit.roomKept`): it is already `FIT_MARGIN`
 * in from the board's edges and from every panel, so a box shown in it keeps that margin, as a
 * box `fitBox` shows does. No margin is added here: the room is also what the board asks
 * whether a new picture is in view, and a picture it calls wholly in view must not move the
 * camera.
 */

/** How far, in screen pixels, a box may reach past the room and still count as inside it: a hair of rounding, no more. */
const HAIR = 1e-6;

/** True when the span from `at`, `length` long, lies inside the span from `from`, `room` long. */
const inside = (at: number, length: number, from: number, room: number): boolean => at >= from - HAIR && at + length <= from + room + HAIR;

/** True when the screen rectangle `room` shows the whole of the board box `box` through `cam`. */
export function shows(cam: Camera, room: Box, box: Box): boolean {
  const [bx, by, bw, bh] = box;
  const [rx, ry, rw, rh] = room;
  return inside(bx * cam.z + cam.x, bw * cam.z, rx, rw) && inside(by * cam.z + cam.y, bh * cam.z, ry, rh);
}

/**
 * The least pan along one axis at zoom `z`: the camera's offset that brings the board span from
 * `start`, `length` long, inside the screen span from `from`, `room` long. The near edge comes
 * just inside; a span already inside stays where it is. A span longer than the room has its
 * start at the room's start: as much of it as can be seen, from its top-left.
 */
function panAlong(start: number, length: number, offset: number, z: number, from: number, room: number): number {
  const at = start * z + offset;
  if (length * z > room + HAIR) return Math.abs(at - from) <= HAIR ? offset : from - start * z;
  if (at < from - HAIR) return from - start * z;
  if (at + length * z > from + room + HAIR) return from + room - (start + length) * z;
  return offset;
}

/**
 * The camera nearest `cam` whose `room` shows the whole of `target`. `cam` is where the camera
 * is going, `room` the free room in board pixels, `target` a box in board units.
 *
 * - When the room shows `target` already, the answer is `cam` itself: no move.
 * - When `target` fits at `cam`'s zoom, the zoom is kept and the camera pans by the least on
 *   each axis. An axis already inside does not move.
 * - Else the camera zooms out, about the middle of the room, by just enough for `target` to fit,
 *   rounded down as `fitBox` rounds, and then pans by the least. It never zooms in.
 * - When `target` does not fit even at the lowest zoom: the lowest zoom, and its top-left comes
 *   to the room's top-left on each axis it overflows.
 *
 * Revealing again from the answer answers the answer itself.
 */
export function reveal(cam: Camera, room: Box, target: Box): Camera {
  if (shows(cam, room, target)) return cam;
  const [tx, ty, tw, th] = target;
  const [rx, ry, rw, rh] = room;
  const fits = tw * cam.z <= rw + HAIR && th * cam.z <= rh + HAIR;
  const zoomed = fits ? cam : zoomTo(cam, rx + rw / 2, ry + rh / 2, fitBox(target, room, cam.z).z);
  const { z } = zoomed;
  const x = panAlong(tx, tw, zoomed.x, z, rx, rw);
  const y = panAlong(ty, th, zoomed.y, z, ry, rh);
  return x === cam.x && y === cam.y && z === cam.z ? cam : { x, y, z };
}
