import type { Id } from '@keel/protocol';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useState, useSyncExternalStore } from 'react';

/**
 * The picture under the pointer, kept outside React: only what shows it (the lineage) hears of a
 * change, so moving the pointer from one picture to the next draws nothing else again.
 */
export class HoverStore {
  private hovered: Id | undefined;
  private readonly listeners = new Set<() => void>();

  get = (): Id | undefined => this.hovered;

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  /** Set the picture under the pointer. Listeners hear only of a change. */
  set(id: Id | undefined): void {
    if (id === this.hovered) return;
    this.hovered = id;
    for (const l of this.listeners) l();
  }

  onPointerOver = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const el = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-item][data-kind="picture"]') : null;
    this.set(el?.dataset.item);
  };

  onPointerLeave = (): void => this.set(undefined);
}

/** The board's one hover store, the same on every render. */
export function useHover(): HoverStore {
  const [store] = useState(() => new HoverStore());
  return store;
}

/** The picture under the pointer, for a component that shows it. */
export function useHovered(store: HoverStore): Id | undefined {
  return useSyncExternalStore(store.subscribe, store.get);
}
