import type { Box } from '@keel/protocol';
import { liveItems } from '@keel/protocol';
import { describe, expect, it } from 'vitest';
import type { Page } from '../src/board/measure';
import { measuringOf, withLineMarks } from '../src/board/measure';
import type { Shown } from '../src/board/shown';
import { CameraStore } from '../src/camera/camera';
import { pinIcon } from '../src/markSizes';
import { localSource } from '../src/source';
import { CH, note, openBoard } from './helpers';

/**
 * What the pointer can reach (`src/board/measure.ts`): in a focus view only what stands above
 * the dim, and of a pin its icon. A box drawn with Shift, the lines a move snaps to, a lasso and
 * the eraser all ask here.
 */

const INK = { id: 'k1', kind: 'ink', box: [0, 150, 100, 50], strokes: [{ pts: [0, 0, 100, 50] }], targets: [], hint: 'none' };
const PIN = { id: 'pn', kind: 'pin', box: [600, 100, 0, 0], at: [10, 30], on: { item: 'm1' } };

function board() {
  const b = openBoard();
  b.must('owner', note('m1', [0, 0, 320, 100]));
  b.must('owner', note('m2', [0, 300, 320, 100]));
  b.must('owner', { type: 'item.add', chapter: CH, item: INK });
  b.must('owner', { type: 'item.add', chapter: CH, item: PIN });
  const source = localSource({ events: b.events });
  const boxes = new Map<string, Box>([
    ['m1', [0, 0, 320, 100]],
    ['m2', [0, 300, 320, 100]],
    ['k1', [0, 150, 100, 50]],
    ['pn', [600, 100, 0, 0]],
  ]);
  const shown = { live: liveItems(source.state), boxes, ends: new Map(), outlines: new Map() } as unknown as Shown;
  const page = { board: { current: null }, layer: { current: null }, camera: new CameraStore({ x: 0, y: 0, z: 1 }), source, rect: () => ({ left: 0, top: 0, width: 1000, height: 800 }) } as unknown as Page;
  return { source, boxes, at: (raised?: ReadonlySet<string>) => measuringOf(page, shown, raised) };
}

describe('in a focus view, only what stands above the dim is there to point at', () => {
  it('on the board itself the pointer reaches everything', () => {
    const m = board().at(undefined);
    expect(['m1', 'm2', 'k1', 'pn'].map((id) => m.reachable(id))).toEqual([true, true, true, true]);
    expect([...m.outlines().keys()].sort()).toEqual(['k1', 'm1', 'm2', 'pn']);
  });

  it('in a focus view, what lies under the dim is out of reach, and has no outline to line up with or to hold in a box', () => {
    const m = board().at(new Set(['m2', 'k1']));
    expect(['m1', 'm2', 'k1', 'pn'].map((id) => m.reachable(id))).toEqual([false, true, true, false]);
    expect([...m.outlines().keys()].sort()).toEqual(['k1', 'm2']);
  });

  it('a lasso holds of the line marks only those above the dim', () => {
    const { source, boxes } = board();
    expect(withLineMarks([], source.state, boxes, undefined).map((r) => r.id)).toEqual(['k1', 'pn']);
    expect(withLineMarks([], source.state, boxes, new Set(['pn'])).map((r) => r.id)).toEqual(['pn']);
  });
});

describe('what a lasso can hold of a pin', () => {
  it('is its icon, standing on its point, not the box of its mark, which has no size', () => {
    const { source, boxes } = board();
    const pin = withLineMarks([], source.state, boxes, undefined).find((r) => r.id === 'pn');
    expect(pin?.box).toEqual(pinIcon([600, 100, 0, 0], [10, 30]));
    expect(pin!.box[2]).toBeGreaterThan(0);
  });
});
