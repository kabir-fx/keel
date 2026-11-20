import type { Box } from '@keel/protocol';
import { describe, expect, it } from 'vitest';
import { anchorMode, placeOnAnchor, shownBox, unplaceFromAnchor } from '../src/anchor';

const close = (a: Box, b: Box) => a.forEach((n, i) => expect(n).toBeCloseTo(b[i]!, 6));

describe('the anchor transform', () => {
  it('leaves a mark where it was when its thing has not moved', () => {
    const then: Box = [100, 100, 200, 80];
    expect(placeOnAnchor([90, 90, 220, 100], then, then, 'scale')).toEqual([90, 90, 220, 100]);
    expect(placeOnAnchor([320, 100, 150, 60], then, then, 'move')).toEqual([320, 100, 150, 60]);
  });

  it('moves and scales ink so its anchor box lands on the thing', () => {
    // A circle drawn round a step; the step is redrawn twice as wide, somewhere else.
    const circle: Box = [94, 94, 212, 92];
    const then: Box = [100, 100, 200, 80];
    const now: Box = [500, 300, 400, 80];
    close(placeOnAnchor(circle, then, now, 'scale'), [488, 294, 424, 92]);
    // The anchor box itself lands exactly on the thing.
    close(placeOnAnchor(then, then, now, 'scale'), now);
  });

  it('moves a note without scaling it: its corner follows the same point of the thing', () => {
    // A note written just right of a step: x at 104% of the step's width.
    const unit: Box = [0, 0, 100, 100];
    const note: Box = [104, 20, 112, 40];
    const step: Box = [1000, 500, 300, 50];
    close(placeOnAnchor(note, unit, step, 'move'), [1312, 510, 112, 40]);
  });

  it('is undone by its inverse, in both modes', () => {
    const then: Box = [0, 0, 100, 100];
    const now: Box = [640, 220, 250, 60];
    for (const mode of ['move', 'scale'] as const) {
      const stored: Box = [-6, 104, 120, 40];
      const shown = placeOnAnchor(stored, then, now, mode);
      close(unplaceFromAnchor(shown, then, now, mode), stored);
    }
  });

  it('keeps the scale at 1 for an anchor with no width or height', () => {
    close(placeOnAnchor([10, 10, 20, 20], [0, 0, 0, 0], [50, 60, 0, 0], 'scale'), [60, 70, 20, 20]);
  });

  it('only moves notes, pins, files and spoken remarks; scales ink, lassos, boxes and arrows', () => {
    expect(['note', 'pin', 'file', 'voice'].map((k) => anchorMode(k as 'note'))).toEqual(['move', 'move', 'move', 'move']);
    expect(['ink', 'lasso', 'box', 'arrow'].map((k) => anchorMode(k as 'ink'))).toEqual(['scale', 'scale', 'scale', 'scale']);
  });

  it('draws a mark at its own box when it has no anchor, or its thing is gone', () => {
    const box: Box = [1, 2, 3, 4];
    expect(shownBox({ kind: 'note', box }, () => [9, 9, 9, 9])).toBe(box);
    expect(shownBox({ kind: 'ink', box, anchor: { item: 'a1', box: [0, 0, 10, 10] } }, () => undefined)).toBe(box);
    close(shownBox({ kind: 'ink', box, anchor: { item: 'a1', box: [0, 0, 10, 10] } }, () => [100, 100, 20, 20]), [102, 104, 6, 8]);
  });
});
