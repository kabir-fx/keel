import type { Box } from '@keel/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { LocalSource } from '../src/source';
import { localSource } from '../src/source';
import { CH, note, openBoard, placeAt, text } from './helpers';
import { Keyboard, Pointer, frame, frames, resetInput, wheel } from './pointer';
import { reduceMotion } from './reducedMotion';

/**
 * Where the board takes the camera by itself, with motion on: the first view, the focus view,
 * what is new, and a fit made as the focus view closes. The pictures are a test double with a
 * part to tap.
 *
 * Time is the test's own: a frame is 16 ms, so a glide of 500 ms lands on its 32nd frame and
 * one of 300 ms on its 19th.
 */
vi.mock('@keel/pictures', () => ({
  Star: () => null,
  StateChip: ({ state }: { state: string }) => createElement('span', { className: 'k-state' }, state),
  Picture: ({ item, onAct }: { item: { id: string }; onAct?: (a: unknown) => void }) =>
    createElement(
      'div',
      { 'data-double': item.id, style: { width: '300px', height: '200px' } },
      createElement('div', { 'data-sub': 'part:queue', onClick: () => onAct?.({ type: 'tap', item: item.id, sub: 'part:queue' }) }, 'the queue'),
    ),
}));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  resetInput();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Frames enough for any glide to land. */
const landed = () => frames(40);

/** The camera, read back from the world's transform: screen = world * z + (x, y). */
function camera(container: HTMLElement) {
  const t = container.querySelector<HTMLElement>('.world')!.style.transform;
  const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(t)!;
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}

/** Where a world box is on the page, by the camera on the page. */
function onPage(container: HTMLElement, [x, y, w, h]: Box) {
  const c = camera(container);
  return { left: x * c.z + c.x, top: y * c.z + c.y, right: (x + w) * c.z + c.x, bottom: (y + h) * c.z + c.y };
}

/** True when the whole of a world box is in the window. */
function inWindow(container: HTMLElement, box: Box): boolean {
  const r = onPage(container, box);
  return r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight;
}

const FOCUS: Box = [3000, 3000, 400, 300];

/** A board with a part, a note, a card, and the part's focus picture far from both. */
function board() {
  const b = openBoard();
  b.must('agent', { type: 'model.patch', ops: [{ op: 'lane.set', lane: { id: 'bridge', name: 'Bridge' } }, { op: 'part.set', part: { id: 'queue', name: 'The queue', lane: 'bridge' } }] });
  b.must('owner', note('m1', [0, 0, 320, 100]));
  b.must('agent', text('a1', { answers: ['m1'] }));
  b.must('owner', placeAt('a1', [400, 0, 380, 200]));
  return b;
}

const focusItem = (extra: Record<string, unknown> = {}) => ({ type: 'item.add', chapter: CH, item: { id: 'f1', kind: 'picture', picture: { kind: 'focus', part: 'queue', title: 'The queue' }, from: ['a1'], ...extra } });

function withFocus() {
  const b = board();
  b.must('agent', focusItem());
  b.must('owner', placeAt('f1', FOCUS));
  return b;
}

/** The agent draws a picture to go beside `near`, and the page places it there. Answers with where. */
async function draw(src: LocalSource, id: string, near: string, side: 'right' | 'below' = 'right', answers: readonly string[] = [near]): Promise<Box> {
  await act(async () => {
    await src.postAs('agent', text(id, { answers, place: { near, side } }) as never);
  });
  const box = src.state.items[id]?.item.box;
  if (!box) throw new Error(`the page did not place "${id}"`);
  return box;
}

const tapQueue = (container: HTMLElement) =>
  act(async () => {
    fireEvent.click(container.querySelector('[data-double="a1"] [data-sub="part:queue"]')!);
  });

describe('the first view arrives as the board opens', () => {
  it('lands at once with motion on: it is fitted before the first frame, and no frame moves it', async () => {
    reduceMotion(false);
    const { container } = render(<App source={localSource({ events: board().events })} />);
    const first = camera(container);
    expect(first).not.toEqual({ x: 0, y: 0, z: 1 });
    expect(inWindow(container, [0, 0, 780, 200])).toBe(true);
    await landed();
    expect(camera(container)).toEqual(first);
  });

  it('on a focus picture lands at once too, and Esc then glides back to the whole board', async () => {
    reduceMotion(false);
    const { container } = render(<App source={localSource({ events: withFocus().events })} focus="f1" />);
    expect(screen.getByTestId('focus-crumb')).toBeTruthy();
    const first = camera(container);
    expect(inWindow(container, FOCUS)).toBe(true);
    expect(inWindow(container, [0, 0, 320, 100])).toBe(false);
    await landed();
    expect(camera(container)).toEqual(first);
    Keyboard.press('Escape');
    expect(camera(container)).toEqual(first);
    await landed();
    expect(inWindow(container, FOCUS)).toBe(true);
    expect(inWindow(container, [0, 0, 320, 100])).toBe(true);
  });
});

describe('the focus view glides in and out', () => {
  it('opens with a glide of 500 ms to the picture, and Esc glides back to where the camera was', async () => {
    const { container } = render(<App source={localSource({ events: withFocus().events })} show={['m1', 'a1']} />);
    const before = camera(container);
    reduceMotion(false);
    await tapQueue(container);
    expect(screen.getByTestId('focus-crumb')).toBeTruthy();
    // A glide: it has not moved yet.
    expect(camera(container)).toEqual(before);
    await frames(31);
    const almost = camera(container);
    expect(almost).not.toEqual(before);
    await frame();
    const opened = camera(container);
    expect(opened).not.toEqual(almost);
    expect(inWindow(container, FOCUS)).toBe(true);
    await landed();
    expect(camera(container)).toEqual(opened);

    Keyboard.press('Escape');
    expect(screen.queryByTestId('focus-crumb')).toBeNull();
    expect(camera(container)).toEqual(opened);
    await frames(31);
    expect(camera(container)).not.toEqual(opened);
    expect(camera(container)).not.toEqual(before);
    await frame();
    expect(camera(container)).toEqual(before);
  });

  it('opened while the camera glides, it goes back to where that glide was going, also when Esc comes in the middle of its own glide', async () => {
    const src = localSource({ events: board().events });
    const { container } = render(<App source={src} />);
    const el = screen.getByTestId('board');
    // Where a fit of the whole board lands.
    wheel(el, { dx: 500, dy: 300 });
    Keyboard.press('1');
    const fitted = camera(container);
    // The owner asks for the part's focus; the agent has not drawn it yet.
    await tapQueue(container);
    expect(screen.getByTestId('focus-opening')).toBeTruthy();
    wheel(el, { dx: 500, dy: 300 });
    await frame();
    reduceMotion(false);
    Keyboard.press('1');
    await frames(3);
    expect(camera(container)).not.toEqual(fitted);
    // The focus arrives while the fit still glides, and opens.
    const ask = src.events.find((e) => e.type === 'ask')!;
    await act(async () => {
      await src.postAs('agent', focusItem({ answers: [ask.id] }) as never);
      await src.postAs('system', { type: 'item.place', item: 'f1', box: FOCUS } as never);
    });
    expect(screen.getByTestId('focus-crumb')).toBeTruthy();
    await frames(3);
    Keyboard.press('Escape');
    await landed();
    expect(camera(container)).toEqual(fitted);
  });
});

describe('what is new, with motion on', () => {
  /** A board whose first view shows the note and the card, with a note far off and one half-way for new pictures to land by. */
  function open() {
    const b = board();
    b.must('owner', note('m9', [9000, 9000, 320, 100]));
    b.must('owner', note('m5', [4500, 4500, 320, 100]));
    const src = localSource({ events: b.events });
    const view = render(<App source={src} show={['m1', 'a1']} />);
    return { src, el: screen.getByTestId('board'), ...view };
  }

  const pressNudge = () =>
    act(async () => {
      fireEvent.click(screen.getByTestId('nudge'));
    });

  it('a press on the nudge glides there in 300 ms: it lands on the 19th frame, not before and not after', async () => {
    const { src, container } = open();
    const far = await draw(src, 'far', 'm9');
    expect(screen.getByTestId('nudge')).toBeTruthy();
    reduceMotion(false);
    const before = camera(container);
    await pressNudge();
    expect(camera(container)).toEqual(before);
    await frames(18);
    const almost = camera(container);
    expect(almost).not.toEqual(before);
    await frame();
    const there = camera(container);
    expect(there).not.toEqual(almost);
    expect(inWindow(container, far)).toBe(true);
    await landed();
    expect(camera(container)).toEqual(there);
    expect(screen.queryByTestId('nudge')).toBeNull();
  });

  it('a picture that lands where a glide is taking the view is not announced on the way, nor once there', async () => {
    const { src, container, el } = open();
    reduceMotion(false);
    // A fit of the whole board, far from the first view.
    Keyboard.press('1');
    await frames(2);
    const mid = await draw(src, 'mid', 'm5');
    // Not in view yet: the camera has only begun to move.
    expect(inWindow(container, mid)).toBe(false);
    await frame();
    expect(screen.queryByTestId('nudge')).toBeNull();
    await landed();
    expect(inWindow(container, mid)).toBe(true);
    expect(screen.queryByTestId('nudge')).toBeNull();
    // It was seen there: leaving it behind does not announce it.
    for (let i = 0; i < 4; i++) wheel(el, { dx: 20000 });
    await frames(2);
    expect(screen.queryByTestId('nudge')).toBeNull();
  });

  it('a picture is seen only once the camera rests with it in view: a glide to it stopped short by the wheel announces it again', async () => {
    const { src, container, el } = open();
    const far = await draw(src, 'far', 'm9');
    reduceMotion(false);
    await pressNudge();
    await frames(3);
    // On the way there it is not news.
    expect(screen.queryByTestId('nudge')).toBeNull();
    wheel(el, { dy: 10 });
    await frames(2);
    expect(inWindow(container, far)).toBe(false);
    expect(screen.getByTestId('nudge').textContent).toContain('card far');
    // Shown again, and this time left to arrive: it is seen for good.
    await pressNudge();
    await landed();
    expect(inWindow(container, far)).toBe(true);
    expect(screen.queryByTestId('nudge')).toBeNull();
    for (let i = 0; i < 4; i++) wheel(el, { dx: 20000 });
    await frames(2);
    expect(screen.queryByTestId('nudge')).toBeNull();
  });

  it('a glide to it stopped short by a press on the board announces it again too', async () => {
    const { src, container } = open();
    await draw(src, 'far', 'm9');
    reduceMotion(false);
    await pressNudge();
    await frames(3);
    expect(screen.queryByTestId('nudge')).toBeNull();
    const stopped = camera(container);
    new Pointer().click([10, 700]);
    await frames(2);
    expect(camera(container)).toEqual(stopped);
    expect(screen.getByTestId('nudge')).toBeTruthy();
  });
});

describe('what the agent draws for the owner’s mark, with motion on', () => {
  /** Write a note on the board, as the owner does: the mark the agent then answers. */
  async function writeNote(words: string): Promise<string> {
    Keyboard.press('n');
    new Pointer().click([300, 300]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Your note' }), { target: { value: words } });
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Your note' }), { key: 'Enter' });
    });
    return screen.getByText(words).closest<HTMLElement>('[data-item]')!.dataset.item!;
  }

  /** A board whose first view shows the note and the card, with a note far below and one far to the right for new pictures to land by. */
  function open() {
    const b = board();
    b.must('owner', note('below', [0, 2500, 320, 100]));
    b.must('owner', note('right', [3000, 0, 320, 100]));
    const src = localSource({ events: b.events });
    const view = render(<App source={src} show={['m1', 'a1']} />);
    return { src, el: screen.getByTestId('board'), ...view };
  }

  it('glides into view with the mark in 300 ms: on the 19th frame', async () => {
    const { src, container } = open();
    const mark = await writeNote('and streams back?');
    reduceMotion(false);
    const before = camera(container);
    const far = await draw(src, 'far', 'below', 'below', [mark]);
    expect(screen.queryByTestId('nudge')).toBeNull();
    expect(camera(container)).toEqual(before);
    await frames(18);
    const almost = camera(container);
    expect(almost).not.toEqual(before);
    await frame();
    const there = camera(container);
    expect(there).not.toEqual(almost);
    await landed();
    expect(camera(container)).toEqual(there);
    expect(inWindow(container, far)).toBe(true);
  });

  it('a second picture that arrives in the middle of that glide comes into view with the first, and neither is announced', async () => {
    const { src, container, el } = open();
    const mark = await writeNote('and streams back?');
    reduceMotion(false);
    const far = await draw(src, 'far', 'below', 'below', [mark]);
    await frames(5);
    const far2 = await draw(src, 'far2', 'right', 'right', [mark]);
    await landed();
    expect(inWindow(container, far)).toBe(true);
    expect(inWindow(container, far2)).toBe(true);
    expect(inWindow(container, [0, 0, 320, 100])).toBe(true);
    expect(screen.queryByTestId('nudge')).toBeNull();
    // Both were seen: leaving them behind announces neither.
    for (let i = 0; i < 4; i++) wheel(el, { dx: 40000 });
    await frames(2);
    expect(screen.queryByTestId('nudge')).toBeNull();
  });

  it('a glide for the mark stopped short by the wheel leaves the picture a nudge, and the view is not taken there again', async () => {
    const { src, container, el } = open();
    const mark = await writeNote('and streams back?');
    reduceMotion(false);
    const far = await draw(src, 'far', 'below', 'below', [mark]);
    await frames(3);
    wheel(el, { dy: 10 });
    await frames(2);
    const stopped = camera(container);
    expect(inWindow(container, far)).toBe(false);
    expect(screen.getByTestId('nudge')).toBeTruthy();
    await landed();
    expect(camera(container)).toEqual(stopped);
  });
});

describe('a fit made as the focus view closes keeps clear of the build', () => {
  /** Where the stylesheet puts the build on a wide window: down the right side when open, one line when folded. */
  const WATCH = { fromRight: 408, top: 88, width: 384, open: 632, folded: 50 };

  /** Give the build a place on the page: a test page has no layout. */
  function layOutWatch() {
    const real = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid !== 'watch') return real.call(this);
      return new DOMRect(window.innerWidth - WATCH.fromRight, WATCH.top, WATCH.width, this.classList.contains('watch--folded') ? WATCH.folded : WATCH.open);
    });
  }

  /** A board whose chapter is building, with the part's focus picture, and a wide note far off. */
  function building() {
    const b = withFocus();
    b.must('owner', note('wide-note', [0, 5000, 1600, 100]));
    b.must('owner', { type: 'solidify', chapter: CH, picks: ['m1'], parts: ['queue'] });
    b.must('owner', { type: 'build.start', chapter: CH, track: ['queue'], check: 'make check' });
    b.must('agent', { type: 'part.state', part: 'queue', state: 'building' });
    return b;
  }

  /** True when the box is drawn beside the open build: left of it by the fit's margin, and inside the window's left edge by as much. */
  function clearOfWatch(container: HTMLElement, box: Box) {
    const r = onPage(container, box);
    return r.left >= 24 - 1e-6 && r.right <= window.innerWidth - WATCH.fromRight - 24 + 1e-6;
  }

  it('"Show me" for a wide new picture, pressed in the focus view with the build open before it', async () => {
    layOutWatch();
    const src = localSource({ events: building().events });
    const { container } = render(<App source={src} focus="f1" />);
    // The focus view folded the build away.
    expect(screen.getByTestId('focus-crumb')).toBeTruthy();
    expect(screen.getByTestId('watch').className).toContain('watch--folded');
    // A new picture, drawn by the note and then made wide and moved far off by the owner.
    const wide: Box = [5000, 0, 1600, 300];
    await draw(src, 'wide', 'm1');
    await act(async () => {
      await src.postAs('owner', placeAt('wide', wide) as never);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('nudge'));
    });
    await frame();
    // The view is left, the build is back as it was, and the picture is beside it.
    expect(screen.queryByTestId('focus-crumb')).toBeNull();
    expect(screen.getByTestId('watch').className).not.toContain('watch--folded');
    expect(clearOfWatch(container, wide)).toBe(true);
    expect(screen.queryByTestId('nudge')).toBeNull();
  });

  it('"Show them" for what came from outside, pressed in the focus view', async () => {
    layOutWatch();
    const b = building();
    const src = localSource({ events: b.events });
    const at = b.events.findIndex((e) => e.type === 'item.add' && e.item.id === 'wide-note') + 1;
    src.setForeign([{ from: at, to: at }]);
    const { container } = render(<App source={src} focus="f1" />);
    expect(screen.getByTestId('watch').className).toContain('watch--folded');
    expect(screen.getByTestId('foreign').dataset.n).toBe('1');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Show them' }));
    });
    await frame();
    expect(screen.queryByTestId('focus-crumb')).toBeNull();
    expect(screen.getByTestId('watch').className).not.toContain('watch--folded');
    expect(clearOfWatch(container, [0, 5000, 1600, 100])).toBe(true);
  });
});
