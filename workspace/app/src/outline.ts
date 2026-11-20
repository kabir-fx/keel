import type { Box } from '@keel/protocol';

/**
 * The tidy outline of a lasso: the edge of the union of its targets' boxes, as closed loops of
 * corner points, clockwise on screen. Boxes that touch or overlap share one loop. Pure, so the
 * outline is the same wherever it is drawn.
 */
export type Loop = Array<[number, number]>;

export function unionOutline(boxes: readonly Box[]): Loop[] {
  const live = boxes.filter((b) => b[2] > 0 && b[3] > 0);
  if (live.length === 0) return [];
  const xs = [...new Set(live.flatMap((b) => [b[0], b[0] + b[2]]))].sort((a, b) => a - b);
  const ys = [...new Set(live.flatMap((b) => [b[1], b[1] + b[3]]))].sort((a, b) => a - b);
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  const covered = (i: number, j: number) => {
    if (i < 0 || j < 0 || i >= nx || j >= ny) return false;
    const cx = (xs[i]! + xs[i + 1]!) / 2;
    const cy = (ys[j]! + ys[j + 1]!) / 2;
    return live.some(([x, y, w, h]) => cx > x && cx < x + w && cy > y && cy < y + h);
  };
  const grid: boolean[][] = Array.from({ length: nx }, (_, i) => Array.from({ length: ny }, (_, j) => covered(i, j)));
  const on = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < ny && grid[i]![j]!;

  // Directed boundary edges, keyed by their start corner. Clockwise: the inside is on the right.
  const key = (i: number, j: number) => `${i},${j}`;
  const edges = new Map<string, Array<[number, number]>>();
  const add = (a: [number, number], b: [number, number]) => {
    const k = key(a[0], a[1]);
    const list = edges.get(k) ?? [];
    list.push(b);
    edges.set(k, list);
  };
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      if (!on(i, j)) continue;
      if (!on(i, j - 1)) add([i, j], [i + 1, j]);
      if (!on(i + 1, j)) add([i + 1, j], [i + 1, j + 1]);
      if (!on(i, j + 1)) add([i + 1, j + 1], [i, j + 1]);
      if (!on(i - 1, j)) add([i, j + 1], [i, j]);
    }
  }

  const loops: Loop[] = [];
  for (;;) {
    const start = [...edges.entries()].find(([, l]) => l.length > 0);
    if (!start) break;
    const [sk] = start;
    const [si, sj] = sk.split(',').map(Number) as [number, number];
    const corners: Array<[number, number]> = [[si, sj]];
    let cur: [number, number] = [si, sj];
    for (let guard = 0; guard < 100_000; guard++) {
      const list = edges.get(key(cur[0], cur[1]));
      const next = list?.shift();
      if (!next) break;
      if (next[0] === si && next[1] === sj) break;
      corners.push(next);
      cur = next;
    }
    loops.push(simplify(corners.map(([i, j]) => [xs[i]!, ys[j]!] as [number, number])));
  }
  return loops.filter((l) => l.length >= 4);
}

const touches = (a: Box, b: Box) => a[0] <= b[0] + b[2] && b[0] <= a[0] + a[2] && a[1] <= b[1] + b[3] && b[1] <= a[1] + a[3];
const gapOf = (a: Box, b: Box) =>
  Math.hypot(Math.max(0, b[0] - (a[0] + a[2]), a[0] - (b[0] + b[2])), Math.max(0, b[1] - (a[1] + a[3]), a[1] - (b[1] + b[3])));

/** The band that joins two boxes that do not touch: across the span they share, else an L of `band` width. */
function bridge(a: Box, b: Box, band: number): Box[] {
  const top = Math.max(a[1], b[1]);
  const bottom = Math.min(a[1] + a[3], b[1] + b[3]);
  const left = Math.max(a[0], b[0]);
  const right = Math.min(a[0] + a[2], b[0] + b[2]);
  if (bottom > top) {
    const [l, r] = a[0] < b[0] ? [a, b] : [b, a];
    return [[l[0] + l[2] - 1, top, r[0] - (l[0] + l[2]) + 2, bottom - top]];
  }
  if (right > left) {
    const [u, d] = a[1] < b[1] ? [a, b] : [b, a];
    return [[left, u[1] + u[3] - 1, right - left, d[1] - (u[1] + u[3]) + 2]];
  }
  // Corner to corner: along from the middle of one, then down or up to the middle of the other.
  const ca: [number, number] = [a[0] + a[2] / 2, a[1] + a[3] / 2];
  const cb: [number, number] = [b[0] + b[2] / 2, b[1] + b[3] / 2];
  // No thicker than the boxes it joins, and ending at the middle of each, so it stays inside them.
  const h = Math.min(band, a[3], b[2]) / 2;
  const x0 = Math.min(ca[0], cb[0] - h);
  const x1 = Math.max(ca[0], cb[0] + h);
  const y0 = Math.min(ca[1] - h, cb[1]);
  const y1 = Math.max(ca[1] + h, cb[1]);
  return [
    [x0, ca[1] - h, x1 - x0, 2 * h],
    [cb[0] - h, y0, 2 * h, y1 - y0],
  ];
}

/**
 * The boxes, joined into one shape: while they fall apart into groups, the two nearest boxes of
 * different groups are joined by a band. So a lasso round things that do not touch is still
 * one outline, as the owner drew one loop.
 */
export function bridged(boxes: readonly Box[], band: number): Box[] {
  const out = boxes.filter((b) => b[2] > 0 && b[3] > 0);
  for (let guard = 0; guard < 64; guard++) {
    const group = out.map((_, i) => i);
    const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i]!)));
    for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) if (touches(out[i]!, out[j]!)) group[find(i)] = find(j);
    let best: [number, number, number] | undefined;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        if (find(i) === find(j)) continue;
        const g = gapOf(out[i]!, out[j]!);
        if (!best || g < best[0]) best = [g, i, j];
      }
    }
    if (!best) break;
    out.push(...bridge(out[best[1]]!, out[best[2]]!, band));
  }
  return out;
}

/** Drop corners that sit on a straight run. */
function simplify(pts: Loop): Loop {
  const out: Loop = [];
  const n = pts.length;
  for (let k = 0; k < n; k++) {
    const p = pts[(k - 1 + n) % n]!;
    const c = pts[k]!;
    const q = pts[(k + 1) % n]!;
    const straight = (p[0] === c[0] && c[0] === q[0]) || (p[1] === c[1] && c[1] === q[1]);
    if (!straight) out.push(c);
  }
  return out;
}

/** A loop as an SVG path, with its corners rounded by up to `r`. */
export function loopPath(loop: Loop, r = 12): string {
  const n = loop.length;
  if (n < 3) return '';
  const f = (v: number) => Math.round(v * 10) / 10;
  const parts: string[] = [];
  for (let k = 0; k < n; k++) {
    const p = loop[(k - 1 + n) % n]!;
    const c = loop[k]!;
    const q = loop[(k + 1) % n]!;
    const inLen = Math.hypot(c[0] - p[0], c[1] - p[1]);
    const outLen = Math.hypot(q[0] - c[0], q[1] - c[1]);
    const rr = Math.min(r, inLen / 2, outLen / 2);
    const a: [number, number] = [c[0] - ((c[0] - p[0]) / inLen) * rr, c[1] - ((c[1] - p[1]) / inLen) * rr];
    const b: [number, number] = [c[0] + ((q[0] - c[0]) / outLen) * rr, c[1] + ((q[1] - c[1]) / outLen) * rr];
    parts.push(`${k === 0 ? 'M' : 'L'} ${f(a[0])} ${f(a[1])} Q ${f(c[0])} ${f(c[1])} ${f(b[0])} ${f(b[1])}`);
  }
  return `${parts.join(' ')} Z`;
}

/** The box round several loops. */
export function loopsBox(loops: readonly Loop[]): Box | undefined {
  const pts = loops.flat();
  if (pts.length === 0) return undefined;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}
