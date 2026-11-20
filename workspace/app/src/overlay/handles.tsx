import type { Box } from '@keel/protocol';
import type { Handle } from '../select/resize';
import { CORNERS, cornerSquare } from '../select/resize';

/**
 * The handles of the one thing selected that the owner can resize: a small square at each
 * corner of the line round it, drawn in the overlay at one size at any zoom. The edges between
 * them are grabbed too, with nothing drawn there.
 */

/** Put the handles at the corners of a thing drawn at `box` on the screen, or hide them. */
export function placeHandles(els: ReadonlyMap<Handle, HTMLElement>, box: Box | undefined): void {
  for (const [corner, el] of els) {
    if (!box) {
      if (!el.hidden) el.hidden = true;
      continue;
    }
    const [x, y, w, h] = cornerSquare(box, corner);
    el.hidden = false;
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
  }
}

/** The four corner handles. `keep` is handed each element as it is drawn, for `placeHandles`. */
export function Handles({ keep }: { keep: (corner: Handle, el: HTMLElement | null) => void }) {
  return (
    <>
      {CORNERS.map((c) => (
        <div key={c} className="select-handle" data-handle={c} hidden ref={(el) => keep(c, el)} />
      ))}
    </>
  );
}
