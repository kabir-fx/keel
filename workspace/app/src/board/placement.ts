import type { BoardState, Box, Id, Point } from '@keel/protocol';
import type { RefObject } from 'react';
import { useLayoutEffect, useRef } from 'react';
import type { CameraStore } from '../camera/camera';
import { shownBoxOf } from '../layout';
import { placeAll } from '../place';
import type { BoardSource } from '../source';
import type { Ahead } from './ahead';

/** What placement needs of the render it runs in. */
export interface PlacementNeeds {
  source: BoardSource;
  camera: CameraStore;
  state: BoardState;
  /** The board's fonts are in: a picture measured before that would change size later. */
  fontsReady: boolean;
  /** This page may place pictures: anyone but the agent. */
  canPlace: boolean;
  ahead: Ahead;
  subRects: ReadonlyMap<string, Box>;
  /** The layer where pictures that wait for a place are drawn out of sight. */
  measureLayer: RefObject<HTMLElement | null>;
  say(text: string): void;
}

/**
 * Give every picture that waits for a place its place.
 *
 * Measure what waits, find room for it, and place it: once, with `item.place`. The page never
 * posts a box change of its own: only a drag or a resize by the owner does. So a placeholder
 * the agent is still drawing gets a spot here only, and is placed once it is finished, at its
 * finished size, from the top left corner of that spot.
 */
export function usePlacement({ source, camera, state, fontsReady, canPlace, ahead, subRects, measureLayer, say }: PlacementNeeds): void {
  /** The top left corner of the spot each finished placeholder stood at on this page. */
  const stood = useRef(new Map<Id, Point>());
  useLayoutEffect(() => {
    if (!fontsReady || !canPlace) return;
    // Read the board as it is now, not as it was at this render.
    const st = source.state;
    const known = ahead.now.current;
    const sizes = new Map<Id, readonly [number, number]>();
    const subOffsets = new Map<string, Box>();
    measureLayer.current?.querySelectorAll<HTMLElement>('[data-measure]').forEach((el) => {
      const id = el.dataset.measure!;
      sizes.set(id, [el.offsetWidth, el.offsetHeight]);
      const r = el.getBoundingClientRect();
      const z = camera.get().z;
      el.querySelectorAll<HTMLElement>('[data-sub]').forEach((sub) => {
        const sr = sub.getBoundingClientRect();
        subOffsets.set(`${id}/${sub.dataset.sub}`, [(sr.left - r.left) / z, (sr.top - r.top) / z, sr.width / z, sr.height / z]);
      });
    });
    if (sizes.size === 0) return;
    const placed = placeAll(st, sizes, (now) => {
      const boxes = { get: (x: Id) => now.get(x) ?? known.get(x) };
      return (x: Id) => shownBoxOf({ state: st, boxes, subs: subRects, subOffsets }, x);
    }, stood.current);
    if (placed.size === 0) return;
    const drawing = new Map<Id, Box>();
    const real = new Map<Id, Box>();
    for (const [id, box] of placed) (st.items[id]?.item.kind === 'picture' && st.items[id]!.item.status === 'drawing' ? drawing : real).set(id, box);
    if (drawing.size > 0) ahead.addProvisional(drawing);
    if (real.size === 0) return;
    ahead.setPendingBoxes(real);
    for (const [id, box] of real) {
      // Another open tab may place it first: that refusal (R8) is not news, and the box that
      // won arrives as an event.
      void source.post({ type: 'item.place', item: id, box }).then((r) => {
        if (!r.ok && r.rule !== 'R8') {
          ahead.refused.current.add(id);
          say(`A picture could not be placed: ${r.reason}`);
        }
        ahead.setPendingBox(id, undefined, box);
      });
    }
  });

  // A placeholder that is finished, placed, or gone has no spot of its own here any more: a
  // finished one waits to be placed at its finished size. Before the page is painted, so a
  // finished picture is measured and placed in the frame of the agent's update, and is never
  // drawn whole on the placeholder's spot.
  const { keepProvisional, provisional } = ahead;
  useLayoutEffect(() => {
    keepProvisional((id) => {
      const it = state.items[id];
      const drawing = !!it && !it.removed && it.item.kind === 'picture' && it.item.box === undefined && it.item.status === 'drawing';
      const spot = provisional.get(id);
      if (!drawing && spot) stood.current.set(id, [spot[0], spot[1]]);
      return drawing;
    });
  }, [state, keepProvisional, provisional]);
}
