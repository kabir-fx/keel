/**
 * The board's easings: how fast a thing goes at each moment of its move. Plain maths, so a plan
 * can be tested alone.
 *
 * Each named easing is a function, for what the board's frame loop moves (the cursor), and
 * carries the CSS string of the same curve, for what Web Animations move (a picture's parts).
 * Both name one cubic Bézier, so the two always agree.
 */

/** An easing: the share of the way gone at a share `t` of the time. Its `css` names the same curve for the page. */
export interface Easing {
  (t: number): number;
  readonly css: string;
}

/** How close the solver gets to the asked time before it stops. A thousandth of a pixel on a 1000 px trip. */
const EPSILON = 1e-7;

/**
 * The cubic Bézier through (0, 0), (x1, y1), (x2, y2), (1, 1), as CSS's `cubic-bezier()` reads it:
 * `t` is the share of the time (the curve's x), the answer is the share of the way (its y). It is
 * exactly 0 at or before the start and exactly 1 at or past the end. `x1` and `x2` must be
 * between 0 and 1, as CSS asks; `y1` and `y2` may leave that range, for an overshoot.
 *
 * Finds the curve's own parameter for `t` by Newton's method, and by halving when that stalls:
 * the way browsers do it (WebKit's `UnitBezier`).
 */
export function bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  // Each coordinate is a cubic a·s³ + b·s² + c·s in the curve's parameter s.
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const xOf = (s: number) => ((ax * s + bx) * s + cx) * s;
  const yOf = (s: number) => ((ay * s + by) * s + cy) * s;
  const slopeX = (s: number) => (3 * ax * s + 2 * bx) * s + cx;

  const solve = (x: number): number => {
    let s = x;
    for (let i = 0; i < 8; i++) {
      const err = xOf(s) - x;
      if (Math.abs(err) < EPSILON) return s;
      const d = slopeX(s);
      if (Math.abs(d) < 1e-6) break;
      s -= err / d;
    }
    // Newton stalled on a flat stretch: halve the interval instead, which always gets there.
    let lo = 0;
    let hi = 1;
    s = x;
    while (hi - lo > EPSILON) {
      const v = xOf(s);
      if (Math.abs(v - x) < EPSILON) return s;
      if (v < x) lo = s;
      else hi = s;
      s = (lo + hi) / 2;
    }
    return s;
  };

  return (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return yOf(solve(t));
  };
}

/** A named easing: the curve as a function, with its CSS string beside it. */
function curve(x1: number, y1: number, x2: number, y2: number): Easing {
  return Object.assign(bezier(x1, y1, x2, y2), { css: `cubic-bezier(${x1}, ${y1}, ${x2}, ${y2})` });
}

/**
 * The board's easings, one for each kind of move (plan section 6). Nothing that moves through
 * space is linear.
 */
export const EASE = {
  /** In and out, no bounce: the cursor travelling, a camera nobody holds. */
  move: curve(0.4, 0, 0.2, 1),
  /** In and out, slower at both ends than `move`: a line drawn on. */
  draw: curve(0.65, 0, 0.35, 1),
  /** Fast in, long settle: a block, a box or a label coming in. */
  enter: curve(0.05, 0.7, 0.1, 1),
  /** Slow start, fast away: something leaving. */
  exit: curve(0.3, 0, 1, 1),
  /**
   * In and out as `move`, going about 1.4% past the end once near its end and settling back on
   * it: a picture pulled out to its size, and the cursor's tip on its corner. Paper, not rubber.
   */
  pull: curve(0.4, 0, 0.2, 1.15),
} as const satisfies Record<string, Easing>;
