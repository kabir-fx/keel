import { describe, expect, it } from 'vitest';
import type { FrameScheduler } from '../src/frame';
import { FrameLoop, ManualClock, oncePerFrame } from '../src/frame';

/** Frames stepped by hand, with a clock that moves 16 ms a frame. */
function frames() {
  let next = 1;
  let time = 0;
  const waiting = new Map<number, FrameRequestCallback>();
  const scheduler: FrameScheduler = {
    requestAnimationFrame: (cb) => {
      waiting.set(next, cb);
      return next++;
    },
    cancelAnimationFrame: (id) => {
      waiting.delete(id);
    },
  };
  return {
    scheduler,
    now: () => time,
    /** How many frames have been asked for and not run or cancelled. */
    asked: () => waiting.size,
    /** Run the frame that waits. */
    step: () => {
      time += 16;
      const run = [...waiting.values()];
      waiting.clear();
      for (const cb of run) cb(time);
    },
  };
}

describe('the frame loop', () => {
  it('asks for no frame while nothing moves', () => {
    const f = frames();
    new FrameLoop(f.scheduler, f.now);
    expect(f.asked()).toBe(0);
  });

  it('runs a step once a frame, with the time since its last call, until it answers false', () => {
    const f = frames();
    const loop = new FrameLoop(f.scheduler, f.now);
    const seen: number[] = [];
    loop.start('glide', (dt) => {
      seen.push(dt);
      return seen.length < 3;
    });
    expect(seen).toEqual([]);
    expect(loop.running('glide')).toBe(true);
    f.step();
    f.step();
    f.step();
    expect(seen).toEqual([16, 16, 16]);
    expect(loop.running('glide')).toBe(false);
    expect(f.asked()).toBe(0);
  });

  it('shares one frame between every step', () => {
    const f = frames();
    const loop = new FrameLoop(f.scheduler, f.now);
    let a = 0;
    let b = 0;
    loop.start('a', () => ++a < 2);
    loop.start('b', () => ++b < 3);
    expect(f.asked()).toBe(1);
    f.step();
    expect(f.asked()).toBe(1);
    f.step();
    f.step();
    expect([a, b]).toEqual([2, 3]);
    expect(f.asked()).toBe(0);
  });

  it('leaves a key that is already running as it is', () => {
    const f = frames();
    const loop = new FrameLoop(f.scheduler, f.now);
    const ran: string[] = [];
    loop.start('k', () => {
      ran.push('first');
      return false;
    });
    loop.start('k', () => {
      ran.push('second');
      return false;
    });
    f.step();
    expect(ran).toEqual(['first']);
  });

  it('cancels a step, and gives the frame back when it was the last', () => {
    const f = frames();
    const loop = new FrameLoop(f.scheduler, f.now);
    let calls = 0;
    loop.start('k', () => {
      calls += 1;
      return true;
    });
    f.step();
    loop.cancel('k');
    expect(f.asked()).toBe(0);
    f.step();
    expect(calls).toBe(1);
    expect(loop.running('k')).toBe(false);
  });

  it('a step that starts another step runs it from the next frame', () => {
    const f = frames();
    const loop = new FrameLoop(f.scheduler, f.now);
    const ran: string[] = [];
    loop.start('a', () => {
      ran.push('a');
      loop.start('b', () => {
        ran.push('b');
        return false;
      });
      return false;
    });
    f.step();
    expect(ran).toEqual(['a']);
    f.step();
    expect(ran).toEqual(['a', 'b']);
    expect(f.asked()).toBe(0);
  });

  it('a step that cancels a later step stops it in the same frame', () => {
    const f = frames();
    const loop = new FrameLoop(f.scheduler, f.now);
    const ran: string[] = [];
    loop.start('a', () => {
      ran.push('a');
      loop.cancel('b');
      return false;
    });
    loop.start('b', () => {
      ran.push('b');
      return true;
    });
    f.step();
    expect(ran).toEqual(['a']);
    expect(f.asked()).toBe(0);
  });

  it('a step that replaces itself keeps the new one running', () => {
    const f = frames();
    const loop = new FrameLoop(f.scheduler, f.now);
    const ran: string[] = [];
    loop.start('k', () => {
      ran.push('old');
      loop.cancel('k');
      loop.start('k', () => {
        ran.push('new');
        return false;
      });
      return false;
    });
    f.step();
    expect(loop.running('k')).toBe(true);
    f.step();
    expect(ran).toEqual(['old', 'new']);
    expect(loop.running('k')).toBe(false);
  });

  it('stop ends every step and asks for no more frames', () => {
    const f = frames();
    const loop = new FrameLoop(f.scheduler, f.now);
    let calls = 0;
    loop.start('a', () => {
      calls += 1;
      return true;
    });
    loop.start('b', () => {
      calls += 1;
      return true;
    });
    loop.stop();
    expect(f.asked()).toBe(0);
    f.step();
    expect(calls).toBe(0);
  });
});

describe('once per frame', () => {
  it('makes many calls in a frame into one, with the latest arguments', () => {
    const f = frames();
    const seen: number[] = [];
    const draw = oncePerFrame((n: number) => seen.push(n), f.scheduler);
    draw(1);
    draw(2);
    draw(3);
    expect(seen).toEqual([]);
    expect(f.asked()).toBe(1);
    f.step();
    expect(seen).toEqual([3]);
    expect(f.asked()).toBe(0);
  });

  it('asks for a new frame for a call after the frame has run', () => {
    const f = frames();
    const seen: number[] = [];
    const draw = oncePerFrame((n: number) => seen.push(n), f.scheduler);
    draw(1);
    f.step();
    draw(2);
    f.step();
    expect(seen).toEqual([1, 2]);
  });

  it('flush runs the waiting call now, and the frame it asked for does nothing more', () => {
    const f = frames();
    const seen: number[] = [];
    const draw = oncePerFrame((n: number) => seen.push(n), f.scheduler);
    draw(7);
    draw.flush();
    expect(seen).toEqual([7]);
    expect(f.asked()).toBe(0);
    f.step();
    expect(seen).toEqual([7]);
  });

  it('flush with nothing waiting does nothing', () => {
    const f = frames();
    const seen: number[] = [];
    const draw = oncePerFrame((n: number) => seen.push(n), f.scheduler);
    draw.flush();
    expect(seen).toEqual([]);
  });

  it('cancel drops the waiting call', () => {
    const f = frames();
    const seen: number[] = [];
    const draw = oncePerFrame((n: number) => seen.push(n), f.scheduler);
    draw(1);
    draw.cancel();
    expect(f.asked()).toBe(0);
    f.step();
    expect(seen).toEqual([]);
    draw(2);
    f.step();
    expect(seen).toEqual([2]);
  });
});

/** A Web Animation as far as the clock touches it. `cancel` makes it idle, as `Animation.cancel` does. */
function fakeAnimation(currentTime: number | null = null) {
  return {
    paused: false,
    playState: 'running' as AnimationPlayState,
    currentTime: currentTime as CSSNumberish | null,
    pause() {
      this.paused = true;
      this.playState = 'paused';
    },
    cancel() {
      this.playState = 'idle';
      this.currentTime = null;
    },
  };
}

describe('the manual clock', () => {
  it('stands still until it is moved, and runs no frame by itself', () => {
    const clock = new ManualClock();
    const loop = new FrameLoop(clock, clock.now);
    let calls = 0;
    loop.start('k', () => ++calls < 10);
    expect(clock.now()).toBe(0);
    expect(calls).toBe(0);
    expect(clock.asked).toBe(true);
  });

  it('runs one frame per move, at the new time, with the time since the last call', () => {
    const clock = new ManualClock();
    const loop = new FrameLoop(clock, clock.now);
    const seen: number[] = [];
    loop.start('k', (dt) => {
      seen.push(dt);
      return true;
    });
    clock.advance(10);
    clock.advance(25);
    clock.advanceTo(100);
    expect(seen).toEqual([10, 25, 65]);
    expect(clock.now()).toBe(100);
    expect(loop.now()).toBe(100);
  });

  it('a frame asked for during a frame waits for the next move', () => {
    const clock = new ManualClock();
    const times: number[] = [];
    clock.requestAnimationFrame((t) => {
      times.push(t);
      clock.requestAnimationFrame((t2) => times.push(t2));
    });
    expect(clock.advance(16)).toBe(1);
    expect(times).toEqual([16]);
    expect(clock.advance(16)).toBe(1);
    expect(times).toEqual([16, 32]);
    expect(clock.advance(16)).toBe(0);
  });

  it('a cancelled frame does not run', () => {
    const clock = new ManualClock();
    let ran = false;
    const handle = clock.requestAnimationFrame(() => {
      ran = true;
    });
    clock.cancelAnimationFrame(handle);
    expect(clock.asked).toBe(false);
    clock.advance(16);
    expect(ran).toBe(false);
  });

  it('never goes back', () => {
    const clock = new ManualClock();
    clock.advanceTo(50);
    expect(() => clock.advanceTo(40)).toThrow('The clock is at 50 ms: it cannot go back to 40 ms.');
    expect(() => clock.advance(-1)).toThrow(RangeError);
    expect(clock.now()).toBe(50);
  });

  it('holds an animation paused at the time since it began, and moves it with the clock', () => {
    const clock = new ManualClock();
    clock.advanceTo(100);
    const anim = fakeAnimation();
    const loop = new FrameLoop(clock, clock.now);
    loop.hold(anim, 120);
    expect(anim.paused).toBe(true);
    // Before its start it shows its first frame.
    expect(anim.currentTime).toBe(0);
    clock.advanceTo(200);
    expect(anim.currentTime).toBe(80);
    expect(clock.holds(anim)).toBe(true);
  });

  it('a loop on it says it is manual; a loop on the page is not, and holds nothing', () => {
    const clock = new ManualClock();
    expect(new FrameLoop(clock, clock.now).manual).toBe(true);
    const f = frames();
    const page = new FrameLoop(f.scheduler, f.now);
    expect(page.manual).toBe(false);
    const anim = fakeAnimation(5);
    page.hold(anim);
    page.release(anim);
    expect(anim.paused).toBe(false);
    expect(anim.currentTime).toBe(5);
    expect(page.now()).toBe(0);
  });

  it('lets go of an animation that was cancelled: it is not set again, and leaves the clock', () => {
    const clock = new ManualClock();
    const landed = fakeAnimation();
    const other = fakeAnimation();
    clock.hold(landed, 0);
    clock.hold(other, 0);
    clock.advanceTo(50);
    landed.cancel();
    clock.advanceTo(100);
    // Setting a time on it would bring it back, mid-flight.
    expect(landed.currentTime).toBeNull();
    expect(clock.holds(landed)).toBe(false);
    expect(other.currentTime).toBe(100);
  });

  it('does not take an animation that is cancelled already', () => {
    const clock = new ManualClock();
    const anim = fakeAnimation();
    anim.cancel();
    clock.hold(anim);
    expect(anim.paused).toBe(false);
    expect(anim.currentTime).toBeNull();
    expect(clock.holds(anim)).toBe(false);
  });

  it('release takes an animation off the clock, and the clock still sets the others', () => {
    const clock = new ManualClock();
    const loop = new FrameLoop(clock, clock.now);
    const mine = fakeAnimation();
    const other = fakeAnimation();
    loop.hold(mine, 0);
    loop.hold(other, 0);
    clock.advanceTo(40);
    loop.release(mine);
    clock.advanceTo(90);
    expect(clock.holds(mine)).toBe(false);
    expect(mine.currentTime).toBe(40);
    expect(other.currentTime).toBe(90);
  });
});
