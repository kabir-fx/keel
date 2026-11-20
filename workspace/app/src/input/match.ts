/**
 * Which key was pressed, on any keyboard: plain logic, with nothing that listens to the page.
 *
 * The rule is Excalidraw's `matchKey` (packages/common/src/keys.ts, at commit 9fbeaed; MIT,
 * copyright 2020 Excalidraw), written again and widened. Excalidraw falls back to the key's
 * place for z, y and w only; the board does it for every letter and digit, so a tool key works
 * on a Russian or a Greek keyboard as Undo does.
 */

/** The few fields of a keyboard event the board reads. */
export interface KeyInput {
  /** What the key types on the owner's layout: "z", "я", "Escape". */
  readonly key: string;
  /** Where the key sits, named for a US keyboard: "KeyZ", "Digit1". Empty when the browser does not say. */
  readonly code: string;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly repeat: boolean;
}

/** One key going down, as the key table reads it. */
export interface KeyPress {
  /**
   * The key: a lower-case Latin letter, a digit, a sign as it was typed ("+"), or the browser's
   * name for a key that types nothing ("Escape", "ArrowLeft"). Space is " ".
   */
  readonly key: string;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  /** True for the repeats a key sends while it is held down. */
  readonly repeat: boolean;
}

const LATIN_OR_DIGIT = /^[a-z0-9]$/;

/** The letter or the digit a US keyboard has at this place: "z" for "KeyZ", "1" for "Digit1". */
function atPlace(code: string): string | undefined {
  const place = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(code);
  return place ? (place[1]?.toLowerCase() ?? place[2]) : undefined;
}

/**
 * The key a keyboard event is for.
 *
 * - The typed character comes first. A Latin letter or a digit is itself, so on a French
 *   keyboard the key that types "a" is A, wherever it sits. So is a character in `known`: the
 *   signs and the named keys the board binds by what they type ("+", "-", "Escape").
 * - Anything else is read by the key's place: on a Russian keyboard the key in the Z place
 *   types "я", and is Z.
 * - Caps Lock is undone: the case of a letter is never read. Whether Shift is held is the
 *   event's own `shiftKey`.
 */
export function keyOf(e: Pick<KeyInput, 'key' | 'code'>, known: ReadonlySet<string>): string {
  // Lower case can be longer than the letter: "İ", typed with Caps Lock on a Turkish keyboard,
  // becomes "i" and a dot above. The letter is the first of the two.
  const typed = e.key.length === 1 ? e.key.toLowerCase().charAt(0) : e.key;
  if (LATIN_OR_DIGIT.test(typed) || known.has(typed)) return typed;
  return atPlace(e.code) ?? typed;
}

/** A keyboard event as a key press. */
export function pressOf(e: KeyInput, known: ReadonlySet<string>): KeyPress {
  return { key: keyOf(e, known), shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, repeat: e.repeat };
}

/**
 * Is this a Mac? There Cmd is the key for shortcuts, and Ctrl with the main button is a
 * right-click. Asked each time, so a test can say which machine it is on.
 */
export const onMac = (): boolean => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
