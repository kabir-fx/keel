import { describe, expect, it } from 'vitest';
import type { CursorState } from '../src/select/cursor';
import { cursorFor } from '../src/select/cursor';

/** The cursor table (`src/select/cursor.ts`): what the board is doing, and the cursor it shows. */

const at = (over: Partial<CursorState> = {}): CursorState => ({ tool: 'select', owner: true, space: false, grip: 'none', holding: 'none', over: 'ground', ...over });

describe('the cursor, state by state', () => {
  it.each([
    ['Select at rest on the ground', at(), 'default'],
    ['Select over something the owner can move (a picture too)', at({ over: 'movable' }), 'grab'],
    ['Select over a control inside a picture', at({ over: 'control' }), 'pointer'],
    ['Select over a handle', at({ over: { resize: 'nwse-resize' } }), 'nwse-resize'],
    ['Select over an edge', at({ over: { resize: 'ew-resize' } }), 'ew-resize'],
    ['Select over an end handle of the arrow selected', at({ over: 'end' }), 'pointer'],
    ['Select over the label of the arrow selected', at({ over: 'label' }), 'grab'],
    ['sliding that label along its line', at({ holding: 'moving', over: 'label' }), 'grabbing'],
    ['moving things', at({ holding: 'moving', over: 'movable' }), 'grabbing'],
    ['moving things, over a control they pass', at({ holding: 'moving', over: 'control' }), 'grabbing'],
    ['resizing, wherever the pointer goes', at({ holding: { resize: 'ns-resize' }, over: 'ground' }), 'ns-resize'],
    ['the Pan tool', at({ tool: 'pan' }), 'grab'],
    ['the Pan tool over a picture', at({ tool: 'pan', over: 'movable' }), 'grab'],
    ['Space held, with the Pen', at({ tool: 'pen', space: true }), 'grab'],
    ['a pan pressed and not yet moved', at({ grip: 'armed', over: 'movable' }), 'grab'],
    ['a pan under way', at({ grip: 'moving', tool: 'pen' }), 'grabbing'],
    ['the Pen', at({ tool: 'pen' }), 'crosshair'],
    ['the Pen over something movable', at({ tool: 'pen', over: 'movable' }), 'crosshair'],
    ['the Pen over a handle of what is selected', at({ tool: 'pen', over: { resize: 'ew-resize' } }), 'crosshair'],
    ['the Pen over a control inside a picture', at({ tool: 'pen', over: 'control' }), 'pointer'],
    ['the Pen over an end handle of the arrow selected: it draws there', at({ tool: 'pen', over: 'end' }), 'crosshair'],
    ['the Arrow over the label of the arrow selected: it draws there', at({ tool: 'arrow', over: 'label' }), 'crosshair'],
    ['the Box', at({ tool: 'box' }), 'crosshair'],
    ['the Arrow', at({ tool: 'arrow' }), 'crosshair'],
    ['the Lasso', at({ tool: 'lasso' }), 'crosshair'],
    ['the Note', at({ tool: 'note' }), 'crosshair'],
    ['the Pin', at({ tool: 'pin' }), 'crosshair'],
    ['the Eraser', at({ tool: 'eraser' }), 'crosshair'],
    ['the Eraser over something movable: it picks nothing up', at({ tool: 'eraser', over: 'movable' }), 'crosshair'],
    ['the Eraser in a viewer’s hand is Select', at({ tool: 'eraser', owner: false }), 'default'],
    ['a drawing tool in a viewer’s hand is Select', at({ tool: 'pen', owner: false }), 'default'],
    ['a viewer over a control', at({ tool: 'pen', owner: false, over: 'control' }), 'pointer'],
  ] as const)('%s: %s', (_name, state, cursor) => {
    expect(cursorFor(state)).toBe(cursor);
  });
});
