import { describe, expect, it } from 'vitest';
import type { FrameScheduler } from '../src/frame';
import { FrameLoop, oncePerFrame } from '../src/frame';

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
