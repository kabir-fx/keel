import type { Box } from '@keel/protocol';
import { describe, expect, it } from 'vitest';
import type { TargetRect, XY } from '../src/geometry';
import { readInk } from '../src/geometry';
import { inkItem, splitGo } from '../src/marks';

/** A spread of three approaches, as the DOM measures it. */
const rects: TargetRect[] = [
  { id: 'spread', item: 'spread', box: [0, 0, 1500, 600] },
  { id: 'spread/approach:a', item: 'spread', sub: 'approach:a', parent: 'spread', box: [20, 60, 440, 500] },
  { id: 'spread/approach:b', item: 'spread', sub: 'approach:b', parent: 'spread', box: [530, 60, 440, 500] },
  { id: 'spread/approach:c', item: 'spread', sub: 'approach:c', parent: 'spread', box: [1040, 60, 440, 500] },
];
const boxOf = () => undefined;

/** A loop round a box, closed with a little overlap, as a hand draws it. */
const ring = ([x, y, w, h]: Box, n = 48): XY[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const t = -Math.PI / 2 + (i / n) * 1.06 * 2 * Math.PI;
    return [x + w / 2 + (w / 2 + 16) * Math.cos(t), y + h / 2 + (h / 2 + 16) * Math.sin(t)] as XY;
  });
const line = (a: [number, number], b: [number, number], n = 24): XY[] => Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n] as XY);
/** The two strokes of a cross over a box. */
const cross = ([x, y, w, h]: Box): XY[][] => [line([x + 40, y + 40], [x + w - 40, y + h - 40]), line([x + w - 40, y + 40], [x + 40, y + h - 40])];

/** Each stroke as a press of its own, kept in one piece: how the pen hands over a go of strokes that never filled up. */
const presses = (strokes: readonly (readonly XY[])[]): XY[][][] => strokes.map((s) => [[...s]]);

const A = rects[1]!.box;
const B = rects[2]!.box;
const C = rects[3]!.box;

describe('one go of the pen, cut into marks that each mean one thing', () => {
  it('a circle on A and, a moment later, a cross on C: two marks, a pick and a cross-out', () => {
    const groups = splitGo(presses([ring(A), ...cross(C)]), rects);
    expect(groups.map((g) => g.length)).toEqual([1, 2]);
    const [pick, out] = groups.map((g, i) => inkItem(`m${i + 1}`, g, rects, boxOf));
    expect(pick!.hint).toBe('circle');
    expect(pick!.targets).toEqual([{ item: 'spread', sub: 'approach:a' }]);
    expect(out!.hint).toBe('cross');
    expect(out!.targets).toEqual([{ item: 'spread', sub: 'approach:c' }]);
    // Read together, as before, the go meant nothing.
    expect(readInk([ring(A), ...cross(C)], rects).hint).not.toBe('circle');
  });

  it('the two strokes of a cross on one thing stay one mark', () => {
    const groups = splitGo(presses(cross(B)), rects);
    expect(groups).toHaveLength(1);
    expect(inkItem('m1', groups[0]!, rects, boxOf)).toMatchObject({ hint: 'cross', targets: [{ item: 'spread', sub: 'approach:b' }] });
  });

  it('a stroke after a finished cross starts a new mark, even on the same thing', () => {
    const groups = splitGo(presses([...cross(B), ring(B)]), rects);
    expect(groups.map((g) => g.length)).toEqual([2, 1]);
  });

  it('strokes on different things are different marks', () => {
    const groups = splitGo(presses([line([A[0] + 20, A[1] + 100], [A[0] + 300, A[1] + 100]), line([C[0] + 20, C[1] + 100], [C[0] + 300, C[1] + 100])]), rects);
    expect(groups).toHaveLength(2);
  });

  it('a pick on A, a cross on C and then a stroke on bare board: three marks, the cross read from its own two strokes and not with the pick before it', () => {
    const bare = line([3000, 2000], [3100, 2300]);
    expect(splitGo(presses([ring(A), ...cross(C), bare]), rects).map((g) => g.length)).toEqual([1, 2, 1]);
  });

  it('a stroke that runs on from the thing the mark is on into its neighbour stays in the mark: one thing they share is enough', () => {
    const onA = line([A[0] + 60, A[1] + 100], [A[0] + 160, A[1] + 400]);
    const onAndOver = line([A[0] + 300, A[1] + 150], [B[0] + 100, B[1] + 450]);
    expect(readInk([onA], rects)).toMatchObject({ hint: 'none', targets: ['spread/approach:a'] });
    expect(readInk([onAndOver], rects)).toMatchObject({ hint: 'none', targets: ['spread/approach:a', 'spread/approach:b'] });
    expect(splitGo(presses([onA, onAndOver]), rects).map((g) => g.length)).toEqual([2]);
    // The other way round as well: the mark is on both, and the stroke after it on one of them.
    expect(splitGo(presses([onAndOver, onA]), rects).map((g) => g.length)).toEqual([2]);
  });

  it('a free sketch on bare board, three boxes and the lines between, stays one mark', () => {
    const far = (dx: number): Box => [3000 + dx, 2000, 120, 80];
    const sketch = [ring(far(0)), ring(far(300)), ring(far(600)), line([3140, 2040], [3280, 2040]), line([3440, 2040], [3580, 2040])];
    expect(splitGo(presses(sketch), rects)).toHaveLength(1);
  });
});

describe('a cut keeps each mark meaning what the hand meant', () => {
  /** A spread with one approach, and a step inside it. */
  const steps: TargetRect[] = [
    { id: 'sp', item: 'sp', box: [800, 100, 600, 300] },
    { id: 'sp/approach:a', item: 'sp', sub: 'approach:a', parent: 'sp', box: [816, 140, 280, 240] },
    { id: 'sp/step:a-take', item: 'sp', sub: 'step:a-take', parent: 'sp/approach:a', box: [832, 180, 120, 40] },
  ];
  /** A ring round the step, a sample about every pixel. */
  const ringed: XY[] = Array.from({ length: 567 }, (_, i) => {
    const t = -Math.PI / 2 + (i / 566) * 2 * Math.PI;
    return [892 + 90 * Math.cos(t), 200 + 32 * Math.sin(t)] as const;
  });
  const through = (...corners: [number, number][]): XY[] => corners.slice(1).flatMap((c, i) => line(corners[i]!, c, 40).slice(i === 0 ? 0 : 1));

  it('a ring round a step is a finished pick: a tick on the same step after it is a mark of its own', () => {
    const tick = through([870, 195], [880, 210], [910, 185]);
    expect(splitGo(presses([ringed, tick]), steps).map((g) => g.length)).toEqual([1, 1]);
  });

  it('a stroke on bare board after a stroke on a thing stays in its sketch', () => {
    const on = through([850, 190], [900, 210], [940, 190]);
    const bare = through([600, 500], [650, 560], [700, 500]);
    expect(splitGo(presses([on, bare]), steps).map((g) => g.length)).toEqual([2]);
  });

  it('at 400% a small X over a step is a finished cross-out there: a stroke on the same step after it is a mark of its own', () => {
    // The board an eighth the size: each stroke of the X is 12.8 board units long, 51 px on screen.
    const tiny = steps.map((r): TargetRect => ({ ...r, box: [r.box[0] / 8, r.box[1] / 8, r.box[2] / 8, r.box[3] / 8] }));
    const x = [line([106, 20], [116, 28], 40), line([116, 20], [106, 28], 40)];
    expect(splitGo(presses([...x, line([105, 25], [115, 25.5], 40)]), tiny, 4).map((g) => g.length)).toEqual([2, 1]);
  });
});
