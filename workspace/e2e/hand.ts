import type { CDPSession, Page } from '@playwright/test';
import { readCamera, syntheticWheel } from './pointer';

/**
 * A hand for the browser tests of ink: a model that moves the pointer the way a hand does, and
 * the way to play it into the system Chrome through Chrome's own mouse input.
 *
 * Nobody can hold a mouse here, so the hand is a model: slow at the ends of a stroke and fast
 * between, a slow drift and a tremor on top, a hook as it lands, loops that stop short of their
 * start or run past it. It has two sets of numbers:
 * - a mouse reports 125 times a second, in whole pixels, and is quick and steady;
 * - a trackpad reports about 90 times a second, in half pixels, is slower and drifts more,
 *   and jumps a little as the finger lifts.
 * The same seed gives the same hand.
 */

export type Kind = 'circle' | 'cross' | 'line' | 'scribble';
export type Device = 'mouse' | 'trackpad';
export type Speed = 'fast' | 'slow';
/** A point on the page: clientX and clientY. */
export type P = [x: number, y: number];

/** How each device moves the pointer. Distances are in screen pixels, times in ms. */
export const DEVICES: Record<Device, { hz: number; step: number; drift: number; tremor: number; liftJump: number; ms: Record<Speed, [number, number]> }> = {
  mouse: { hz: 125, step: 1, drift: 0.7, tremor: 0.25, liftJump: 0, ms: { fast: [260, 420], slow: [1300, 1900] } },
  trackpad: { hz: 90, step: 0.5, drift: 1.8, tremor: 0.45, liftJump: 1.5, ms: { fast: [480, 760], slow: [2100, 2900] } },
};

/** A small fixed-seed generator (mulberry32), so the hand is the same on every run. */
export function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Where the hand means to go: a path from 0 (its start) to 1 (its end). */
export type Path = (u: number) => P;

const along = (pts: readonly P[]): Path => {
  const lens = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i]![0], p[1] - pts[i]![1]));
  const total = lens.reduce((a, b) => a + b, 0);
  return (u) => {
    let left = Math.min(1, Math.max(0, u)) * total;
    for (let i = 0; i < lens.length; i++) {
      if (left <= lens[i]! || i === lens.length - 1) {
        const t = lens[i]! === 0 ? 0 : left / lens[i]!;
        return [pts[i]![0] + (pts[i + 1]![0] - pts[i]![0]) * t, pts[i]![1] + (pts[i + 1]![1] - pts[i]![1]) * t];
      }
      left -= lens[i]!;
    }
    return pts[pts.length - 1]!;
  };
};

/** The strokes of one go, as paths about a point of the page, sized by `s`. */
export function shapes(kind: Kind, rnd: () => number, s: number, [cx, cy]: P): Path[] {
  const sign = rnd() < 0.5 ? 1 : -1;
  if (kind === 'circle') {
    // Round a wide, low row or round a spot; it stops short of its start or runs past it.
    const wide = rnd() < 0.6;
    const [rx, ry] = wide ? [130 * s, 30 * s + 8] : [48 * s + 6, 44 * s + 6];
    const turns = 0.95 + rnd() * 0.14;
    const from = rnd() * 2 * Math.PI;
    const drift = (rnd() - 0.5) * 0.12;
    return [
      (u) => {
        const a = from + sign * u * turns * 2 * Math.PI;
        const r = 1 + drift * u;
        return [cx + rx * r * Math.cos(a), cy + ry * r * Math.sin(a)];
      },
    ];
  }
  if (kind === 'cross') {
    // Two strokes over a wide, low row, each bowed a little as a wrist bows it.
    const [w, h] = [190 * s + 20, 26 * s + 14 + rnd() * 50 * s];
    const stroke = (dir: 1 | -1): Path => {
      const bow = (rnd() - 0.5) * 0.14;
      const [x0, y0, x1, y1] = [cx - (w / 2) * dir, cy - h / 2, cx + (w / 2) * dir, cy + h / 2];
      const len = Math.hypot(x1 - x0, y1 - y0);
      return (u) => {
        const off = bow * len * Math.sin(Math.PI * u);
        return [x0 + (x1 - x0) * u - ((y1 - y0) / len) * off, y0 + (y1 - y0) * u + ((x1 - x0) / len) * off];
      };
    };
    return [stroke(1), stroke(-1)];
  }
  if (kind === 'line') {
    // A level line, as under a row of words: a few degrees off level, a slight bow.
    const len = 210 * s + 30;
    const slope = ((rnd() - 0.5) * 10 * Math.PI) / 180;
    const bow = (rnd() - 0.5) * 0.08;
    const [x0, y0] = [cx - (len / 2) * sign, cy];
    return [
      (u) => {
        const d = len * u * sign;
        return [x0 + d * Math.cos(slope), y0 + d * Math.sin(slope) + bow * len * Math.sin(Math.PI * u)];
      },
    ];
  }
  // A scribble: a zigzag, a scratch back and forth along a row, a tick, or an open hook.
  const which = Math.floor(rnd() * 4);
  if (which === 0) {
    const n = 5 + Math.floor(rnd() * 4);
    return [along(Array.from({ length: n + 1 }, (_, i): P => [cx - 90 * s + (180 * s * i) / n, cy + (i % 2 === 0 ? -1 : 1) * (22 * s + 10)]))];
  }
  if (which === 1) {
    // Three passes or five, so it ends on the far side. A scratch that ends where it began is a
    // flat loop to the board's reading, and always was: it is no plain scribble.
    const passes = rnd() < 0.5 ? 3 : 5;
    return [along(Array.from({ length: passes + 1 }, (_, i): P => [cx + (i % 2 === 0 ? -1 : 1) * (80 * s + 20), cy + (i - passes / 2) * 5]))];
  }
  if (which === 2) return [along([[cx - 30 * s - 10, cy - 6], [cx, cy + 34 * s + 8], [cx + 70 * s + 20, cy - 60 * s - 10]])];
  return [
    (u) => {
      const a = 0.35 * Math.PI + u * 1.3 * Math.PI;
      return [cx + (60 * s + 10) * Math.cos(a), cy + (60 * s + 10) * Math.sin(a) * sign];
    },
  ];
}

/** Where the hand really is at `t` of a stroke that takes `ms`: the path, eased, with drift, tremor and a hook as it lands. */
export function hand(path: Path, ms: number, device: Device, rnd: () => number): (t: number) => P {
  const d = DEVICES[device];
  const waves = [1.3, 2.9, 5.1, 10.3].map((hz, i) => ({ hz, amp: i < 3 ? d.drift / (i + 1) : d.tremor, px: rnd() * 2 * Math.PI, py: rnd() * 2 * Math.PI }));
  const hook: P = [(rnd() - 0.5) * 7, (rnd() - 0.5) * 7];
  return (t) => {
    const k = Math.min(1, Math.max(0, t / ms));
    // Least jerk: slow where the stroke starts and ends, fast between.
    const u = 10 * k ** 3 - 15 * k ** 4 + 6 * k ** 5;
    const [x, y] = path(u);
    let [nx, ny] = [0, 0];
    for (const w of waves) {
      nx += w.amp * Math.sin((2 * Math.PI * w.hz * t) / 1000 + w.px);
      ny += w.amp * Math.sin((2 * Math.PI * w.hz * t) / 1000 + w.py);
    }
    // The hand lands a little off and comes onto its line over the first twentieth of the stroke.
    const landing = Math.max(0, 1 - u / 0.05);
    const q = (n: number) => Math.round(n / d.step) * d.step;
    return [q(x + nx + hook[0] * landing), q(y + ny + hook[1] * landing)];
  };
}

export const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Draw one stroke with Chrome's own mouse, in real time. The moves are sent at the device's
 * rate without waiting for the page to answer each one, as a device sends them, so the browser
 * collects those of one frame into one pointer event, as it does for a real hand.
 */
export async function draw(cdp: CDPSession, at: (t: number) => P, ms: number, device: Device, rnd: () => number): Promise<void> {
  const d = DEVICES[device];
  const mouse = (type: 'mousePressed' | 'mouseMoved' | 'mouseReleased', [x, y]: P, down: boolean) =>
    cdp.send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !down ? 'none' : 'left', buttons: down ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
  await mouse('mouseMoved', at(0), false);
  await mouse('mousePressed', at(0), true);
  const t0 = performance.now();
  let end = at(0);
  let last: Promise<unknown> = Promise.resolve();
  for (let n = 1; ; n++) {
    const wait = (n * 1000) / d.hz - (performance.now() - t0);
    if (wait > 0) await sleep(wait);
    const t = Math.min(ms, performance.now() - t0);
    end = at(t);
    last = mouse('mouseMoved', end, true);
    if (t >= ms) break;
  }
  // A finger jumps a little as it leaves a trackpad.
  if (d.liftJump > 0) {
    const q = (n: number) => Math.round(n / d.step) * d.step;
    end = [q(end[0] + (rnd() - 0.5) * 2 * d.liftJump), q(end[1] + (rnd() - 0.5) * 2 * d.liftJump)];
    last = mouse('mouseMoved', end, true);
  }
  await last;
  await mouse('mouseReleased', end, false);
}

/**
 * Put the camera at a zoom. 100% is the `0` key. Further in is the `+` key, which stops at the
 * 400% ceiling. Further out is Ctrl and the wheel, which zooms by `exp(-deltaY / 100)` with the
 * delta cut to 10: those wheel events are built in the page, because Chrome's own wheel rounds
 * its delta and so cannot land on a zoom exactly.
 */
export async function zoomTo(page: Page, z: number): Promise<void> {
  await page.keyboard.press('0');
  if (z > 1) {
    for (let i = 0; i < 12 && (await readCamera(page)).z < z; i++) await page.keyboard.press('+');
  } else {
    for (let i = 0; i < 40 && (await readCamera(page)).z !== z; i++) {
      const dy = Math.log((await readCamera(page)).z / z) * 100;
      await syntheticWheel(page, { at: [720, 430], dy: Math.max(-10, Math.min(10, dy)), ctrl: true });
    }
  }
  const got = (await readCamera(page)).z;
  if (got !== z) throw new Error(`the camera is at ${got}, not at ${z}`);
}
