import type { Box } from '@keel/protocol';
import { describe, expect, it } from 'vitest';
import type { Handle, ResizeRules } from '../src/select/resize';
import { cornerSquare, handleAt, handleCursor, handlesOf, landed, resized } from '../src/select/resize';

/** Resizing as plain geometry (`src/select/resize.ts`): the handles, and the box a drag gives. */

const rules = (over: Partial<ResizeRules> = {}): ResizeRules => ({ keepRatio: false, fromCentre: false, widthOnly: false, min: [24, 24], ...over });

describe('the box a drag of a handle gives', () => {
  const start: Box = [100, 100, 200, 100];

  it.each([
    ['the right edge: the width, from the left', 'e', 50, 30, [100, 100, 250, 100]],
    ['the left edge: the width, from the right', 'w', 50, 30, [150, 100, 150, 100]],
    ['the bottom edge: the height, from the top', 's', 30, 40, [100, 100, 200, 140]],
    ['the top edge: the height, from the bottom', 'n', 30, 40, [100, 140, 200, 60]],
    ['the bottom right corner: both, from the top left', 'se', 50, 40, [100, 100, 250, 140]],
    ['the top left corner: both, from the bottom right', 'nw', 50, 40, [150, 140, 150, 60]],
  ] as const)('%s', (_name, handle, dx, dy, want) => {
    expect(resized(start, handle, dx, dy, rules())).toEqual(want);
  });

  it('Shift keeps the ratio: on a corner, by the side that grew the more', () => {
    expect(resized(start, 'se', 100, 10, rules({ keepRatio: true }))).toEqual([100, 100, 300, 150]);
    expect(resized(start, 'se', 10, 100, rules({ keepRatio: true }))).toEqual([100, 100, 400, 200]);
    // From the corner across from it.
    expect(resized(start, 'nw', -100, 0, rules({ keepRatio: true }))).toEqual([0, 50, 300, 150]);
  });

  it('Shift keeps the ratio: on an edge, the other side follows about its middle', () => {
    expect(resized(start, 'e', 200, 0, rules({ keepRatio: true }))).toEqual([100, 50, 400, 200]);
    expect(resized(start, 's', 0, 100, rules({ keepRatio: true }))).toEqual([0, 100, 400, 200]);
  });

  it('Option resizes from the centre: the far side moves as much the other way', () => {
    expect(resized(start, 'e', 50, 0, rules({ fromCentre: true }))).toEqual([50, 100, 300, 100]);
    expect(resized(start, 'se', 50, 20, rules({ fromCentre: true }))).toEqual([50, 80, 300, 140]);
  });

  it('Shift and Option together: the ratio kept, about the centre', () => {
    expect(resized(start, 'se', 100, 0, rules({ keepRatio: true, fromCentre: true }))).toEqual([0, 50, 400, 200]);
  });

  it('never goes under the smallest size, and never flips', () => {
    expect(resized(start, 'e', -500, 0, rules())).toEqual([100, 100, 24, 100]);
    expect(resized(start, 'w', 500, 0, rules())).toEqual([276, 100, 24, 100]);
    expect(resized(start, 'nw', 500, 500, rules())).toEqual([276, 176, 24, 24]);
    // One step either side of the smallest width.
    expect(resized(start, 'e', -177, 0, rules())[2]).toBe(24);
    expect(resized(start, 'e', -175, 0, rules())[2]).toBe(25);
    expect(resized(start, 'e', -176, 0, rules())[2]).toBe(24);
  });

  it('with the ratio kept, neither side goes under its smallest size', () => {
    expect(resized(start, 'se', -500, -500, rules({ keepRatio: true }))).toEqual([100, 100, 48, 24]);
    // A box taller than it is wide stops at its smallest width.
    expect(resized([0, 0, 100, 200], 'se', -500, -500, rules({ keepRatio: true }))).toEqual([0, 0, 24, 48]);
  });

  it('a note: only its width changes, and a corner changes only its width', () => {
    expect(resized([0, 0, 320, 110], 'se', 40, 300, rules({ widthOnly: true, min: [120, 0] }))).toEqual([0, 0, 360, 110]);
    expect(resized([0, 0, 320, 110], 'nw', 40, 300, rules({ widthOnly: true, min: [120, 0] }))).toEqual([40, 0, 280, 110]);
    expect(resized([0, 0, 320, 110], 'e', -400, 0, rules({ widthOnly: true, keepRatio: true, min: [120, 0] }))).toEqual([0, 0, 120, 110]);
  });

  it('each frame starts from the box at the press: the same pointer gives the same box', () => {
    const once = resized(start, 'se', 40, 40, rules({ keepRatio: true }));
    resized(start, 'se', 300, 10, rules({ keepRatio: true }));
    expect(resized(start, 'se', 40, 40, rules({ keepRatio: true }))).toEqual(once);
    expect(start).toEqual([100, 100, 200, 100]);
  });
});

describe('the handles', () => {
  // A thing drawn on the screen from (100, 100), 200 by 100. The line round it is 4 px out.
  const box: Box = [100, 100, 200, 100];
  const all = handlesOf(false);
  const line = { left: 96, top: 96, right: 304, bottom: 204 };

  it('a corner is drawn 8 px square, centred on the corner of the line round the thing', () => {
    expect(cornerSquare(box, 'nw')).toEqual([92, 92, 8, 8]);
    expect(cornerSquare(box, 'se')).toEqual([300, 200, 8, 8]);
  });

  it('a corner is grabbed inside its square, and one pixel past it is not the corner', () => {
    expect(handleAt(92, 92, box, all)).toBe('nw');
    expect(handleAt(91, 92, box, all)).toBeUndefined();
    expect(handleAt(92, 91, box, all)).toBeUndefined();
    expect(handleAt(308, 208, box, all)).toBe('se');
    expect(handleAt(309, 208, box, all)).toBeUndefined();
  });

  it('an edge is grabbed in a band 4 px wide along the line, and not one pixel past it', () => {
    expect(handleAt(line.right, 150, box, all)).toBe('e');
    expect(handleAt(line.right + 2, 150, box, all)).toBe('e');
    expect(handleAt(line.right - 2, 150, box, all)).toBe('e');
    expect(handleAt(line.right + 3, 150, box, all)).toBeUndefined();
    expect(handleAt(line.right - 3, 150, box, all)).toBeUndefined();
    expect(handleAt(200, line.top - 2, box, all)).toBe('n');
    expect(handleAt(200, line.top - 3, box, all)).toBeUndefined();
    expect(handleAt(200, line.bottom + 2, box, all)).toBe('s');
    expect(handleAt(line.left - 2, 150, box, all)).toBe('w');
    expect(handleAt(line.left + 3, 150, box, all)).toBeUndefined();
    // Two pixels either side and no more: a pointer between two pixels, a quarter past, is off the edge.
    expect(handleAt(line.right + 2.25, 150, box, all)).toBeUndefined();
    expect(handleAt(line.right - 2.25, 150, box, all)).toBeUndefined();
  });

  it('a corner wins over the edges that meet at it', () => {
    expect(handleAt(line.right, line.bottom, box, all)).toBe('se');
    expect(handleAt(line.left + 1, line.top, box, all)).toBe('nw');
  });

  it('a note has no top or bottom edge to grab; its corners and its sides are there', () => {
    const note = handlesOf(true);
    expect(handleAt(200, line.top, box, note)).toBeUndefined();
    expect(handleAt(200, line.bottom, box, note)).toBeUndefined();
    expect(handleAt(line.right, 150, box, note)).toBe('e');
    expect(handleAt(line.right, line.bottom, box, note)).toBe('se');
  });

  it.each([
    ['n', false, 'ns-resize'],
    ['s', false, 'ns-resize'],
    ['e', false, 'ew-resize'],
    ['w', false, 'ew-resize'],
    ['nw', false, 'nwse-resize'],
    ['se', false, 'nwse-resize'],
    ['ne', false, 'nesw-resize'],
    ['sw', false, 'nesw-resize'],
    ['se', true, 'ew-resize'],
  ] as const)('the cursor for %s (a note: %s) is %s', (handle: Handle, note, cursor) => {
    expect(handleCursor(handle, note)).toBe(cursor);
  });
});

describe('the box a resize lands on', () => {
  /** A box that began on fractions, as one drawn at an odd zoom does. */
  const start: Box = [620.25, 412.5, 160.5, 80.25];

  it.each([
    ['the bottom right corner: the top left stays to the hair, the sides come to whole units', 'se', [200.4, 100.6], [620.25, 412.5, 200, 101]],
    ['the top left corner: the bottom right stays to the hair', 'nw', [200.4, 100.6], [580.75, 391.75, 200, 101]],
    ['the top right corner: the bottom left stays', 'ne', [200.4, 100.6], [620.25, 391.75, 200, 101]],
    ['the right edge: the height and the top are left as they were, fractions and all', 'e', [200.4, 80.25], [620.25, 412.5, 200, 80.25]],
    ['the top edge: the width and the left are left as they were', 'n', [160.5, 100.6], [620.25, 391.75, 160.5, 101]],
    ['half a unit rounds up, just under it rounds down', 'se', [200.5, 100.49], [620.25, 412.5, 201, 100]],
  ] as const)('%s', (_name, handle, size, want) => {
    const box = landed(start, handle, size, false);
    expect(box).toEqual(want);
    // What the handle holds still: the far edges, to the last digit.
    if (handle.includes('w')) expect(box[0] + box[2]).toBe(start[0] + start[2]);
    else expect(box[0]).toBe(start[0]);
    if (handle.includes('n')) expect(box[1] + box[3]).toBe(start[1] + start[3]);
    else expect(box[1]).toBe(start[1]);
  });

  it('a size that comes back to the one it had leaves its side as it was, to the last digit', () => {
    // Held by its far edge, a side is placed back from that edge: 0.1 + 200 - 200 is not 0.1.
    const began: Box = [0.1, 0.5, 200, 100];
    expect(landed(began, 'nw', [200.3, 99.6], false)).toEqual(began);
    expect(landed(began, 'nw', [200.3, 120], false)).toEqual([0.1, -19.5, 200, 120]);
  });

  it('from the centre, the centre stays where it was', () => {
    const box = landed(start, 'se', [200.4, 100.05], true);
    expect([box[2], box[3]]).toEqual([200, 100]);
    expect(box[0] + box[2] / 2).toBe(start[0] + start[2] / 2);
    expect(box[1] + box[3] / 2).toBe(start[1] + start[3] / 2);
  });

  it('a resize that changed nothing lands where it began', () => {
    expect(landed(start, 'se', [start[2], start[3]], false)).toEqual(start);
  });
});
