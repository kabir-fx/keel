import { onControl } from '../input/press';
import { pinItem } from '../marks';
import type { Tool } from './types';

/**
 * The Pin tool: a click (a press that does not become a drag) on a thing puts a pin there and
 * opens the field for its words. The pin is posted with its words, not here. A click on the
 * bare ground makes no pin, and the board says why. A click on a button inside a picture is the
 * button's alone: one click must not both press it and open a pin.
 */
export function pinTool(): Tool {
  return {
    down: (press) => !onControl(press.target),
    move() {},
    up(press, board) {
      if (press.moved) return;
      const at = board.toWorld(press.downClient[0], press.downClient[1]);
      // The pin shown with its label is a draft: the label takes a new id when it is posted.
      const id = board.newId();
      board.freeId(id);
      const pin = pinItem(id, at, board.measure(), board.targetBox);
      if (!pin) {
        board.say('A pin goes on a thing: click a picture, a note, or a part of one.');
        return;
      }
      board.openLabel({ kind: 'pin', pin, at: [at[0] + 14, at[1] - 34] });
    },
    cancel() {},
  };
}
