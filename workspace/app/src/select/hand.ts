import type { BoardCtx, Press } from '../tools/types';

/** The pointer and the keys as every gesture of Select, and the Arrow tool, read them. */

/** The pointer now, in world units, by the camera as it is now: a wheel in the middle of a drag moves the world under a pointer that stood still. */
export function pointerNow(press: Press, board: BoardCtx): [number, number] {
  const cam = board.camera.get();
  return [(press.at.x - cam.x) / cam.z, (press.at.y - cam.y) / cam.z];
}

/**
 * A key pressed or let go in the middle of a drag changes it at once, with no move of the
 * pointer: Shift locks an axis or keeps a ratio, Option resizes from the centre, Cmd lets go of
 * the snap. So what is drawn is always what lands. Excalidraw's rule (its App.tsx, commit 9fbeaed).
 */
export function followKeys(press: Press, again: () => void): () => void {
  const onKey = (e: KeyboardEvent) => {
    press.mods = { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey };
    again();
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  return () => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKey);
  };
}

/** Cmd or Ctrl held: a move or a resize snaps to nothing, and an arrow's end ties to nothing. Excalidraw's key for both. */
export const cmdHeld = (press: Press): boolean => press.mods.meta || press.mods.ctrl;
