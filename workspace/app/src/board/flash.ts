import type { Id } from '@keel/protocol';

/** How long an item stays lit, in ms: a little longer than the animation that fades it. */
const FLASH_MS = 1400;

/** Make items blink once so the eye finds them. `layer` is the element the items are drawn in. */
export function flashItems(layer: HTMLElement | null, ids: readonly Id[]): void {
  for (const id of ids) {
    const el = layer?.querySelector<HTMLElement>(`[data-item="${id}"]`);
    if (!el) continue;
    el.classList.remove('item--flash');
    void el.offsetWidth;
    el.classList.add('item--flash');
    setTimeout(() => el.classList.remove('item--flash'), FLASH_MS);
  }
}
