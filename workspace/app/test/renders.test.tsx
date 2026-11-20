import type { Actor, Box, PictureItem } from '@keel/protocol';
import type { PictureProps } from '@keel/pictures';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { HoverStore } from '../src/board/hover';
import type { Edge } from '../src/lineage';
import { Lineage } from '../src/lineage';
import { sameReads, stateReads } from '../src/pictureReads';
import { MovingStore } from '../src/select/moving';
import type { LocalSource } from '../src/source';
import { localSource } from '../src/source';
import { CH, note, openBoard, placeAt, text } from './helpers';
import { Keyboard, Pointer, frame, frames, resetInput, wheel } from './pointer';

/**
 * What renders again, and when. The real pictures, marks and read chips draw, each through a
 * stand-in that counts its renders: a picture by `Picture`, a mark by `MarkView`, a chip by
 * `ReadChip`. The app's own renders are counted by `useShown`, which it calls once a render, the
 * lineage's routes by `routeEdge`, and what is drawn beside a thing (its tag, its chapter's
 * label) by `useHeldBox`, which each calls once a render.
 *
 * `Picture` is counted inside the real `PictureFrame`, so the count is the real memo's. The
 * stand-ins for `MarkView` and `ReadChip` take the real one's place, so each follows it (see
 * `standIn`): take the memo off the real one, and the counts here show it.
 */
const seen = vi.hoisted(() => ({ pictures: [] as string[], marks: [] as string[], chips: [] as string[], beside: [] as string[], app: 0, routes: 0 }));

/**
 * A stand-in that counts a render and then draws the real component. It is memoised only when
 * the real one is, and then with the real one's own test of its props, so it skips exactly when
 * the real one would.
 */
const standIn = vi.hoisted(() => <P extends object>(react: typeof import('react'), real: ComponentType<P>, count: (props: P) => void): ComponentType<P> => {
  const Counting = (props: P) => {
    count(props);
    return react.createElement(real, props);
  };
  const memoised = real as unknown as { $$typeof?: symbol; compare?: ((a: P, b: P) => boolean) | null };
  return memoised.$$typeof === Symbol.for('react.memo') ? react.memo(Counting, memoised.compare ?? undefined) : Counting;
});

vi.mock('@keel/pictures', async (importOriginal) => {
  const real = await importOriginal<typeof import('@keel/pictures')>();
  const { createElement } = await import('react');
  return {
    ...real,
    Picture: (props: PictureProps) => {
      seen.pictures.push(props.item.id);
      return createElement(real.Picture, props);
    },
  };
});

vi.mock('../src/items', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/items')>();
  return { ...real, MarkView: standIn(await import('react'), real.MarkView, (props) => seen.marks.push(props.item.id)) };
});

vi.mock('../src/reads', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/reads')>();
  return { ...real, ReadChip: standIn(await import('react'), real.ReadChip, (props) => seen.chips.push(props.chip.id)) };
});

vi.mock('../src/board/shown', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/board/shown')>();
  return {
    ...real,
    useShown: (...args: Parameters<typeof real.useShown>) => {
      seen.app += 1;
      return real.useShown(...args);
    },
  };
});

vi.mock('../src/route', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/route')>();
  return {
    ...real,
    routeEdge: (...args: Parameters<typeof real.routeEdge>) => {
      seen.routes += 1;
      return real.routeEdge(...args);
    },
  };
});

vi.mock('../src/select/following', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/select/following')>();
  return {
    ...real,
    useHeldBox: (...args: Parameters<typeof real.useHeldBox>) => {
      seen.beside.push(args[1]);
      return real.useHeldBox(...args);
    },
  };
});

function forget() {
  seen.beside.length = 0;
  seen.pictures.length = 0;
  seen.marks.length = 0;
  seen.chips.length = 0;
  seen.app = 0;
  seen.routes = 0;
}

beforeEach(forget);

afterEach(() => {
  cleanup();
  resetInput();
});

/** A busy board: notes, cards, a pipeline of the board's model, a choice, an ink circle on a card, an arrow between two cards, a lasso round a note and a card, and an answer in words under a note. */
function busyBoard() {
  const b = openBoard();
  b.must('agent', { type: 'model.patch', ops: [{ op: 'lane.set', lane: { id: 'bridge', name: 'Bridge' } }, { op: 'part.set', part: { id: 'queue', name: 'The queue', lane: 'bridge' } }] });
  b.must('owner', note('m1', [0, 0, 320, 100]));
  b.must('owner', note('m2', [0, 600, 320, 100]));
  b.must('agent', text('a1', { answers: ['m1'] }));
  b.must('owner', placeAt('a1', [400, 0, 380, 200]));
  b.must('agent', text('a2', { answers: ['m2'] }));
  b.must('owner', placeAt('a2', [400, 600, 380, 200]));
  b.must('agent', { type: 'item.add', chapter: CH, item: { id: 'p1', kind: 'picture', picture: { kind: 'pipeline', title: 'The pipeline' }, answers: ['m1'] } });
  b.must('owner', placeAt('p1', [1000, 0, 700, 400]));
  b.must('agent', {
    type: 'item.add',
    chapter: CH,
    item: { id: 'c1', kind: 'picture', picture: { kind: 'choice', title: 'Cap the door', options: [{ id: 'a', label: 'Cap it' }, { id: 'b', label: 'Leave it' }], chosen: 'a' }, answers: ['m2'] },
  });
  b.must('owner', placeAt('c1', [1000, 600, 440, 200]));
  b.must('owner', { type: 'item.add', chapter: CH, item: { id: 'k1', kind: 'ink', box: [390, -10, 400, 220], strokes: [{ pts: [0, 0, 400, 220] }], targets: [{ item: 'a1' }], hint: 'circle', anchor: { item: 'a1', box: [400, 0, 380, 200] } } });
  b.must('owner', { type: 'item.add', chapter: CH, item: { id: 'r1', kind: 'arrow', box: [590, 200, 0, 400], from: [0, 0], to: [0, 400], fromTarget: { item: 'a1' }, toTarget: { item: 'a2' } } });
  b.must('owner', { type: 'item.add', chapter: CH, item: { id: 'l1', kind: 'lasso', box: [-20, 580, 820, 240], path: [0, 0, 820, 0, 820, 240, 0, 240], targets: [{ item: 'm2' }, { item: 'a2' }] } });
  b.must('agent', { type: 'answer', answers: ['m2'], read: 'Open the bridge' });
  return b;
}

async function open(b = busyBoard()) {
  const src = localSource({ events: b.events });
  const view = render(<App source={src} />);
  await frames(2);
  forget();
  return { src, ...view };
}

/** Post as an actor, and fail loudly on a refusal. */
async function post(src: LocalSource, by: Actor, draft: Record<string, unknown>) {
  const r = await act(() => src.postAs(by, draft as never));
  expect(r.ok, JSON.stringify(r)).toBe(true);
}

describe('one board event renders again only what it touches', () => {
  it('a new note renders no picture, no other mark, and no read chip', async () => {
    const { src } = await open();
    await post(src, 'owner', note('m9', [0, 1200, 320, 100]));
    expect(seen.pictures).toEqual([]);
    expect(seen.marks).toEqual(['m9']);
    expect(seen.chips).toEqual([]);
  });

  it('moving one picture renders that picture, and the marks that hang on it', async () => {
    const { src } = await open();
    await post(src, 'owner', placeAt('a2', [400, 700, 380, 200]));
    expect(seen.pictures).toEqual(['a2']);
    // The arrow's end is tied to a2, and the lasso holds it; the circle on a1 has not moved.
    expect(seen.marks).toEqual(['r1', 'l1']);
    expect(seen.chips).toEqual([]);
  });

  it('a read chip renders again only when the mark it sits under moves', async () => {
    const { src, container } = await open();
    const chip = () => container.querySelector<HTMLElement>('.read-chip')!;
    const id = chip().dataset.read!;
    const before = chip().style.top;
    await post(src, 'owner', placeAt('m1', [0, 40, 320, 100]));
    expect(seen.chips).toEqual([]);
    await post(src, 'owner', placeAt('m2', [0, 640, 320, 100]));
    expect(seen.chips).toEqual([id]);
    expect(chip().style.top).not.toBe(before);
  });

  it('a part that changes state renders the pictures that draw the model, and no other', async () => {
    const { src } = await open();
    await post(src, 'owner', { type: 'part.state', part: 'queue', state: 'solid' });
    expect(seen.pictures).toEqual(['p1']);
    expect(seen.marks).toEqual([]);
  });

  it('a pick on a choice renders that choice, which then shows the pick', async () => {
    const { src, container } = await open();
    await post(src, 'owner', { type: 'choice.pick', item: 'c1', option: 'b' });
    expect(seen.pictures).toEqual(['c1']);
    expect(container.querySelector('[data-item="c1"] [data-chosen]')?.getAttribute('data-chosen')).toBe('b');
  });
});

describe('what the agent and the pointer do renders no item', () => {
  it('a presence change renders no item, and not the app', async () => {
    const { src } = await open();
    act(() => src.setPresence({ state: 'drawing', note: 'reading your marks' }));
    expect(screen.getByTestId('presence').dataset.state).toBe('drawing');
    act(() => src.setPresence({ state: 'listening', cursor: { item: 'a1' } }));
    expect(screen.getByTestId('presence').dataset.state).toBe('listening');
    expect(screen.getByTestId('agent-cursor')).toBeTruthy();
    expect(seen).toEqual({ pictures: [], marks: [], chips: [], beside: [], app: 0, routes: 0 });
  });

  it('a hover from one picture to the next renders no item, and not the app', async () => {
    const { container } = await open();
    fireEvent.pointerOver(container.querySelector('[data-item="a1"]')!);
    fireEvent.pointerOver(container.querySelector('[data-item="a2"]')!);
    fireEvent.pointerLeave(screen.getByTestId('board'));
    expect(seen).toEqual({ pictures: [], marks: [], chips: [], beside: [], app: 0, routes: 0 });
  });

  it('a wheel pan and a wheel zoom render no item', async () => {
    const { container } = await open();
    const board = screen.getByTestId('board');
    const before = container.querySelector<HTMLElement>('.world')!.style.transform;
    for (let i = 0; i < 5; i++) wheel(board, { dx: 20, dy: 30 });
    await frames(2);
    for (let i = 0; i < 5; i++) wheel(board, { dy: -10, ctrl: true, at: [200, 200] });
    await frames(2);
    expect(container.querySelector<HTMLElement>('.world')!.style.transform).not.toBe(before);
    expect(seen.pictures).toEqual([]);
    expect(seen.marks).toEqual([]);
    expect(seen.chips).toEqual([]);
    expect(seen.routes).toBe(0);
  });
});

describe('how the owner looks at a picture renders only the pictures that read it', () => {
  /** The busy board, with a walk of its model, a player for it, and a pipeline that shows it. */
  function walkBoard() {
    const b = busyBoard();
    b.must('agent', { type: 'model.patch', ops: [{ op: 'walk.set', walk: { id: 'w1', name: 'One request', steps: [{ n: 1, part: 'queue', text: 'wait' }, { n: 2, part: 'queue', text: 'go' }] } }] });
    b.must('agent', { type: 'item.add', chapter: CH, item: { id: 'wk', kind: 'picture', picture: { kind: 'walk', walk: 'w1' }, answers: ['m1'] } });
    b.must('owner', placeAt('wk', [1800, 0, 420, 300]));
    b.must('agent', { type: 'item.add', chapter: CH, item: { id: 'pw', kind: 'picture', picture: { kind: 'pipeline', title: 'The request', walk: 'w1' }, answers: ['m1'] } });
    b.must('owner', placeAt('pw', [1800, 600, 700, 400]));
    return b;
  }
  const inside = (container: HTMLElement, id: string) => within(container.querySelector<HTMLElement>(`[data-item="${id}"]`)!);

  it('a step of a walk renders the pictures that show that walk, and no other', async () => {
    const { container } = await open(walkBoard());
    fireEvent.click(inside(container, 'wk').getByLabelText('Next step'));
    expect(seen.pictures).toEqual(['wk', 'pw']);
    expect(seen.marks).toEqual([]);
    expect(container.querySelector('[data-item="wk"] [data-step]')?.getAttribute('data-step')).toBe('1');
    expect(container.querySelector('[data-item="pw"] [data-lit]')?.getAttribute('data-part')).toBe('queue');
    expect(container.querySelector('[data-item="p1"] [data-lit]')).toBeNull();
  });

  it('one pipeline switched to Flat renders the pipelines, which follow it, and no other picture', async () => {
    const { container } = await open(walkBoard());
    fireEvent.click(inside(container, 'p1').getByText('Flat'));
    expect(seen.pictures).toEqual(['p1', 'pw']);
    expect(container.querySelector('[data-item="p1"] [data-view]')?.getAttribute('data-view')).toBe('flat');
    expect(container.querySelector('[data-item="pw"] [data-view]')?.getAttribute('data-view')).toBe('flat');
  });
});

describe('the lineage routes again only what moved', () => {
  const boxes = new Map<string, Box>([
    ['m1', [0, 0, 300, 100]],
    ['a1', [600, 0, 300, 200]],
    ['m2', [0, 400, 300, 100]],
    ['a2', [600, 400, 300, 200]],
    ['in-the-way', [380, 420, 120, 60]],
  ]);
  const edges = (): Edge[] => [
    { from: 'm1', to: 'a1', kind: 'answers', primary: true },
    { from: 'm2', to: 'a2', kind: 'answers', primary: true },
  ];
  const obstacles = boxes;
  /** Nothing is in the owner's hand. */
  const moving = new MovingStore();

  it('draws the same edges again without routing them, and routes one again when its end moves', () => {
    const hover = new HoverStore();
    const { rerender, container } = render(<Lineage edges={edges()} boxOf={(id) => boxes.get(id)} hover={hover} moving={moving} obstacles={obstacles} />);
    expect(seen.routes).toBe(2);
    const before = container.querySelector('[data-lineage="m2>a2"]')!.getAttribute('d');
    rerender(<Lineage edges={edges()} boxOf={(id) => boxes.get(id)} hover={hover} moving={moving} obstacles={obstacles} />);
    expect(seen.routes).toBe(2);
    const moved: Box = [600, 700, 300, 200];
    rerender(<Lineage edges={edges()} boxOf={(id) => (id === 'a2' ? moved : boxes.get(id))} hover={hover} moving={moving} obstacles={obstacles} />);
    expect(seen.routes).toBe(3);
    expect(container.querySelector('[data-lineage="m2>a2"]')!.getAttribute('d')).not.toBe(before);
  });

  it('routes an arrow again, round the card, when a card moves into its way', () => {
    const hover = new HoverStore();
    const ends = new Map<string, Box>([
      ['m', [0, 0, 200, 100]],
      ['a', [800, 0, 300, 200]],
    ]);
    const one: Edge[] = [{ from: 'm', to: 'a', kind: 'answers', primary: true }];
    const boxOf = (id: string) => ends.get(id);
    const points = (container: HTMLElement) => container.querySelector('[data-lineage="m>a"]')!.getAttribute('d')!.split('L').length;
    const { rerender, container } = render(<Lineage edges={one} boxOf={boxOf} hover={hover} moving={moving} obstacles={new Map([...ends, ['card', [450, 900, 100, 100]]])} />);
    expect(seen.routes).toBe(1);
    expect(points(container)).toBe(2);
    // The same arrow between the same two boxes: only the card has moved, into the way.
    rerender(<Lineage edges={one} boxOf={boxOf} hover={hover} moving={moving} obstacles={new Map([...ends, ['card', [450, 20, 100, 100]]])} />);
    expect(seen.routes).toBe(2);
    expect(points(container)).toBeGreaterThan(2);
  });

  it('on the board: a note moved into an arrow’s way sends the arrow round it', async () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 200, 100]));
    b.must('agent', text('a1', { answers: ['m1'] }));
    b.must('owner', placeAt('a1', [800, 0, 300, 200]));
    b.must('owner', note('m8', [450, 900, 100, 100]));
    const { src, container } = await open(b);
    const points = () => container.querySelector('[data-lineage="m1>a1"]')!.getAttribute('d')!.split('L').length;
    expect(points()).toBe(2);
    await post(src, 'owner', placeAt('m8', [450, 20, 100, 100]));
    expect(seen.routes).toBe(1);
    expect(points()).toBeGreaterThan(2);
  });

  it('on the board: while a note is dragged, only the arrows with an end in the hand are routed again, once a frame, and the board is not drawn', async () => {
    const { container } = await open();
    const arrow = (edge: string) => container.querySelector(`[data-lineage="${edge}"]`)!.getAttribute('d');
    const still = [arrow('m2>a2'), arrow('m2>c1')];
    const before = [arrow('m1>a1'), arrow('m1>p1')];
    const mouse = new Pointer().on(container.querySelector('[data-item="m1"]')!);
    mouse.down([10, 10]);
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move([10, 110]));
    await frame();
    // The two arrows out of m1, and no other.
    expect(seen.routes).toBe(2);
    // The press selected the note, which drew the board. From here on the hand only moves.
    const boardDrawn = seen.app;
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move([10, 210]));
    await frame();
    expect(seen.routes).toBe(4);
    expect(seen.app).toBe(boardDrawn);
    expect([arrow('m1>a1'), arrow('m1>p1')]).not.toEqual(before);
    expect([arrow('m2>a2'), arrow('m2>c1')]).toEqual(still);
    mouse.cancel();
    expect([arrow('m1>a1'), arrow('m1>p1')]).toEqual(before);
  });

  it('on the board: while a note is dragged, its tag and its chapter’s label are drawn again to follow it, and the tag of a thing the hand does not hold is not', async () => {
    const b = openBoard();
    // The chapter's label stands over its first thing, m1.
    b.must('owner', note('m1', [0, 0, 320, 100]));
    b.must('owner', note('m2', [0, 300, 320, 100]));
    const { src, container } = await open(b);
    // Both notes were made in a session that is not this one: each has its tag.
    act(() => src.setForeign([{ from: 3, to: 4 }]));
    expect(container.querySelector('[data-foreign="m1"]')).not.toBeNull();
    expect(container.querySelector('[data-foreign="m2"]')).not.toBeNull();
    const mouse = new Pointer().on(container.querySelector('[data-item="m1"]')!);
    mouse.down([10, 10]);
    Keyboard.withModifierKeys({ meta: true }, () => mouse.move([40, 30]));
    await frame();
    forget();
    for (const to of [[80, 60], [120, 90], [160, 120]] as const) {
      Keyboard.withModifierKeys({ meta: true }, () => mouse.move(to));
      await frame();
    }
    // Once a frame each for the tag and the label of the one in the hand, and never for the other's tag.
    expect(seen.beside).toEqual(['m1', 'm1', 'm1', 'm1', 'm1', 'm1']);
    expect(seen.app).toBe(0);
    mouse.cancel();
  });

  it('on the board: an event that moves nothing it draws routes nothing, and a hover routes only the arrows it opens', async () => {
    const b = busyBoard();
    b.must('agent', { type: 'item.add', chapter: CH, item: { id: 'a3', kind: 'picture', picture: { kind: 'text', title: 'Three' }, from: ['a1', 'c1'], answers: ['m2'] } });
    b.must('owner', placeAt('a3', [1800, 600, 300, 200]));
    const src = localSource({ events: b.events });
    const { container } = render(<App source={src} />);
    await frames(2);
    forget();
    await post(src, 'owner', { type: 'chapter.rename', chapter: CH, title: 'One engine, many more requests' });
    expect(seen.app).toBeGreaterThan(0);
    expect(seen.routes).toBe(0);
    const into = () => [...container.querySelectorAll('[data-lineage$=">a3"]')].length;
    const shut = into();
    fireEvent.pointerOver(container.querySelector('[data-item="a3"]')!);
    expect(into()).toBeGreaterThan(shut);
    expect(seen.routes).toBe(into() - shut);
  });
});

describe('what a picture reads of the state', () => {
  const pic = (id: string, picture: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id, kind: 'picture', picture, ...extra }) as unknown as PictureItem;

  it('a card, and a picture still drawing, read nothing', () => {
    const s = busyBoard().state;
    expect(stateReads(s, pic('t', { kind: 'text', title: 'A card' }))).toEqual([]);
    expect(stateReads(s, pic('p', { kind: 'pipeline' }, { status: 'drawing' }))).toEqual([]);
  });

  it('a pipeline of the board’s model reads every part, and sees one change; one with its own model reads nothing', () => {
    const b = busyBoard();
    const p1 = b.state.items.p1!.item as PictureItem;
    const before = stateReads(b.state, p1);
    expect(before).toContain(b.state.model.parts.queue);
    b.must('owner', note('m9', [0, 1200, 320, 100]));
    expect(sameReads(before, stateReads(b.state, p1))).toBe(true);
    b.must('owner', { type: 'part.state', part: 'queue', state: 'solid' });
    expect(sameReads(before, stateReads(b.state, p1))).toBe(false);
    expect(stateReads(b.state, pic('own', { kind: 'pipeline', model: { lanes: [], parts: [] } }))).toEqual([]);
  });

  it('a choice reads its own state on the board and its part', () => {
    const b = busyBoard();
    const c1 = b.state.items.c1!.item as PictureItem;
    const before = stateReads(b.state, c1);
    b.must('owner', { type: 'choice.pick', item: 'c1', option: 'b' });
    expect(sameReads(before, stateReads(b.state, c1))).toBe(false);
  });

  it('a blueprint reads its chapter, and where each pick came from, a few marks deep', () => {
    const b = busyBoard();
    b.must('owner', note('on-card', [420, 20, 200, 60], { on: { item: 'a1' } }));
    const bp = pic('bp', { kind: 'blueprint', title: 'The plan', picks: [{ text: 'Cap it', from: { item: 'on-card' } }], proof: [], parts: [] });
    const reads = stateReads(b.state, bp);
    expect(reads).toContain(b.state.items['on-card']);
    expect(reads).toContain(b.state.items.a1);
    b.must('owner', { type: 'chapter.rename', chapter: CH, title: 'Renamed' });
    const named = pic('bp', { kind: 'blueprint', title: 'The plan', picks: [], proof: [], parts: [] });
    const s = { ...b.state, items: { ...b.state.items, bp: { ...b.state.items.a1!, item: named } } };
    expect(stateReads(s, named)).toContain(s.chapters[CH]);
  });
});
