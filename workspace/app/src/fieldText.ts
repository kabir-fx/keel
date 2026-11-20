import { FIELD_ROOM, TAB_SPACES } from './input/constants';

/**
 * What the owner types into a field on the board (a note, a label), as plain rules with no page
 * in them: the text made plain, a paste cut to what the field holds, and how tall the field is.
 */

/** The most a note holds, as the contract says. */
export const NOTE_MAX = 2000;
/** The most words a box or an arrow holds, as the contract says. */
export const LABEL_MAX = 200;
/** The most words a pin holds, as the contract says. */
export const PIN_MAX = 400;

/** What the Tab key types: spaces, so the words look the same wherever they are drawn. */
export const TAB_TEXT = ' '.repeat(TAB_SPACES);

/**
 * Text as the board keeps it: every line end is a plain "\n", and a tab is spaces. A field that
 * holds a few words (`lines` false) has no line ends at all: each run of them becomes one space.
 */
export function plainText(text: string, lines: boolean): string {
  const plain = text.replace(/\r\n?/g, '\n').replace(/\t/g, TAB_TEXT);
  return lines ? plain : plain.replace(/\n+/g, ' ');
}

/** How many letters a field still has room for, when `selected` of its `length` are about to be replaced. */
export function roomIn(max: number, length: number, selected: number): number {
  return Math.max(0, max - (length - selected));
}

/** What a paste puts in the field. */
export interface Pasted {
  text: string;
  /** True when the field could not hold all of it. */
  cut: boolean;
}

/**
 * Fit pasted text into a field with room for `room` letters: made plain, then cut to the room.
 * The cut never splits a letter that takes two units (an emoji), so the field never holds half
 * of one.
 */
export function fitPaste(pasted: string, room: number, lines: boolean): Pasted {
  const text = plainText(pasted, lines);
  if (text.length <= room) return { text, cut: false };
  let end = Math.max(0, room);
  const last = end > 0 ? text.charCodeAt(end - 1) : 0;
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), cut: true };
}

/**
 * The height of a field whose text is `text` pixels tall: a little taller (`FIELD_ROOM`), in
 * whole pixels. `spare` is the part that is room and not text: the field takes it back from the
 * box round it, so the note's paper stays the height of its words.
 */
export function fieldHeight(text: number): { height: number; spare: number } {
  const height = Math.ceil(text * FIELD_ROOM);
  return { height, spare: height - text };
}
