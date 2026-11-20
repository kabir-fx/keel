import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CameraStore } from '../src/camera/camera';
import type { FrameScheduler } from '../src/frame';
import { FrameLoop } from '../src/frame';
import { ERASER_TRAIL_FADE_MS, ERASER_TRAIL_FADE_POINTS, ERASER_TRAIL_SIZE, LASSO_TRAIL_FADE_POINTS } from '../src/input/constants';
import type { TrailLook } from '../src/overlay/trails';
import { ERASER_TRAIL, LASSO_TRAIL, Trail, TrailLayer, widthAt } from '../src/overlay/trails';
import { reduceMotion } from './reducedMotion';

/**
 * The trail engine (`src/overlay/trails.ts`): how wide a trail is along its length and its age,
 * that it fades to nothing and then asks for no frame, that it is drawn through the camera at a
 * width kept on screen, and that with "reduce motion" it does not fade at all.
 */

/** Frames stepped by hand, on a clock that moves 16 ms a frame. */
function frames() {
  let next = 1;
  let time = 1000;
  const waiting = new Map<number, FrameRequestCallback>();
  const scheduler: FrameScheduler = {
    requestAnimationFrame: (cb) => {
      waiting.set(next, cb);
      return next++;
    },
    cancelAnimationFrame: (id) => {
      waiting.delete(id);
    },
  };
  return {
    scheduler,
    now: () => time,
    /** Let time pass with no frame. */
    wait: (ms: number) => {
      time += ms;
    },
    /** How many frames have been asked for and not run. */
    asked: () => waiting.size,
    step: () => {
      time += 16;
      const run = [...waiting.values()];
      waiting.clear();
      for (const cb of run) cb(time);
    },
  };
}

/** A board's trail layer in an SVG, its frame loop and camera, all on the hand-stepped clock. */
function stage(z = 1) {
  const f = frames();
  const loop = new FrameLoop(f.scheduler, f.now);
  const camera = new CameraStore({ x: 0, y: 0, z }, { loop });
  const layer = new TrailLayer();
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  layer.mount(svg);
  const host = { layer, frames: loop, camera, now: f.now };
  const path = () => svg.querySelector('path');
  return { f, loop, camera, layer, svg, host, path, d: () => path()?.getAttribute('d') ?? '' };
}

/** The numbers of a path, as x,y pairs. */
function pointsOf(d: string): Array<[number, number]> {
  const n = (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i]!, n[i + 1]!]);
  return out;
}

/** The box round a drawn path: its middle, and half its width and height. */
function spread(d: string) {
  const pts = pointsOf(d);
  const xs = pts.map(([x]) => x);
  const ys = pts.map(([, y]) => y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: (x1 - x0) / 2, h: (y1 - y0) / 2 };
}

/** A sweep to the right along y = 100, one point a frame. */
function sweep(t: Trail, s: ReturnType<typeof stage>, from: number, to: number, step = 10) {
  for (let x = from + step; x <= to; x += step) {
    t.add([[x, 100]]);
    s.f.step();
  }
}

describe('the two trails', () => {
  it('the eraser’s: 5 px either side, a lag of 0.2, gone in 200 ms and over 10 points, a dot at its head', () => {
    expect(ERASER_TRAIL).toEqual({ size: 5, streamline: 0.2, fadeMs: 200, fadePoints: 10, keepHead: true, oneSide: false, className: 'trail trail--eraser' });
  });

  it('the lasso’s: 2 px from its line, a lag of 0.4, never gone with age, one side of it drawn', () => {
    expect(LASSO_TRAIL).toEqual({ size: 2, streamline: 0.4, fadeMs: Infinity, fadePoints: 5000, keepHead: false, oneSide: true, className: 'trail trail--lasso' });
  });
});

describe('each trail at its own numbers, read from what is drawn', () => {
  /** How far right a trail reaches once the pointer has jumped from 20 to 100 along a level line. */
  const headAfterJump = (look: TrailLook) => {
    const s = stage();
    const t = new Trail(look, s.host, [0, 0]);
    t.add([[10, 0]]);
    t.add([[20, 0]]);
    t.add([[100, 0]]);
    const x = Math.max(...pointsOf(s.d()).map(([px]) => px));
    t.clear();
    return x;
  };

  it('the eraser’s lags the pointer by its smoothing of 0.2, the lasso’s by 0.4: the lasso’s is the further behind', () => {
    expect(headAfterJump(ERASER_TRAIL)).toBeCloseTo(88.42, 1);
    expect(headAfterJump(LASSO_TRAIL)).toBeCloseTo(67.68, 1);
  });

  it('the eraser’s reaches 5 px either side of its line at any zoom; the lasso’s line lies 2 px to one side', () => {
    for (const z of [0.25, 1, 4]) {
      const s = stage(z);
      const t = new Trail(ERASER_TRAIL, s.host, [0, 0]);
      t.add([[100 / z, 0]]);
      t.add([[200 / z, 0]]);
      expect(spread(s.d()).h, `at ${z}`).toBeCloseTo(5, 1);
      t.clear();
    }
    const s = stage();
    const t = new Trail(LASSO_TRAIL, s.host, [0, 0]);
    t.add([[100, 0]]);
    t.add([[200, 0]]);
    expect(Math.max(...pointsOf(s.d()).map(([, y]) => Math.abs(y)))).toBeCloseTo(2, 1);
    t.clear();
  });
});

describe('how wide a trail is', () => {
  it('a point narrows with its age and is gone at 200 ms: one ms before, it still shows', () => {
    expect(ERASER_TRAIL_FADE_MS).toBe(200);
    expect(widthAt(ERASER_TRAIL, 0, 2)).toBeGreaterThan(0.99);
    expect(widthAt(ERASER_TRAIL, 100, 2)).toBeLessThan(widthAt(ERASER_TRAIL, 50, 2));
    expect(widthAt(ERASER_TRAIL, 199, 2)).toBeGreaterThan(0);
    expect(widthAt(ERASER_TRAIL, 200, 2)).toBe(0);
    expect(widthAt(ERASER_TRAIL, 201, 2)).toBe(0);
  });

  it('it narrows toward its tail, and is gone 10 points back from its head: 9 points back, it still shows', () => {
    expect(ERASER_TRAIL_FADE_POINTS).toBe(10);
    expect(widthAt(ERASER_TRAIL, 0, 5)).toBeLessThan(widthAt(ERASER_TRAIL, 0, 2));
    expect(widthAt(ERASER_TRAIL, 0, 9)).toBeGreaterThan(0);
    expect(widthAt(ERASER_TRAIL, 0, 10)).toBe(0);
    expect(widthAt(ERASER_TRAIL, 0, 11)).toBe(0);
  });

  it('it falls off late and fast: half way through its age it is still nine tenths wide', () => {
    expect(widthAt(ERASER_TRAIL, 100, 2)).toBeCloseTo(1 - 0.5 ** 4, 6);
    expect(widthAt(ERASER_TRAIL, 0, 6)).toBeCloseTo(1 - 0.6 ** 4, 6);
  });

  it('the lasso’s never fades with age, and only narrows 5,000 points back', () => {
    expect(LASSO_TRAIL_FADE_POINTS).toBe(5000);
    expect(widthAt(LASSO_TRAIL, 3_600_000, 2)).toBeGreaterThan(0.99);
    expect(widthAt(LASSO_TRAIL, 0, 4999)).toBeGreaterThan(0);
    expect(widthAt(LASSO_TRAIL, 0, 5000)).toBe(0);
  });
});

describe('a trail that fades', () => {
  beforeEach(() => reduceMotion(false));
  afterEach(() => reduceMotion(true));

  it('fades behind the pointer, keeps a dot at its head, and asks for no frame once nothing changes', () => {
    const s = stage();
    const t = new Trail(ERASER_TRAIL, s.host, [0, 100]);
    sweep(t, s, 0, 200);
    // While it fades, every frame is asked for.
    expect(s.f.asked()).toBe(1);
    const moving = s.d();
    // The pointer rests. Its newest point is 16 ms old now: a frame later than 184 ms old, a
    // frame is still asked for; at 200 ms old, none is.
    s.f.wait(ERASER_TRAIL_FADE_MS - 3 * 16);
    s.f.step();
    expect(s.f.asked()).toBe(1);
    s.f.step();
    expect(s.f.asked()).toBe(0);
    expect(s.loop.running(t)).toBe(false);
    // What stays is the dot at the head: a circle of 5 px, where the trail's line had got to.
    expect(s.d()).not.toBe(moving);
    const dot = spread(s.d());
    expect(dot.w).toBeCloseTo(ERASER_TRAIL_SIZE, 0);
    expect(dot.h).toBeCloseTo(ERASER_TRAIL_SIZE, 0);
    expect(Math.hypot(dot.x - 200, dot.y - 100)).toBeLessThan(3);
  });

  it('the dot at its head keeps its size on screen at any zoom', () => {
    for (const z of [0.25, 1, 4]) {
      const s = stage(z);
      const t = new Trail(ERASER_TRAIL, s.host, [0, 0]);
      sweep(t, s, 0, 50 / z, 10 / z);
      s.f.wait(1000);
      s.f.step();
      expect(spread(s.d()).w, `at ${z}`).toBeCloseTo(ERASER_TRAIL_SIZE, 0);
      t.clear();
    }
  });

  it('a press that has not moved yet shows a dot where it went down', () => {
    const s = stage();
    new Trail(ERASER_TRAIL, s.host, [40, 100]);
    const dot = spread(s.d());
    expect(dot.x).toBeCloseTo(40, 1);
    expect(dot.y).toBeCloseTo(100, 1);
    expect(dot.w).toBeCloseTo(ERASER_TRAIL_SIZE, 0);
  });

  it('fades to nothing once the press ends: its path goes, and the loop stops', () => {
    const s = stage();
    const t = new Trail(ERASER_TRAIL, s.host, [0, 100]);
    sweep(t, s, 0, 100);
    t.end();
    // Its newest point is 16 ms old: it narrows frame by frame, and is gone once that point is 200 ms old.
    const wide = spread(s.d()).h;
    for (let i = 0; i < 5; i++) s.f.step();
    expect(spread(s.d()).h).toBeLessThan(wide);
    for (let i = 0; i < 7; i++) s.f.step();
    expect(s.path()).toBeNull();
    expect(s.svg.children).toHaveLength(0);
    expect(s.f.asked()).toBe(0);
    expect(s.loop.running(t)).toBe(false);
    // The camera moving after draws nothing.
    s.camera.set({ x: 40, y: 0, z: 1 });
    expect(s.svg.children).toHaveLength(0);
    expect(s.f.asked()).toBe(0);
  });

  it('a trail at rest is drawn again when the camera moves, asking for no frame', () => {
    const s = stage();
    const t = new Trail(ERASER_TRAIL, s.host, [0, 100]);
    sweep(t, s, 0, 100);
    s.f.wait(1000);
    s.f.step();
    expect(s.f.asked()).toBe(0);
    const dot = spread(s.d());
    s.camera.set({ x: 30, y: -20, z: 1 });
    expect(s.f.asked()).toBe(0);
    const moved = spread(s.d());
    expect([moved.x - dot.x, moved.y - dot.y]).toEqual([30, -20]);
  });

  it('once it is gone it lets the camera go, whether it faded out or was cleared', () => {
    for (const ending of ['end', 'clear'] as const) {
      const s = stage();
      const offs: Array<ReturnType<typeof vi.fn>> = [];
      const onMove = s.camera.onMove;
      s.camera.onMove = (l) => {
        const off = vi.fn(onMove(l));
        offs.push(off);
        return off;
      };
      const t = new Trail(ERASER_TRAIL, s.host, [0, 100]);
      sweep(t, s, 0, 100);
      expect(offs).toHaveLength(1);
      expect(offs[0], ending).not.toHaveBeenCalled();
      t[ending]();
      for (let i = 0; i < 20; i++) s.f.step();
      expect(s.svg.children, ending).toHaveLength(0);
      expect(offs[0], ending).toHaveBeenCalledTimes(1);
    }
  });

  it('a trail at rest that ends goes at once: its dot does not stay', () => {
    const s = stage();
    const t = new Trail(ERASER_TRAIL, s.host, [0, 100]);
    sweep(t, s, 0, 100);
    s.f.wait(1000);
    s.f.step();
    expect(s.f.asked()).toBe(0);
    expect(s.svg.children).toHaveLength(1);
    t.end();
    expect(s.svg.children).toHaveLength(0);
  });

  it('a trail with no dot that has faded while the press is down is off the page, and comes back with the next point', () => {
    const look: TrailLook = { ...ERASER_TRAIL, keepHead: false };
    const s = stage();
    const t = new Trail(look, s.host, [0, 100]);
    sweep(t, s, 0, 100);
    s.f.wait(1000);
    s.f.step();
    expect(s.svg.children).toHaveLength(0);
    // A point's time lags with its place: the first few after a rest are counted old.
    for (let x = 110; x <= 150; x += 10) t.add([[x, 100]]);
    expect(s.svg.children).toHaveLength(1);
    t.clear();
  });

  it('a clear takes it off at once, while it fades', () => {
    const s = stage();
    const t = new Trail(ERASER_TRAIL, s.host, [0, 100]);
    sweep(t, s, 0, 100);
    expect(s.f.asked()).toBe(1);
    t.clear();
    expect(s.svg.children).toHaveLength(0);
    expect(s.f.asked()).toBe(0);
    t.add([[120, 100]]);
    expect(s.svg.children).toHaveLength(0);
    // Ended after it was cleared, it stays off.
    t.end();
    expect(s.svg.children).toHaveLength(0);
    expect(s.f.asked()).toBe(0);
  });
});

describe('a trail on the board', () => {
  it('is kept in board units and drawn through the camera, so a pan or a zoom in the middle of a press keeps it on the board', () => {
    const s = stage();
    const line = [[100, 0], [100, 100], [0, 100]] as const;
    const t = new Trail(ERASER_TRAIL, s.host, [0, 0]);
    t.add(line);
    const before = spread(s.d());
    s.camera.set({ x: 50, y: 20, z: 2 });
    // The same trail drawn afresh under the camera as it is now.
    const later = stage(2);
    later.camera.set({ x: 50, y: 20, z: 2 });
    new Trail(ERASER_TRAIL, later.host, [0, 0]).add(line);
    expect(s.d()).toBe(later.d());
    // Where the camera puts the line now, its width kept on screen round it.
    const drawn = spread(s.d());
    expect(Math.abs(drawn.x - (before.x * 2 + 50))).toBeLessThan(1.5);
    expect(Math.abs(drawn.y - (before.y * 2 + 20))).toBeLessThan(1.5);
    expect(Math.abs(drawn.w - ((before.w - ERASER_TRAIL_SIZE) * 2 + ERASER_TRAIL_SIZE))).toBeLessThan(1.5);
  });

  it('keeps its width on screen at any zoom', () => {
    for (const z of [0.25, 1, 4]) {
      const s = stage(z);
      const t = new Trail(ERASER_TRAIL, s.host, [0, 0]);
      t.add([[100 / z, 0]]);
      t.add([[200 / z, 0]]);
      // A level line: it reaches 5 px above and below it on screen.
      expect(spread(s.d()).h, `at ${z}`).toBeCloseTo(ERASER_TRAIL_SIZE, 1);
      t.clear();
    }
  });

  it('the lasso’s is one side of its line, closed, so it is a loop to dash and fill', () => {
    const s = stage();
    const t = new Trail(LASSO_TRAIL, s.host, [0, 0]);
    t.add([
      [100, 0],
      [100, 100],
      [0, 100],
    ]);
    const d = s.d();
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    expect(s.path()!.getAttribute('class')).toBe('trail trail--lasso');
  });

  it('the lasso’s runs along one side of its line only, not round both', () => {
    const s = stage();
    const wave: Array<[number, number]> = Array.from({ length: 40 }, (_, i) => [i * 10, 40 * Math.sin(i / 3)]);
    const t = new Trail(LASSO_TRAIL, s.host, [0, 0]);
    t.add(wave);
    const both = stage();
    new Trail({ ...LASSO_TRAIL, oneSide: false }, both.host, [0, 0]).add(wave);
    // The whole outline goes up one side and back down the other: one side is half of it.
    const [one, whole] = [pointsOf(s.d()).length, pointsOf(both.d()).length];
    expect(one).toBeGreaterThan(whole * 0.4);
    expect(one).toBeLessThan(whole * 0.6);
  });

  it('the lasso’s asks for no frame at all: it never fades with age, and it goes at once when it ends', () => {
    reduceMotion(false);
    try {
      const s = stage();
      const t = new Trail(LASSO_TRAIL, s.host, [0, 0]);
      t.add([
        [100, 0],
        [100, 100],
      ]);
      expect(s.f.asked()).toBe(0);
      t.end();
      expect(s.svg.children).toHaveLength(0);
    } finally {
      reduceMotion(true);
    }
  });

  it('its path is put on the page once, not again each time it is drawn', () => {
    const s = stage();
    const append = vi.spyOn(s.svg, 'append');
    const t = new Trail(ERASER_TRAIL, s.host, [0, 0]);
    for (let x = 10; x <= 100; x += 10) t.add([[x, 0]]);
    expect(append).toHaveBeenCalledTimes(1);
    t.clear();
  });

  it('a path taken off stays off when the layer comes onto the page again', () => {
    const s = stage();
    const t = new Trail(ERASER_TRAIL, s.host, [0, 0]);
    t.add([[10, 0]]);
    t.clear();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.layer.mount(svg);
    expect(svg.children).toHaveLength(0);
  });

  it('a path drawn before the layer is on the page shows in it once it is', () => {
    const s = stage();
    const layer = new TrailLayer();
    const t = new Trail(ERASER_TRAIL, { ...s.host, layer }, [0, 0]);
    t.add([[10, 0]]);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    layer.mount(svg);
    expect(svg.querySelectorAll('path.trail--eraser')).toHaveLength(1);
    t.clear();
    expect(svg.children).toHaveLength(0);
  });
});

describe('a trail with "reduce motion"', () => {
  it('does not animate: it shows the whole line, asks for no frame, and goes when the press ends', () => {
    const s = stage();
    const t = new Trail(ERASER_TRAIL, s.host, [0, 100]);
    for (let x = 10; x <= 200; x += 10) t.add([[x, 100]]);
    expect(s.f.asked()).toBe(0);
    const d = s.d();
    // The whole line, from where it went down: not only its last ten points.
    expect(Math.min(...pointsOf(d).map(([x]) => x))).toBeLessThan(0);
    s.f.wait(5000);
    s.camera.set({ x: 0, y: 0, z: 1.000001 });
    s.camera.set({ x: 0, y: 0, z: 1 });
    expect(s.d()).toBe(d);
    t.end();
    expect(s.svg.children).toHaveLength(0);
    expect(s.f.asked()).toBe(0);
  });
});
