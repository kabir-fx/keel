import { describe, expect, it } from 'vitest';
import type { Box } from '@keel/protocol';
import type { Where } from '../src/layout';
import { landsWhereItWas, movableOf, movedBox, resizable, resizedBox, tiedTo } from '../src/select/grab';
import { CH, note, openBoard, placeAt, text } from './helpers';

/**
 * What a move takes with it and who may move and resize, as plain rules on the board's state:
 * the rules Select and the arrow keys share.
 */

const arrow = (id: string, ends: Record<string, unknown>) => ({ type: 'item.add', chapter: CH, item: { id, kind: 'arrow', box: [200, 50, 200, 0], from: [0, 0], to: [200, 0], ...ends } });
const lasso = (id: string, round: string) => ({ type: 'item.add', chapter: CH, item: { id, kind: 'lasso', box: [150, 0, 300, 100], path: [0, 0, 300, 0, 300, 100, 0, 100], targets: [{ item: round }] } });

describe('what is worked out again while a thing moves', () => {
  const b = openBoard();
  b.must('owner', note('n1', [0, 0, 200, 100]));
  b.must('owner', note('n2', [400, 0, 200, 100]));
  b.must('owner', note('n3', [800, 0, 200, 100]));
  b.must('owner', arrow('from-n1', { fromTarget: { item: 'n1' } }));
  b.must('owner', arrow('to-n1', { toTarget: { item: 'n1' } }));
  b.must('owner', arrow('n2-to-n3', { fromTarget: { item: 'n2' }, toTarget: { item: 'n3' } }));
  b.must('owner', arrow('free', {}));
  b.must('owner', lasso('round-n1', 'n1'));
  b.must('owner', lasso('round-arrow', 'from-n1'));
  b.must('owner', lasso('round-n3', 'n3'));
  const tied = (...moving: string[]) => [...tiedTo(b.state, new Set(moving))].sort();

  it('an arrow tied to it by its start alone, and one tied by its end alone', () => {
    expect(tied('n1')).toContain('from-n1');
    expect(tied('n1')).toContain('to-n1');
  });

  it('a lasso round it, and a lasso round an arrow that is worked out again', () => {
    expect(tied('n1')).toContain('round-n1');
    expect(tied('n1')).toContain('round-arrow');
  });

  it('an arrow that moves itself; and nothing tied to what stays', () => {
    expect(tied('n1')).toEqual(['from-n1', 'round-arrow', 'round-n1', 'to-n1']);
    expect(tied('free')).toEqual(['free']);
    expect(tied('n2')).toEqual(['n2-to-n3']);
  });
});

describe('who may move and resize: the owner, and no one who only looks', () => {
  const b = openBoard();
  b.must('owner', note('n1', [0, 0, 200, 100]));
  b.must('owner', { type: 'item.add', chapter: CH, item: { id: 'b1', kind: 'box', box: [0, 200, 100, 100] } });
  const page = (isOwner: boolean, selection: string[] = []) => ({ isOwner, state: () => b.state, selection: () => selection });

  it('the owner moves a note; a viewer moves nothing, by a drag or by the arrow keys', () => {
    expect(movableOf(page(true), ['n1', 'b1'])).toEqual(['n1', 'b1']);
    expect(movableOf(page(false), ['n1', 'b1'])).toEqual([]);
  });

  it('the owner resizes a box and a note, the note in width only; a viewer gets no handles', () => {
    expect(resizable(page(true, ['b1']))).toEqual({ id: 'b1', widthOnly: false });
    expect(resizable(page(true, ['n1']))).toEqual({ id: 'n1', widthOnly: true });
    expect(resizable(page(false, ['b1']))).toBeUndefined();
    expect(resizable(page(false, ['n1']))).toBeUndefined();
  });
});

describe('the box to post for a thing the hand moved or resized, in the thing’s own units', () => {
  // The card was 380 by 200 when the box and the note were put on it, and is 418 by 220 now: the
  // box is drawn 1.1 times its size, and the note at its own size, 1.1 times as far into the card.
  const GREW = 418 / 380;
  const b = openBoard();
  b.must('owner', note('m1', [0, 0, 320, 100]));
  b.must('agent', text('a1', { answers: ['m1'] }));
  b.must('owner', placeAt('a1', [400, 0, 418, 220]));
  b.must('owner', { type: 'item.add', chapter: CH, item: { id: 'b1', kind: 'box', box: [300, 250, 100, 50], anchor: { item: 'a1', box: [300, 0, 380, 200] } } });
  b.must('owner', note('n2', [320, 100, 200, 80], { anchor: { item: 'a1', box: [300, 0, 380, 200] } }));
  b.must('owner', { type: 'item.add', chapter: CH, item: { id: 'free', kind: 'box', box: [0.5, 300, 100.5, 50] } });
  const where = (ahead: Array<[string, Box]> = []): Where => ({ state: b.state, boxes: new Map(ahead), subs: new Map() });
  /** The box on the card as it is drawn, and the note. */
  const BOX: Box = [400, 275, 110, 55];
  const NOTE: Box = [422, 110, 200, 80];

  it('a side the hand left is posted as it is stored, not as it comes back from drawn units; the side it moved, where it left it', () => {
    // 250 times 1.1 and back is 249.99999999999997.
    expect(resizedBox(where(), 'b1', 'e', BOX, [400, 275, 130, 55], false)).toEqual([300, 250, 130 / GREW, 50]);
    expect(resizedBox(where(), 'b1', 's', BOX, [400, 275, 110, 77], false)).toEqual([300, 250, 100, 77 / GREW]);
  });

  it('it lands as it is drawn: its size on a whole unit, and the edge the resize held where it was drawn', () => {
    const box = resizedBox(where(), 'b1', 'w', BOX, [379.7, 275, 130.3, 55], false)!;
    expect(box).toEqual([300 + (380 - 400) / GREW, 250, 130 / GREW, 50]);
    // Drawn again from what is posted, its right edge is where it was: 510.
    expect(400 + (box[0] - 300) * GREW + box[2] * GREW).toBeCloseTo(510, 9);
  });

  it('a note on such a card keeps its size and only moves with it: resized by its left edge, its right edge stays where it is drawn', () => {
    const box = resizedBox(where(), 'n2', 'w', NOTE, [372, 110, 250, 80], false)!;
    expect(box).toEqual([300 + (372 - 400) / GREW, 100, 250, 80]);
    // Drawn again: 400 + (x - 300) * 1.1 is its left edge, and its width is its own.
    expect(400 + (box[0] - 300) * GREW + box[2]).toBeCloseTo(622, 9);
    // By its right edge its place is the one stored, to the last digit.
    expect(resizedBox(where(), 'n2', 'e', NOTE, [422, 110, 260.4, 80], false)).toEqual([320, 100, 260, 80]);
  });

  it('a resize that comes back to within half a unit lands on the box it has', () => {
    const box = resizedBox(where(), 'b1', 'se', BOX, [400, 275, 110.4, 54.6], false);
    expect(box).toEqual([300, 250, 100, 50]);
    expect(landsWhereItWas(where(), 'b1', box!)).toBe(true);
    expect(landsWhereItWas(where(), 'b1', resizedBox(where(), 'b1', 'se', BOX, [400, 275, 110.6, 55], false)!)).toBe(false);
  });

  it('a thing with no card under it is posted as it is drawn, its fractions kept on the sides the hand left', () => {
    expect(resizedBox(where(), 'free', 's', [0.5, 300, 100.5, 50], [0.5, 300, 100.5, 60.2], false)).toEqual([0.5, 300, 100.5, 60]);
  });

  it('the box it has is the one drawn ahead of the log, when there is one', () => {
    expect(landsWhereItWas(where(), 'free', [0.5, 300, 100.5, 50])).toBe(true);
    const ahead = where([['free', [10, 300, 100.5, 50]]]);
    expect(landsWhereItWas(ahead, 'free', [0.5, 300, 100.5, 50])).toBe(false);
    expect(landsWhereItWas(ahead, 'free', [10, 300, 100.5, 50])).toBe(true);
    expect(landsWhereItWas(ahead, 'free', [10, 300, 100.5, 51])).toBe(false);
    expect(resizedBox(ahead, 'free', 'n', [10, 300, 100.5, 50], [10, 290.3, 100.5, 59.7], false)).toEqual([10, 290, 100.5, 60]);
  });

  it('a thing that is not on the board has no box to post, and lands nowhere', () => {
    expect(resizedBox(where(), 'gone', 'e', BOX, [400, 275, 130, 55], false)).toBeUndefined();
    expect(landsWhereItWas(where(), 'gone', BOX)).toBe(false);
  });

  it('a move within half a unit of where the thing is lands on the box it has; half a unit on, it does not', () => {
    const near = movedBox(where(), 'b1', [400.4, 274.6, 110, 55]);
    expect(near && landsWhereItWas(where(), 'b1', near)).toBe(true);
    const on = movedBox(where(), 'b1', [400.6, 275, 110, 55]);
    expect(on).toEqual([301, 250, 100, 50]);
    expect(on && landsWhereItWas(where(), 'b1', on)).toBe(false);
  });
});
