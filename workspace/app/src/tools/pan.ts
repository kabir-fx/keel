import type { Id } from '@keel/protocol';
import type { BoardCtx, Press, Tool } from './types';

/**
 * Looking round: a drag moves the camera, and a press that never became a drag selects what it
 * was on. The Pan tool is this with nothing to select; the Select tool uses it for a press on
 * the ground or on a thing that cannot move.
 */
export interface PanGesture {
  /** Begin at this press. `hit` is what a click selects; nothing, for the Pan tool. */
  start(board: BoardCtx, hit?: Id): void;
  move(press: Press, board: BoardCtx): void;
  end(press: Press, board: BoardCtx): void;
}

/**
 * Make one looking-round gesture. Each move is applied from the last point it applied, not from
 * where the press began: a wheel that pans or zooms in the middle of the drag moves the camera
 * too, and the two add up. Each tool that pans makes its own.
 */
export function panGesture(): PanGesture {
  let hit: Id | undefined;
  /** The pointer's last applied place, in board pixels; null until the press has become a drag. */
  let last: readonly [number, number] | null = null;
  return {
    start(board, on) {
      hit = on;
      last = null;
      board.camera.hold('armed');
    },
    move(press, board) {
      if (!press.moved) return;
      if (!last) {
        last = [press.down.x, press.down.y];
        board.capture(press.pointer);
        board.camera.hold('moving');
      }
      const cam = board.camera.get();
      board.camera.set({ ...cam, x: cam.x + press.at.x - last[0], y: cam.y + press.at.y - last[1] });
      last = [press.at.x, press.at.y];
    },
    end(press, board) {
      last = null;
      board.camera.hold('none');
      if (press.moved) board.dragEnded();
      else board.select(hit);
    },
  };
}

/** The Pan tool, the middle button, and Space held: a drag moves the camera. */
export function panTool(): Tool {
  const pan = panGesture();
  return {
    down(_press, board) {
      pan.start(board);
      return true;
    },
    move: pan.move,
    up: pan.end,
    // Looking round changes nothing on the board, so a pan that is cut short stays where it
    // got to, and posts nothing. Only the hand lets go.
    cancel(_press, board) {
      board.camera.hold('none');
    },
  };
}
