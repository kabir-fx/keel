/**
 * Timed work on the page's frames: one loop that runs only while something moves, a clock that
 * moves only when a test or a reviewer moves it, and a wrapper that lets a function run at most
 * once a frame.
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

/** Frames and the time they run at: the page's own, or a `ManualClock`. `now` is called on its own, with no `this`. */
export interface Clock extends FrameScheduler {
  now(): number;
}

/** The parts of a Web Animation a manual clock sets. */
export type HeldAnimation = Pick<Animation, 'pause' | 'currentTime' | 'playState'>;

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
  /** The time this loop runs on, in ms: what each step's `dt` is counted in. */
  readonly now: () => number;

  constructor(scheduler: FrameScheduler = window, now: () => number = () => performance.now()) {
    this.scheduler = scheduler;
    this.now = now;
  }

  /** True when the loop runs on a `ManualClock`: nothing moves until a test or a reviewer moves the clock. */
  get manual(): boolean {
    return this.scheduler instanceof ManualClock;
  }

  /**
   * Put a Web Animation on this loop's clock. On the page's own clock it runs as it is. On a
   * manual clock it is paused at once, and each move of the clock sets it to the time since
   * `start` (by default, now), so a frame asked for twice shows it the same.
   */
  hold(animation: HeldAnimation, start: number = this.now()): void {
    if (this.scheduler instanceof ManualClock) this.scheduler.hold(animation, start);
  }

  /** Take an animation off this loop's clock: the clock sets it no more. Nothing to do on the page's own clock. */
  release(animation: HeldAnimation): void {
    if (this.scheduler instanceof ManualClock) this.scheduler.release(animation);
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

/**
 * A clock that moves only when it is told to: for a fixture played in a test or a review, so
 * the same moment always shows the same frame. Frames asked for wait until `advance` runs them,
 * one frame per call, at the new time. A frame asked for while one runs waits for the next call.
 * The Web Animations it holds are set to its time on each move.
 */
export class ManualClock implements Clock {
  private time = 0;
  private nextHandle = 1;
  private readonly waiting = new Map<number, FrameRequestCallback>();
  /** The animations on this clock, and when each began. */
  private readonly held = new Map<HeldAnimation, number>();

  now = (): number => this.time;

  requestAnimationFrame = (callback: FrameRequestCallback): number => {
    const handle = this.nextHandle++;
    this.waiting.set(handle, callback);
    return handle;
  };

  cancelAnimationFrame = (handle: number): void => {
    this.waiting.delete(handle);
  };

  /** True when a frame has been asked for and not run yet. */
  get asked(): boolean {
    return this.waiting.size > 0;
  }

  /** Move time forward by `ms` and run one frame. Answers how many frame callbacks ran. */
  advance(ms: number): number {
    return this.advanceTo(this.time + ms);
  }

  /**
   * Move time to `t` and run one frame: the callbacks asked for before this call, in the order
   * they were asked for. Time never goes back. Answers how many callbacks ran.
   */
  advanceTo(t: number): number {
    if (!(t >= this.time)) throw new RangeError(`The clock is at ${this.time} ms: it cannot go back to ${t} ms.`);
    this.time = t;
    const run = [...this.waiting.values()];
    this.waiting.clear();
    for (const callback of run) callback(t);
    for (const [animation, start] of this.held) this.setTo(animation, t - start);
    return run.length;
  }

  /**
   * Pause `animation` and keep it at the time since `start`, from now on. A cancelled animation
   * (`idle`) is not taken: pausing it would bring it back.
   */
  hold(animation: HeldAnimation, start: number = this.time): void {
    if (animation.playState === 'idle') return;
    animation.pause();
    this.held.set(animation, start);
    this.setTo(animation, this.time - start);
  }

  /** Take `animation` off the clock: it is not set again. */
  release(animation: HeldAnimation): void {
    this.held.delete(animation);
  }

  /**
   * Set an animation to a time; before its start, it shows its first frame. One that was
   * cancelled since (a picture landed at once under the owner's press) leaves the clock instead:
   * setting a time on it would bring it back, mid-flight.
   */
  private setTo(animation: HeldAnimation, ms: number): void {
    if (animation.playState === 'idle') this.held.delete(animation);
    else animation.currentTime = Math.max(0, ms);
  }

  /** True when `animation` is on this clock. */
  holds(animation: HeldAnimation): boolean {
    return this.held.has(animation);
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
