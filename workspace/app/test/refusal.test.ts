import { describe, expect, it } from 'vitest';
import { plainRefusal } from '../src/refusal';

describe('a refusal, in plain words', () => {
  it.each([
    ['item.text: Too big: expected string to have <=2000 characters', 'That is too long for the board: it keeps at most 2,000 characters here. Shorten it and try again.'],
    ['patch.text: Too big: expected string to have <=400 characters', 'That is too long for the board: it keeps at most 400 characters here. Shorten it and try again.'],
    ['item.box.0: Too big: expected number to be <=1000000', 'That is too far out on the board to keep. Draw it nearer the rest.'],
    ['item.strokes: Too big: expected array to have <=120 items', 'That is too many strokes for one mark. Lift the pen, wait a moment, and go on: the rest becomes a second mark.'],
    ['item.strokes.0.pts: Too big: expected array to have <=6000 items', 'That stroke is too long for one mark. Draw it in shorter strokes.'],
    ['item.targets: Too big: expected array to have <=40 items', 'That mark covers too many things at once. Draw it round fewer.'],
    ['item.id: an id is 1 to 48 characters of a-z, 0-9 and "-"', 'The board could not name that mark. Reload the page and try again.'],
    ['item.mystery: Invalid input', 'The board could not read that, so it was not saved. Reload the page and try again.'],
  ])('%s', (reason, plain) => {
    expect(plainRefusal({ rule: 'shape', reason })).toBe(plain);
  });

  it('keeps a sentence the rules wrote for people, and rewords the common ones', () => {
    expect(plainRefusal({ rule: 'shape', reason: 'A note needs some text. Take it off the board instead.' })).toBe('A note needs some text. Take it off the board instead.');
    expect(plainRefusal({ rule: 'R4', reason: 'Item id "m12" is used already. An id is used once.' })).toBe('Another open tab used the same name a moment ago. Try again.');
    expect(plainRefusal({ rule: 'R7', reason: 'There is no item "m3" on the board.' })).toBe('That is not on the board any more, so this was not saved.');
    expect(plainRefusal({ rule: 'offline', reason: 'The board server is not connected.' })).toBe('The board server is not connected.');
  });
});
