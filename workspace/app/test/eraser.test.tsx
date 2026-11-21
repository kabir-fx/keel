import type { BoardEvent, Box, InkItem, Item } from '@keel/protocol';
import { act, cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { localSource } from '../src/source';
import type { PostResult } from '../src/source';
import { createTools, drawsOrMoves, toolFor } from '../src/tools';
import { reachAt } from '../src/tools/erasable';
import { ERASING } from '../src/tools/eraser';
import { Flags } from '../src/tools/flags';
import type { Press } from '../src/tools/types';
import { fakeBoard, moveTo, pressAt } from './fakeBoard';
import { CH, note, openBoard, placeAt, text } from './helpers';
import { frame, Keyboard, Pointer, resetInput } from './pointer';

/**
 * The Eraser (`src/tools/eraser.ts`): what it reaches fades and stays until the pointer lifts,
 * Alt brings a thing back, a lift takes everything off as one step that Undo brings back, and
 * any other ending leaves the board as it was, with nothing left on the page.
 */

vi.mock('@keel/pictures', () => ({
  Star: () => null,
  StateChip: ({ state }: { state: string }) => createElement('span', { className: 'k-state' }, state),
  Picture: ({ item }: { item: { id: string } }) => createElement('div', { 'data-double': item.id }, createElement('button', { type: 'button' }, `step ${item.id}`)),
}));

afterEach(() => {
  cleanup();
  resetInput();
});

/** A level ink line of the owner's from (x, y), `len` long. */
const line = (id: string, x: number, y: number, len = 200): InkItem => ({
  id,
  kind: 'ink',
  box: [x, y, len, 0],
  strokes: [{ pts: [0, 0, len, 0], w: 4 }],
  targets: [],
  hint: 'none',
});

/** An upright ink line of the owner's from (x, y), `len` long. */
const upright = (id: string, x: number, y: number, len = 200): InkItem => ({
  id,
  kind: 'ink',
  box: [x, y, 0, len],
  strokes: [{ pts: [0, 0, 0, len], w: 4 }],
  targets: [],
  hint: 'none',
});

/**
 * The Eraser on a fake board: the owner's note `m1`, two upright ink lines at x = 100 and 200
 * (y 0 to 200), a box and a pin, each drawn in an element of its own; and a card of the agent's.
 * What the eraser posts is answered by hand.
 */
function eraserBoard(over: Parameters<typeof fakeBoard>[0] = {}) {
  const fake = fakeBoard({ tool: 'eraser', ...over });
  const b = openBoard();
  const items: Item[] = [
    upright('i1', 100, 0),
    upright('i2', 200, 0),
    { id: 'bx', kind: 'box', box: [400, 0, 100, 100] },
    { id: 'm1', kind: 'note', box: [0, 300, 320, 100], text: 'a note' },
    { id: 'pn', kind: 'pin', box: [600, 100, 0, 0], at: [0, 0], on: { item: 'm1' } },
  ];
  b.must('owner', note('m1', [0, 300, 320, 100]));
  for (const it of items) if (it.id !== 'm1') b.must('owner', { type: 'item.add', chapter: CH, item: it });
  b.must('agent', text('a1', { answers: ['m1'] }));
  b.must('owner', placeAt('a1', [0, 500, 300, 200]));
  const boxes = new Map<string, Box>([...items.map((it): [string, Box] => [it.id, it.box]), ['a1', [0, 500, 300, 200]]]);
  const els = new Map<string, HTMLElement>();
  for (const id of boxes.keys()) {
    const el = document.createElement('div');
    el.dataset.item = id;
    els.set(id, el);
  }
  const { board, did } = fake;
  board.state = () => b.state;
  board.boxes = () => boxes;
  board.outlines = () => new Map(boxes);
  board.where = () => ({ state: b.state, boxes: new Map(), subs: new Map() });
  board.itemEl = (id) => els.get(id);
  /** The answers the board owes, in order. */
  const owed: Array<(r: PostResult) => void> = [];
  board.send = (draft) => {
    did.sent.push(draft);
    return new Promise((done) => owed.push(done));
  };
  /** Answer every post that waits: as the board would, or with a refusal. */
  const answer = async (ok = true) => {
    for (const done of owed.splice(0)) done(ok ? { ok: true, event: {} as BoardEvent } : { ok: false, rule: 'R6', reason: 'no' });
    await act(async () => {});
  };
  const trails = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  fake.hand.trails.mount(trails);
  /** The items that carry the eraser's flag, or any other flag a press wrote. */
  const flagged = () => [...els.entries()].filter(([, el]) => el.getAttributeNames().some((n) => n !== 'data-item')).map(([id]) => id);
  return { ...fake, b, els, answer, trails, flagged, eraser: createTools().eraser };
}

/** A press with the eraser along a path of board points, one sample a frame, left open. */
function sweep(t: ReturnType<typeof eraserBoard>, path: ReadonlyArray<readonly [number, number]>, over: Partial<Press> = {}): Press {
  const [first, ...rest] = path;
  const press = pressAt(first![0], first![1], over);
  expect(t.eraser.down(press, t.board)).toBe(true);
  for (const [x, y] of rest) t.eraser.move(moveTo(press, x, y), t.board);
  return press;
}

const removed = (t: ReturnType<typeof eraserBoard>) => t.did.sent.map((d) => (d.type === 'item.remove' ? d.item : d.type));

describe('the eraser on the board', () => {
  it('what it reaches fades, and nothing is posted until the pointer lifts; then everything it holds goes as one step', async () => {
    const t = eraserBoard();
    const press = sweep(t, [
      [50, 100],
      [150, 100],
      [250, 100],
    ]);
    expect(t.flagged()).toEqual(['i1', 'i2']);
    expect(t.els.get('i1')!.hasAttribute(ERASING)).toBe(true);
    // It holds the pointer, so the sweep goes on outside the board.
    expect(t.did.captured).toEqual([7]);
    expect(t.did.sent).toEqual([]);
    expect(t.did.groups).toEqual([]);
    t.eraser.up(press, t.board);
    expect(t.did.groups).toEqual([['i1', 'i2']]);
    expect(removed(t)).toEqual(['i1', 'i2']);
    // Each stays faded until the board has answered for it.
    expect(t.flagged()).toEqual(['i1', 'i2']);
    await t.answer();
    expect(t.flagged()).toEqual([]);
  });

  it('a fast sweep, two samples far apart, reaches what lies between them', () => {
    const t = eraserBoard();
    const press = sweep(t, [
      [50, 100],
      [700, 100],
    ]);
    expect(t.flagged()).toEqual(['i1', 'i2', 'bx', 'pn']);
    t.eraser.up(press, t.board);
    expect(removed(t)).toEqual(['i1', 'i2', 'bx', 'pn']);
  });

  it('a plain click takes off what is under it, and a click on bare board takes nothing', () => {
    const t = eraserBoard();
    const press = sweep(t, [[100 + reachAt(1), 50]]);
    expect(press.moved).toBe(false);
    t.eraser.up(press, t.board);
    expect(removed(t)).toEqual(['i1']);
    const bare = eraserBoard();
    const miss = sweep(bare, [[150, 50]]);
    bare.eraser.up(miss, bare.board);
    expect(bare.did.sent).toEqual([]);
    expect(bare.did.groups).toEqual([]);
  });

  it('a click with Alt held takes nothing: Alt only brings back', () => {
    const t = eraserBoard();
    const press = sweep(t, [[100, 50]], { mods: { shift: false, alt: true, ctrl: false, meta: false } });
    expect(t.flagged()).toEqual([]);
    t.eraser.up(press, t.board);
    expect(t.did.sent).toEqual([]);
  });

  it('Alt held takes a thing back out of the set as the eraser passes over it, and only that thing', () => {
    const t = eraserBoard();
    const press = sweep(t, [
      [50, 100],
      [250, 100],
    ]);
    expect(t.flagged()).toEqual(['i1', 'i2']);
    press.mods = { ...press.mods, alt: true };
    t.eraser.move(moveTo(press, 250, 150), t.board);
    t.eraser.move(moveTo(press, 150, 150), t.board);
    expect(t.flagged()).toEqual(['i1']);
    expect(t.els.get('i2')!.getAttributeNames()).toEqual(['data-item']);
    // Alt does not add: passing over the box with it held leaves the box be.
    t.eraser.move(moveTo(press, 450, 150), t.board);
    t.eraser.move(moveTo(press, 450, 50), t.board);
    t.eraser.move(moveTo(press, 250, 50), t.board);
    expect(t.flagged()).toEqual(['i1']);
    // Let go of Alt: the eraser takes again.
    press.mods = { ...press.mods, alt: false };
    t.eraser.move(moveTo(press, 200, 50), t.board);
    expect(t.flagged()).toEqual(['i1', 'i2']);
    t.eraser.up(press, t.board);
    expect(removed(t)).toEqual(['i1', 'i2']);
  });

  it('a sweep over the agent’s picture fades it, and the lift takes it off as Delete does, saying Undo puts it back', async () => {
    const t = eraserBoard();
    // Across the card at (0, 500, 300, 200), well inside it.
    const press = sweep(t, [
      [100, 600],
      [200, 600],
    ]);
    expect(t.flagged()).toEqual(['a1']);
    t.eraser.up(press, t.board);
    expect(removed(t)).toEqual(['a1']);
    expect(t.did.groups).toEqual([['a1']]);
    await t.answer();
    expect(t.did.said.at(-1)).toMatch(/^Taken off the board\. Undo \(.+\) puts it back\.$/);
    expect(t.flagged()).toEqual([]);
  });

  it('a click inside a picture takes it off; a click on a note or beside the picture takes nothing', () => {
    for (const [at, want] of [
      [[150, 650], ['a1']],
      [[100, 350], []],
      [[340, 600], []],
    ] as const) {
      const t = eraserBoard();
      const press = sweep(t, [at]);
      t.eraser.up(press, t.board);
      expect(removed(t), String(at)).toEqual(want);
    }
  });

  it('a sweep that reaches the owner’s drawing takes only the drawing: the picture it lies on stays', () => {
    const t = eraserBoard();
    // Ink across the card, as the owner would underline something on it.
    t.b.must('owner', { type: 'item.add', chapter: CH, item: line('on', 20, 600, 200) });
    t.board.boxes().set('on', [20, 600, 200, 0]);
    const el = document.createElement('div');
    el.dataset.item = 'on';
    t.els.set('on', el);
    // Down on the card off the ink: the card fades. Then across the ink: the ink is what goes.
    const press = sweep(t, [[100, 520]]);
    expect(t.flagged()).toEqual(['a1']);
    t.eraser.move(moveTo(press, 100, 650), t.board);
    expect(t.flagged()).toEqual(['on']);
    t.eraser.up(press, t.board);
    expect(removed(t)).toEqual(['on']);
  });

  it('never touches a note: the owner’s writing goes with Delete', () => {
    const t = eraserBoard();
    const press = sweep(t, [
      [-50, 350],
      [380, 350],
    ]);
    expect(t.flagged()).toEqual([]);
    t.eraser.up(press, t.board);
    expect(t.did.sent).toEqual([]);
  });

  for (const why of ['cancel', 'lost', 'blur', 'escape', 'superseded'] as const) {
    it(`a press that ends by ${why} brings everything back: no flag on any item, no trail, nothing posted`, () => {
      const t = eraserBoard();
      const press = sweep(t, [
        [50, 100],
        [700, 100],
      ]);
      expect(t.flagged()).toHaveLength(4);
      expect(t.trails.querySelectorAll('path.trail--eraser')).toHaveLength(1);
      t.eraser.cancel(press, t.board, why);
      expect(t.flagged()).toEqual([]);
      for (const el of t.els.values()) {
        expect(el.getAttributeNames()).toEqual(['data-item']);
        expect(el.className).toBe('');
      }
      expect(t.trails.children).toHaveLength(0);
      expect(t.did.sent).toEqual([]);
      expect(t.did.groups).toEqual([]);
    });
  }

  it('its trail follows the pointer while the press lasts, and goes when it ends', () => {
    const t = eraserBoard();
    const press = sweep(t, [
      [50, 100],
      [60, 100],
    ]);
    expect(t.trails.querySelectorAll('path.trail--eraser')).toHaveLength(1);
    t.eraser.up(press, t.board);
    // Tests ask for reduced motion: the trail does not fade, it goes.
    expect(t.trails.children).toHaveLength(0);
  });

  it('a refused removal brings the thing back as it was', async () => {
    const t = eraserBoard();
    const press = sweep(t, [
      [50, 100],
      [150, 100],
    ]);
    t.eraser.up(press, t.board);
    await t.answer(false);
    expect(t.flagged()).toEqual([]);
  });

  it('what an earlier sweep is taking off is left be by the next one, until the board has answered', async () => {
    const t = eraserBoard();
    const first = sweep(t, [
      [50, 100],
      [150, 100],
    ]);
    t.eraser.up(first, t.board);
    const second = sweep(t, [
      [50, 150],
      [250, 150],
    ]);
    t.eraser.up(second, t.board);
    expect(t.did.groups).toEqual([['i1'], ['i2']]);
    expect(removed(t)).toEqual(['i1', 'i2']);
    await t.answer(false);
    // Refused: the next sweep takes it again.
    const third = sweep(t, [
      [50, 150],
      [150, 150],
    ]);
    t.eraser.up(third, t.board);
    expect(t.did.groups.at(-1)).toEqual(['i1']);
  });

  it('a thing that left the board while the press was open is not taken off again', () => {
    const t = eraserBoard();
    const press = sweep(t, [
      [50, 100],
      [250, 100],
    ]);
    t.b.must('owner', { type: 'item.remove', item: 'i1' });
    t.eraser.up(press, t.board);
    expect(t.did.groups).toEqual([['i2']]);
    expect(removed(t)).toEqual(['i2']);
    expect(t.els.get('i1')!.getAttributeNames()).toEqual(['data-item']);
  });

  it('nothing reached, nothing posted and no step', () => {
    const t = eraserBoard();
    const press = sweep(t, [
      [700, 400],
      [900, 400],
    ]);
    t.eraser.up(press, t.board);
    expect(t.did.groups).toEqual([]);
    expect(t.did.sent).toEqual([]);
  });

  it('reaches as far on screen at any zoom: what is in reach at 100% is out of it zoomed in', () => {
    // A click 6 board units from the line of a stroke 4 wide: the eraser reaches 5 + 2 past it
    // at 100%, and 2.25 + 2 at 400%.
    const near = eraserBoard();
    near.eraser.up(sweep(near, [[106, 50]]), near.board);
    expect(removed(near)).toEqual(['i1']);
    const t = eraserBoard();
    t.camera.set({ x: 0, y: 0, z: 4 });
    t.eraser.up(sweep(t, [[106, 50]]), t.board);
    expect(t.did.sent).toEqual([]);
  });

  it('reaches only what can be pointed at: in a focus view, what lies under the dim stays', () => {
    const t = eraserBoard();
    // The focus view has raised the second line and the pin; the first line and the box lie under the dim.
    t.board.reachable = (id) => id === 'i2' || id === 'pn';
    const press = sweep(t, [
      [50, 100],
      [250, 100],
      [450, 100],
      [600, 100],
    ]);
    expect(t.flagged()).toEqual(['i2', 'pn']);
    t.eraser.up(press, t.board);
    expect(removed(t)).toEqual(['i2', 'pn']);
  });

  it('lists what it can reach once, as the press goes down, and measures the page for it only then', () => {
    const t = eraserBoard();
    const where = vi.spyOn(t.board, 'where');
    const outlines = vi.spyOn(t.board, 'outlines');
    const press = sweep(t, [
      [50, 100],
      [150, 100],
      [250, 100],
      [350, 100],
    ]);
    t.eraser.up(press, t.board);
    expect(where).toHaveBeenCalledTimes(1);
    expect(outlines).toHaveBeenCalledTimes(1);
  });

  it('a press on a button inside a picture is the button’s', () => {
    const t = eraserBoard();
    const button = document.createElement('button');
    t.els.get('a1')!.append(button);
    expect(t.eraser.down(pressAt(10, 510, { target: button }), t.board)).toBe(false);
    expect(t.did.captured).toEqual([]);
  });

  it('is the owner’s alone: in another hand a press is Select’s', () => {
    const tools = createTools();
    expect(toolFor(tools, pressAt(0, 0), fakeBoard({ tool: 'eraser' }).board)).toBe(tools.eraser);
    expect(toolFor(tools, pressAt(0, 0), fakeBoard({ tool: 'eraser', isOwner: false }).board)).toBe(tools.select);
  });

  it('a sweep keeps the view still', () => {
    const tools = createTools();
    expect(drawsOrMoves(tools, tools.eraser)).toBe(true);
  });
});

/* ------------------------------------------------------------------ in the app */

function open(role: 'owner' | 'agent' = 'owner') {
  const b = openBoard();
  b.must('owner', note('m1', [0, 0, 320, 100]));
  b.must('owner', { type: 'item.add', chapter: CH, item: upright('i1', 500, 200) });
  b.must('owner', { type: 'item.add', chapter: CH, item: upright('i2', 600, 200) });
  b.must('owner', { type: 'item.add', chapter: CH, item: line('i3', 500, 700) });
  const src = localSource({ events: b.events, role });
  const { container } = render(<App source={src} />);
  const n = src.events.length;
  /** The camera, read back from the world's transform. */
  const cam = () => {
    const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(container.querySelector<HTMLElement>('.world')!.style.transform)!;
    return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
  };
  /** A board point on the page. */
  const page = ([wx, wy]: readonly [number, number]): [number, number] => {
    const c = cam();
    return [wx * c.z + c.x, wy * c.z + c.y];
  };
  const item = (id: string) => container.querySelector<HTMLElement>(`[data-item="${id}"]`);
  return { src, page, item, posted: (): BoardEvent[] => src.events.slice(n) };
}

/** Undo, as the owner presses it. */
const undo = () => act(async () => Keyboard.withModifierKeys({ meta: true, ctrl: true }, () => Keyboard.press('z')));

describe('the eraser in the app', () => {
  it('E takes it in hand, and the toolbar shows it as Erase', () => {
    open();
    Keyboard.press('e');
    expect(document.querySelector('.app')!.getAttribute('data-tool')).toBe('eraser');
    const button = screen.getByRole('button', { name: 'Erase your ink, boxes, arrows and pins, or a picture' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.textContent).toBe('Erase');
  });

  it('one sweep over two strokes: they fade, go when the pointer lifts as one step, and one Undo brings both back', async () => {
    const { page, item, posted } = open();
    Keyboard.press('e');
    const mouse = new Pointer();
    mouse.down(page([450, 300]));
    mouse.move(page([550, 300]));
    mouse.move(page([650, 300]));
    await frame();
    expect(item('i1')!.hasAttribute(ERASING)).toBe(true);
    expect(item('i2')!.hasAttribute(ERASING)).toBe(true);
    expect(item('i3')!.hasAttribute(ERASING)).toBe(false);
    expect(posted()).toEqual([]);
    await act(async () => mouse.up(page([650, 300])));
    expect(posted().map((e) => [e.type, 'item' in e ? e.item : undefined])).toEqual([
      ['item.remove', 'i1'],
      ['item.remove', 'i2'],
    ]);
    expect(item('i1')).toBeNull();
    expect(item('i2')).toBeNull();
    // The eraser stays in hand.
    expect(document.querySelector('.app')!.getAttribute('data-tool')).toBe('eraser');
    await undo();
    expect(posted().slice(2).map((e) => [e.type, 'item' in e ? e.item : undefined])).toEqual([
      ['item.restore', 'i2'],
      ['item.restore', 'i1'],
    ]);
    expect(item('i1')!.getAttributeNames().filter((n) => n.startsWith('data-') && !['data-item', 'data-kind', 'data-box'].includes(n))).toEqual([]);
    expect(item('i2')).not.toBeNull();
  });

  it('Esc in the middle of a sweep brings everything back and posts nothing', async () => {
    const { page, item, posted } = open();
    Keyboard.press('e');
    const mouse = new Pointer();
    mouse.down(page([450, 300]));
    mouse.move(page([650, 300]));
    await frame();
    expect(item('i1')!.hasAttribute(ERASING)).toBe(true);
    Keyboard.keyDown('Escape');
    expect(item('i1')!.hasAttribute(ERASING)).toBe(false);
    expect(item('i2')!.hasAttribute(ERASING)).toBe(false);
    expect(screen.getByTestId('trails').children).toHaveLength(0);
    await act(async () => mouse.up(page([650, 300])));
    expect(posted()).toEqual([]);
  });

  it('on a page that is not the owner’s it does nothing', async () => {
    const { page, item, posted } = open('agent');
    Keyboard.press('e');
    const mouse = new Pointer();
    mouse.down(page([450, 300]));
    mouse.move(page([650, 300]));
    await frame();
    expect(item('i1')!.hasAttribute(ERASING)).toBe(false);
    expect(screen.getByTestId('trails').children).toHaveLength(0);
    await act(async () => mouse.up(page([650, 300])));
    expect(posted()).toEqual([]);
  });
});

describe('a flag a press writes on the page', () => {
  it('a thing flagged again keeps the element it was flagged on, and every flag comes off', () => {
    const flags = new Flags('data-x');
    const [one, two] = [document.createElement('div'), document.createElement('div')];
    flags.set('a', one);
    flags.set('a', two);
    expect(two.hasAttribute('data-x')).toBe(false);
    flags.set('b', undefined);
    expect(flags.keys()).toEqual(['a', 'b']);
    flags.clear();
    expect(one.hasAttribute('data-x')).toBe(false);
    expect(flags.keys()).toEqual([]);
  });
});
