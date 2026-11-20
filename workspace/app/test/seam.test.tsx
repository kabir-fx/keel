import type { InkItem } from '@keel/protocol';
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Board, BoardNow } from '../src/board/context';
import { useBoard } from '../src/board/context';
import { CameraStore } from '../src/camera/camera';
import { FrameLoop } from '../src/frame';
import { PEN_PAUSE } from '../src/input/constants';
import type { Pointers } from '../src/input/pointers';
import { createPointers } from '../src/input/pointers';
import { LiveStore } from '../src/live';
import { MovingStore } from '../src/select/moving';
import { createTools, drawsOrMoves, toolFor } from '../src/tools';
import type { Press, Sample, Tool } from '../src/tools/types';
import { fakeBoard, moveTo, pressAt } from './fakeBoard';

/**
 * The seam between the board and its tools (`src/tools/types.ts`), tested with no app round it:
 * which tool a press goes to, what a press holds, and that a press which is cut short leaves
 * nothing behind.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe('which tool a press goes to', () => {
  const tools = createTools();
  const goesTo = (press: Partial<Press>, over: Parameters<typeof fakeBoard>[0] = {}) => toolFor(tools, pressAt(0, 0, press), fakeBoard(over).board);

  it('the middle button, Space held and the Pan tool all pan, whatever else is true', () => {
    expect(goesTo({ button: 1 }, { tool: 'pen' })).toBe(tools.pan);
    expect(goesTo({}, { tool: 'pen', spaceHeld: true })).toBe(tools.pan);
    expect(goesTo({}, { tool: 'pan' })).toBe(tools.pan);
  });

  it('the right button is not for the tools: not with the Pan tool in hand, and not with Space held', () => {
    expect(goesTo({ button: 2 })).toBeUndefined();
    expect(goesTo({ button: 2 }, { tool: 'pen' })).toBeUndefined();
    expect(goesTo({ button: 2 }, { tool: 'pan' })).toBeUndefined();
    expect(goesTo({ button: 2 }, { spaceHeld: true })).toBeUndefined();
  });

  it('the tools that make a mark are the owner’s; in another hand they are Select', () => {
    for (const t of ['pen', 'box', 'arrow', 'lasso', 'note', 'pin'] as const) {
      expect(goesTo({}, { tool: t })).toBe(tools[t]);
      expect(goesTo({}, { tool: t, isOwner: false })).toBe(tools.select);
    }
  });

  it('Select is Select, in the owner’s hand and in any other', () => {
    expect(goesTo({}, { tool: 'select' })).toBe(tools.select);
    expect(goesTo({}, { tool: 'select', isOwner: false })).toBe(tools.select);
  });

  it('a press that draws or moves keeps the view still; looking round and a tap do not', () => {
    const { board, el } = fakeBoard();
    expect(drawsOrMoves(tools, undefined)).toBe(false);
    for (const t of [tools.pan, tools.note, tools.pin]) expect(drawsOrMoves(tools, t)).toBe(false);
    for (const t of [tools.pen, tools.box, tools.arrow, tools.lasso]) expect(drawsOrMoves(tools, t)).toBe(true);
    // Select on the ground looks round; on a thing that can move, it may be about to move it.
    tools.select.down(pressAt(500, 500), board);
    expect(drawsOrMoves(tools, tools.select)).toBe(false);
    tools.select.down(pressAt(10, 10, { target: el }), board);
    expect(drawsOrMoves(tools, tools.select)).toBe(true);
    tools.select.up(pressAt(10, 10, { target: el }), board);
    expect(drawsOrMoves(tools, tools.select)).toBe(false);
  });
});

/** A pointer event as the dispatcher reads it. `coalesced` are the samples the browser collected for a move. */
function event(x: number, y: number, over: { button?: number; coalesced?: Array<[number, number]>; target?: Element } = {}) {
  const native = {
    clientX: x,
    clientY: y,
    pressure: 0.5,
    timeStamp: 1,
    getCoalescedEvents: () => (over.coalesced ?? []).map(([cx, cy]) => ({ clientX: cx, clientY: cy, pressure: 0.5, timeStamp: 1 })),
  };
  const e = {
    pointerId: 7,
    pointerType: 'mouse',
    button: over.button ?? 0,
    clientX: x,
    clientY: y,
    pressure: 0.5,
    timeStamp: 1,
    target: over.target ?? null,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    preventDefault: vi.fn(),
    nativeEvent: native,
  };
  return e as unknown as Parameters<Pointers['down']>[0] & { preventDefault: ReturnType<typeof vi.fn> };
}

/** A tool that writes down what it is handed. */
function recorder(takes = true) {
  const heard: Array<{ call: 'down' | 'move' | 'up' | 'cancel'; at: Sample; moved: boolean; samples: number }> = [];
  const hear = (call: 'down' | 'move' | 'up' | 'cancel') => (press: Press) => {
    heard.push({ call, at: press.at, moved: press.moved, samples: press.samples.length });
  };
  const tool: Tool = {
    down: (press) => {
      hear('down')(press);
      return takes;
    },
    move: hear('move'),
    up: hear('up'),
    cancel: hear('cancel'),
  };
  return { tool, heard };
}

describe('the pointer on the board', () => {
  it('a press holds where it went down, in board pixels and in world units by the camera of that moment', () => {
    const { board, camera } = fakeBoard();
    camera.set({ x: 100, y: 50, z: 2 });
    const { tool, heard } = recorder();
    const pointers = createPointers(board, () => tool);
    pointers.down(event(10, 10));
    expect(heard[0]).toMatchObject({ call: 'down', at: { x: 10, y: 10, wx: -45, wy: -20 }, moved: false });
    expect(pointers.tool()).toBe(tool);
  });

  it('a press is a click up to 4 pixels from where it went down, a drag from 5, and stays a drag', () => {
    const { board } = fakeBoard();
    const { tool, heard } = recorder();
    const pointers = createPointers(board, () => tool);
    pointers.down(event(100, 100));
    pointers.move(event(104, 100));
    pointers.flush();
    expect(heard.at(-1)).toMatchObject({ call: 'move', moved: false });
    pointers.move(event(105, 100));
    pointers.flush();
    expect(heard.at(-1)).toMatchObject({ call: 'move', moved: true });
    pointers.move(event(100, 100));
    pointers.flush();
    expect(heard.at(-1)).toMatchObject({ call: 'move', moved: true });
  });

  it('a move hands over every sample the browser collected, the last one as where the pointer is', () => {
    const { board } = fakeBoard();
    const { tool, heard } = recorder();
    const pointers = createPointers(board, () => tool);
    pointers.down(event(0, 0));
    pointers.move(event(30, 0, { coalesced: [[10, 0], [20, 0], [30, 0]] }));
    pointers.flush();
    expect(heard.at(-1)).toMatchObject({ call: 'move', samples: 3, at: { x: 30, y: 0 } });
    pointers.move(event(40, 0));
    pointers.flush();
    expect(heard.at(-1)).toMatchObject({ call: 'move', samples: 1, at: { x: 40, y: 0 } });
  });

  it('a sample is in world units by the camera as it was when the sample came', () => {
    const { board, camera } = fakeBoard();
    const { tool, heard } = recorder();
    const pointers = createPointers(board, () => tool);
    pointers.down(event(0, 0));
    pointers.move(event(20, 0));
    pointers.flush();
    expect(heard.at(-1)!.at).toMatchObject({ wx: 20, wy: 0 });
    camera.set({ x: 10, y: 0, z: 2 });
    pointers.move(event(20, 0));
    pointers.flush();
    expect(heard.at(-1)!.at).toMatchObject({ x: 20, wx: 5, wy: 0 });
  });

  it('lifting the pointer ends the press where it lifted, and the tool hears no more', () => {
    const { board } = fakeBoard();
    const { tool, heard } = recorder();
    const pointers = createPointers(board, () => tool);
    pointers.down(event(0, 0));
    pointers.move(event(50, 0));
    pointers.up(event(60, 0));
    expect(heard.at(-1)).toMatchObject({ call: 'up', at: { x: 60, y: 0 }, moved: true });
    expect(pointers.tool()).toBeUndefined();
    pointers.move(event(70, 0));
    pointers.up(event(70, 0));
    expect(heard).toHaveLength(3);
  });

  it('a press is not opened while a note or a label is open, when no tool takes it, or when the tool says it is not its own', () => {
    const { tool, heard } = recorder();
    const typing = createPointers(fakeBoard({ editing: true }).board, () => tool);
    typing.down(event(0, 0));
    expect(heard).toHaveLength(0);

    const none = createPointers(fakeBoard().board, () => undefined);
    none.down(event(0, 0));
    expect(none.tool()).toBeUndefined();

    const refused = recorder(false);
    const notMine = createPointers(fakeBoard().board, () => refused.tool);
    notMine.down(event(0, 0));
    notMine.move(event(50, 0));
    expect(refused.heard.map((h) => h.call)).toEqual(['down']);
    expect(notMine.tool()).toBeUndefined();
  });

  it('the middle button does not start the browser’s own scroll', () => {
    const { board } = fakeBoard();
    const pointers = createPointers(board, () => recorder().tool);
    const main = event(0, 0);
    pointers.down(main);
    expect(main.preventDefault).not.toHaveBeenCalled();
    const middle = event(0, 0, { button: 1 });
    pointers.down(middle);
    expect(middle.preventDefault).toHaveBeenCalled();
  });

  it('remembers where the pointer last was, with no press open', () => {
    const { board } = fakeBoard();
    const pointers = createPointers(board, () => undefined);
    expect(pointers.last()).toBeNull();
    pointers.move(event(12, 34));
    expect(pointers.last()).toEqual({ x: 12, y: 34 });
  });
});

describe('a press that is cut short leaves nothing behind', () => {
  it('the pen: the stroke goes, nothing is posted, and what was selected is selected again', () => {
    vi.useFakeTimers();
    const { board, did, hand } = fakeBoard();
    const { pen } = createTools();
    const press = pressAt(10, 10);
    pen.down(press, board);
    pen.move(moveTo(press, 60, 10), board);
    expect(hand.get().strokes).toHaveLength(1);
    expect(did.selected).toBeUndefined();
    pen.cancel(press, board, 'cancel');
    expect(hand.get().strokes).toHaveLength(0);
    expect(pen.open()).toBe(false);
    expect(did.selected).toBe('m1');
    vi.advanceTimersByTime(PEN_PAUSE * 2);
    expect(did.marks).toHaveLength(0);
  });

  it('the pen: the finished strokes of the go stay, and still become a mark when the pen rests', async () => {
    vi.useFakeTimers();
    const { board, did, hand } = fakeBoard();
    const { pen } = createTools();
    const first = pressAt(10, 10);
    pen.down(first, board);
    pen.move(moveTo(first, 60, 10), board);
    pen.up(first, board);
    const second = pressAt(10, 40);
    pen.down(second, board);
    pen.move(moveTo(second, 60, 40), board);
    pen.cancel(second, board, 'blur');
    expect(hand.get().strokes).toHaveLength(1);
    expect(pen.waiting()).toBe(true);
    await vi.advanceTimersByTimeAsync(PEN_PAUSE);
    expect(did.marks).toHaveLength(1);
    expect(did.marks[0]).toMatchObject({ kind: 'ink' });
    expect((did.marks[0] as InkItem).strokes).toHaveLength(1);
    expect(pen.open()).toBe(false);
  });

  it('the box, the arrow and the lasso: the live shape goes, no label opens, nothing is posted', () => {
    for (const name of ['box', 'arrow', 'lasso'] as const) {
      const { board, did, hand } = fakeBoard();
      // The lasso is drawn as a trail, in the overlay's SVG.
      const trails = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      hand.trails.mount(trails);
      const shown = () => (name === 'lasso' ? trails.querySelector('path')?.getAttribute('class') : hand.get().shape?.kind);
      const tool = createTools()[name];
      const press = pressAt(10, 10);
      tool.down(press, board);
      for (let x = 20; x <= 120; x += 10) tool.move(moveTo(press, x, 60), board);
      expect(shown()).toBe(name === 'lasso' ? 'trail trail--lasso' : name);
      expect(did.selected).toBeUndefined();
      tool.cancel(press, board, 'escape');
      expect(shown()).toBeUndefined();
      expect(hand.get().shape).toBeUndefined();
      expect(did.labels).toHaveLength(0);
      expect(did.marks).toHaveLength(0);
      expect(did.selected).toBe('m1');
    }
  });

  it('a move: the item is back where it was, with no style left on it, and nothing is posted', () => {
    const { board, did, el } = fakeBoard();
    const { select } = createTools();
    const press = pressAt(10, 10, { target: el });
    expect(select.down(press, board)).toBe(true);
    select.move(moveTo(press, 50, 30), board);
    expect(el.style.translate).toBe('40px 20px');
    expect(el.classList.contains('item--dragging')).toBe(true);
    expect(did.captured).toEqual([7]);
    select.cancel(press, board, 'cancel');
    expect(el.style.translate).toBe('');
    expect(el.classList.contains('item--dragging')).toBe(false);
    expect(select.moving()).toBe(false);
    expect(did.sent).toHaveLength(0);
    expect(did.pending).toHaveLength(0);
    expect(did.dragEnds).toBe(0);
  });

  it('a pan: the camera stays where it got to, and nothing is selected or posted', () => {
    const { board, did, camera } = fakeBoard({ tool: 'pan' });
    const { pan } = createTools();
    const press = pressAt(10, 10);
    pan.down(press, board);
    pan.move(moveTo(press, 60, 40), board);
    expect(camera.get()).toEqual({ x: 50, y: 30, z: 1 });
    pan.cancel(press, board, 'lost');
    expect(camera.get()).toEqual({ x: 50, y: 30, z: 1 });
    expect(did.selected).toBe('m1');
    expect(did.sent).toHaveLength(0);
  });

  it('Select leaves a press on a control inside a picture to the control', () => {
    const { board, el } = fakeBoard();
    const button = document.createElement('button');
    el.append(button);
    expect(createTools().select.down(pressAt(10, 10, { target: button }), board)).toBe(false);
  });
});

describe('the board’s one object', () => {
  const fixed = { isOwner: true, camera: new CameraStore({ x: 0, y: 0, z: 1 }), hand: new LiveStore(), frames: new FrameLoop(), moving: new MovingStore() };
  /** Only the functions a test fills are called; the rest of a render’s functions are not needed here. */
  const now = (fns: Partial<BoardNow>) => fns as BoardNow;

  it('is the same object, with the same functions, on every render', () => {
    const { result, rerender } = renderHook(() => useBoard(fixed));
    const [board] = result.current;
    const say = board.say;
    rerender();
    expect(result.current[0]).toBe(board);
    expect(result.current[0].say).toBe(say);
    expect(board.camera).toBe(fixed.camera);
  });

  it('a function kept from an earlier render calls the one of the latest render', () => {
    const { result } = renderHook(() => useBoard(fixed));
    const [board, fill] = result.current;
    const tool: Board['tool'] = board.tool;
    fill(now({ tool: () => 'select' }));
    expect(tool()).toBe('select');
    fill(now({ tool: () => 'pen' }));
    expect(tool()).toBe('pen');
  });

  it('says so when it is called before its first render has finished', () => {
    const { result } = renderHook(() => useBoard(fixed));
    expect(() => result.current[0].tool()).toThrow(/before its first render/);
  });
});
