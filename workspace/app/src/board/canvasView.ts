import type { BoardState, Box, CanvasWork, HomeInfo, Id, ItemState, ShowInfo } from '@keel/protocol';
import { canvasBuilds } from '@keel/protocol';
import type { BuildPlace } from '@keel/pictures';
import type { RefObject } from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { Camera, CameraStore } from '../camera/camera';
import type { Fit } from '../camera/fit';
import type { Elsewhere, Seen } from '../canvases';
import { elsewhere } from '../canvases';
import { quoted, runningOf } from '../tryit';
import type { Focus } from './focusView';

/**
 * The Board view shows one canvas (record 0014). These are the board's side of that: what
 * happens when another canvas comes into view, what happened on the ones out of view, and
 * where a build on the one in view goes.
 */

/** What changing the canvas in view needs of the render it runs in. */
export interface CanvasInViewNeeds {
  canvas: Id | undefined;
  camera: CameraStore;
  /** Where the camera was on each canvas the owner left. */
  cameras: RefObject<Map<Id, Camera>>;
  fitted: RefObject<boolean>;
  /** The pictures that are no news: those of a canvas that comes into view join them. */
  known: RefObject<Set<Id> | null>;
  live: readonly ItemState[];
  boxes: ReadonlyMap<Id, Box>;
  fit: Fit;
  viewport: { w: number; h: number };
  focus: Focus;
  select(): void;
}

/**
 * Another canvas comes into view: the focus view and the selection go, its camera comes back as
 * the owner left it, else it is fitted, else (blank) it is set where a first note goes. What is
 * already on it is no news.
 */
export function useCanvasInView({ canvas, camera, cameras, fitted, known, live, boxes, fit, viewport, focus, select }: CanvasInViewNeeds): void {
  const shown = useRef(canvas);
  useLayoutEffect(() => {
    if (shown.current === canvas) return;
    shown.current = canvas;
    for (const s of live) if (s.item.kind === 'picture') known.current?.add(s.item.id);
    if (!fitted.current) return;
    focus.close();
    focus.stopOpening();
    select();
    const kept = canvas ? cameras.current.get(canvas) : undefined;
    if (kept) camera.set(kept);
    else if (boxes.size > 0) fit.fitTo();
    else camera.set({ x: Math.round(viewport.w / 2 - 400), y: 200, z: 1 });
    camera.land();
  });
}

/** What happened on the canvases out of view since the owner last had each one in view. */
export function useElsewhere(whole: BoardState, canvas: Id | undefined): Elsewhere[] {
  const seen = useRef(new Map<Id, Seen>());
  const seenOf = (id: Id): Seen => {
    let s = seen.current.get(id);
    if (!s) seen.current.set(id, (s = { seq: whole.seq, at: new Date().toISOString() }));
    return s;
  };
  // The canvas in view is seen now, and again with every change while it stays in view.
  useEffect(() => {
    if (canvas) seen.current.set(canvas, { seq: whole.seq, at: new Date().toISOString() });
  }, [canvas, whole]);
  return useMemo(() => elsewhere(whole, canvas, seenOf), [whole, canvas]);
}

/**
 * Where a build on the canvas in view goes, for the blueprint, with the ideas on other canvases
 * it will not have: whether each one's show runs, and why it cannot be tried while the server
 * is busy with its branch. The same value while nothing in it changes.
 */
export function useBuildPlace(
  whole: BoardState,
  canvas: Id | undefined,
  home: HomeInfo | undefined,
  works: ReadonlyMap<string, CanvasWork>,
  shows: ReadonlyMap<string, ShowInfo>,
): BuildPlace | undefined {
  const branch = canvas ? works.get(canvas)?.branch : undefined;
  const waiting = whole.canvasOrder.flatMap((id) => {
    if (id === canvas) return [];
    const busy = works.get(id)?.busy;
    return canvasBuilds(whole, id).waiting.map((c) => ({
      chapter: c.id,
      title: c.title,
      ...(runningOf(shows.get(c.id)) ? { running: true as const } : {}),
      ...(busy ? { held: `${quoted([c.title])} can be tried once ${busy === 'building' ? 'the builder' : 'the board'} is done with its canvas.` } : {}),
    }));
  });
  const key = JSON.stringify([home?.branch, home?.commit, branch, waiting]);
  return useMemo(() => {
    if (!home && !branch && waiting.length === 0) return undefined;
    return { ...(home ? { home: { branch: home.branch, ...(home.commit ? { commit: home.commit } : {}) } } : {}), ...(branch ? { branch } : {}), waiting };
  }, [key]);
}
