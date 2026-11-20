import type { Box } from '@keel/protocol';
import { useLayoutEffect, useRef } from 'react';
import type { CameraStore } from '../camera/camera';
import { TIE_LINE } from '../input/constants';

/**
 * The thing an arrow's end would tie to, outlined while the owner draws an arrow or drags one of
 * its ends, so they see what it will hold on to before they let go. It is kept outside React: it
 * changes as the pointer moves, and only the overlay's one element is written for it.
 */
export class Highlight {
  private box: Box | undefined;
  private readonly listeners = new Set<() => void>();

  /** Where the thing is drawn, in world units; nothing when no end would tie. */
  get = (): Box | undefined => this.box;

  /** Outline a thing drawn at `box`, or nothing. The same box again changes nothing. */
  show = (box: Box | undefined): void => {
    const now = this.box;
    if (now === box || (now && box && now.every((n, i) => n === box[i]))) return;
    this.box = box;
    for (const l of [...this.listeners]) l();
  };

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
}

/**
 * The outline, in the overlay: a line `TIE_LINE` wide in keel's blue just outside the thing, the
 * same on screen at any zoom. The store and the camera place it by writing its styles, with no
 * render.
 */
export function HighlightLayer({ highlight, camera }: { highlight: Highlight; camera: CameraStore }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const place = () => {
      const el = ref.current;
      const box = highlight.get();
      if (!el) return;
      if (!box) {
        if (!el.hidden) el.hidden = true;
        return;
      }
      const cam = camera.get();
      const left = Math.round(box[0] * cam.z + cam.x - TIE_LINE);
      const top = Math.round(box[1] * cam.z + cam.y - TIE_LINE);
      el.hidden = false;
      el.style.transform = `translate(${left}px, ${top}px)`;
      el.style.width = `${Math.round((box[0] + box[2]) * cam.z + cam.x + TIE_LINE) - left}px`;
      el.style.height = `${Math.round((box[1] + box[3]) * cam.z + cam.y + TIE_LINE) - top}px`;
    };
    place();
    const offHighlight = highlight.subscribe(place);
    const offCamera = camera.onMove(place);
    return () => {
      offHighlight();
      offCamera();
    };
  }, [highlight, camera]);
  return <div className="tie-outline" data-testid="tie-outline" hidden ref={ref} />;
}
