import type { Id } from '@keel/protocol';
import type { XY } from '../geometry';
import { onControl } from '../input/press';
import { ERASER_TRAIL, Trail, trailHost } from '../overlay/trails';
import { pictureTakenOff } from '../undo';
import type { Erasable } from './erasable';
import { erasables, reached } from './erasable';
import { Flags } from './flags';
import type { BoardCtx, Tool } from './types';

/** The flag on a thing the eraser has reached: the styles fade it (`styles/trails.css`). */
export const ERASING = 'data-erasing';

/**
 * The Eraser: a sweep takes the owner's ink, boxes, arrows and pins off the board, or the agent's
 * pictures, and a click takes off what is under it. One sweep takes one layer: the owner's
 * drawing when it reaches any, else the pictures it reaches. So a line rubbed out on a picture
 * never takes the picture with it, and a picture fades only while the sweep has reached no
 * drawing. What the eraser reaches fades as it goes and stays on the board;
 * with Alt held, it brings back what it passes over. When the pointer lifts, everything it holds
 * is taken off as one step, which Undo brings back whole. A press that ends any other way
 * brings everything back and posts nothing.
 *
 * A grey trail follows the pointer and fades behind it. A click on a button inside a picture is
 * the button's alone. In the focus view the eraser reaches only what stands above the dim.
 */
export function eraserTool(): Tool {
  /** What this press can reach, measured as it went down. */
  let things: Erasable[] = [];
  /** What this press has reached so far: the owner's drawing, and, apart, pictures. */
  let held = new Flags(ERASING);
  /** The pictures this press has reached: they fade, and go, only while it has reached no drawing (`pictures`). */
  let reachedPictures = new Set<Id>();
  let pictures = new Flags(ERASING);
  /** Where the eraser was last tested: the next piece of its path begins there. */
  let last: XY = [0, 0];
  let trail: Trail | undefined;
  /** What an earlier press is taking off, its answer not back yet: a new press leaves it be. */
  const leaving = new Set<Id>();

  /** Test the newest piece of the path: Alt brings back what it reaches, else what it reaches is held. */
  const sweep = (piece: readonly XY[], alt: boolean, board: BoardCtx) => {
    const layer = new Map(things.map((t) => [t.id, t.layer]));
    for (const id of reached(piece, things, board.camera.get().z)) {
      const picture = layer.get(id) === 'picture';
      if (alt) {
        held.unset(id);
        reachedPictures.delete(id);
      } else if (picture) reachedPictures.add(id);
      else held.set(id, board.itemEl(id));
    }
    // The pictures it reached show as going only while no drawing is held.
    if (held.keys().length > 0) pictures.clear();
    else {
      for (const id of pictures.keys()) if (!reachedPictures.has(id)) pictures.unset(id);
      for (const id of reachedPictures) pictures.set(id, board.itemEl(id));
    }
  };

  return {
    down(press, board) {
      if (onControl(press.target)) return false;
      board.capture(press.pointer);
      // Only what can be pointed at: in the focus view, what lies under the dim is not there to rub out.
      // Measured once, here: a picture, and a box its words made taller, are as big as their frames.
      things = erasables(board.where(), board.boxes(), board.camera.get().z, board.outlines()).filter((t) => board.reachable(t.id) && !leaving.has(t.id));
      held = new Flags(ERASING);
      reachedPictures = new Set();
      pictures = new Flags(ERASING);
      last = [press.down.wx, press.down.wy];
      trail = new Trail(ERASER_TRAIL, trailHost(board), last);
      sweep([last], press.mods.alt, board);
      return true;
    },
    move(press, board) {
      const pts = press.samples.map((s): XY => [s.wx, s.wy]);
      trail?.add(pts);
      sweep([last, ...pts], press.mods.alt, board);
      last = pts.at(-1) ?? last;
    },
    up(_press, board) {
      trail?.end();
      const items = board.state().items;
      // One layer: the drawing it reached, else the pictures.
      const taken = held.keys().length > 0 ? held : pictures;
      const anyPicture = taken === pictures;
      // What left the board in the meantime (from another page of the owner's) is not taken twice.
      for (const id of taken.keys()) if (items[id]?.removed) taken.unset(id);
      const ids = taken.keys();
      if (ids.length === 0) return;
      // One sweep is one step: Undo brings back all it took.
      board.together(ids);
      const sent = ids.map((id) => {
        leaving.add(id);
        // It stays faded until the board has answered: then it is gone, or, refused, back as it was.
        return board.send({ type: 'item.remove', item: id }).finally(() => {
          leaving.delete(id);
          taken.unset(id);
        });
      });
      // As with Delete: a picture is the agent's work, so the board says how to get it back.
      if (anyPicture) void Promise.all(sent).then((rs) => rs.some((r) => r.ok) && board.say(pictureTakenOff()));
    },
    cancel() {
      trail?.clear();
      held.clear();
      pictures.clear();
    },
  };
}
