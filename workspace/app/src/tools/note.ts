import { onControl } from '../input/press';
import type { Tool } from './types';

/** What the board says when the Note tool cannot place a note where the owner clicked or typed. */
export const NOTE_WHERE = 'A note goes on the board: click on the board where it goes, clear of the panels, then type. Esc puts the Note tool down.';

/**
 * The Note tool: a click (a press that does not become a drag) opens a new note where it went
 * down, on the thing it went down on. The note is posted when the owner has typed it. A click on
 * a button inside a picture is the button's alone: one click must not both press it and open a note.
 */
export function noteTool(): Tool {
  return {
    down: (press) => !onControl(press.target),
    move() {},
    up(press, board) {
      if (press.moved) return;
      const [x, y] = press.downClient;
      const [wx, wy] = board.toWorld(x, y);
      board.openNote([Math.round(wx - 18), Math.round(wy - 24)], board.noteTarget(x, y));
    },
    cancel() {},
  };
}
