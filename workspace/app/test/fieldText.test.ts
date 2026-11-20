import { describe, expect, it } from 'vitest';
import { LABEL_MAX, NOTE_MAX, PIN_MAX, TAB_TEXT, fieldHeight, fitPaste, plainText, roomIn } from '../src/fieldText';
import { FIELD_ROOM, TAB_SPACES } from '../src/input/constants';

/** The plain rules of what the owner types into a field: no page in them. */

describe('text made plain', () => {
  it('makes every line end a plain one, and every tab spaces', () => {
    expect(plainText('one\r\ntwo\rthree\nfour', true)).toBe('one\ntwo\nthree\nfour');
    expect(plainText('a\tb', true)).toBe(`a${TAB_TEXT}b`);
    expect(TAB_TEXT).toBe(' '.repeat(TAB_SPACES));
    // A Windows line end is one line end, not two.
    expect(plainText('a\r\n\r\nb', true)).toBe('a\n\nb');
  });

  it('a field of a few words has no line ends: each run of them is one space', () => {
    expect(plainText('one\r\ntwo\n\n\nthree', false)).toBe('one two three');
    expect(plainText('a\tb', false)).toBe(`a${TAB_TEXT}b`);
  });

  it('leaves plain text as it is', () => {
    const text = 'Can the engine stream to every client at once?\n  yes';
    expect(plainText(text, true)).toBe(text);
  });
});

describe('the room left in a field', () => {
  it('is what the field holds, less what is in it and will stay', () => {
    expect(roomIn(2000, 0, 0)).toBe(2000);
    expect(roomIn(2000, 1990, 0)).toBe(10);
    // What is selected is replaced by the paste, so it is room too.
    expect(roomIn(2000, 1990, 40)).toBe(50);
    expect(roomIn(2000, 2000, 0)).toBe(0);
    expect(roomIn(200, 250, 0)).toBe(0);
  });

  it('the fields hold what the contract says', () => {
    expect([NOTE_MAX, LABEL_MAX, PIN_MAX]).toEqual([2000, 200, 400]);
  });
});

describe('a paste', () => {
  it('that fits goes in whole, made plain, and is not cut', () => {
    expect(fitPaste('one\r\n\ttwo', 100, true)).toEqual({ text: `one\n${TAB_TEXT}two`, cut: false });
  });

  it('is cut at the room left, one letter either side of it', () => {
    expect(fitPaste('abcde', 5, true)).toEqual({ text: 'abcde', cut: false });
    expect(fitPaste('abcdef', 5, true)).toEqual({ text: 'abcde', cut: true });
    expect(fitPaste('abcd', 5, true)).toEqual({ text: 'abcd', cut: false });
  });

  it('is measured after it is made plain: a tab counts as its spaces, a Windows line end as one', () => {
    expect(fitPaste('a\tb', 1 + TAB_SPACES, true)).toEqual({ text: `a${TAB_TEXT}`, cut: true });
    expect(fitPaste('a\r\nb', 3, true)).toEqual({ text: 'a\nb', cut: false });
  });

  it('into a full field puts nothing in, and says it was cut', () => {
    expect(fitPaste('more', 0, true)).toEqual({ text: '', cut: true });
    expect(fitPaste('more', -3, true)).toEqual({ text: '', cut: true });
  });

  it('never leaves half of a letter that takes two units', () => {
    const face = '\u{1F600}';
    expect(face).toHaveLength(2);
    expect(fitPaste(`ab${face}`, 3, true)).toEqual({ text: 'ab', cut: true });
    expect(fitPaste(`ab${face}`, 4, true)).toEqual({ text: `ab${face}`, cut: false });
    expect(fitPaste(`${face}${face}`, 3, true)).toEqual({ text: face, cut: true });
  });

  it('knows the first half of a two-unit letter by its whole range, one unit either side of it', () => {
    const at = (unit: number) => String.fromCharCode(unit);
    // The first and the last of them: U+10000 and U+10FFFF.
    for (const [first, second] of [[0xd800, 0xdc00], [0xdbff, 0xdfff]] as const) {
      expect(fitPaste(`ab${at(first)}${at(second)}`, 3, true)).toEqual({ text: 'ab', cut: true });
    }
    // Just outside: a letter of its own, and a second half, are kept whole.
    for (const outside of [0xd7ff, 0xdc00]) expect(fitPaste(`ab${at(outside)}c`, 3, true)).toEqual({ text: `ab${at(outside)}`, cut: true });
  });

  it('into a field of a few words is one line', () => {
    expect(fitPaste('one\r\ntwo\nthree', 100, false)).toEqual({ text: 'one two three', cut: false });
  });
});

describe('the height of a field', () => {
  it('is its text and 5% more, in whole pixels, and says how much of it is room', () => {
    expect(FIELD_ROOM).toBe(1.05);
    expect(fieldHeight(30)).toEqual({ height: 32, spare: 2 });
    expect(fieldHeight(600)).toEqual({ height: 630, spare: 30 });
    expect(fieldHeight(0)).toEqual({ height: 0, spare: 0 });
  });

  it('less the room is the height of the text again, so the paper round the field does not grow', () => {
    for (const text of [1, 29, 30, 31, 47, 60, 300, 1234]) {
      const { height, spare } = fieldHeight(text);
      expect(height - spare).toBe(text);
      expect(height).toBeGreaterThanOrEqual(text * FIELD_ROOM);
      expect(height).toBeLessThan(text * FIELD_ROOM + 1);
    }
  });
});
