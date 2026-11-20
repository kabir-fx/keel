import type { Id } from '@keel/protocol';
import { MIN_BOX } from '../input/constants';
import { boxFromDrag } from '../marks';
import type { Tool } from './types';

/**
 * The Box tool: a drag draws a box in the live layer, and lifting the pointer opens the field
 * for its label. The box is posted with its label, not here. A box too small to be meant is dropped.
 */
export function boxTool(): Tool {
  let from: [number, number] = [0, 0];
  let to: [number, number] = [0, 0];
  /** What was selected when the drag began: a drag that is cut short gives it back. */
  let selectedBefore: readonly Id[] = [];

  return {
    down(press, board) {
      // A drawing tool takes the press at once: the picture under it does not get a click.
      board.capture(press.pointer);
      selectedBefore = board.selection();
      board.select(undefined);
      from = to = [press.down.wx, press.down.wy];
      board.hand.set({ shape: { kind: 'box', from, to } });
      return true;
    },
    move(press, board) {
      if (!press.moved) return;
      to = [press.at.wx, press.at.wy];
      board.hand.set({ shape: { kind: 'box', from, to } });
    },
    up(_press, board) {
      const z = board.camera.get().z;
      const box = boxFromDrag(from, to);
      if (box[2] * z < MIN_BOX || box[3] * z < MIN_BOX) {
        board.hand.set({ shape: undefined });
        return;
      }
      board.openLabel({ kind: 'box', box, at: [box[0] + 8, box[1] + box[3] / 2 - 18] });
    },
    cancel(_press, board) {
      board.hand.set({ shape: undefined });
      board.select(selectedBefore);
    },
  };
}
