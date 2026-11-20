import type { BoardState, Box } from '@keel/protocol';
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useAhead } from '../src/board/ahead';
import { useShown } from '../src/board/shown';
import type { Board } from './helpers';
import { CH, note, openBoard, placeAt, text } from './helpers';

/**
 * What `useShown` keeps from one render to the next. A memo on an item holds only while its box,
 * its markings, its outline and its ends are the very objects of the render before, so each is
 * kept when it is equal. And kept only then: something equal in size alone, or nearly equal,
 * must be a new object, or the item would stay as it was drawn.
 */

afterEach(cleanup);

const NO_SUBS: ReadonlyMap<string, Box> = new Map();

/** `useShown` over a board, drawn again each time the board has moved on. */
function shownOf(b: Board) {
  const hook = renderHook(({ state }: { state: BoardState }) => useShown(state, useAhead(), NO_SUBS, undefined), { initialProps: { state: b.state } });
  return {
    get now() {
      return hook.result.current;
    },
    /** Draw again from the board as it is now: every event since the last time lands in one render. */
    again() {
      hook.rerender({ state: b.state });
      return hook.result.current;
    },
  };
}

/** The owner's pen on one question of the first card: a cross or a circle. */
const pen = (id: string, hint: 'cross' | 'circle', sub: string) => ({
  type: 'item.add',
  chapter: CH,
  item: { id, kind: 'ink', box: [0, 0, 10, 10], strokes: [{ pts: [0, 0, 10, 10] }], targets: [{ item: 'a1', sub }], hint },
});

/** Two notes, a card with two questions that answers the first, and a card that answers the second. */
function board() {
  const b = openBoard();
  b.must('owner', note('m1', [0, 0, 320, 100]));
  b.must('owner', note('m2', [0, 600, 320, 100]));
  b.must('agent', { type: 'item.add', chapter: CH, item: { id: 'a1', kind: 'picture', picture: { kind: 'text', title: 'One', questions: ['Why?', 'How?'] }, answers: ['m1'] } });
  b.must('owner', placeAt('a1', [400, 0, 380, 200]));
  b.must('agent', text('a2', { answers: ['m2'] }));
  b.must('owner', placeAt('a2', [400, 600, 380, 200]));
  return b;
}

const elsewhere = note('m9', [0, 1200, 320, 100]);

describe('a box', () => {
  it('is kept when its numbers are the same, and new when one of them moved at all', () => {
    const b = board();
    // A note that hangs on the first card: its box is worked out from the card's on every state.
    b.must('owner', note('on', [420, 20, 200, 60], { anchor: { item: 'a1', box: [400, 0, 380, 200] } }));
    const shown = shownOf(b);
    const before = shown.now.boxes;
    b.must('owner', elsewhere);
    expect(shown.again().boxes.get('a1')).toBe(before.get('a1'));
    expect(shown.now.boxes.get('m1')).toBe(before.get('m1'));
    expect(shown.now.boxes.get('on')).toBe(before.get('on'));
    // One unit to the right: a small move is still a move.
    b.must('owner', placeAt('m1', [1, 0, 320, 100]));
    expect(shown.again().boxes.get('m1')).toEqual([1, 0, 320, 100]);
    expect(shown.now.boxes.get('m1')).not.toBe(before.get('m1'));
    expect(shown.now.boxes.get('a1')).toBe(before.get('a1'));
  });
});

describe('the markings of a picture', () => {
  it('are kept when they say the same, and new when they say something else at the same length', () => {
    const b = board();
    b.must('owner', pen('x1', 'cross', 'q:1'));
    const shown = shownOf(b);
    const before = shown.now.marks.a1;
    expect(before).toEqual({ crossed: ['q:1'], circled: [] });
    b.must('owner', elsewhere);
    expect(shown.again().marks.a1).toBe(before);
    // The cross comes off one question and goes on the other, in one render: still one cross.
    b.must('owner', { type: 'item.remove', item: 'x1' });
    b.must('owner', pen('x2', 'cross', 'q:2'));
    expect(shown.again().marks.a1).toEqual({ crossed: ['q:2'], circled: [] });
    // The same for a circle, with the cross left where it is.
    b.must('owner', pen('o1', 'circle', 'q:1'));
    expect(shown.again().marks.a1).toEqual({ crossed: ['q:2'], circled: ['q:1'] });
    b.must('owner', { type: 'item.remove', item: 'o1' });
    b.must('owner', pen('o2', 'circle', 'q:2'));
    expect(shown.again().marks.a1).toEqual({ crossed: ['q:2'], circled: ['q:2'] });
  });
});

describe('the ends of an arrow', () => {
  it('are kept when neither moved, and new when only the far one did', () => {
    const b = board();
    b.must('owner', { type: 'item.add', chapter: CH, item: { id: 'r1', kind: 'arrow', box: [590, 200, 0, 400], from: [0, 0], to: [0, 400], fromTarget: { item: 'a1' }, toTarget: { item: 'a2' } } });
    const shown = shownOf(b);
    const before = shown.now.ends.get('r1')!;
    b.must('owner', elsewhere);
    expect(shown.again().ends.get('r1')).toBe(before);
    b.must('owner', placeAt('a2', [400, 700, 380, 200]));
    const after = shown.again().ends.get('r1')!;
    expect(after).not.toBe(before);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toEqual([before[1][0], before[1][1] + 100]);
  });
});

describe('the outline of a lasso', () => {
  /** A lasso round the first card and a small note that lies on it. */
  function lassoed() {
    const b = board();
    b.must('owner', note('in', [450, 50, 100, 60]));
    b.must('owner', { type: 'item.add', chapter: CH, item: { id: 'l1', kind: 'lasso', box: [380, -20, 420, 240], path: [0, 0, 420, 0, 420, 240, 0, 240], targets: [{ item: 'a1' }, { item: 'in' }] } });
    return b;
  }

  it('is kept when nothing it holds has moved', () => {
    const b = lassoed();
    const shown = shownOf(b);
    const before = shown.now.outlines.get('l1')!;
    expect(before.picked).toBe(2);
    b.must('owner', elsewhere);
    expect(shown.again().outlines.get('l1')).toBe(before);
  });

  it('is new when what it holds has moved, though the shape has as many corners', () => {
    const b = lassoed();
    const shown = shownOf(b);
    const before = shown.now.outlines.get('l1')!;
    b.must('owner', placeAt('a1', [400, 10, 380, 200]));
    b.must('owner', placeAt('in', [450, 60, 100, 60]));
    const after = shown.again().outlines.get('l1')!;
    expect(after.loops.map((l) => l.length)).toEqual(before.loops.map((l) => l.length));
    expect(after.loops).not.toEqual(before.loops);
    expect(after).not.toBe(before);
  });

  it('is new when it holds one fewer, though the shape is the same', () => {
    const b = lassoed();
    const shown = shownOf(b);
    const before = shown.now.outlines.get('l1')!;
    // The note lay inside the card, so the outline round both is the outline round the card.
    b.must('owner', { type: 'item.remove', item: 'in' });
    const after = shown.again().outlines.get('l1')!;
    expect(after.loops).toEqual(before.loops);
    expect(after.picked).toBe(1);
  });
});

describe('the cards a lineage arrow goes round', () => {
  it('are the same cards when none moved, and new ones when one did', () => {
    const b = board();
    const shown = shownOf(b);
    const before = shown.now.cards;
    b.must('owner', { type: 'chapter.rename', chapter: CH, title: 'Renamed' });
    expect(shown.again().cards).toBe(before);
    // As many cards as before, one of them somewhere else.
    b.must('owner', placeAt('m2', [0, 700, 320, 100]));
    const after = shown.again().cards;
    expect(after.size).toBe(before.size);
    expect(after).not.toBe(before);
    expect(after.get('m2')).toEqual([0, 700, 320, 100]);
  });
});

describe('a read chip', () => {
  it('is kept while its mark stays where it is, and new when the mark moves', () => {
    const b = board();
    b.must('agent', { type: 'answer', answers: ['m2'], read: 'Open the bridge' });
    const shown = shownOf(b);
    const [before] = shown.now.chips;
    expect(before).toMatchObject({ read: 'Open the bridge', mark: 'm2', at: [160, 706] });
    b.must('owner', elsewhere);
    expect(shown.again().chips).toEqual([before]);
    expect(shown.now.chips[0]).toBe(before);
    b.must('owner', placeAt('m2', [0, 640, 320, 100]));
    expect(shown.again().chips[0]).not.toBe(before);
    expect(shown.now.chips[0]).toMatchObject({ mark: 'm2', at: [160, 746] });
  });
});
