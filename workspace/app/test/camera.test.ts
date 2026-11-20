import type { Box, Id } from '@keel/protocol';
import { emptyState } from '@keel/protocol';
import { describe, expect, it } from 'vitest';
import { pageDown, pageUp, zoomIn, zoomOut, zoomToActual } from '../src/camera/actions';
import { lostFrom, wayBack } from '../src/camera/back';
import type { Camera } from '../src/camera/camera';
import { CameraStore, MAX_ZOOM, MIN_ZOOM, clampZoom, fitBox, viewOf, zoomAt, zoomTo } from '../src/camera/camera';
import type { Panel } from '../src/camera/fit';
import { freeArea } from '../src/camera/fit';
import { afterGesture } from '../src/camera/gesture';
import { cameraForGrab, grabAt, miniTransform, viewBoxOf } from '../src/camera/miniView';
import type { Wheel } from '../src/camera/wheel';
import { afterWheel, wheelPixels, wheelZoom } from '../src/camera/wheel';
import { groundAt } from '../src/camera/world';
import type { BoardRect } from '../src/tools/types';

/** The camera's plain maths: zoom values, the wheel, Safari's pinch, the free room, the minimap and the way back. */

const RECT: BoardRect = { left: 10, top: 20, width: 1200, height: 800 };

const wheelOf = (over: Partial<Wheel>): Wheel => ({ deltaX: 0, deltaY: 0, deltaMode: 0, clientX: 310, clientY: 220, ctrlKey: false, metaKey: false, shiftKey: false, ...over });

/** Where a world point is on the board, by a camera. */
const onScreen = (c: Camera, [wx, wy]: readonly [number, number]) => [wx * c.z + c.x, wy * c.z + c.y] as const;

describe('zoom values', () => {
  it('are rounded to 6 decimals and kept between 20% and 400%, one step either side of each limit', () => {
    expect(clampZoom(1.23456749)).toBe(1.234567);
    expect(clampZoom(1.2345675)).toBe(1.234568);
    expect(clampZoom(0.199999)).toBe(MIN_ZOOM);
    expect(clampZoom(0.200001)).toBe(0.200001);
    expect(clampZoom(3.999999)).toBe(3.999999);
    expect(clampZoom(4.000001)).toBe(MAX_ZOOM);
  });

  it('a step in and a step out come back to exactly 100%', () => {
    let c: Camera = { x: 13, y: -7, z: 1 };
    for (let i = 0; i < 5; i++) c = zoomAt(c, 400, 300, 1.25);
    for (let i = 0; i < 5; i++) c = zoomAt(c, 400, 300, 1 / 1.25);
    expect(c.z).toBe(1);
  });

  it('a zoom keeps the world point under the screen point, and at a limit answers with the same camera', () => {
    const c: Camera = { x: 40.3, y: -20.7, z: 0.83 };
    const w = [(300 - c.x) / c.z, (200 - c.y) / c.z] as const;
    for (const f of [1.7, 0.31, 1.05]) {
      const n = zoomAt(c, 300, 200, f);
      const [sx, sy] = onScreen(n, w);
      expect(Math.abs(sx - 300)).toBeLessThan(1e-9);
      expect(Math.abs(sy - 200)).toBeLessThan(1e-9);
    }
    const top = zoomTo(c, 300, 200, 9);
    expect(top.z).toBe(MAX_ZOOM);
    expect(zoomAt(top, 10, 10, 2)).toBe(top);
  });
});

describe('the wheel', () => {
  it('Ctrl or Cmd zooms by exp(-deltaY / 100), the delta cut to 10 either way: 9, 10 and 11', () => {
    expect(wheelZoom(5)).toBe(Math.exp(-0.05));
    expect(wheelZoom(9)).toBe(Math.exp(-0.09));
    expect(wheelZoom(10)).toBe(Math.exp(-0.1));
    expect(wheelZoom(11)).toBe(Math.exp(-0.1));
    expect(wheelZoom(100)).toBe(Math.exp(-0.1));
    expect(wheelZoom(-100)).toBe(Math.exp(0.1));
    const c: Camera = { x: 0, y: 0, z: 1 };
    expect(afterWheel(c, wheelOf({ deltaY: 100, ctrlKey: true }), RECT).z).toBe(clampZoom(Math.exp(-0.1)));
    expect(afterWheel(c, wheelOf({ deltaY: 5, metaKey: true }), RECT).z).toBe(clampZoom(Math.exp(-0.05)));
  });

  it('zooms about the pointer, in board pixels', () => {
    const c: Camera = { x: 55, y: -12, z: 1.4 };
    const at = [RECT.left + 300, RECT.top + 200] as const;
    const w = [(300 - c.x) / c.z, (200 - c.y) / c.z] as const;
    const n = afterWheel(c, wheelOf({ deltaY: -8, ctrlKey: true, clientX: at[0], clientY: at[1] }), RECT);
    const [sx, sy] = onScreen(n, w);
    expect(Math.abs(sx - 300)).toBeLessThan(0.5);
    expect(Math.abs(sy - 200)).toBeLessThan(0.5);
  });

  it('a plain wheel pans by both deltas; in lines by 16 px a line, in pages by the board’s height (and width across)', () => {
    const c: Camera = { x: 100, y: 100, z: 2 };
    expect(afterWheel(c, wheelOf({ deltaX: 30, deltaY: 50 }), RECT)).toEqual({ x: 70, y: 50, z: 2 });
    expect(wheelPixels(wheelOf({ deltaX: 2, deltaY: 3, deltaMode: 1 }), RECT)).toEqual([32, 48]);
    expect(afterWheel(c, wheelOf({ deltaY: 3, deltaMode: 1 }), RECT)).toEqual({ x: 100, y: 52, z: 2 });
    expect(afterWheel(c, wheelOf({ deltaY: 1, deltaMode: 2 }), RECT)).toEqual({ x: 100, y: 100 - 800, z: 2 });
    expect(afterWheel(c, wheelOf({ deltaX: -1, deltaMode: 2 }), RECT)).toEqual({ x: 100 + 1200, y: 100, z: 2 });
  });

  it('a Ctrl wheel in lines zooms by its pixels, cut as any other', () => {
    expect(afterWheel({ x: 0, y: 0, z: 1 }, wheelOf({ deltaY: 3, deltaMode: 1, ctrlKey: true }), RECT).z).toBe(clampZoom(Math.exp(-0.1)));
  });

  it('Shift turns a vertical wheel sideways; with Ctrl or Cmd as well it pans up and down, and never zooms', () => {
    const c: Camera = { x: 0, y: 0, z: 1 };
    expect(afterWheel(c, wheelOf({ deltaY: 40, shiftKey: true }), RECT)).toEqual({ x: -40, y: 0, z: 1 });
    // A Mac often sends Shift and the wheel as a sideways delta already.
    expect(afterWheel(c, wheelOf({ deltaX: 40, shiftKey: true }), RECT)).toEqual({ x: -40, y: 0, z: 1 });
    expect(afterWheel(c, wheelOf({ deltaY: 40, shiftKey: true, ctrlKey: true }), RECT)).toEqual({ x: 0, y: -40, z: 1 });
  });

  it('a wheel that only moves sideways never zooms, even with Ctrl', () => {
    const c: Camera = { x: 0, y: 0, z: 1 };
    expect(afterWheel(c, wheelOf({ deltaX: 25, ctrlKey: true }), RECT)).toEqual({ x: -25, y: 0, z: 1 });
  });

  it('an event with zero deltas does nothing', () => {
    const c: Camera = { x: 3, y: 4, z: 1 };
    expect(afterWheel(c, wheelOf({}), RECT)).toBe(c);
    expect(afterWheel(c, wheelOf({ ctrlKey: true, deltaMode: 1 }), RECT)).toBe(c);
  });
});

describe('Safari’s pinch', () => {
  it('zooms to the zoom at the start times the scale, about the pointer, within half a pixel', () => {
    const start: Camera = { x: -140.25, y: 77.5, z: 0.9 };
    const at = [512, 333] as const;
    const w = [(at[0] - start.x) / start.z, (at[1] - start.y) / start.z] as const;
    let c = start;
    for (const scale of [1.1, 1.3, 1.25, 1.9, 0.6]) {
      c = afterGesture(c, start.z, scale, at);
      expect(c.z).toBe(clampZoom(start.z * scale));
      const [sx, sy] = onScreen(c, w);
      expect(Math.abs(sx - at[0])).toBeLessThan(0.5);
      expect(Math.abs(sy - at[1])).toBeLessThan(0.5);
    }
  });
});

describe('the free room for a fit', () => {
  const SIZE = { w: 1440, h: 900 };
  const panel = (dock: Panel['dock'], left: number, top: number, w: number, h: number): Panel => ({ dock, left, top, right: left + w, bottom: top + h });
  /** The panels of the board at 1440 by 900, as the stylesheet places them. */
  const PILLS = [panel('top', 24, 20, 400, 52), panel('top', 616, 26, 208, 40), panel('top', 1016, 20, 400, 52)];
  const BOTTOM = [panel('bottom', 420, 812, 600, 64), panel('bottom', 1220, 732, 196, 36), panel('bottom', 1220, 776, 196, 100)];
  const WATCH_OPEN = panel('side', 1032, 88, 384, 632);
  const WATCH_FOLDED = panel('top', 1032, 88, 384, 50);

  const clear = (room: Box, ps: readonly Panel[]) =>
    ps.every((p) => room[0] >= p.right || room[0] + room[2] <= p.left || room[1] >= p.bottom || room[1] + room[3] <= p.top);

  it('is the board less what the panels cover, and 24 px more', () => {
    expect(freeArea(SIZE, [...PILLS, ...BOTTOM])).toEqual([24, 72 + 24, 1440 - 48, 900 - 72 - 24 - (900 - 732) - 24]);
  });

  it('keeps clear of every panel with the watch panel open and folded', () => {
    const open = freeArea(SIZE, [...PILLS, ...BOTTOM, WATCH_OPEN]);
    expect(open[0] + open[2]).toBe(1032 - 24);
    expect(clear(open, [...PILLS, ...BOTTOM, WATCH_OPEN])).toBe(true);
    const folded = freeArea(SIZE, [...PILLS, ...BOTTOM, WATCH_FOLDED]);
    expect(folded[1]).toBe(138 + 24);
    expect(folded[0] + folded[2]).toBe(1440 - 24);
    expect(clear(folded, [...PILLS, ...BOTTOM, WATCH_FOLDED])).toBe(true);
  });

  it('a side panel on the left covers from the left; one past the middle covers from the top; one with no size covers nothing', () => {
    expect(freeArea(SIZE, [panel('side', 0, 100, 300, 600)])[0]).toBe(324);
    expect(freeArea(SIZE, [panel('side', 16, 84, 1408, 500)])).toEqual([24, 584 + 24, 1392, 900 - 584 - 48]);
    expect(freeArea(SIZE, [panel('top', 0, 0, 0, 0), panel('side', 1000, 0, 0, 400)])).toEqual([24, 24, 1392, 852]);
  });

  describe('a side panel that reaches past the middle of the board (a narrow window)', () => {
    const BOARD = { w: 1000, h: 900 };

    it('is a side panel up to the middle, and one step past it gives the larger of the room beside it and the room below it', () => {
      // It reaches exactly to the middle: the room is beside it, whatever is free below.
      expect(freeArea(BOARD, [panel('side', 500, 88, 476, 312)])).toEqual([24, 24, 452, 852]);
      // One pixel further: beside it is 451 by 852, below it is 952 by 452, which is larger.
      expect(freeArea(BOARD, [panel('side', 499, 88, 477, 312)])).toEqual([24, 424, 952, 452]);
      // The same on the left.
      expect(freeArea(BOARD, [panel('side', 24, 88, 476, 312)])).toEqual([524, 24, 452, 852]);
      expect(freeArea(BOARD, [panel('side', 24, 88, 477, 312)])).toEqual([24, 424, 952, 452]);
    });

    it('takes the room beside it when that is the larger: the watch panel at 800 by 900, a build running', () => {
      const at800 = [panel('top', 24, 20, 360, 52), panel('top', 416, 20, 360, 52), panel('bottom', 100, 812, 600, 64), panel('bottom', 580, 732, 196, 36), panel('bottom', 580, 776, 196, 100)];
      const watch = panel('side', 392, 88, 384, 632);
      const room = freeArea({ w: 800, h: 900 }, [...at800, watch]);
      expect(room).toEqual([24, 96, 344, 612]);
      expect(clear(room, [...at800, watch])).toBe(true);
    });

    it('takes whichever leaves room when only one does, one step either side of the 200 px floor', () => {
      // Beside it there are 200 px, below it 199: beside. Then 199 beside and 200 below: below.
      expect(freeArea({ w: 800, h: 700 }, [panel('side', 248, 0, 552, 453)])).toEqual([24, 24, 200, 652]);
      expect(freeArea({ w: 800, h: 700 }, [panel('side', 247, 0, 553, 452)])).toEqual([24, 476, 752, 200]);
    });

    it('is left out when neither beside it nor below it leaves room: the watch panel across a 700 px window', () => {
      const toolbar = panel('bottom', 16, 812, 668, 64);
      const pills = [panel('top', 24, 20, 318, 52), panel('top', 358, 20, 318, 52)];
      expect(freeArea({ w: 700, h: 900 }, [...pills, toolbar, panel('side', 16, 84, 668, 632)])).toEqual(freeArea({ w: 700, h: 900 }, [...pills, toolbar]));
      // One step either side of the floor, beside and below at once.
      expect(freeArea({ w: 800, h: 700 }, [panel('side', 247, 0, 553, 453)])).toEqual([24, 24, 752, 652]);
    });
  });

  it('never reaches past the board, and keeps 200 px a side where the board has them, on a table of small boards', () => {
    const sizes = [
      { w: 100, h: 100 },
      { w: 150, h: 600 },
      { w: 199, h: 199 },
      { w: 200, h: 200 },
      { w: 247, h: 247 },
      { w: 248, h: 248 },
      { w: 320, h: 480 },
      { w: 600, h: 150 },
      { w: 700, h: 900 },
      { w: 780, h: 900 },
      { w: 800, h: 900 },
      { w: 900, h: 600 },
    ];
    for (const size of sizes) {
      const sets: Panel[][] = [
        [],
        [panel('top', 24, 20, size.w - 48, 52), panel('bottom', 16, size.h - 88, size.w - 32, 64)],
        [panel('top', 24, 20, 300, 52), panel('bottom', 16, size.h - 88, size.w - 32, 64), panel('side', size.w - 408, 88, 384, size.h - 268)],
        [panel('side', 0, 0, 300, size.h), panel('side', size.w - 300, 0, 300, size.h)],
        [panel('top', 0, 0, size.w, size.h - 40)],
        [panel('bottom', 0, 40, size.w, size.h - 40)],
      ];
      for (const ps of sets) {
        const [x, y, w, h] = freeArea(size, ps);
        const said = `${size.w} by ${size.h}, ${ps.length} panels: ${[x, y, w, h].join(', ')}`;
        expect(x, said).toBeGreaterThanOrEqual(0);
        expect(y, said).toBeGreaterThanOrEqual(0);
        expect(x + w, said).toBeLessThanOrEqual(size.w);
        expect(y + h, said).toBeLessThanOrEqual(size.h);
        expect(w, said).toBeGreaterThanOrEqual(Math.min(200, size.w));
        expect(h, said).toBeGreaterThanOrEqual(Math.min(200, size.h));
      }
    }
  });

  it('a fit to the free room puts the content inside it', () => {
    const room = freeArea(SIZE, [...PILLS, ...BOTTOM, WATCH_OPEN]);
    const content: Box = [-300, 50, 2600, 900];
    const c = fitBox(content, room, 1);
    const [x0, y0] = onScreen(c, [content[0], content[1]]);
    const [x1, y1] = onScreen(c, [content[0] + content[2], content[1] + content[3]]);
    expect(x0).toBeGreaterThanOrEqual(room[0] - 1e-9);
    expect(y0).toBeGreaterThanOrEqual(room[1] - 1e-9);
    expect(x1).toBeLessThanOrEqual(room[0] + room[2] + 1e-9);
    expect(y1).toBeLessThanOrEqual(room[1] + room[3] + 1e-9);
  });
});

describe('the minimap', () => {
  const content: Box = [0, 0, 4000, 2000];

  it('draws the view box at its size, but never smaller than 6 px a side, about the view’s middle', () => {
    const t = { s: 0.01, tx: 5, ty: 7 };
    // 590 and 610 world units are 5.9 and 6.1 px.
    const near = (r: { x: number; y: number; w: number; h: number }, x: number, y: number, w: number, h: number) => {
      expect(r.x).toBeCloseTo(x, 9);
      expect(r.y).toBeCloseTo(y, 9);
      expect(r.w).toBeCloseTo(w, 9);
      expect(r.h).toBeCloseTo(h, 9);
    };
    near(viewBoxOf([1000, 500, 590, 610], t), 12.95 + 5 - 3, 12, 6, 6.1);
    near(viewBoxOf([0, 0, 1000, 800], t), 5, 7, 10, 8);
  });

  it('a press on the view box holds that point of it; a press outside holds the view’s middle', () => {
    const view: Box = [1000, 500, 1200, 800];
    const t = miniTransform(content, view);
    const b = viewBoxOf(view, t);
    const inside = grabAt(view, t, [b.x + 2, b.y + 3]);
    expect(inside.inside).toBe(true);
    expect(inside.offset[0]).toBeCloseTo(2 / t.s, 9);
    expect(inside.offset[1]).toBeCloseTo(3 / t.s, 9);
    expect(grabAt(view, t, [b.x - 1, b.y]).offset).toEqual([600, 400]);
  });

  it('the camera for a drag puts the held point under the pointer, by the frozen transform', () => {
    const view: Box = [1000, 500, 1200, 800];
    const t = miniTransform(content, view);
    const b = viewBoxOf(view, t);
    const grab = grabAt(view, t, [b.x + 2, b.y + 3]);
    const cam = cameraForGrab(t, grab.offset, [b.x + 2 + 17, b.y + 3 - 4], 0.5);
    const moved = viewBoxOf(viewOf(cam, { w: 600, h: 400 }), t);
    expect(moved.x - b.x).toBeCloseTo(17, 9);
    expect(moved.y - b.y).toBeCloseTo(-4, 9);
  });

  it('fits the content and the view together, so a view far off is still on the map', () => {
    const view: Box = [9000, 9000, 1200, 800];
    const t = miniTransform(content, view);
    const b = viewBoxOf(view, t);
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.x + b.w).toBeLessThanOrEqual(196);
    expect(b.y + b.h).toBeLessThanOrEqual(100);
  });
});

describe('the way back to the board', () => {
  const boxes = new Map<Id, Box>([
    ['a', [0, 0, 100, 100]],
    ['b', [5000, 0, 100, 100]],
  ]);

  it('is offered only when there are items and none is in view', () => {
    expect(lostFrom(boxes, [-50, -50, 100, 100])).toBe(false);
    expect(lostFrom(boxes, [200, 200, 100, 100])).toBe(true);
    expect(lostFrom(new Map(), [200, 200, 100, 100])).toBe(false);
  });

  it('goes to the whole board when it fits above 20%, else to the item nearest the view', () => {
    // 5100 units across at 20% is 1020 px.
    expect(wayBack(boxes, [3000, 3000, 100, 100], [0, 0, 1021, 600])).toEqual([]);
    expect(wayBack(boxes, [3000, 3000, 100, 100], [0, 0, 1019, 600])).toEqual(['b']);
    expect(wayBack(boxes, [-900, 3000, 100, 100], [0, 0, 1019, 600])).toEqual(['a']);
  });
});

describe('the ground', () => {
  it('slides by less than a cell, so its dots sit where the camera puts the world’s grid', () => {
    for (const cam of [
      { x: 0, y: 0, z: 1 },
      { x: -1234.5, y: 77.25, z: 0.37 },
      { x: 9999, y: -45, z: 4 },
    ]) {
      const g = groundAt(cam);
      expect(g.cell).toBeCloseTo(24 * cam.z, 12);
      for (const [slide, at] of [
        [g.x, cam.x],
        [g.y, cam.y],
      ] as const) {
        expect(slide).toBeGreaterThanOrEqual(0);
        expect(slide).toBeLessThan(g.cell);
        // The ground's first cell starts 96 px before the board: it lines up with the camera.
        const off = (slide - 96 - at) / g.cell;
        expect(Math.abs(off - Math.round(off))).toBeLessThan(1e-9);
      }
    }
  });
});

describe('the camera’s actions for the keys', () => {
  /** What the actions use of the board, with a camera that jumps. */
  function keysBoard() {
    const camera = new CameraStore({ x: 10, y: 20, z: 0.8 }, { reduced: () => true });
    const zooms: number[] = [];
    let fits = 0;
    const board = {
      camera,
      zoomBy: (f: number) => zooms.push(f),
      fitAll: () => {
        fits += 1;
      },
      selection: () => [],
      boxes: () => new Map<Id, Box>(),
      state: emptyState,
      layerEl: () => null,
      rect: () => RECT,
    };
    return { camera, board, zooms, fits: () => fits };
  }

  it('zoom in, out and to 100% step the zoom; a page moves the view by its height less an eighth', () => {
    const { camera, board, zooms } = keysBoard();
    zoomIn(board);
    zoomOut(board);
    zoomToActual(board);
    expect(zooms).toEqual([1.25, 1 / 1.25, 1 / 0.8]);
    pageDown(board);
    expect(camera.get()).toEqual({ x: 10, y: 20 - 800 * 0.875, z: 0.8 });
    pageUp(board);
    pageUp(board);
    expect(camera.get()).toEqual({ x: 10, y: 20 + 800 * 0.875, z: 0.8 });
  });
});
