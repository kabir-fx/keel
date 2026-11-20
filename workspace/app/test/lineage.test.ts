import type { Box } from '@keel/protocol';
import { describe, expect, it } from 'vitest';
import { DETOUR_MAX, routeEdge, segmentHits } from '../src/lineage';

const hitsAny = (pts: Array<[number, number]>, boxes: Box[]) => boxes.some((b) => pts.slice(1).some((p, i) => segmentHits(pts[i]!, p, b)));

describe('a lineage arrow', () => {
  it('goes straight when nothing is in the way', () => {
    const route = routeEdge([0, 0, 100, 100], [400, 0, 100, 100], []);
    expect(route).toHaveLength(2);
  });

  it('goes round a card in the way when a short route exists', () => {
    const a: Box = [0, 0, 200, 100];
    const b: Box = [600, 0, 200, 100];
    const card: Box = [300, -20, 200, 140];
    const route = routeEdge(a, b, [a, b, card]);
    expect(route.length).toBeGreaterThan(2);
    expect(hitsAny(route, [[card[0] - 4, card[1] - 4, card[2] + 8, card[3] + 8]])).toBe(false);
  });

  it('turns a corner to reach a card below and to the side, round what lies between', () => {
    const a: Box = [0, 0, 300, 100];
    const b: Box = [600, 600, 300, 200];
    const card: Box = [320, 280, 260, 120];
    const route = routeEdge(a, b, [card]);
    expect(hitsAny(route, [card])).toBe(false);
  });

  it('stays straight when every way round is much longer', () => {
    const a: Box = [0, 0, 100, 100];
    const b: Box = [300, 0, 100, 100];
    // A wall far taller than the gap: going round is more than DETOUR_MAX times longer.
    const wall: Box = [150, -5000, 100, 10100];
    const route = routeEdge(a, b, [wall]);
    expect(route).toHaveLength(2);
    expect(DETOUR_MAX).toBeGreaterThan(1);
  });

  it('a card that holds an end does not count as in the way', () => {
    // A note sitting on a picture: the arrow from the note leaves the picture it sits on.
    const pic: Box = [0, 0, 1000, 600];
    const noteOnIt: Box = [100, 100, 200, 80];
    const reply: Box = [1100, 100, 300, 100];
    expect(routeEdge(noteOnIt, reply, [pic])).toHaveLength(2);
  });

  it('a segment is tested against a box, also one it only passes through', () => {
    expect(segmentHits([0, 50], [300, 50], [100, 0, 100, 100])).toBe(true);
    expect(segmentHits([0, 150], [300, 150], [100, 0, 100, 100])).toBe(false);
    expect(segmentHits([0, 0], [300, 300], [100, 100, 50, 50])).toBe(true);
  });
});
