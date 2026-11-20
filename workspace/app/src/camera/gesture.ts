/**
 * Safari's trackpad pinch on the camera: what one gesture event does to it, and the listeners
 * that hear it on the page.
 *
 * Adapted from Excalidraw (MIT licence, copyright 2020 Excalidraw), at commit 9fbeaed:
 * `onGestureStart`, `onGestureChange` and `onGestureEnd` in
 * packages/excalidraw/components/App.tsx, written again for our camera.
 */

import type { RefObject } from 'react';
import { useEffect } from 'react';
import type { Board } from '../board/context';
import type { BoardRect } from '../tools/types';
import type { Camera, CameraStore } from './camera';
import { zoomTo } from './camera';
import { laidOut } from './fit';

/**
 * The camera during a Safari trackpad pinch: the zoom at its start times the gesture's scale,
 * about `at` in board pixels. The scale is counted from the start of the gesture, so the zoom
 * never drifts from one change to the next.
 */
export function afterGesture(cam: Camera, startZoom: number, scale: number, at: readonly [number, number]): Camera {
  return zoomTo(cam, at[0], at[1], startZoom * scale);
}

/** Where a pinch zooms about, in board pixels: where the pointer last was over the board, else the board's middle. */
function pinchCentre(rect: BoardRect, pointer: { x: number; y: number } | null): [number, number] {
  if (pointer) return [pointer.x - rect.left, pointer.y - rect.top];
  return [rect.width / 2, rect.height / 2];
}

/** The scale a gesture event carries; only Safari makes them, so no type in the DOM's list has it. */
const scaleOf = (e: Event): number => {
  const scale: unknown = (e as Event & { scale?: unknown }).scale;
  return typeof scale === 'number' && Number.isFinite(scale) && scale > 0 ? scale : 1;
};

/**
 * Safari's trackpad pinch. Safari sends it as `gesturestart`, `gesturechange` and `gestureend`
 * (Chrome and Firefox send a wheel with Ctrl, which `useWheel` takes). A change carries a scale
 * and no centre, so the board zooms about where the pointer last was. The page's own zoom is
 * stopped wherever the pinch is; the board zooms only for a pinch that starts over it.
 */
export function useGesture(boardEl: RefObject<HTMLElement | null>, camera: CameraStore, rect: () => BoardRect, board: Pick<Board, 'pointer' | 'flushMoves'>): void {
  useEffect(() => {
    const el = boardEl.current;
    if (!el) return;
    /** The zoom when the pinch began; null when no pinch over the board is under way. */
    let startZoom: number | null = null;
    const start = (e: Event) => {
      e.preventDefault();
      startZoom = e.target instanceof Node && el.contains(e.target) ? camera.get().z : null;
    };
    const change = (e: Event) => {
      e.preventDefault();
      if (startZoom === null) return;
      board.flushMoves();
      camera.set(afterGesture(camera.get(), startZoom, scaleOf(e), pinchCentre(laidOut(rect()), board.pointer())));
    };
    const end = (e: Event) => {
      e.preventDefault();
      startZoom = null;
    };
    document.addEventListener('gesturestart', start, { passive: false });
    document.addEventListener('gesturechange', change, { passive: false });
    document.addEventListener('gestureend', end, { passive: false });
    return () => {
      document.removeEventListener('gesturestart', start);
      document.removeEventListener('gesturechange', change);
      document.removeEventListener('gestureend', end);
    };
  }, [boardEl, camera, rect, board]);
}
