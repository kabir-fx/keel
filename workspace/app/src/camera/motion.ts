/**
 * How the camera glides: the in-between cameras of a glide, and its easing. Plain maths, so it
 * can be tested alone; `CameraStore.glide` runs it on the board's frame loop.
 *
 * Adapted from Excalidraw (MIT licence, copyright 2020 Excalidraw), at commit 9fbeaed:
 * `interpolateViewport` and `easeOut` from packages/excalidraw/components/App.viewport.ts and
 * packages/common/src/utils.ts. Changed for the board: our camera is `screen = world * z + (x,
 * y)`, so the pan blend is a plain mix of x and y; and a page that asks for reduced motion jumps.
 */

import type { Camera } from './camera';

/** Fast at first, slow as it arrives, never past the end: `1 - (1 - t)^4`. */
export const easeOut = (t: number): number => 1 - (1 - t) ** 4;

/**
 * The camera a share `f` of the way from `a` to `b`, where `f` runs from 0 to 1.
 *
 * The zoom changes geometrically, `a.z * (b.z / a.z)^f`, so each moment zooms by the same
 * ratio. The pan cannot move in step with `f` beside it: with a geometric zoom and a straight
 * pan, points on the screen swoop and drift back once the zoom changes a lot. So the pan moves
 * by `m`, the share of the way the zoom has gone in plain units. A world point `w` is then at
 * `s(a) + m * (s(b) - s(a))` on the screen: a straight line, travelled one way.
 */
export function between(a: Camera, b: Camera, f: number): Camera {
  if (f >= 1) return b;
  if (f <= 0) return a;
  const z = a.z * (b.z / a.z) ** f;
  const m = b.z === a.z ? f : (z - a.z) / (b.z - a.z);
  return { z, x: a.x + (b.x - a.x) * m, y: a.y + (b.y - a.y) * m };
}

/** The media query the page asks whether it should move less with. */
const REDUCED = '(prefers-reduced-motion: reduce)';

/** True when the page asks for reduced motion: the camera then jumps where it would glide. */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia(REDUCED).matches;
}

/**
 * Call `listener` each time the page starts to ask for reduced motion: the owner turned it on
 * while the board is open. Answers how to stop listening. A page with no `matchMedia` never
 * asks, and is never listened to.
 */
export function onReducedMotion(listener: () => void): () => void {
  if (typeof matchMedia !== 'function') return () => undefined;
  const query = matchMedia(REDUCED);
  if (typeof query.addEventListener !== 'function') return () => undefined;
  const changed = (e: MediaQueryListEvent) => {
    if (e.matches) listener();
  };
  query.addEventListener('change', changed);
  return () => query.removeEventListener('change', changed);
}
