/**
 * The wheel on the camera: what one wheel event does to it, and the listeners that hear it on
 * the page. A trackpad's two-finger scroll, and its pinch in Chrome and Firefox, are wheel
 * events too.
 *
 * Adapted from Excalidraw (MIT licence, copyright 2020 Excalidraw), at commit 9fbeaed:
 * `AppWheel.handle`, `zoomBy` and `preventBrowserZoom` in
 * packages/excalidraw/components/App.wheel.ts, for `afterWheel`, `wheelZoom` and the listeners.
 * Changed for the board: the zoom multiplies, and deltas in lines and pages are read.
 */

import type { RefObject } from 'react';
import { useEffect } from 'react';
import type { Board } from '../board/context';
import { WHEEL_LINE, WHEEL_MAX_ZOOM_DELTA, WHEEL_ZOOM_RATE } from '../input/constants';
import type { BoardRect } from '../tools/types';
import type { Camera, CameraStore } from './camera';
import { zoomAt } from './camera';
import { laidOut } from './fit';

/** What the camera needs of a wheel event. A trackpad's two-finger scroll and its pinch arrive as wheel events too. */
export interface Wheel {
  deltaX: number;
  deltaY: number;
  /** What the deltas count: 0 pixels, 1 lines, 2 pages. */
  deltaMode: number;
  /** Page pixels. */
  clientX: number;
  clientY: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/**
 * A wheel's deltas in pixels. A line is `WHEEL_LINE`; a page is the board's width across and
 * its height down. The deltas are read before the mode: Firefox reports pixels to a page that
 * reads them first.
 */
export function wheelPixels(e: Wheel, rect: BoardRect): [dx: number, dy: number] {
  const { deltaX, deltaY } = e;
  if (e.deltaMode === 1) return [deltaX * WHEEL_LINE, deltaY * WHEEL_LINE];
  if (e.deltaMode === 2) return [deltaX * rect.width, deltaY * rect.height];
  return [deltaX, deltaY];
}

/** How much one wheel event zooms by: its delta is cut to `WHEEL_MAX_ZOOM_DELTA` either way, so at most 10.5%. */
export function wheelZoom(deltaY: number): number {
  const cut = Math.max(-WHEEL_MAX_ZOOM_DELTA, Math.min(WHEEL_MAX_ZOOM_DELTA, deltaY));
  return Math.exp(-cut * WHEEL_ZOOM_RATE);
}

/**
 * The camera after one wheel event over the board, or `cam` itself when it does not move.
 *
 * - With Ctrl or Cmd it zooms about the pointer (a trackpad pinch arrives this way).
 * - Shift turns a vertical wheel into a sideways pan (a Mac often sends Shift and the wheel as
 *   a sideways delta already); with Ctrl or Cmd as well, it pans up and down.
 * - A wheel that only moves sideways never zooms: it pans.
 * - Otherwise it pans by both deltas, each event as it comes, so a trackpad's glide after the
 *   fingers lift is kept.
 */
export function afterWheel(cam: Camera, e: Wheel, rect: BoardRect): Camera {
  const [dx, dy] = wheelPixels(e, rect);
  if (!dx && !dy) return cam;
  const zoomKey = e.ctrlKey || e.metaKey;
  if (dy !== 0 && zoomKey && !e.shiftKey) return zoomAt(cam, e.clientX - rect.left, e.clientY - rect.top, wheelZoom(dy));
  if (e.shiftKey) {
    const d = dy || dx;
    return zoomKey ? { ...cam, y: cam.y - d } : { ...cam, x: cam.x - d };
  }
  return { ...cam, x: cam.x - dx, y: cam.y - dy };
}

/**
 * The owner's hand on the camera, on the page:
 *
 * - The wheel over the board moves the camera, and the page never scrolls or zooms under it.
 *   Moves of a press that wait for their frame land first, so a wheel during a drag adds to it.
 * - Over the panels the page keeps its wheel (a panel scrolls), but a Ctrl or Cmd wheel is
 *   stopped there too, so the browser never zooms the whole page.
 * - A press on the board stops a glide where it is.
 */
export function useWheel(boardEl: RefObject<HTMLElement | null>, camera: CameraStore, rect: () => BoardRect, board: Pick<Board, 'flushMoves'>): void {
  useEffect(() => {
    const el = boardEl.current;
    if (!el) return;
    // React's onWheel is passive; the board needs preventDefault.
    const onBoard = (e: WheelEvent) => {
      e.preventDefault();
      // An event with no deltas does nothing at all, and does not stop a glide.
      if (!e.deltaX && !e.deltaY) return;
      board.flushMoves();
      camera.set(afterWheel(camera.get(), e, laidOut(rect())));
    };
    const onPage = (e: WheelEvent) => {
      if ((e.ctrlKey || e.metaKey) && !(e.target instanceof Node && el.contains(e.target))) e.preventDefault();
    };
    const onPress = () => camera.stop();
    el.addEventListener('wheel', onBoard, { passive: false });
    window.addEventListener('wheel', onPage, { passive: false });
    el.addEventListener('pointerdown', onPress, true);
    return () => {
      el.removeEventListener('wheel', onBoard);
      window.removeEventListener('wheel', onPage);
      el.removeEventListener('pointerdown', onPress, true);
    };
  }, [boardEl, camera, rect, board]);
}
