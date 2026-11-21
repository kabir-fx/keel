import type { BoardEvent, Box } from '@keel/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import type { Mock } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, PEN_PAUSE } from '../src/App';
import type { FrameScheduler } from '../src/frame';
import type { PointerInput, Pointers } from '../src/input/pointers';
import { createPointers } from '../src/input/pointers';
import { localSource } from '../src/source';
import { createTools, toolFor } from '../src/tools';
import type { EndReason, Press, Sample, Tool } from '../src/tools/types';
import { fakeBoard } from './fakeBoard';
import { CH, note, openBoard, placeAt, text } from './helpers';
import { Keyboard, Pointer, frame, resetInput } from './pointer';

/**
 * The pointer on the board (`src/input/pointers.ts`): presses by pointer id, moves once a
 * frame, the one way a press ends, the press held back on a picture's button, the buttons that
 * start nothing, and the browser's own menu and drag.
 *
 * The first half drives the dispatcher alone, with frames stepped by hand, against a tool that
 * writes down what it hears or the real tools on a fake board. The second half is the app.
 */

/** What the picture double was asked to do: its button by item id, its part as `tap:<id>`. */
const pressed = vi.hoisted(() => [] as string[]);

// The pictures are a test double: each draws one part and one button, and writes down their clicks.
vi.mock('@keel/pictures', () => ({
  Star: () => null,
  StateChip: () => null,
  Picture: ({ item }: { item: { id: string } }) =>
    createElement(
      'div',
      { 'data-double': item.id },
      createElement('div', { 'data-sub': 'part:queue', onClick: () => pressed.push(`tap:${item.id}`) }, 'the queue'),
      createElement('button', { type: 'button', onClick: () => pressed.push(item.id) }, `step ${item.id}`),
    ),
}));

/** What a test put on the window, taken off after it. */
const tidy: Array<() => void> = [];

afterEach(() => {
  cleanup();
  resetInput();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const off of tidy.splice(0)) off();
  // A press ends whatever still waits for the click of the last lift.
  window.dispatchEvent(new Event('pointerdown'));
  pressed.length = 0;
});

/* ------------------------------------------------------------------ the dispatcher alone */

/** Frames stepped by hand. */
function frames() {
  let next = 1;
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
    /** How many frames are asked for and not run or dropped. */
    asked: () => waiting.size,
    /** Run the frame that waits. */
    step: () => {
      const run = [...waiting.values()];
      waiting.clear();
      for (const cb of run) cb(0);
    },
  };
}

interface EventOver {
  id?: number;
  button?: number;
  ctrl?: boolean;
  coalesced?: Array<[number, number]>;
  target?: Element;
  /** The element whose handler hears the event: the board. */
  on?: Element;
}

/** A pointer event as the dispatcher reads it. `coalesced` are the samples the browser collected for a move. */
function event(x: number, y: number, over: EventOver = {}): PointerInput & { preventDefault: Mock<() => void> } {
  return {
    pointerId: over.id ?? 7,
    pointerType: 'mouse',
    button: over.button ?? 0,
    clientX: x,
    clientY: y,
    pressure: 0.5,
    timeStamp: 1,
    target: over.target ?? null,
    currentTarget: over.on ?? null,
    shiftKey: false,
    altKey: false,
    ctrlKey: over.ctrl ?? false,
    metaKey: false,
    preventDefault: vi.fn<() => void>(),
    getCoalescedEvents: () => (over.coalesced ?? []).map(([cx, cy]) => ({ clientX: cx, clientY: cy, pressure: 0.5, timeStamp: 1 })),
  };
}

interface Heard {
  call: 'down' | 'move' | 'up' | 'cancel';
  /** Where the press says the pointer is: its last sample, and the same place in page pixels. */
  at: number;
  client: number;
  ctrl: boolean;
  moved: boolean;
  /** The samples of the call, as given. */
  samples: readonly Sample[];
  why?: EndReason;
}

/** A tool that writes down what it is handed. */
function recorder() {
  const heard: Heard[] = [];
  const hear = (call: Heard['call'], press: Press, why?: EndReason) => {
    heard.push({ call, at: press.at.x, client: press.client[0], ctrl: press.mods.ctrl, moved: press.moved, samples: press.samples, ...(why ? { why } : {}) });
  };
  const tool: Tool = {
    down: (press) => {
      hear('down', press);
      return true;
    },
    move: (press) => hear('move', press),
    up: (press) => hear('up', press),
    cancel: (press, _board, why) => hear('cancel', press, why),
  };
  return { tool, heard, calls: () => heard.map((h) => h.call), xs: () => heard.at(-1)?.samples.map((s) => s.x) };
}

/** A dispatcher on a fake board, with a tool that writes down what it hears and frames stepped by hand. */
function alone(over: Parameters<typeof fakeBoard>[0] = {}) {
  const f = frames();
  const fake = fakeBoard(over);
  const r = recorder();
  const picked: Press[] = [];
  const pointers = createPointers(
    fake.board,
    (press) => {
      picked.push(press);
      return r.tool;
    },
    f.scheduler,
  );
  return { ...fake, ...r, f, pointers, picked };
}

describe('moves reach the tool once a frame', () => {
  it('samples that arrive between two frames reach the tool in one call, in order', () => {
    const { pointers, f, heard, calls, xs } = alone();
    pointers.down(event(0, 0));
    pointers.move(event(10, 0));
    pointers.move(event(20, 0, { coalesced: [[12, 0], [16, 0], [20, 0]] }));
    pointers.move(event(30, 0));
    expect(calls()).toEqual(['down']);
    expect(f.asked()).toBe(1);
    f.step();
    expect(calls()).toEqual(['down', 'move']);
    expect(xs()).toEqual([10, 12, 16, 20, 30]);
    expect(heard.at(-1)).toMatchObject({ at: 30, moved: true });
  });

  it('a frame with nothing waiting is not asked for, and the next samples are a new call', () => {
    const { pointers, f, calls, xs } = alone();
    pointers.down(event(0, 0));
    pointers.move(event(10, 0));
    f.step();
    expect(f.asked()).toBe(0);
    pointers.move(event(20, 0));
    pointers.move(event(25, 0));
    f.step();
    expect(calls()).toEqual(['down', 'move', 'move']);
    expect(xs()).toEqual([20, 25]);
  });

  it('a down, a move and an up inside one frame lose nothing', () => {
    const { pointers, f, heard, calls } = alone();
    pointers.down(event(0, 0));
    pointers.move(event(10, 0));
    pointers.move(event(20, 0));
    pointers.up(event(25, 0));
    expect(calls()).toEqual(['down', 'move', 'up']);
    expect(heard[1]!.samples.map((s) => s.x)).toEqual([10, 20]);
    expect(heard[2]).toMatchObject({ at: 25, moved: true, samples: [] });
    // The frame that was asked for is not needed any more, and hands over nothing if it comes.
    expect(f.asked()).toBe(0);
  });

  it('each sample has its world point by the camera as it was when the sample came, not when it is handed over', () => {
    const { pointers, f, heard, camera } = alone();
    pointers.down(event(0, 0));
    pointers.move(event(20, 0));
    camera.set({ x: 10, y: 0, z: 2 });
    pointers.move(event(20, 0));
    f.step();
    expect(heard.at(-1)!.samples.map((s) => [s.x, s.wx])).toEqual([
      [20, 20],
      [20, 5],
    ]);
  });

  it('a move says where the pointer is and which keys are held, as of its last event', () => {
    const { pointers, f, heard } = alone();
    pointers.down(event(0, 0));
    pointers.move(event(10, 0, { ctrl: true }));
    pointers.move(event(30, 0, { coalesced: [[20, 0], [30, 0]] }));
    f.step();
    expect(heard.at(-1)).toMatchObject({ call: 'move', at: 30, client: 30, ctrl: false });
    pointers.move(event(40, 0, { ctrl: true }));
    pointers.up(event(41, 0));
    expect(heard.at(-2)).toMatchObject({ call: 'move', at: 40, client: 40, ctrl: true });
    expect(heard.at(-1)).toMatchObject({ call: 'up', at: 41, client: 41, ctrl: false });
  });

  it('flush hands over what waits now, for the wheel, and then nothing waits', () => {
    const { pointers, f, calls, xs } = alone();
    pointers.flush();
    pointers.down(event(0, 0));
    pointers.move(event(10, 0));
    pointers.flush();
    expect(calls()).toEqual(['down', 'move']);
    expect(xs()).toEqual([10]);
    expect(f.asked()).toBe(0);
    pointers.flush();
    f.step();
    expect(calls()).toEqual(['down', 'move']);
  });

  it('where the pointer last was is kept on every event, before any frame and with no press open', () => {
    const { pointers } = alone();
    expect(pointers.last()).toBeNull();
    pointers.move(event(12, 34));
    expect(pointers.last()).toEqual({ x: 12, y: 34 });
    pointers.down(event(50, 60));
    pointers.move(event(70, 80, { id: 9 }));
    expect(pointers.last()).toEqual({ x: 70, y: 80 });
  });

  it('a lift says where the pointer last was, also with no move since the press', () => {
    const { pointers } = alone();
    pointers.down(event(50, 60));
    pointers.up(event(90, 20));
    expect(pointers.last()).toEqual({ x: 90, y: 20 });
    pointers.down(event(50, 60));
    pointers.cancel(event(30, 40));
    expect(pointers.last()).toEqual({ x: 30, y: 40 });
  });
});

describe('a press is one pointer’s', () => {
  it('an event from another pointer id changes nothing', () => {
    const { pointers, f, calls, heard } = alone();
    const board = document.createElement('div');
    pointers.down(event(0, 0));
    pointers.move(event(50, 0, { id: 8 }));
    f.step();
    pointers.up(event(50, 0, { id: 8 }));
    pointers.cancel(event(50, 0, { id: 8 }));
    pointers.lost(event(50, 0, { id: 8, target: board, on: board }));
    expect(calls()).toEqual(['down']);
    expect(pointers.open()).toBe(true);
    // The press's own pointer still moves and ends it, from where it was: not from the other pointer's place.
    pointers.move(event(6, 0));
    pointers.up(event(6, 0));
    expect(calls()).toEqual(['down', 'move', 'up']);
    expect(heard.at(-1)).toMatchObject({ at: 6 });
    expect(pointers.open()).toBe(false);
  });
});

describe('a press ends in exactly one way', () => {
  const board = document.createElement('div');
  const ENDINGS: Array<[why: EndReason, end: (p: Pointers) => void]> = [
    ['up', (p) => p.up(event(60, 0))],
    ['cancel', (p) => p.cancel(event(0, 0))],
    ['lost', (p) => p.lost(event(0, 0, { target: board, on: board }))],
    ['blur', (p) => p.end('blur')],
    ['escape', (p) => p.end('escape')],
    // A new press, even one that starts nothing itself: the open one never got its up.
    ['superseded', (p) => p.down(event(80, 0, { button: 2 }))],
  ];

  it('only a lift is the tool’s up; every other ending is its cancel, and says why', () => {
    for (const [why, end] of ENDINGS) {
      const { pointers, heard, calls } = alone();
      pointers.down(event(0, 0));
      pointers.move(event(50, 0));
      expect(pointers.open()).toBe(true);
      end(pointers);
      // The move that waited for its frame comes first, so the tool ends from where the pointer got to.
      expect(calls(), why).toEqual(['down', 'move', why === 'up' ? 'up' : 'cancel']);
      expect(heard.at(-1)!.why, why).toBe(why === 'up' ? undefined : why);
      expect(heard.at(-1)!.at, why).toBe(why === 'up' ? 60 : 50);
      expect(pointers.open(), why).toBe(false);
      expect(pointers.tool(), why).toBeUndefined();
    }
  });

  it('once it has ended, no later ending reaches the tool: not the loss of capture after a lift, nor a blur', () => {
    for (const [why, end] of ENDINGS) {
      const { pointers, f, calls } = alone();
      pointers.down(event(0, 0));
      end(pointers);
      const n = calls().length;
      pointers.lost(event(0, 0, { target: board, on: board }));
      pointers.up(event(0, 0));
      pointers.cancel(event(0, 0));
      pointers.end('blur');
      pointers.end('escape');
      pointers.move(event(90, 0));
      f.step();
      expect(calls().length, why).toBe(n);
    }
  });

  it('a new press ends the one whose up never came, then begins', () => {
    const { pointers, heard, calls } = alone();
    pointers.down(event(0, 0));
    pointers.move(event(50, 0));
    pointers.down(event(200, 0));
    expect(calls()).toEqual(['down', 'move', 'cancel', 'down']);
    expect(heard[2]).toMatchObject({ why: 'superseded', at: 50 });
    expect(heard[3]).toMatchObject({ at: 200, moved: false });
    expect(pointers.open()).toBe(true);
  });

  it('a capture lost by something inside the board is not the board’s: the press stays open', () => {
    const { pointers, calls } = alone();
    const inside = document.createElement('span');
    board.append(inside);
    pointers.down(event(0, 0));
    pointers.lost(event(0, 0, { target: inside, on: board }));
    expect(calls()).toEqual(['down']);
    expect(pointers.open()).toBe(true);
  });

  it('after Esc the board keeps the pointer, so the lift that follows is no click for what is under it', () => {
    const { pointers, did } = alone();
    pointers.down(event(0, 0));
    expect(did.captured).toEqual([]);
    pointers.end('escape');
    expect(did.captured).toEqual([7]);
    // Any other ending leaves the pointer alone.
    pointers.down(event(0, 0, { id: 9 }));
    pointers.end('blur');
    expect(did.captured).toEqual([7]);
  });

  it('with no press open, an ending does nothing', () => {
    const { pointers, calls, did } = alone();
    pointers.end('blur');
    pointers.end('escape');
    pointers.up(event(0, 0));
    pointers.cancel(event(0, 0));
    expect(calls()).toEqual([]);
    expect(did.captured).toEqual([]);
  });
});

describe('the page is told while a press is open', () => {
  const board = document.createElement('div');
  const ENDINGS: Array<[why: EndReason, end: (p: Pointers) => void]> = [
    ['up', (p) => p.up(event(60, 0))],
    ['cancel', (p) => p.cancel(event(0, 0))],
    ['lost', (p) => p.lost(event(0, 0, { target: board, on: board }))],
    ['blur', (p) => p.end('blur')],
    ['escape', (p) => p.end('escape')],
    ['superseded', (p) => p.down(event(80, 0, { button: 2 }))],
  ];

  it('once as the press begins, and once as it ends, whichever way it ends', () => {
    for (const [why, end] of ENDINGS) {
      const { pointers, did } = alone();
      expect(did.pressing, why).toEqual([]);
      pointers.down(event(0, 0));
      pointers.move(event(50, 0));
      expect(did.pressing, why).toEqual([true]);
      end(pointers);
      expect(did.pressing, why).toEqual([true, false]);
    }
  });

  it('a press that starts nothing is not told: the right button, a field that is open, a tool that does not take it', () => {
    const right = alone();
    right.pointers.down(event(0, 0, { button: 2 }));
    const typing = alone({ editing: true });
    typing.pointers.down(event(0, 0));
    const refused = alone();
    refused.tool.down = () => false;
    refused.pointers.down(event(0, 0));
    expect([right.did.pressing, typing.did.pressing, refused.did.pressing]).toEqual([[], [], []]);
  });

  it('a press held back on a control is open from the first: the chrome stands still for a click on a picture’s button too', () => {
    const a = alone({ tool: 'pen' });
    const button = document.createElement('button');
    a.el.append(button);
    a.pointers.down(event(100, 100, { target: button }));
    expect(a.did.pressing).toEqual([true]);
    a.pointers.up(event(100, 100, { target: button }));
    expect(a.did.pressing).toEqual([true, false]);
  });

  it('a held-back press the tool does not take once it is a drag is let go, and the page is told', () => {
    const a = alone({ tool: 'pen' });
    const button = document.createElement('button');
    a.el.append(button);
    a.tool.down = () => false;
    a.pointers.down(event(100, 100, { target: button }));
    a.pointers.move(event(140, 100, { target: button }));
    expect(a.pointers.open()).toBe(false);
    expect(a.did.pressing).toEqual([true, false]);
  });
});

describe('the buttons that start a press', () => {
  const mac = (on: boolean) => vi.spyOn(navigator, 'platform', 'get').mockReturnValue(on ? 'MacIntel' : 'Win32');

  it('the right button starts nothing, whatever the tool: no tool is even asked', () => {
    for (const tool of ['select', 'pan', 'pen'] as const) {
      const { pointers, picked, calls } = alone({ tool });
      pointers.down(event(0, 0, { button: 2 }));
      pointers.move(event(50, 0, { button: 2 }));
      pointers.up(event(50, 0, { button: 2 }));
      expect(picked).toHaveLength(0);
      expect(calls()).toEqual([]);
      expect(pointers.open()).toBe(false);
    }
  });

  it('on a Mac a Ctrl-click is a right-click and starts nothing; on another machine it is a press with Ctrl held', () => {
    mac(true);
    const onMac = alone();
    onMac.pointers.down(event(0, 0, { ctrl: true }));
    expect(onMac.picked).toHaveLength(0);
    expect(onMac.pointers.open()).toBe(false);

    mac(false);
    const elsewhere = alone();
    elsewhere.pointers.down(event(0, 0, { ctrl: true }));
    expect(elsewhere.calls()).toEqual(['down']);
    expect(elsewhere.picked[0]!.mods.ctrl).toBe(true);
  });

  it('the main button and the middle button start one, and the middle one does not start the browser’s own scroll', () => {
    const { pointers, calls } = alone();
    const main = event(0, 0);
    pointers.down(main);
    pointers.up(event(0, 0));
    expect(main.preventDefault).not.toHaveBeenCalled();
    const middle = event(0, 0, { button: 1 });
    pointers.down(middle);
    expect(middle.preventDefault).toHaveBeenCalled();
    expect(calls()).toEqual(['down', 'up', 'down']);
  });
});

describe('a press on a control inside an item, with a drawing tool in hand, is held back', () => {
  /** A fake board whose one item has a button in it, and a press on that button. */
  function onButton(over: Parameters<typeof fakeBoard>[0] = { tool: 'pen' }) {
    const a = alone(over);
    const button = document.createElement('button');
    a.el.append(button);
    return { ...a, button, at: (x: number, y = 100) => event(x, y, { target: button }) };
  }

  it('a click: the tool is not told, the pointer is not captured, and the click is left to the control', () => {
    const { pointers, f, at, calls, did } = onButton();
    const swallowed = vi.fn();
    window.addEventListener('click', swallowed);
    tidy.push(() => window.removeEventListener('click', swallowed));
    pointers.down(at(100));
    expect(pointers.open()).toBe(true);
    expect(pointers.tool()).toBeUndefined();
    pointers.move(at(103));
    f.step();
    pointers.up(at(103));
    expect(calls()).toEqual([]);
    expect(did.captured).toEqual([]);
    expect(pointers.open()).toBe(false);
    window.dispatchEvent(new Event('click'));
    expect(swallowed).toHaveBeenCalledTimes(1);
  });

  it('at 10 pixels it is still a click', () => {
    const { pointers, f, at, calls } = onButton();
    pointers.down(at(100));
    pointers.move(at(110));
    f.step();
    expect(calls()).toEqual([]);
    expect(f.asked()).toBe(0);
    pointers.up(at(110));
    expect(calls()).toEqual([]);
  });

  it('at 11 pixels the press becomes the tool’s: down at the first point, then every sample so far', () => {
    const { pointers, f, at, heard, calls, xs } = onButton();
    pointers.down(at(100));
    pointers.move(at(104));
    pointers.move(at(110));
    expect(calls()).toEqual([]);
    pointers.move(at(111));
    expect(calls()).toEqual(['down']);
    // The tool is handed the press as it went down, not as it is now.
    expect(heard[0]).toMatchObject({ at: 100, client: 100, moved: false, samples: [] });
    expect(pointers.tool()).toBeDefined();
    f.step();
    expect(calls()).toEqual(['down', 'move']);
    expect(xs()).toEqual([104, 110, 111]);
    expect(heard[1]).toMatchObject({ at: 111, client: 111, moved: true });
    pointers.move(at(130));
    pointers.up(at(130));
    expect(calls()).toEqual(['down', 'move', 'move', 'up']);
  });

  it('the click the browser sends when that drag lifts is swallowed; the next click is not', () => {
    const { pointers, at } = onButton();
    const clicks = vi.fn();
    window.addEventListener('click', clicks);
    tidy.push(() => window.removeEventListener('click', clicks));
    pointers.down(at(100));
    pointers.move(at(120));
    pointers.up(at(120));
    const lift = new Event('click', { cancelable: true });
    window.dispatchEvent(lift);
    expect(clicks).not.toHaveBeenCalled();
    expect(lift.defaultPrevented).toBe(true);
    window.dispatchEvent(new Event('click'));
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('when no click comes with the lift, the next press ends the wait: its own click goes through', () => {
    vi.useFakeTimers();
    const { pointers, at } = onButton();
    const clicks = vi.fn();
    window.addEventListener('click', clicks);
    tidy.push(() => window.removeEventListener('click', clicks));
    pointers.down(at(100));
    pointers.move(at(120));
    pointers.up(at(120));
    window.dispatchEvent(new Event('pointerdown'));
    window.dispatchEvent(new Event('click'));
    expect(clicks).toHaveBeenCalledTimes(1);

    // And so does the end of the lift's own turn.
    pointers.down(at(100));
    pointers.move(at(120));
    pointers.up(at(120));
    vi.advanceTimersByTime(0);
    window.dispatchEvent(new Event('click'));
    expect(clicks).toHaveBeenCalledTimes(2);
  });

  it('a held-back press that ends any other way was never the tool’s: the tool hears nothing', () => {
    const board = document.createElement('div');
    const ends: Array<(p: Pointers) => void> = [(p) => p.cancel(event(0, 0)), (p) => p.lost(event(0, 0, { target: board, on: board })), (p) => p.end('blur'), (p) => p.end('escape')];
    for (const end of ends) {
      const { pointers, f, at, calls } = onButton();
      pointers.down(at(100));
      pointers.move(at(105));
      end(pointers);
      expect(pointers.open()).toBe(false);
      pointers.move(at(140));
      f.step();
      expect(calls()).toEqual([]);
    }
  });

  it('a new press over a held-back one starts as its own', () => {
    const { pointers, at, calls, heard } = onButton();
    pointers.down(at(100));
    pointers.down(event(300, 100));
    expect(calls()).toEqual(['down']);
    expect(heard[0]).toMatchObject({ at: 300 });
  });

  it('every drawing tool holds back; Select, Pan, Note and Pin are told at once', () => {
    for (const tool of ['pen', 'box', 'arrow', 'lasso'] as const) {
      const { pointers, at, calls } = onButton({ tool });
      pointers.down(at(100));
      expect(calls(), tool).toEqual([]);
    }
    for (const tool of ['select', 'pan', 'note', 'pin'] as const) {
      const { pointers, at, calls } = onButton({ tool });
      pointers.down(at(100));
      expect(calls(), tool).toEqual(['down']);
    }
  });

  it('not in another hand, not with Space held, not with the middle button, and not on a control outside any item', () => {
    for (const over of [{ tool: 'pen', isOwner: false }, { tool: 'pen', spaceHeld: true }] as const) {
      const { pointers, at, calls } = onButton(over);
      pointers.down(at(100));
      expect(calls()).toEqual(['down']);
    }
    const middle = onButton();
    middle.pointers.down(event(100, 100, { target: middle.button, button: 1 }));
    expect(middle.calls()).toEqual(['down']);
    const loose = onButton();
    loose.pointers.down(event(100, 100, { target: document.createElement('button') }));
    expect(loose.calls()).toEqual(['down']);
  });

  it('a press on a part inside a button is on the button', () => {
    const { pointers, button, calls } = onButton();
    const icon = document.createElement('span');
    button.append(icon);
    pointers.down(event(100, 100, { target: icon }));
    expect(calls()).toEqual([]);
    expect(pointers.open()).toBe(true);
  });
});

/* ------------------------------------------------------------------ the real tools, on a fake board */

/** A dispatcher with the board's real tools, on a fake board with one note, `m1`, at 0,0 and 320 by 100. */
function withTools(tool: 'select' | 'pen' | 'box' | 'arrow' | 'lasso') {
  const f = frames();
  const fake = fakeBoard({ tool });
  // A loop round the note holds it.
  fake.board.measureAll = () => [{ id: 'm1', item: 'm1', box: [0, 0, 320, 100] }];
  const tools = createTools();
  const pointers = createPointers(fake.board, (press) => toolFor(tools, press, fake.board), f.scheduler);
  /** What the tools handed the board to post, or to post once it has its words. */
  const handed = () => fake.did.marks.length + fake.did.labels.length + fake.did.sent.length;
  // The overlay's SVG, where the lasso's trail is drawn.
  const trails = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  fake.hand.trails.mount(trails);
  return { ...fake, f, tools, pointers, handed, trails };
}

type Path = ReadonlyArray<readonly [number, number]>;

/** A loop round the note, a drag from one corner of it past the other, and a drag of the note itself. */
const LOOP: Path = [[-20, -20], [160, -24], [340, -20], [344, 50], [340, 120], [160, 124], [-20, 120], [-24, 50], [-20, -22]];
const ACROSS: Path = [[-20, -20], [160, 50], [340, 120]];
const CARRY: Path = [[10, 10], [60, 40], [110, 70]];

/** One gesture for each tool that hands the board something when it ends with a lift. */
const PATHS: Record<'select' | 'pen' | 'box' | 'arrow' | 'lasso', Path> = { select: CARRY, pen: LOOP, lasso: LOOP, box: ACROSS, arrow: ACROSS };

/** Make a tool's gesture up to its last point, with the pointer still down. Answers the lift that would end it. */
function gesture(pointers: Pointers, tool: keyof typeof PATHS, target: Element): PointerInput {
  const over = tool === 'select' ? { target } : {};
  const [first, ...rest] = PATHS[tool].map(([x, y]) => event(x, y, over));
  if (!first) throw new Error('a gesture has a first point');
  pointers.down(first);
  for (const e of rest) pointers.move(e);
  return rest.at(-1) ?? first;
}

describe('a press that is cut short posts nothing, where a lift would have posted', () => {
  const board = document.createElement('div');
  const CUTS: Array<[why: string, cut: (p: Pointers) => void]> = [
    ['cancel', (p) => p.cancel(event(0, 0))],
    ['lost', (p) => p.lost(event(0, 0, { target: board, on: board }))],
    ['blur', (p) => p.end('blur')],
    ['escape', (p) => p.end('escape')],
    ['superseded', (p) => p.down(event(0, 0, { button: 2 }))],
  ];

  for (const tool of ['pen', 'box', 'arrow', 'lasso', 'select'] as const) {
    const name = tool === 'select' ? 'a move' : `the ${tool}`;

    it(`${name}: a lift hands the board one thing to post`, async () => {
      vi.useFakeTimers();
      const { pointers, el, handed } = withTools(tool);
      pointers.up(gesture(pointers, tool, el));
      await vi.advanceTimersByTimeAsync(PEN_PAUSE);
      expect(handed()).toBe(1);
    });

    it(`${name}: a cancel, a lost capture, a blur, Esc and a new press all post nothing and leave no trace`, async () => {
      vi.useFakeTimers();
      for (const [why, cut] of CUTS) {
        const { pointers, f, el, hand, did, handed, tools, trails } = withTools(tool);
        gesture(pointers, tool, el);
        f.step();
        // The gesture is under way: the live layer shows it, or its trail does, or the item is moved by its style.
        if (tool === 'select') expect(el.style.translate, why).toBe('100px 60px');
        else if (tool === 'pen') expect(hand.get().strokes, why).toHaveLength(1);
        else if (tool === 'lasso') expect(trails.querySelectorAll('path.trail--lasso'), why).toHaveLength(1);
        else expect(hand.get().shape?.kind, why).toBe(tool);
        cut(pointers);
        await vi.advanceTimersByTimeAsync(PEN_PAUSE * 2);
        expect(handed(), why).toBe(0);
        expect(did.said, why).toEqual([]);
        expect(hand.get().strokes, why).toEqual([]);
        expect(hand.get().shape, why).toBeUndefined();
        expect(trails.children, why).toHaveLength(0);
        expect(el.getAttributeNames().filter((n) => n.startsWith('data-') && n !== 'data-item'), why).toEqual([]);
        expect(el.style.translate, why).toBe('');
        expect(el.getAttribute('style') ?? '', why).toBe('');
        expect(el.className, why).toBe('');
        expect(did.pending, why).toEqual([]);
        // The selection the press cleared is back.
        expect(did.selected, why).toBe('m1');
        expect(tools.select.moving(), why).toBe(false);
        expect(tools.pen.open(), why).toBe(false);
      }
    });
  }

  it('a cancelled pen stroke drops that stroke only: the strokes before it stay, and still become one mark after the pause', async () => {
    vi.useFakeTimers();
    const { pointers, hand, did } = withTools('pen');
    pointers.down(event(10, 10));
    pointers.move(event(80, 10));
    pointers.up(event(80, 10));
    await vi.advanceTimersByTimeAsync(PEN_PAUSE - 100);
    pointers.down(event(10, 40));
    pointers.move(event(80, 40));
    expect(hand.get().strokes).toHaveLength(2);
    pointers.cancel(event(0, 0));
    expect(hand.get().strokes).toHaveLength(1);
    // The pause counts again from the cut: the go is not made a mark early, and not forgotten.
    await vi.advanceTimersByTimeAsync(PEN_PAUSE - 100);
    expect(did.marks).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(did.marks).toHaveLength(1);
    expect(did.marks[0]).toMatchObject({ kind: 'ink', strokes: [{ pts: [0, 0, 70, 0] }] });
  });

  it('the next press works after each: a move that was cut short can be made again', () => {
    for (const [why, cut] of CUTS) {
      const { pointers, el, did } = withTools('select');
      gesture(pointers, 'select', el);
      cut(pointers);
      pointers.up(gesture(pointers, 'select', el));
      expect(did.sent, why).toEqual([{ type: 'item.update', item: 'm1', patch: { box: [100, 60, 320, 100] } }]);
      expect(el.style.translate, why).toBe('');
    }
  });

  it('a look round with Select that is cut short stays where the pointer got to: the hand lets go, and nothing is selected or posted', () => {
    for (const [why, cut] of CUTS) {
      const { pointers, camera, did, handed } = withTools('select');
      pointers.down(event(500, 400));
      pointers.move(event(530, 410));
      pointers.flush();
      expect(camera.grip(), why).toBe('moving');
      // This move still waits for its frame when the press is cut: it is not lost.
      pointers.move(event(560, 430));
      cut(pointers);
      expect(camera.get(), why).toEqual({ x: 60, y: 30, z: 1 });
      expect(camera.grip(), why).toBe('none');
      expect(did.selected, why).toBe('m1');
      expect(did.dragEnds, why).toBe(0);
      expect(handed(), why).toBe(0);
    }
  });

  it('the pen on the item’s button: a click makes no ink, and a drag draws from the first point', async () => {
    vi.useFakeTimers();
    const { pointers, f, el, hand, did } = withTools('pen');
    const button = document.createElement('button');
    el.append(button);
    pointers.down(event(100, 50, { target: button }));
    pointers.move(event(110, 50, { target: button }));
    f.step();
    pointers.up(event(110, 50, { target: button }));
    expect(hand.get().strokes).toEqual([]);
    expect(did.captured).toEqual([]);
    expect(did.selected).toBe('m1');

    pointers.down(event(100, 50, { target: button }));
    pointers.move(event(105, 50, { target: button }));
    pointers.move(event(111, 50, { target: button }));
    f.step();
    expect(hand.get().strokes.map((s) => s.map((p) => p[0]))).toEqual([[100, 105, 111]]);
    expect(did.captured).toEqual([7]);
    pointers.up(event(111, 50, { target: button }));
    await vi.advanceTimersByTimeAsync(PEN_PAUSE);
    expect(did.marks).toHaveLength(1);
    expect(did.marks[0]!.box).toEqual([100, 50, 11, 0]);
  });

  it('the lasso keeps every sample of a frame, so a fast loop is still a loop', () => {
    const { pointers, el, did } = withTools('lasso');
    pointers.up(gesture(pointers, 'lasso', el));
    expect(did.marks).toHaveLength(1);
    expect(did.marks[0]).toMatchObject({ kind: 'lasso', targets: [{ item: 'm1' }] });
  });
});

/* ------------------------------------------------------------------ the app */

/** A board with a note of the owner's, `m1`, and a card of the agent's, `a1`, with a button and a part on it. */
function open(focus = false) {
  const b = openBoard();
  b.must('agent', { type: 'model.patch', ops: [{ op: 'lane.set', lane: { id: 'bridge', name: 'Bridge' } }, { op: 'part.set', part: { id: 'queue', name: 'The queue', lane: 'bridge' } }] });
  b.must('owner', note('m1', [0, 0, 320, 100]));
  b.must('agent', text('a1', { answers: ['m1'] }));
  b.must('owner', placeAt('a1', [400, 0, 380, 200]));
  if (focus) {
    b.must('agent', { type: 'item.add', chapter: CH, item: { id: 'f1', kind: 'picture', picture: { kind: 'focus', part: 'queue', title: 'The queue' }, from: ['a1'] } });
    b.must('owner', placeAt('f1', [3000, 3000, 400, 300]));
  }
  const src = localSource({ events: b.events });
  const { container } = render(<App source={src} {...(focus ? { focus: 'f1' } : {})} />);
  const n = src.events.length;
  return {
    src,
    container,
    /** What was posted since the board opened. */
    posted: (): BoardEvent[] => src.events.slice(n),
    board: screen.getByTestId('board'),
    note: container.querySelector<HTMLElement>('[data-item="m1"]')!,
    part: container.querySelector<HTMLElement>('[data-item="a1"] [data-sub="part:queue"]')!,
    button: screen.getByRole('button', { name: 'step a1' }),
  };
}

/** The camera, read back from the world's transform: screen = world * z + (x, y). */
function camera(container: HTMLElement) {
  const t = container.querySelector<HTMLElement>('.world')!.style.transform;
  const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(t)!;
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}

const tool = () => document.querySelector('.app')!.getAttribute('data-tool');
const ink = () => screen.getByTestId('live').querySelectorAll('svg.ink');
const shape = () => screen.getByTestId('live').querySelector<HTMLElement>('.live-box, .live-line');
/** A shape being drawn in the live layer, or a lasso's trail in the overlay. */
const drawing = () => shape() ?? screen.getByTestId('trails').querySelector('path');
const label = () => screen.queryByRole('textbox', { name: 'A few words' });
const selected = (el: HTMLElement) => el.className.includes('item--selected');
const dragging = (el: HTMLElement) => el.style.translate !== '' || el.className.includes('item--dragging');

/** Let the pen's pause pass, and the marks it makes be posted. */
async function rest() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PEN_PAUSE + 50);
  });
}

/** Let what a lift posted land. */
const settle = () => act(async () => {});

/** Send an event to the window or the page, as the browser would. */
function tell(target: EventTarget, e: Event): Event {
  act(() => {
    target.dispatchEvent(e);
  });
  return e;
}

/** The box of the one ink mark posted, in world units. */
function inkBox(events: BoardEvent[]): Box {
  const adds = events.filter((e) => e.type === 'item.add');
  expect(adds).toHaveLength(1);
  const item = (adds[0] as Extract<BoardEvent, { type: 'item.add' }>).item;
  expect(item.kind).toBe('ink');
  return item.box!;
}

describe('a press the browser takes away', () => {
  it('the pen: a cancelled stroke is not saved, and is gone from the page', async () => {
    vi.useFakeTimers();
    const { posted } = open();
    Keyboard.press('p');
    const mouse = new Pointer();
    mouse.down([1000, 600]);
    mouse.move([1040, 620]);
    mouse.move([1100, 640]);
    await frame();
    expect(ink()).toHaveLength(1);
    mouse.cancel();
    expect(ink()).toHaveLength(0);
    await rest();
    expect(posted()).toHaveLength(0);
  });

  it('the box, the arrow and the lasso: the shape is gone, no label opens, nothing is said or posted', async () => {
    for (const key of ['b', 'a', 'l']) {
      const { posted, note } = open();
      new Pointer().on(note).click([10, 10]);
      expect(selected(note)).toBe(true);
      Keyboard.press(key);
      const mouse = new Pointer();
      mouse.down([900, 500]);
      for (const to of [[1000, 520], [1100, 600], [1000, 700], [900, 650], [880, 560], [900, 505]] as const) mouse.move(to);
      await frame();
      expect(drawing()).not.toBeNull();
      expect(selected(note)).toBe(false);
      mouse.cancel();
      expect(drawing()).toBeNull();
      expect(label()).toBeNull();
      expect(screen.queryByTestId('toast')).toBeNull();
      expect(selected(note)).toBe(true);
      await settle();
      expect(posted()).toHaveLength(0);
      cleanup();
    }
  });

  it('a move: the item is back where it was, and nothing is posted', async () => {
    const { posted, note } = open();
    const mouse = new Pointer().on(note);
    mouse.down([10, 10]);
    mouse.move([60, 40]);
    await frame();
    expect(note.style.translate).not.toBe('');
    expect(note.className).toContain('item--dragging');
    mouse.cancel();
    expect(dragging(note)).toBe(false);
    await settle();
    expect(posted()).toHaveLength(0);
  });
});

describe('a press that ends with no lift', () => {
  /** Begin to move the note, and stop with the pointer still down. */
  async function halfMove(note: HTMLElement) {
    const mouse = new Pointer().on(note);
    mouse.down([10, 10]);
    mouse.move([60, 40]);
    await frame();
    expect(dragging(note)).toBe(true);
    return mouse;
  }

  it('blur in the middle of a move posts nothing and leaves no styles on the item; the next press works', async () => {
    const { posted, note, container } = open();
    const mouse = await halfMove(note);
    tell(window, new Event('blur'));
    expect(dragging(note)).toBe(false);
    // The pointer comes up somewhere while the window is away, or after: that is no drop.
    mouse.up();
    await settle();
    expect(posted()).toHaveLength(0);

    const z = camera(container).z;
    new Pointer().on(note).drag([10, 10], [60, 40]);
    await settle();
    expect(posted()).toMatchObject([{ type: 'item.update', item: 'm1', patch: { box: [50 / z, 30 / z, 320, 100] } }]);
    expect(dragging(note)).toBe(false);
  });

  it('the page being hidden ends it the same way; a page that is only shown again does not', async () => {
    const { posted, note } = open();
    await halfMove(note);
    const visible = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    tell(document, new Event('visibilitychange'));
    expect(dragging(note)).toBe(true);
    visible.mockReturnValue('hidden');
    tell(document, new Event('visibilitychange'));
    expect(dragging(note)).toBe(false);
    await settle();
    expect(posted()).toHaveLength(0);
  });

  it('a press whose up never arrives is ended by the window getting focus back', async () => {
    const { posted, note } = open();
    await halfMove(note);
    tell(window, new Event('focus'));
    expect(dragging(note)).toBe(false);
    await settle();
    expect(posted()).toHaveLength(0);
  });

  it('a press whose up never arrives is ended by the next press, which is a press of its own', async () => {
    const { posted, note, part } = open();
    await halfMove(note);
    // The lift was lost. The next press is a click on the card: it selects the card, and the note is not dropped.
    const next = new Pointer().on(part);
    next.down([500, 100]);
    expect(dragging(note)).toBe(false);
    next.up();
    await settle();
    expect(posted()).toHaveLength(0);
    expect(selected(document.querySelector<HTMLElement>('[data-item="a1"]')!)).toBe(true);
  });

  it('a selection cleared by a press comes back also when that press is cut short by a second press that is cut short too', async () => {
    const { note, board } = open();
    new Pointer().on(note).click([10, 10]);
    expect(selected(note)).toBe(true);
    Keyboard.press('b');
    // The first press with the Box tool clears the selection, and its lift never comes.
    const first = new Pointer('mouse', 1).on(board);
    first.down([700, 400]);
    first.move([760, 460]);
    await frame();
    expect(selected(note)).toBe(false);
    // A second press ends the first, and is itself taken away by the browser.
    const second = new Pointer('mouse', 2).on(board);
    second.down([720, 420]);
    second.move([780, 480]);
    await frame();
    second.cancel();
    await settle();
    expect(shape()).toBeNull();
    expect(selected(note)).toBe(true);
  });

  it('the board losing its capture of the pointer ends it; the loss a lift brings does nothing', async () => {
    const { posted, note, board } = open();
    await halfMove(note);
    tell(board, new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 1 }));
    expect(dragging(note)).toBe(false);
    await settle();
    expect(posted()).toHaveLength(0);

    new Pointer().on(note).drag([10, 10], [60, 40]);
    tell(board, new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 1 }));
    await settle();
    expect(posted()).toHaveLength(1);
  });

  it('a pointer that lifts outside the board still ends its press, as a lift', async () => {
    const { posted, note } = open();
    const mouse = await halfMove(note);
    mouse.on(screen.getByRole('toolbar', { name: 'Tools' })).up();
    expect(dragging(note)).toBe(false);
    await settle();
    expect(posted()).toMatchObject([{ type: 'item.update', item: 'm1' }]);
  });

  it('a pointer the browser takes away outside the board still ends its press, as a cancel', async () => {
    const { posted, note } = open();
    const mouse = await halfMove(note);
    mouse.on(screen.getByRole('toolbar', { name: 'Tools' })).cancel();
    expect(dragging(note)).toBe(false);
    await settle();
    expect(posted()).toHaveLength(0);
  });

  it('the board leaving the page with a press open ends it: the tool puts back what it changed, and nothing is posted', async () => {
    const { posted, note } = open();
    await halfMove(note);
    cleanup();
    expect(dragging(note)).toBe(false);
    await settle();
    expect(posted()).toHaveLength(0);
  });
});

describe('the page marks itself while a press is open on the board', () => {
  const pressing = () => document.querySelector('.app')!.hasAttribute('data-pressing');

  it('from the press on the board until its lift, and not for a press on a button of the chrome', async () => {
    const { note } = open();
    expect(pressing()).toBe(false);
    const mouse = new Pointer().on(note);
    mouse.down([10, 10]);
    expect(pressing()).toBe(true);
    mouse.move([60, 40]);
    await frame();
    expect(pressing()).toBe(true);
    mouse.up();
    expect(pressing()).toBe(false);
    await settle();

    const zoomIn = screen.getByRole('button', { name: 'Zoom in' });
    const onBar = new Pointer().on(zoomIn);
    onBar.down([20, 20]);
    expect(pressing()).toBe(false);
    onBar.up();
  });

  it('Esc takes the press back and the mark with it, though the button is still down', async () => {
    const { note } = open();
    const mouse = new Pointer().on(note);
    mouse.down([10, 10]);
    mouse.move([60, 40]);
    await frame();
    expect(pressing()).toBe(true);
    Keyboard.keyDown('Escape');
    expect(pressing()).toBe(false);
    mouse.up();
    expect(pressing()).toBe(false);
    await settle();
  });
});

describe('Esc in the middle of a press', () => {
  it('a drag with the Box tool: the shape goes, and the tool in hand and the open focus view stay', async () => {
    const { posted } = open(true);
    expect(screen.getByTestId('focus-crumb')).toBeTruthy();
    Keyboard.press('b');
    const mouse = new Pointer();
    mouse.down([900, 500]);
    mouse.move([1100, 650]);
    await frame();
    expect(shape()).not.toBeNull();

    // The Esc is used up: the page's own keys never see it.
    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    tidy.push(() => window.removeEventListener('keydown', seen));
    expect(Keyboard.keyDown('Escape')).toBe(false);
    expect(seen).not.toHaveBeenCalled();
    expect(shape()).toBeNull();
    expect(tool()).toBe('box');
    expect(screen.getByTestId('focus-crumb')).toBeTruthy();

    // The key is still down: its repeats are used up too, and the lift that follows draws nothing.
    expect(Keyboard.keyDown('Escape', 'Escape', { repeat: true })).toBe(false);
    Keyboard.keyUp('Escape');
    mouse.move([1150, 700]);
    mouse.up();
    await frame();
    expect(shape()).toBeNull();
    expect(label()).toBeNull();
    expect(tool()).toBe('box');
    expect(screen.getByTestId('focus-crumb')).toBeTruthy();
    await settle();
    expect(posted()).toHaveLength(0);

    // With no press open, Esc is the board's again: it leaves the focus view and puts the tool down.
    expect(Keyboard.press('Escape')).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('focus-crumb')).toBeNull();
    expect(tool()).toBe('select');
  });

  it('a move: the item is back where it was, nothing is posted, and it stays selected as it was', async () => {
    const { posted, note } = open();
    new Pointer().on(note).click([10, 10]);
    expect(selected(note)).toBe(true);
    const mouse = new Pointer().on(note);
    mouse.down([10, 10]);
    mouse.move([60, 40]);
    await frame();
    expect(dragging(note)).toBe(true);
    Keyboard.press('Escape');
    expect(dragging(note)).toBe(false);
    expect(selected(note)).toBe(true);
    mouse.up();
    await settle();
    expect(posted()).toHaveLength(0);
  });

  it('a pen stroke: that stroke goes, and the Pen stays in hand', async () => {
    vi.useFakeTimers();
    const { posted } = open();
    Keyboard.press('p');
    const mouse = new Pointer();
    mouse.down([1000, 600]);
    mouse.move([1100, 640]);
    await frame();
    Keyboard.press('Escape');
    expect(ink()).toHaveLength(0);
    expect(tool()).toBe('pen');
    mouse.up();
    await rest();
    expect(posted()).toHaveLength(0);
  });
});

describe('the press held back on a control', () => {
  it('with the Pen in hand, a click on a picture’s button presses the button and makes no ink', async () => {
    vi.useFakeTimers();
    const { posted, button } = open();
    Keyboard.press('p');
    new Pointer().on(button).click([500, 100]);
    expect(pressed).toEqual(['a1']);
    expect(ink()).toHaveLength(0);
    await rest();
    expect(posted()).toHaveLength(0);
  });

  it('a slow, careful click still presses the button: there is no time limit', async () => {
    vi.useFakeTimers();
    const { posted, button } = open();
    Keyboard.press('p');
    const mouse = new Pointer().on(button);
    mouse.down([500, 100]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    mouse.move([504, 103]);
    await frame();
    mouse.up();
    fireEvent.click(button);
    expect(pressed).toEqual(['a1']);
    expect(ink()).toHaveLength(0);
    await rest();
    expect(posted()).toHaveLength(0);
  });

  it('at 10 px from where it went down it is still a click', async () => {
    vi.useFakeTimers();
    const { posted, button } = open();
    Keyboard.press('p');
    const mouse = new Pointer().on(button);
    mouse.down([500, 100]);
    mouse.move([510, 100]);
    await frame();
    expect(ink()).toHaveLength(0);
    mouse.up();
    fireEvent.click(button);
    expect(pressed).toEqual(['a1']);
    await rest();
    expect(posted()).toHaveLength(0);
  });

  it('a drag that starts on the button and goes 11 px draws from the first point, and the button is not pressed', async () => {
    vi.useFakeTimers();
    const { posted, button, container } = open();
    Keyboard.press('p');
    const cam = camera(container);
    const mouse = new Pointer().on(button);
    mouse.down([500, 100]);
    mouse.move([506, 100]);
    await frame();
    expect(ink()).toHaveLength(0);
    mouse.move([511, 100]);
    await frame();
    expect(ink()).toHaveLength(1);
    mouse.up();
    // The browser's click for the lift, were the pointer still over the button.
    fireEvent.click(button);
    expect(pressed).toEqual([]);
    await rest();
    const box = inkBox(posted());
    expect(box[0]).toBeCloseTo((500 - cam.x) / cam.z, 1);
    expect(box[2]).toBeCloseTo(11 / cam.z, 1);

    // The button still works after: the next click on it is its own.
    new Pointer().on(button).click([500, 100]);
    expect(pressed).toEqual(['a1']);
  });

  it('the Box, the Arrow and the Lasso leave a click on the button to the button too', async () => {
    for (const key of ['b', 'a', 'l']) {
      const { posted, button } = open();
      Keyboard.press(key);
      new Pointer().on(button).click([500, 100]);
      expect(pressed).toEqual(['a1']);
      expect(drawing()).toBeNull();
      expect(label()).toBeNull();
      expect(screen.queryByTestId('toast')).toBeNull();
      await settle();
      expect(posted()).toHaveLength(0);
      cleanup();
      pressed.length = 0;
    }
  });

  it('a press on the picture beside its button is the Pen’s at once: it draws at 5 px, where one on the button waits for 11', async () => {
    vi.useFakeTimers();
    const { part } = open();
    Keyboard.press('p');
    const mouse = new Pointer().on(part);
    mouse.down([450, 60]);
    // A press that has not moved is a click so far, and a click with the Pen makes no mark.
    expect(ink()).toHaveLength(0);
    mouse.move([455, 60]);
    await frame();
    expect(ink()).toHaveLength(1);
  });
});

describe('a click or a drag', () => {
  it('4 px is a click and 5 px is a drag', async () => {
    const { posted, note, container } = open();
    const z = camera(container).z;
    new Pointer().on(note).drag([10, 10], [14, 10], { steps: 1 });
    await settle();
    expect(posted()).toHaveLength(0);
    expect(selected(note)).toBe(true);

    new Pointer().on(note).drag([10, 10], [15, 10], { steps: 1 });
    await settle();
    expect(posted()).toMatchObject([{ type: 'item.update', item: 'm1', patch: { box: [5 / z, 0, 320, 100] } }]);
  });
});

describe('another pointer during a press', () => {
  it('adds nothing to the stroke, and its lift does not end it', async () => {
    vi.useFakeTimers();
    const { posted, container } = open();
    Keyboard.press('p');
    const cam = camera(container);
    const mouse = new Pointer('mouse', 1);
    const other = new Pointer('pen', 2);
    mouse.down([1000, 600]);
    mouse.move([1030, 600]);
    other.move([1400, 900]);
    other.up();
    mouse.move([1060, 600]);
    mouse.up();
    await rest();
    const box = inkBox(posted());
    expect(box[0]).toBeCloseTo((1000 - cam.x) / cam.z, 1);
    expect(box[2]).toBeCloseTo(60 / cam.z, 1);
    expect(box[3]).toBeCloseTo(0, 1);
  });
});

describe('the right button, and the browser’s own menu and drag', () => {
  /** Every context menu asked for on the page: true where the board stopped it. */
  function menus() {
    const stopped: boolean[] = [];
    const on = (e: Event) => stopped.push(e.defaultPrevented);
    window.addEventListener('contextmenu', on);
    tidy.push(() => window.removeEventListener('contextmenu', on));
    return stopped;
  }

  it('a right-click on the board opens no menu and draws nothing', async () => {
    vi.useFakeTimers();
    const { posted } = open();
    const stopped = menus();
    Keyboard.press('p');
    const mouse = new Pointer();
    mouse.down([1000, 600], 'right');
    mouse.move([1100, 640]);
    await frame();
    expect(ink()).toHaveLength(0);
    mouse.up();
    expect(stopped).toEqual([true]);
    await rest();
    expect(posted()).toHaveLength(0);
  });

  it('on a Mac, a Ctrl-click opens no menu and draws nothing; with the Box tool too', async () => {
    vi.useFakeTimers();
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const { posted } = open();
    const stopped = menus();
    Keyboard.press('p');
    Keyboard.withModifierKeys({ ctrl: true }, () => new Pointer().drag([1000, 600], [1100, 640]));
    expect(ink()).toHaveLength(0);
    Keyboard.press('b');
    Keyboard.withModifierKeys({ ctrl: true }, () => new Pointer().drag([1000, 600], [1200, 760]));
    expect(shape()).toBeNull();
    expect(label()).toBeNull();
    expect(stopped).toEqual([true, true]);
    await rest();
    expect(posted()).toHaveLength(0);
  });

  it('a right-button drag does not pan: not with the Pan tool in hand, and not with Space held', async () => {
    const { container } = open();
    const before = camera(container);
    Keyboard.press('h');
    new Pointer().drag([300, 300], [420, 380], { button: 'right' });
    await frame();
    expect(camera(container)).toEqual(before);

    Keyboard.press('s');
    Keyboard.keyDown(' ');
    new Pointer().drag([300, 300], [420, 380], { button: 'right' });
    await frame();
    expect(camera(container)).toEqual(before);

    // The main button still pans with Space held, and the middle button pans by itself.
    new Pointer().drag([300, 300], [420, 380]);
    Keyboard.keyUp(' ');
    await frame();
    expect(camera(container)).toEqual({ ...before, x: before.x + 120, y: before.y + 80 });
    new Pointer().drag([300, 300], [310, 320], { button: 'middle' });
    await frame();
    expect(camera(container)).toEqual({ ...before, x: before.x + 130, y: before.y + 100 });
  });

  it('inside a field the owner types in, the menu still opens: paste and spelling live there', () => {
    const { board } = open();
    Keyboard.press('n');
    new Pointer().click([900, 500]);
    const field = screen.getByRole('textbox', { name: 'Your note' });
    expect(tell(field, new MouseEvent('contextmenu', { bubbles: true, cancelable: true })).defaultPrevented).toBe(false);
    expect(tell(board, new MouseEvent('contextmenu', { bubbles: true, cancelable: true })).defaultPrevented).toBe(true);
  });

  it('nothing inside an item is lifted by the browser’s own drag; a word in a field still is', () => {
    const { note, button } = open();
    for (const el of [note, button]) expect(tell(el, new Event('dragstart', { bubbles: true, cancelable: true })).defaultPrevented).toBe(true);
    Keyboard.press('n');
    new Pointer().click([900, 500]);
    const field = screen.getByRole('textbox', { name: 'Your note' });
    expect(tell(field, new Event('dragstart', { bubbles: true, cancelable: true })).defaultPrevented).toBe(false);
  });

  it('outside the board the menu is the browser’s', () => {
    open();
    const bar = screen.getByRole('toolbar', { name: 'Tools' });
    expect(tell(bar, new MouseEvent('contextmenu', { bubbles: true, cancelable: true })).defaultPrevented).toBe(false);
  });
});

describe('moves once a frame, in the app', () => {
  it('a move is drawn with the next frame, not on the event', async () => {
    open();
    Keyboard.press('b');
    const mouse = new Pointer();
    mouse.down([900, 500]);
    mouse.move([1000, 560]);
    mouse.move([1100, 650]);
    expect(shape()!.style.width).toBe('0px');
    await frame();
    expect(shape()!.style.width).not.toBe('0px');
  });

  it('a down, a move and an up inside one frame lose nothing: the whole stroke is saved', async () => {
    vi.useFakeTimers();
    const { posted, container } = open();
    Keyboard.press('p');
    const cam = camera(container);
    new Pointer().drag([1000, 600], [1090, 600], { steps: 6 });
    await rest();
    const box = inkBox(posted());
    expect(box[0]).toBeCloseTo((1000 - cam.x) / cam.z, 1);
    expect(box[2]).toBeCloseTo(90 / cam.z, 1);
  });
});

describe('a picture’s buttons work with any tool in hand', () => {
  it('with the Note tool, a click on a picture’s button presses the button and opens no note', () => {
    const { button } = open();
    Keyboard.press('n');
    new Pointer().on(button).click([500, 100]);
    expect(pressed).toEqual(['a1']);
    expect(screen.queryByRole('textbox', { name: 'Your note' })).toBeNull();
  });

  // In this test page nothing has a size, so the Pin tool finds no thing under a click and says
  // so. That line is how these tests see that the Pin tool took a click, or left it alone.
  const PIN_NEEDS_A_THING = 'A pin goes on a thing: click a picture, a note, or a part of one.';

  it('with the Pin tool, a click on a picture’s button presses the button and the Pin tool leaves it alone', () => {
    const { button } = open();
    Keyboard.press('i');
    new Pointer().on(button).click([500, 100]);
    expect(pressed).toEqual(['a1']);
    expect(label()).toBeNull();
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('beside the button, on the same picture, the Note tool and the Pin tool still take the click', () => {
    const { part } = open();
    Keyboard.press('n');
    new Pointer().on(part).click([450, 60]);
    expect(screen.queryByRole('textbox', { name: 'Your note' })).not.toBeNull();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Your note' }), { key: 'Escape' });
    Keyboard.press('i');
    new Pointer().on(part).click([450, 60]);
    expect(screen.getByTestId('toast').textContent).toBe(PIN_NEEDS_A_THING);
  });
});
