/**
 * The minimap on the page: the board drawn small, and the presses and the wheel on it.
 *
 * Adapted from Excalidraw (MIT licence, copyright 2020 Excalidraw), at commit 9fbeaed: the
 * press handling of `MinimapController` (`onPointerDown`, `onPointerMove`, `moveViewport`,
 * `onWheel` and `unlockOnceSettled`) in
 * packages/excalidraw/components/Minimap/minimap-controller.chunk.ts. Changed for the board: a
 * press beside the view box glides there and is a drag only past the click slop, the map is
 * drawn by the page and not by a worker, and nothing limits how far the view can be dragged.
 */

import type { Box } from '@keel/protocol';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { CLICK_SLOP } from '../input/constants';
import type { BoardRect } from '../tools/types';
import type { Camera, CameraStore } from './camera';
import { unionBox, viewOf, zoomAt } from './camera';
import { laidOut } from './fit';
import type { MiniTransform } from './miniView';
import { MINI_H, MINI_W, cameraForGrab, grabAt, miniTransform, viewBoxOf } from './miniView';
import { wheelPixels, wheelZoom } from './wheel';

/** One item, as the minimap draws it. */
export interface MiniBox {
  box: Box;
  tone: 'owner' | 'owner-line' | 'agent';
}

/** A press in the minimap: the transform it froze, what it holds, and where it began. */
interface Drag {
  pointer: number;
  t: MiniTransform;
  /** The point of the view that stays under the pointer, in world units from the view's corner. */
  offset: readonly [number, number];
  /** The minimap's corner on the page, measured once as the press went down. */
  origin: readonly [number, number];
  from: readonly [number, number];
  /** True once it moves the view: at once on the view box, past the click slop elsewhere. */
  moving: boolean;
}

/** True when two lists draw the same: the same boxes, in the same tones, in the same order. */
function sameBoxes(a: readonly MiniBox[], b: readonly MiniBox[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i]!;
    return x.tone === y.tone && x.box.every((v, k) => v === y.box[k]);
  });
}

/** The items, drawn once in world units: only the transform of their layer changes as the camera moves. */
const MiniItems = memo(function MiniItems({ boxes }: { boxes: readonly MiniBox[] }) {
  return boxes.map(({ box: [x, y, w, h], tone }, i) => (
    <rect key={i} className={`mm-item mm-item--${tone}`} x={x} y={y} width={Math.max(0, w)} height={Math.max(0, h)} vectorEffect="non-scaling-stroke" />
  ));
});

/**
 * The minimap: the whole board small, and a box for what the board shows. A press on the box
 * drags it and keeps the point it grabbed under the pointer; a click elsewhere glides there; a
 * wheel zooms about the middle of the view.
 *
 * It renders only when the items change, never as the camera moves. The items are drawn once,
 * in world units, in a layer whose transform is written with the view box straight to the page
 * on each move, and only what changed is written: a pan moves the box by its transform and
 * costs the page no layout. During a drag the layer's transform is frozen, so the map does not
 * shift under the pointer, and only the view box moves.
 */
export const Minimap = memo(function Minimap({ boxes, camera, rect }: { boxes: readonly MiniBox[]; camera: CameraStore; rect: () => BoardRect }) {
  const root = useRef<HTMLDivElement>(null);
  const layer = useRef<SVGGElement>(null);
  const viewEl = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  /**
   * The transform the map is held at: from a press until its drag ends, and on after a click
   * until the glide it started has landed, so the view box goes where the owner clicked.
   */
  const held = useRef<MiniTransform | null>(null);
  /** What was last written to the page: the layer's transform, and the view box's place and size. Nothing is written twice. */
  const written = useRef({ layer: '', at: '', w: '', h: '' });
  const content = useMemo(() => unionBox(boxes.map((b) => b.box)), [boxes]);
  const contentNow = useRef(content);
  contentNow.current = content;

  const sizeNow = useCallback(() => {
    const r = laidOut(rect());
    return { w: r.width, h: r.height };
  }, [rect]);

  /** The transform the map is drawn with now: held while a drag or its glide lasts, else fitted to the content and the view. */
  const transformFor = useCallback(
    (cam: Camera) => {
      if (held.current && !drag.current && !camera.gliding()) held.current = null;
      return held.current ?? miniTransform(contentNow.current, viewOf(cam, sizeNow()));
    },
    [camera, sizeNow],
  );

  const draw = useCallback(
    (cam: Camera) => {
      const g = layer.current;
      const v = viewEl.current;
      if (!g || !v) return;
      const t = transformFor(cam);
      const b = viewBoxOf(viewOf(cam, sizeNow()), t);
      const was = written.current;
      const now = { layer: `matrix(${t.s} 0 0 ${t.s} ${t.tx} ${t.ty})`, at: `translate(${b.x}px, ${b.y}px)`, w: `${b.w}px`, h: `${b.h}px` };
      if (now.layer !== was.layer) g.setAttribute('transform', now.layer);
      // The box moves by its transform, which costs the page no layout. Its size changes only
      // with the zoom or the map's scale, and is written only then.
      if (now.at !== was.at) v.style.transform = now.at;
      if (now.w !== was.w) v.style.width = now.w;
      if (now.h !== was.h) v.style.height = now.h;
      written.current = now;
    },
    [transformFor, sizeNow],
  );

  useLayoutEffect(() => camera.onMove(draw), [camera, draw]);
  // New items can change the transform.
  useLayoutEffect(() => draw(camera.get()), [content, camera, draw]);
  useEffect(() => {
    const redraw = () => draw(camera.get());
    window.addEventListener('resize', redraw);
    return () => window.removeEventListener('resize', redraw);
  }, [camera, draw]);

  // A wheel over the minimap zooms about the middle of the view, and never pans. React's
  // onWheel is passive, and the page must not zoom.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // A drag holds the view to the pointer.
      if (drag.current) return;
      const [, dy] = wheelPixels(e, laidOut(rect()));
      if (!dy) return;
      const { w, h } = sizeNow();
      camera.set(zoomAt(camera.get(), w / 2, h / 2, wheelZoom(dy)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [camera, rect, sizeNow]);

  const local = (e: ReactPointerEvent, origin: readonly [number, number]): [number, number] => [e.clientX - origin[0], e.clientY - origin[1]];

  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || drag.current) return;
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const origin = [r.left + el.clientLeft, r.top + el.clientTop] as const;
    const at = local(e, origin);
    const size = sizeNow();
    const cam = camera.get();
    // The press is judged by the map as the owner sees it: still held, while the glide of an
    // earlier click runs.
    const t = transformFor(cam);
    const grab = grabAt(viewOf(cam, size), t, at);
    // Beside the box, the press holds the middle of the view the camera is going to.
    const goal = camera.goal();
    const far = viewOf(goal, size);
    const offset = grab.inside ? grab.offset : ([far[2] / 2, far[3] / 2] as const);
    drag.current = { pointer: e.pointerId, t, offset, origin, from: at, moving: grab.inside };
    held.current = t;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // The pointer is gone already: the drag ends with its up.
    }
    // The owner has the box in hand: a glide stops, or the box would slide from under the
    // pointer. A press beside it sends the view there, at the zoom the camera was going to.
    if (grab.inside) camera.stop();
    else camera.glide(cameraForGrab(t, offset, at, goal.z));
  };

  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointer) return;
    const at = local(e, d.origin);
    if (!d.moving) {
      if (Math.hypot(at[0] - d.from[0], at[1] - d.from[1]) <= CLICK_SLOP) return;
      d.moving = true;
    }
    // At the zoom the camera is going to: the first move of a press beside the box takes over
    // from that press's glide, and keeps its zoom.
    camera.set(cameraForGrab(d.t, d.offset, at, camera.goal().z));
  };

  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer !== e.pointerId) return;
    drag.current = null;
    draw(camera.get());
  };

  return (
    <div
      ref={root}
      className="chrome minimap"
      data-testid="minimap"
      data-viewport-ui="bottom"
      role="img"
      aria-label={`Minimap: ${boxes.length} ${boxes.length === 1 ? 'item' : 'items'}. Click to go there.`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
    >
      <svg className="mm-items" width={MINI_W} height={MINI_H} aria-hidden="true">
        <g ref={layer}>
          <MiniItems boxes={boxes} />
        </g>
      </svg>
      <div ref={viewEl} className="mm-view" data-testid="minimap-view" />
    </div>
  );
}, sameMap);

/** The minimap draws the same for these props: a board event that moved nothing hands it a new list of the same boxes. */
function sameMap(a: { boxes: readonly MiniBox[]; camera: CameraStore; rect: () => BoardRect }, b: { boxes: readonly MiniBox[]; camera: CameraStore; rect: () => BoardRect }): boolean {
  return a.camera === b.camera && a.rect === b.rect && sameBoxes(a.boxes, b.boxes);
}
