import type { Box } from '@keel/protocol';
import { describe, expect, it } from 'vitest';
import { LASSO_PAD, lassoOutline, shownBoxOf } from '../src/layout';
import { bridged, loopPath, loopsBox, unionOutline } from '../src/outline';
import { CH, note, openBoard, placeAt, text } from './helpers';

const none = new Map<string, Box>();
const close = (a: Box | undefined, b: Box) => {
  expect(a).toBeTruthy();
  a!.forEach((n, i) => expect(n).toBeCloseTo(b[i]!, 6));
};

/**
 * Every mark kind on a picture, then the picture moves and doubles in width. Ink, lassos, boxes
 * and arrows move and scale with it; notes, pins, files and spoken remarks only move.
 */
describe('each mark kind follows the picture it is on', () => {
  const then: Box = [400, 0, 400, 200];
  const now: Box = [1000, 500, 800, 200];
  const anchor = { item: 'a1', box: then };
  const add = (item: Record<string, unknown>) => ({ type: 'item.add', chapter: CH, item: { anchor, ...item } });

  const board = () => {
    const b = openBoard();
    b.must('owner', note('n0', [0, 0, 300, 100]));
    b.must('agent', text('a1', { answers: ['n0'] }));
    b.must('owner', placeAt('a1', then));
    // Everything inside a mark is counted from the corner of its box.
    b.must('owner', add({ id: 'ink', kind: 'ink', box: [500, 50, 100, 40], strokes: [{ pts: [0, 0, 100, 40] }], targets: [{ item: 'a1' }], hint: 'none' }));
    b.must('owner', add({ id: 'box', kind: 'box', box: [500, 50, 100, 40] }));
    b.must('owner', add({ id: 'arrow', kind: 'arrow', box: [500, 50, 100, 40], from: [0, 0], to: [100, 40] }));
    b.must('owner', add({ id: 'note', kind: 'note', box: [500, 50, 100, 40], text: 'n', on: { item: 'a1' } }));
    b.must('owner', add({ id: 'pin', kind: 'pin', box: [500, 50, 0, 0], at: [0, 0], on: { item: 'a1' } }));
    b.must('owner', add({ id: 'file', kind: 'file', box: [500, 50, 100, 40], name: 'f.md', asset: 'assets/f.md' }));
    b.must('owner', add({ id: 'voice', kind: 'voice', box: [500, 50, 100, 40], text: 'v', on: { item: 'a1' } }));
    b.must('owner', { type: 'item.add', chapter: CH, item: { id: 'lasso', kind: 'lasso', box: [380, -20, 440, 240], path: [0, 0, 440, 0, 440, 240, 0, 240], targets: [{ item: 'a1' }] } });
    return b;
  };

  it('draws every mark where it was drawn while the picture has not moved', () => {
    const b = board();
    const w = { state: b.state, boxes: none, subs: none };
    for (const id of ['ink', 'box', 'arrow', 'note', 'file', 'voice']) close(shownBoxOf(w, id), [500, 50, 100, 40]);
    close(shownBoxOf(w, 'pin'), [500, 50, 0, 0]);
    close(shownBoxOf(w, 'lasso'), [400 - LASSO_PAD, -LASSO_PAD, 400 + 2 * LASSO_PAD, 200 + 2 * LASSO_PAD]);
  });

  it('moves and scales ink, boxes, arrows and lassos; only moves notes, pins, files and remarks', () => {
    const b = board();
    b.must('owner', placeAt('a1', now));
    const w = { state: b.state, boxes: none, subs: none };
    // 100 units into a 400-wide picture is 200 units into an 800-wide one.
    for (const id of ['ink', 'box', 'arrow']) close(shownBoxOf(w, id), [1200, 550, 200, 40]);
    for (const id of ['note', 'file', 'voice']) close(shownBoxOf(w, id), [1200, 550, 100, 40]);
    close(shownBoxOf(w, 'pin'), [1200, 550, 0, 0]);
    close(shownBoxOf(w, 'lasso'), [1000 - LASSO_PAD, 500 - LASSO_PAD, 800 + 2 * LASSO_PAD, 200 + 2 * LASSO_PAD]);
  });

  it('a picture the app has just moved (not back from the log yet) carries its marks too', () => {
    const b = board();
    const w = { state: b.state, boxes: new Map<string, Box>([['a1', now]]), subs: none };
    close(shownBoxOf(w, 'ink'), [1200, 550, 200, 40]);
    close(shownBoxOf(w, 'note'), [1200, 550, 100, 40]);
  });

  it('a note on a lasso follows the lasso, which follows its targets', () => {
    const b = board();
    const lassoThen = shownBoxOf({ state: b.state, boxes: none, subs: none }, 'lasso')!;
    b.must('owner', note('on-lasso', [lassoThen[0] + 10, lassoThen[1] + lassoThen[3] + 8, 200, 50], { anchor: { item: 'lasso', box: lassoThen } }));
    b.must('owner', placeAt('a1', [1000, 500, 400, 200]));
    close(shownBoxOf({ state: b.state, boxes: none, subs: none }, 'on-lasso'), [1000 - LASSO_PAD + 10, 500 + 200 + LASSO_PAD + 8, 200, 50]);
  });

  it('a mark stuck on a sub follows the sub', () => {
    const b = board();
    b.must('owner', { type: 'item.add', chapter: CH, item: { id: 'c', kind: 'ink', box: [-6, -6, 112, 112], strokes: [{ pts: [0, 0, 112, 112] }], targets: [{ item: 'a1', sub: 'q:1' }], hint: 'circle', anchor: { item: 'a1', sub: 'q:1', box: [0, 0, 100, 100] } } });
    const subs = new Map<string, Box>([['a1/q:1', [420, 150, 300, 20]]]);
    close(shownBoxOf({ state: b.state, boxes: none, subs }, 'c'), [420 - 18, 150 - 1.2, 336, 22.4]);
  });

  it('a lasso with nothing left on the board keeps its own box', () => {
    const b = board();
    b.must('agent', { type: 'item.remove', item: 'a1' });
    close(shownBoxOf({ state: b.state, boxes: none, subs: none }, 'lasso'), [380, -20, 440, 240]);
  });

  it('a lasso round a sub and a note is drawn round where both are now', () => {
    const b = board();
    b.must('owner', { type: 'item.add', chapter: CH, item: { id: 'l2', kind: 'lasso', box: [0, 0, 10, 10], path: [0, 0, 10, 0, 10, 10], targets: [{ item: 'n0' }, { item: 'a1', sub: 'q:2' }] } });
    const subs = new Map<string, Box>([['a1/q:2', [420, 150, 300, 20]]]);
    const w = { state: b.state, boxes: none, subs };
    const lasso = b.state.items.l2!.item;
    if (lasso.kind !== 'lasso') throw new Error('not a lasso');
    // The note [0,0,300,100] and the row [420,150,300,20], each padded, do not touch: a band
    // joins them, so the outline is one shape.
    expect(lassoOutline(w, lasso)).toHaveLength(1);
    close(shownBoxOf(w, 'l2'), [-LASSO_PAD, -LASSO_PAD, 720 + 2 * LASSO_PAD, 170 + 2 * LASSO_PAD]);
  });
});

describe('the tidy outline of a lasso', () => {
  it('is a box for one box', () => {
    expect(unionOutline([[0, 0, 10, 10]])).toEqual([
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
    ]);
  });

  it('is one loop round boxes that overlap, with the step where they meet', () => {
    const loops = unionOutline([
      [0, 0, 100, 50],
      [50, 40, 100, 60],
    ]);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toHaveLength(8);
    expect(loopsBox(loops)).toEqual([0, 0, 150, 100]);
  });

  it('is two loops round boxes that do not touch, and a path for each', () => {
    const loops = unionOutline([
      [0, 0, 10, 10],
      [50, 50, 10, 10],
    ]);
    expect(loops).toHaveLength(2);
    for (const l of loops) expect(loopPath(l)).toMatch(/^M [\d.]+ [\d.]+ Q .* Z$/);
  });

  it('joins boxes that do not touch into one shape: across what they share, else with an L', () => {
    const side = bridged([[0, 0, 100, 50], [200, 20, 100, 100]], 20);
    expect(unionOutline(side)).toHaveLength(1);
    expect(side[2]).toEqual([99, 20, 102, 30]);
    const corner = bridged([[0, 0, 100, 50], [300, 300, 100, 100]], 20);
    expect(unionOutline(corner)).toHaveLength(1);
    expect(bridged([[0, 0, 10, 10], [5, 5, 10, 10]], 20)).toHaveLength(2);
  });

  it('is nothing round nothing', () => {
    expect(unionOutline([])).toEqual([]);
    expect(unionOutline([[5, 5, 0, 10]])).toEqual([]);
  });
});
