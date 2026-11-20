/**
 * A grid of rows (lanes) and columns, and an orthogonal router whose vertical runs use the
 * gutters between columns, so an arrow never passes through a box. Ported from spike S3.
 */

export type Pt = [number, number];

export interface Row {
  top: number;
  boxTop: number;
  boxH: number;
  bottom: number;
}

export interface Grid {
  /** x of column 1. */
  left: number;
  boxW: number;
  gut: number;
  rows: Row[];
  /** "row/col" of every cell that holds a box. */
  occupied: Set<string>;
  /** How many arrows already run in each gutter, so the next one keeps off them. */
  gutterUse: Map<number, number>;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Route {
  pts: Pt[];
  /** The middle of the longest segment. */
  mid: Pt;
  horizontal: boolean;
  segLen: number;
}

export const colX = (g: Grid, c: number): number => g.left + (c - 1) * (g.boxW + g.gut);

/** x of the gutter right of column c. Column 0 is left of column 1. */
export const gutterX = (g: Grid, c: number): number => colX(g, c) + g.boxW + g.gut / 2;

function row(g: Grid, r: number): Row {
  const out = g.rows[r];
  if (!out) throw new Error(`no row ${r}`);
  return out;
}

export const cellRect = (g: Grid, r: number, c: number): Rect => {
  const rr = row(g, r);
  return { x: colX(g, c), y: rr.boxTop, w: g.boxW, h: rr.boxH };
};

const free = (g: Grid, r: number, c1: number, c2: number): boolean => {
  for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) if (g.occupied.has(`${r}/${c}`)) return false;
  return true;
};

export const rowsBetweenFree = (g: Grid, c: number, r1: number, r2: number): boolean => {
  for (let r = Math.min(r1, r2) + 1; r < Math.max(r1, r2); r++) if (g.occupied.has(`${r}/${c}`)) return false;
  return true;
};

const OFFSETS = [0, 12, -12, 24, -24, 6, -6];

function takeGutter(g: Grid, c: number): number {
  const k = g.gutterUse.get(c) ?? 0;
  g.gutterUse.set(c, k + 1);
  return OFFSETS[k % OFFSETS.length] ?? 0;
}

export function finish(pts: Pt[]): Route {
  let best = -1;
  let mid: Pt = pts[0] ?? [0, 0];
  let horizontal = true;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i]!;
    const [x2, y2] = pts[i + 1]!;
    const len = Math.abs(x2 - x1) + Math.abs(y2 - y1);
    if (len > best) {
      best = len;
      mid = [(x1 + x2) / 2, (y1 + y2) / 2];
      horizontal = y1 === y2;
    }
  }
  return { pts, mid, horizontal, segLen: Math.max(0, best) };
}

/** Route an arrow from the box at (ra, ca) to the box at (rb, cb). */
export function route(g: Grid, ra: number, ca: number, rb: number, cb: number): Route {
  const A = cellRect(g, ra, ca);
  const B = cellRect(g, rb, cb);
  const amy = A.y + A.h / 2;
  const bmy = B.y + B.h / 2;
  const topM = (r: number) => (row(g, r).top + row(g, r).boxTop) / 2;
  const botM = (r: number) => (row(g, r).boxTop + row(g, r).boxH + row(g, r).bottom) / 2;

  if (ra === rb) {
    if (cb > ca) {
      if (cb - ca === 1 || free(g, ra, ca + 1, cb - 1)) return finish([[A.x + A.w, amy], [B.x, bmy]]);
      const y = topM(ra);
      return finish([[A.x + A.w - 22, A.y], [A.x + A.w - 22, y], [B.x + 22, y], [B.x + 22, B.y]]);
    }
    if (cb < ca) {
      if (ca - cb === 1) return finish([[A.x, amy], [B.x + B.w, bmy]]);
      const y = botM(ra);
      return finish([[A.x + A.w / 2 - 10, A.y + A.h], [A.x + A.w / 2 - 10, y], [B.x + B.w / 2 + 10, y], [B.x + B.w / 2 + 10, B.y + B.h]]);
    }
    const y = botM(ra);
    const x = A.x + A.w + 16;
    return finish([[A.x + A.w, amy], [x, amy], [x, y], [A.x + A.w - 24, y], [A.x + A.w - 24, A.y + A.h]]);
  }

  const down = rb > ra;
  if (ca === cb && rowsBetweenFree(g, ca, ra, rb)) {
    const x = A.x + A.w / 2;
    return finish([[x, down ? A.y + A.h : A.y], [x, down ? B.y : B.y + B.h]]);
  }
  if (cb >= ca) {
    if (cb === ca) {
      const x = gutterX(g, ca) + takeGutter(g, ca);
      return finish([[A.x + A.w, amy], [x, amy], [x, bmy], [B.x + B.w, bmy]]);
    }
    const order: number[] = [];
    for (let k = ca; k <= cb - 1; k++) order.push(k);
    // Going up: along the source lane first, then up.
    if (!down) order.reverse();
    for (const k of order) {
      const okA = k < ca + 1 || free(g, ra, ca + 1, k);
      const okB = cb - 1 < k + 1 || free(g, rb, k + 1, cb - 1);
      if (okA && okB) {
        const x = gutterX(g, k) + takeGutter(g, k);
        return finish([[A.x + A.w, amy], [x, amy], [x, bmy], [B.x, bmy]]);
      }
    }
    const y = down ? botM(ra) : topM(ra);
    const x = gutterX(g, cb - 1) + takeGutter(g, cb - 1);
    const ax = A.x + A.w / 2 + 14;
    return finish([[ax, down ? A.y + A.h : A.y], [ax, y], [x, y], [x, bmy], [B.x, bmy]]);
  }
  // Backwards in time, across lanes.
  for (let k = ca - 1; k >= cb; k--) {
    const okA = ca - 1 < k + 1 || free(g, ra, k + 1, ca - 1);
    const okB = k < cb + 1 || free(g, rb, cb + 1, k);
    if (okA && okB) {
      const x = gutterX(g, k) + takeGutter(g, k);
      return finish([[A.x, amy], [x, amy], [x, bmy], [B.x + B.w, bmy]]);
    }
  }
  const y = down ? botM(ra) : topM(ra);
  const x = gutterX(g, cb) + takeGutter(g, cb);
  const ax = A.x + A.w / 2 - 14;
  return finish([[ax, down ? A.y + A.h : A.y], [ax, y], [x, y], [x, bmy], [B.x + B.w, bmy]]);
}

/** An SVG path through the points, with rounded corners. */
export function roundedPath(pts: readonly Pt[], r = 8): string {
  const first = pts[0];
  if (!first || pts.length < 2) return '';
  let d = `M${first[0]},${first[1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1]!;
    const [x, y] = pts[i]!;
    const [nx, ny] = pts[i + 1]!;
    const l1 = Math.hypot(x - px, y - py);
    const l2 = Math.hypot(nx - x, ny - y);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const ax = x - ((x - px) / (l1 || 1)) * rr;
    const ay = y - ((y - py) / (l1 || 1)) * rr;
    const bx = x + ((nx - x) / (l2 || 1)) * rr;
    const by = y + ((ny - y) / (l2 || 1)) * rr;
    d += ` L${ax},${ay} Q${x},${y} ${bx},${by}`;
  }
  const last = pts[pts.length - 1]!;
  return `${d} L${last[0]},${last[1]}`;
}

export interface LabelSize {
  w: number;
  h: number;
  lines: string[];
}

export interface PlacedLabel extends LabelSize {
  /** The centre. */
  x: number;
  y: number;
}

export const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Put each label on its arrow where it covers no box and no earlier label: every segment,
 * longest first, at several points along it; then beside the line; then a ring round the
 * middle. `bounds` keeps a label inside the picture.
 */
export function placeLabels(routes: Array<{ r: Route; size?: LabelSize }>, boxes: readonly Rect[], bounds?: Rect): Array<PlacedLabel | undefined> {
  const placed: Rect[] = [];
  return routes.map(({ r, size }) => {
    if (!size) return undefined;
    const segs = r.pts
      .slice(0, -1)
      .map((p, i) => [p, r.pts[i + 1]!] as const)
      .sort((a, b) => Math.abs(b[1][0] - b[0][0]) + Math.abs(b[1][1] - b[0][1]) - (Math.abs(a[1][0] - a[0][0]) + Math.abs(a[1][1] - a[0][1])));
    const tries: Pt[] = [];
    for (const [a, b] of segs) for (const t of [0.5, 0.35, 0.65, 0.2, 0.8]) tries.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    for (const [a, b] of segs) {
      for (const t of [0.5, 0.3, 0.7]) {
        const c: Pt = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        if (a[1] === b[1]) tries.push([c[0], c[1] - size.h / 2 - 4], [c[0], c[1] + size.h / 2 + 4]);
        else tries.push([c[0] + size.w / 2 + 4, c[1]], [c[0] - size.w / 2 - 4, c[1]]);
      }
    }
    for (const rad of [26, 40, 56, 74]) {
      for (const k of [0, 4, 2, 6, 1, 3, 5, 7]) {
        const ang = (k * Math.PI) / 4;
        tries.push([r.mid[0] + Math.cos(ang) * (rad + size.w / 3), r.mid[1] + Math.sin(ang) * rad]);
      }
    }
    const rect = (c: Pt): Rect => ({ x: c[0] - size.w / 2, y: c[1] - size.h / 2, w: size.w, h: size.h });
    const pad = (q: Rect): Rect => ({ x: q.x - 2, y: q.y - 2, w: q.w + 4, h: q.h + 4 });
    const inside = (q: Rect) => !bounds || (q.x >= bounds.x && q.y >= bounds.y && q.x + q.w <= bounds.x + bounds.w && q.y + q.h <= bounds.y + bounds.h);
    const clear = (c: Pt) => !boxes.some((b) => overlaps(pad(rect(c)), b)) && !placed.some((l) => overlaps(pad(rect(c)), l));
    const best =
      tries.find((c) => inside(rect(c)) && clear(c)) ?? tries.find((c) => inside(rect(c)) && !placed.some((l) => overlaps(pad(rect(c)), l))) ?? r.mid;
    const q = rect(best);
    placed.push(q);
    return { ...size, x: best[0], y: best[1] };
  });
}
