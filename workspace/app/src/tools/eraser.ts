import type { Id } from '@keel/protocol';
import type { XY } from '../geometry';
import { onControl } from '../input/press';
import { ERASER_TRAIL, Trail, trailHost } from '../overlay/trails';
import type { Erasable } from './erasable';
import { erasables, reached } from './erasable';
import { Flags } from './flags';
import type { BoardCtx, Tool } from './types';

/** The flag on a thing the eraser has reached: the styles fade it (`styles/trails.css`). */
export const ERASING = 'data-erasing';

/**
 * The Eraser: a sweep takes the owner's ink, boxes, arrows and pins off the board, and a click
 * takes off what is under it. What the eraser reaches fades as it goes and stays on the board;
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
  /** What this press has reached so far. */
  let held = new Flags(ERASING);
  /** Where the eraser was last tested: the next piece of its path begins there. */
  let last: XY = [0, 0];
  let trail: Trail | undefined;
  /** What an earlier press is taking off, its answer not back yet: a new press leaves it be. */
  const leaving = new Set<Id>();

  /** Test the newest piece of the path: Alt brings back what it reaches, else what it reaches is held. */
  const sweep = (piece: readonly XY[], alt: boolean, board: BoardCtx) => {
    for (const id of reached(piece, things, board.camera.get().z)) {
      if (alt) held.unset(id);
      else held.set(id, board.itemEl(id));
    }
  };

  return {
    down(press, board) {
      if (onControl(press.target)) return false;
      board.capture(press.pointer);
      // Only what can be pointed at: in the focus view, what lies under the dim is not there to rub out.
      things = erasables(board.where(), board.boxes(), board.camera.get().z).filter((t) => board.reachable(t.id) && !leaving.has(t.id));
      held = new Flags(ERASING);
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
      const taken = held;
      // What left the board in the meantime (from another page of the owner's) is not taken twice.
      for (const id of taken.keys()) if (items[id]?.removed) taken.unset(id);
      const ids = taken.keys();
      if (ids.length === 0) return;
      // One sweep is one step: Undo brings back all it took.
      board.together(ids);
      for (const id of ids) {
        leaving.add(id);
        // It stays faded until the board has answered: then it is gone, or, refused, back as it was.
        void board.send({ type: 'item.remove', item: id }).finally(() => {
          leaving.delete(id);
          taken.unset(id);
        });
      }
    },
    cancel() {
      trail?.clear();
      held.clear();
    },
  };
}
