import { describe, expect, it } from 'vitest';
import type { Camera } from '../src/camera/camera';
import { CameraStore } from '../src/camera/camera';
import { between, easeOut } from '../src/camera/motion';
import type { FrameScheduler } from '../src/frame';
import { FrameLoop } from '../src/frame';
import { bezier, EASE } from '../src/motion/ease';
import { arc, at, distance, lengthOf, polyline } from '../src/motion/path';
import {
  ARC_BEND,
  ARC_BEND_MAX,
  BLOCK_GAP_MS,
  BLOCK_IN_MS,
  BLOCK_RISE_PX,
  BOX_FROM_SCALE,
  BOX_GAP_MS,
  BOX_IN_MS,
  CAMERA_REVEAL_MS,
  CURSOR_ENTER_MS,
  CURSOR_TRAVEL_MAX_MS,
  CURSOR_TRAVEL_MIN_MS,
  LABEL_IN_MS,
  lineMs,
  STILL_AFTER_MS,
  travelMs,
} from '../src/motion/timing';

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

  it('eases out unless told otherwise, and eases as it is told: in and out for a reveal', () => {
    for (const [given, ease] of [
      [undefined, easeOut],
      [EASE.move, EASE.move],
    ] as const) {
      const { camera, f } = gliding({ x: 0, y: 0, z: 1 });
      camera.glide({ x: 1000, y: 0, z: 1 }, 160, given);
      for (let k = 1; k < 10; k++) {
        f.step();
        expect(camera.get().x).toBeCloseTo(1000 * ease((k * 16) / 160), 9);
      }
      f.step();
      expect(camera.get()).toEqual({ x: 1000, y: 0, z: 1 });
      expect(camera.gliding()).toBe(false);
    }
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

/* ------------------------------------------------------------------ motion/: easings, paths, timing */

/** The four numbers a CSS `cubic-bezier(...)` string names. */
const cssPoints = (css: string): [number, number, number, number] => {
  const m = /^cubic-bezier\(([^)]*)\)$/.exec(css);
  if (!m) throw new Error(`not a cubic-bezier: "${css}"`);
  const n = m[1]!.split(',').map(Number);
  expect(n).toHaveLength(4);
  return n as [number, number, number, number];
};

/** The point of the Bézier through (0,0), (x1,y1), (x2,y2), (1,1) at its own parameter `s`. */
const onCurve = ([x1, y1, x2, y2]: readonly number[], s: number) => {
  const c = (a: number, b: number) => 3 * (1 - s) ** 2 * s * a + 3 * (1 - s) * s * s * b + s ** 3;
  return [c(x1!, x2!), c(y1!, y2!)] as const;
};

const shares = (n: number) => Array.from({ length: n + 1 }, (_, i) => i / n);

describe('the board’s easings', () => {
  it('a Bézier answers the curve’s own height at each time, to a millionth', () => {
    const curves: Array<[number, number, number, number]> = [[0.25, 0.1, 0.25, 1], [0.4, 0, 0.2, 1], [0.05, 0.7, 0.1, 1], [0.15, 0.9, 0.3, 1.15], [0, 0, 1, 1]];
    for (const p of curves) {
      const f = bezier(...p);
      for (const s of shares(50)) {
        const [x, y] = onCurve(p, s);
        expect(Math.abs(f(x) - y), `${p} at s=${s}`).toBeLessThan(1e-6);
      }
    }
  });

  it('a straight Bézier is no easing at all: the time itself', () => {
    const f = bezier(1 / 3, 1 / 3, 2 / 3, 2 / 3);
    for (const t of shares(20)) expect(f(t)).toBeCloseTo(t, 9);
  });

  it('every easing is exactly 0 at or before the start and exactly 1 at or past the end', () => {
    for (const [name, e] of Object.entries(EASE)) {
      for (const t of [-1, -1e-9, 0]) expect(e(t), name).toBe(0);
      for (const t of [1, 1 + 1e-9, 2]) expect(e(t), name).toBe(1);
    }
  });

  it('each easing is the curve its CSS string names, so the page and the frame loop agree', () => {
    for (const [name, e] of Object.entries(EASE)) {
      const same = bezier(...cssPoints(e.css));
      for (const t of shares(100)) expect(e(t), `${name} at ${t}`).toBe(same(t));
    }
    expect(EASE.move.css).toBe('cubic-bezier(0.4, 0, 0.2, 1)');
    expect(EASE.draw.css).toBe('cubic-bezier(0.65, 0, 0.35, 1)');
    expect(EASE.enter.css).toBe('cubic-bezier(0.05, 0.7, 0.1, 1)');
    expect(EASE.exit.css).toBe('cubic-bezier(0.3, 0, 1, 1)');
  });

  it('move, draw, enter and exit go one way, never past the end, and none is linear', () => {
    for (const name of ['move', 'draw', 'enter', 'exit'] as const) {
      const ys = shares(200).map((t) => EASE[name](t));
      expect(oneWay(ys), name).toBe(true);
      expect(Math.max(...ys), name).toBe(1);
      expect(Math.min(...ys), name).toBe(0);
      // Somewhere it is well off the straight line.
      expect(Math.max(...shares(200).map((t, i) => Math.abs(ys[i]! - t))), name).toBeGreaterThan(0.1);
    }
    // In and out: slow at both ends. Enter is fast in; exit is slow away.
    expect(EASE.move(0.1)).toBeLessThan(0.1);
    expect(EASE.move(0.9)).toBeGreaterThan(0.9);
    expect(EASE.enter(0.1)).toBeGreaterThan(0.5);
    expect(EASE.exit(0.3)).toBeLessThan(0.3);
  });

  it('pull goes in and out, past the end once by about 1 to 1.5%, late, and comes back to it exactly', () => {
    const ys = shares(2000).map((t) => EASE.pull(t));
    const peak = Math.max(...ys);
    expect(peak).toBeGreaterThan(1.01);
    expect(peak).toBeLessThan(1.015);
    // Up to the peak, then down to 1: the way turns once, and late.
    const top = ys.indexOf(peak);
    expect(top / ys.length).toBeGreaterThan(0.75);
    expect(oneWay(ys.slice(0, top + 1))).toBe(true);
    expect(oneWay(ys.slice(top))).toBe(true);
    expect(ys[ys.length - 1]).toBe(1);
    // Slow away, as a hand starts a drag.
    expect(EASE.pull(0.1)).toBeLessThan(0.1);
  });
});

describe('the paths the cursor travels', () => {
  const cross = (a: readonly number[], b: readonly number[], c: readonly number[]) => (b[0]! - a[0]!) * (c[1]! - a[1]!) - (b[1]! - a[1]!) * (c[0]! - a[0]!);

  it('an arc starts and ends exactly at its two places, also asked before 0 and past 1', () => {
    const p = arc([10, 20], [610, 420]);
    expect(at(p, 0)).toEqual([10, 20]);
    expect(at(p, -3)).toEqual([10, 20]);
    expect(at(p, 1)).toEqual([610, 420]);
    expect(at(p, 7)).toEqual([610, 420]);
  });

  it('an arc bends to the left of the way it goes, by a share of its length, and never more than the cap', () => {
    // A trip to the right bends up; one to the left bends down.
    const short = arc([0, 0], [200, 0]);
    expect(at(short, 0.5)[0]).toBeCloseTo(100, 6);
    expect(at(short, 0.5)[1]).toBeCloseTo(-200 * ARC_BEND, 6);
    expect(at(arc([200, 0], [0, 0]), 0.5)[1]).toBeCloseTo(200 * ARC_BEND, 6);
    const long = arc([0, 0], [5000, 0]);
    expect(at(long, 0.5)[1]).toBeCloseTo(-ARC_BEND_MAX, 6);
    // Its length is a little more than the straight line.
    expect(lengthOf(short)).toBeGreaterThan(200);
    expect(lengthOf(short)).toBeLessThan(200 * 1.05);
  });

  it('an arc is a curve, not a straight line, and the same trip is always the same path', () => {
    const p = arc([0, 0], [300, 300]);
    expect(Math.abs(cross(at(p, 0.25), at(p, 0.5), at(p, 0.75)))).toBeGreaterThan(100);
    expect(arc([0, 0], [300, 300])).toEqual(p);
  });

  it('equal shares of the way are equal distances along it: only the easing says how fast', () => {
    const p = arc([0, 0], [800, 100]);
    const steps = shares(20).slice(1).map((f, i) => distance(at(p, i / 20), at(p, f)));
    const mean = lengthOf(p) / 20;
    for (const d of steps) expect(Math.abs(d - mean) / mean).toBeLessThan(0.01);
  });

  it('a trip of no length is a point', () => {
    const p = arc([5, 6], [5, 6]);
    expect(lengthOf(p)).toBe(0);
    for (const f of [-1, 0, 0.5, 1, 2]) expect(at(p, f)).toEqual([5, 6]);
  });

  it('a polyline is measured along its length: an arrow’s route', () => {
    const route = polyline([[0, 0], [100, 0], [100, 0], [100, 100]]);
    expect(lengthOf(route)).toBe(200);
    expect(at(route, 0.25)).toEqual([50, 0]);
    expect(at(route, 0.5)).toEqual([100, 0]);
    expect(at(route, 0.75)).toEqual([100, 50]);
    expect(at(route, 1)).toEqual([100, 100]);
    expect(at(polyline([[3, 4]]), 0.5)).toEqual([3, 4]);
  });
});

describe('the motion’s numbers', () => {
  it('a trip takes 320 to 750 ms, longer for a longer trip, by the motion skill’s distance scaling', () => {
    const times = shares(500).map((f) => travelMs(f * 4000));
    expect(oneWay(times)).toBe(true);
    expect(Math.min(...times)).toBe(CURSOR_TRAVEL_MIN_MS);
    expect(Math.max(...times)).toBe(CURSOR_TRAVEL_MAX_MS);
    expect([CURSOR_TRAVEL_MIN_MS, CURSOR_TRAVEL_MAX_MS]).toEqual([320, 750]);
    expect(travelMs(0)).toBe(320);
    expect(travelMs(100)).toBe(400);
    expect(travelMs(150)).toBe(460);
    expect(travelMs(400)).toBe(640);
    expect(travelMs(1e6)).toBe(750);
    expect(travelMs(Number.NaN)).toBe(320);
  });

  it('a line takes 80 to 650 ms by its length: a short stroke is short, a flick shorter', () => {
    expect(lineMs(0)).toBe(80);
    expect(lineMs(8)).toBe(80);
    expect(lineMs(24)).toBe(130);
    expect(lineMs(40)).toBe(180);
    expect(lineMs(420)).toBe(415);
    expect(lineMs(800)).toBe(650);
    expect(lineMs(1e6)).toBe(650);
    expect(oneWay(shares(100).map((f) => lineMs(f * 1000)))).toBe(true);
  });

  it('are the plan’s starting values', () => {
    expect({ CURSOR_ENTER_MS, BLOCK_IN_MS, BLOCK_GAP_MS, BLOCK_RISE_PX, BOX_IN_MS, BOX_GAP_MS, BOX_FROM_SCALE, LABEL_IN_MS, CAMERA_REVEAL_MS, STILL_AFTER_MS }).toEqual({
      CURSOR_ENTER_MS: 600,
      BLOCK_IN_MS: 220,
      BLOCK_GAP_MS: 60,
      BLOCK_RISE_PX: 6,
      BOX_IN_MS: 180,
      BOX_GAP_MS: 40,
      BOX_FROM_SCALE: 0.96,
      LABEL_IN_MS: 160,
      CAMERA_REVEAL_MS: 560,
      STILL_AFTER_MS: 150,
    });
  });
});
