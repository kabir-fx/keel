// DOM helpers: measure tap targets, snapshot a world region. Carried from spike S2, with the
// contract's `data-item` and `data-sub` in place of the spike's `data-target`.

import type { Box, Sub, Target } from '@keel/protocol';
import { toCanvas } from 'html-to-image';
import type { Camera } from './camera/camera';
import { screenToWorld } from './camera/camera';
import type { TargetRect } from './geometry';
import { overlaps } from './geometry';

export { screenToWorld };

/**
 * Every `data-item` inside `layer`, and every `data-sub` inside an item, becomes a hit-test
 * target. A sub's parent is its item. Pictures declare their own subs: the app needs no list.
 */
export function measureTargets(layer: HTMLElement, board: HTMLElement, cam: Camera, skip?: (el: HTMLElement) => boolean): TargetRect[] {
  const origin = board.getBoundingClientRect();
  const out: TargetRect[] = [];
  const toBox = (el: Element): Box => {
    const r = el.getBoundingClientRect();
    const [x, y] = screenToWorld(cam, r.left - origin.left, r.top - origin.top);
    return [x, y, r.width / cam.z, r.height / cam.z];
  };
  layer.querySelectorAll<HTMLElement>('[data-item]').forEach((el) => {
    const item = el.dataset.item!;
    if (skip?.(el)) return;
    out.push({ id: item, item, box: toBox(el) });
    el.querySelectorAll<HTMLElement>('[data-sub]').forEach((s) => {
      const sub = s.dataset.sub!;
      // A sub inside another sub (a step inside an approach) has that sub as its parent.
      const outer = s.parentElement?.closest<HTMLElement>('[data-sub]');
      const parent = outer && el.contains(outer) ? `${item}/${outer.dataset.sub}` : item;
      out.push({ id: `${item}/${sub}`, item, sub, parent, box: toBox(s) });
    });
  });
  return out;
}

/** The kinds of mark that are lines, drawn with no box of their own in the DOM: never a target under the pen. */
export const LINE_KINDS: ReadonlySet<string> = new Set(['ink', 'arrow', 'lasso', 'pin']);

/** Skip the line marks, which have no box in the DOM. */
export const skipLines = (el: HTMLElement) => LINE_KINDS.has(el.dataset.kind ?? '');

/** The contract's target for a target rect id. */
export function targetOf(rects: readonly TargetRect[], id: string): Target | undefined {
  const r = rects.find((t) => t.id === id);
  if (!r) return undefined;
  return r.sub ? { item: r.item, sub: r.sub } : { item: r.item };
}

/** The item, and the sub inside it, under a screen point. */
export function targetAt(clientX: number, clientY: number): { item: string; sub?: Sub; el: HTMLElement } | undefined {
  if (typeof document.elementsFromPoint !== 'function') return undefined;
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    if (!(el instanceof HTMLElement || el instanceof SVGElement)) continue;
    // In the focus view, what lies under the dim is not there to point at.
    if (el instanceof HTMLElement && el.dataset.focusDim !== undefined) return undefined;
    const itemEl = el.closest<HTMLElement>('[data-item]');
    if (!itemEl) continue;
    const subEl = el.closest<HTMLElement>('[data-sub]');
    const sub = subEl && itemEl.contains(subEl) ? subEl.dataset.sub : undefined;
    return { item: itemEl.dataset.item!, ...(sub ? { sub } : {}), el: itemEl };
  }
  return undefined;
}

/**
 * Snapshot a world region of the DOM layer as a canvas. `world` is the element that carries
 * the camera transform; its children are placed in world coordinates. Items outside the region
 * (by their `data-box`) and anything marked `data-no-export` are skipped, so the cost tracks the
 * region, not the board.
 */
export async function snapshotRegion(world: HTMLElement, box: Box, pixelRatio = 2): Promise<HTMLCanvasElement> {
  const [x, y, w, h] = box;
  return toCanvas(world, {
    width: Math.ceil(w),
    height: Math.ceil(h),
    pixelRatio,
    backgroundColor: '#EEF1F5',
    style: { transform: `translate(${-x}px, ${-y}px)`, transformOrigin: '0 0', left: '0', top: '0' },
    cacheBust: false,
    // Embedding the web fonts makes the library parse stylesheets in a document with a <base>,
    // which the server's Content Security Policy (base-uri 'none') forbids. The agent reads the
    // shapes and words of a sketch; the hand it is written in does not change the reading.
    skipFonts: true,
    filter: (domNode) => {
      const node = domNode as Node; // text nodes come through here too
      if (!(node instanceof HTMLElement || node instanceof SVGElement)) return true;
      if (node.dataset.noExport !== undefined) return false;
      const b = node.dataset.box;
      if (!b) return true;
      return overlaps(b.split(',').map(Number) as unknown as Box, box);
    },
  });
}

/** A canvas as PNG bytes. */
export function pngOf(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
}
