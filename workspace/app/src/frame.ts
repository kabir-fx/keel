/**
 * Timed work on the page's frames: one loop that runs only while something moves, and a
 * wrapper that lets a function run at most once a frame.
 *
 * Adapted from Excalidraw (MIT licence, copyright 2020 Excalidraw), at commit 9fbeaed:
 * - `FrameLoop` from packages/excalidraw/renderer/animation.ts (`AnimationController`);
 * - `oncePerFrame` from packages/common/src/utils.ts (`throttleRAF`).
 * Changed for the board: a loop is an object a board owns and not one shared by the whole
 * page, a step is told the time since its last call and answers with a boolean, and a step
 * first runs on the next frame, never inside `start`.
 */

/** What asks the browser for a frame. A test hands in its own, to step frames by hand. */
export interface FrameScheduler {
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
}

/**
 * One step of something that moves. `dt` is the time since its last call, in ms; on its first
 * call, the time since it was started. True means "call me on the next frame too".
 */
export type Step = (dt: number) => boolean;

interface Running {
  step: Step;
  last: number;
}

/**
 * The one frame loop: everything on a board that moves by itself (the camera gliding, a trail
 * fading) is a step in it. It asks for a frame only while it has a step, so a board at rest
 * asks for none.
 */
export class FrameLoop {
  private readonly steps = new Map<unknown, Running>();
  private frame: number | null = null;
  private readonly scheduler: FrameScheduler;
  private readonly now: () => number;

  constructor(scheduler: FrameScheduler = window, now: () => number = () => performance.now()) {
    this.scheduler = scheduler;
    this.now = now;
  }

  /** Run `step` on every frame from the next one, until it answers false. A key that is already running is left as it is. */
  start(key: unknown, step: Step): void {
    if (this.steps.has(key)) return;
    this.steps.set(key, { step, last: this.now() });
    this.schedule();
  }

  /** Stop the step under `key`. It is not called again. */
  cancel(key: unknown): void {
    if (this.steps.delete(key)) this.stopIfIdle();
  }

  running(key: unknown): boolean {
    return this.steps.has(key);
  }

  /** Stop everything, as when the board leaves the page. */
  stop(): void {
    this.steps.clear();
    this.stopIfIdle();
  }

  private schedule(): void {
    if (this.frame !== null) return;
    this.frame = this.scheduler.requestAnimationFrame(() => this.tick());
  }

  private stopIfIdle(): void {
    if (this.steps.size > 0 || this.frame === null) return;
    this.scheduler.cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  private tick(): void {
    this.frame = null;
    // A step may start, cancel or replace steps. Work from the set as the frame began, so a
    // step started now first runs on the next frame, and each runs at most once a frame.
    for (const [key, running] of [...this.steps]) {
      if (this.steps.get(key) !== running) continue;
      const now = this.now();
      const dt = now - running.last;
      running.last = now;
      const more = running.step(dt);
      // The step may have cancelled or replaced itself: only the one that ran may end itself.
      if (!more && this.steps.get(key) === running) this.steps.delete(key);
    }
    if (this.steps.size > 0) this.schedule();
  }
}

/** A function that runs at most once a frame, with the arguments of its latest call. */
export interface Framed<A extends unknown[]> {
  (...args: A): void;
  /** Run the waiting call now, if one waits. For the moment before an event that must see its result. */
  flush(): void;
  /** Drop the waiting call. */
  cancel(): void;
}

/**
 * Wrap `fn` so that many calls in one frame become one call, on the next frame, with the
 * latest arguments. A pointer can report many times between two frames; what it moves needs
 * to be drawn once.
 */
export function oncePerFrame<A extends unknown[]>(fn: (...args: A) => void, scheduler: FrameScheduler = window): Framed<A> {
  let frame: number | null = null;
  let waiting: A | null = null;

  const unschedule = () => {
    if (frame === null) return;
    scheduler.cancelAnimationFrame(frame);
    frame = null;
  };

  const run = () => {
    const args = waiting;
    waiting = null;
    if (args) fn(...args);
  };

  const framed = (...args: A) => {
    waiting = args;
    if (frame !== null) return;
    frame = scheduler.requestAnimationFrame(() => {
      frame = null;
      run();
    });
  };
  framed.flush = () => {
    unschedule();
    run();
  };
  framed.cancel = () => {
    waiting = null;
    unschedule();
  };
  return framed;
}
