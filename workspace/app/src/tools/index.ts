import { arrowTool } from './arrow';
import { boxTool } from './box';
import { eraserTool } from './eraser';
import { lassoTool } from './lasso';
import { noteTool } from './note';
import { panTool } from './pan';
import type { PenTool } from './pen';
import { penTool } from './pen';
import { pinTool } from './pin';
import type { SelectTool } from './select';
import { selectTool } from './select';
import type { BoardCtx, Press, Tool } from './types';

/** One board's tools. Each keeps the state of the press it is handling, so every board makes its own. */
export interface Tools {
  select: SelectTool;
  pan: Tool;
  pen: PenTool;
  box: Tool;
  arrow: Tool;
  note: Tool;
  pin: Tool;
  lasso: Tool;
  eraser: Tool;
}

/** Make the tools of one board. */
export function createTools(): Tools {
  return {
    select: selectTool(),
    pan: panTool(),
    pen: penTool(),
    box: boxTool(),
    arrow: arrowTool(),
    note: noteTool(),
    pin: pinTool(),
    lasso: lassoTool(),
    eraser: eraserTool(),
  };
}

/**
 * The tool a press goes to, or none when the press is not for the board's tools.
 *
 * - Only the main button and the middle button are for the tools. The right button does
 *   nothing, also with the Pan tool in hand or Space held.
 * - The middle button, Space held, or the Pan tool in hand: the press pans.
 * - The tools that make a mark (Pen, Box, Arrow, Lasso, Note, Pin) and the Eraser are the
 *   owner's. In anyone else's hand they behave as Select: a mark is the owner's word, and the
 *   board would refuse it.
 * - Everything else is Select.
 */
export function toolFor(tools: Tools, press: Press, board: BoardCtx): Tool | undefined {
  const inHand = board.tool();
  if (press.button !== 0 && press.button !== 1) return undefined;
  if (press.button === 1 || board.spaceHeld() || inHand === 'pan') return tools.pan;
  if (inHand === 'select') return tools.select;
  return board.isOwner ? tools[inHand] : tools.select;
}

/**
 * Is this tool's open press the owner drawing, erasing or moving something? Looking round and a tap
 * that waits for its click are not: the view may still move by itself under them.
 */
export function drawsOrMoves(tools: Tools, open: Tool | undefined): boolean {
  if (!open || open === tools.pan || open === tools.note || open === tools.pin) return false;
  if (open === tools.select) return tools.select.moving();
  return true;
}
