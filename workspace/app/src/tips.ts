import { TOOLTIP_DELAY, TOOLTIP_WARM } from './input/constants';

/**
 * When a tooltip shows, and where. Plain logic, with no React and no page, so it can be tested
 * alone; `Tooltip.tsx` is the thin part that listens to the pointer and draws the tip.
 *
 * Adapted from Excalidraw (MIT licence, copyright 2020 Excalidraw), at commit 9fbeaed:
 * `showTooltip`, `hideTooltip` and `updateTooltipPosition` in
 * packages/excalidraw/components/Tooltip.tsx. Changed for the board: a press or Esc puts the tip
 * away until the pointer leaves the control, and the tip sits above a control in the lower half
 * of the window, where the toolbar is, and below one in the upper half.
 */

/** The clock a tip waits on. A test hands in its own. */
export interface TipClock {
  now(): number;
  /** Run `fn` after `ms`. Answers with what stops it. */
  after(ms: number, fn: () => void): () => void;
}

/** The page's own clock. */
export const pageClock: TipClock = {
  now: () => Date.now(),
  after: (ms, fn) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
};

/**
 * Which control's tip shows, if any. `T` is whatever stands for a control: the page hands in
 * elements, a test anything. `show` is told each change: the control whose tip now shows, or
 * null when none does.
 *
 * - The first tip shows once the pointer has rested on a control for `TOOLTIP_DELAY`.
 * - For `TOOLTIP_WARM` after a tip closes, the next one shows at once.
 * - A press or Esc puts the tip away, and it stays away while the pointer stays on that control.
 * - A control that has left the page by the time its wait is over shows no tip: no pointer event
 *   says that it went. `present` answers whether a control is still there.
 */
export class TipTimer<T> {
  private shown: T | null = null;
  private waiting: { target: T; stop: () => void } | null = null;
  /** When a tip last closed. */
  private closedAt = -Infinity;
  /** The control whose tip was put away: it shows no tip again until the pointer leaves it. */
  private putAway: T | null = null;

  constructor(
    private readonly show: (target: T | null) => void,
    private readonly clock: TipClock = pageClock,
    private readonly present: (target: T) => boolean = () => true,
  ) {}

  /** The control whose tip shows now, if any. */
  showing(): T | null {
    return this.shown;
  }

  /** The pointer is over this control now, or over none. */
  over(target: T | null): void {
    if (target !== this.putAway) this.putAway = null;
    // Still on the control whose tip shows or waits: nothing changes. Over no control, a tip that waits stops waiting.
    if (target !== null && (target === this.shown || target === this.waiting?.target)) return;
    this.close();
    if (target === null || target === this.putAway) return;
    if (this.clock.now() - this.closedAt <= TOOLTIP_WARM) this.open(target);
    else this.waiting = { target, stop: this.clock.after(TOOLTIP_DELAY, () => this.due(target)) };
  }

  /** The wait is over: the tip shows, unless its control has left the page meanwhile. */
  private due(target: T): void {
    this.waiting = null;
    if (this.present(target)) this.open(target);
  }

  /** A press, or Esc: the tip goes, and the control under the pointer shows none until it is left. */
  putAwayNow(): void {
    const target = this.shown ?? this.waiting?.target ?? null;
    this.close();
    this.putAway = target;
  }

  private open(target: T): void {
    this.waiting = null;
    this.shown = target;
    this.show(target);
  }

  private close(): void {
    this.waiting?.stop();
    this.waiting = null;
    if (this.shown === null) return;
    this.shown = null;
    this.closedAt = this.clock.now();
    this.show(null);
  }
}

/** A box on the page, in page pixels. */
export interface PageBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Do two boxes on the page cross: is some of one inside the other? Boxes that only touch do not, and a box with no size crosses nothing. */
export function crosses(a: PageBox, b: PageBox): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) return false;
  return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

/** How far a tip keeps from its control, in pixels. Excalidraw's `margin`. */
const TIP_GAP = 5;

/** How far a tip keeps from the edges of the window, in pixels. Excalidraw's `margin`. */
const TIP_EDGE = 5;

/**
 * Where a tip of this size goes for a control at `of`, in a window of this size: centred on the
 * control, above it when the control is in the lower half of the window, else below it; on the
 * other side when there is no room; and never past the window's edges.
 */
export function placeTip(of: PageBox, tip: { width: number; height: number }, view: { width: number; height: number }): { left: number; top: number } {
  const above = of.top - TIP_GAP - tip.height;
  const below = of.top + of.height + TIP_GAP;
  const wantsAbove = of.top + of.height / 2 > view.height / 2;
  const top = wantsAbove ? (above >= TIP_EDGE ? above : below) : below + tip.height <= view.height - TIP_EDGE ? below : above;
  const centred = of.left + of.width / 2 - tip.width / 2;
  const left = Math.max(TIP_EDGE, Math.min(centred, view.width - TIP_EDGE - tip.width));
  return { left, top };
}
