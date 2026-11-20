import { describe, expect, it } from 'vitest';
import type { TargetRect, XY } from '../src/geometry';
import { bboxOf, hitTest, lineBox, overlaps, padBox, wholeBoxAround } from '../src/geometry';
import { samples } from '../src/ink/ink';

const loop = (cx: number, cy: number, rx: number, ry: number): XY[] =>
  Array.from({ length: 41 }, (_, i) => [cx + rx * Math.cos((i / 40) * 2 * Math.PI), cy + ry * Math.sin((i / 40) * 2 * Math.PI)] as const);
const line = (x0: number, y0: number, x1: number, y1: number): XY[] => Array.from({ length: 11 }, (_, i) => [x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10] as const);

const targets: TargetRect[] = [
  { id: 'a1', item: 'a1', box: [0, 0, 400, 200] },
  { id: 'a1/approach:a', item: 'a1', sub: 'approach:a', parent: 'a1', box: [10, 10, 180, 180] },
  { id: 'a1/approach:b', item: 'a1', sub: 'approach:b', parent: 'a1', box: [210, 10, 180, 180] },
];

describe('what a mark covers (carried from spike S2)', () => {
  it('finds what a circle encloses, and what a cross best covers', () => {
    expect(hitTest([loop(100, 100, 110, 110)], 'circle', targets)).toEqual(['a1/approach:a']);
    expect(hitTest([loop(200, 100, 260, 160)], 'circle', targets)).toEqual(['a1']);
    expect(hitTest([line(220, 20, 380, 180), line(380, 20, 220, 180)], 'cross', targets)).toEqual(['a1/approach:b']);
  });

  it('measures boxes', () => {
    expect(bboxOf([[1, 2], [5, -3], [4, 9]])).toEqual([1, -3, 4, 12]);
    expect(padBox([0, 0, 10, 10], 2)).toEqual([-2, -2, 14, 14]);
    // The smallest box on whole units round a box: near edges down, far edges up.
    expect(wholeBoxAround([10.3, -4.7, 20.2, 5.5])).toEqual([10, -5, 21, 6]);
    expect(wholeBoxAround([10.7, -4.3, 20.2, 5.5])).toEqual([10, -5, 21, 7]);
    expect(wholeBoxAround([10, 20, 30, 40])).toEqual([10, 20, 30, 40]);
    expect(wholeBoxAround([0.1, 0.2, 0, 0])).toEqual([0, 0, 1, 1]);
    // A line's SVG: whole units round its points and 12 units of room.
    expect(lineBox([[200.3, 400.7], [520.6, 100.2]])).toEqual([188, 88, 345, 325]);
    expect(lineBox([[10, 20], [110, 20], [60, 70]])).toEqual([-2, 8, 124, 74]);
    expect(overlaps([0, 0, 10, 10], [10, 0, 10, 10])).toBe(false);
    expect(overlaps([0, 0, 10, 10], [9, 9, 10, 10])).toBe(true);
    expect(samples([1, 2, 3, 4])).toEqual([[1, 2, 0.5], [3, 4, 0.5]]);
  });
});
