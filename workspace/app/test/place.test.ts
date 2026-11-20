import type { BoardState, Box, Id } from '@keel/protocol';
import { replay } from '@keel/protocol';
import { describe, expect, it } from 'vitest';
import { overlaps, padBox } from '../src/geometry';
import { shownBoxOf } from '../src/layout';
import { edgeEnds, primarySource } from '../src/lineage';
import { anchorOf, beside, CLEAR, GAP_BELOW, GAP_RIGHT, isClear, nearestClear, place, placeAll, REACH, SIDES, sidesFrom, STEP, unplaced } from '../src/place';
import { CH, lanes, note, openBoard, placeAt, text } from './helpers';

const fromLog = (state: BoardState) => (id: Id) => {
  const s = state.items[id];
  return s && !s.removed ? s.item.box : undefined;
};

describe('the anchor of a picture', () => {
  it('for a small picture: place.near first, then the first mark it answers, then the first from', () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 300, 100]));
    b.must('owner', note('m2', [0, 400, 300, 100], { on: { item: 'm1' } }));
    b.must('agent', text('a1', { answers: ['m1'] }));
    b.must('owner', placeAt('a1', [400, 0, 300, 100]));
    b.must('agent', text('a2', { answers: ['m2'], from: ['a1'], place: { near: 'a1' } }));
    b.must('agent', text('a3', { answers: ['m2'], from: ['a1'] }));
    b.must('agent', text('a4', { answers: ['m2'] }));
    const s = b.state;
    const boxOf = fromLog(s);
    expect(anchorOf(s, 'a2', boxOf)).toBe('a1');
    // A reply sits by the mark it answers, even one stuck on something else.
    expect(anchorOf(s, 'a3', boxOf)).toBe('m2');
    expect(anchorOf(s, 'a4', boxOf)).toBe('m2');
    // A mark that is not drawn any more is passed over.
    b.must('owner', { type: 'item.remove', item: 'm2' });
    expect(anchorOf(b.state, 'a3', fromLog(b.state))).toBe('a1');
  });

  it('for a wide picture: place.near first, then the first from, then what the first answered mark points at, then that mark', () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 300, 100]));
    b.must('owner', note('m2', [0, 400, 300, 100], { on: { item: 'm1' } }));
    b.must('agent', text('a1', { answers: ['m1'] }));
    b.must('owner', placeAt('a1', [400, 0, 300, 100]));
    b.must('agent', lanes('w2', { answers: ['m2'], from: ['a1'], place: { near: 'm2' } }));
    b.must('agent', lanes('w3', { answers: ['m2'], from: ['a1'] }));
    b.must('agent', lanes('w4', { answers: ['m2'] }));
    const s = b.state;
    const boxOf = fromLog(s);
    expect(anchorOf(s, 'w2', boxOf)).toBe('m2');
    expect(anchorOf(s, 'w3', boxOf)).toBe('a1');
    // m2 is stuck on m1, so the wide picture answering m2 goes by m1.
    expect(anchorOf(s, 'w4', boxOf)).toBe('m1');
  });

  it('falls back to the answered mark, then to the chapter last placed item', () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 300, 100]));
    b.must('agent', text('a1', { answers: ['m1'] }));
    expect(anchorOf(b.state, 'a1', fromLog(b.state))).toBe('m1');
    b.must('owner', placeAt('a1', [400, 0, 300, 100]));
    // The act of solidifying is not an item, so the picture falls back to the last placed item.
    const solid = b.must('owner', { type: 'solidify', chapter: 'engine-loop', picks: ['a1'], parts: [] });
    b.must('agent', text('a2', { answers: [solid.id] }));
    expect(anchorOf(b.state, 'a2', fromLog(b.state))).toBe('a1');
  });
});

describe('placement', () => {
  it('puts a small picture right of its anchor, top-aligned, with a 48 gap', () => {
    const b = openBoard();
    b.must('owner', note('m1', [100, 200, 300, 120]));
    b.must('agent', text('a1', { answers: ['m1'] }));
    expect(place(b.state, 'a1', [380, 140], fromLog(b.state))).toEqual([100 + 300 + GAP_RIGHT, 200, 380, 140]);
  });

  it('puts a wide picture below what it belongs to, left-aligned with it, with a 64 gap', () => {
    const b = openBoard();
    b.must('owner', note('m1', [100, 200, 300, 120]));
    b.must('owner', note('m2', [600, 250, 300, 300]));
    b.must('agent', lanes('a1', { answers: ['m2'] }));
    expect(place(b.state, 'a1', [800, 400], fromLog(b.state))).toEqual([600, 550 + GAP_BELOW, 800, 400]);
  });

  it('puts a wide picture that belongs to nothing on the board below the lowest item of the chapter', () => {
    const b = openBoard();
    b.must('owner', note('m1', [100, 200, 300, 120]));
    b.must('owner', note('m2', [600, 250, 300, 300]));
    const solid = b.must('owner', { type: 'solidify', chapter: CH, picks: ['m1'], parts: [] });
    b.must('agent', lanes('a1', { answers: [solid.id] }));
    expect(place(b.state, 'a1', [800, 400], fromLog(b.state))).toEqual([100, 550 + GAP_BELOW, 800, 400]);
  });

  it('a wide picture beside its place.near: the side named, at the nearest clear spot, not below everything', () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 300, 100]));
    b.must('agent', lanes('pipe', { answers: ['m1'] }));
    b.must('owner', placeAt('pipe', [0, 200, 1400, 900]));
    // A tall pile below the pipeline: below everything would be far away.
    b.must('owner', note('m2', [0, 1150, 300, 2000]));
    b.must('agent', lanes('walk', { from: ['pipe'], place: { near: 'pipe', side: 'right' } }));
    const box = place(b.state, 'walk', [600, 700], fromLog(b.state));
    expect(box).toEqual([1400 + GAP_BELOW, 200, 600, 700]);
  });

  it('honours place.side next to place.near', () => {
    const b = openBoard();
    b.must('owner', note('m1', [100, 200, 300, 120]));
    b.must('agent', text('a1', { answers: ['m1'], place: { near: 'm1', side: 'below' } }));
    b.must('agent', text('a2', { answers: ['m1'], place: { near: 'm1', side: 'left' } }));
    const boxOf = fromLog(b.state);
    expect(place(b.state, 'a1', [300, 100], boxOf)).toEqual([100, 320 + GAP_RIGHT, 300, 100]);
    expect(place(b.state, 'a2', [300, 100], boxOf)).toEqual([100 - GAP_RIGHT - 300, 200, 300, 100]);
  });

  it('puts a small picture whose spot is taken on the next side that is clear: below, then left, then above', () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 300, 100]));
    // Something already sits where the card would go.
    b.must('owner', note('m2', [348, 0, 300, 90]));
    b.must('agent', text('a1', { answers: ['m1'] }));
    expect(place(b.state, 'a1', [300, 100], fromLog(b.state))).toEqual([0, 100 + GAP_RIGHT, 300, 100]);
  });

  it('a reply to a note on a part of a big pipeline lands beside the note, where the note is drawn now, and overlaps nothing', () => {
    // Screen 6: "only one request at a time here?" is stuck on the scheduler, low in the
    // pipeline. Right of the note is the pipeline, and under the pipeline's right half is
    // another picture, so sliding down from the right would land far below the note.
    const b = openBoard();
    b.must('owner', note('seed', [-9000, -9000, 100, 40]));
    b.must('agent', lanes('pipe', { answers: ['seed'] }));
    b.must('owner', placeAt('pipe', [0, 0, 1700, 780]));
    b.must('agent', lanes('under', { from: ['pipe'] }));
    b.must('owner', placeAt('under', [800, 830, 900, 400]));
    // Made against the scheduler as a 100 by 100 space, as the fixture makes it.
    b.must('owner', note('note-one', [-40, 112, 350, 62], { on: { item: 'pipe', sub: 'part:scheduler' }, anchor: { item: 'pipe', sub: 'part:scheduler', box: [0, 0, 100, 100] } }));
    b.must('agent', text('reply-one', { answers: ['note-one'], place: { near: 'note-one', side: 'right' } }));
    const subs = new Map<string, Box>([['pipe/part:scheduler', [400, 640, 180, 70]]]);
    const boxOf = (id: Id) => shownBoxOf({ state: b.state, boxes: new Map(), subs }, id);
    const shown = boxOf('note-one')!;
    expect(shown).toEqual([400 - 0.4 * 180, 640 + 1.12 * 70, 350, 62]);

    const reply = place(b.state, 'reply-one', [380, 98], boxOf);
    // Right of the note is the pipeline: the nearest clear spot is just below the note.
    expect(reply).toEqual([Math.round(shown[0]), Math.round(shown[1] + shown[3] + GAP_RIGHT), 380, 98]);
    for (const id of ['pipe', 'under', 'note-one']) expect(overlaps(padBox(reply, CLEAR), boxOf(id)!), `the reply overlaps ${id}`).toBe(false);
    // The old rule (right of the note, then slide down) would have gone below the picture under the pipeline.
    expect(reply[1]).toBeLessThan(830);
    // Its one lineage arrow comes from the note, and is short.
    const placed = new Map<Id, Box>([['reply-one', reply]]);
    const after = (id: Id) => shownBoxOf({ state: b.state, boxes: placed, subs }, id);
    expect(primarySource(b.state, 'reply-one', after)).toEqual({ from: 'note-one', kind: 'near' });
    const [[x1, y1], [x2, y2]] = edgeEnds(shown, reply);
    expect(Math.hypot(x2 - x1, y2 - y1)).toBeLessThan(GAP_RIGHT + 1);
  });

  it('in a crowded neighbourhood, takes the nearest clear spot on any side', () => {
    const b = openBoard();
    b.must('owner', note('m', [1000, 1000, 200, 60]));
    // Something sits right, below, left and above the note, each at its own distance.
    b.must('owner', note('right', [1240, 980, 300, 140]));
    b.must('owner', note('below', [980, 1100, 260, 200]));
    b.must('owner', note('left', [600, 960, 380, 200]));
    b.must('owner', note('above', [990, 800, 240, 160]));
    b.must('agent', text('a1', { answers: ['m'] }));
    const boxOf = fromLog(b.state);
    const box = place(b.state, 'a1', [300, 100], boxOf);
    // Clear above after 7 steps; right needs 13, below 9, left 16.
    expect(box).toEqual([1000, 1000 - GAP_RIGHT - 100 - 7 * STEP, 300, 100]);
    for (const id of ['m', 'right', 'below', 'left', 'above']) expect(overlaps(padBox(box, CLEAR), boxOf(id)!), `overlaps ${id}`).toBe(false);
    // No spot a step nearer is clear, on any side.
    const others = ['m', 'right', 'below', 'left', 'above'].map((id) => boxOf(id)!);
    for (const side of SIDES) expect(isClear(beside(boxOf('m')!, side, [300, 100], GAP_RIGHT, 6 * STEP), others)).toBe(false);
    // The side the agent asks for is tried first at each distance, not at any distance.
    expect(nearestClear(boxOf('m')!, [300, 100], others, sidesFrom('left'))).toEqual(box);
  });

  it('a small picture with no clear spot within reach slides down from beside its anchor', () => {
    const b = openBoard();
    b.must('owner', note('seed', [-9000, -9000, 100, 40]));
    b.must('agent', lanes('big', { answers: ['seed'] }));
    b.must('owner', placeAt('big', [-3000, -3000, 6000, 6000]));
    b.must('owner', note('m', [0, 0, 200, 60], { on: { item: 'big' } }));
    b.must('agent', text('a1', { answers: ['m'] }));
    const box = place(b.state, 'a1', [300, 100], fromLog(b.state));
    expect(box[0]).toBe(200 + GAP_RIGHT);
    expect(box[1]).toBeGreaterThanOrEqual(3000 + CLEAR);
    expect(box[1] - STEP).toBeLessThan(3000 + CLEAR);
    expect(REACH).toBeLessThan(3000);
  });

  it('a wide picture whose named side is taken goes to the nearest clear side, and overlaps nothing', () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 300, 100]));
    // Something already sits where the picture would go.
    b.must('owner', note('m2', [0, 148, 300, 90]));
    b.must('agent', lanes('w1', { answers: ['m1'], place: { near: 'm1', side: 'below' } }));
    const box = place(b.state, 'w1', [600, 200], fromLog(b.state));
    expect(box).toEqual([300 + GAP_BELOW, 0, 600, 200]);
    expect(isClear(box, [[0, 0, 300, 100], [0, 148, 300, 90]])).toBe(true);
  });

  it('places several pictures in log order, each seeing the ones before, with no overlap', () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 300, 100]));
    for (const id of ['a1', 'a2', 'a3']) b.must('agent', text(id, { answers: ['m1'] }));
    b.must('agent', lanes('a4', { from: ['a1'] }));
    const sizes = new Map<Id, [number, number]>([
      ['a1', [380, 200]],
      ['a2', [380, 200]],
      ['a3', [380, 200]],
      ['a4', [900, 300]],
    ]);
    const placed = placeAll(b.state, sizes, (now) => (id) => now.get(id) ?? fromLog(b.state)(id));
    expect([...placed.keys()]).toEqual(['a1', 'a2', 'a3', 'a4']);
    const all: Box[] = [[0, 0, 300, 100], ...placed.values()];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(overlaps(all[i]!, all[j]!)).toBe(false);
    // The three replies take the note's right, then its left (the first reply reaches below
    // the note), then above it.
    expect(placed.get('a1')!.slice(0, 2)).toEqual([300 + GAP_RIGHT, 0]);
    expect(placed.get('a2')!.slice(0, 2)).toEqual([-GAP_RIGHT - 380, 0]);
    expect(placed.get('a3')!.slice(0, 2)).toEqual([0, -GAP_RIGHT - 200]);
    // The wide one grew out of the first reply: it goes below that reply, beside where it belongs.
    const a1 = placed.get('a1')!;
    expect(placed.get('a4')!.slice(0, 2)).toEqual([a1[0], a1[1] + a1[3] + GAP_BELOW]);
  });

  it('stops at the first picture not measured yet, so a later one never takes its spot', () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 300, 100]));
    b.must('agent', text('a1', { answers: ['m1'] }));
    b.must('agent', text('a2', { answers: ['m1'] }));
    const placed = placeAll(b.state, new Map([['a2', [300, 100] as const]]), () => fromLog(b.state));
    expect(placed.size).toBe(0);
  });

  it('gives the same layout for the same log', () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 300, 100]));
    b.must('owner', note('m2', [800, 40, 300, 100]));
    b.must('agent', text('a1', { answers: ['m1', 'm2'] }));
    b.must('agent', lanes('a2', { from: ['a1'] }));
    b.must('agent', text('a3', { answers: ['m2'] }));
    // A crowd round one note: each reply sees the ones before it.
    for (const id of ['c1', 'c2', 'c3', 'c4', 'c5']) b.must('agent', text(id, { answers: ['m2'], place: { near: 'm2', side: 'below' } }));
    const sizes = new Map<Id, [number, number]>([
      ['a1', [460, 220]],
      ['a2', [700, 260]],
      ['a3', [380, 120]],
      ['c1', [300, 90]],
      ['c2', [420, 160]],
      ['c3', [300, 90]],
      ['c4', [360, 240]],
      ['c5', [300, 90]],
    ]);
    const run = () => {
      const s = replay(b.events);
      return [...placeAll(s, sizes, (now) => (id) => now.get(id) ?? fromLog(s)(id))];
    };
    const first = run();
    expect(first.map(([id]) => id)).toEqual(['a1', 'a2', 'a3', 'c1', 'c2', 'c3', 'c4', 'c5']);
    for (let i = 0; i < 3; i++) expect(run()).toEqual(first);
    const all: Box[] = [[0, 0, 300, 100], [800, 40, 300, 100], ...first.map(([, box]) => box)];
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(overlaps(all[i]!, all[j]!)).toBe(false);
    expect(unplaced(b.state)).toEqual(['a1', 'a2', 'a3', 'c1', 'c2', 'c3', 'c4', 'c5']);
  });

  it('leaves removed items out: they are not drawn and take no room', () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 300, 100]));
    b.must('owner', note('m2', [348, 0, 300, 100]));
    b.must('owner', { type: 'item.remove', item: 'm2' });
    b.must('agent', text('a1', { answers: ['m1'] }));
    expect(place(b.state, 'a1', [300, 100], fromLog(b.state))).toEqual([348, 0, 300, 100]);
  });
});
