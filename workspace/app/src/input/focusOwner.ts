/**
 * Who put the focus where it is: the keyboard, or the pointer. Space is a button's own key only
 * when the owner came to the button with the keyboard; after a click with the pointer it pans.
 *
 * The board keeps track of this itself and does not ask the browser (`:focus-visible`): Chrome
 * counts a button clicked with the mouse as the keyboard's from the moment any key goes down,
 * which is just when the board asks.
 */

/**
 * Keys that only change another key. Held alone they do not put the keyboard in use: Cmd goes
 * down to leave the window, and the focus that comes back with the window stays as it was.
 */
const MODIFIERS: ReadonlySet<string> = new Set(['Meta', 'Control', 'Alt', 'Shift']);

/** What the page hears, and the one question it answers. Plain logic: the listeners are in `keys.ts`. */
export interface FocusOwner {
  /** The pointer was pressed, anywhere: it is in use, and no control holds the focus as the keyboard's. */
  pointerDown(): void;
  /** A key went down, by its `key`. Any but a bare modifier puts the keyboard in use. */
  keyDown(key: string): void;
  /** The focus arrived here: it is the keyboard's if the keyboard was the last in use, and nobody's if the pointer was. */
  focusIn(target: EventTarget | null): void;
  /** Does this hold the focus as the keyboard's? */
  byKeyboard(target: EventTarget | null): boolean;
}

/** Who put the focus where it is, on one page. Before any key goes down, nothing holds it as the keyboard's. */
export function createFocusOwner(): FocusOwner {
  let keyboard = false;
  let held: EventTarget | null = null;
  return {
    pointerDown() {
      keyboard = false;
      held = null;
    },
    keyDown(key) {
      if (!MODIFIERS.has(key)) keyboard = true;
    },
    focusIn(target) {
      held = keyboard ? target : null;
    },
    byKeyboard: (target) => target !== null && target === held,
  };
}
