import { describe, expect, it } from 'vitest';
import type { TargetRect, XY } from '../src/geometry';
import { chooseAnchor, enclosedBy, isCross, lassoTargets, pairs, readHint, readInk, targetAtPoint, thin, underTargets } from '../src/geometry';
import recorded from './fixtures/strokes.json';

/**
 * The pen's reading, on strokes frozen as data (`fixtures/strokes.json`): hand-like strokes with
 * wobble, uneven speed, overshoot and hooks, and the owner's 20-stroke sketch from the golden
 * fixture. The board they are read on is a test double: a card with three questions, as the
 * `text` renderer draws them, and a spread whose approaches hold steps.
 */

const S = recorded as Record<string, number[][]>;
const strokes = (name: string): XY[][] => S[name]!.map((f) => pairs(f));

const board: TargetRect[] = [
  { id: 'n1', item: 'n1', box: [40, 60, 300, 120] },
  { id: 'a1', item: 'a1', box: [360, 100, 400, 200] },
  { id: 'a1/q:1', item: 'a1', sub: 'q:1', parent: 'a1', box: [376, 190, 368, 24] },
  { id: 'a1/q:2', item: 'a1', sub: 'q:2', parent: 'a1', box: [376, 216, 368, 24] },
  { id: 'a1/q:3', item: 'a1', sub: 'q:3', parent: 'a1', box: [376, 242, 368, 24] },
  { id: 'sp', item: 'sp', box: [800, 100, 600, 300] },
  { id: 'sp/approach:a', item: 'sp', sub: 'approach:a', parent: 'sp', box: [816, 140, 280, 240] },
  { id: 'sp/step:a-take', item: 'sp', sub: 'step:a-take', parent: 'sp/approach:a', box: [832, 180, 120, 40] },
  { id: 'sp/approach:b', item: 'sp', sub: 'approach:b', parent: 'sp', box: [1104, 140, 280, 240] },
];

describe('the hint of one go of the pen, on recorded strokes', () => {
  it.each([
    ['circleRound', 'circle'],
    ['circleOpen', 'circle'],
    ['circleSpiral', 'circle'],
    ['boxInOneGo', 'circle'],
    ['cShape', 'none'],
    ['crossQuick', 'cross'],
    ['equals', 'none'],
    ['tee', 'none'],
    ['underline', 'underline'],
    ['steep', 'none'],
    ['zigzag', 'none'],
    ['tick', 'none'],
    ['sketch', 'none'],
  ])('%s reads as %s', (name, hint) => {
    expect(readHint(strokes(name))).toBe(hint);
  });

  it('reads an X as two strokes that meet near their middles, whatever their angle', () => {
    const [a, b] = strokes('crossQuick') as [XY[], XY[]];
    expect(isCross(a, b)).toBe(true);
    expect(isCross(a, a)).toBe(false);
  });

  it('keeps a stroke small for the log, ends and all', () => {
    const dense: XY[] = Array.from({ length: 9000 }, (_, i) => [i / 10, Math.sin(i / 100) * 20]);
    const t = thin(dense);
    expect(t.length).toBeLessThanOrEqual(3000);
    expect(t[0]).toEqual(dense[0]);
    expect(t[t.length - 1]).toEqual(dense[dense.length - 1]);
  });
});

describe('what the pen points at', () => {
  it('a loop round a question targets that question, and is anchored to it', () => {
    expect(readInk(strokes('circleRound'), board)).toEqual({ hint: 'circle', targets: ['a1/q:2'], anchor: 'a1/q:2' });
  });

  it('a cross over a question targets the one it best covers', () => {
    expect(readInk(strokes('crossQuick'), board)).toEqual({ hint: 'cross', targets: ['a1/q:3'], anchor: 'a1/q:3' });
  });

  it('an underline targets what sits just above it', () => {
    expect(readInk(strokes('underline'), board)).toEqual({ hint: 'underline', targets: ['a1/q:1'], anchor: 'a1/q:1' });
  });

  it('a level line with nothing above it is a sketch, not an underline', () => {
    const line: XY[] = [
      [100, 700],
      [300, 702],
    ];
    expect(readInk([line], board).hint).toBe('none');
  });

  it('a sketch on bare ground has no targets and no anchor', () => {
    const far = strokes('sketch').map((s) => s.map(([x, y]): XY => [x + 2000, y + 2000]));
    expect(readInk(far, board)).toEqual({ hint: 'none', targets: [] });
  });

  it('a loop round a whole approach takes the approach, not its steps', () => {
    const loop: XY[] = Array.from({ length: 50 }, (_, i) => [956 + 180 * Math.cos((i / 49) * 2 * Math.PI), 260 + 150 * Math.sin((i / 49) * 2 * Math.PI)]);
    expect(readInk([loop], board).targets).toEqual(['sp/approach:a']);
  });

  it('a small loop inside a big picture, with nothing small in it, rings the picture', () => {
    const loop: XY[] = Array.from({ length: 40 }, (_, i) => [1250 + 20 * Math.cos((i / 39) * 2 * Math.PI), 120 + 12 * Math.sin((i / 39) * 2 * Math.PI)]);
    expect(readInk([loop], board)).toEqual({ hint: 'circle', targets: ['sp'], anchor: 'sp' });
  });

  it('underTargets picks the nearest row, inner before outer', () => {
    expect(underTargets(strokes('underline')[0]!, board)).toEqual(['a1/q:1']);
  });
});

describe('the lasso, the box, the arrow, the pin', () => {
  it('a lasso takes the items mostly inside it', () => {
    const loop: XY[] = [
      [20, 40],
      [780, 40],
      [780, 320],
      [20, 320],
    ];
    expect(lassoTargets(loop, board)).toEqual(['n1', 'a1']);
  });

  it('a lasso round one approach of a spread takes that approach, outermost first', () => {
    const loop: XY[] = [
      [806, 130],
      [1100, 130],
      [1100, 390],
      [806, 390],
    ];
    expect(lassoTargets(loop, board)).toEqual(['sp/approach:a']);
  });

  it('a box is drawn round what is mostly inside it', () => {
    expect(enclosedBy([20, 40, 340, 160], board)).toEqual(['n1']);
    expect(chooseAnchor([20, 40, 340, 160], ['n1'], board)).toBe('n1');
  });

  it('an anchor for marks on several things in one item is the item', () => {
    expect(chooseAnchor([370, 180, 380, 90], ['a1/q:1', 'a1/q:2'], board)).toBe('a1');
  });

  it('an anchor for marks on things in different items is the one it overlaps most', () => {
    expect(chooseAnchor([250, 100, 140, 80], ['n1', 'a1'], board)).toBe('n1');
  });

  it('a point takes the deepest thing under it', () => {
    expect(targetAtPoint(860, 200, board)).toBe('sp/step:a-take');
    expect(targetAtPoint(400, 228, board)).toBe('a1/q:2');
    expect(targetAtPoint(10, 10, board)).toBeUndefined();
  });
});
