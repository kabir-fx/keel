import { openCount } from '@keel/protocol';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { BoardSource } from '../source';

/** How long the owner makes no movement before the page points them at "Answer now" (record 0019). */
export const STILL_MS = 10_000;

/** What the owner does that counts as movement. */
const MOVEMENT = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const;

/**
 * Whether the owner has made no movement for `STILL_MS`. A movement writes the time, and says
 * so only when the owner was still; one timer looks again when the time could be up. So a
 * pointer that moves all day draws nothing again.
 */
export class Stillness {
  private last: number;
  private still = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly now: () => number = () => Date.now()) {
    this.last = now();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  isStill = (): boolean => this.still;

  /** Hear the owner's movement on `target` until the answer is called. */
  listen(target: Window): () => void {
    const always = { capture: true, passive: true } as const;
    for (const type of MOVEMENT) target.addEventListener(type, this.moved, always);
    this.last = this.now();
    this.look();
    return () => {
      for (const type of MOVEMENT) target.removeEventListener(type, this.moved, always);
      clearTimeout(this.timer);
      this.timer = undefined;
    };
  }

  private readonly moved = (): void => {
    this.last = this.now();
    if (!this.still) return;
    this.still = false;
    this.say();
    this.look();
  };

  private readonly look = (): void => {
    clearTimeout(this.timer);
    this.timer = undefined;
    const left = this.last + STILL_MS - this.now();
    if (left > 0) {
      this.timer = setTimeout(this.look, left);
      return;
    }
    this.still = true;
    this.say();
  };

  private say(): void {
    for (const l of this.listeners) l();
  }
}

/** The page's one stillness clock, listening for as long as the page is open. */
export function useStillness(): Stillness {
  const [still] = useState(() => new Stillness());
  useEffect(() => still.listen(window), [still]);
  return still;
}

/**
 * True when the owner's page points at "Answer now": the agent holds, a mark waits, the owner
 * can ask, and has been still. The hint line and the pill both read it, so they never disagree.
 */
export function useAskNow(source: BoardSource, still: Stillness): boolean {
  const waits = useSyncExternalStore(source.subscribe, () => source.role === 'owner' && !!source.hold && !!source.holding && openCount(source.whole ?? source.state) > 0);
  const quiet = useSyncExternalStore(still.subscribe, still.isStill);
  return waits && quiet;
}
