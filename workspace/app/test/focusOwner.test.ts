import { describe, expect, it } from 'vitest';
import { createFocusOwner } from '../src/input/focusOwner';

/**
 * Who put the focus where it is (`src/input/focusOwner.ts`), as plain logic. What it means for
 * Space on the board is in `keysOnBoard.test.tsx`.
 */

const button = new EventTarget();
const other = new EventTarget();

describe('who put the focus where it is', () => {
  it('before any key goes down, a focus is nobody’s', () => {
    const focus = createFocusOwner();
    focus.focusIn(button);
    expect(focus.byKeyboard(button)).toBe(false);
  });

  it('after a key, a focus is the keyboard’s, and only where it arrived', () => {
    const focus = createFocusOwner();
    focus.keyDown('Tab');
    focus.focusIn(button);
    expect(focus.byKeyboard(button)).toBe(true);
    expect(focus.byKeyboard(other)).toBe(false);
    expect(focus.byKeyboard(null)).toBe(false);
    // The focus moves on: the button no longer holds it.
    focus.focusIn(other);
    expect(focus.byKeyboard(button)).toBe(false);
    expect(focus.byKeyboard(other)).toBe(true);
  });

  it('a press of the pointer takes the focus from the keyboard, and the next focus is nobody’s', () => {
    const focus = createFocusOwner();
    focus.keyDown('Tab');
    focus.focusIn(button);
    focus.pointerDown();
    expect(focus.byKeyboard(button)).toBe(false);
    focus.focusIn(other);
    expect(focus.byKeyboard(other)).toBe(false);
  });

  it('a bare modifier does not put the keyboard in use; the key it goes with does', () => {
    const focus = createFocusOwner();
    focus.pointerDown();
    for (const key of ['Meta', 'Control', 'Alt', 'Shift']) focus.keyDown(key);
    focus.focusIn(button);
    expect(focus.byKeyboard(button)).toBe(false);
    // Shift and Tab: back to the button before.
    focus.keyDown('Shift');
    focus.keyDown('Tab');
    focus.focusIn(button);
    expect(focus.byKeyboard(button)).toBe(true);
  });

  it('a window that gets its focus back leaves it as it was: the keyboard’s stays the keyboard’s', () => {
    const focus = createFocusOwner();
    focus.keyDown('Tab');
    focus.focusIn(button);
    focus.keyDown('Meta');
    focus.focusIn(button);
    expect(focus.byKeyboard(button)).toBe(true);
  });
});
