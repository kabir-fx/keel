import type { RefObject } from 'react';
import { useLayoutEffect } from 'react';
import type { Camera, CameraStore } from './camera';
import { MAX_ZOOM } from './camera';

/** The ground's grid of dots is this far apart, in world units. */
const GRID = 24;

/** How far the ground reaches past each edge of the board, in screen pixels: one cell at the largest zoom, so it can slide by up to a whole cell. */
const GROUND_REACH = GRID * MAX_ZOOM;

/**
 * Where the ground is drawn for a camera: its cell size on screen, and how far it is slid. The
 * ground starts `GROUND_REACH` before the board's corner and slides by less than a cell, so
 * its dots sit where the camera puts them and it always covers the board.
 */
export function groundAt(cam: Camera): { cell: number; x: number; y: number } {
  const cell = GRID * cam.z;
  const slide = (v: number) => (((v + GROUND_REACH) % cell) + cell) % cell;
  return { cell, x: slide(cam.x), y: slide(cam.y) };
}

/**
 * Write the camera to the page: the world's transform, and the ground's grid under it. It is
 * written straight to the elements on every move of the camera, so a pan or a zoom never
 * renders the board again. The ground moves by its transform; its cell size and the zoom
 * variable change only when the zoom does.
 *
 * Measured with the bench and kept out: the ground on a layer of its own (`will-change`) cost
 * the zoom 12 to 50 dropped frames a run; `will-change` on the world while it zooms cost the
 * zoom 2 ms of main thread a frame for one or two frames saved; the world's translate snapped
 * to device pixels made text no sharper at 150% and 400%.
 *
 * It also shows how the owner's hand holds the camera, for the cursor: `data-grip` on the
 * board is `armed` while a pan is pressed and `moving` while it is under way.
 */
export function useWorldTransform(camera: CameraStore, world: RefObject<HTMLElement | null>, ground: RefObject<HTMLElement | null>, board: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const g = ground.current;
    if (g) g.style.inset = `-${GROUND_REACH}px`;
    let zoom = Number.NaN;
    const offMove = camera.onMove((cam) => {
      const w = world.current;
      const zoomed = cam.z !== zoom;
      zoom = cam.z;
      if (w) {
        w.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`;
        // What keeps its size on screen as the board zooms (the chapter labels) reads this.
        if (zoomed) w.style.setProperty('--z', String(cam.z));
      }
      if (g) {
        const at = groundAt(cam);
        if (zoomed) g.style.backgroundSize = `${at.cell}px ${at.cell}px`;
        g.style.transform = `translate(${at.x}px, ${at.y}px)`;
      }
    });
    const offGrip = camera.onGrip((grip) => {
      const b = board.current;
      if (!b) return;
      if (grip === 'none') delete b.dataset.grip;
      else b.dataset.grip = grip;
    });
    // Each tool that pans lets the hand go when its press ends. This is the net under them: the
    // hand also lets go whenever any press ends, or the window loses focus, so no ending a tool
    // did not foresee can leave the closed hand on the board.
    const letGo = () => camera.hold('none');
    const b = board.current;
    window.addEventListener('pointerup', letGo);
    window.addEventListener('pointercancel', letGo);
    window.addEventListener('blur', letGo);
    b?.addEventListener('lostpointercapture', letGo);
    return () => {
      offMove();
      offGrip();
      camera.stop();
      window.removeEventListener('pointerup', letGo);
      window.removeEventListener('pointercancel', letGo);
      window.removeEventListener('blur', letGo);
      b?.removeEventListener('lostpointercapture', letGo);
    };
  }, [camera, world, ground, board]);
}
