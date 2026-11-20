import type { Grip } from '../camera/camera';
import type { ToolId } from '../chrome';

/**
 * The cursor, as one table from what the board is doing to the cursor it shows. The page sets
 * it from code on the board's element and never through a style React renders, which would
 * write over it. The table and that rule are Excalidraw's (packages/excalidraw/components/
 * App.cursor.ts, commit 9fbeaed), written again for the board's tools.
 */

/** What lies under the pointer, as the cursor sees it. */
export type Over =
  /** The ground, or something that cannot be moved. */
  | 'ground'
  /** Something the owner can pick up and move: a picture, or one of their marks. */
  | 'movable'
  /** A button, a link or another control inside a picture: it takes the click, with any tool. */
  | 'control'
  /** A handle or an edge of what is selected, with the cursor it resizes along. */
  | { resize: string }
  /** A handle on an end of the arrow selected. */
  | 'end'
  /** The label of the arrow selected: it slides along the line. */
  | 'label';

/** What the board is doing, for the cursor. */
export interface CursorState {
  /** The tool in hand. */
  tool: ToolId;
  /** True when this page may mark the board: in any other hand a drawing tool is Select. */
  owner: boolean;
  /** True while Space is held: a drag pans, whatever the tool. */
  space: boolean;
  /** How the hand holds the camera. */
  grip: Grip;
  /** What the open press is doing: moving things, or resizing one (with the cursor it resizes along). Nothing when no press moves or resizes. */
  holding: 'none' | 'moving' | { resize: string };
  over: Over;
}

/** The tools that draw, place or rub out: a crosshair, in the owner's hand. */
const DRAWS: ReadonlySet<ToolId> = new Set(['pen', 'box', 'arrow', 'lasso', 'note', 'pin', 'eraser']);

/** The cursor the board shows. */
export function cursorFor(s: CursorState): string {
  if (s.grip === 'moving' || s.holding === 'moving') return 'grabbing';
  if (typeof s.holding === 'object') return s.holding.resize;
  if (s.grip === 'armed' || s.space || s.tool === 'pan') return 'grab';
  if (s.over === 'control') return 'pointer';
  if (s.owner && DRAWS.has(s.tool)) return 'crosshair';
  if (typeof s.over === 'object') return s.over.resize;
  if (s.over === 'end') return 'pointer';
  return s.over === 'movable' || s.over === 'label' ? 'grab' : 'default';
}
