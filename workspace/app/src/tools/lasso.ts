import type { Id } from '@keel/protocol';
import type { TargetRect, XY } from '../geometry';
import { MIN_LASSO_POINTS } from '../input/constants';
import { lassoItem } from '../marks';
import { LASSO_TRAIL, Trail, trailHost } from '../overlay/trails';
import { Flags } from './flags';
import { holdsNow } from './holds';
import type { BoardCtx, Tool } from './types';

/** The flag on a thing the loop being drawn holds: the styles light it up (`styles/trails.css`). */
export const LASSOED = 'data-lassoed';

/** The element a target is drawn in: an item, or a thing inside one. */
function elementOf(board: BoardCtx, rect: TargetRect | undefined): Element | undefined {
  if (!rect) return undefined;
  const item = board.itemEl(rect.item);
  return rect.sub ? (item?.querySelector(`[data-sub="${rect.sub}"]`) ?? undefined) : item;
}

/**
 * The Lasso tool: a drag draws a loop, as a trail with marching dashes, and what the loop holds
 * lights up as it goes in and goes out again as the loop leaves it. Lifting the pointer posts a
 * lasso round what the loop holds. A loop that holds nothing is not posted, and the board says why.
 *
 * What the loop holds is worked out again on every frame from what was measured as it began, so
 * the page's layout is read once a loop.
 */
export function lassoTool(): Tool {
  let pts: XY[] = [];
  /** What was selected when the loop began: a loop that is cut short gives it back. */
  let selectedBefore: readonly Id[] = [];
  /** What the loop can hold, measured as it began. */
  let rects: TargetRect[] = [];
  /** What it holds now, lit on the page. Every ending puts all of it out. */
  const lit = new Flags(LASSOED);
  let trail: Trail | undefined;

  /** Light what the loop holds now, and only that. */
  const light = (board: BoardCtx) => {
    const now = new Set(holdsNow(pts, rects, board.camera.get().z));
    for (const id of lit.keys()) if (!now.has(id)) lit.unset(id);
    for (const id of now) {
      if (!lit.has(id)) lit.set(id, elementOf(board, rects.find((r) => r.id === id)));
    }
  };

  /** Take the loop off the page: its trail and its light. */
  const stop = () => {
    trail?.clear();
    lit.clear();
  };

  return {
    down(press, board) {
      // A drawing tool takes the press at once: the picture under it does not get a click.
      board.capture(press.pointer);
      selectedBefore = board.selection();
      board.select(undefined);
      pts = [[press.down.wx, press.down.wy]];
      rects = board.measureAll();
      trail = new Trail(LASSO_TRAIL, trailHost(board), [press.down.wx, press.down.wy]);
      return true;
    },
    move(press, board) {
      if (!press.moved) return;
      // Every sample since the last call, not only the last: a move can hold a whole frame of them.
      const more = press.samples.map((s): XY => [s.wx, s.wy]);
      pts.push(...more);
      trail?.add(more);
      light(board);
    },
    up(_press, board) {
      stop();
      if (pts.length < MIN_LASSO_POINTS) return;
      const id = board.newId();
      const item = lassoItem(id, pts, board.measureAll());
      if (!item) {
        board.freeId(id);
        board.say('That loop holds nothing. Draw it round the pictures and notes you pick.');
        return;
      }
      void board.postMark(item).then(() => board.freeId(id));
    },
    cancel(_press, board) {
      stop();
      board.select(selectedBefore);
    },
  };
}
