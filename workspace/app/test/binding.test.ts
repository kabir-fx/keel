import type { ArrowItem, Box, Id } from '@keel/protocol';
import { parseLog, replay } from '@keel/protocol';
import { describe, expect, it } from 'vitest';
import type { EndAim } from '../src/binding';
import { drawnEnds, entryInto, keptBoxes, lockAngle, outsideBy, sharesOf, spotIn, spotOnDiagonals, TIE_SPACE, tieAt, tieOn, tieReach, tiesAt, tieTargets } from '../src/binding';
import { fixtureNames, loadFixture } from '../src/fixture';
import type { TargetRect } from '../src/geometry';
import { lineBox } from '../src/geometry';
import { ANGLE_STEP, TIE_GAP, TIE_MIN_LENGTH, TIE_REACH } from '../src/input/constants';
import type { Where } from '../src/layout';
import { arrowEnds, shownBoxOf } from '../src/layout';
import { arrowItem } from '../src/marks';
import { ARROW_LINE } from '../src/markSizes';
import pinned from './fixtures/arrow-ends.json';
import { CH, note, openBoard } from './helpers';

/**
 * How an arrow holds on to what it points at (`src/binding.ts`): which thing an end ties to and
 * within what reach, the spot it holds, and where each end is drawn from where its targets are
 * now: the gap at each end, and the cases where an end goes to its spot instead. Boxes are laid
 * out by hand.
 */

const rect = (id: string, box: Box, parent?: string): TargetRect => ({ id, item: id.split('/')[0]!, ...(id.includes('/') ? { sub: id.split('/')[1] as `part:${string}` } : {}), ...(parent ? { parent } : {}), box });
const none = new Map<string, Box>();
/** The thing an end would tie to first. */
const tieTarget = (p: [number, number], rects: readonly TargetRect[], reach: number) => tieTargets(p, rects, reach)[0];

describe('how near is near: the reach of a tie', () => {
  it('is 15 board units at 100% and closer', () => {
    expect(tieReach(1)).toBe(TIE_REACH);
    expect(TIE_REACH).toBe(15);
    expect(tieReach(2)).toBe(15);
    expect(tieReach(4)).toBe(15);
  });

  it('grows as the board is zoomed out, by the formula, up to twice that', () => {
    // 15 / (zoom × 1.5), held between 15 and 30.
    expect(tieReach(0.8)).toBe(15);
    expect(tieReach(0.6)).toBeCloseTo(15 / 0.9, 10);
    expect(tieReach(0.5)).toBe(20);
    expect(tieReach(0.4)).toBeCloseTo(25, 10);
    expect(tieReach(1 / 3)).toBeCloseTo(30, 10);
    expect(tieReach(0.25)).toBe(30);
    expect(tieReach(0.2)).toBe(30);
  });

  it('an end 15 units outside a thing ties to it at 100%, and at 16 it does not', () => {
    const rects = [rect('m1', [100, 100, 200, 100])];
    expect(tieTarget([85, 150], rects, tieReach(1))).toMatchObject({ rect: { id: 'm1' }, mode: 'outline' });
    expect(tieTarget([84, 150], rects, tieReach(1))).toBeUndefined();
    // Off a corner, it is the straight distance that counts.
    expect(tieTarget([100 - 9, 100 - 12], rects, tieReach(1))).toBeDefined();
    expect(tieTarget([100 - 9, 100 - 12.1], rects, tieReach(1))).toBeUndefined();
  });

  it('zoomed out to 50%, 20 units ties and 21 does not', () => {
    const rects = [rect('m1', [100, 100, 200, 100])];
    expect(tieTarget([80, 150], rects, tieReach(0.5))).toBeDefined();
    expect(tieTarget([79, 150], rects, tieReach(0.5))).toBeUndefined();
  });
});

describe('which thing an end ties to, and how', () => {
  const card = rect('a1', [0, 0, 400, 300]);
  const part = rect('a1/part:queue', [100, 100, 100, 50], 'a1');

  it('on a thing, the deepest thing under it, at that exact spot', () => {
    expect(tieTarget([150, 120], [card, part], TIE_REACH)).toMatchObject({ rect: { id: 'a1/part:queue' }, mode: 'inside' });
    expect(tieTarget([20, 20], [card, part], TIE_REACH)).toMatchObject({ rect: { id: 'a1' }, mode: 'inside' });
  });

  it('just outside things, the nearest, on its outline', () => {
    const a = rect('m1', [0, 0, 100, 100]);
    const b = rect('m2', [120, 0, 100, 100]);
    expect(tieTarget([108, 50], [a, b], TIE_REACH)).toMatchObject({ rect: { id: 'm1' }, mode: 'outline' });
    expect(tieTarget([108, 50], [b, a], TIE_REACH)).toMatchObject({ rect: { id: 'm1' }, mode: 'outline' });
    expect(tieTarget([113, 50], [a, b], TIE_REACH)).toMatchObject({ rect: { id: 'm2' }, mode: 'outline' });
  });

  it('just outside a thing and a part of it that are as near, the part, however deep', () => {
    const edge = rect('a1/part:edge', [0, 0, 100, 40], 'a1');
    expect(tieTarget([50, -10], [card, edge], TIE_REACH)).toMatchObject({ rect: { id: 'a1/part:edge' } });
    expect(tieTarget([50, -10], [edge, card], TIE_REACH)).toMatchObject({ rect: { id: 'a1/part:edge' } });
    // A step in an approach in a card, on the card's edge; the approach a little further in.
    const approach = rect('a1/approach:a', [0, 5, 200, 100], 'a1');
    const step = rect('a1/step:a-1', [0, 0, 100, 40], 'a1/approach:a');
    expect(tieTarget([50, -10], [card, approach, step], TIE_REACH)).toMatchObject({ rect: { id: 'a1/step:a-1' } });
  });

  it('how far outside a box a point is: 0 on it or in it', () => {
    expect(outsideBy([50, 50], [0, 0, 100, 100])).toBe(0);
    expect(outsideBy([100, 100], [0, 0, 100, 100])).toBe(0);
    expect(outsideBy([103, 104], [0, 0, 100, 100])).toBe(5);
  });

  it('the spot is kept as shares of the target, inside it, to four places', () => {
    expect(sharesOf([150, 120], [100, 100, 100, 50])).toEqual([0.5, 0.4]);
    // A point outside the box is kept inside it.
    expect(sharesOf([90, 175], [100, 100, 100, 50])).toEqual([0, 1]);
    expect(sharesOf([100 + 100 / 3, 100], [100, 100, 100, 50])).toEqual([0.3333, 0]);
    // A box with no width or no height holds its middle on that axis.
    expect(sharesOf([7, 9], [0, 0, 0, 20])).toEqual([0.5, 0.45]);
    expect(spotIn([0.5, 0.4], [100, 100, 100, 50])).toEqual([150, 120]);
  });

  it('a tie is counted from where the thing is drawn now, where the board says; else where it was measured', () => {
    const rects = [rect('m1', [0, 0, 100, 40])];
    const other: [number, number] = [50, -200];
    expect(tieAt([50, 30], other, rects, TIE_REACH, () => [0, 0, 100, 60])).toEqual({ end: { target: { item: 'm1' }, tie: { at: [0.5, 0.5], mode: 'inside' } }, box: [0, 0, 100, 60] });
    expect(tieAt([50, 30], other, rects, TIE_REACH, () => undefined)?.end.tie.at).toEqual([0.5, 0.75]);
    expect(tieAt([500, 30], other, rects, TIE_REACH, () => undefined)).toBeUndefined();
  });

  it('where a thing is drawn is asked once a thing in a gesture: a picture and a part of it are two things', () => {
    const asked: string[] = [];
    const boxOf = keptBoxes((t) => {
      asked.push(t.sub ? `${t.item}/${t.sub}` : t.item);
      return t.sub ? [10, 10, 20, 20] : [0, 0, 100, 100];
    });
    expect(boxOf({ item: 'a1' })).toEqual([0, 0, 100, 100]);
    expect(boxOf({ item: 'a1', sub: 'part:queue' })).toEqual([10, 10, 20, 20]);
    expect(boxOf({ item: 'a1' })).toEqual([0, 0, 100, 100]);
    expect(boxOf({ item: 'a1', sub: 'part:queue' })).toEqual([10, 10, 20, 20]);
    expect(asked).toEqual(['a1', 'a1/part:queue']);
  });

  it('both ends of a new arrow, with the reach at 100%', () => {
    const rects = [rect('m1', [0, 0, 100, 100]), rect('m2', [300, 0, 100, 100])];
    const boxOf = (t: { item: string }) => rects.find((r) => r.item === t.item)?.box;
    // The head stops 15 short of the second note, pointing at its middle.
    expect(tiesAt([50, 50], [285, 50], rects, boxOf)).toEqual({
      from: { target: { item: 'm1' }, tie: { at: [0.5, 0.5], mode: 'inside' } },
      to: { target: { item: 'm2' }, tie: { at: [0.5, 0.5], mode: 'outline' } },
    });
    expect(tiesAt([50, 50], [284, 50], rects, boxOf)).toEqual({ from: { target: { item: 'm1' }, tie: { at: [0.5, 0.5], mode: 'inside' } } });
    // A tail begun just outside a note, on an arrow that leaves it: the note lies behind the tail, on the arrow's line.
    expect(tiesAt([110, 50], [250, 50], rects, boxOf)).toEqual({ from: { target: { item: 'm1' }, tie: { at: [0.5, 0.5], mode: 'outline' } } });
  });
});

describe('the spot an end holds on a thing it stops just short of', () => {
  const box: Box = [100, 0, 100, 100];

  it('is where the arrow’s line, carried on, first meets one of the thing’s diagonals', () => {
    // Level through the middle: both diagonals, at the middle.
    expect(spotOnDiagonals([0, 50], [90, 50], box)).toEqual([150, 50]);
    // Level, a fifth of the way down: the first diagonal it meets.
    expect(spotOnDiagonals([0, 20], [90, 20], box)).toEqual([120, 20]);
    // Slanting: still on the arrow's own line.
    const [x, y] = spotOnDiagonals([0, 0], [90, 45], box)!;
    expect(x).toBeCloseTo(400 / 3, 10);
    expect(y).toBeCloseTo(200 / 3, 10);
    // Along one diagonal, it meets the other, at the middle.
    expect(spotOnDiagonals([50, -50], [90, -10], box)).toEqual([150, 50]);
  });

  it('is nothing when the thing does not lie ahead of the end', () => {
    // The line passes beside the thing.
    expect(spotOnDiagonals([0, -10], [90, -10], box)).toBeUndefined();
    // The end has come through the thing and out the far side.
    expect(spotOnDiagonals([0, 50], [210, 50], box)).toBeUndefined();
    // The arrow leaves the thing: it begins inside it.
    expect(spotOnDiagonals([150, 50], [210, 50], box)).toBeUndefined();
    // An arrow with no length points nowhere.
    expect(spotOnDiagonals([90, 50], [90, 50], box)).toBeUndefined();
    // A thing with no size has no diagonals.
    expect(spotOnDiagonals([0, 50], [90, 50], [100, 50, 0, 0])).toBeUndefined();
  });

  it('an end just outside a thing ties to it when the arrow points at it, by its outline, with that spot; else to nothing', () => {
    const rects = [rect('m1', box)];
    expect(tieAt([90, 20], [0, 20], rects, TIE_REACH, () => undefined)).toEqual({ end: { target: { item: 'm1' }, tie: { at: [0.2, 0.2], mode: 'outline' } }, box });
    // In reach of its corner, and passing above it.
    expect(tieTarget([90, -10], rects, TIE_REACH)).toMatchObject({ mode: 'outline' });
    expect(tieAt([90, -10], [0, -10], rects, TIE_REACH, () => undefined)).toBeUndefined();
    // Through it and out the far side, still in reach.
    expect(tieAt([210, 50], [0, 50], rects, TIE_REACH, () => undefined)).toBeUndefined();
    // The thing is decided where the end is; its spot by where the arrow comes from.
    const hits = tieTargets([90, 50], rects, TIE_REACH);
    expect(tieOn(hits, [90, 50], [0, 50], () => undefined)?.end.tie.at).toEqual([0.5, 0.5]);
    expect(tieOn(hits, [90, 50], [0, 5], () => undefined)?.end.tie.at).toEqual([0.3, 0.7]);
    expect(tieOn([], [90, 50], [0, 50], () => undefined)).toBeUndefined();
  });

  it('of the things within reach, an end ties to the nearest one the arrow points at: a nearer thing beside its line does not take it', () => {
    const ahead = rect('ahead', [100, 0, 100, 100]);
    const beside = rect('beside', [60, 52, 32, 40]);
    // The end is 5 short of the thing dead ahead, and 3.6 from the corner of a thing that lies under its line.
    expect(tieTargets([95, 50], [ahead, beside], TIE_REACH).map((h) => [h.rect.id, h.mode])).toEqual([
      ['beside', 'outline'],
      ['ahead', 'outline'],
    ]);
    expect(tieAt([95, 50], [-200, 50], [ahead, beside], TIE_REACH, () => undefined)).toEqual({ end: { target: { item: 'ahead' }, tie: { at: [0.5, 0.5], mode: 'outline' } }, box: ahead.box });
    expect(tiesAt([-200, 50], [95, 50], [ahead, beside], () => undefined).to?.target).toEqual({ item: 'ahead' });
    // Aimed down into the nearer one, it ties to that.
    expect(tieAt([95, 50], [110, 0], [ahead, beside], TIE_REACH, () => undefined)?.end).toEqual({ target: { item: 'beside' }, tie: { at: [0.7818, 0.7818], mode: 'outline' } });
    // Aimed at neither, to nothing.
    expect(tieAt([95, 50], [95, 300], [ahead, beside], TIE_REACH, () => undefined)).toBeUndefined();
    // Out of reach of the one it points at, it does not tie to it, however near the other is.
    expect(tieAt([84, 50], [-200, 50], [ahead, beside], TIE_REACH, () => undefined)).toBeUndefined();
    // A thing under the end is the only one it can tie to.
    expect(tieTargets([150, 50], [ahead, beside], TIE_REACH)).toEqual([{ rect: ahead, mode: 'inside' }]);
  });

  it('things equally near are tried the deeper one first, so a part comes before the picture it is in, whatever order they were measured in', () => {
    const card = rect('a1', [0, 0, 400, 300]);
    const approach = rect('a1/approach:a', [0, 0, 200, 100], 'a1');
    const step = rect('a1/step:a-1', [0, 0, 100, 40], 'a1/approach:a');
    const other = rect('m9', [0, -120, 100, 100]);
    const ids = (rects: TargetRect[]) => tieTargets([50, -10], rects, TIE_REACH).map((h) => h.rect.id);
    expect(ids([card, approach, step, other])).toEqual(['a1/step:a-1', 'a1/approach:a', 'a1', 'm9']);
    // Two that are not one inside the other keep the order they were measured in.
    expect(ids([other, step, card, approach])).toEqual(['a1/step:a-1', 'a1/approach:a', 'm9', 'a1']);
  });
});

describe('where the ends are drawn: the gap, and when an end goes to its spot', () => {
  const box: Box = [100, 0, 100, 100];
  const outline = (b: Box, spot: [number, number]): EndAim => ({ spot, tie: { box: b, mode: 'outline' } });
  const inside = (b: Box, spot: [number, number]): EndAim => ({ spot, tie: { box: b, mode: 'inside' } });

  it('the gap is 5 plus half the line: the head stops that far short of the outline it is aimed through', () => {
    expect(TIE_SPACE).toBe(TIE_GAP + ARROW_LINE / 2);
    expect(TIE_SPACE).toBe(6.5);
    expect(drawnEnds({ spot: [0, 50] }, outline(box, [150, 50]))).toEqual([
      [0, 50],
      [93.5, 50],
    ]);
    // Aimed at a spot on the edge: stopped at the outline it comes to first all the same.
    expect(drawnEnds({ spot: [0, 50] }, outline(box, [100, 50]))[1]).toEqual([93.5, 50]);
    // From above, through the top.
    expect(drawnEnds({ spot: [150, -200] }, outline(box, [150, 50]))[1]).toEqual([150, -6.5]);
  });

  it('a head tied to an exact spot is drawn at the spot, on the thing', () => {
    expect(drawnEnds({ spot: [0, 50] }, inside(box, [150, 50]))[1]).toEqual([150, 50]);
  });

  it('the tail stops short of the outline it is tied to as well, on the line between the two spots', () => {
    const a: Box = [0, 0, 100, 100];
    expect(drawnEnds(outline(a, [50, 50]), { spot: [300, 50] })).toEqual([
      [106.5, 50],
      [300, 50],
    ]);
    // Slanting away from its corner.
    expect(drawnEnds(outline(a, [50, 50]), { spot: [250, 250] })[0]).toEqual([106.5, 106.5]);
    // A tail tied to an exact spot begins on it.
    expect(drawnEnds(inside(a, [50, 50]), { spot: [300, 50] })[0]).toEqual([50, 50]);
    // Both ends by their outlines: each stops short of its own thing.
    expect(drawnEnds(outline(a, [50, 50]), outline([300, 0, 100, 100], [350, 50]))).toEqual([
      [106.5, 50],
      [293.5, 50],
    ]);
  });

  it('a tail whose outline would leave an arrow with a free head 10 long or shorter begins at its spot', () => {
    expect(TIE_MIN_LENGTH).toBe(10);
    const a: Box = [0, 0, 100, 100];
    // The outline point is at 106.5: 10 from a head at 116.5, a little more from one at 116.6.
    expect(drawnEnds(outline(a, [50, 50]), { spot: [116.5, 50] })[0]).toEqual([50, 50]);
    expect(drawnEnds(outline(a, [50, 50]), { spot: [116.6, 50] })[0]).toEqual([106.5, 50]);
    // A head that is tied leaves the tail on its outline, however near.
    expect(drawnEnds(outline(a, [50, 50]), inside([110, 0, 100, 100], [116.5, 50]))[0]).toEqual([106.5, 50]);
  });

  it('where the outline point would lie on the tail’s thing, the head is drawn at its spot, and the tail stays on its outline', () => {
    // Two cards 4 apart: the point 6.5 short of the second lies on the first.
    const a: Box = [0, 0, 100, 100];
    const b: Box = [104, 0, 100, 100];
    expect(drawnEnds(outline(a, [50, 50]), outline(b, [154, 50]))).toEqual([
      [106.5, 50],
      [154, 50],
    ]);
    // 10 apart, it lies in the gap round the first one: on it, for this.
    expect(drawnEnds(outline(a, [50, 50]), outline([110, 0, 100, 100], [160, 50]))[1]).toEqual([160, 50]);
    // A tail that is not tied has no thing to fall on.
    expect(drawnEnds({ spot: [50, 50] }, outline(b, [154, 50]))[1]).toEqual([97.5, 50]);
  });

  it('…unless the tail’s thing is twice as big or more, as a picture round one of its own parts is', () => {
    const part: Box = [100, 100, 50, 50];
    const twice: Box = [0, 0, 100, 50]; // 5,000: twice the part's 2,500
    const under: Box = [0, 0, 100, 49.9];
    // Laid out so the outline point is on the tail's thing, at twice the part's size and a little under.
    const onTail = (b: Box) => drawnEnds(inside([b[0], 100, b[2], b[3]], [20, 125]), outline(part, [125, 125]))[1];
    expect(onTail(twice)).toEqual([93.5, 125]);
    expect(onTail(under)).toEqual([125, 125]);
  });

  it('a head whose outline would leave 10 or less of the arrow to see is drawn at its spot', () => {
    const b: Box = [20, 0, 100, 100];
    // From a free tail: the outline point is at 13.5, 10 from a tail at 3.5, a little more from one at 3.4.
    expect(drawnEnds({ spot: [3.5, 50] }, outline(b, [20, 50]))[1]).toEqual([20, 50]);
    expect(drawnEnds({ spot: [3.4, 50] }, outline(b, [20, 50]))[1]).toEqual([13.5, 50]);
    // From a tied tail, counted from where the line leaves the tail's thing: two cards 23 apart leave 10, and 23.5 a little more.
    const a: Box = [0, 0, 100, 100];
    expect(drawnEnds(outline(a, [50, 50]), outline([123, 0, 100, 100], [173, 50]))[1]).toEqual([173, 50]);
    expect(drawnEnds(outline(a, [50, 50]), outline([123.5, 0, 100, 100], [173.5, 50]))[1]).toEqual([117, 50]);
    // The same from a tail tied to an exact spot deep in its thing: it is the thing's outline that counts.
    expect(drawnEnds(inside(a, [10, 50]), outline([123, 0, 100, 100], [173, 50]))[1]).toEqual([173, 50]);
    expect(drawnEnds(inside(a, [10, 50]), outline([123.5, 0, 100, 100], [173.5, 50]))[1]).toEqual([117, 50]);
  });

  it('a tail whose own thing the head is drawn on begins at its spot: an arrow is never drawn turned round', () => {
    // A small thing laid over the edge of one far bigger. The head stops 6.5 short of the small one, 16.5 inside the big one, and the tail's outline is 23 past it.
    const big: Box = [0, 0, 200, 200];
    expect(drawnEnds(outline(big, [100, 100]), outline([190, 80, 40, 40], [210, 100]))).toEqual([
      [100, 100],
      [183.5, 100],
    ]);
    // As from a picture to a part of it, where the tail holds an exact spot.
    expect(drawnEnds(inside(big, [100, 100]), outline([190, 80, 40, 40], [210, 100]))).toEqual([
      [100, 100],
      [183.5, 100],
    ]);
    // On a steep line the head can stop in the gap round the big one, outside it, and more than 10 before the tail's outline: the same.
    const [tail, head] = drawnEnds(outline(big, [190, 10]), outline([203, 100, 40, 40], [207.5, 136]));
    expect(tail).toEqual([190, 10]);
    expect(head[0]).toBeCloseTo(190 + (25 * 83.5) / 180, 9);
    expect(head[1]).toBe(93.5);
    // Clear of each other, each end stops short of its own thing.
    expect(drawnEnds(outline(big, [100, 100]), outline([230, 80, 40, 40], [250, 100]))).toEqual([
      [206.5, 100],
      [223.5, 100],
    ]);
    // Wherever one thing is put across the edge of another, bigger or of a size with it, the arrow is drawn the way it points.
    for (const size of [40, 150]) {
      for (let x = 100; x <= 260; x += 0.5) {
        for (const y of [0, 37, 80, 141]) {
          const spot: [number, number] = [x + size / 2, y + size / 2];
          const [tail, head] = drawnEnds(outline(big, [100, 100]), outline([x, y, size, size], spot));
          const along = (head[0] - tail[0]) * (spot[0] - 100) + (head[1] - tail[1]) * (spot[1] - 100);
          expect(along, `a thing ${size} wide at ${x}, ${y}: drawn from ${tail} to ${head}`).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('a tail inside the head’s thing, grown by the gap, leaves the head at its spot: there is no outline between them', () => {
    expect(drawnEnds({ spot: [95, 50] }, outline(box, [150, 50]))[1]).toEqual([150, 50]);
    expect(entryInto([95, 50], [150, 50], [93.5, -6.5, 113, 113])).toBeUndefined();
    expect(entryInto([0, 50], [150, 50], [93.5, -6.5, 113, 113])).toEqual([93.5, 50]);
    expect(entryInto([0, 500], [10, 500], [93.5, -6.5, 113, 113])).toBeUndefined();
    // A line beside the box, level with it or slanting past it, never comes in.
    expect(entryInto([0, 500], [200, 500], [93.5, -6.5, 113, 113])).toBeUndefined();
    expect(entryInto([0, 200], [200, 150], [93.5, -6.5, 113, 113])).toBeUndefined();
    // A line along a side of the box is on it: it comes in at the corner.
    expect(entryInto([0, -6.5], [150, -6.5], [93.5, -6.5, 113, 113])).toEqual([93.5, -6.5]);
    expect(entryInto([93.5, 249.5], [93.5, -6.5], [93.5, -6.5, 113, 113])).toEqual([93.5, 106.5]);
  });

  it('free ends are drawn where they are', () => {
    expect(drawnEnds({ spot: [1, 2] }, { spot: [3, 4] })).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });
});

describe('Shift: steps of 15 degrees', () => {
  const angle = (from: [number, number], to: [number, number]) => (Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI;

  it('the arrow goes to the nearest step, and its end to the point on that ray nearest the pointer', () => {
    expect(ANGLE_STEP).toBe(15);
    expect(lockAngle([0, 0], [100, 10])).toEqual([100, 0]);
    const [x, y] = lockAngle([0, 0], [100, 30]);
    expect(angle([0, 0], [x, y])).toBeCloseTo(15, 10);
    // The pointer is straight off the ray from where the end is put.
    expect((100 - x) * x + (30 - y) * y).toBeCloseTo(0, 8);
    // Upright and level rays are exactly so.
    expect(lockAngle([10, 10], [11, 110])).toEqual([10, 110]);
    expect(lockAngle([10, 10], [-90, 9])).toEqual([-90, 10]);
  });

  it('a step either side of the middle between two steps', () => {
    const at = (deg: number) => [Math.cos((deg * Math.PI) / 180) * 100, Math.sin((deg * Math.PI) / 180) * 100] as [number, number];
    expect(angle([0, 0], lockAngle([0, 0], at(7.4)))).toBeCloseTo(0, 8);
    expect(angle([0, 0], lockAngle([0, 0], at(7.6)))).toBeCloseTo(15, 8);
    for (let deg = -180; deg < 180; deg += 7) {
      const got = angle([0, 0], lockAngle([0, 0], at(deg)));
      expect(Math.abs(Math.round(got / 15) * 15 - got)).toBeLessThan(1e-8);
    }
  });
});

/* ------------------------------------------------------------ on the board */

/** A board with two notes, and an arrow drawn from inside the first to just outside the second. */
function tiedBoard() {
  const b = openBoard();
  b.must('owner', note('m1', [0, 0, 300, 100]));
  b.must('owner', note('m2', [600, 0, 300, 100]));
  const rects = [rect('m1', [0, 0, 300, 100]), rect('m2', [600, 0, 300, 100])];
  const boxOf = (t: { item: string }) => rects.find((r) => r.item === t.item)?.box;
  const arrow = arrowItem('a1', [100, 50], [590, 50], rects, boxOf);
  b.must('owner', { type: 'item.add', chapter: CH, item: arrow });
  return b;
}

const whereOf = (state: Where['state'], boxes: ReadonlyMap<Id, Box> = new Map()): Where => ({ state, boxes, subs: none });
const endsOf = (w: Where, id: Id) => arrowEnds(w, w.state.items[id]!.item as ArrowItem, shownBoxOf(w, id)!);
const moveTo = (id: Id, box: Box) => ({ type: 'item.update', item: id, patch: { box } });

describe('an arrow on the board holds on to what it points at', () => {
  it('a new arrow holds the spot it started on, and the thing it points at by its outline', () => {
    const b = tiedBoard();
    expect(b.state.items.a1!.item).toMatchObject({
      fromTarget: { item: 'm1' },
      fromTie: { at: [0.3333, 0.5], mode: 'inside' },
      toTarget: { item: 'm2' },
      toTie: { at: [0.5, 0.5], mode: 'outline' },
    });
    // The tail on its spot; the head 6.5 short of the second note, pointing at its middle.
    expect(endsOf(whereOf(b.state), 'a1')).toEqual([
      [99.99, 50],
      [593.5, 50],
    ]);
  });

  it('a tie’s spot survives a save and a reload: the log written and read back draws the same ends', () => {
    const b = tiedBoard();
    const { events, problems } = parseLog(b.events.map((e) => JSON.stringify(e)).join('\n'));
    expect(problems).toEqual([]);
    const again = replay(events);
    expect(again.items.a1!.item).toEqual(b.state.items.a1!.item);
    expect(endsOf(whereOf(again), 'a1')).toEqual(endsOf(whereOf(b.state), 'a1'));
  });

  it('move the thing an arrow starts from: the start stays at its spot on that thing', () => {
    const b = tiedBoard();
    // Both ends on a note: the arrow hangs on the one it points at, and the one it starts from moves.
    const rects = [rect('m1', [0, 0, 300, 100]), rect('m2', [600, 0, 300, 100])];
    b.must('owner', { type: 'item.add', chapter: CH, item: arrowItem('a2', [100, 50], [700, 50], rects, (t) => rects.find((r) => r.item === t.item)?.box) });
    b.must('owner', moveTo('m1', [0, 300, 300, 100]));
    const [from] = endsOf(whereOf(b.state), 'a2');
    // A third of the way along the note, halfway down it, where the arrow was started: not its nearest edge.
    expect(from[0]).toBeCloseTo(100, 1);
    expect(from[1]).toBe(350);
  });

  it('the head follows the thing it points at through a move and a resize, and stays short of it', () => {
    const b = tiedBoard();
    b.must('owner', moveTo('m2', [600, 400, 300, 100]));
    // Aimed from the tail's spot at the middle of the note, now at (750, 450): it comes down to the note's top, and stops 6.5 short of it.
    // The tail is on its spot, a third of the way along the first note: at 99.99, its share kept to four places.
    const [, moved] = endsOf(whereOf(b.state), 'a1');
    expect(moved[1]).toBeCloseTo(393.5, 9);
    expect(moved[0]).toBeCloseTo(99.99 + ((750 - 99.99) * (393.5 - 50)) / (450 - 50), 9);
    b.must('owner', moveTo('m2', [600, 0, 600, 300]));
    // Twice as big: its middle is at (900, 150), and the head comes to its left edge.
    const [, resized] = endsOf(whereOf(b.state), 'a1');
    expect(resized[0]).toBeCloseTo(593.5, 9);
    expect(resized[1]).toBeCloseTo(50 + ((150 - 50) * (593.5 - 99.99)) / (900 - 99.99), 9);
  });

  it('the ends follow a move before it is posted, from boxes the page knows ahead of the log', () => {
    const b = tiedBoard();
    const ahead = new Map<Id, Box>([['m1', [0, 300, 300, 100]]]);
    const [from] = endsOf(whereOf(b.state, ahead), 'a1');
    expect(from[1]).toBe(350);
  });

  it('an end whose thing has gone is drawn where the arrow’s box puts it', () => {
    const b = tiedBoard();
    b.must('owner', { type: 'item.remove', item: 'm2' });
    expect(endsOf(whereOf(b.state), 'a1')[1]).toEqual([590, 50]);
  });
});

describe('every arrow of the fixtures draws exactly what it drew before ties', () => {
  /** The ends, the path and the box of each arrow, as the code before ties drew them: taken from it, and kept. */
  const before: Record<string, unknown[]> = pinned;
  const r1 = (n: number) => Math.round(n * 10) / 10;

  it('pins every arrow of the golden fixture and the app’s fixtures', () => {
    expect(Object.keys(before).sort()).toEqual(['bench', 'bench moved', 'engine-loop', 'engine-loop moved']);
    expect(fixtureNames()).toEqual(expect.arrayContaining(['bench', 'engine-loop']));
    expect(Object.values(before).reduce((n, rows) => n + rows.length, 0)).toBe(86);
  });

  it.each(Object.keys(before))('%s', async (key) => {
    const [name, moved] = key.split(' ') as [string, string | undefined];
    const fx = (await loadFixture(name))!;
    const state = replay(fx.events);
    const arrows = state.itemOrder.map((id) => state.items[id]!).filter((s) => !s.removed && s.item.kind === 'arrow').map((s) => s.item as ArrowItem);
    // The parts each arrow points at, and, for the moved board, each thing an arrow points at moved: as when they were taken.
    const subs = new Map<string, Box>();
    const boxes = new Map<Id, Box>();
    for (const a of arrows) {
      for (const t of [a.fromTarget, a.toTarget]) {
        const b = t ? state.items[t.item]?.item.box : undefined;
        if (!t || !b) continue;
        if (t.sub) subs.set(`${t.item}/${t.sub}`, [b[0] + 20, b[1] + 30, 80, 40]);
        if (moved) boxes.set(t.item, [b[0] + 37, b[1] - 23, b[2], b[3]]);
      }
    }
    const w: Where = { state, boxes, subs };
    const now = arrows.map((a) => {
      const shown = shownBoxOf(w, a.id)!;
      const ends = arrowEnds(w, a, shown);
      return { id: a.id, shown, ends, d: `M ${ends.map((p) => `${r1(p[0])} ${r1(p[1])}`).join(' L ')}`, box: lineBox(ends) };
    });
    expect(now).toEqual(before[key]);
  });
});
