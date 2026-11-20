import type { Box } from '@keel/protocol';

/**
 * The sizes the owner's marks are drawn at, for the code that must know where their lines are:
 * what a press lands on, what the eraser reaches, what the line round a selection goes round.
 * The styles draw them (`styles/marks.css`), and these say the same: a unit test reads the
 * styles to keep the two together, and the browser tests of the eraser's reach check them
 * against what Chrome draws.
 */

/** The line of a box the owner drew, in board units: the border of `.drawn-box`, which runs inside the box's edge. */
export const BOX_LINE = 2.5;

/** The line of an arrow, in screen pixels at any zoom: `.line-mark > path`. */
export const ARROW_LINE = 3;

/** The dashed line of a lasso, in screen pixels at any zoom: `.line-mark--lasso`. */
export const LASSO_LINE = 2.5;

/** A pin's icon is a square this wide, in board units (`MarkView` in `items.tsx`)... */
export const PIN_SIZE = 26;

/** ...drawn with its tip on the pin's point: this far left of the point, and this far above it (`.pin__icon`). */
export const PIN_TIP: readonly [left: number, up: number] = [13, 24];

/** Where a pin's icon is drawn, in board units: the pin's point is at `at`, counted from the box its mark is drawn at. */
export function pinIcon(shown: Box, at: readonly [number, number]): Box {
  return [shown[0] + at[0] - PIN_TIP[0], shown[1] + at[1] - PIN_TIP[1], PIN_SIZE, PIN_SIZE];
}
