import type { Stroke } from '../../src';

/**
 * Small geometry helpers for the fixture. The owner's ink is taken from the mockups' own
 * SVG paths, so the strokes in the log are the strokes on the screens.
 */

export type Pt = [number, number];

/** Sample an SVG path made of M, L, C and Z into one polyline per `M`. Curves get four points. */
export function sample(d: string): Pt[][] {
  const tok = d.match(/[MLCZ]|-?\d+(?:\.\d+)?/g) ?? [];
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  let cmd = '';
  let i = 0;
  const pt = (): Pt => [Number(tok[i++]), Number(tok[i++])];
  while (i < tok.length) {
    const t = tok[i] as string;
    if (/[MLCZ]/.test(t)) {
      cmd = t;
      i += 1;
      if (cmd === 'Z') continue;
    }
    if (cmd === 'M') {
      if (cur.length > 1) out.push(cur);
      cur = [pt()];
      cmd = 'L';
    } else if (cmd === 'L') {
      cur.push(pt());
    } else if (cmd === 'C') {
      const p0 = cur[cur.length - 1] as Pt;
      const p1 = pt();
      const p2 = pt();
      const p3 = pt();
      for (let s = 1; s <= 4; s++) {
        const u = s / 4;
        const v = 1 - u;
        const f = (k: 0 | 1) => v * v * v * p0[k] + 3 * v * v * u * p1[k] + 3 * v * u * u * p2[k] + u * u * u * p3[k];
        cur.push([f(0), f(1)]);
      }
    }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

const r1 = (n: number): number => Math.round(n * 10) / 10;

const flat = (pts: Pt[]): number[] => pts.flatMap(([x, y]) => [r1(x), r1(y)]);

/** The strokes of a path, moved by (dx, dy). For free marks, in board units. */
export function inkAt(d: string, dx: number, dy: number, w = 3): Stroke[] {
  return sample(d).map((pts) => ({ pts: flat(pts.map(([x, y]): Pt => [x + dx, y + dy])), w }));
}

/** The strokes of a path, stretched so that together they fill [lo, hi] on both axes. */
export function inkFit(d: string, lo: number, hi: number, w = 3): Stroke[] {
  const lines = sample(d);
  const all = lines.flat();
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const map = (v: number, a: number, b: number) => lo + ((v - a) / (b - a)) * (hi - lo);
  return lines.map((pts) => ({ pts: flat(pts.map(([x, y]): Pt => [map(x, x0, x1), map(y, y0, y1)])), w }));
}

/** A circle round a thing, in its 100 by 100 space: one closed loop from about -6 to 106. */
export const circleOf = (d: string): Stroke[] => inkFit(d, -6, 106);

/** A cross on a thing, in its 100 by 100 space: two strokes, corner to corner. */
export const CROSS: Stroke[] = [
  { pts: [0, 0, 100, 100], w: 3 },
  { pts: [100, 0, 0, 100], w: 3 },
];

/** The owner's rough sketch on screen 1: three clients, arrows, the middle, the model, the way back. */
export const SKETCH_PATHS = [
  'M 22 72 C 70 68, 125 73, 171 70 C 173 88, 169 106, 171 124 C 122 127, 68 122, 21 125 C 18 106, 23 90, 22 72 Z',
  'M 21 146 C 72 143, 120 147, 170 144 C 172 162, 170 180, 172 198 C 124 200, 70 196, 20 199 C 19 181, 22 163, 21 146 Z',
  'M 22 219 C 68 216, 126 221, 171 218 C 173 236, 170 255, 171 272 C 120 275, 66 270, 21 273 C 19 254, 23 237, 22 219 Z',
  'M 178 97 C 220 105, 262 130, 302 160 M 302 160 L 288 158 M 302 160 L 294 148',
  'M 178 171 C 220 174, 262 180, 302 186 M 302 186 L 290 180 M 302 186 L 290 192',
  'M 178 245 C 222 240, 262 226, 302 212 M 302 212 L 290 210 M 302 212 L 294 222',
  'M 312 103 C 380 98, 470 104, 541 100 C 544 150, 539 215, 542 270 C 468 274, 382 268, 311 272 C 308 215, 314 155, 312 103 Z',
  'M 548 185 C 580 182, 612 186, 640 184 M 640 184 L 628 178 M 640 184 L 628 191',
  'M 650 142 C 700 139, 748 143, 791 140 C 793 170, 789 202, 792 230 C 745 233, 698 228, 649 231 C 647 200, 651 170, 650 142 Z',
  'M 425 278 C 427 300, 424 322, 426 340 C 320 346, 200 340, 98 345 C 95 325, 97 305, 96 284 M 96 284 L 88 297 M 96 284 L 105 296',
];

/** The sketch as strokes in board units: the mockup's SVG sits at (760, 210). */
export const sketchStrokes = (): Stroke[] => SKETCH_PATHS.flatMap((d) => inkAt(d, 760, 210));
