import { FrameLoop, ManualClock } from '../frame';
import type { Player } from './player';
import { lengthOf } from './script';

/**
 * A played fixture on the page, and the hooks a test or a reviewer drives it with. Fixture mode
 * only: a live board never has any of it.
 *
 * - `window.__keel`: how far the play has run, read-only.
 * - `window.renderAt(ms)`, on a manual clock only: move the board's clock forward to `ms`, one
 *   frame of 1/60 s at a time, and resolve when the page shows that moment.
 */

/** What a test can read of a play. */
export interface PlayStatus {
  /** True once the board has opened and the play has begun. */
  ready(): boolean;
  /** How far the play has run, in ms. */
  ms(): number;
  /** How long the play runs, in ms: the time of its last moment. */
  readonly length: number;
  /** True once every moment of the play has reached the board. */
  done(): boolean;
}

declare global {
  interface Window {
    __keel?: PlayStatus;
    renderAt?: (ms: number) => Promise<void>;
  }
}

/** The time of frame `n` of the manual clock: counted, not added up, so frame 60 is exactly 1000 ms. */
export const frameTime = (n: number): number => (n * 1000) / 60;

/** The last frame at or before `ms`. A hair of slack, so 250 ms is frame 15 and not frame 14. */
export const frameAt = (ms: number): number => Math.floor((ms * 60) / 1000 + 1e-9);

/** Everything that changes on the page, for telling whether a frame changed anything. */
const WATCH: MutationObserverInit = { subtree: true, childList: true, attributes: true, characterData: true };

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Wait for one real frame. On a manual clock, what the page started in that time goes on the
 * clock at once: a transition that began and ended while a test waited would otherwise be over
 * and gone, so the frame would depend on how long the wait took.
 */
async function waitFrame(clock?: ManualClock): Promise<void> {
  await nextFrame();
  if (clock) holdAll(clock);
}

/** Wait for real frames until `holds` is true, for at most `most` frames. */
async function until(holds: () => boolean, clock?: ManualClock, most = 600): Promise<void> {
  for (let i = 0; i < most && !holds(); i++) await waitFrame(clock);
}

/**
 * Wait for real frames until `quiet` frames in a row change nothing on the page: React has drawn
 * what changed, and the effects that follow (a placement, a measure, a step started on the
 * loop) have run. At most `most` frames, so something that never rests cannot hang a test.
 */
async function settle(clock?: ManualClock, quiet = 2, most = 120): Promise<void> {
  // The observer is handed what changed at the end of each task, before a frame's wait is over:
  // what it was handed since the last frame counts, as well as what it still holds.
  let changed = false;
  const watch = new MutationObserver(() => {
    changed = true;
  });
  watch.observe(document.body, WATCH);
  try {
    let still = 0;
    for (let i = 0; i < most && still < quiet; i++) {
      await waitFrame(clock);
      const quietFrame = !changed && watch.takeRecords().length === 0;
      changed = false;
      still = quietFrame ? still + 1 : 0;
    }
  } finally {
    watch.disconnect();
  }
}

/**
 * The board has opened: it is on the page, its fonts are in, nothing waits to be measured, and
 * the page has come to rest, so the first view is fitted. What is on the board now counts as
 * known; what the play brings is new, as on a live board.
 *
 * Every face the page declares is loaded, not only those the board drew so far: a blank board
 * has drawn no note yet, and a note played in later must not come in a fallback face on one run
 * and its own on the next.
 */
async function opened(clock?: ManualClock): Promise<void> {
  await until(() => document.querySelector('[data-testid="board"]') !== null, clock);
  await Promise.all([...document.fonts].map((face) => face.load().catch(() => undefined)));
  await document.fonts.ready;
  await until(() => document.querySelector('[data-measure]') === null, clock);
  await settle(clock, 3);
}

/** Put every animation on the page that is not on the clock yet on it, from now. */
function holdAll(clock: ManualClock): void {
  for (const animation of document.getAnimations()) if (!clock.holds(animation)) clock.hold(animation);
}

/**
 * Play `player` on the page once the board has opened, on `clock` when it is given, and put the
 * hooks on `window`. The play runs on a frame loop of its own on the board's clock: on a manual
 * clock both loops run in the same moves of it, so they keep one time.
 */
export function startReplay(player: Player, clock?: ManualClock): void {
  if (clock) new MutationObserver(() => holdAll(clock)).observe(document.documentElement, WATCH);
  const loop = clock ? new FrameLoop(clock, clock.now) : new FrameLoop();
  let begun = false;
  const ready = opened(clock).then(() => {
    if (clock) holdAll(clock);
    player.start(loop);
    begun = true;
  });
  window.__keel = Object.freeze({ ready: () => begun, ms: () => player.ms, length: lengthOf(player.script), done: () => player.done });
  if (clock) window.renderAt = renderer(clock, player, ready);
}

/**
 * `renderAt` on a manual clock. Each call waits for the one before. A frame that changed the
 * board (a moment of the play reached it, or something on the loop moved) is let settle before
 * the next, so the next frame starts from the same page every time.
 *
 * Every animation on the page goes on the clock, from the time of the frame it was first seen
 * in: one made by a change to the page is seen at the end of the task that changed it
 * (`startReplay`), before the page draws it; one made with no change to the page while it stood
 * between two calls is seen as the next call begins. Seen a frame later, an animation has run a
 * frame in the browser's compositor, and Chrome goes on drawing the value it ran to after the
 * clock pauses it at its start. A creator that knows its start better says so with
 * `FrameLoop.hold`. A cancelled animation is not on the page's list, and the clock takes none
 * that is idle.
 */
function renderer(clock: ManualClock, player: Player, ready: Promise<void>): (ms: number) => Promise<void> {
  let frame = 0;
  const render = async (ms: number) => {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) throw new Error(`renderAt takes a time in ms, 0 or more, and ${String(ms)} is not one.`);
    await ready;
    const last = frameAt(ms);
    if (last < frame) throw new Error(`The board shows ${Math.round(clock.now())} ms already, and renderAt only goes forward. Load the page again to see ${ms} ms.`);
    // What was made while the page stood still began at the time it stood at.
    holdAll(clock);
    while (frame < last) {
      frame += 1;
      const watch = new MutationObserver(() => undefined);
      watch.observe(document.body, WATCH);
      clock.advanceTo(frameTime(frame));
      const moved = watch.takeRecords().length > 0;
      watch.disconnect();
      if (player.takeChanged() || moved) {
        await settle(clock);
        holdAll(clock);
      }
    }
    await settle(clock);
    holdAll(clock);
  };
  let queue: Promise<void> = Promise.resolve();
  return (ms: number) => {
    const run = queue.then(() => render(ms));
    queue = run.catch(() => undefined);
    return run;
  };
}
