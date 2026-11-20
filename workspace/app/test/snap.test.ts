import type { Box } from '@keel/protocol';
import { describe, expect, it } from 'vitest';
import { SNAP_DISTANCE } from '../src/input/constants';
import { resizeGuides, snapMove, snapResize, snapTargets } from '../src/select/snap';

/**
 * Snapping as plain geometry (`src/select/snap.ts`), on boxes laid out by hand. `reach` is the
 * snap distance in world units: `SNAP_DISTANCE` at 100%, half of it at 200%.
 */

const reach = SNAP_DISTANCE;

describe('a move snaps its edges and its centre to those of the things in view', () => {
  // One card at (0, 0), 200 by 100. What is moved is a box 100 by 50, put down 300 to the right of it.
  const card: Box = [0, 0, 200, 100];
  const targets = snapTargets([card]);
  const moved: Box = [300, 300, 100, 50];

  it('a left edge 8 px from the card’s left edge snaps onto it; 9 px does not', () => {
    // dx = -292 puts the left edge at 8, dx = -291 at 9.
    expect(snapMove(moved, -292, 0, targets, reach).dx).toBe(-300);
    expect(snapMove(moved, -291, 0, targets, reach).dx).toBe(-291);
  });

  it('the same 8 px from the other side', () => {
    expect(snapMove(moved, -308, 0, targets, reach).dx).toBe(-300);
    expect(snapMove(moved, -309, 0, targets, reach).dx).toBe(-309);
  });

  it('at 200% the reach is half as many world units: 4 snaps, 5 does not', () => {
    expect(snapMove(moved, -296, 0, targets, SNAP_DISTANCE / 2).dx).toBe(-300);
    expect(snapMove(moved, -295, 0, targets, SNAP_DISTANCE / 2).dx).toBe(-295);
  });

  it('a right edge snaps to a right edge, and to a left edge', () => {
    // The moved box's right edge (400 + dx) onto the card's right edge (200).
    expect(snapMove(moved, -197, 0, targets, reach).dx).toBe(-200);
    // Its right edge onto the card's left edge (0).
    expect(snapMove(moved, -403, 0, targets, reach).dx).toBe(-400);
  });

  it('a centre snaps to a centre, along each axis on its own', () => {
    // Centre x 350 + dx onto 100; centre y 325 + dy onto 50.
    const s = snapMove(moved, -246, -271, targets, reach);
    expect([s.dx, s.dy]).toEqual([-250, -275]);
  });

  it('the nearest line wins, also when it is found after a farther one', () => {
    // A box 104 wide moved by -307: its left edge is 7 from the card's left edge, its right edge 3 from the card's centre.
    expect(snapMove([300, 300, 104, 50], -307, 0, targets, reach).dx).toBe(-304);
  });

  it('a guide is drawn along the line things meet on, from end to end of both', () => {
    const s = snapMove(moved, -292, 0, targets, reach);
    expect(s.guides).toContainEqual({ kind: 'line', axis: 'x', at: 0, from: 0, to: 350 });
  });

  it('nothing in reach: the move as it was, and no guide', () => {
    const s = snapMove(moved, 37, 41, targets, reach);
    expect(s).toEqual({ dx: 37, dy: 41, guides: [] });
  });
});

describe('a move snaps to keep a gap equal', () => {
  // Two cards side by side with a gap of 100 between them, and a third below, out of the way.
  const a: Box = [0, 0, 100, 100];
  const b: Box = [200, 0, 100, 100];
  const targets = snapTargets([a, b]);

  it('in the middle of a gap wider than it', () => {
    // A box 40 wide, from x 500: its centre onto the gap's middle (150) is dx -370; 4 away snaps.
    const box: Box = [500, 30, 40, 40];
    expect(snapMove(box, -374, 0, targets, reach).dx).toBe(-370);
    const s = snapMove(box, -374, 0, targets, reach);
    expect(s.guides.filter((g) => g.kind === 'gap')).toEqual([
      { kind: 'gap', axis: 'x', from: 100, to: 130, at: 50 },
      { kind: 'gap', axis: 'x', from: 170, to: 200, at: 50 },
    ]);
  });

  it('a box wider than the gap is not put in its middle', () => {
    // 140 wide, from x 500: its centre onto the gap's middle (150) would be dx -420; 4 away, it stays.
    const box: Box = [500, 30, 140, 40];
    expect(snapMove(box, -416, 0, targets, reach).dx).toBe(-416);
  });

  it('as far past the right card as the gap is long; 8 px snaps, 9 px does not', () => {
    // Its left edge at 300 + 100 = 400 keeps the gap.
    const box: Box = [600, 20, 50, 50];
    expect(snapMove(box, -192, 0, targets, reach).dx).toBe(-200);
    expect(snapMove(box, -191, 0, targets, reach).dx).toBe(-191);
  });

  it('as far before the left card as the gap is long', () => {
    // Its right edge at 0 - 100 = -100.
    const box: Box = [-500, 20, 50, 50];
    expect(snapMove(box, 345, 0, targets, reach).dx).toBe(350);
  });

  it('of an equal gap and a line both in reach, the nearer is taken', () => {
    // One unit from the middle of the gap between the cards, five from the left edge of a third thing.
    const third: Box = [131, 500, 50, 50];
    expect(snapMove([126, 20, 50, 50], 0, 0, snapTargets([[0, 0, 100, 100], [200, 0, 100, 100], third]), 8).dx).toBe(-1);
    // And the line when it is the nearer: one unit from the edge, five from the middle of the gap.
    const near: Box = [129, 500, 50, 50];
    expect(snapMove([130, 20, 50, 50], 0, 0, snapTargets([[0, 0, 100, 100], [200, 0, 100, 100], near]), 8).dx).toBe(-1);
  });

  it('two things that do not face each other have no gap between them to keep', () => {
    // One is far below the other: nothing lies between them. A box where the middle of such a gap would be is left alone.
    expect(snapMove([126, 600, 50, 50], 0, 0, snapTargets([[0, 0, 100, 100], [200, 300, 100, 100]]), 8).dx).toBe(0);
  });

  it('only beside the gap: a box that does not reach across into it does not keep it', () => {
    const box: Box = [600, 300, 50, 50];
    expect(snapMove(box, -195, 0, targets, reach).dx).toBe(-195);
  });

  it('and up and down', () => {
    const t = snapTargets([
      [0, 0, 100, 100],
      [0, 200, 100, 100],
    ]);
    // Below the lower card by the gap: top at 400.
    expect(snapMove([20, 700, 50, 50], 0, -294, t, reach).dy).toBe(-300);
  });
});

describe('a resize snaps the edges that move', () => {
  const targets = snapTargets([[0, 0, 200, 100]]);

  it('the right edge to a right edge within reach, and how far it is to go', () => {
    expect(snapResize([-100, 200, 294, 50], 'e', targets, reach)).toEqual({ dx: 6, dy: 0 });
    expect(snapResize([-100, 200, 291, 50], 'e', targets, reach)).toEqual({ dx: 0, dy: 0 });
  });

  it('an edge that does not move does not snap', () => {
    // The left edge sits 3 from the card's left edge, and the right edge is the one dragged.
    expect(snapResize([3, 200, 500, 50], 'e', targets, reach)).toEqual({ dx: 0, dy: 0 });
  });

  it('a corner snaps each of its two edges', () => {
    expect(snapResize([300, 300, 100, 103], 'nw', targets, reach)).toEqual({ dx: 0, dy: 0 });
    expect(snapResize([204, 96, 100, 100], 'nw', targets, reach)).toEqual({ dx: -4, dy: 4 });
  });

  it('the guides show the lines the moving edges meet', () => {
    expect(resizeGuides([-100, 200, 300, 50], 'e', targets)).toEqual([{ kind: 'line', axis: 'x', at: 200, from: 0, to: 250 }]);
    expect(resizeGuides([-100, 200, 301, 50], 'e', targets)).toEqual([]);
  });
});
