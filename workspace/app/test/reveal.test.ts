import type { Box } from '@keel/protocol';
import { describe, expect, it } from 'vitest';
import type { Camera } from '../src/camera/camera';
import { MIN_ZOOM } from '../src/camera/camera';
import { freeArea } from '../src/camera/fit';
import { reveal, shows } from '../src/camera/reveal';

/**
 * The smallest camera move that shows something whole. The room is a board 1000 by 700 with no
 * panel: the fit's margin, 24 px, in all round.
 */
const ROOM: Box = [24, 24, 952, 652];
const RIGHT = 24 + 952;
const BOTTOM = 24 + 652;

/** Where a board box is on the screen through `cam`. */
function onScreen(cam: Camera, [x, y, w, h]: Box) {
  return { left: x * cam.z + cam.x, top: y * cam.z + cam.y, right: (x + w) * cam.z + cam.x, bottom: (y + h) * cam.z + cam.y };
}

const AT_100: Camera = { x: 0, y: 0, z: 1 };

describe('the room', () => {
  it('is the free room a fit uses, already the margin in from every edge', () => {
    expect(freeArea({ w: 1000, h: 700 }, [])).toEqual(ROOM);
  });
});

describe('a reveal', () => {
  it('does not move when the room shows the target already: it answers the camera itself', () => {
    const cam = { x: 10, y: -20, z: 0.8 };
    expect(reveal(cam, ROOM, [100, 100, 300, 200])).toBe(cam);
    // Edge to edge with the room is inside.
    expect(reveal(AT_100, ROOM, [24, 24, 952, 652])).toBe(AT_100);
  });

  const PANS: Array<[string, Box, Camera]> = [
    ['past the right edge: the right edge comes to the room’s', [900, 100, 200, 100], { x: RIGHT - 1100, y: 0, z: 1 }],
    ['past the left edge: the left edge comes to the room’s', [-50, 100, 200, 100], { x: 24 + 50, y: 0, z: 1 }],
    ['past the top edge: the top edge comes to the room’s', [100, -30, 200, 100], { x: 0, y: 24 + 30, z: 1 }],
    ['past the bottom edge: the bottom edge comes to the room’s', [100, 650, 200, 100], { x: 0, y: BOTTOM - 750, z: 1 }],
    ['past a corner: both axes, each by the least', [900, 650, 200, 100], { x: RIGHT - 1100, y: BOTTOM - 750, z: 1 }],
    ['wholly out of view: the near edge comes just inside, no further', [3000, 2000, 200, 100], { x: RIGHT - 3200, y: BOTTOM - 2100, z: 1 }],
  ];
  for (const [name, target, want] of PANS) {
    it(`pans by the least, at the same zoom, for a target ${name}`, () => {
      expect(reveal(AT_100, ROOM, target)).toEqual(want);
    });
  }

  it('leaves an axis that is inside where it is, to the pixel', () => {
    const cam = { x: 13.25, y: -7.5, z: 1.5 };
    const across = reveal(cam, ROOM, [600, 100, 100, 100]);
    expect(across.y).toBe(cam.y);
    expect(across.x).not.toBe(cam.x);
    const down = reveal(cam, ROOM, [100, 500, 100, 100]);
    expect(down.x).toBe(cam.x);
    expect(down.y).not.toBe(cam.y);
  });

  it('zooms out exactly enough for the target to fit with the margin, and no more', () => {
    // 1904 wide fits the room's 952 at 50%, edge to edge.
    const half = reveal(AT_100, ROOM, [0, 0, 1904, 100]);
    expect(half.z).toBe(0.5);
    expect(onScreen(half, [0, 0, 1904, 100])).toMatchObject({ left: 24, right: RIGHT });
    // A width that fits at no round zoom: the zoom is rounded down, by less than a millionth.
    const target: Box = [-400, 300, 3000, 400];
    const odd = reveal(AT_100, ROOM, target);
    const fits = 952 / 3000;
    expect(odd.z).toBeLessThanOrEqual(fits);
    expect(odd.z).toBeGreaterThan(fits - 1e-6);
    expect(shows(odd, ROOM, target)).toBe(true);
  });

  it('never zooms in: from 60% it stays at 60% for what would fit at 100%', () => {
    const cam = { x: 0, y: 0, z: 0.6 };
    const to = reveal(cam, ROOM, [2000, 100, 200, 100]);
    expect(to.z).toBe(0.6);
    expect(shows(to, ROOM, [2000, 100, 200, 100])).toBe(true);
  });

  it('never zooms in: from 150% it stays at 150% when the target fits there', () => {
    const cam = { x: 0, y: 0, z: 1.5 };
    const target: Box = [700, 300, 300, 200];
    const to = reveal(cam, ROOM, target);
    expect(to.z).toBe(1.5);
    expect(onScreen(to, target).right).toBe(RIGHT);
  });

  it('from 150% zooms out only as far as the target needs, not to 100%', () => {
    const cam = { x: 0, y: 0, z: 1.5 };
    // 800 wide needs 119%: 952 / 800.
    const to = reveal(cam, ROOM, [100, 100, 800, 100]);
    expect(to.z).toBe(1.19);
  });

  it('zooms out no further than the board’s lowest zoom', () => {
    // Fits the room at exactly the lowest zoom.
    const target: Box = [0, 0, 952 / MIN_ZOOM, 100];
    const to = reveal(AT_100, ROOM, target);
    expect(to.z).toBe(MIN_ZOOM);
    expect(shows(to, ROOM, target)).toBe(true);
  });

  it('a target larger than the room at the lowest zoom: the lowest zoom, its top-left at the room’s top-left', () => {
    const target: Box = [-500, -800, 20000, 30000];
    const to = reveal(AT_100, ROOM, target);
    expect(to.z).toBe(MIN_ZOOM);
    expect(onScreen(to, target)).toMatchObject({ left: 24, top: 24 });
    // Too wide only: across, its left at the room's left; down, the least pan.
    const wide: Box = [-500, 200, 20000, 100];
    const across = reveal(AT_100, ROOM, wide);
    expect(across.z).toBe(MIN_ZOOM);
    expect(onScreen(across, wide).left).toBe(24);
    expect(shows(across, ROOM, [0, 200, 1, 100])).toBe(true);
  });

  it('is stable: revealing again from its answer answers that same camera', () => {
    const cams: Camera[] = [AT_100, { x: 13.25, y: -7.5, z: 1.5 }, { x: -812.37, y: 455.1, z: 0.6 }, { x: 0, y: 0, z: MIN_ZOOM }];
    const targets: Box[] = [
      [900, 650, 200, 100],
      [-400, 300, 3000, 400],
      [3000.3, -2000.7, 210.1, 99.9],
      [-500, -800, 20000, 30000],
      [123.456, 789.012, 4567.8, 12.3],
    ];
    for (const cam of cams) {
      for (const target of targets) {
        const once = reveal(cam, ROOM, target);
        expect(reveal(once, ROOM, target)).toBe(once);
        expect(once.z).toBeLessThanOrEqual(cam.z);
      }
    }
  });
});
