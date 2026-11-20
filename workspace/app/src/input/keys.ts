import { useEffect } from 'react';
import type { Board } from '../board/context';
import type { FocusOwner } from './focusOwner';
import { createFocusOwner } from './focusOwner';
import type { KeyContext, KeyEntry } from './keytable';
import { entryFor, KNOWN_KEYS } from './keytable';
import { keyOf, onMac, pressOf } from './match';

/** Is this where typing goes? Then a key is a letter for it, not a shortcut for the board. */
export const typing = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

/** What a keyboard presses when it has the focus: Space and Enter are theirs. */
const CONTROL = 'button, a[href], select, summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="option"]';

/** Where and when a key was pressed, read from the board as it is now. A control is one the keyboard put the focus on. */
const contextOf = (board: Board, focus: FocusOwner, target: EventTarget | null): KeyContext => ({
  mode: board.mode(),
  typing: typing(target),
  pressOpen: board.pressOpen(),
  noteWaits: board.tool() === 'note',
  control: target instanceof HTMLElement && target.matches(CONTROL) && focus.byKeyboard(target),
  mac: onMac(),
});

/**
 * The board's keys. One listener on the window walks the key table (`keytable.ts`): it finds
 * the one entry a press is for, runs it, and takes the key from the browser.
 *
 * It hears a key last, after everything on the page: a field that takes a key for itself (Esc,
 * Enter) stops it on the way, and Esc during a press is used up before it gets here
 * (`usePressEndings`). A key another handler has already taken (the Talk button takes Space)
 * is left alone. Every other key of a field comes through, so Cmd or Ctrl with plus or minus
 * reaches the board from inside a note too.
 *
 * A key that does something when it comes up (Space, Talk) is let go when its up arrives, and
 * also when the window loses focus or the Cmd key comes up: an up that happens out of the
 * page's sight, or under Cmd on a Mac, never arrives, and the key would stay held.
 *
 * Space is a control's own key only when the keyboard put the focus on it (`focusOwner.ts`). Which
 * of the two is in use is heard first, in the capture phase, so a focus that a handler moves on
 * a key press is the keyboard's too.
 */
export function useKeys(board: Board): void {
  useEffect(() => {
    /** The keys that are down and have something to do when they come up. */
    const held = new Map<string, KeyEntry>();
    const focus = createFocusOwner();
    const pointerUsed = () => focus.pointerDown();
    const keyUsed = (e: KeyboardEvent) => focus.keyDown(e.key);
    const focused = (e: FocusEvent) => focus.focusIn(e.target);

    const down = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const press = pressOf(e, KNOWN_KEYS);
      const entry = entryFor(press, contextOf(board, focus, e.target));
      if (!entry) return;
      if (!(entry.once && press.repeat)) {
        if (entry.up) held.set(press.key, entry);
        if (entry.run(board, press) === false) return;
      }
      if (!entry.passes) e.preventDefault();
    };

    const letGo = () => {
      const entries = [...held.values()];
      held.clear();
      for (const entry of entries) entry.up?.(board);
    };

    const up = (e: KeyboardEvent) => {
      if (e.key === 'Meta') {
        letGo();
        return;
      }
      const key = keyOf(e, KNOWN_KEYS);
      const entry = held.get(key);
      if (!entry) return;
      held.delete(key);
      entry.up?.(board);
    };

    window.addEventListener('pointerdown', pointerUsed, true);
    window.addEventListener('keydown', keyUsed, true);
    window.addEventListener('focusin', focused, true);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', letGo);
    return () => {
      window.removeEventListener('pointerdown', pointerUsed, true);
      window.removeEventListener('keydown', keyUsed, true);
      window.removeEventListener('focusin', focused, true);
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', letGo);
      letGo();
    };
  }, [board]);
}
