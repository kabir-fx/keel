import type { Board } from '../board/context';
import { PAGE_STEP, ZOOM_STEP } from '../input/constants';
import { fitBox, unionBox } from './camera';
import { drawnBox, laidOut, measureRoom } from './fit';

/**
 * What the camera does for a key. Each glides, from where the camera is going, so a key pressed
 * twice adds up; with "reduce motion" each jumps. The keys themselves are bound in
 * `input/keys.ts`.
 */
type CameraBoard = Pick<Board, 'camera' | 'zoomBy' | 'fitAll' | 'selection' | 'boxes' | 'state' | 'layerEl' | 'rect'>;

/** Zoom in one step about the middle of the board. */
export function zoomIn(board: CameraBoard): void {
  board.zoomBy(ZOOM_STEP);
}

/** Zoom out one step about the middle of the board. */
export function zoomOut(board: CameraBoard): void {
  board.zoomBy(1 / ZOOM_STEP);
}

/** Back to 100% about the middle of the board. */
export function zoomToActual(board: CameraBoard): void {
  board.zoomBy(1 / board.camera.goal().z);
}

/** Fit the whole board in view, clear of the panels. */
export function fitEverything(board: CameraBoard): void {
  board.fitAll();
}

/** Fit what is selected in view, all of it, clear of the panels, never past 100%. With nothing selected, fit the whole board. */
export function fitSelection(board: CameraBoard): void {
  const box = unionBox(
    board.selection().flatMap((id) => {
      const b = drawnBox(id, board.boxes(), board.state(), board.layerEl());
      return b ? [b] : [];
    }),
  );
  if (!box) {
    board.fitAll();
    return;
  }
  board.camera.glide(fitBox(box, measureRoom(board.rect()), 1));
}

/** Move the view one page up the board: its height, less an eighth that stays in view. */
export function pageUp(board: CameraBoard): void {
  pageBy(board, 1);
}

/** Move the view one page down the board: its height, less an eighth that stays in view. */
export function pageDown(board: CameraBoard): void {
  pageBy(board, -1);
}

function pageBy(board: CameraBoard, dir: 1 | -1): void {
  const goal = board.camera.goal();
  board.camera.glide({ ...goal, y: goal.y + dir * laidOut(board.rect()).height * PAGE_STEP });
}
