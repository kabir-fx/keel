import { describe, expect, it } from 'vitest';
import { headAngle, headPath, headPoints, headSize, LABEL_MIDDLE, labelPoint, linePath, shareAlong } from '../src/arrowhead';
import { ARROWHEAD, ARROWHEAD_ANGLE, ARROWHEAD_WIDEST_ANGLE, ARROWHEAD_WIDEST_SIZE } from '../src/input/constants';

/**
 * What sits along an arrow's line (`src/arrowhead.ts`): its head, which shrinks on a short arrow
 * and opens wider as it does, and its label, at a share of the line.
 */

/** How long a side of a head is, and how far it opens from the line, in degrees. */
function measured(from: [number, number], to: [number, number]) {
  const [a, tip, b] = headPoints(from, to)!;
  const back = Math.atan2(from[1] - to[1], from[0] - to[0]);
  const open = (p: [number, number]) => {
    const turn = Math.atan2(p[1] - tip[1], p[0] - tip[0]) - back;
    return Math.abs((Math.atan2(Math.sin(turn), Math.cos(turn)) * 180) / Math.PI);
  };
  return { tip, sides: [Math.hypot(a[0] - tip[0], a[1] - tip[1]), Math.hypot(b[0] - tip[0], b[1] - tip[1])], open: [open(a), open(b)] };
}

describe('an arrow’s head', () => {
  it('on a long arrow, is the head the board has always had: 12 a side, open 25 degrees', () => {
    expect([ARROWHEAD, ARROWHEAD_ANGLE]).toEqual([12, 25]);
    // The marker the head was drawn with before it was a path: a side of 3.5 by 1.6, on a line 3 wide.
    expect(Math.abs(ARROWHEAD - 3 * Math.hypot(3.5, 1.6))).toBeLessThan(0.5);
    expect(Math.abs(ARROWHEAD_ANGLE - (Math.atan2(1.6, 3.5) * 180) / Math.PI)).toBeLessThan(0.5);
    const m = measured([0, 0], [300, 0]);
    expect(m.tip).toEqual([300, 0]);
    expect(m.sides[0]).toBeCloseTo(12, 10);
    expect(m.sides[1]).toBeCloseTo(12, 10);
    expect(m.open[0]).toBeCloseTo(25, 10);
    expect(m.open[1]).toBeCloseTo(25, 10);
  });

  it('on a 12 px arrow, is 6 px with a wider opening; on one of 10 px and under, half the arrow at the widest', () => {
    const m = measured([0, 0], [12, 0]);
    expect(m.sides[0]).toBeCloseTo(6, 10);
    expect(m.open[0]).toBeGreaterThan(ARROWHEAD_ANGLE);
    expect(m.open[0]).toBeCloseTo(25 + 30 / 7, 10);
    expect(m.open[1]).toBeCloseTo(25 + 30 / 7, 10);
    const short = measured([0, 0], [10, 0]);
    expect(short.sides[0]).toBeCloseTo(5, 10);
    expect(short.open[0]).toBeCloseTo(30, 10);
    expect(short.open[1]).toBeCloseTo(30, 10);
  });

  it('is the smaller of the full size and half the arrow, at either side of where they meet', () => {
    expect(headSize(24)).toBe(12);
    expect(headSize(23)).toBe(11.5);
    expect(headSize(25)).toBe(12);
    expect(headSize(12)).toBe(6);
  });

  it('opens from 25 degrees at full size to 30 at the widest size and under, in a straight line between', () => {
    expect([ARROWHEAD_WIDEST_SIZE, ARROWHEAD_WIDEST_ANGLE]).toEqual([5, 30]);
    expect(headAngle(12)).toBe(25);
    expect(headAngle(8.5)).toBe(27.5);
    expect(headAngle(6)).toBeCloseTo(25 + 30 / 7, 10);
    expect(headAngle(5)).toBe(30);
    expect(headAngle(4)).toBe(30);
    // Asked of a head bigger than the full size, it opens no less than the full size does.
    expect(headAngle(30)).toBe(25);
  });

  it('turns with the arrow, and points back along it', () => {
    const m = measured([100, 100], [100, 0]);
    expect(m.sides[0]).toBeCloseTo(12, 10);
    expect(m.open[0]).toBeCloseTo(25, 10);
    const [a, , b] = headPoints([100, 100], [100, 0])!;
    expect(a[1]).toBeGreaterThan(0);
    expect(b[1]).toBeGreaterThan(0);
    expect(Math.sign(a[0] - 100)).toBe(-Math.sign(b[0] - 100));
  });

  it('is a path from one side to the tip and on to the other, to a tenth; nothing on an arrow with no length', () => {
    expect(headPath([0, 0], [100, 0])).toBe('M 89.1 -5.1 L 100 0 L 89.1 5.1');
    expect(headPath([5, 5], [5, 5])).toBe('');
    expect(headPoints([5, 5], [5, 5])).toBeUndefined();
    expect(linePath([
      [0.04, 1],
      [2, 3.06],
    ])).toBe('M 0 1 L 2 3.1');
  });
});

describe('an arrow’s label', () => {
  it('sits at its share of the line: the middle when it has none', () => {
    expect(LABEL_MIDDLE).toBe(0.5);
    expect(labelPoint([0, 0], [200, 100])).toEqual([100, 50]);
    expect(labelPoint([0, 0], [200, 100], 0.25)).toEqual([50, 25]);
    expect(labelPoint([0, 0], [200, 100], 0.75)).toEqual([150, 75]);
  });

  it('dragged, goes to the share of the line nearest the pointer, between its ends, to three places', () => {
    expect(shareAlong([0, 0], [200, 0], [50, 40])).toBe(0.25);
    expect(shareAlong([0, 0], [200, 0], [-50, 0])).toBe(0);
    expect(shareAlong([0, 0], [200, 0], [250, 0])).toBe(1);
    expect(shareAlong([0, 0], [300, 0], [100, 0])).toBe(0.333);
    expect(shareAlong([5, 5], [5, 5], [9, 9])).toBe(0.5);
  });
});
