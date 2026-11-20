/**
 * What a picture is made of, and the order it is drawn on.
 *
 * The board never shows an agent's picture whole. It sets the picture down, then draws what
 * is on it, one part after another. The app knows no picture by its classes, so each renderer
 * says what its picture is made of: it marks each part with `data-build="<kind>"`, through
 * `asPart`. `buildParts` reads the marks back, in the order the parts are drawn on.
 * (`data-part` is taken: in the pipeline it names the model's part that a box stands for.)
 *
 * The kinds of part:
 * - `frame`: a surface that is set down. The picture's root is one, and so is each sheet
 *   inside it: an approach of a spread, a tile, a panel, an option. Only a frame holds parts.
 * - `head`: a frame's title or strip, the first thing read on it. A frame has one at most, and
 *   it is the first part inside the frame.
 * - `block`: something that comes in as one: a paragraph, a list item, a caption, a risk, the
 *   gaps, a row of chips or of controls, an image.
 * - `shape`: a box of an SVG drawing, with the words in it: a box, a step, a lane, a part.
 * - `line`: a stroke of an SVG drawing: an arrow, a divider, a cross. A dashed one carries
 *   `data-dashed`, because a dashed stroke cannot be drawn on by its dash offset.
 * - `label`: the words of a line, on their plate.
 *
 * The order:
 * - Parts come in document order. So a frame comes before everything on it, and a part on a
 *   sheet comes after that sheet.
 * - One SVG drawing comes in at the place of its first part: its shapes, then its lines, then
 *   its labels, whatever order the SVG paints them in. Within each kind, `data-order` gives the
 *   reading order, smallest first. A part with none comes after those with one, in document order.
 * - `depth` is how many frames a part sits inside: 0 for the root frame, 1 for its head, its
 *   blocks and a sheet on it, 2 for what is on that sheet. A player can build each sheet as its
 *   own small arrival.
 *
 * What a new picture kind must do: put `asPart('frame')` on its root and on each sheet, and put
 * everything that shows inside a part that is not a frame. Anything else would land with the
 * paper, all at once. `pictures/test/build.test.tsx` checks every kind for it.
 *
 * Reading the parts reads attributes only: no layout and no style, so it is cheap and runs in
 * a test's DOM.
 */

export const PART_KINDS = ['frame', 'head', 'block', 'shape', 'line', 'label'] as const;

export type PartKind = (typeof PART_KINDS)[number];

export interface BuildPart {
  el: Element;
  kind: PartKind;
  /** How many frames the part sits inside. The root frame is 0. */
  depth: number;
  /** A dashed line: it has to be drawn on some other way than by its dash offset. */
  dashed: boolean;
}

/** What a renderer spreads on the element of a part. `order` is its place in the reading order of its drawing. */
export function asPart(kind: PartKind, order?: number): { 'data-build': PartKind; 'data-order'?: number } {
  return order === undefined ? { 'data-build': kind } : { 'data-build': kind, 'data-order': order };
}

/** The reading order of a drawing, for `data-order`. Each list is indexed like the drawing's own. */
export interface DrawingOrder {
  /** Bands (a lane, a floor), top to bottom, before any box. */
  bands: number[];
  /** Boxes by column, then top to bottom. */
  boxes: number[];
  /** Arrows by the box they leave, then the box they reach; from 0, so a line drawn after them takes `arrows.length`. A label takes its arrow's. */
  arrows: number[];
}

/**
 * The reading order of a drawing of bands, boxes in columns, and arrows between the boxes.
 * `col` and `row` only have to grow left to right and top to bottom; an arrow names its boxes
 * by their index in `boxes`.
 */
export function drawingOrder(
  bands: number,
  boxes: ReadonlyArray<{ col: number; row: number }>,
  arrows: ReadonlyArray<{ from: number; to: number }>,
): DrawingOrder {
  const box = places(boxes.map((b) => [b.col, b.row]));
  return {
    bands: Array.from({ length: bands }, (_, i) => i),
    boxes: box.map((p) => bands + p),
    arrows: places(arrows.map((a) => [box[a.from] ?? 0, box[a.to] ?? 0])),
  };
}

/** For each key, its place once the keys are sorted by their first number, then their second. */
function places(keys: ReadonlyArray<readonly [number, number]>): number[] {
  const sorted = keys.map((k, i) => ({ k, i })).sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.i - b.i);
  const place = new Array<number>(keys.length);
  sorted.forEach(({ i }, p) => (place[i] = p));
  return place;
}

/** The kinds a drawing orders among themselves, by their turn. */
const TURN_IN_DRAWING = new Map<PartKind, number>([
  ['shape', 0],
  ['line', 1],
  ['label', 2],
]);

interface Marked {
  el: Element;
  kind: PartKind;
  /** Its place in document order. */
  at: number;
  /** The SVG it is drawn in, for a shape, a line or a label. */
  drawing: Element | null;
}

/** The parts under `root`, `root` included, in the order they are drawn on. Nothing marked gives `[]`. */
export function buildParts(root: Element): BuildPart[] {
  const marked: Marked[] = [root, ...root.querySelectorAll('[data-build]')].flatMap((el, at) => {
    const kind = kindOf(el);
    return kind ? [{ el, kind, at, drawing: TURN_IN_DRAWING.has(kind) ? el.closest('svg') : null }] : [];
  });
  const drawings = new Map<Element, Marked[]>();
  for (const m of marked) {
    if (!m.drawing) continue;
    const group = drawings.get(m.drawing);
    if (group) group.push(m);
    else drawings.set(m.drawing, [m]);
  }

  const part = (m: Marked): BuildPart => ({ el: m.el, kind: m.kind, depth: depthOf(m.el, root), dashed: m.el.hasAttribute('data-dashed') });
  const out: BuildPart[] = [];
  const done = new Set<Element>();
  for (const m of marked) {
    if (!m.drawing) out.push(part(m));
    else if (!done.has(m.drawing)) {
      done.add(m.drawing);
      out.push(...drawings.get(m.drawing)!.sort(inDrawing).map(part));
    }
  }
  return out;
}

function inDrawing(a: Marked, b: Marked): number {
  const turn = TURN_IN_DRAWING.get(a.kind)! - TURN_IN_DRAWING.get(b.kind)!;
  if (turn !== 0) return turn;
  const oa = orderOf(a.el);
  const ob = orderOf(b.el);
  if (oa !== ob) return oa === undefined ? 1 : ob === undefined ? -1 : oa - ob;
  return a.at - b.at;
}

function kindOf(el: Element): PartKind | undefined {
  const v = el.getAttribute('data-build');
  return (PART_KINDS as readonly string[]).includes(v ?? '') ? (v as PartKind) : undefined;
}

function orderOf(el: Element): number | undefined {
  const v = el.getAttribute('data-order');
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function depthOf(el: Element, root: Element): number {
  let depth = 0;
  for (let a: Element | null = el; a && a !== root; ) {
    a = a.parentElement;
    if (a && kindOf(a) === 'frame') depth++;
  }
  return depth;
}
