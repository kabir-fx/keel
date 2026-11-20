import type { BoardEvent, Box, Id } from '@keel/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { routeEdge } from '../src/route';
import { createNudge } from '../src/select/nudge';
import { whereWith } from '../src/select/moving';
import { localSource } from '../src/source';
import { fakeBoard } from './fakeBoard';
import { CH, note, openBoard, placeAt, text } from './helpers';
import { Keyboard, Pointer, frame, resetInput, wheel } from './pointer';

/**
 * Select on the board: a move in world units whatever the camera does, what follows a move, the
 * selection as a set and every part that reads it, the line round it, what a press lands on,
 * resizing, snapping, and the arrow keys. The tests drive the whole app with a pointer and keys.
 * A test page has no layout: a press goes to the element a test names, as the browser would send
 * it to the element under the pointer.
 */

/** What the picture double was asked to do: its button by item id, its part as `tap:<id>`. */
const pressed = vi.hoisted(() => [] as string[]);
/** Every render of a picture and of a mark, by id. */
const drawn = vi.hoisted(() => [] as string[]);

/** What a picture double is handed. */
interface DoubleProps {
  item: { id: string };
  view: { walk?: { id: string; step: number } };
  onAct?: (act: { type: 'tap'; item: string; sub: string }) => void;
}

// The pictures are a test double: each draws one part and one button, writes down their clicks,
// says the step of the walk it is shown, and a tap on its part is a tap on the part, as a real
// picture's is.
vi.mock('@keel/pictures', () => ({
  Star: () => null,
  StateChip: () => null,
  Picture: ({ item, view, onAct }: DoubleProps) => {
    drawn.push(item.id);
    return createElement(
      'div',
      { 'data-double': item.id, 'data-walk': view.walk ? `${view.walk.id}:${view.walk.step}` : '' },
      createElement(
        'div',
        {
          'data-sub': 'part:queue',
          onClick: () => {
            pressed.push(`tap:${item.id}`);
            onAct?.({ type: 'tap', item: item.id, sub: 'part:queue' });
          },
        },
        'the queue',
      ),
      createElement('button', { type: 'button', onClick: () => pressed.push(item.id) }, `step ${item.id}`),
    );
  },
}));

// A mark counts its renders, and then draws as the real one, memoised as the real one is.
vi.mock('../src/items', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/items')>();
  const react = await import('react');
  type Props = import('../src/items').MarkViewProps;
  const counting = (props: Props) => {
    drawn.push(props.item.id);
    return react.createElement(real.MarkView, props);
  };
  return { ...real, MarkView: react.memo(counting) };
});

afterEach(() => {
  cleanup();
  resetInput();
  vi.useRealTimers();
  pressed.length = 0;
  drawn.length = 0;
});

type Draft = Record<string, unknown>;

/** A board with these things on it, as the owner sees it. */
function open(...drafts: Array<['owner' | 'agent', Draft]>) {
  const b = openBoard();
  for (const [by, d] of drafts) b.must(by, d);
  const src = localSource({ events: b.events });
  const n = src.events.length;
  const view = render(<App source={src} />);
  return {
    src,
    ...view,
    /** What was posted since the board opened. */
    posted: (): BoardEvent[] => src.events.slice(n),
    board: screen.getByTestId('board'),
  };
}

const owner = (d: Draft): ['owner', Draft] => ['owner', d];
const agent = (d: Draft): ['agent', Draft] => ['agent', d];

const el = (id: Id) => document.querySelector<HTMLElement>(`[data-item="${id}"]`)!;
const selectedIds = () => [...document.querySelectorAll<HTMLElement>('.layer .item--selected')].map((e) => e.dataset.item);

/** The camera, read back from the world's transform: screen = world * z + (x, y). */
function camera() {
  const t = document.querySelector<HTMLElement>('.world')!.style.transform;
  const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(t)!;
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}

/** Where a page point is in world units, by the camera now. A test page lays the board at the page's corner. */
function toWorld([px, py]: readonly [number, number]): [number, number] {
  const c = camera();
  return [(px - c.x) / c.z, (py - c.y) / c.z];
}

/** How far an element is drawn moved by a style, in world units. */
function translateOf(e: HTMLElement): [number, number] {
  if (!e.style.translate) return [0, 0];
  const [x, y] = e.style.translate.split(' ').map((v) => Number.parseFloat(v));
  return [x ?? 0, y ?? 0];
}

/** The box of each `item.update` posted, by item. */
const updates = (events: BoardEvent[]) => events.filter((e): e is Extract<BoardEvent, { type: 'item.update' }> => e.type === 'item.update').map((e) => [e.item, e.patch.box]);

/** Let what a lift posted land. */
const settle = () => act(async () => {});

const NOTE: Box = [0, 0, 320, 100];

describe('a move is the pointer now less where it went down, in world units', () => {
  it('a wheel pan in the middle of a move leaves the note under the pointer, and it lands there', async () => {
    const { board, posted } = open(owner(note('m1', NOTE)));
    const mouse = new Pointer().on(el('m1'));
    const down = toWorld([10, 10]);
    mouse.down([10, 10]);
    mouse.move([60, 40]);
    await frame();
    const before = camera();
    // Two fingers move the board under a pointer that stands still.
    wheel(board, { dx: 30, dy: 120, at: [60, 40] });
    await frame();
    expect(camera()).not.toEqual(before);
    const now = toWorld([60, 40]);
    const [tx, ty] = translateOf(el('m1'));
    expect(tx).toBeCloseTo(now[0] - down[0], 6);
    expect(ty).toBeCloseTo(now[1] - down[1], 6);
    mouse.up();
    await settle();
    expect(updates(posted())).toEqual([['m1', [Math.round(now[0] - down[0]), Math.round(now[1] - down[1]), 320, 100]]]);
  });

  it('a wheel zoom in the middle of a move leaves the note under the pointer', async () => {
    const { board } = open(owner(note('m1', NOTE)));
    const mouse = new Pointer().on(el('m1'));
    const down = toWorld([10, 10]);
    mouse.down([10, 10]);
    mouse.move([60, 40]);
    await frame();
    const before = translateOf(el('m1'));
    const z = camera().z;
    wheel(board, { dy: -50, ctrl: true, at: [200, 300] });
    await frame();
    expect(camera().z).not.toBe(z);
    // The zoom was about another point: the world under the pointer moved, and the note with it.
    const now = toWorld([60, 40]);
    const [tx, ty] = translateOf(el('m1'));
    expect(tx).toBeCloseTo(now[0] - down[0], 6);
    expect(ty).toBeCloseTo(now[1] - down[1], 6);
    expect([tx, ty]).not.toEqual(before);
    mouse.up();
  });

  it('Shift keeps the move on one axis, the one it went further along, and it lands so', async () => {
    const { posted } = open(owner(note('m1', NOTE)));
    const mouse = new Pointer().on(el('m1'));
    mouse.down([10, 10]);
    Keyboard.withModifierKeys({ shift: true, meta: true }, () => mouse.move([210, 40]));
    await frame();
    expect(translateOf(el('m1'))).toEqual([200 / camera().z, 0]);
    Keyboard.withModifierKeys({ shift: true, meta: true }, () => mouse.move([230, 290]));
    await frame();
    expect(translateOf(el('m1'))).toEqual([0, 280 / camera().z]);
    Keyboard.withModifierKeys({ shift: true, meta: true }, () => mouse.up());
    await settle();
    expect(updates(posted())).toEqual([['m1', [0, Math.round(280 / camera().z), 320, 100]]]);
  });

  it('Esc in the middle of a move puts the note back, posts nothing, and leaves what was selected', async () => {
    const { posted } = open(owner(note('m1', NOTE)), owner(note('m2', [0, 400, 320, 100])));
    new Pointer().on(el('m2')).click([10, 410]);
    expect(selectedIds()).toEqual(['m2']);
    const mouse = new Pointer().on(el('m1'));
    mouse.down([10, 10]);
    mouse.move([90, 70]);
    await frame();
    expect(el('m1').style.translate).not.toBe('');
    // Lifted over the rest while it moves.
    expect(el('m1').className).toContain('item--dragging');
    expect(selectedIds()).toEqual(['m1']);
    Keyboard.press('Escape');
    expect(el('m1').style.translate).toBe('');
    expect(el('m1').className).not.toContain('item--dragging');
    expect(selectedIds()).toEqual(['m2']);
    mouse.up();
    await settle();
    expect(posted()).toHaveLength(0);
  });

  it('a thing dragged away and back to where it began is not moved: no change is posted, and its place keeps its fraction', async () => {
    const { posted } = open(owner(note('m1', [0.5, 0.25, 320, 100])), owner(note('m2', [0, 300, 320, 100])));
    for (const [id, at] of [['m1', [10, 10]], ['m2', [10, 310]]] as const) {
      const mouse = new Pointer().on(el(id));
      await Keyboard.withModifierKeys({ meta: true }, async () => {
        mouse.down(pageAt(at[0], at[1]));
        mouse.move(pageAt(at[0] + 80, at[1] + 40));
        await frame();
        mouse.move(pageAt(at[0], at[1]));
        await frame();
        mouse.up();
      });
      await settle();
    }
    expect(posted()).toEqual([]);
    expect(el('m1').dataset.box).toBe('0.5,0.3,320,100');
    expect(translateOf(el('m1'))).toEqual([0, 0]);
  });

  it('a thing dragged away and back to within half a unit of where it began lands on the box it has: no change is posted, and Undo has no step for it', async () => {
    const { posted } = open(owner(note('m1', NOTE)), owner(note('m2', [0, 300, 320, 100])));
    const mouse = new Pointer().on(el('m2'));
    await Keyboard.withModifierKeys({ meta: true }, async () => {
      mouse.down(pageAt(10, 310));
      mouse.move(pageAt(90, 350));
      await frame();
      mouse.move(pageAt(10.3, 310.4));
      await frame();
      mouse.up();
    });
    await settle();
    expect(updates(posted())).toEqual([]);
    Keyboard.press('z', 'KeyZ', { meta: true });
    await settle();
    expect(posted()).toEqual([]);
    expect(el('m2').dataset.box).toBe('0,300,320,100');
  });

  it('of two things dragged together, the one that lands on the box it has is not posted', async () => {
    // The box is on a card four times the size it was, so it is stored in units four times those of the drag: a quarter of one is no move.
    const { posted } = open(
      owner(note('m1', NOTE)),
      agent(text('a1', { answers: ['m1'] })),
      owner(placeAt('a1', [400, 0, 1520, 800])),
      owner({ type: 'item.add', chapter: CH, item: { id: 'b1', kind: 'box', box: [300, 250, 100, 50], anchor: { item: 'a1', box: [300, 0, 380, 200] } } }),
    );
    expect(el('b1').dataset.box).toBe('400,1000,400,200');
    clickOn('m1', [10, 10]);
    Keyboard.withModifierKeys({ shift: true }, () => new Pointer().on(screen.getByTestId('board')).click(pageAt(401, 1100)));
    expect(selectedIds()).toEqual(['m1', 'b1']);
    const mouse = new Pointer().on(el('m1'));
    await Keyboard.withModifierKeys({ meta: true }, async () => {
      mouse.down(pageAt(10, 10));
      mouse.move(pageAt(90, 50));
      await frame();
      mouse.move(pageAt(11, 10));
      await frame();
      mouse.up();
    });
    await settle();
    expect(updates(posted())).toEqual([['m1', [1, 0, 320, 100]]]);
  });

  it('a note on a card that has moved since is posted counted from where the card was: it lands where it was put', async () => {
    // The note was written when the card was at x 300; the card is at 400 now, so the note is drawn 100 to the right of its box.
    const { posted } = open(
      owner(note('m1', NOTE)),
      agent(text('a1', { answers: ['m1'] })),
      owner(placeAt('a1', [400, 0, 380, 200])),
      owner(note('n2', [300, 250, 200, 80], { anchor: { item: 'a1', box: [300, 0, 380, 200] } })),
    );
    expect(el('n2').dataset.box).toBe('400,250,200,80');
    await dragOn(el('n2'), [410, 260], [420, 280], { meta: true });
    expect(updates(posted())).toEqual([['n2', [310, 270, 200, 80]]]);
    expect(el('n2').dataset.box).toBe('410,270,200,80');
  });

  it('while its change is on its way, the note is drawn where it was put', async () => {
    const { src, posted } = open(owner(note('m1', NOTE)));
    let land = () => {};
    const post = src.post;
    src.post = (draft) => new Promise((done) => (land = () => done(post(draft))));
    await dragOn(el('m1'), [10, 10], [60, 40], { meta: true });
    expect(posted()).toHaveLength(0);
    expect(el('m1').style.translate).toBe('');
    expect(el('m1').dataset.box).toBe('50,30,320,100');
    await act(async () => land());
    expect(updates(posted())).toEqual([['m1', [50, 30, 320, 100]]]);
    expect(el('m1').dataset.box).toBe('50,30,320,100');
  });

  it('a mark dropped keeps the width and height it had, to the tenth: a move changes its place only', async () => {
    const ink = { id: 'k1', kind: 'ink', box: [10.3, 20.6, 100.7, 50.2], strokes: [{ pts: [0, 0, 100.7, 50.2] }], targets: [], hint: 'none' };
    const { posted } = open(owner({ type: 'item.add', chapter: CH, item: ink }));
    const mouse = new Pointer().on(el('k1'));
    // A press on the ink's line: its middle.
    const [cx, cy] = [10.3 + 50.35, 20.6 + 25.1];
    const c = camera();
    const at: [number, number] = [cx * c.z + c.x, cy * c.z + c.y];
    mouse.down(at);
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move([at[0] + 47, at[1] + 33]));
    await frame();
    Keyboard.withModifierKeys({ meta: true }, () => mouse.up());
    await settle();
    const [[, box]] = updates(posted()) as [[Id, Box]];
    expect(box.slice(2)).toEqual([100.7, 50.2]);
    expect(box[0]).toBe(Math.round(10.3 + 47 / c.z));
  });
});

describe('what is tied to a moving thing follows it during the move', () => {
  const tied = () =>
    open(
      owner(note('m1', NOTE)),
      owner(note('m2', [600, 0, 200, 100])),
      owner({ type: 'item.add', chapter: CH, item: { id: 'r1', kind: 'arrow', box: [320, 50, 280, 0], from: [0, 0], to: [280, 0], fromTarget: { item: 'm1' }, toTarget: { item: 'm2' } } }),
    );
  const arrowPath = () => el('r1').querySelector('path:not([d^="M0.5"])')!.getAttribute('d');

  it('an arrow tied to a note follows it before anything is posted, and does not jump when it is', async () => {
    const { posted } = tied();
    expect(arrowPath()).toBe('M 320 50 L 600 50');
    const mouse = new Pointer().on(el('m2'));
    const c = camera();
    mouse.down([600 * c.z + c.x + 10, c.y + 10]);
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move([600 * c.z + c.x + 10, c.y + 10 + 100 * c.z]));
    await frame();
    expect(arrowPath()).toBe('M 320 50 L 600 100');
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move([600 * c.z + c.x + 10, c.y + 10 + 200 * c.z]));
    await frame();
    expect(posted()).toHaveLength(0);
    // The end on m2 is drawn into where m2 is now; the end on m1 stays.
    expect(arrowPath()).toBe('M 320 50 L 600 200');
    Keyboard.withModifierKeys({ meta: true }, () => mouse.up());
    await settle();
    expect(updates(posted())).toEqual([['m2', [600, 200, 200, 100]]]);
    expect(arrowPath()).toBe('M 320 50 L 600 200');
  });

  it('an arrow tied at both ends, dragged whole, lets go of both and goes with the pointer: it is drawn again, not moved by a style', async () => {
    const { posted } = tied();
    const mouse = new Pointer().on(screen.getByTestId('board'));
    mouse.down(pageAt(450, 50));
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move(pageAt(450, 150)));
    await frame();
    // Its ends go on from where they were drawn, moved with it, off the notes they were on.
    expect(el('r1').style.translate).toBe('');
    expect(arrowPath()).toBe('M 320 150 L 600 150');
    Keyboard.withModifierKeys({ meta: true }, () => mouse.up());
    await settle();
    expect(updates(posted())).toEqual([['r1', [320, 150, 280, 0]]]);
    expect(posted().map((e) => e.type === 'item.update' && e.patch)).toEqual([{ box: [320, 150, 280, 0], arrowFrom: { at: [0, 0] }, arrowTo: { at: [280, 0] } }]);
    expect(arrowPath()).toBe('M 320 150 L 600 150');
  });

  it('a lasso round a note follows it as it moves', async () => {
    open(
      owner(note('m1', NOTE)),
      owner({ type: 'item.add', chapter: CH, item: { id: 'l1', kind: 'lasso', box: [-20, -20, 360, 140], path: [0, 0, 360, 0, 360, 140, 0, 140], targets: [{ item: 'm1' }] } }),
    );
    const loop = () => el('l1').querySelector('path')!.getAttribute('d');
    const before = loop();
    const mouse = new Pointer().on(el('m1'));
    mouse.down(pageAt(10, 10));
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move(pageAt(110, 10)));
    await frame();
    expect(loop()).not.toBe(before);
    // Its outline runs 14 out from the note, and its drawing has 6 more of room: from x -20, moved by 100.
    expect(el('l1').querySelector('svg')!.style.left).toBe('80px');
    mouse.cancel();
    expect(loop()).toBe(before);
  });

  it('a note on a card moves with the card, and a selected note on the card moves once, not twice', async () => {
    const { posted } = open(
      owner(note('m1', NOTE)),
      agent(text('a1', { answers: ['m1'] })),
      owner(placeAt('a1', [400, 0, 380, 200])),
      owner(note('n2', [420, 20, 200, 80], { anchor: { item: 'a1', box: [400, 0, 380, 200] } })),
    );
    clickOn('a1', [700, 150]);
    clickOn('n2', [430, 30], { shift: true });
    const mouse = new Pointer().on(el('a1'));
    mouse.down(pageAt(700, 150));
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move(pageAt(720, 160)));
    await frame();
    expect(el('n2').style.translate).toBe(el('a1').style.translate);
    // The card is lifted over the rest, and the note on it is carried over the card: it is not hidden under it.
    expect([el('a1').classList.contains('item--dragging'), el('a1').classList.contains('item--carried')]).toEqual([true, false]);
    expect([el('n2').classList.contains('item--dragging'), el('n2').classList.contains('item--carried')]).toEqual([false, true]);
    Keyboard.withModifierKeys({ meta: true }, () => mouse.up());
    await settle();
    expect(updates(posted())).toEqual([['a1', [420, 10, 380, 200]]]);
    expect(el('n2').dataset.box).toBe('440,30,200,80');
    expect(document.querySelectorAll('.item--dragging, .item--carried')).toHaveLength(0);
  });

  it('a thing taken off the board in the middle of its move is not posted when the pointer lifts', async () => {
    const { src, posted } = open(owner(note('m1', NOTE)), owner(note('m2', [0, 200, 320, 100])));
    const mouse = new Pointer().on(el('m1'));
    mouse.down(pageAt(10, 10));
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move(pageAt(60, 40)));
    await frame();
    // The owner takes it off in another tab. Its element goes: the lift reaches the board.
    await act(async () => {
      await src.postAs('owner', { type: 'item.remove', item: 'm1' });
    });
    Keyboard.withModifierKeys({ meta: true }, () => mouse.on(screen.getByTestId('board')).up());
    await settle();
    expect(posted().map((e) => e.type)).toEqual(['item.remove']);
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('an arrow tied to a note by its start follows that note, too', async () => {
    tied();
    const mouse = new Pointer().on(el('m1'));
    mouse.down(pageAt(10, 10));
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move(pageAt(10, 210)));
    await frame();
    // The end on m1 is drawn out of where m1 is now, from its corner nearest the other end; the end on m2 stays.
    expect(arrowPath()).toBe('M 320 200 L 600 50');
    mouse.cancel();
    expect(arrowPath()).toBe('M 320 50 L 600 50');
  });

  it('a cancel puts the arrow back where it was', async () => {
    tied();
    const mouse = new Pointer().on(el('m2'));
    const c = camera();
    mouse.down([600 * c.z + c.x + 10, c.y + 10]);
    mouse.move([600 * c.z + c.x + 10, c.y + 10 + 200 * c.z]);
    await frame();
    // The arrow tied to the lifted note is carried over it: its end is not hidden under the note.
    expect(el('r1').classList.contains('item--carried')).toBe(true);
    mouse.cancel();
    expect(arrowPath()).toBe('M 320 50 L 600 50');
    expect(document.querySelectorAll('.item--dragging, .item--carried')).toHaveLength(0);
  });

  it('an arrow dragged by itself is lifted, not carried', async () => {
    tied();
    clickOn('r1', [460, 50]);
    const mouse = new Pointer().on(screen.getByTestId('board'));
    mouse.down(pageAt(460, 50));
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move(pageAt(460, 150)));
    await frame();
    expect([el('r1').classList.contains('item--dragging'), el('r1').classList.contains('item--carried')]).toEqual([true, false]);
    mouse.cancel();
  });

  it('a read chip under a moving note moves with it', async () => {
    const { container } = open(owner(note('m1', NOTE)), agent({ type: 'answer', answers: ['m1'], read: 'Open the bridge' }));
    const chip = container.querySelector<HTMLElement>('.read-chip[data-mark="m1"]')!;
    const mouse = new Pointer().on(el('m1'));
    mouse.down([10, 10]);
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move([110, 60]));
    await frame();
    expect(chip.style.translate).toBe(el('m1').style.translate);
    mouse.cancel();
    expect(chip.style.translate).toBe('');
  });
});

describe('what sits beside a moving thing stays beside it: a lineage arrow, a tag, a chapter’s label', () => {
  const A1: Box = [800, 0, 300, 200];
  /** A note and the card that answers it: one lineage arrow, from the note to the card. */
  const answered = () => open(owner(note('m1', NOTE)), agent(text('a1', { answers: ['m1'] })), owner(placeAt('a1', A1)));
  const lineage = () => document.querySelector('[data-lineage="m1>a1"]')?.getAttribute('d') ?? null;
  /** The arrow as the board draws it between two boxes, round these cards. */
  const routed = (a: Box, b: Box, cards: readonly Box[] = []) =>
    routeEdge(a, b, cards)
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
      .join(' ');
  const placeOf = (e: HTMLElement) => [e.style.left, e.style.top];

  it('a lineage arrow follows the note it comes from before anything is posted, and does not jump when it is', async () => {
    const { posted } = answered();
    expect(lineage()).toBe(routed(NOTE, A1));
    const mouse = new Pointer().on(el('m1'));
    mouse.down(pageAt(10, 10));
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move(pageAt(10, 310)));
    await frame();
    const held = routed([0, 300, 320, 100], A1);
    expect(held).not.toBe(routed(NOTE, A1));
    expect(posted()).toHaveLength(0);
    expect(lineage()).toBe(held);
    Keyboard.withModifierKeys({ meta: true }, () => mouse.up());
    await settle();
    expect(updates(posted())).toEqual([['m1', [0, 300, 320, 100]]]);
    expect(lineage()).toBe(held);
  });

  it('it follows the card it points at, too, and a cancel puts it back', async () => {
    answered();
    const mouse = new Pointer().on(el('a1'));
    mouse.down(pageAt(810, 10));
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move(pageAt(810, 410)));
    await frame();
    expect(lineage()).toBe(routed(NOTE, [800, 400, 300, 200]));
    mouse.cancel();
    expect(lineage()).toBe(routed(NOTE, A1));
  });

  it('it goes round a card that moves with its end where the hand has the card, not where the card was', async () => {
    const M: Box = [0, 0, 200, 100];
    const { posted } = open(owner(note('m1', M)), agent(text('a1', { answers: ['m1'] })), owner(placeAt('a1', [800, 600, 300, 200])), owner(note('n1', [500, 0, 100, 100])));
    // The card and the note n1 go up together. Where n1 was is then in the way of a straight arrow, and n1 is not there any more.
    clickOn('a1', [810, 610]);
    clickOn('n1', [510, 10], { shift: true });
    const mouse = new Pointer().on(el('a1'));
    mouse.down(pageAt(810, 610));
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move(pageAt(810, 10)));
    await frame();
    const straight = routed(M, A1);
    expect(routed(M, A1, [[500, 0, 100, 100]])).not.toBe(straight);
    expect(lineage()).toBe(straight);
    Keyboard.withModifierKeys({ meta: true }, () => mouse.up());
    await settle();
    expect(updates(posted())).toEqual([
      ['a1', A1],
      ['n1', [500, -600, 100, 100]],
    ]);
    expect(lineage()).toBe(straight);
  });

  it('ends the hand has put on each other have no arrow between them', async () => {
    answered();
    const mouse = new Pointer().on(el('m1'));
    mouse.down(pageAt(10, 10));
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move(pageAt(810, 60)));
    await frame();
    expect(lineage()).toBeNull();
    mouse.cancel();
    expect(lineage()).toBe(routed(NOTE, A1));
  });

  it('a “not made here” tag stays on the corner of its thing while it moves', async () => {
    const { src } = answered();
    // The note and the card came with the log from outside: events 3 and 4.
    act(() => src.setForeign([{ from: 3, to: 4 }]));
    const tag = (id: Id) => document.querySelector<HTMLElement>(`[data-foreign="${id}"]`)!;
    expect(placeOf(tag('m1'))).toEqual(['320px', '0px']);
    const mouse = new Pointer().on(el('m1'));
    mouse.down(pageAt(10, 10));
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move(pageAt(110, 60)));
    await frame();
    expect(placeOf(tag('m1'))).toEqual(['420px', '50px']);
    // It goes on with the hand, frame by frame.
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move(pageAt(210, 160)));
    await frame();
    expect(placeOf(tag('m1'))).toEqual(['520px', '150px']);
    // The card is not in the hand: its tag stays.
    expect(placeOf(tag('a1'))).toEqual(['1100px', '0px']);
    mouse.cancel();
    expect(placeOf(tag('m1'))).toEqual(['320px', '0px']);
  });

  it('a chapter’s label stays above its first thing while that moves', async () => {
    answered();
    const label = () => document.querySelector<HTMLElement>(`[data-chapter-label="${CH}"]`)!;
    expect(placeOf(label())).toEqual(['0px', '-10px']);
    const mouse = new Pointer().on(el('m1'));
    mouse.down(pageAt(10, 10));
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move(pageAt(60, 30)));
    await frame();
    expect(placeOf(label())).toEqual(['50px', '10px']);
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move(pageAt(110, 60)));
    await frame();
    expect(placeOf(label())).toEqual(['100px', '40px']);
    Keyboard.withModifierKeys({ meta: true }, () => mouse.up());
    await settle();
    expect(placeOf(label())).toEqual(['100px', '40px']);
  });
});


/** A page point for a world point, by the camera now. */
function pageAt(wx: number, wy: number): [number, number] {
  const c = camera();
  return [wx * c.z + c.x, wy * c.z + c.y];
}

/** Click a thing at a world point of it, with these keys held. */
function clickOn(id: Id, [wx, wy]: readonly [number, number], mods: { shift?: boolean } = {}) {
  Keyboard.withModifierKeys(mods, () => new Pointer().on(el(id)).click(pageAt(wx, wy)));
}

/** Drag from one world point to another, the press landing on `on` (the ground when not given), with these keys held. */
async function dragOn(on: Element | undefined, from: readonly [number, number], to: readonly [number, number], mods: { shift?: boolean; meta?: boolean } = {}) {
  const mouse = new Pointer().on(on);
  await Keyboard.withModifierKeys(mods, async () => {
    mouse.down(pageAt(from[0], from[1]));
    mouse.move(pageAt((from[0] + to[0]) / 2, (from[1] + to[1]) / 2));
    mouse.move(pageAt(to[0], to[1]));
    await frame();
    mouse.up();
  });
  await settle();
}

const threeNotes = () => [owner(note('m1', NOTE)), owner(note('m2', [0, 200, 320, 100])), owner(note('m3', [0, 400, 320, 100]))] as const;

describe('the selection is a set', () => {
  it('Shift and a click adds a thing, and takes it away again; a click alone selects only it', () => {
    open(...threeNotes());
    clickOn('m1', [10, 10]);
    expect(selectedIds()).toEqual(['m1']);
    clickOn('m3', [10, 410], { shift: true });
    expect(selectedIds()).toEqual(['m1', 'm3']);
    clickOn('m2', [10, 210], { shift: true });
    expect(selectedIds()).toEqual(['m1', 'm2', 'm3']);
    clickOn('m1', [10, 10], { shift: true });
    expect(selectedIds()).toEqual(['m2', 'm3']);
    clickOn('m1', [10, 10]);
    expect(selectedIds()).toEqual(['m1']);
  });

  it('a click on one of several narrows the selection to it', () => {
    open(...threeNotes());
    clickOn('m1', [10, 10]);
    clickOn('m2', [10, 210], { shift: true });
    clickOn('m2', [10, 210]);
    expect(selectedIds()).toEqual(['m2']);
  });

  it('a drag on one of three selected moves all three, and the drop is one step for Undo', async () => {
    const { posted } = open(...threeNotes());
    clickOn('m1', [10, 10]);
    clickOn('m2', [10, 210], { shift: true });
    clickOn('m3', [10, 410], { shift: true });
    await dragOn(el('m2'), [10, 210], [110, 260], { meta: true });
    expect(updates(posted())).toEqual([
      ['m1', [100, 50, 320, 100]],
      ['m2', [100, 250, 320, 100]],
      ['m3', [100, 450, 320, 100]],
    ]);
    expect(selectedIds()).toEqual(['m1', 'm2', 'm3']);
    Keyboard.press('z', 'KeyZ', { meta: true });
    await settle();
    expect(updates(posted()).slice(3)).toEqual([
      ['m3', [0, 400, 320, 100]],
      ['m2', [0, 200, 320, 100]],
      ['m1', [0, 0, 320, 100]],
    ]);
  });

  it('a press on a thing not selected moves only it, and selects it', async () => {
    const { posted } = open(...threeNotes());
    clickOn('m1', [10, 10]);
    clickOn('m2', [10, 210], { shift: true });
    await dragOn(el('m3'), [10, 410], [60, 410], { meta: true });
    expect(updates(posted())).toEqual([['m3', [50, 400, 320, 100]]]);
    expect(selectedIds()).toEqual(['m3']);
  });

  it('Delete with three selected takes all three off, as one step: one Undo puts all three back', async () => {
    const { posted } = open(...threeNotes());
    clickOn('m1', [10, 10]);
    clickOn('m2', [10, 210], { shift: true });
    clickOn('m3', [10, 410], { shift: true });
    Keyboard.press('Delete');
    await settle();
    expect(posted().map((e) => [e.type, 'item' in e ? e.item : undefined])).toEqual([
      ['item.remove', 'm1'],
      ['item.remove', 'm2'],
      ['item.remove', 'm3'],
    ]);
    expect(selectedIds()).toEqual([]);
    Keyboard.press('z', 'KeyZ', { meta: true });
    await settle();
    expect(posted().slice(3).map((e) => e.type)).toEqual(['item.restore', 'item.restore', 'item.restore']);
  });

  it('Delete in the middle of a move takes nothing off: it waits for the hand to let go, as Undo does', async () => {
    const { posted } = open(...threeNotes());
    clickOn('m1', [10, 10]);
    const mouse = new Pointer().on(el('m1'));
    mouse.down(pageAt(10, 10));
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move(pageAt(110, 60)));
    await frame();
    Keyboard.press('Delete');
    Keyboard.press('Backspace');
    await settle();
    expect(posted()).toEqual([]);
    Keyboard.withModifierKeys({ meta: true }, () => mouse.up());
    await settle();
    expect(updates(posted())).toEqual([['m1', [100, 50, 320, 100]]]);
    // The hand has let go: Delete is Delete again.
    Keyboard.press('Delete');
    await settle();
    expect(posted().at(-1)).toMatchObject({ type: 'item.remove', item: 'm1' });
  });

  it('Shift and a drag on the ground adds what the box holds to what is selected, and not what it only reaches into', async () => {
    const { board } = open(...threeNotes(), owner(note('m4', [500, 0, 320, 100])), owner(note('m5', [500, 400, 320, 100])));
    clickOn('m5', [510, 410]);
    const mouse = new Pointer().on(board);
    const marquee = screen.getByTestId('select-marquee');
    await Keyboard.withModifierKeys({ shift: true }, async () => {
      mouse.down(pageAt(-20, -20));
      mouse.move(pageAt(340, 320));
      await frame();
      // The box is drawn while the pointer is down, and nothing more is selected yet.
      expect(marquee.hidden).toBe(false);
      expect(selectedIds()).toEqual(['m5']);
      mouse.move(pageAt(600, 320));
      await frame();
      mouse.up();
    });
    // Shift adds, here as on a click: m5 stays, m1 and m2 join it. The box only reaches into m4.
    expect(selectedIds()).toEqual(['m1', 'm2', 'm5']);
    expect(marquee.hidden).toBe(true);
  });

  it('a box drawn over a thing already selected leaves it selected, once', async () => {
    const { board, posted } = open(...threeNotes());
    clickOn('m1', [10, 10]);
    await dragOn(board, [-20, -20], [340, 320], { shift: true });
    expect(selectedIds()).toEqual(['m1', 'm2']);
    // m1 is in the selection one time: one line round it, and a drag moves it once.
    expect([...document.querySelectorAll<HTMLElement>('.select-ring[data-ring]')].map((r) => r.dataset.ring).sort()).toEqual(['m1', 'm2']);
    await dragOn(el('m1'), [10, 10], [110, 60], { meta: true });
    expect(updates(posted())).toEqual([
      ['m1', [100, 50, 320, 100]],
      ['m2', [100, 250, 320, 100]],
    ]);
  });

  it('a plain drag on the ground looks round and leaves what is selected', async () => {
    const { board } = open(...threeNotes());
    clickOn('m1', [10, 10]);
    const before = camera();
    await dragOn(board, [600, 300], [700, 380]);
    expect(camera().x).toBeCloseTo(before.x + 100 * before.z, 6);
    expect(selectedIds()).toEqual(['m1']);
  });

  it('a click on the ground selects nothing; Shift and a click on the ground keeps what is selected', () => {
    const { board } = open(...threeNotes());
    clickOn('m1', [10, 10]);
    Keyboard.withModifierKeys({ shift: true }, () => new Pointer().on(board).click(pageAt(700, 300)));
    expect(selectedIds()).toEqual(['m1']);
    new Pointer().on(board).click(pageAt(700, 300));
    expect(selectedIds()).toEqual([]);
  });

  it('a thing taken off the board leaves the selection: when it comes back it is not selected', async () => {
    const { src } = open(...threeNotes());
    clickOn('m1', [10, 10]);
    clickOn('m2', [10, 210], { shift: true });
    await act(async () => {
      await src.postAs('owner', { type: 'item.remove', item: 'm1' });
    });
    expect(selectedIds()).toEqual(['m2']);
    await act(async () => {
      await src.postAs('owner', { type: 'item.restore', item: 'm1' });
    });
    expect(selectedIds()).toEqual(['m2']);
  });

  it('the one thing selected is read as of the last select, before the page has drawn it: a lasso cut short twice over gives it back', () => {
    const { board } = open(...threeNotes());
    clickOn('m1', [10, 10]);
    Keyboard.press('l');
    const first = new Pointer(undefined, 1).on(board);
    first.down(pageAt(600, 100));
    // A second press over the first: the first is cut short and gives m1 back, and the second takes it at once, in one turn.
    const second = new Pointer(undefined, 2).on(board);
    second.down(pageAt(650, 150));
    expect(selectedIds()).toEqual([]);
    second.cancel();
    expect(selectedIds()).toEqual(['m1']);
  });

  it('a press cut short gives back what was selected', async () => {
    open(...threeNotes());
    clickOn('m1', [10, 10]);
    clickOn('m2', [10, 210], { shift: true });
    const mouse = new Pointer().on(el('m3'));
    mouse.down(pageAt(10, 410));
    expect(selectedIds()).toEqual(['m3']);
    mouse.cancel();
    expect(selectedIds()).toEqual(['m1', 'm2']);
  });
});

describe('every part that reads the selection: about one thing, it sees one only when one is selected', () => {
  const walkBoard = () =>
    open(
      agent({ type: 'model.patch', chapter: CH, ops: [{ op: 'part.set', part: { id: 'door', name: 'The door' } }, { op: 'walk.set', walk: { id: 'w1', name: 'One request', steps: [{ n: 1, part: 'door', text: 'in' }, { n: 2, part: 'door', text: 'out' }] } }] }),
      owner(note('m1', NOTE)),
      agent(text('wk', { picture: { kind: 'walk', walk: 'w1' }, answers: ['m1'] })),
      owner(placeAt('wk', [400, 0, 300, 200])),
    );
  const walkStep = () => document.querySelector<HTMLElement>('[data-double="wk"]')!.dataset.walk;

  it('the arrow keys step a walk when it alone is selected, and move nothing', async () => {
    vi.useFakeTimers();
    const { posted } = walkBoard();
    clickOn('wk', [410, 10]);
    Keyboard.press('ArrowRight');
    expect(walkStep()).toBe('w1:1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(posted()).toHaveLength(0);
  });

  it('Shift and an arrow key do not move a walk that alone is selected: its arrow keys are for its steps', async () => {
    vi.useFakeTimers();
    const { posted } = walkBoard();
    clickOn('wk', [410, 10]);
    expect(Keyboard.press('ArrowRight', 'ArrowRight', { shift: true })).toBe(true);
    expect(el('wk').dataset.box).toBe('400,0,300,200');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(posted()).toEqual([]);
    expect(walkStep()).toBe('');
  });

  it('with a walk and a note selected, the arrow keys step no walk: they move both', async () => {
    vi.useFakeTimers();
    const { posted } = walkBoard();
    clickOn('wk', [410, 10]);
    clickOn('m1', [10, 10], { shift: true });
    Keyboard.press('ArrowRight');
    expect(walkStep()).toBe('');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(updates(posted())).toEqual([
      ['wk', [401, 0, 300, 200]],
      ['m1', [1, 0, 320, 100]],
    ]);
  });

  const lassoBoard = () =>
    open(
      ...threeNotes(),
      owner({ type: 'item.add', chapter: CH, item: { id: 'l1', kind: 'lasso', box: [-20, -20, 360, 140], path: [0, 0, 360, 0, 360, 140, 0, 140], targets: [{ item: 'm1' }] } }),
      owner({ type: 'item.add', chapter: CH, item: { id: 'l2', kind: 'lasso', box: [-20, 180, 360, 340], path: [0, 0, 360, 0, 360, 340, 0, 340], targets: [{ item: 'm2' }, { item: 'm3' }] } }),
    );
  /** A click on the dashed outline of a lasso: its left side, which runs `LASSO_PAD` out from what it holds. */
  const clickLasso = (board: HTMLElement, y: number, mods: { shift?: boolean } = {}) => Keyboard.withModifierKeys(mods, () => new Pointer().on(board).click(pageAt(-14, y)));

  it('Solidify acts on the one lasso selected; with two selected, on the newest, as with none', async () => {
    const { board, posted } = lassoBoard();
    clickLasso(board, 50);
    expect(selectedIds()).toEqual(['l1']);
    Keyboard.press('S', 'KeyS', { shift: true });
    await settle();
    expect(posted().at(-1)).toMatchObject({ type: 'solidify', lasso: 'l1', picks: ['m1'] });
    clickLasso(board, 50);
    clickLasso(board, 300, { shift: true });
    expect(selectedIds()).toEqual(['l1', 'l2']);
    // The board solidified l1 already: the newest open one is l2.
    Keyboard.press('S', 'KeyS', { shift: true });
    await settle();
    expect(posted().at(-1)).toMatchObject({ type: 'solidify', lasso: 'l2' });
  });

  const lineageBoard = () =>
    open(
      owner(note('m1', NOTE)),
      agent(text('a1', { answers: ['m1'] })),
      owner(placeAt('a1', [0, 300, 200, 100])),
      agent(text('a2', { answers: ['m1'] })),
      owner(placeAt('a2', [300, 300, 200, 100])),
      agent(text('a3', { from: ['a1', 'a2'] })),
      owner(placeAt('a3', [150, 600, 200, 100])),
    );
  const into = () => document.querySelectorAll('[data-lineage$=">a3"]').length;

  it('lineage shows every arrow into the one picture selected, and only its own one with several selected', () => {
    lineageBoard();
    expect(into()).toBe(1);
    clickOn('a3', [160, 610]);
    expect(into()).toBe(2);
    clickOn('m1', [10, 10], { shift: true });
    expect(into()).toBe(1);
  });

  it('the click that ends a drag of a card is not a tap on the part the card was held by', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { container, posted } = open(
      agent({ type: 'model.patch', chapter: CH, ops: [{ op: 'lane.set', lane: { id: 'bridge', name: 'Bridge' } }, { op: 'part.set', part: { id: 'queue', name: 'The queue', lane: 'bridge' } }] }),
      owner(note('m1', NOTE)),
      agent(text('a1', { answers: ['m1'] })),
      owner(placeAt('a1', [400, 0, 380, 200])),
      agent({ type: 'item.add', chapter: CH, item: { id: 'f1', kind: 'picture', picture: { kind: 'focus', part: 'queue', title: 'The queue' }, from: ['a1'] } }),
    );
    const focus = () => container.querySelector('.app')!.getAttribute('data-focus');
    const part = container.querySelector<HTMLElement>('[data-item="a1"] [data-sub="part:queue"]')!;
    const mouse = new Pointer().on(part);
    mouse.down(pageAt(410, 10));
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move(pageAt(450, 60)));
    await frame();
    Keyboard.withModifierKeys({ meta: true }, () => mouse.up());
    // The browser sends a click to what the press went down and came up on.
    fireEvent.click(part);
    await settle();
    expect(updates(posted())).toEqual([['a1', [440, 50, 380, 200]]]);
    expect(focus()).toBeNull();
    // A tap some time after the drag is a tap.
    vi.setSystemTime(Date.now() + 301);
    fireEvent.click(part);
    expect(focus()).toBe('f1');
  });

  it('opening a part’s focus view lets go of everything selected', () => {
    const { container } = open(
      agent({ type: 'model.patch', chapter: CH, ops: [{ op: 'lane.set', lane: { id: 'bridge', name: 'Bridge' } }, { op: 'part.set', part: { id: 'queue', name: 'The queue', lane: 'bridge' } }] }),
      owner(note('m1', NOTE)),
      owner(note('m2', [0, 200, 320, 100])),
      agent(text('a1', { answers: ['m1'] })),
      owner(placeAt('a1', [400, 0, 380, 200])),
      agent({ type: 'item.add', chapter: CH, item: { id: 'f1', kind: 'picture', picture: { kind: 'focus', part: 'queue', title: 'The queue' }, from: ['a1'] } }),
    );
    clickOn('m1', [10, 10]);
    clickOn('m2', [10, 210], { shift: true });
    const part = container.querySelector<HTMLElement>('[data-item="a1"] [data-sub="part:queue"]')!;
    new Pointer().on(part).click(pageAt(410, 10));
    expect(container.querySelector('.app')!.getAttribute('data-focus')).toBe('f1');
    expect(selectedIds()).toEqual([]);
  });

  it('Delete with one thing selected takes that one off', async () => {
    const { posted } = open(...threeNotes());
    clickOn('m2', [10, 210]);
    Keyboard.press('Delete');
    await settle();
    expect(posted().map((e) => [e.type, 'item' in e ? e.item : undefined])).toEqual([['item.remove', 'm2']]);
  });

  it('Redo that takes a selected thing off lets go of that one, and keeps the rest selected', async () => {
    const { posted } = open(...threeNotes());
    clickOn('m1', [10, 10]);
    clickOn('m2', [10, 210], { shift: true });
    Keyboard.press('Delete');
    await settle();
    Keyboard.press('z', 'KeyZ', { meta: true });
    await settle();
    clickOn('m1', [10, 10]);
    clickOn('m3', [10, 410], { shift: true });
    Keyboard.press('z', 'KeyZ', { meta: true, shift: true });
    await settle();
    expect(posted().slice(-2).map((e) => e.type)).toEqual(['item.remove', 'item.remove']);
    expect(selectedIds()).toEqual(['m3']);
  });

  it.each(['p', 'b', 'a'])('the tool on key %s lets go of everything selected as it draws, and gives it all back when the press is cut short', async (key) => {
    const { board } = open(...threeNotes());
    clickOn('m1', [10, 10]);
    clickOn('m3', [10, 410], { shift: true });
    Keyboard.press(key);
    const mouse = new Pointer().on(board);
    mouse.down(pageAt(600, 100));
    mouse.move(pageAt(700, 200));
    await frame();
    expect(selectedIds()).toEqual([]);
    mouse.cancel();
    expect(selectedIds()).toEqual(['m1', 'm3']);
  });

  it('2 fits the one thing selected, and all of several', () => {
    open(owner(note('m1', NOTE)), owner(note('m2', [3000, 2000, 320, 100])));
    clickOn('m1', [10, 10]);
    Keyboard.press('2');
    const one = camera().z;
    clickOn('m2', [3010, 2010], { shift: true });
    Keyboard.press('2');
    const both = camera();
    expect(both.z).toBeLessThan(one);
    // Both are in view: the far corner of m2 is on the board.
    expect(3320 * both.z + both.x).toBeLessThanOrEqual(window.innerWidth);
    expect(0 * both.z + both.x).toBeGreaterThanOrEqual(0);
  });
});

describe('what a press lands on', () => {
  /** A card, and a box the owner drew round it, close: its line is 2.5 units wide inside its box, from 395 to 397.5 on the left. */
  const boxed = () =>
    open(
      owner(note('m1', NOTE)),
      agent(text('a1', { answers: ['m1'] })),
      owner(placeAt('a1', [400, 0, 380, 200])),
      owner({ type: 'item.add', chapter: CH, item: { id: 'b1', kind: 'box', box: [395, -5, 400, 210] } }),
    );

  it('a press inside a box drawn round a card reaches the part of the card under it', () => {
    const { container } = boxed();
    const part = container.querySelector<HTMLElement>('[data-item="a1"] [data-sub="part:queue"]')!;
    new Pointer().on(part).click(pageAt(450, 40));
    expect(pressed).toEqual(['tap:a1']);
    expect(selectedIds()).toEqual(['a1']);
  });

  it('a press on the box’s line selects the box; near it, over the ground, so does one up to a slop away, and no further', () => {
    const { board } = boxed();
    const z = camera().z;
    new Pointer().on(board).click(pageAt(396, 100));
    expect(selectedIds()).toEqual(['b1']);
    // The middle of the line is at 396.25, half of it is 1.25 wide, and the slop is 8 screen pixels past that.
    new Pointer().on(board).click(pageAt(396.25 - 1.25 - 8 / z, 100));
    expect(selectedIds()).toEqual(['b1']);
    new Pointer().on(board).click(pageAt(396.25 - 1.25 - 8 / z - 0.5, 100));
    expect(selectedIds()).toEqual([]);
  });

  it('a press only near the box’s line and squarely on the card under it lands on the card', () => {
    const { container } = boxed();
    const card = container.querySelector<HTMLElement>('[data-item="a1"]')!;
    new Pointer().on(card).click(pageAt(403, 100));
    expect(selectedIds()).toEqual(['a1']);
  });

  it('ink only near the pointer gives way to the card the pointer is squarely on; ink under the pointer is taken', () => {
    const ink = { id: 'k1', kind: 'ink', box: [450, 100, 200, 0], strokes: [{ pts: [0, 0, 200, 0] }], targets: [], hint: 'none' };
    const { container } = open(owner(note('m1', NOTE)), agent(text('a1', { answers: ['m1'] })), owner(placeAt('a1', [400, 0, 380, 200])), owner({ type: 'item.add', chapter: CH, item: ink }));
    const card = container.querySelector<HTMLElement>('[data-item="a1"]')!;
    // Four units off the line: near it, not on it.
    new Pointer().on(card).click(pageAt(500, 104 / 1));
    expect(selectedIds()).toEqual(['a1']);
    new Pointer().on(card).click(pageAt(500, 100));
    expect(selectedIds()).toEqual(['k1']);
  });

  it('free ink is taken by a press near its line, within the slop, and not past it', () => {
    const ink = { id: 'k1', kind: 'ink', box: [600, 400, 200, 0], strokes: [{ pts: [0, 0, 200, 0] }], targets: [], hint: 'none' };
    const { board } = open(owner(note('m1', NOTE)), owner({ type: 'item.add', chapter: CH, item: ink }));
    const z = camera().z;
    new Pointer().on(board).click(pageAt(700, 400 + 6 / z));
    expect(selectedIds()).toEqual(['k1']);
    new Pointer().on(board).click(pageAt(700, 400 + 40 / z));
    expect(selectedIds()).toEqual([]);
  });

  it('in a focus view, what lies under the dim is not hit', () => {
    const ink = { id: 'k1', kind: 'ink', box: [0, 600, 300, 0], strokes: [{ pts: [0, 0, 300, 0] }], targets: [], hint: 'none' };
    const { container } = open(
      agent({ type: 'model.patch', chapter: CH, ops: [{ op: 'lane.set', lane: { id: 'bridge', name: 'Bridge' } }, { op: 'part.set', part: { id: 'queue', name: 'The queue', lane: 'bridge' } }] }),
      owner(note('m1', NOTE)),
      agent(text('a1', { answers: ['m1'] })),
      owner(placeAt('a1', [400, 0, 380, 200])),
      agent({ type: 'item.add', chapter: CH, item: { id: 'f1', kind: 'picture', picture: { kind: 'focus', part: 'queue', title: 'The queue' }, from: ['a1'] } }),
      owner({ type: 'item.add', chapter: CH, item: ink }),
    );
    new Pointer().on(container.querySelector<HTMLElement>('[data-item="a1"] [data-sub="part:queue"]')!).click(pageAt(410, 10));
    const dim = container.querySelector<HTMLElement>('[data-focus-dim]')!;
    new Pointer().on(dim).click(pageAt(100, 600));
    expect(selectedIds()).toEqual([]);
  });

  it('an arrow only near the pointer gives way to the card under it; on its line it is taken; near it over the ground, too', () => {
    // From the ground (x 330 to 400) across the card (from x 400).
    const arrow = { id: 'r1', kind: 'arrow', box: [330, 150, 320, 0], from: [0, 0], to: [320, 0] };
    const { container, board } = open(owner(note('m1', NOTE)), agent(text('a1', { answers: ['m1'] })), owner(placeAt('a1', [400, 0, 380, 200])), owner({ type: 'item.add', chapter: CH, item: arrow }));
    const card = container.querySelector<HTMLElement>('[data-item="a1"]')!;
    const z = camera().z;
    // Its line is three screen pixels wide: on it within half of that, near it within the slop past that.
    new Pointer().on(card).click(pageAt(500, 150 + 2 / z));
    expect(selectedIds()).toEqual(['a1']);
    new Pointer().on(card).click(pageAt(500, 150 + 1.5 / z));
    expect(selectedIds()).toEqual(['r1']);
    new Pointer().on(board).click(pageAt(360, 150 - (1.5 + 8) / z));
    expect(selectedIds()).toEqual(['r1']);
    new Pointer().on(board).click(pageAt(360, 150 - (1.5 + 8) / z - 0.5));
    expect(selectedIds()).toEqual([]);
  });

  it('a pin over ink takes the press, as it is drawn over it', () => {
    const ink = { id: 'k1', kind: 'ink', box: [0, 150, 300, 0], strokes: [{ pts: [0, 0, 300, 0] }], targets: [], hint: 'none' };
    const pin = { id: 'p1', kind: 'pin', box: [100, 150, 0, 0], at: [0, 0], on: { item: 'm1' } };
    open(owner(note('m1', [0, 0, 320, 300])), owner({ type: 'item.add', chapter: CH, item: ink }), owner({ type: 'item.add', chapter: CH, item: pin }));
    new Pointer().on(el('p1')).click(pageAt(100, 150));
    expect(selectedIds()).toEqual(['p1']);
  });
});

describe('resizing a box and a note', () => {
  const B1: Box = [100, 100, 200, 100];
  const withBox = (...more: Array<['owner' | 'agent', Draft]>) => open(owner({ type: 'item.add', chapter: CH, item: { id: 'b1', kind: 'box', box: B1 } }), ...more);
  /** Select the box by a click on its line. */
  const selectBox = (board: HTMLElement) => new Pointer().on(board).click(pageAt(101, 150));
  /** A drag of a handle: from a point of the line round the thing, in world units, by a way in screen pixels. */
  async function dragHandle(board: HTMLElement, [wx, wy]: readonly [number, number], [dx, dy]: readonly [number, number], mods: { shift?: boolean; alt?: boolean; meta?: boolean } = {}, end: 'up' | 'cancel' = 'up') {
    const [px, py] = pageAt(wx, wy);
    const mouse = new Pointer().on(board);
    await Keyboard.withModifierKeys(mods, async () => {
      mouse.down([px, py]);
      mouse.move([px + dx / 2, py + dy / 2]);
      mouse.move([px + dx, py + dy]);
      await frame();
      if (end === 'up') mouse.up();
      else mouse.cancel();
    });
    await settle();
  }
  /** The corner of the line round a thing, in world units: `SELECT_PAD` screen pixels out. */
  const corner = (x: number, y: number, sx: 1 | -1, sy: 1 | -1): [number, number] => {
    const z = camera().z;
    return [x + (sx * 4) / z, y + (sy * 4) / z];
  };

  it('a corner resizes the box: one change on release, and the box is drawn at its new size while the pointer is down', async () => {
    const { board, posted } = withBox();
    selectBox(board);
    const z = camera().z;
    const [px, py] = pageAt(...corner(300, 200, 1, 1));
    const mouse = new Pointer().on(board);
    mouse.down([px, py]);
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move([px + 50 * z, py + 20 * z]));
    await frame();
    expect(el('b1').style.width).toBe('250px');
    expect(el('b1').style.minHeight).toBe('120px');
    expect(posted()).toHaveLength(0);
    Keyboard.withModifierKeys({ meta: true }, () => mouse.up());
    await settle();
    expect(updates(posted())).toEqual([['b1', [100, 100, 250, 120]]]);
  });

  it('a “not made here” tag on the box stays on its top right corner while the box is resized', async () => {
    const { board, src } = withBox();
    // The box came with the log from outside: event 3.
    act(() => src.setForeign([{ from: 3, to: 3 }]));
    const tag = () => document.querySelector<HTMLElement>('[data-foreign="b1"]')!;
    expect([tag().style.left, tag().style.top]).toEqual(['300px', '100px']);
    selectBox(board);
    const z = camera().z;
    const [px, py] = pageAt(...corner(300, 100, 1, -1));
    const mouse = new Pointer().on(board);
    mouse.down([px, py]);
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move([px + 50 * z, py - 20 * z]));
    await frame();
    expect([tag().style.left, tag().style.top]).toEqual(['350px', '80px']);
    mouse.cancel();
    expect([tag().style.left, tag().style.top]).toEqual(['300px', '100px']);
  });

  it('a tag on ink that hangs on the box stays on the ink’s corner as the ink is drawn again with the box', async () => {
    const { board, src } = withBox(owner({ type: 'item.add', chapter: CH, item: { id: 'k1', kind: 'ink', box: B1, strokes: [{ pts: [0, 0, 200, 100] }], targets: [], hint: 'none', anchor: { item: 'b1', box: B1 } } }));
    // The ink came with the log from outside: event 4.
    act(() => src.setForeign([{ from: 4, to: 4 }]));
    const tag = () => document.querySelector<HTMLElement>('[data-foreign="k1"]')!;
    expect([tag().style.left, tag().style.top]).toEqual(['300px', '100px']);
    selectBox(board);
    expect(selectedIds()).toEqual(['b1']);
    const z = camera().z;
    const [px, py] = pageAt(...corner(300, 200, 1, 1));
    const mouse = new Pointer().on(board);
    mouse.down([px, py]);
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move([px + 50 * z, py + 20 * z]));
    await frame();
    expect(el('k1').dataset.box).toBe('100,100,250,120');
    expect([tag().style.left, tag().style.top]).toEqual(['350px', '100px']);
    mouse.cancel();
    expect([tag().style.left, tag().style.top]).toEqual(['300px', '100px']);
  });

  it('a box that began on a fraction: the corner held still stays to the hair when the pointer lifts, and only the sides dragged come to whole units', async () => {
    const { board, posted } = open(owner({ type: 'item.add', chapter: CH, item: { id: 'b1', kind: 'box', box: [100.5, 100.25, 200, 100] } }));
    new Pointer().on(board).click(pageAt(101.5, 150));
    expect(selectedIds()).toEqual(['b1']);
    await dragHandle(board, corner(300.5, 200.25, 1, 1), [50.3, 20.4], { meta: true });
    expect(updates(posted())).toEqual([['b1', [100.5, 100.25, 250, 120]]]);
    // From the corner across: the bottom right stays where it now is.
    await dragHandle(board, corner(100.5, 100.25, -1, -1), [-10.2, -10.2], { meta: true });
    expect(updates(posted()).at(-1)).toEqual(['b1', [90.5, 90.25, 260, 130]]);
  });

  it('Shift keeps the ratio; Option resizes from the centre', async () => {
    const { board, posted } = withBox();
    selectBox(board);
    const z = camera().z;
    await dragHandle(board, corner(300, 200, 1, 1), [100 * z, 10 * z], { shift: true, meta: true });
    expect(updates(posted()).at(-1)).toEqual(['b1', [100, 100, 300, 150]]);
    await dragHandle(board, corner(400, 250, 1, 1), [-100 * z, 0], { alt: true, meta: true });
    expect(updates(posted()).at(-1)).toEqual(['b1', [200, 100, 100, 150]]);
  });

  it('never under the smallest size, and never flipped', async () => {
    const { board, posted } = withBox();
    selectBox(board);
    const z = camera().z;
    await dragHandle(board, corner(300, 200, 1, 1), [-900 * z, -900 * z], { meta: true });
    expect(updates(posted())).toEqual([['b1', [100, 100, 24, 24]]]);
  });

  it('an edge is grabbed with nothing drawn on it, and resizes one side', async () => {
    const { board, posted } = withBox();
    selectBox(board);
    const z = camera().z;
    await dragHandle(board, [100 - 4 / z, 150], [-30 * z, 40 * z], { meta: true });
    expect(updates(posted())).toEqual([['b1', [70, 100, 230, 100]]]);
  });

  it('a click on a handle resizes nothing, and keeps the box selected', async () => {
    const { board, posted } = withBox();
    selectBox(board);
    new Pointer().on(board).click(pageAt(...corner(300, 200, 1, 1)));
    await settle();
    expect(posted()).toHaveLength(0);
    expect(selectedIds()).toEqual(['b1']);
  });

  it('a cut short resize posts nothing and puts the box back as it was drawn', async () => {
    const { board, posted } = withBox();
    selectBox(board);
    const z = camera().z;
    await dragHandle(board, corner(300, 200, 1, 1), [50 * z, 50 * z], {}, 'cancel');
    expect(posted()).toHaveLength(0);
    expect(el('b1').style.width).toBe('200px');
    expect(el('b1').style.minHeight).toBe('100px');
    expect(selectedIds()).toEqual(['b1']);
  });

  it('a box taken off the board in the middle of its resize is not posted when the pointer lifts, and nothing is said', async () => {
    const { board, posted, src } = withBox();
    selectBox(board);
    const z = camera().z;
    const [px, py] = pageAt(...corner(300, 200, 1, 1));
    const mouse = new Pointer().on(board);
    mouse.down([px, py]);
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move([px + 50 * z, py + 20 * z]));
    await frame();
    await act(async () => {
      await src.post({ type: 'item.remove', item: 'b1' });
    });
    Keyboard.withModifierKeys({ meta: true }, () => mouse.up());
    await settle();
    expect(posted().map((e) => e.type)).toEqual(['item.remove']);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.querySelector('.toast')).toBeNull();
  });

  it('a handle dragged out and back to where it was changes nothing: no change is posted, and Undo has no step for it', async () => {
    const { board, posted } = withBox();
    selectBox(board);
    const z = camera().z;
    const [px, py] = pageAt(...corner(300, 200, 1, 1));
    const mouse = new Pointer().on(board);
    mouse.down([px, py]);
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move([px + 50 * z, py + 20 * z]));
    await frame();
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move([px, py]));
    await frame();
    Keyboard.withModifierKeys({ meta: true }, () => mouse.up());
    await settle();
    expect(posted()).toEqual([]);
    expect(el('b1').dataset.box).toBe('100,100,200,100');
  });

  it('a handle let go within half a unit of where it was changes nothing either', async () => {
    const { board, posted } = withBox();
    selectBox(board);
    const z = camera().z;
    const [px, py] = pageAt(...corner(300, 200, 1, 1));
    const mouse = new Pointer().on(board);
    mouse.down([px, py]);
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move([px + 50 * z, py + 20 * z]));
    await frame();
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move([px + 0.3 * z, py - 0.4 * z]));
    await frame();
    Keyboard.withModifierKeys({ meta: true }, () => mouse.up());
    await settle();
    expect(posted()).toEqual([]);
    expect(el('b1').dataset.box).toBe('100,100,200,100');
  });

  it('a box on a card that has grown since is posted in its own units: the side the hand moved where it was left, the rest as it is stored', async () => {
    // The card was 380 by 200 when the box was put on it and is 418 by 220 now: the box is drawn 1.1 times its size, at 400, 275.
    const { board, posted } = open(
      owner(note('m1', NOTE)),
      agent(text('a1', { answers: ['m1'] })),
      owner(placeAt('a1', [400, 0, 418, 220])),
      owner({ type: 'item.add', chapter: CH, item: { id: 'b1', kind: 'box', box: [300, 250, 100, 50], anchor: { item: 'a1', box: [300, 0, 380, 200] } } }),
    );
    new Pointer().on(board).click(pageAt(401, 300));
    expect(selectedIds()).toEqual(['b1']);
    const z = camera().z;
    // Its right edge, drawn at 510, out by 20: it is left 130 wide as drawn.
    const [px, py] = pageAt(510 + 4 / z, 300);
    const mouse = new Pointer().on(board);
    mouse.down([px, py]);
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move([px + 20 * z, py]));
    await frame();
    Keyboard.withModifierKeys({ meta: true }, () => mouse.up());
    await settle();
    // Its top and its height, which the hand left, are 250 and 50 to the last digit: 250 times 1.1 and back is not.
    expect(updates(posted())).toEqual([['b1', [300, 250, 130 / (418 / 380), 50]]]);
    expect(el('b1').dataset.box).toBe('400,275,130,55');
  });

  it('a box is as tall as the hand leaves it: the height the page gives its element is a note’s rule, not a box’s', async () => {
    const { board, posted } = withBox();
    selectBox(board);
    // The page rounds what it measures, and measures a box on a card that has grown as it is drawn: neither is the box's own height.
    Object.defineProperty(el('b1'), 'offsetHeight', { configurable: true, value: 58 });
    const z = camera().z;
    await dragHandle(board, corner(300, 200, 1, 1), [40 * z, 20 * z], { meta: true });
    expect(updates(posted())).toEqual([['b1', [100, 100, 240, 120]]]);
  });

  it('a note resizes in width only: its height is left to its words', async () => {
    const { posted } = open(owner(note('m1', NOTE)));
    clickOn('m1', [10, 10]);
    const z = camera().z;
    const mouse = new Pointer().on(screen.getByTestId('board'));
    const [px, py] = pageAt(...corner(320, 100, 1, 1));
    mouse.down([px, py]);
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move([px + 80 * z, py + 300 * z]));
    await frame();
    expect(el('m1').style.width).toBe('400px');
    // Its height follows its words while it is resized.
    expect(el('m1').style.minHeight).toBe('0px');
    Keyboard.withModifierKeys({ meta: true }, () => mouse.up());
    await settle();
    // A test page lays nothing out: the words take no height, and the note keeps its own.
    expect(updates(posted())).toEqual([['m1', [0, 0, 400, 100]]]);
  });

  it('a note’s edge dragged out and back changes nothing, whatever height the page gives its words meanwhile', async () => {
    const { posted } = open(owner(note('m1', NOTE)));
    clickOn('m1', [10, 10]);
    // The page lays the note's words out lower than the box the note was made with: its own height is only its least.
    Object.defineProperty(el('m1'), 'offsetHeight', { configurable: true, value: 58 });
    const z = camera().z;
    const mouse = new Pointer().on(screen.getByTestId('board'));
    const [px, py] = pageAt(...corner(320, 100, 1, 1));
    mouse.down([px, py]);
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move([px + 80 * z, py]));
    await frame();
    expect(el('m1').style.width).toBe('400px');
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move([px, py]));
    await frame();
    Keyboard.withModifierKeys({ meta: true }, () => mouse.up());
    await settle();
    expect(posted()).toEqual([]);
    // Dragged out and left there, the note is as tall as the page lays its words out.
    mouse.down([px, py]);
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move([px + 80 * z, py]));
    await frame();
    Keyboard.withModifierKeys({ meta: true }, () => mouse.up());
    await settle();
    expect(updates(posted())).toEqual([['m1', [0, 0, 400, 58]]]);
  });

  it('the edge snaps to the line of a thing near it; with Cmd it does not', async () => {
    const { board, posted } = withBox(owner(note('m1', [-200, 300, 520, 100])));
    selectBox(board);
    const z = camera().z;
    // The right edge, 300, dragged to 313: 7 from the note's right edge, 320.
    await dragHandle(board, [300 + 4 / z, 150], [13 * z, 0]);
    expect(updates(posted()).at(-1)).toEqual(['b1', [100, 100, 220, 100]]);
    await dragHandle(board, [320 + 4 / z, 150], [-7 * z, 0], { meta: true });
    expect(updates(posted()).at(-1)).toEqual(['b1', [100, 100, 213, 100]]);
  });

  it('a wheel in the middle of a resize, with the pointer still, keeps the corner under the pointer: it is drawn there at once, and lands there', async () => {
    const { board, posted } = withBox();
    selectBox(board);
    const z = camera().z;
    const [px, py] = pageAt(...corner(300, 200, 1, 1));
    const at: [number, number] = [px + 50 * z, py + 20 * z];
    const mouse = new Pointer().on(board);
    mouse.down([px, py]);
    mouse.move(at);
    await frame();
    expect(el('b1').style.width).toBe('250px');
    const before = camera();
    // Two fingers move the board under a pointer that stands still.
    wheel(board, { dx: 30, dy: 60, at });
    await frame();
    const now = camera();
    expect(now).not.toEqual(before);
    // The world went by under the pointer: the corner is as much further on as it went.
    const wide = 250 + (before.x - now.x) / z;
    const tall = 120 + (before.y - now.y) / z;
    expect(wide).not.toBeCloseTo(250, 0);
    expect(parseFloat(el('b1').style.width)).toBeCloseTo(wide, 6);
    expect(parseFloat(el('b1').style.minHeight)).toBeCloseTo(tall, 6);
    mouse.up();
    await settle();
    expect(updates(posted())).toEqual([['b1', [100, 100, Math.round(wide), Math.round(tall)]]]);
  });

  it('Shift pressed in the middle of a resize keeps the ratio at once', async () => {
    const { board } = withBox();
    selectBox(board);
    const z = camera().z;
    const [px, py] = pageAt(...corner(300, 200, 1, 1));
    const mouse = new Pointer().on(board);
    Keyboard.keyDown('Meta');
    mouse.down([px, py]);
    mouse.move([px + 100 * z, py + 10 * z]);
    await frame();
    expect(el('b1').style.minHeight).toBe('110px');
    Keyboard.keyDown('Shift');
    expect(el('b1').style.minHeight).toBe('150px');
    Keyboard.keyUp('Shift');
    expect(el('b1').style.minHeight).toBe('110px');
    mouse.cancel();
    Keyboard.keyUp('Meta');
  });

  it('a box on a card that has moved since is posted counted from where the card was', async () => {
    const { board, posted } = open(
      owner(note('m1', NOTE)),
      agent(text('a1', { answers: ['m1'] })),
      owner(placeAt('a1', [400, 0, 380, 200])),
      owner({ type: 'item.add', chapter: CH, item: { id: 'b1', kind: 'box', box: [300, 250, 100, 50], anchor: { item: 'a1', box: [300, 0, 380, 200] } } }),
    );
    new Pointer().on(board).click(pageAt(401, 270));
    expect(selectedIds()).toEqual(['b1']);
    const z = camera().z;
    await dragHandle(board, corner(500, 300, 1, 1), [20 * z, 10 * z], { meta: true });
    expect(updates(posted())).toEqual([['b1', [300, 250, 120, 60]]]);
  });

  it('ink on a box being resized is drawn on it while the pointer is down, also when the box hangs on a card that has moved since', async () => {
    const { board } = open(
      owner(note('m1', NOTE)),
      agent(text('a1', { answers: ['m1'] })),
      owner(placeAt('a1', [400, 0, 380, 200])),
      owner({ type: 'item.add', chapter: CH, item: { id: 'b1', kind: 'box', box: [300, 250, 100, 50], anchor: { item: 'a1', box: [300, 0, 380, 200] } } }),
      owner({ type: 'item.add', chapter: CH, item: { id: 'k1', kind: 'ink', box: [400, 250, 100, 50], strokes: [{ pts: [0, 0, 100, 50] }], targets: [], hint: 'none', anchor: { item: 'b1', box: [400, 250, 100, 50] } } }),
    );
    new Pointer().on(board).click(pageAt(401, 270));
    expect(selectedIds()).toEqual(['b1']);
    const z = camera().z;
    const [px, py] = pageAt(...corner(500, 300, 1, 1));
    const mouse = new Pointer().on(board);
    mouse.down([px, py]);
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move([px + 20 * z, py + 10 * z]));
    await frame();
    expect(el('k1').dataset.box).toBe('400,250,120,60');
    mouse.cancel();
    expect(el('k1').dataset.box).toBe('400,250,100,50');
  });

  it('a note is never narrower than its least width', async () => {
    const { posted } = open(owner(note('m1', NOTE)));
    clickOn('m1', [10, 10]);
    const z = camera().z;
    await dragHandle(screen.getByTestId('board'), [320 + 4 / z, 50], [-1000 * z, 0], { meta: true });
    expect(updates(posted())).toEqual([['m1', [0, 0, 120, 100]]]);
  });

  it('a plain label is as wide as its words: it has no handles', () => {
    open(owner(note('m1', NOTE)), owner(note('m2', [0, 300, 120, 40], { plain: true })));
    clickOn('m1', [10, 10]);
    expect(document.querySelectorAll('.select-handle')).toHaveLength(4);
    clickOn('m2', [10, 310]);
    expect(selectedIds()).toEqual(['m2']);
    expect(document.querySelectorAll('.select-handle')).toHaveLength(0);
  });

  it('there are no handles with several selected, or on what the owner cannot resize', () => {
    const { board } = withBox(owner(note('m1', [0, 400, 320, 100])), agent(text('a1', { answers: ['m1'] })), owner(placeAt('a1', [600, 0, 300, 200])));
    selectBox(board);
    expect(document.querySelectorAll('.select-handle')).toHaveLength(4);
    clickOn('m1', [10, 410], { shift: true });
    expect(document.querySelectorAll('.select-handle')).toHaveLength(0);
    clickOn('a1', [610, 10]);
    expect(document.querySelectorAll('.select-handle')).toHaveLength(0);
  });
});

describe('snapping a move', () => {
  const two = () => open(owner(note('m1', NOTE)), owner(note('m2', [0, 200, 320, 100])));

  it('an edge 8 px from another thing’s edge snaps onto it, 9 px does not, and Cmd turns it off', async () => {
    const z = () => camera().z;
    const { posted } = two();
    await dragOn(el('m2'), [10, 210], [10 + 8 / z(), 260]);
    expect(updates(posted()).at(-1)).toEqual(['m2', [0, 250, 320, 100]]);
    await dragOn(el('m2'), [10, 260], [10 + 9 / z(), 300]);
    expect(updates(posted()).at(-1)).toEqual(['m2', [Math.round(9 / z()), 290, 320, 100]]);
    await dragOn(el('m2'), [20, 300], [20 - 6 / z(), 340], { meta: true });
    expect(updates(posted()).at(-1)![1]![0]).toBe(Math.round(9 / z() - 6 / z()));
  });

  it('the reach is 8 screen pixels at any zoom: zoomed in, 8 px snaps and 9 px does not', async () => {
    const { posted } = two();
    Keyboard.press('=');
    Keyboard.press('=');
    const z = camera().z;
    expect(z).toBeGreaterThan(1.5);
    await dragOn(el('m2'), [10, 210], [10 + 8 / z, 260]);
    expect(updates(posted()).at(-1)).toEqual(['m2', [0, 250, 320, 100]]);
    await dragOn(el('m2'), [10, 260], [10 + 9 / z, 300]);
    expect(updates(posted()).at(-1)).toEqual(['m2', [Math.round(9 / z), 290, 320, 100]]);
  });

  it('Ctrl pressed in the middle of a move turns the snap off too', async () => {
    const { posted } = two();
    const mouse = new Pointer().on(el('m2'));
    mouse.down(pageAt(10, 210));
    Keyboard.keyDown('Control');
    mouse.move(pageAt(10 + 6 / camera().z, 260));
    await frame();
    mouse.up();
    Keyboard.keyUp('Control');
    await settle();
    expect(updates(posted())).toEqual([['m2', [Math.round(6 / camera().z), 250, 320, 100]]]);
  });

  it('only what is in view pulls: a note far out of view lines up with nothing', async () => {
    const { posted } = open(owner(note('m1', [20000, 200, 320, 100])), owner(note('m2', [0, 200, 320, 100])));
    await dragOn(el('m2'), [10, 210], [10 + 30 / camera().z, 210 + 4 / camera().z]);
    expect(updates(posted())).toEqual([['m2', [Math.round(30 / camera().z), Math.round(200 + 4 / camera().z), 320, 100]]]);
  });

  it('a thing never lines up with where it was itself', async () => {
    const { posted } = open(owner(note('m2', [0, 200, 320, 100])));
    await dragOn(el('m2'), [10, 210], [15, 215]);
    expect(updates(posted())).toEqual([['m2', [5, 205, 320, 100]]]);
  });

  it('with Shift the axis held still stays still: a snap does not move it off', async () => {
    const { posted } = open(owner(note('m1', [0, 105, 320, 100])), owner(note('m2', [500, 200, 320, 100])));
    // The top of m2 is 5 from the bottom line of m1 (205): it would snap, but Shift holds it.
    await dragOn(el('m2'), [510, 210], [710, 213], { shift: true });
    expect(updates(posted())).toEqual([['m2', [700, 200, 320, 100]]]);
  });

  it('Cmd let go in the middle of a move snaps it at once, with no move of the pointer: what is drawn is what lands', async () => {
    const { posted } = two();
    const mouse = new Pointer().on(el('m2'));
    Keyboard.keyDown('Meta');
    mouse.down(pageAt(10, 210));
    mouse.move(pageAt(10 + 6 / camera().z, 260));
    await frame();
    // Six screen pixels from m1's edge: within the snap, and Cmd holds it off.
    expect(translateOf(el('m2'))[0]).toBeCloseTo(6 / camera().z, 6);
    Keyboard.keyUp('Meta');
    expect(translateOf(el('m2'))).toEqual([0, 50]);
    mouse.up();
    await settle();
    expect(updates(posted())).toEqual([['m2', [0, 250, 320, 100]]]);
  });

  it('Shift pressed in the middle of a move locks it to one axis at once; let go, it is free again', async () => {
    two();
    const mouse = new Pointer().on(el('m2'));
    Keyboard.keyDown('Meta');
    mouse.down(pageAt(10, 210));
    mouse.move(pageAt(110, 240));
    await frame();
    expect(translateOf(el('m2'))).toEqual([100, 30]);
    Keyboard.keyDown('Shift');
    expect(translateOf(el('m2'))).toEqual([100, 0]);
    Keyboard.keyUp('Shift');
    expect(translateOf(el('m2'))).toEqual([100, 30]);
    mouse.cancel();
    Keyboard.keyUp('Meta');
  });

  it('the guides are drawn while the move snaps, and gone when it lands', async () => {
    two();
    const path = () => screen.getByTestId('snap-guides').querySelector('path')!.getAttribute('d') ?? '';
    const mouse = new Pointer().on(el('m2'));
    mouse.down(pageAt(10, 210));
    mouse.move(pageAt(14, 260));
    await frame();
    expect(path()).toMatch(/^M/);
    mouse.up();
    await settle();
    expect(path()).toBe('');
  });
});

describe('the arrow keys move what is selected', () => {
  it('a run of five presses shows each at once, posts one change once the keys rest, and is one step for Undo', async () => {
    vi.useFakeTimers();
    const { posted } = open(owner(note('m1', NOTE)), owner(note('m2', [0, 200, 320, 100])));
    clickOn('m1', [10, 10]);
    clickOn('m2', [10, 210], { shift: true });
    Keyboard.press('ArrowRight');
    expect(el('m1').dataset.box).toBe('1,0,320,100');
    for (let i = 0; i < 3; i++) Keyboard.press('ArrowRight', 'ArrowRight', { repeat: true });
    Keyboard.press('ArrowDown');
    expect(el('m1').dataset.box).toBe('4,1,320,100');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(posted()).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(updates(posted())).toEqual([
      ['m1', [4, 1, 320, 100]],
      ['m2', [4, 201, 320, 100]],
    ]);
    // The board has the run: each note is drawn from the log again, where the run left it.
    expect([el('m1').dataset.box, el('m2').dataset.box]).toEqual(['4,1,320,100', '4,201,320,100']);
    Keyboard.press('z', 'KeyZ', { meta: true });
    await settle();
    expect(updates(posted()).slice(2)).toEqual([
      ['m2', [0, 200, 320, 100]],
      ['m1', [0, 0, 320, 100]],
    ]);
    // And Undo is seen: nothing the run drew ahead of the log is left over it.
    expect([el('m1').dataset.box, el('m2').dataset.box]).toEqual(['0,0,320,100', '0,200,320,100']);
  });

  it('the keys rest from the last press: presses 400 ms apart are one run, posted 500 ms after the last', async () => {
    vi.useFakeTimers();
    const { posted } = open(owner(note('m1', NOTE)));
    clickOn('m1', [10, 10]);
    Keyboard.press('ArrowRight');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    Keyboard.press('ArrowRight');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    // 800 ms after the first press, 400 after the last: the run is still open.
    expect(posted()).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(updates(posted())).toEqual([['m1', [2, 0, 320, 100]]]);
  });

  it('once the board has a run, a move of the thing from elsewhere shows', async () => {
    vi.useFakeTimers();
    const { src } = open(owner(note('m1', NOTE)));
    clickOn('m1', [10, 10]);
    Keyboard.press('ArrowRight');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(el('m1').dataset.box).toBe('1,0,320,100');
    await act(async () => {
      await src.post({ type: 'item.update', item: 'm1', patch: { box: [40, 60, 320, 100] } });
    });
    expect(el('m1').dataset.box).toBe('40,60,320,100');
  });

  it('a thing taken off the board in the middle of a run is not posted, and comes back where the log has it', async () => {
    vi.useFakeTimers();
    const { src, posted } = open(owner(note('m1', NOTE)));
    clickOn('m1', [10, 10]);
    Keyboard.press('ArrowRight');
    await act(async () => {
      await src.post({ type: 'item.remove', item: 'm1' });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(updates(posted())).toEqual([]);
    await act(async () => {
      await src.post({ type: 'item.restore', item: 'm1' });
    });
    expect(el('m1').dataset.box).toBe('0,0,320,100');
  });

  it('Undo right after a run posts the run first, and then takes it back', async () => {
    vi.useFakeTimers();
    const { posted } = open(owner(note('m1', NOTE)));
    clickOn('m1', [10, 10]);
    Keyboard.press('ArrowRight');
    Keyboard.press('z', 'KeyZ', { meta: true });
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(updates(posted())).toEqual([
      ['m1', [1, 0, 320, 100]],
      ['m1', [0, 0, 320, 100]],
    ]);
    expect(el('m1').dataset.box).toBe('0,0,320,100');
  });

  it('Delete right after a run posts the run first', async () => {
    vi.useFakeTimers();
    const { posted } = open(owner(note('m1', NOTE)));
    clickOn('m1', [10, 10]);
    Keyboard.press('ArrowDown');
    Keyboard.press('Delete');
    await settle();
    expect(posted().map((e) => e.type)).toEqual(['item.update', 'item.remove']);
  });

  it('with Shift each press moves five', async () => {
    vi.useFakeTimers();
    const { posted } = open(owner(note('m1', NOTE)));
    clickOn('m1', [10, 10]);
    Keyboard.press('ArrowLeft', 'ArrowLeft', { shift: true });
    Keyboard.press('ArrowUp', 'ArrowUp', { shift: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(updates(posted())).toEqual([['m1', [-5, -5, 320, 100]]]);
  });

  it('a press on the board posts the run at once, before the press does anything', async () => {
    vi.useFakeTimers();
    const { posted, board } = open(owner(note('m1', NOTE)));
    clickOn('m1', [10, 10]);
    Keyboard.press('ArrowRight');
    new Pointer().on(board).click(pageAt(700, 300));
    await settle();
    expect(updates(posted())).toEqual([['m1', [1, 0, 320, 100]]]);
  });

  it('Left, Up and Shift with an arrow in the middle of a move are no nudge either', async () => {
    vi.useFakeTimers();
    const { posted } = open(owner(note('m1', NOTE)));
    const mouse = new Pointer().on(el('m1'));
    await Keyboard.withModifierKeys({ meta: true }, async () => {
      mouse.down(pageAt(10, 10));
      mouse.move(pageAt(60, 110));
      mouse.move(pageAt(110, 210));
      await frame();
    });
    expect(Keyboard.press('ArrowLeft')).toBe(true);
    expect(Keyboard.press('ArrowUp')).toBe(true);
    expect(Keyboard.press('ArrowRight', 'ArrowRight', { shift: true })).toBe(true);
    Keyboard.withModifierKeys({ meta: true }, () => mouse.up());
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(updates(posted())).toEqual([['m1', [100, 200, 320, 100]]]);
    expect(el('m1').dataset.box).toBe('100,200,320,100');
  });

  it('an arrow key in the middle of a move or a resize is not a nudge: the thing stays where the pointer left it, and the key stays the browser’s', async () => {
    vi.useFakeTimers();
    const { posted, board } = open(owner(note('m1', NOTE)), owner({ type: 'item.add', chapter: CH, item: { id: 'b1', kind: 'box', box: [600, 100, 200, 100] } }));
    // A move of the note, with a press of an arrow key before the pointer lifts.
    const mouse = new Pointer().on(el('m1'));
    await Keyboard.withModifierKeys({ meta: true }, async () => {
      mouse.down(pageAt(10, 10));
      mouse.move(pageAt(60, 110));
      mouse.move(pageAt(110, 210));
      await frame();
    });
    expect(Keyboard.press('ArrowRight')).toBe(true);
    Keyboard.withModifierKeys({ meta: true }, () => mouse.up());
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(updates(posted())).toEqual([['m1', [100, 200, 320, 100]]]);
    expect(el('m1').dataset.box).toBe('100,200,320,100');

    // A resize of the box, the same.
    new Pointer().on(board).click(pageAt(601, 150));
    expect(selectedIds()).toEqual(['b1']);
    const z = camera().z;
    const [px, py] = pageAt(800 + 4 / z, 200 + 4 / z);
    const hand = new Pointer().on(board);
    await Keyboard.withModifierKeys({ meta: true }, async () => {
      hand.down([px, py]);
      hand.move([px + 25 * z, py + 25 * z]);
      hand.move([px + 50 * z, py + 50 * z]);
      await frame();
    });
    expect(Keyboard.press('ArrowDown')).toBe(true);
    Keyboard.withModifierKeys({ meta: true }, () => hand.up());
    await settle();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(updates(posted()).slice(1)).toEqual([['b1', [600, 100, 250, 150]]]);
  });

  it('a run that ends where it began posts nothing and is no step: Right and then Left', async () => {
    vi.useFakeTimers();
    const { src, posted } = open(owner(note('m1', NOTE)));
    clickOn('m1', [10, 10]);
    Keyboard.press('ArrowRight');
    expect(el('m1').dataset.box).toBe('1,0,320,100');
    Keyboard.press('ArrowLeft');
    expect(el('m1').dataset.box).toBe('0,0,320,100');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(posted()).toEqual([]);
    // And it is no step: Undo has nothing to take back.
    Keyboard.press('z', 'KeyZ', { meta: true });
    await settle();
    expect(posted()).toEqual([]);
    // Nothing is left drawn ahead of the log: a move from elsewhere shows.
    await act(async () => {
      await src.post({ type: 'item.update', item: 'm1', patch: { box: [40, 60, 320, 100] } });
    });
    expect(el('m1').dataset.box).toBe('40,60,320,100');
  });

  it('a run that leaves a thing on the box it has posts nothing for it', async () => {
    vi.useFakeTimers();
    // The note is on a card four times the size it was: one unit as drawn is a quarter of one of the note's own, and its place is kept on whole ones.
    const { posted } = open(
      owner(note('m1', NOTE)),
      agent(text('a1', { answers: ['m1'] })),
      owner(placeAt('a1', [400, 0, 1520, 800])),
      owner(note('n2', [300, 250, 200, 80], { anchor: { item: 'a1', box: [300, 0, 380, 200] } })),
    );
    expect(el('n2').dataset.box).toBe('400,1000,200,80');
    clickOn('n2', [410, 1010]);
    Keyboard.press('ArrowRight');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(posted()).toEqual([]);
    expect(el('n2').dataset.box).toBe('400,1000,200,80');
    // Two more, and it is half a unit on: that is a move.
    Keyboard.press('ArrowRight');
    Keyboard.press('ArrowRight');
    Keyboard.press('ArrowRight');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(updates(posted())).toEqual([['n2', [301, 250, 200, 80]]]);
  });

  it('with nothing selected that can move, the key stays the browser’s', () => {
    const { board } = open(
      owner(note('m1', NOTE)),
      owner({ type: 'item.add', chapter: CH, item: { id: 'l1', kind: 'lasso', box: [-20, -20, 360, 140], path: [0, 0, 360, 0, 360, 140, 0, 140], targets: [{ item: 'm1' }] } }),
    );
    expect(Keyboard.press('ArrowRight')).toBe(true);
    // A lasso is drawn round what it holds: it does not move by itself.
    new Pointer().on(board).click(pageAt(-14, 50));
    expect(selectedIds()).toEqual(['l1']);
    expect(Keyboard.press('ArrowRight')).toBe(true);
  });
});

describe('the line round what is selected is drawn in the overlay, on the screen', () => {
  /** Where a ring is drawn on the board: its transform and its size, in screen pixels. */
  function ringAt(id: Id): [number, number, number, number] {
    const ring = document.querySelector<HTMLElement>(`[data-ring="${id}"]`)!;
    const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(ring.style.transform)!;
    return [Number(m[1]), Number(m[2]), Number.parseFloat(ring.style.width), Number.parseFloat(ring.style.height)];
  }
  /** The ring round a box on the screen: four pixels out, and the one-pixel line past that, on whole pixels. */
  const around = (x: number, y: number, w: number, h: number): [number, number, number, number] => {
    const c = camera();
    const [sx, sy] = [x * c.z + c.x, y * c.z + c.y];
    const left = Math.round(sx - 5);
    const top = Math.round(sy - 5);
    return [left, top, Math.round(sx + w * c.z + 5) - left, Math.round(sy + h * c.z + 5) - top];
  };

  it('one ring round each thing selected, none in the world, and a faint box round several', () => {
    open(...threeNotes());
    clickOn('m1', [10, 10]);
    expect(ringAt('m1')).toEqual(around(0, 0, 320, 100));
    expect(document.querySelector('[data-ring-all]')).toBeNull();
    clickOn('m3', [10, 410], { shift: true });
    expect(ringAt('m3')).toEqual(around(0, 400, 320, 100));
    const all = document.querySelector<HTMLElement>('[data-ring-all]')!;
    expect(all.hidden).toBe(false);
    expect(all.style.height).toBe(`${around(0, 0, 320, 500)[3]}px`);
    expect(document.querySelector('.overlay [data-ring="m1"]')).not.toBeNull();
    expect(document.querySelector('.world [data-ring]')).toBeNull();
  });

  it('follows the camera with no render of any item, and the hand as it moves', async () => {
    const { board } = open(owner(note('m1', NOTE)), agent(text('a1', { answers: ['m1'] })), owner(placeAt('a1', [400, 0, 300, 200])));
    clickOn('m1', [10, 10]);
    clickOn('a1', [410, 10], { shift: true });
    await frame();
    drawn.length = 0;
    wheel(board, { dx: 40, dy: 90, at: [300, 300] });
    await frame();
    wheel(board, { dy: -30, ctrl: true, at: [300, 300] });
    await frame();
    expect(ringAt('m1')).toEqual(around(0, 0, 320, 100));
    expect(ringAt('a1')).toEqual(around(400, 0, 300, 200));
    expect(drawn).toEqual([]);
    const mouse = new Pointer().on(el('m1'));
    mouse.down(pageAt(10, 10));
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move(pageAt(110, 60)));
    await frame();
    expect(ringAt('m1')).toEqual(around(100, 50, 320, 100));
    expect(ringAt('a1')).toEqual(around(500, 50, 300, 200));
    expect(drawn).toEqual([]);
    mouse.cancel();
    expect(ringAt('m1')).toEqual(around(0, 0, 320, 100));
  });

  it('a pin’s ring goes round its icon, which stands on its point', () => {
    const pin = { id: 'p1', kind: 'pin', box: [100, 150, 0, 0], at: [0, 0], on: { item: 'm1' } };
    open(owner(note('m1', [0, 0, 320, 300])), owner({ type: 'item.add', chapter: CH, item: pin }));
    new Pointer().on(el('p1')).click(pageAt(100, 140));
    expect(ringAt('p1')).toEqual(around(100 - 13, 150 - 24, 26, 26));
  });

  it('the handles of a box sit on the corners of its ring, and hide while it moves', async () => {
    const { board } = open(owner({ type: 'item.add', chapter: CH, item: { id: 'b1', kind: 'box', box: [100, 100, 200, 100] } }));
    new Pointer().on(board).click(pageAt(101, 150));
    const nw = document.querySelector<HTMLElement>('[data-handle="nw"]')!;
    const c = camera();
    expect(nw.hidden).toBe(false);
    expect(nw.style.transform).toBe(`translate(${Math.round(100 * c.z + c.x - 4 - 4)}px, ${Math.round(100 * c.z + c.y - 4 - 4)}px)`);
    expect(nw.style.width).toBe('8px');
    const mouse = new Pointer().on(board);
    mouse.down(pageAt(101, 150));
    mouse.move(pageAt(160, 190));
    await frame();
    expect(nw.hidden).toBe(true);
    mouse.up();
    await settle();
    expect(nw.hidden).toBe(false);
  });
});

describe('the handles and the hand while a gesture is no move', () => {
  const cursor = () => screen.getByTestId('board').style.cursor;
  const withBox = () => open(owner({ type: 'item.add', chapter: CH, item: { id: 'b1', kind: 'box', box: [100, 100, 200, 100] } }), owner(note('m1', [500, 400, 320, 100])));

  it('a resize moves nothing: the handles stay on the box as it is resized by one', async () => {
    const { board } = withBox();
    new Pointer().on(board).click(pageAt(101, 150));
    const nw = document.querySelector<HTMLElement>('[data-handle="nw"]')!;
    const se = document.querySelector<HTMLElement>('[data-handle="se"]')!;
    expect(nw.hidden).toBe(false);
    const z = camera().z;
    const [px, py] = pageAt(300 + 4 / z, 200 + 4 / z);
    const mouse = new Pointer().on(board);
    mouse.down([px, py]);
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move([px + 40 * z, py + 20 * z]));
    await frame();
    expect(el('b1').style.width).toBe('240px');
    expect(nw.hidden).toBe(false);
    expect(se.hidden).toBe(false);
    mouse.cancel();
  });

  it('a box drawn with Shift moves nothing: the hand is not closed, and the handles of what is selected stay', async () => {
    const { board } = withBox();
    new Pointer().on(board).click(pageAt(101, 150));
    const nw = document.querySelector<HTMLElement>('[data-handle="nw"]')!;
    expect(nw.hidden).toBe(false);
    const mouse = new Pointer().on(board);
    await Keyboard.withModifierKeys({ shift: true }, async () => {
      mouse.down(pageAt(900, 900));
      mouse.move(pageAt(950, 950));
      mouse.move(pageAt(1000, 1000));
      await frame();
      expect(screen.getByTestId('select-marquee').hidden).toBe(false);
      expect(cursor()).not.toBe('grabbing');
      expect(nw.hidden).toBe(false);
      mouse.up();
    });
  });
});

describe('the cursor comes from one table, set on the board from code', () => {
  const cursor = () => screen.getByTestId('board').style.cursor;
  /** Move the pointer over an element at a world point, with no button down, and let a frame pass. */
  async function hover(on: Element, at: readonly [number, number]) {
    new Pointer().on(on).move(pageAt(at[0], at[1]));
    await frame();
  }

  it('an open hand over what can move, a picture too; the default over the ground; a pointer over a control', async () => {
    const { board, container } = open(owner(note('m1', NOTE)), agent(text('a1', { answers: ['m1'] })), owner(placeAt('a1', [400, 0, 300, 200])));
    await hover(el('m1'), [10, 10]);
    expect(cursor()).toBe('grab');
    await hover(el('a1'), [410, 10]);
    expect(cursor()).toBe('grab');
    await hover(board, [900, 900]);
    expect(cursor()).toBe('default');
    await hover(container.querySelector('[data-item="a1"] button')!, [420, 20]);
    expect(cursor()).toBe('pointer');
  });

  it('an open hand while a look round is pressed, a closed one while it moves', async () => {
    const { board } = open(owner(note('m1', NOTE)));
    await hover(board, [900, 500]);
    const mouse = new Pointer().on(board);
    mouse.down(pageAt(900, 500));
    expect(cursor()).toBe('grab');
    mouse.move(pageAt(960, 540));
    await frame();
    expect(cursor()).toBe('grabbing');
    mouse.up();
    expect(cursor()).toBe('default');
  });

  it('a closed hand while an arrow is dragged by itself: it is drawn again as it goes, not moved by a style, and it is a move all the same', async () => {
    const { board, posted } = open(owner({ type: 'item.add', chapter: CH, item: { id: 'a1', kind: 'arrow', box: [100, 100, 200, 0], from: [0, 0], to: [200, 0] } }));
    const mouse = new Pointer().on(board);
    mouse.move(pageAt(200, 100));
    await frame();
    expect(cursor()).toBe('grab');
    mouse.down(pageAt(200, 100));
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move(pageAt(260, 150)));
    await frame();
    expect(cursor()).toBe('grabbing');
    Keyboard.withModifierKeys({ meta: true }, () => mouse.up());
    await settle();
    expect(updates(posted())).toEqual([['a1', [160, 150, 200, 0]]]);
    expect(cursor()).not.toBe('grabbing');
  });

  it('a closed hand while things move, and back after', async () => {
    open(owner(note('m1', NOTE)));
    await hover(el('m1'), [10, 10]);
    const mouse = new Pointer().on(el('m1'));
    mouse.down(pageAt(10, 10));
    expect(cursor()).toBe('grab');
    mouse.move(pageAt(60, 40));
    await frame();
    expect(cursor()).toBe('grabbing');
    mouse.up();
    await settle();
    expect(cursor()).toBe('grab');
  });

  it('the resize arrows on a handle and an edge, and while resizing', async () => {
    const { board } = open(owner({ type: 'item.add', chapter: CH, item: { id: 'b1', kind: 'box', box: [100, 100, 200, 100] } }));
    new Pointer().on(board).click(pageAt(101, 150));
    const z = camera().z;
    await hover(board, [300 + 4 / z, 200 + 4 / z]);
    expect(cursor()).toBe('nwse-resize');
    await hover(board, [300 + 4 / z, 150]);
    expect(cursor()).toBe('ew-resize');
    const mouse = new Pointer().on(board);
    mouse.down(pageAt(300 + 4 / z, 150));
    mouse.move(pageAt(360, 150));
    await frame();
    expect(cursor()).toBe('ew-resize');
    mouse.up();
  });

  it('during a press, what the pointer passes over does not change it: a stroke over a picture’s button keeps the crosshair', async () => {
    const { container } = open(owner(note('m1', NOTE)), agent(text('a1', { answers: ['m1'] })), owner(placeAt('a1', [400, 0, 300, 200])));
    Keyboard.press('p');
    const mouse = new Pointer().on(screen.getByTestId('board'));
    mouse.down(pageAt(900, 500));
    mouse.on(container.querySelector('[data-item="a1"] button')!).move(pageAt(420, 20));
    await frame();
    expect(cursor()).toBe('crosshair');
    mouse.up();
  });

  it('a crosshair for the drawing tools, an open hand for the Pan tool and with Space held', async () => {
    open(owner(note('m1', NOTE)));
    await hover(el('m1'), [10, 10]);
    Keyboard.press('p');
    expect(cursor()).toBe('crosshair');
    Keyboard.press('h');
    expect(cursor()).toBe('grab');
    Keyboard.press('v');
    expect(cursor()).toBe('grab');
    Keyboard.press('b');
    expect(cursor()).toBe('crosshair');
    Keyboard.keyDown(' ');
    expect(cursor()).toBe('grab');
    Keyboard.keyUp(' ');
    expect(cursor()).toBe('crosshair');
  });
});

describe('the run of arrow keys, on a board of its own', () => {
  it('a run ends when what is selected changes: each thing gets its own change', async () => {
    vi.useFakeTimers();
    const b = openBoard();
    b.must('owner', note('m1', NOTE));
    b.must('owner', note('m2', [0, 200, 320, 100]));
    let selection: readonly Id[] = ['m1'];
    const { board, did } = fakeBoard();
    const nudger = createNudge({
      ...board,
      state: () => b.state,
      boxes: () => new Map<Id, Box>([['m1', NOTE], ['m2', [0, 200, 320, 100]]]),
      where: () => ({ state: b.state, boxes: new Map(), subs: new Map() }),
      selection: () => selection,
    });
    expect(nudger.nudge(1, 0)).toBe(true);
    selection = ['m2'];
    expect(nudger.nudge(0, 1)).toBe(true);
    expect(did.sent).toEqual([{ type: 'item.update', item: 'm1', patch: { box: [1, 0, 320, 100] } }]);
    await vi.advanceTimersByTimeAsync(500);
    expect(did.sent.at(-1)).toEqual({ type: 'item.update', item: 'm2', patch: { box: [0, 201, 320, 100] } });
    expect(did.groups).toEqual([['m1'], ['m2']]);
  });
});

describe('the board a frame of a gesture has', () => {
  it('the things it holds are at the boxes it gives them, and the parts inside a moved picture move with it', () => {
    const b = openBoard();
    const where = { state: b.state, boxes: new Map<Id, Box>([['n1', [5, 5, 10, 10]]]), subs: new Map<string, Box>([['a1/part:queue', [10, 20, 30, 40]], ['a2/part:queue', [1, 2, 3, 4]]]) };
    const w = whereWith(where, { stored: new Map<Id, Box>([['a1', [100, 100, 50, 50]]]), moved: new Set(['a1']), dx: 7, dy: -3 });
    expect(w.boxes.get('a1')).toEqual([100, 100, 50, 50]);
    expect(w.boxes.get('n1')).toEqual([5, 5, 10, 10]);
    expect(w.subs.get('a1/part:queue')).toEqual([17, 17, 30, 40]);
    expect(w.subs.get('a2/part:queue')).toEqual([1, 2, 3, 4]);
  });
});
