import { describe, expect, it } from 'vitest';
import type { Camera } from '../src/camera/camera';
import { CameraStore } from '../src/camera/camera';
import { between, easeOut } from '../src/camera/motion';
import type { FrameScheduler } from '../src/frame';
import { FrameLoop } from '../src/frame';

/** The camera's glide: its in-between cameras, its easing, and the store that runs it on the frame loop. */

/** Frames stepped by hand, with a clock that moves 16 ms a frame unless told otherwise. */
function frames() {
  let next = 1;
  let time = 0;
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
    loop: new FrameLoop(scheduler, () => time),
    asked: () => waiting.size,
    step: (ms = 16) => {
      time += ms;
      const run = [...waiting.values()];
      waiting.clear();
      for (const cb of run) cb(time);
    },
  };
}

/** A camera on hand-stepped frames that glides (the page does not ask for reduced motion), and every camera it showed. */
function gliding(start: Camera) {
  const f = frames();
  const camera = new CameraStore(start, { loop: f.loop, reduced: () => false });
  const seen: Camera[] = [];
  camera.onMove((c) => seen.push(c));
  /** Step frames until the glide ends; how many it took. */
  const run = () => {
    let n = 0;
    while (f.asked() > 0 && n < 1000) {
      f.step();
      n += 1;
    }
    return n;
  };
  return { camera, seen, f, run };
}

const screenOf = (c: Camera, [wx, wy]: readonly [number, number]) => [wx * c.z + c.x, wy * c.z + c.y] as const;

/** True when the numbers never turn back: all rising, or all falling. */
const oneWay = (xs: readonly number[]) => {
  const d = xs.slice(1).map((x, i) => x - xs[i]!);
  return d.every((v) => v >= -1e-9) || d.every((v) => v <= 1e-9);
};

/** True when every point lies on the straight line from the first to the last. */
const straight = (pts: ReadonlyArray<readonly [number, number]>) => {
  const [a, b] = [pts[0]!, pts[pts.length - 1]!];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return pts.every((p) => Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / len < 1e-6);
};

const WORLD_POINTS = [
  [0, 0],
  [500, -300],
  [-1200, 800],
  [3000, 2000],
] as const;

const MOVES: Array<[string, Camera, Camera]> = [
  ['a pan', { x: 0, y: 0, z: 0.7 }, { x: -2400, y: 900, z: 0.7 }],
  ['a zoom', { x: 100, y: 50, z: 0.2 }, { x: -300, y: -200, z: 4 }],
  ['both at once', { x: 640, y: -120, z: 3.2 }, { x: -1800, y: 2200, z: 0.25 }],
];

describe('the in-between cameras', () => {
  it('begin at the start and end exactly on the target', () => {
    const a = { x: 1, y: 2, z: 0.5 };
    const b = { x: -7.3, y: 99.1, z: 3.3 };
    expect(between(a, b, 0)).toBe(a);
    expect(between(a, b, 1)).toBe(b);
  });

  it('change the zoom geometrically: halfway is the mean ratio', () => {
    expect(between({ x: 0, y: 0, z: 0.25 }, { x: 0, y: 0, z: 4 }, 0.5).z).toBeCloseTo(1, 12);
  });

  for (const [name, a, b] of MOVES) {
    it(`move every world point along a straight line on the screen, one way, for ${name}`, () => {
      for (const w of WORLD_POINTS) {
        const path = Array.from({ length: 41 }, (_, i) => screenOf(between(a, b, i / 40), w));
        expect(oneWay(path.map((p) => p[0]))).toBe(true);
        expect(oneWay(path.map((p) => p[1]))).toBe(true);
        expect(straight(path)).toBe(true);
      }
    });
  }
});

describe('the easing', () => {
  it('is 1 - (1 - t)^4: from 0 to 1, rising, never past 1', () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(0.5)).toBe(1 - 0.5 ** 4);
    const xs = Array.from({ length: 101 }, (_, i) => easeOut(i / 100));
    expect(oneWay(xs)).toBe(true);
    expect(Math.max(...xs)).toBe(1);
  });
});

describe('a glide', () => {
  it('takes 500 ms of frames and lands exactly on its target', () => {
    const to = { x: -812.37, y: 455.1, z: 2.75 };
    const { camera, run } = gliding({ x: 10, y: 20, z: 0.4 });
    camera.glide(to);
    expect(camera.gliding()).toBe(true);
    expect(camera.goal()).toBe(to);
    // 500 ms in frames of 16 ms: the 32nd frame passes 500 ms.
    expect(run()).toBe(32);
    expect(camera.get()).toEqual(to);
    expect(camera.gliding()).toBe(false);
  });

  it('can be told how long: 300 ms for what is new', () => {
    const { camera, run } = gliding({ x: 0, y: 0, z: 1 });
    camera.glide({ x: 300, y: 0, z: 1 }, 300);
    expect(run()).toBe(19);
  });

  for (const [name, a, b] of MOVES) {
    it(`moves each world point one way on the screen, with no overshoot, for ${name}`, () => {
      const { camera, seen, run } = gliding(a);
      camera.glide(b);
      run();
      expect(seen.length).toBeGreaterThan(20);
      for (const w of WORLD_POINTS) {
        const path = seen.map((c) => screenOf(c, w));
        const [x0, y0] = path[0]!;
        const [x1, y1] = path[path.length - 1]!;
        expect(oneWay(path.map((p) => p[0]))).toBe(true);
        expect(oneWay(path.map((p) => p[1]))).toBe(true);
        expect(straight(path)).toBe(true);
        for (const [x, y] of path) {
          expect(x).toBeGreaterThanOrEqual(Math.min(x0, x1) - 1e-6);
          expect(x).toBeLessThanOrEqual(Math.max(x0, x1) + 1e-6);
          expect(y).toBeGreaterThanOrEqual(Math.min(y0, y1) - 1e-6);
          expect(y).toBeLessThanOrEqual(Math.max(y0, y1) + 1e-6);
        }
      }
    });
  }

  it('stops where it is when the owner moves the camera, and asks for no more frames', () => {
    const { camera, f } = gliding({ x: 0, y: 0, z: 1 });
    camera.glide({ x: 1000, y: 0, z: 1 });
    f.step();
    f.step();
    const mid = camera.get();
    expect(mid.x).toBeGreaterThan(0);
    expect(mid.x).toBeLessThan(1000);
    camera.set({ ...mid, y: 40 });
    expect(camera.gliding()).toBe(false);
    expect(f.asked()).toBe(0);
    expect(camera.get()).toEqual({ ...mid, y: 40 });
    expect(camera.goal()).toEqual({ ...mid, y: 40 });
  });

  it('a new glide starts from where the last one got to, and goes to its own target', () => {
    const { camera, f, run } = gliding({ x: 0, y: 0, z: 1 });
    camera.glide({ x: 1000, y: 0, z: 1 });
    f.step();
    const mid = camera.get();
    camera.glide({ x: 0, y: 500, z: 2 });
    f.step();
    expect(camera.get().x).toBeLessThan(mid.x);
    run();
    expect(camera.get()).toEqual({ x: 0, y: 500, z: 2 });
  });

  it('a listener that starts the next glide as one lands gets its glide: it runs, lands, and the camera is at rest', () => {
    const { camera, f, run } = gliding({ x: 0, y: 0, z: 1 });
    const first = { x: 100, y: 0, z: 1 };
    const next = { x: 0, y: 300, z: 2 };
    let chained = false;
    camera.onMove((c) => {
      if (chained || c !== first) return;
      chained = true;
      camera.glide(next);
    });
    camera.glide(first);
    run();
    expect(chained).toBe(true);
    expect(camera.get()).toEqual(next);
    expect(camera.gliding()).toBe(false);
    expect(f.asked()).toBe(0);
  });

  it('a listener that starts a glide in the middle of one replaces it', () => {
    const { camera, run } = gliding({ x: 0, y: 0, z: 1 });
    const next = { x: -40, y: 300, z: 2 };
    let turned = false;
    camera.onMove((c) => {
      if (turned || c.x < 500) return;
      turned = true;
      camera.glide(next);
    });
    camera.glide({ x: 1000, y: 0, z: 1 });
    run();
    expect(turned).toBe(true);
    expect(camera.get()).toEqual(next);
    expect(camera.gliding()).toBe(false);
  });

  it('lands at once when told to, and stops where it is when told to', () => {
    const { camera, f } = gliding({ x: 0, y: 0, z: 1 });
    camera.glide({ x: 1000, y: 0, z: 1 });
    camera.land();
    expect(camera.get()).toEqual({ x: 1000, y: 0, z: 1 });
    expect(f.asked()).toBe(0);
    camera.glide({ x: 0, y: 0, z: 1 });
    f.step();
    const mid = camera.get();
    camera.stop();
    f.step();
    expect(camera.get()).toBe(mid);
    expect(f.asked()).toBe(0);
  });

  it('a long frame (a tab in the background) ends it on its target, not past it', () => {
    const { camera, f } = gliding({ x: 0, y: 0, z: 1 });
    camera.glide({ x: 100, y: 100, z: 1.5 });
    f.step(5000);
    expect(camera.get()).toEqual({ x: 100, y: 100, z: 1.5 });
    expect(camera.gliding()).toBe(false);
    expect(f.asked()).toBe(0);
  });

  it('with reduced motion it is a jump, and takes no frames', () => {
    const f = frames();
    const camera = new CameraStore({ x: 0, y: 0, z: 1 }, { loop: f.loop, reduced: () => true });
    const seen: Camera[] = [];
    camera.onMove((c) => seen.push(c));
    camera.glide({ x: -50, y: 75, z: 0.5 });
    expect(camera.get()).toEqual({ x: -50, y: 75, z: 0.5 });
    expect(camera.gliding()).toBe(false);
    expect(f.asked()).toBe(0);
    expect(seen).toHaveLength(2);
  });

  it('to where the camera already is does nothing', () => {
    const { camera, f } = gliding({ x: 5, y: 6, z: 1 });
    camera.glide({ x: 5, y: 6, z: 1 });
    expect(camera.gliding()).toBe(false);
    expect(f.asked()).toBe(0);
  });
});
