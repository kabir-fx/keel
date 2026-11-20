import type { Box, Id } from '@keel/protocol';
import { memo, useSyncExternalStore } from 'react';
import type { BoardRect } from '../tools/types';
import { lostFrom, wayBack } from './back';
import type { CameraStore } from './camera';
import { viewOf } from './camera';
import type { Fit } from './fit';
import { laidOut } from './fit';

/** What the button is given. */
interface BackToBoardProps {
  camera: CameraStore;
  boxes: ReadonlyMap<Id, Box>;
  fit: Fit;
  rect: () => BoardRect;
}

/** True when two sets of boxes say the same: a board event that moved nothing hands over a new map of the same boxes. */
function sameBoxes(a: ReadonlyMap<Id, Box>, b: ReadonlyMap<Id, Box>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [id, x] of a) {
    const y = b.get(id);
    if (!y || (x !== y && !x.every((v, k) => v === y[k]))) return false;
  }
  return true;
}

/**
 * Shown when nothing on the board is in view: a press glides back to the whole board, or to
 * the item nearest the view when the board does not fit even at the smallest zoom. It is
 * hidden while the camera glides. It wears the nudge's look, among the notices.
 *
 * It renders when the button comes or goes and when the items change, never for a camera move
 * that leaves the button as it is, nor for a render of the board that changed neither.
 */
export const BackToBoard = memo(
  function BackToBoard({ camera, boxes, fit, rect }: BackToBoardProps) {
    const size = () => {
      const r = laidOut(rect());
      return { w: r.width, h: r.height };
    };
    const lost = useSyncExternalStore(camera.subscribe, () => !camera.gliding() && lostFrom(boxes, viewOf(camera.get(), size())));
    if (!lost) return null;
    return (
      <button
        type="button"
        className="notice notice--nudge"
        data-testid="back-to-board"
        onClick={() => fit.fitTo(wayBack(boxes, viewOf(camera.get(), size()), fit.room()))}
      >
        <span>Nothing in view.</span>
        <span className="notice__go">Go back to the board</span>
      </button>
    );
  },
  (a, b) => a.camera === b.camera && a.fit === b.fit && a.rect === b.rect && sameBoxes(a.boxes, b.boxes),
);
