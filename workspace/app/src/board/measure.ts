import type { Anchor, BoardState, Box, Id, Item, ItemKind, ItemState, Target } from '@keel/protocol';
import { liveItems } from '@keel/protocol';
import type { RefObject } from 'react';
import type { Camera, CameraStore } from '../camera/camera';
import { arrowLines } from '../arrowhead';
import { LINE_KINDS, measureTargets, skipLines, targetAt } from '../dom';
import type { TargetRect } from '../geometry';
import { bboxOf, distToPath, enclosedShare, inBox, padBox, pairs, wholeBox } from '../geometry';
import { inkWidth, PEN } from '../ink/ink';
import { LINE_SLOP } from '../input/constants';
import { linePoints } from '../items';
import { markScale, pointOn } from '../layout';
import { ARROW_LINE, BOX_LINE, LASSO_LINE, pinIcon } from '../markSizes';
import { loopsBox } from '../outline';
import type { Hit } from '../select/hit';
import { distToOutline, KIND_LAYER, rankHits } from '../select/hit';
import type { BoardSource } from '../source';
import type { BoardCtx, BoardRect } from '../tools/types';
import type { Ends, Outline, Shown } from './shown';

/**
 * Measuring the board for a gesture: what a mark can point at, what lies under a point. The
 * functions that take an element read the page layout, so a gesture calls them once, not once
 * a sample.
 */

/** In the focus view only what is above the dim can be pointed at: its ids, or undefined when no focus is open. */
type Raised = ReadonlySet<Id> | undefined;

/** The line marks as they are drawn in this render. */
export interface Lines {
  live: readonly ItemState[];
  boxes: ReadonlyMap<Id, Box>;
  ends: ReadonlyMap<Id, Ends>;
  outlines: ReadonlyMap<Id, Outline>;
  raised: Raised;
}

/** What the pen and the pointer can point at: every item with a box in the DOM, and its subs. */
export function measureItems(layer: HTMLElement | null, board: HTMLElement | null, cam: Camera, state: BoardState, raised: Raised): TargetRect[] {
  if (!layer || !board) return [];
  return measureTargets(layer, board, cam, skipLines).filter((r) => {
    const s = state.items[r.item];
    return !!s && !s.removed && (!raised || raised.has(r.item));
  });
}

/** What a lasso can hold: `rects`, and the line marks too (a sketch, a pin), by where they are drawn. */
export function withLineMarks(rects: TargetRect[], state: BoardState, boxes: ReadonlyMap<Id, Box>, raised: Raised): TargetRect[] {
  for (const s of liveItems(state)) {
    if (!LINE_KINDS.has(s.item.kind) || s.item.kind === 'lasso') continue;
    if (raised && !raised.has(s.item.id)) continue;
    const b = boxes.get(s.item.id);
    if (!b) continue;
    const box: Box = s.item.kind === 'pin' ? pinIcon(b, s.item.at) : b;
    rects.push({ id: s.item.id, item: s.item.id, box });
  }
  return rects;
}

/** Where a sub is drawn now, in world units: measured inside its item, and counted from the item's own box `base`. */
export function subBoxFromDom(itemEl: HTMLElement, sub: string, base: Box | undefined, z: number): Box | undefined {
  const subEl = itemEl.querySelector<HTMLElement>(`[data-sub="${sub}"]`);
  if (!base || !subEl) return undefined;
  const ir = itemEl.getBoundingClientRect();
  const sr = subEl.getBoundingClientRect();
  return [base[0] + (sr.left - ir.left) / z, base[1] + (sr.top - ir.top) / z, sr.width / z, sr.height / z];
}

/**
 * How a press at a world point lands on a mark drawn as a line, or on a box the owner drew:
 * squarely on its line, only near it (within the slop, `LINE_SLOP` screen pixels), or not at all.
 * A drawn box is hit on its line only, so a press inside it reaches what it was drawn round. An
 * arrow is hit on its line and on the two sides of its head. Points inside a mark are counted
 * from its box. `z` is the zoom.
 */
export function lineHit(lines: Lines, it: Item, z: number, wx: number, wy: number): 'square' | 'near' | undefined {
  const shown = lines.boxes.get(it.id);
  if (!shown) return undefined;
  const slop = LINE_SLOP / z;
  const within = (d: number, half: number) => (d <= half ? 'square' : d <= half + slop ? 'near' : undefined);
  if (it.kind === 'ink') {
    if (!inBox(wx, wy, [shown[0] - slop * 4, shown[1] - slop * 4, shown[2] + slop * 8, shown[3] + slop * 8])) return undefined;
    const [sx, sy] = markScale(it.box, shown);
    let best: 'square' | 'near' | undefined;
    for (const s of it.strokes) {
      const width = inkWidth(s.w ?? PEN.size, sx, sy);
      const d = distToPath(wx, wy, pairs(s.pts).map((p) => pointOn(p, it.box, shown)));
      // The reach of a stroke is its whole width past its middle, as it always was.
      const got = d <= width / 2 ? 'square' : d <= slop + width ? 'near' : undefined;
      if (got === 'square') return got;
      best ??= got;
    }
    return best;
  }
  if (it.kind === 'arrow') {
    const [from, to] = linePoints(it, shown, lines.ends.get(it.id)) as [[number, number], [number, number]];
    return within(Math.min(...arrowLines(from, to).map((line) => distToPath(wx, wy, line))), ARROW_LINE / 2 / z);
  }
  if (it.kind === 'lasso') {
    const loops = lines.outlines.get(it.id)?.loops ?? [];
    const d = Math.min(...loops.map((l) => distToPath(wx, wy, [...l, l[0]!])));
    return within(d, LASSO_LINE / 2 / z);
  }
  if (it.kind === 'box') return within(distToOutline(wx, wy, padBox(shown, -BOX_LINE / 2)), BOX_LINE / 2);
  return undefined;
}

/** The kinds that are hit through the page: what the browser finds under the pointer. The rest are lines, and a drawn box is hit on its line. */
const HIT_ON_PAGE: ReadonlySet<ItemKind> = new Set(['picture', 'note', 'file', 'voice', 'pin']);

/**
 * What a press lands on: the item the browser found under the pointer (`target`), and every
 * mark drawn as a line, and box the owner drew, near the world point, ranked by the order the
 * board stacks them in (`rankHits`). The browser's own find is the topmost item it draws with a
 * press: one below it can never come first, so the others it would find are not asked for.
 */
export function hitAt(lines: Lines, z: number, target: Element | null, wx: number, wy: number): Id | undefined {
  const { live, raised } = lines;
  const hits: Hit[] = [];
  const onPage = target?.closest<HTMLElement>('[data-item]')?.dataset.item;
  live.forEach((s, order) => {
    const it = s.item;
    if (raised && !raised.has(it.id)) return;
    const layer = KIND_LAYER[it.kind];
    if (HIT_ON_PAGE.has(it.kind)) {
      if (it.id === onPage) hits.push({ id: it.id, layer, order, square: true });
      return;
    }
    const got = lineHit(lines, it, z, wx, wy);
    if (got) hits.push({ id: it.id, layer, order, square: got === 'square' });
  });
  return rankHits(hits);
}

/** The kinds drawn in a frame of their own on the page: their size is the frame's. */
const FRAMED: ReadonlySet<ItemKind> = new Set(['picture', 'note', 'file', 'voice', 'box']);

/**
 * Where an item is drawn, at the size it is drawn, in world units: what the line round it goes
 * round. A thing in a frame is as big as its frame (`size`, when it was measured, else its box);
 * ink reaches half a line past its points; an arrow runs between its ends, with its head; a pin
 * is its icon.
 */
export function outlineOf(it: Item, shown: Box, ends: Ends | undefined, size?: readonly [number, number]): Box {
  if (FRAMED.has(it.kind)) return size ? [shown[0], shown[1], size[0], size[1]] : shown;
  if (it.kind === 'ink') {
    const [sx, sy] = markScale(it.box, shown);
    return padBox(shown, inkWidth(Math.max(PEN.size, ...it.strokes.map((s) => s.w ?? PEN.size)), sx, sy) / 2);
  }
  if (it.kind === 'arrow') {
    const [from, to] = linePoints(it, shown, ends) as [[number, number], [number, number]];
    return bboxOf(arrowLines(from, to).flat());
  }
  if (it.kind === 'pin') return pinIcon(shown, it.at);
  return shown;
}

/**
 * What a click lands on, for a note: a thing in the DOM under the page point, else a lasso's
 * outline round the world point. `boxIn` says where a target is drawn now, given the element
 * its item is drawn in.
 */
export function noteTargetAt(
  lines: Lines,
  state: BoardState,
  boxIn: (itemEl: HTMLElement, t: Target) => Box | undefined,
  client: readonly [number, number],
  world: readonly [number, number],
): { on?: Target; anchor?: Anchor } {
  const hit = targetAt(client[0], client[1]);
  if (hit && state.items[hit.item] && !LINE_KINDS.has(state.items[hit.item]!.item.kind)) {
    const on: Target = hit.sub ? { item: hit.item, sub: hit.sub } : { item: hit.item };
    const box = boxIn(hit.el, on);
    return box ? { on, anchor: { ...on, box: wholeBox(box) } } : { on };
  }
  const { live, outlines, raised } = lines;
  for (let i = live.length - 1; i >= 0; i--) {
    const it = live[i]!.item;
    if (it.kind !== 'lasso' || (raised && !raised.has(it.id))) continue;
    const loops = outlines.get(it.id)?.loops ?? [];
    const b = loopsBox(loops);
    if (b && loops.some((l) => enclosedShare([world[0], world[1], 0, 0], l) > 0)) return { anchor: { item: it.id, box: wholeBox(b) } };
  }
  return {};
}

/** The page a board is drawn on, as measuring needs it. */
export interface Page {
  /** The board's element, and the element its items are drawn in. */
  board: RefObject<HTMLElement | null>;
  layer: RefObject<HTMLElement | null>;
  camera: CameraStore;
  source: BoardSource;
  /** The board's place on the page, from memory. */
  rect(): BoardRect;
}

/** The measuring half of the board's context. */
export type Measuring = Pick<BoardCtx, 'rect' | 'toBoard' | 'toWorld' | 'itemEl' | 'hitAt' | 'reachable' | 'measure' | 'measureAll' | 'outlines' | 'targetBox' | 'noteTarget'>;

/** The measuring half of the board's context, for one render: it measures the board as that render drew it. */
export function measuringOf(page: Page, shown: Shown, raised: Raised): Measuring {
  const { camera, source } = page;
  const lines: Lines = { live: shown.live, boxes: shown.boxes, ends: shown.ends, outlines: shown.outlines, raised };

  const toBoard = (clientX: number, clientY: number): [number, number] => {
    const r = page.rect();
    return [clientX - r.left, clientY - r.top];
  };
  const toWorld = (clientX: number, clientY: number): [number, number] => {
    const [x, y] = toBoard(clientX, clientY);
    const cam = camera.get();
    return [(x - cam.x) / cam.z, (y - cam.y) / cam.z];
  };
  const itemEl = (id: Id) => page.layer.current?.querySelector<HTMLElement>(`[data-item="${id}"]`) ?? undefined;
  /** Where a target is drawn now, measured the same way the board draws anchored marks. */
  const boxIn = (el: HTMLElement, t: Target) => (t.sub ? subBoxFromDom(el, t.sub, shown.stored(t.item), camera.get().z) : shown.boxes.get(t.item));
  const targetBox = (t: Target) => {
    if (!t.sub) return shown.boxes.get(t.item);
    const el = itemEl(t.item);
    return el ? boxIn(el, t) : undefined;
  };
  const measure = () => measureItems(page.layer.current, page.board.current, camera.get(), source.state, raised);
  const reachable = (id: Id) => !raised || raised.has(id);
  const outlines = () => {
    const out = new Map<Id, Box>();
    for (const s of shown.live) {
      const b = shown.boxes.get(s.item.id);
      if (!b || !reachable(s.item.id)) continue;
      const el = FRAMED.has(s.item.kind) ? itemEl(s.item.id) : undefined;
      out.set(s.item.id, outlineOf(s.item, b, shown.ends.get(s.item.id), el && el.offsetWidth > 0 ? [el.offsetWidth, el.offsetHeight] : undefined));
    }
    return out;
  };

  return {
    rect: page.rect,
    toBoard,
    toWorld,
    itemEl,
    reachable,
    measure,
    measureAll: () => withLineMarks(measure(), source.state, shown.boxes, raised),
    outlines,
    targetBox,
    hitAt: (target, wx, wy) => hitAt(lines, camera.get().z, target, wx, wy),
    noteTarget: (clientX, clientY) => noteTargetAt(lines, source.state, boxIn, [clientX, clientY], toWorld(clientX, clientY)),
  };
}
