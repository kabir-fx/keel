import type { Box, Id, ItemState } from '@keel/protocol';
import type { RefObject } from 'react';
import { useLayoutEffect, useRef } from 'react';
import { PLAYS as ARRIVAL_PLAYS } from '../arrival/attributes';
import type { CameraStore } from '../camera/camera';

/** What measuring the subs needs of the render it runs in. */
export interface SubsNeeds {
  camera: CameraStore;
  layer: RefObject<HTMLElement | null>;
  live: readonly ItemState[];
  /** An item's own box, by the log or ahead of it. */
  stored(id: Id): Box | undefined;
  subRects: ReadonlyMap<string, Box>;
  setSubRects(next: ReadonlyMap<string, Box>): void;
}

const sameBox = (a: Box | undefined, b: Box | undefined, slop = 0.5) => !!a && !!b && a.every((n, i) => Math.abs(n - (b[i] ?? 0)) <= slop);

/** The subs that marks hang on (anchors, what lassos hold, what arrows point at), as `item/sub`. */
export function wantedSubs(live: readonly ItemState[]): Set<string> {
  const wanted = new Set<string>();
  for (const s of live) {
    const it = s.item;
    if (it.kind === 'picture') continue;
    if (it.anchor?.sub) wanted.add(`${it.anchor.item}/${it.anchor.sub}`);
    if (it.kind === 'lasso') for (const t of it.targets) if (t.sub) wanted.add(`${t.item}/${t.sub}`);
    if (it.kind === 'arrow') for (const t of [it.fromTarget, it.toTarget]) if (t?.sub) wanted.add(`${t.item}/${t.sub}`);
  }
  return wanted;
}

/** True when a mark hangs on a sub of this item: its subs are measured on every render. */
export const hangsOnSubs = (live: readonly ItemState[], id: Id): boolean => [...wantedSubs(live)].some((key) => key.startsWith(`${id}/`));

/**
 * Measure where the subs that marks hang on are now (anchors, what lassos hold, what arrows
 * point at), so the marks follow them. The ref it answers with is true when the last measure
 * found nothing moved: the layout is settled.
 */
export function useSubRects({ camera, layer, live, stored, subRects, setSubRects }: SubsNeeds): RefObject<boolean> {
  const settled = useRef(false);
  useLayoutEffect(() => {
    const el = layer.current;
    if (!el) return;
    const z = camera.get().z;
    const next = new Map<string, Box>();
    for (const key of wantedSubs(live)) {
      const cut = key.indexOf('/');
      const item = key.slice(0, cut);
      const sub = key.slice(cut + 1);
      const base = stored(item);
      const itemEl = el.querySelector<HTMLElement>(`[data-item="${item}"]`);
      const subEl = itemEl?.querySelector<HTMLElement>(`[data-sub="${sub}"]`);
      if (!base || !itemEl || !subEl) continue;
      // A picture being drawn on is posed, not where it rests: it keeps what it measured
      // before, and is measured again once the arrival is over (`ARRIVAL_PLAYS`).
      if (itemEl.querySelector(`[${ARRIVAL_PLAYS}]`)) {
        const kept = subRects.get(key);
        if (kept) next.set(key, kept);
        continue;
      }
      const ir = itemEl.getBoundingClientRect();
      const sr = subEl.getBoundingClientRect();
      next.set(key, [base[0] + (sr.left - ir.left) / z, base[1] + (sr.top - ir.top) / z, sr.width / z, sr.height / z]);
    }
    const same = next.size === subRects.size && [...next].every(([k, b]) => sameBox(b, subRects.get(k)));
    settled.current = same;
    if (!same) setSubRects(next);
  });
  return settled;
}
