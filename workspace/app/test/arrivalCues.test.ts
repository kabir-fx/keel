import type { BoardState, Box, Id } from '@keel/protocol';
import { describe, expect, it } from 'vitest';
import type { Moment } from '../src/arrival/cues';
import { looking, readCues } from '../src/arrival/cues';
import type { Connection } from '../src/source';
import { note, openBoard, placeAt, text } from './helpers';

/**
 * The cues: what gets drawn on, read from two moments of the board. Each moment is the state and
 * the boxes as `useShown` would give them: each item's own box, and a placeholder's spot on this
 * page where it has one.
 */

/** The agent draws a picture for the note, and the page places it. */
function drawn(b: ReturnType<typeof openBoard>, id: Id, box: Box): void {
  b.must('agent', text(id, { answers: ['m1'] }));
  b.must('owner', { type: 'item.place', item: id, box });
}

interface Read {
  connection?: Connection;
  fitted?: ReadonlySet<Id> | null;
  /** Placeholders at a spot of this page's own. */
  spots?: ReadonlyMap<Id, Box>;
  /** The read chips on the board. */
  chips?: readonly string[];
}

const moment = (state: BoardState, { connection = 'open', spots = new Map(), chips = [] }: Read): Moment => {
  const boxes = new Map<Id, Box>();
  for (const id of state.itemOrder) {
    const s = state.items[id]!;
    if (!s.removed && s.item.box) boxes.set(id, s.item.box);
  }
  for (const [id, box] of spots) boxes.set(id, box);
  return { state, boxes, spots, chips: new Set(chips), connection };
};

/** A board with the owner's note on it, opened and fitted: nothing on it yet is news. */
function opened() {
  const b = openBoard();
  b.must('owner', note('m1', [0, 0, 320, 100]));
  const looked = looking();
  const known = new Set<Id>();
  let before: Moment | null = null;
  /** Read the cues of the board as it is now. */
  const read = (r: Read = {}) => {
    const now = moment(b.state, r);
    const cues = readCues(before, now, r.fitted === undefined ? known : r.fitted, looked);
    before = now;
    return cues;
  };
  read();
  return { b, read, known };
}

const SPOT: Box = [400, 0, 360, 120];
const PLACED: Box = [400, 0, 380, 152];

describe('the cues of an arrival', () => {
  it('a finished picture of the agent\'s that gets its place for the first time is placed', () => {
    const { b, read } = opened();
    b.must('agent', text('a1', { answers: ['m1'] }));
    expect(read()).toEqual([]);
    b.must('owner', { type: 'item.place', item: 'a1', box: PLACED });
    expect(read()).toEqual([{ kind: 'placed', id: 'a1' }]);
    // Once: the next moment has no cue for it.
    expect(read()).toEqual([]);
  });

  it('several pictures placed in one moment are each placed, in the order the board holds them', () => {
    const { b, read } = opened();
    b.must('agent', text('a1', { answers: ['m1'] }));
    b.must('agent', text('a2', { answers: ['m1'] }));
    b.must('owner', { type: 'item.place', item: 'a2', box: [400, 300, 380, 152] });
    b.must('owner', { type: 'item.place', item: 'a1', box: PLACED });
    expect(read()).toEqual([
      { kind: 'placed', id: 'a1' },
      { kind: 'placed', id: 'a2' },
    ]);
  });

  it('none on the board\'s first moment, nor before its first view is fitted', () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 320, 100]));
    drawn(b, 'a1', PLACED);
    expect(readCues(null, moment(b.state, {}), new Set(), looking())).toEqual([]);
    expect(readCues(moment(b.state, {}), moment(b.state, {}), null, looking())).toEqual([]);
  });

  it('none for a picture that was on the board when it opened', () => {
    const { b, read, known } = opened();
    drawn(b, 'a1', PLACED);
    known.add('a1');
    expect(read()).toEqual([]);
  });

  it('none for what came with the server\'s init after a lost connection, then or once it is placed: pictures and chips', () => {
    const { b, read } = opened();
    expect(read({ connection: 'closed' })).toEqual([]);
    drawn(b, 'a1', PLACED);
    b.must('agent', text('a2', { answers: ['m1'] }));
    b.must('agent', { type: 'answer', answers: ['m1'], read: 'a remark' });
    expect(read({ chips: ['e9'] })).toEqual([]);
    b.must('owner', { type: 'item.place', item: 'a2', box: [400, 300, 380, 152] });
    expect(read({ chips: ['e9'] })).toEqual([]);
    // What comes after the resync is news again.
    drawn(b, 'a3', [400, 600, 380, 152]);
    expect(read({ chips: ['e9'] })).toEqual([{ kind: 'placed', id: 'a3' }]);
  });

  it('none for a move or a resize by the owner, nor for a picture brought back', () => {
    const { b, read } = opened();
    drawn(b, 'a1', PLACED);
    expect(read()).toHaveLength(1);
    b.must('owner', placeAt('a1', [600, 200, 400, 160]));
    expect(read()).toEqual([]);
    b.must('owner', { type: 'item.remove', item: 'a1' });
    expect(read()).toEqual([]);
    b.must('owner', { type: 'item.restore', item: 'a1' });
    expect(read()).toEqual([]);
  });

  it('none for the owner\'s marks', () => {
    const { b, read } = opened();
    b.must('owner', note('m2', [0, 200, 320, 100]));
    expect(read()).toEqual([]);
  });
});

describe('the cues of a placeholder', () => {
  it('a placeholder at its spot on this page arrives as a picture does', () => {
    const { b, read } = opened();
    b.must('agent', text('p1', { answers: ['m1'], status: 'drawing' }));
    expect(read()).toEqual([]);
    expect(read({ spots: new Map([['p1', SPOT]]) })).toEqual([{ kind: 'placed', id: 'p1' }]);
    expect(read({ spots: new Map([['p1', SPOT]]) })).toEqual([]);
  });

  it('finished, it is held while it is still at its spot, and finished from where it was drawn once it has its place', () => {
    const { b, read } = opened();
    b.must('agent', text('p1', { answers: ['m1'], status: 'drawing' }));
    read({ spots: new Map([['p1', SPOT]]) });
    b.must('agent', { type: 'item.update', item: 'p1', patch: { picture: { kind: 'text', title: 'done' }, status: 'done' } });
    expect(read({ spots: new Map([['p1', SPOT]]) })).toEqual([{ kind: 'settling', id: 'p1' }]);
    // On a live board it is measured again, with no place for a moment: nothing then.
    expect(read()).toEqual([]);
    b.must('owner', { type: 'item.place', item: 'p1', box: PLACED });
    expect(read()).toEqual([{ kind: 'finished', id: 'p1', from: SPOT }]);
    expect(read()).toEqual([]);
  });

  it('a placeholder there when the board opened, or out of view, is finished all the same', () => {
    const { b, read, known } = opened();
    b.must('agent', text('p1', { answers: ['m1'], status: 'drawing' }));
    known.add('p1');
    expect(read({ spots: new Map([['p1', SPOT]]) })).toEqual([]);
    b.must('agent', { type: 'item.update', item: 'p1', patch: { picture: { kind: 'text', title: 'done' }, status: 'done' } });
    b.must('owner', { type: 'item.place', item: 'p1', box: PLACED });
    expect(read()).toEqual([{ kind: 'finished', id: 'p1', from: SPOT }]);
  });

  it('a placeholder taken off the board is forgotten', () => {
    const { b, read } = opened();
    b.must('agent', text('p1', { answers: ['m1'], status: 'drawing' }));
    read({ spots: new Map([['p1', SPOT]]) });
    b.must('agent', { type: 'item.remove', item: 'p1' });
    expect(read()).toEqual([]);
  });
});

describe('the cues of a redraw', () => {
  it('the agent\'s new spec for a finished picture on the board is a redraw', () => {
    const { b, read } = opened();
    drawn(b, 'a1', PLACED);
    read();
    b.must('agent', { type: 'item.update', item: 'a1', patch: { picture: { kind: 'text', title: 'again' } } });
    expect(read()).toEqual([{ kind: 'redrawn', id: 'a1' }]);
    expect(read()).toEqual([]);
  });

  it('no redraw for a change that is not of its spec, for a picture with no place, or for one taken off', () => {
    const { b, read } = opened();
    drawn(b, 'a1', PLACED);
    read();
    b.must('owner', placeAt('a1', [700, 0, 380, 152]));
    expect(read()).toEqual([]);
    b.must('agent', { type: 'item.update', item: 'a1', patch: { answers: ['m1'] } });
    expect(read()).toEqual([]);
    b.must('agent', text('a2', { answers: ['m1'] }));
    read();
    b.must('agent', { type: 'item.update', item: 'a2', patch: { picture: { kind: 'text', title: 'unplaced' } } });
    expect(read()).toEqual([]);
  });
});

describe('the cues of a read chip', () => {
  it('a chip on the board for the first time is read, once', () => {
    const { b, read } = opened();
    b.must('agent', { type: 'answer', answers: ['m1'], read: 'a remark' });
    expect(read({ chips: ['e4'] })).toEqual([{ kind: 'read', id: 'e4' }]);
    expect(read({ chips: ['e4'] })).toEqual([]);
  });

  it('none for a chip there when the first view is fitted', () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 320, 100]));
    const looked = looking();
    const now = moment(b.state, { chips: ['e4'] });
    expect(readCues(null, now, null, looked)).toEqual([]);
    expect(readCues(now, now, new Set(), looked)).toEqual([]);
    expect(readCues(now, now, new Set(), looked)).toEqual([]);
  });

  it('the first moment read after the first view is fitted: what was there before is not news, what came with it is', () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 320, 100]));
    const looked = looking();
    const opening = moment(b.state, { chips: ['e4'] });
    expect(readCues(null, opening, null, looked)).toEqual([]);
    // Nothing changed while the view was fitted; the next change brings a placeholder and a chip.
    b.must('agent', text('p1', { answers: ['m1'], status: 'drawing' }));
    const later = moment(b.state, { chips: ['e4', 'e7'], spots: new Map([['p1', SPOT]]) });
    expect(readCues(opening, later, new Set(), looked)).toEqual([
      { kind: 'placed', id: 'p1' },
      { kind: 'read', id: 'e7' },
    ]);
  });

  it('none for a chip there on the board\'s first moment', () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 320, 100]));
    const looked = looking();
    readCues(null, moment(b.state, { chips: ['e4'] }), new Set(), looked);
    expect(readCues(moment(b.state, { chips: ['e4'] }), moment(b.state, { chips: ['e4'] }), new Set(), looked)).toEqual([]);
  });
});
