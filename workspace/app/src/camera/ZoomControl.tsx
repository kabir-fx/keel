import { useSyncExternalStore } from 'react';
import { ZOOM_STEP } from '../input/constants';
import { keyWords } from '../input/keytable';
import type { CameraStore } from './camera';
import { MAX_ZOOM, MIN_ZOOM } from './camera';

/**
 * The zoom buttons: out, the zoom now (a press goes back to 100%), in, and fit. A button that
 * would go past a limit is grey. It renders only when the zoom changes, never for a pan.
 */
export function ZoomControl({ camera, onZoom, onFit }: { camera: CameraStore; onZoom: (factor: number) => void; onFit: () => void }) {
  const z = useSyncExternalStore(camera.subscribe, () => camera.get().z);
  return (
    <div className="chrome zoom" role="group" aria-label="Zoom" data-viewport-ui="bottom">
      <button type="button" aria-label="Zoom out" data-tip={`Zoom out (${keyWords('zoom.out')})`} disabled={z <= MIN_ZOOM} onClick={() => onZoom(1 / ZOOM_STEP)}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3.5 8 H12.5" />
        </svg>
      </button>
      <button type="button" className="zoom__level" data-testid="zoom" data-tip={`Back to 100% (${keyWords('zoom.actual')})`} onClick={() => onZoom(1 / camera.goal().z)}>
        {Math.round(z * 100)}%
      </button>
      <button type="button" aria-label="Zoom in" data-tip={`Zoom in (${keyWords('zoom.in')})`} disabled={z >= MAX_ZOOM} onClick={() => onZoom(ZOOM_STEP)}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3.5 8 H12.5 M8 3.5 V12.5" />
        </svg>
      </button>
      <span className="zoom__sep" aria-hidden="true" />
      <button type="button" aria-label="Fit the board" data-tip={`Fit the board (${keyWords('fit.all')})`} onClick={onFit}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2.5 6 V2.5 H6 M10 2.5 H13.5 V6 M13.5 10 V13.5 H10 M6 13.5 H2.5 V10" />
        </svg>
      </button>
    </div>
  );
}
