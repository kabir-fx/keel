import type { TargetRect, XY } from '../geometry';
import { distToSegment, lassoTargets } from '../geometry';
import { LASSO_SIMPLIFY } from '../input/constants';

/**
 * What a lasso holds while it is being drawn: plain geometry, worked out again on every frame.
 * What "holds" means is the board's own rule (`lassoTargets`: half of a thing inside the loop),
 * the one the lasso is posted with. Working it out on every frame from a path simplified at
 * 5 px is Excalidraw's (packages/excalidraw/lasso/index.ts, commit 9fbeaed).
 */

/**
 * A path with every point dropped that lies no further than `tolerance` from the line the points
 * kept round it make (Ramer, Douglas and Peucker). Its two ends are always kept.
 */
export function simplify(pts: readonly XY[], tolerance: number): XY[] {
  const keep = new Set([0, pts.length - 1]);
  const spans: Array<[number, number]> = [[0, pts.length - 1]];
  for (let span = spans.pop(); span; span = spans.pop()) {
    const [a, b] = span;
    let far = -1;
    let most = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = distToSegment(pts[i]![0], pts[i]![1], pts[a]!, pts[b]!);
      if (d > most) {
        most = d;
        far = i;
      }
    }
    if (far < 0) continue;
    keep.add(far);
    spans.push([a, far], [far, b]);
  }
  return pts.filter((_, i) => keep.has(i));
}

/**
 * The targets a loop being drawn holds now, by their ids. `loop` is its path in board units, and
 * `z` the zoom: the path is simplified to within `LASSO_SIMPLIFY` screen pixels first.
 */
export function holdsNow(loop: readonly XY[], rects: readonly TargetRect[], z: number): string[] {
  return lassoTargets(simplify(loop, LASSO_SIMPLIFY / z), rects);
}
