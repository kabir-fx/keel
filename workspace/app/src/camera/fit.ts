/**
 * Fitting the camera to things on the board, clear of the panels: the room the panels leave
 * free, measured from the panels themselves, and the fits and zooms that use it.
 *
 * Adapted from Excalidraw (MIT licence, copyright 2020 Excalidraw), at commit 9fbeaed:
 * `getOffsets` and `measureSide` in packages/excalidraw/components/App.viewport.ts, for
 * `freeArea` and `measurePanels`. Changed for the board: a panel says where it sits (the top,
 * the bottom, a side), a side panel that reaches past the middle is weighed both ways, and the
 * room has a smallest size.
 */

import type { Box, BoardState, Id } from '@keel/protocol';
import type { RefObject } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FIT_MARGIN, FIT_MIN_ROOM, GLIDE_MS } from '../input/constants';
import type { BoardSource } from '../source';
import type { BoardRect } from '../tools/types';
import type { CameraStore } from './camera';
import { fitBox, unionBox, zoomAt } from './camera';

/** Room the focus view keeps clear at the top: under the board pill and the crumb, which shows only once the view is open. */
export const FOCUS_TOP = 148;

/**
 * Where a panel sits over the board, as its `data-viewport-ui` attribute says: along the top,
 * along the bottom, or down one side. A fit keeps clear of every panel on the page.
 */
export type Dock = 'top' | 'bottom' | 'side';

/** A panel over the board, in board pixels. */
export interface Panel {
  dock: Dock;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The board's place on the page, with a size: a board that is not laid out (a test page has
 * no layout) is taken to fill the window.
 */
export function laidOut(rect: BoardRect): BoardRect {
  if (rect.width > 0 && rect.height > 0) return rect;
  return { left: rect.left, top: rect.top, width: window.innerWidth, height: window.innerHeight };
}

/** How far the panels cover a board in from each of its edges, in board pixels. */
interface Insets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** The insets with one edge covered at least `reach` in. */
const covered = (insets: Insets, edge: keyof Insets, reach: number): Insets => ({ ...insets, [edge]: Math.max(insets[edge], reach) });

/** What the insets leave of a board of this size, less `margin` all round. A side is negative when nothing is left. */
function roomIn(size: { w: number; h: number }, insets: Insets, margin: number): Box {
  const x = insets.left + margin;
  const y = insets.top + margin;
  return [x, y, size.w - insets.right - margin - x, size.h - insets.bottom - margin - y];
}

/** True when a room is one a fit can use: `FIT_MIN_ROOM` or more each way. */
const leavesRoom = ([, , w, h]: Box): boolean => w >= FIT_MIN_ROOM && h >= FIT_MIN_ROOM;

/**
 * A room made no smaller than `FIT_MIN_ROOM` a side, and slid back inside the board where that
 * pushed it past an edge. On a board smaller than that, the room is the board.
 */
function floored(size: { w: number; h: number }, [x, y, w, h]: Box): Box {
  const fw = Math.min(size.w, Math.max(FIT_MIN_ROOM, w));
  const fh = Math.min(size.h, Math.max(FIT_MIN_ROOM, h));
  return [Math.max(0, Math.min(x, size.w - fw)), Math.max(0, Math.min(y, size.h - fh)), fw, fh];
}

/**
 * The part of a board of this size that the panels leave free, less `margin` all round.
 *
 * - A top panel covers the board down to its bottom edge, a bottom one up from its top edge.
 * - A side panel covers the board from the side its middle is on, to its far edge.
 * - A side panel that reaches past the middle of the board (a narrow window) leaves a room
 *   beside it and a room below it: the larger one is taken. When neither is a room a fit can
 *   use, the panel is left out: it covers the board, and nothing can be kept clear of it.
 * - A panel with no size (one the page hides) covers nothing.
 * - The room is never smaller than `FIT_MIN_ROOM` a side, and never reaches past the board.
 */
export function freeArea(size: { w: number; h: number }, panels: readonly Panel[], margin = FIT_MARGIN): Box {
  let insets: Insets = { top: 0, bottom: 0, left: 0, right: 0 };
  /** The side panels that reach past the middle: the edge each is on, how far it reaches in, and its bottom edge. */
  const wide: Array<{ edge: 'left' | 'right'; reach: number; bottom: number }> = [];
  for (const p of panels) {
    if (p.right <= p.left || p.bottom <= p.top) continue;
    if (p.dock === 'top') insets = covered(insets, 'top', p.bottom);
    else if (p.dock === 'bottom') insets = covered(insets, 'bottom', size.h - p.top);
    else {
      const edge = (p.left + p.right) / 2 < size.w / 2 ? 'left' : 'right';
      const reach = edge === 'left' ? p.right : size.w - p.left;
      if (reach > size.w / 2) wide.push({ edge, reach, bottom: p.bottom });
      else insets = covered(insets, edge, reach);
    }
  }
  // Weighed last, so each choice knows what every other panel covers.
  const area = (i: Insets) => {
    const [, , w, h] = roomIn(size, i, margin);
    return w * h;
  };
  for (const p of wide) {
    const ways = [covered(insets, p.edge, p.reach), covered(insets, 'top', p.bottom)].filter((i) => leavesRoom(roomIn(size, i, margin)));
    if (ways.length > 0) insets = ways.reduce((best, way) => (area(way) > area(best) ? way : best));
  }
  return floored(size, roomIn(size, insets, margin));
}

const DOCKS: ReadonlySet<string> = new Set<Dock>(['top', 'bottom', 'side']);

/** Every panel on the page that says where it sits, in board pixels. This reads the page layout. */
export function measurePanels(rect: BoardRect): Panel[] {
  const panels: Panel[] = [];
  for (const el of document.querySelectorAll<HTMLElement>('[data-viewport-ui]')) {
    const dock = el.dataset.viewportUi ?? '';
    if (!DOCKS.has(dock)) continue;
    const r = el.getBoundingClientRect();
    panels.push({ dock: dock as Dock, left: r.left - rect.left, top: r.top - rect.top, right: r.right - rect.left, bottom: r.bottom - rect.top });
  }
  return panels;
}

/** The part of the board the panels leave free, measured now. This reads the page layout. */
export function measureRoom(rect: BoardRect): Box {
  const r = laidOut(rect);
  return freeArea({ w: r.width, h: r.height }, measurePanels(r));
}

/**
 * Where an item is drawn, at the size it is drawn now. A picture's stored box can be older than
 * the picture: it grows when its chapter builds, or once its fonts are in. A fit uses the size
 * on screen, so nothing it shows ends under the toolbar or a panel. This reads the page layout.
 */
export function drawnBox(id: Id, boxes: ReadonlyMap<Id, Box>, state: BoardState, layer: HTMLElement | null): Box | undefined {
  const b = boxes.get(id);
  if (!b || state.items[id]?.item.kind !== 'picture') return b;
  const el = layer?.querySelector<HTMLElement>(`[data-item="${id}"]`);
  const w = el?.offsetWidth ?? 0;
  const h = el?.offsetHeight ?? 0;
  return w > 0 && h > 0 ? [b[0], b[1], w, h] : b;
}

/** Fitting the camera to things on the board. */
export interface Fit {
  /** The part of the board the panels leave free, in board pixels, measured from the page now. For a fit: one move of the owner's. */
  room(): Box;
  /**
   * The same, as it was last measured: read from memory, for what asks on every frame of a camera
   * move and must not read the page. It can miss a panel that came or went since with no render
   * of the board.
   */
  roomKept(): Box;
  /** Glide to these items, or the whole board, and any extra boxes, in the free room. `ms` is how long the glide takes. */
  fitTo(ids?: readonly Id[], extra?: readonly Box[], ms?: number): void;
  /**
   * The same fit, made once the page has drawn what this turn changed. For a fit asked for in
   * the turn that moves a panel (leaving the focus view unfolds the build): its room is then
   * measured with the panels where they will stay.
   */
  fitAfterRender(ids?: readonly Id[], extra?: readonly Box[], ms?: number): void;
  /** The latest `fitTo`, for a callback that must not change when it does. */
  fitToRef: RefObject<Fit['fitTo']>;
  /** Zoom by a factor about the middle of the board, from where the camera is going. */
  zoomBy(factor: number): void;
}

/**
 * The camera moves that show the owner something: fit and zoom, clear of the panels. The free
 * room is measured from the panels themselves each time a fit asks for it: a panel may come or
 * go with no render of the board (the hint line hears the agent for itself), and a fit is one
 * move of the owner's. What asks on every frame reads the last measure instead, which a render
 * of the board throws away.
 *
 * What it answers with is the same object on every render, and each function of it works from
 * the board as it is when called: a part of the chrome that is handed it never renders again
 * for it, and a callback that kept it is never out of date.
 */
export function useFit(camera: CameraStore, source: BoardSource, layer: RefObject<HTMLElement | null>, boxes: ReadonlyMap<Id, Box>, rect: () => BoardRect): Fit {
  /** The room as last measured. Any render may have opened, folded or moved a panel, and the board renders when the window changes size: each throws it away. */
  const measured = useRef<Box | null>(null);
  useLayoutEffect(() => {
    measured.current = null;
  });
  const room = useCallback((): Box => (measured.current = measureRoom(rect())), [rect]);
  const roomKept = useCallback((): Box => measured.current ?? room(), [room]);

  /** Where things are as of the latest render. */
  const boxesNow = useRef(boxes);
  boxesNow.current = boxes;

  const fitTo = useCallback(
    (ids?: readonly Id[], extra: readonly Box[] = [], ms: number = GLIDE_MS) => {
      const now = boxesNow.current;
      const drawn = (id: Id) => drawnBox(id, now, source.state, layer.current);
      const every = () => [...now.keys()].map(drawn).filter((b): b is Box => !!b);
      const list = ids?.length ? ids.map(drawn).filter((b): b is Box => !!b) : every();
      const all = unionBox([...(list.length ? list : every()), ...extra]);
      if (all) camera.glide(fitBox(all, room(), 1), ms);
    },
    [camera, room, source, layer],
  );
  const fitToRef = useRef(fitTo);
  fitToRef.current = fitTo;

  /** A fit that waits for the next render to be on the page. */
  const waiting = useRef<Parameters<Fit['fitTo']> | null>(null);
  const [, renderAgain] = useState(0);
  useEffect(() => {
    const args = waiting.current;
    if (!args) return;
    waiting.current = null;
    fitTo(...args);
  });
  const fitAfterRender = useCallback((...args: Parameters<Fit['fitTo']>) => {
    waiting.current = args;
    renderAgain((n) => n + 1);
  }, []);

  const zoomBy = useCallback(
    (factor: number) => {
      const r = laidOut(rect());
      const goal = camera.goal();
      const next = zoomAt(goal, r.width / 2, r.height / 2, factor);
      // At a limit there is nowhere to go: a glide on its way there carries on as it was.
      if (next !== goal) camera.glide(next);
    },
    [camera, rect],
  );

  return useMemo(() => ({ room, roomKept, fitTo, fitAfterRender, fitToRef, zoomBy }), [room, roomKept, fitTo, fitAfterRender, zoomBy]);
}
