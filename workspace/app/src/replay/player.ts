import type { FrameLoop } from '../frame';
import type { LocalSource } from '../source';
import type { PlayStep } from './script';

/** What a play is played into: a board in memory. */
export type Stage = Pick<LocalSource, 'feed' | 'setPresence'>;

/**
 * A step's time is reached when the time played is this close to it. The time played is a sum
 * of frame lengths, and a sum of sixtieths of a second can fall a hair short of a whole number.
 */
const HAIR = 1e-6;

/**
 * Plays a script into a board in memory, as one step of a frame loop: it adds up the time it is
 * told has passed and hands each moment of the script to the board when that time comes. It has
 * no timer of its own, so on a manual clock it moves only when the clock is moved.
 */
export class Player {
  private played = 0;
  private next = 0;
  private changed = false;

  constructor(
    private readonly stage: Stage,
    readonly script: readonly PlayStep[],
  ) {}

  /** How far the play has run, in ms. */
  get ms(): number {
    return this.played;
  }

  /** True once every moment of the script has reached the board. */
  get done(): boolean {
    return this.next >= this.script.length;
  }

  /** Play on `loop`, from its next frame. */
  start(loop: FrameLoop): void {
    if (!this.done) loop.start(this, this.step);
  }

  /** True when a moment reached the board since the last time this was asked. */
  takeChanged(): boolean {
    const was = this.changed;
    this.changed = false;
    return was;
  }

  /** One frame: `dt` more ms have passed. */
  step = (dt: number): boolean => {
    this.played += dt;
    while (!this.done && this.script[this.next]!.at <= this.played + HAIR) {
      const moment = this.script[this.next++]!;
      if (moment.events?.length) this.stage.feed(moment.events);
      if (moment.presence) this.stage.setPresence(moment.presence);
      this.changed = true;
    }
    return !this.done;
  };
}
