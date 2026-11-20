import { HANDLE_SIZE } from '../input/constants';

/**
 * The handles on the two ends of the arrow selected: a small round handle on each end, drawn in
 * the overlay at one size at any zoom. A drag of one moves that end (`select/arrowGrip.ts`).
 */

/** Which end a handle is on. */
export type EndName = 'from' | 'to';

const NAMES: readonly EndName[] = ['from', 'to'];

/** Put the handles on the ends, given in screen pixels, or hide them. */
export function placeEnds(els: ReadonlyMap<EndName, HTMLElement>, ends: readonly [readonly [number, number], readonly [number, number]] | undefined): void {
  for (const [name, el] of els) {
    if (!ends) {
      if (!el.hidden) el.hidden = true;
      continue;
    }
    const [x, y] = ends[name === 'from' ? 0 : 1];
    el.hidden = false;
    el.style.transform = `translate(${Math.round(x - HANDLE_SIZE / 2)}px, ${Math.round(y - HANDLE_SIZE / 2)}px)`;
  }
}

/** The two end handles. `keep` is handed each element as it is drawn, for `placeEnds`. */
export function EndHandles({ keep }: { keep: (name: EndName, el: HTMLElement | null) => void }) {
  return (
    <>
      {NAMES.map((name) => (
        <div key={name} className="end-handle" data-end={name} hidden ref={(el) => keep(name, el)} />
      ))}
    </>
  );
}
