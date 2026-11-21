import type { Box, ItemKind } from '@keel/protocol';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Hit } from '../src/select/hit';
import type { Lines } from '../src/board/measure';
import { lineHit } from '../src/board/measure';
import { distToOutline, KIND_LAYER, rankHits } from '../src/select/hit';

/** What a press lands on (`src/select/hit.ts`): one ranking for everything under the pointer. */

const hit = (id: string, layer: number, order: number, square: boolean): Hit => ({ id, layer, order, square });
/** A press inside a box the owner drew, off its line. */
const inside = (id: string, order: number): Hit => ({ id, layer: KIND_LAYER.box, order, square: true, inside: true });

describe('the ranking of what is under the pointer', () => {
  it.each([
    ['nothing under the pointer: nothing', [], undefined],
    ['on top and square: the one on top', [hit('card', 1, 0, true), hit('ink', 3, 1, true)], 'ink'],
    ['on top and near, nothing square below: the one on top', [hit('card', 1, 0, false), hit('ink', 3, 1, false)], 'ink'],
    ['on top and near, below and square: the one below', [hit('card', 1, 0, true), hit('ink', 3, 1, false)], 'card'],
    ['two square below a near one: the higher of the two', [hit('card', 1, 0, true), hit('note', 2, 1, true), hit('ink', 3, 2, false)], 'note'],
    ['one layer, later in the log: the later one', [hit('n1', 2, 0, true), hit('n2', 2, 1, true)], 'n2'],
    ['one layer, the later one only near: the earlier, square one', [hit('n1', 2, 0, true), hit('n2', 2, 1, false)], 'n1'],
    ['a higher layer wins over a later place in the log', [hit('pin', 4, 0, true), hit('ink', 3, 9, true)], 'pin'],
    ['the order they are handed in does not matter', [hit('ink', 3, 1, false), hit('card', 1, 0, true)], 'card'],
    ['inside a box, nothing else: the box', [inside('box', 0)], 'box'],
    ['inside a box drawn round a picture, on the picture: the picture, though the box is above it', [hit('pic', 1, 0, true), inside('box', 1)], 'pic'],
    ['inside a box, on a note drawn earlier on its layer: the note', [hit('note', 2, 0, true), inside('box', 1)], 'note'],
    ['inside a box, on its neighbour’s line: the line', [inside('box', 0), hit('b2', 2, 1, true)], 'b2'],
    ['inside a box, with a line only near: the box', [inside('box', 0), hit('ink', 3, 1, false)], 'box'],
    ['inside two boxes: the one on top', [inside('outer', 0), inside('inner', 1)], 'inner'],
  ] as const)('%s', (_name, hits, want) => {
    expect(rankHits(hits)).toBe(want);
  });
});

describe('the layers are the stacking order the page draws', () => {
  const styles = (file: string) => readFileSync(join(__dirname, '../src/styles', file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  /** The z-index a file of the styles gives one selector, written as it is in the file. */
  const zIn = (file: string, selector: string): number => {
    for (const [, selectors, body] of styles(file).matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const z = /z-index:\s*(\d+)/.exec(body!);
      if (z && selectors!.split(',').some((one) => one.trim() === selector)) return Number(z[1]);
    }
    throw new Error(`no z-index for ${selector} in ${file}`);
  };
  const zOf = (selector: string) => zIn('canvas.css', selector);

  it('each kind’s layer is the z-index of its kind in canvas.css', () => {
    for (const kind of Object.keys(KIND_LAYER) as ItemKind[]) expect(KIND_LAYER[kind], kind).toBe(zOf(`.item--${kind}`));
  });

  it('what hangs on a thing being dragged is carried over it, in the order of the layers: a note or a box, then ink and arrows, then pins', () => {
    const lifted = zOf('.item--dragging');
    // Lifted over every layer at rest.
    expect(lifted).toBeGreaterThan(Math.max(...Object.values(KIND_LAYER)));
    const carried = zOf('.item--carried:not(.item--lasso)');
    expect(carried).toBeGreaterThan(lifted);
    expect(zOf('.item--carried.item--ink')).toBeGreaterThan(carried);
    expect(zOf('.item--carried.item--arrow')).toBe(zOf('.item--carried.item--ink'));
    expect(zOf('.item--carried.item--pin')).toBeGreaterThan(zOf('.item--carried.item--ink'));
  });

  it('in a focus view the same holds over all that is raised: the rules that raise a thing weigh more than the board’s, so the lift is said again there', () => {
    const raised = (more: string) => zIn('focus.css', `.app[data-focus] .item--raised${more}`);
    const top = Math.max(raised(''), raised('.item--picture'), raised('.item--lasso'), raised('.item--ink'), raised('.item--arrow'), raised('.item--pin'), zIn('focus.css', '.app[data-focus] .live'), zIn('focus.css', '.app[data-focus] .read-chip--raised'));
    const lifted = raised('.item--dragging');
    expect(lifted).toBeGreaterThan(top);
    const carried = raised('.item--carried:not(.item--lasso)');
    expect(carried).toBeGreaterThan(lifted);
    expect(raised('.item--carried.item--ink')).toBeGreaterThan(carried);
    expect(raised('.item--carried.item--arrow')).toBe(raised('.item--carried.item--ink'));
    expect(raised('.item--carried.item--pin')).toBeGreaterThan(raised('.item--carried.item--ink'));
  });
});

describe('how far a point is from the outline of a box', () => {
  const box: Box = [0, 0, 100, 50];
  it.each([
    ['on the left edge', 0, 25, 0],
    ['inside, nearer the left edge', 3, 25, 3],
    ['inside, nearer the top edge', 50, 2, 2],
    ['in the middle: as far as the nearest edge', 50, 25, 25],
    ['outside to the right', 104, 25, 4],
    ['outside a corner', 103, 54, 5],
  ] as const)('%s', (_name, x, y, d) => {
    expect(distToOutline(x, y, box)).toBeCloseTo(d, 9);
  });
});

describe('a press on a box the owner drew', () => {
  const box = { id: 'b1', kind: 'box' as const, box: [0, 0, 200, 100] as Box };
  const lines = (frame?: readonly [number, number]): Lines => ({
    live: [],
    boxes: new Map([[box.id, box.box]]),
    ends: new Map(),
    outlines: new Map(),
    raised: undefined,
    frameSize: () => frame,
  });

  it.each([
    ['on its line: square', [1, 50], 'square'],
    ['in the middle: inside', [100, 50], 'inside'],
    ['inside, within the slop of its line: inside', [6, 50], 'inside'],
    ['outside, within the slop of its line: near', [-4, 50], 'near'],
    ['well outside: nothing', [-40, 50], undefined],
  ] as const)('%s', (_name, [x, y], want) => {
    expect(lineHit(lines(), box, 1, x, y)).toBe(want);
  });

  it('is hit as the page draws it: a box its words made taller is hit on its lower part and its lower line', () => {
    expect(lineHit(lines(), box, 1, 100, 140)).toBeUndefined();
    expect(lineHit(lines([200, 160]), box, 1, 100, 140)).toBe('inside');
    expect(lineHit(lines([200, 160]), box, 1, 100, 159)).toBe('square');
  });
});
