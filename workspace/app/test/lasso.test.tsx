import type { BoardEvent, LassoItem } from '@keel/protocol';
import { act, cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { TargetRect, XY } from '../src/geometry';
import { LASSO_SIMPLIFY } from '../src/input/constants';
import { localSource } from '../src/source';
import { createTools } from '../src/tools';
import { holdsNow, simplify } from '../src/tools/holds';
import { LASSOED } from '../src/tools/lasso';
import type { Press } from '../src/tools/types';
import { fakeBoard, moveTo, pressAt } from './fakeBoard';
import { note, openBoard, placeAt, text } from './helpers';
import { frame, Keyboard, Pointer, resetInput } from './pointer';

/**
 * The live lasso (`src/tools/lasso.ts`, `src/tools/holds.ts`): while the loop is drawn it is a
 * trail in the overlay, and what it holds lights up as the loop takes it in and goes out as the
 * loop leaves it. After a lift or any other ending nothing is lit and no trail is left.
 */

vi.mock('@keel/pictures', () => ({
  Star: () => null,
  StateChip: ({ state }: { state: string }) => createElement('span', { className: 'k-state' }, state),
  Picture: ({ item }: { item: { id: string } }) => createElement('div', { 'data-double': item.id }, createElement('div', { 'data-sub': 'q:1' }, 'a question')),
}));

afterEach(() => {
  cleanup();
  resetInput();
});

describe('a path simplified', () => {
  it('drops a point no further than the tolerance from the line of its neighbours, and keeps one further', () => {
    const at = (d: number): XY[] => [
      [0, 0],
      [50, d],
      [100, 0],
    ];
    expect(simplify(at(5), 5)).toEqual([
      [0, 0],
      [100, 0],
    ]);
    expect(simplify(at(5.01), 5)).toEqual(at(5.01));
    expect(simplify(at(-5.01), 5)).toEqual(at(-5.01));
  });

  it('keeps its ends and the corners of a long path, and drops the wobble between them', () => {
    const square: XY[] = [];
    for (let i = 0; i <= 100; i++) square.push([i, i % 2]);
    for (let i = 0; i <= 100; i++) square.push([100 + (i % 2), i]);
    for (let i = 0; i <= 100; i++) square.push([100 - i, 100 + (i % 2)]);
    const kept = simplify(square, 5);
    expect(kept).toHaveLength(4);
    expect(kept[0]).toEqual([0, 0]);
    expect(kept[3]).toEqual([0, 100]);
    for (const [i, [x, y]] of ([[100, 0], [100, 100]] as const).entries()) expect(Math.hypot(kept[i + 1]![0] - x, kept[i + 1]![1] - y)).toBeLessThan(1.5);
  });

  it('leaves a path of one or two points as it is', () => {
    expect(simplify([[1, 2]], 5)).toEqual([[1, 2]]);
    expect(simplify([], 5)).toEqual([]);
  });
});

describe('what a loop being drawn holds', () => {
  /** A square loop with one point drawn `d` above the middle of its top edge, and a thing that lies only in that bump. */
  const bumped = (d: number): XY[] => [
    [0, 0],
    [50, -d],
    [100, 0],
    [100, 100],
    [0, 100],
  ];
  const inBump = (d: number): TargetRect[] => [{ id: 'small', item: 'small', box: [45, -0.6 * d, 10, 0.5 * d] }];

  it('works from the path simplified at 5 screen pixels: a bump of 5 is dropped, one a step past it is kept', () => {
    expect(LASSO_SIMPLIFY).toBe(5);
    for (const z of [0.25, 1, 2]) {
      const d = LASSO_SIMPLIFY / z;
      expect(holdsNow(bumped(d + 0.01), inBump(d + 0.01), z), `at ${z}`).toEqual(['small']);
      expect(holdsNow(bumped(d - 0.01), inBump(d - 0.01), z), `at ${z}`).toEqual([]);
    }
  });

  it('holds by the board’s own rule: half of a thing inside the loop', () => {
    const loop: XY[] = [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ];
    // Three of five columns of the 5 by 5 grid inside: held. Two: not.
    expect(holdsNow(loop, [{ id: 'a', item: 'a', box: [40, 10, 100, 10] }], 1)).toEqual(['a']);
    expect(holdsNow(loop, [{ id: 'b', item: 'b', box: [60, 10, 100, 10] }], 1)).toEqual([]);
  });
});

/** A lasso on a fake board that measures two notes and a question inside a card, each drawn in an element of its own. */
function lassoBoard() {
  const fake = fakeBoard({ tool: 'lasso' });
  const rects: TargetRect[] = [
    { id: 'm1', item: 'm1', box: [100, 100, 100, 100] },
    { id: 'm2', item: 'm2', box: [400, 100, 100, 100] },
    { id: 'a1', item: 'a1', box: [700, 0, 300, 300] },
    { id: 'a1/q:1', item: 'a1', sub: 'q:1', parent: 'a1', box: [720, 20, 60, 40] },
  ];
  const els = new Map<string, HTMLElement>();
  for (const id of ['m1', 'm2', 'a1']) {
    const el = document.createElement('div');
    el.dataset.item = id;
    els.set(id, el);
  }
  const q = document.createElement('div');
  q.dataset.sub = 'q:1';
  els.get('a1')!.append(q);
  fake.board.measureAll = vi.fn(() => rects);
  fake.board.itemEl = (id) => els.get(id);
  const trails = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  fake.hand.trails.mount(trails);
  /** What is lit now: items and the things inside them. */
  const lit = () => [...els.values(), q].filter((el) => el.hasAttribute(LASSOED)).map((el) => el.dataset.item ?? `sub ${el.dataset.sub}`);
  return { ...fake, els, q, trails, lit, lasso: createTools().lasso };
}

/** Draw a loop with the lasso from its first point, one sample a frame, and leave the pointer down. */
function draw(t: ReturnType<typeof lassoBoard>, path: readonly XY[]): Press {
  const [first, ...rest] = path;
  const press = pressAt(first![0], first![1]);
  t.lasso.down(press, t.board);
  return drawOn(t, press, rest);
}

/** Carry on a loop that is being drawn, through these points. */
function drawOn(t: ReturnType<typeof lassoBoard>, press: Press, path: readonly XY[]): Press {
  for (const [x, y] of path) t.lasso.move(moveTo(press, x, y), t.board);
  return press;
}

/** A loop round the first note; and on from there round the second, which leaves the first outside. */
const ROUND_M1: XY[] = [
  [50, 50],
  [250, 50],
  [250, 250],
  [50, 250],
];
const ON_ROUND_M2: XY[] = [
  [50, 300],
  [550, 300],
  [550, 50],
  [300, 50],
];

describe('the lasso while it is drawn', () => {
  it('what it holds lights up as the loop takes it in, and goes out as the loop leaves it', () => {
    const t = lassoBoard();
    const press = draw(t, [ROUND_M1[0]!, ROUND_M1[1]!]);
    expect(t.lit()).toEqual([]);
    drawOn(t, press, ROUND_M1.slice(2));
    expect(t.lit()).toEqual(['m1']);
    // On round the second: the loop takes that in, and the first is left outside it.
    drawOn(t, press, ON_ROUND_M2);
    expect(t.lit()).toEqual(['m2']);
    expect(t.els.get('m1')!.getAttributeNames()).toEqual(['data-item']);
    t.lasso.cancel(press, t.board, 'escape');
  });

  it('a thing inside a picture lights up alone when the loop holds it and not the picture', () => {
    const t = lassoBoard();
    const press = draw(t, [
      [710, 10],
      [790, 10],
      [790, 70],
      [710, 70],
    ]);
    expect(t.lit()).toEqual(['sub q:1']);
    drawOn(t, press, [[1100, 70], [1100, 400], [650, 400], [650, 10]]);
    expect(t.lit()).toEqual(['a1']);
    t.lasso.cancel(press, t.board, 'escape');
  });

  it('is drawn as a trail with marching dashes, in the overlay, not in the live layer', () => {
    const t = lassoBoard();
    const press = draw(t, ROUND_M1);
    expect(t.trails.querySelectorAll('path.trail--lasso')).toHaveLength(1);
    // It runs the way the loop went, lagging the pointer a little to lose its wobble.
    const xs = (t.trails.querySelector('path')!.getAttribute('d')!.match(/-?\d+(\.\d+)?/g) ?? []).map(Number).filter((_, i) => i % 2 === 0);
    expect(Math.min(...xs)).toBeLessThan(55);
    expect(Math.max(...xs)).toBeGreaterThan(150);
    expect(t.hand.get().shape).toBeUndefined();
    t.lasso.cancel(press, t.board, 'escape');
  });

  it('measures what it can hold once, as it begins, not once a frame', () => {
    const t = lassoBoard();
    const press = draw(t, [...ROUND_M1, ...ON_ROUND_M2]);
    expect(t.board.measureAll).toHaveBeenCalledTimes(1);
    t.lasso.cancel(press, t.board, 'escape');
  });

  it('works out what it holds at the zoom of the moment: a bump the simplified path drops when zoomed out it keeps at 100%', () => {
    for (const [z, held] of [[1, ['small']], [0.25, []]] as const) {
      const t = lassoBoard();
      t.camera.set({ x: 0, y: 0, z });
      // A bump of 10 board units: 10 screen pixels at 100%, 2.5 at 25%.
      t.board.measureAll = () => [{ id: 'small', item: 'm1', box: [45, -6, 10, 5] }];
      const press = draw(t, [[0, 0], [50, -10], [100, 0], [100, 100], [0, 100], [0, 10]]);
      expect(t.lit(), `at ${z}`).toEqual(held.length ? ['m1'] : []);
      t.lasso.cancel(press, t.board, 'escape');
    }
  });

  it('a click whose hand shakes inside the click slop is still a click: nothing lit, nothing posted, nothing said', () => {
    const t = lassoBoard();
    const press = draw(t, [[150, 150], [152, 150], [152, 152], [150, 152], [148, 152], [148, 148], [152, 148], [151, 151]]);
    expect(press.moved).toBe(false);
    expect(t.lit()).toEqual([]);
    t.lasso.up(press, t.board);
    expect(t.did.marks).toEqual([]);
    expect(t.did.said).toEqual([]);
  });

  it('a click lights nothing and draws no loop', () => {
    const t = lassoBoard();
    const press = draw(t, [[150, 150], [151, 151]]);
    expect(press.moved).toBe(false);
    expect(t.lit()).toEqual([]);
    t.lasso.up(press, t.board);
    expect(t.did.marks).toEqual([]);
  });

  it('after the lift nothing is lit and no trail is left; the lasso posted holds what was lit', () => {
    const t = lassoBoard();
    const press = draw(t, [...ROUND_M1, [50, 150], [50, 60]]);
    expect(t.lit()).toEqual(['m1']);
    t.lasso.up(press, t.board);
    expect(t.lit()).toEqual([]);
    expect(t.trails.children).toHaveLength(0);
    expect(t.did.marks).toHaveLength(1);
    expect(t.did.marks[0]).toMatchObject({ kind: 'lasso', targets: [{ item: 'm1' }] });
  });

  it('a loop lets go of what was selected as it begins, and one cut short gives all of it back, several things too', () => {
    const t = lassoBoard();
    t.board.select(['m1', 'm2']);
    const press = draw(t, ROUND_M1);
    expect(t.did.selection).toEqual([]);
    t.lasso.cancel(press, t.board, 'escape');
    expect(t.did.selection).toEqual(['m1', 'm2']);
  });

  for (const why of ['cancel', 'lost', 'blur', 'escape', 'superseded'] as const) {
    it(`after a press that ends by ${why} nothing is lit, no trail is left, and nothing is posted`, () => {
      const t = lassoBoard();
      const press = draw(t, [...ROUND_M1, ...ON_ROUND_M2]);
      expect(t.lit()).toEqual(['m2']);
      t.lasso.cancel(press, t.board, why);
      expect(t.lit()).toEqual([]);
      for (const el of [...t.els.values(), t.q]) expect(el.getAttributeNames().filter((n) => n !== 'data-item' && n !== 'data-sub')).toEqual([]);
      expect(t.trails.children).toHaveLength(0);
      expect(t.did.marks).toEqual([]);
    });
  }
});

/* ------------------------------------------------------------------ in the app */

describe('the lasso in the app', () => {
  function open() {
    const b = openBoard();
    b.must('owner', note('m1', [100, 100, 200, 100]));
    b.must('owner', note('m2', [500, 100, 200, 100]));
    b.must('agent', text('a1', { answers: ['m1'] }));
    b.must('owner', placeAt('a1', [100, 400, 300, 200]));
    const src = localSource({ events: b.events });
    const { container } = render(<App source={src} />);
    const n = src.events.length;
    const cam = () => {
      const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(container.querySelector<HTMLElement>('.world')!.style.transform)!;
      return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
    };
    const page = ([wx, wy]: readonly [number, number]): [number, number] => [wx * cam().z + cam().x, wy * cam().z + cam().y];
    const item = (id: string) => container.querySelector<HTMLElement>(`[data-item="${id}"]`)!;
    return { page, item, posted: (): BoardEvent[] => src.events.slice(n) };
  }

  it('lights up what the loop holds while it is drawn, and the lasso it posts holds just that', async () => {
    // The app measures its items from the page: in the test page every item is where its box says.
    const { page, item, posted } = open();
    for (const id of ['m1', 'm2']) {
      const el = item(id);
      const [x, y, w, h] = el.dataset.box!.split(',').map(Number) as [number, number, number, number];
      const [left, top] = page([x, y]);
      const [right, bottom] = page([x + w, y + h]);
      el.getBoundingClientRect = () => DOMRect.fromRect({ x: left, y: top, width: right - left, height: bottom - top });
    }
    Keyboard.press('l');
    const mouse = new Pointer();
    mouse.down(page([50, 50]));
    for (const p of [[350, 50], [350, 250], [50, 250], [50, 60]] as const) mouse.move(page(p));
    await frame();
    expect(item('m1').hasAttribute(LASSOED)).toBe(true);
    expect(item('m2').hasAttribute(LASSOED)).toBe(false);
    expect(screen.getByTestId('trails').querySelectorAll('path.trail--lasso')).toHaveLength(1);
    await act(async () => mouse.up(page([50, 60])));
    expect(item('m1').hasAttribute(LASSOED)).toBe(false);
    expect(screen.getByTestId('trails').children).toHaveLength(0);
    const added = posted().find((e) => e.type === 'item.add');
    expect(added && 'item' in added ? (added.item as LassoItem).targets : undefined).toEqual([{ item: 'm1' }]);
  });
});
