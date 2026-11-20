import type { Box } from '@keel/protocol';
import { describe, expect, it } from 'vitest';
import { anchorBox, shownBoxOf } from '../src/layout';
import { edgeEnds, lineageEdges, primarySource } from '../src/lineage';
import { CH, lanes, note, openBoard, placeAt, text } from './helpers';

const none = new Map<string, Box>();

describe('where items are drawn', () => {
  it('draws a note stuck to a sub where the sub is now', () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 300, 100]));
    b.must('agent', text('a1', { answers: ['m1'] }));
    b.must('owner', placeAt('a1', [400, 0, 380, 200]));
    b.must('owner', note('m2', [104, 0, 120, 40], { on: { item: 'a1', sub: 'q:1' }, anchor: { item: 'a1', sub: 'q:1', box: [0, 0, 100, 100] } }));
    const subs = new Map<string, Box>([['a1/q:1', [420, 150, 300, 20]]]);
    expect(shownBoxOf({ state: b.state, boxes: none, subs }, 'm2')).toEqual([420 + 312, 150, 120, 40]);
  });

  it('finds a sub inside a picture placed in this pass from its measured offset', () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 300, 100]));
    b.must('agent', text('a1', { answers: ['m1'] }));
    const a = { item: 'a1', sub: 'q:1', box: [0, 0, 100, 100] as Box };
    const placed = new Map<string, Box>([['a1', [1000, 500, 380, 200]]]);
    const offsets = new Map<string, Box>([['a1/q:1', [16, 150, 340, 20]]]);
    expect(anchorBox({ state: b.state, boxes: placed, subs: none, subOffsets: offsets }, a)).toEqual([1016, 650, 340, 20]);
  });

  it('keeps a mark near its picture when the picture does not draw that sub yet', () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 300, 100]));
    b.must('agent', text('a1', { answers: ['m1'] }));
    b.must('owner', placeAt('a1', [400, 0, 380, 200]));
    const a = { item: 'a1', sub: 'step:x', box: [0, 0, 100, 100] as Box };
    expect(anchorBox({ state: b.state, boxes: none, subs: none }, a)).toEqual([400, 0, 100, 100]);
  });

  it('draws nothing for a removed item, or a picture with no place', () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 300, 100]));
    b.must('agent', text('a1', { answers: ['m1'] }));
    b.must('owner', { type: 'item.remove', item: 'm1' });
    expect(shownBoxOf({ state: b.state, boxes: none, subs: none }, 'm1')).toBeUndefined();
    expect(shownBoxOf({ state: b.state, boxes: none, subs: none }, 'a1')).toBeUndefined();
  });
});

describe('lineage arrows', () => {
  const board = () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 300, 100]));
    b.must('owner', note('m2', [0, 600, 300, 100]));
    b.must('agent', text('a1', { answers: ['m1'] }));
    b.must('owner', placeAt('a1', [400, 0, 380, 200]));
    return b;
  };

  it('runs from each from item and each answered mark to the picture, one of them primary', () => {
    const b = board();
    b.must('agent', lanes('w2', { from: ['a1'], answers: ['m2'] }));
    b.must('owner', placeAt('w2', [400, 400, 380, 200]));
    const boxOf = (id: string) => shownBoxOf({ state: b.state, boxes: none, subs: none }, id);
    expect(lineageEdges(b.state, boxOf)).toEqual([
      { from: 'm1', to: 'a1', kind: 'answers', primary: true },
      { from: 'a1', to: 'w2', kind: 'from', primary: true },
      { from: 'm2', to: 'w2', kind: 'answers', primary: false },
    ]);
  });

  it('a small picture is placed by the mark it answers, so that mark is its one arrow, before what it grew out of', () => {
    const b = board();
    b.must('agent', text('a2', { from: ['a1'], answers: ['m2'] }));
    b.must('owner', placeAt('a2', [400, 600, 380, 200]));
    const boxOf = (id: string) => shownBoxOf({ state: b.state, boxes: none, subs: none }, id);
    expect(lineageEdges(b.state, boxOf).filter((e) => e.to === 'a2')).toEqual([
      { from: 'm2', to: 'a2', kind: 'answers', primary: true },
      { from: 'a1', to: 'a2', kind: 'from', primary: false },
    ]);
  });

  it('draws at most one arrow into a picture by default: place.near, else the first from, else the nearest mark it answers', () => {
    const b = board();
    b.must('owner', note('m3', [0, 300, 300, 100]));
    b.must('agent', { ...text('a2', { from: ['a1'], answers: ['m2', 'm3'], place: { near: 'm3', side: 'right' } }), chapter: CH });
    b.must('owner', placeAt('a2', [400, 400, 380, 200]));
    const boxOf = (id: string) => shownBoxOf({ state: b.state, boxes: none, subs: none }, id);
    expect(primarySource(b.state, 'a2', boxOf)).toEqual({ from: 'm3', kind: 'near' });
    const into = lineageEdges(b.state, boxOf).filter((e) => e.to === 'a2');
    expect(into.filter((e) => e.primary)).toEqual([{ from: 'm3', to: 'a2', kind: 'near', primary: true }]);
    expect(into.filter((e) => !e.primary).map((e) => e.from)).toEqual(['a1', 'm2']);
    // With no near and no from, the nearest mark it answers.
    b.must('agent', text('a3', { answers: ['m1', 'm2'] }));
    b.must('owner', placeAt('a3', [0, 900, 300, 100]));
    expect(primarySource(b.state, 'a3', boxOf)).toEqual({ from: 'm2', kind: 'answers' });
  });

  it('draws one arrow from a picture for the marks made on it, and none for a picture with no place', () => {
    const b = board();
    b.must('owner', note('m3', [10, 10, 100, 40], { anchor: { item: 'a1', box: [400, 0, 380, 200] } }));
    b.must('owner', note('m4', [10, 60, 100, 40], { anchor: { item: 'a1', box: [400, 0, 380, 200] } }));
    b.must('agent', text('a3', { answers: ['m3', 'm4'] }));
    const boxOf = (id: string) => shownBoxOf({ state: b.state, boxes: none, subs: none }, id);
    expect(lineageEdges(b.state, boxOf).filter((e) => e.to === 'a3')).toEqual([]);
    b.must('owner', placeAt('a3', [900, 0, 380, 200]));
    // The nearest of the marks it answers is its one arrow; the picture they are on is the other.
    expect(lineageEdges(b.state, boxOf).filter((e) => e.to === 'a3')).toEqual([
      { from: 'm4', to: 'a3', kind: 'answers', primary: true },
      { from: 'a1', to: 'a3', kind: 'answers', primary: false },
    ]);
  });

  it('lets a mark that lies inside another source share its arrow', () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 600, 400]));
    b.must('owner', note('m2', [100, 100, 100, 40]));
    b.must('agent', text('a1', { answers: ['m1', 'm2'] }));
    b.must('owner', placeAt('a1', [700, 0, 380, 200]));
    const boxOf = (id: string) => shownBoxOf({ state: b.state, boxes: none, subs: none }, id);
    expect(lineageEdges(b.state, boxOf)).toEqual([{ from: 'm1', to: 'a1', kind: 'answers', primary: true }]);
  });

  it('starts and ends each arrow on the edges of the two boxes', () => {
    const [[x1, y1], [x2, y2]] = edgeEnds([0, 0, 100, 100], [300, 0, 100, 100], 0);
    expect([x1, y1, x2, y2]).toEqual([100, 50, 300, 50]);
  });
});
