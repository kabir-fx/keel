import type { Id, Target } from '@keel/protocol';
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { landFirst } from '../src/arrival/land';
import { PLAYS, WAITS } from '../src/arrival/attributes';
import { useLog } from '../src/board/log';
import { CameraStore } from '../src/camera/camera';
import type { LocalSource } from '../src/source';
import { localSource } from '../src/source';
import { note, openBoard, placeAt, text } from './helpers';
import { frames, resetInput } from './pointer';
import { reduceMotion } from './reducedMotion';

/**
 * The arrival on the board: the agent's picture is drawn on as it gets its place, with motion
 * on, and lands at once whenever the owner or the board needs it whole. Frames are the test's
 * own, 16 ms each; an arrival of a card is over well inside 150 of them.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  resetInput();
  vi.restoreAllMocks();
  vi.useRealTimers();
  Reflect.deleteProperty(document, 'hidden');
});

/** Frames enough for any arrival of a card to be over. */
const over = () => frames(150);

const CARD = { kind: 'text', title: 'How I read it', body: 'A small service that reminds people.', questions: ['By email only?', 'How many days before?'] };

/** A board with the owner's note, opened on the page. */
function open() {
  const b = openBoard();
  b.must('owner', note('m1', [0, 0, 320, 100]));
  const src = localSource({ events: b.events });
  const view = render(<App source={src} />);
  return { src, ...view };
}

/** The agent answers `mark` with a card, and the page places it. */
async function answer(src: LocalSource, id: Id = 'a1', mark: Id = 'm1') {
  await act(async () => {
    await src.postAs('agent', text(id, { answers: [mark], picture: CARD }) as never);
  });
  expect(src.state.items[id]?.item.box, `the page placed ${id}`).toBeDefined();
}

const item = (container: HTMLElement, id: Id) => container.querySelector<HTMLElement>(`.layer [data-item="${id}"]`)!;
const root = (container: HTMLElement, id: Id) => item(container, id).querySelector<HTMLElement>('[data-build]')!;
const arrow = (container: HTMLElement, id: Id) => container.querySelector<SVGPathElement>(`[data-lineage$=">${id}"]`);
const marked = (container: HTMLElement) => container.querySelectorAll(`[${PLAYS}], [${WAITS}]`).length;

/** Every animation made while `body` runs. */
function watchAnimations() {
  const made: Animation[] = [];
  const animate = Element.prototype.animate;
  vi.spyOn(Element.prototype, 'animate').mockImplementation(function (this: Element, ...args: Parameters<Element['animate']>) {
    const a = animate.apply(this, args);
    made.push(a);
    return a;
  });
  return made;
}

/** The picture and its arrow as the page has them, with nothing of an arrival on them. */
async function atRest(motion: boolean): Promise<{ picture: string; arrow: string | undefined }> {
  reduceMotion(!motion);
  const { src, container } = open();
  await answer(src);
  await over();
  const out = { picture: item(container, 'a1').outerHTML, arrow: arrow(container, 'a1')?.outerHTML };
  cleanup();
  return out;
}

describe('the agent\'s picture arriving on the board', () => {
  it('with motion, is drawn on: its root, its head, its words and its arrow are posed before the page is painted', async () => {
    reduceMotion(false);
    const made = watchAnimations();
    const { src, container } = open();
    await answer(src);
    expect(root(container, 'a1').hasAttribute(PLAYS)).toBe(true);
    const posed = new Set(made.map((a) => (a.effect as KeyframeEffect).target));
    expect(posed.has(root(container, 'a1'))).toBe(true);
    for (const el of item(container, 'a1').querySelectorAll('[data-build="head"], [data-build="block"]')) expect(posed.has(el)).toBe(true);
    expect(posed.has(arrow(container, 'a1'))).toBe(true);
    // Never the element the board positions and measures.
    expect(posed.has(item(container, 'a1'))).toBe(false);
  });

  it('once over, leaves the picture and its arrow exactly as a board with reduced motion has them: no animation, no attribute, no style', async () => {
    reduceMotion(false);
    const made = watchAnimations();
    const { src, container } = open();
    await answer(src);
    await over();
    expect(marked(container)).toBe(0);
    expect(made.length).toBeGreaterThan(0);
    expect(made.every((a) => a.playState === 'idle')).toBe(true);
    const played = { picture: item(container, 'a1').outerHTML, arrow: arrow(container, 'a1')?.outerHTML };
    cleanup();
    expect(played).toEqual(await atRest(false));
  });

  it('with reduced motion, nothing plays: no animation is made and no attribute is set', async () => {
    reduceMotion(true);
    const made = watchAnimations();
    const { src, container } = open();
    await answer(src);
    expect(made).toEqual([]);
    expect(marked(container)).toBe(0);
  });

  it('a picture that will not be in view simply is there', async () => {
    reduceMotion(false);
    const made = watchAnimations();
    const { src, container } = open();
    // A note far out of view, made elsewhere: the camera does not go to it.
    await act(async () => {
      await src.postAs('owner', note('far', [9000, 9000, 320, 100]) as never);
    });
    await answer(src, 'a1', 'far');
    expect(made).toEqual([]);
    expect(marked(container)).toBe(0);
  });

  it('two pictures in one moment: drawn at once, the second a beat after the first by a cursor of its own, and left out of the map while it waits', async () => {
    reduceMotion(false);
    const { src, container } = open();
    const mapped = () => container.querySelectorAll('[data-testid="minimap"] .mm-item--agent').length;
    await act(async () => {
      await src.postAs('agent', text('a1', { answers: ['m1'], picture: CARD }) as never);
      await src.postAs('agent', text('a2', { answers: ['m1'], picture: CARD }) as never);
    });
    expect(root(container, 'a1').hasAttribute(PLAYS)).toBe(true);
    expect(item(container, 'a2').hasAttribute(WAITS)).toBe(true);
    expect(mapped()).toBe(1);
    // A beat later both are drawn on, each by its own cursor.
    let n = 0;
    while (item(container, 'a2').hasAttribute(WAITS) && n++ < 30) await frames(1);
    expect(n).toBeLessThan(30);
    expect(root(container, 'a1').hasAttribute(PLAYS)).toBe(true);
    expect(root(container, 'a2').hasAttribute(PLAYS)).toBe(true);
    expect(mapped()).toBe(2);
    expect(container.querySelectorAll('[data-testid="agent-droplet"]')).toHaveLength(1);
    await over();
    expect(marked(container)).toBe(0);
    expect(container.querySelectorAll('.arrival-band')).toHaveLength(0);
    // And the cursors merge into one.
    await frames(60);
    expect(container.querySelectorAll('[data-testid="agent-droplet"]')).toHaveLength(0);
  });

  describe('lands at once', () => {
    async function playing() {
      reduceMotion(false);
      const made = watchAnimations();
      const view = open();
      await answer(view.src);
      await frames(10);
      expect(root(view.container, 'a1').hasAttribute(PLAYS)).toBe(true);
      const landed = () => marked(view.container) === 0 && made.every((a) => a.playState === 'idle');
      return { ...view, landed, made };
    }

    it('under the owner\'s press, which then does what it always does', async () => {
      const { container, landed } = await playing();
      act(() => {
        fireEvent.pointerDown(item(container, 'a1').querySelector('[data-build="block"]')!, { pointerId: 1, button: 0, buttons: 1, isPrimary: true });
      });
      expect(landed()).toBe(true);
    });

    it('when the owner moves it', async () => {
      const { src, landed } = await playing();
      await act(async () => {
        await src.postAs('owner', placeAt('a1', [600, 300, 380, 200]) as never);
      });
      expect(landed()).toBe(true);
    });

    it('when it is removed', async () => {
      const { src, landed } = await playing();
      await act(async () => {
        await src.postAs('owner', { type: 'item.remove', item: 'a1' } as never);
      });
      expect(landed()).toBe(true);
    });

    it('when the agent changes it: what it drew lands, and the redraw plays in its place', async () => {
      const { src, made, container } = await playing();
      const before = made.length;
      await act(async () => {
        await src.postAs('agent', { type: 'item.update', item: 'a1', patch: { picture: { ...CARD, title: 'How I read it now' } } } as never);
      });
      expect(made.slice(0, before).every((a) => a.playState === 'idle')).toBe(true);
      expect(made.length).toBeGreaterThan(before);
      expect(root(container, 'a1').hasAttribute(PLAYS)).toBe(true);
    });

    it('when the board leaves for the Story', async () => {
      const { container, landed } = await playing();
      act(() => {
        fireEvent.click(container.querySelector('[data-testid="view-story"]') ?? [...container.querySelectorAll('button')].find((b) => b.textContent === 'Story')!);
      });
      expect(landed()).toBe(true);
    });

    it('when the page is hidden', async () => {
      const { landed } = await playing();
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(landed()).toBe(true);
    });

    it('when the board goes', async () => {
      const { unmount, landed } = await playing();
      unmount();
      expect(landed()).toBe(true);
    });
  });

  it('when the owner turns on reduced motion, what plays and what waits land: nothing held, nothing posed, the cursor let go', async () => {
    reduceMotion(false);
    // A stand-in for the page's media query, which tells its listeners when it starts to match.
    let reduce = false;
    const listeners = new Set<(e: MediaQueryListEvent) => void>();
    const real = globalThis.matchMedia;
    vi.spyOn(globalThis, 'matchMedia').mockImplementation((query: string) => {
      if (!query.includes('prefers-reduced-motion')) return real(query);
      return {
        media: query,
        get matches() {
          return reduce;
        },
        onchange: null,
        addEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => listeners.add(l),
        removeEventListener: (_: string, l: (e: MediaQueryListEvent) => void) => listeners.delete(l),
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => true,
      } as unknown as MediaQueryList;
    });
    const made = watchAnimations();
    const { src, container, unmount } = open();
    await act(async () => {
      await src.postAs('agent', text('a1', { answers: ['m1'], picture: CARD }) as never);
      await src.postAs('agent', text('a2', { answers: ['m1'], picture: CARD }) as never);
    });
    // Inside the stagger: the first is drawn on, the second waits its beat.
    await frames(4);
    const cursor = () => container.querySelector<HTMLElement>('[data-testid="agent-cursor"]')!;
    expect(root(container, 'a1').hasAttribute(PLAYS)).toBe(true);
    expect(item(container, 'a2').hasAttribute(WAITS)).toBe(true);
    // Led as it draws, the cursor is working, not at rest.
    expect(cursor().hasAttribute('data-rest')).toBe(false);

    reduce = true;
    act(() => {
      for (const l of [...listeners]) l({ matches: true, media: '(prefers-reduced-motion: reduce)' } as MediaQueryListEvent);
    });
    expect(marked(container)).toBe(0);
    expect(made.every((a) => a.playState === 'idle')).toBe(true);
    expect(cursor().hasAttribute('data-rest')).toBe(true);
    // And nothing starts after.
    const before = made.length;
    await over();
    expect(made.length).toBe(before);
    // The board's listener goes with the board.
    unmount();
    expect(listeners.size).toBe(0);
  });

  it('a mark that hangs on a part of a picture being drawn on is not measured from its pose: it keeps what it had, and is measured once the picture is whole', async () => {
    reduceMotion(false);
    const { src, container } = open();
    await answer(src);
    const sub = () => item(container, 'a1').querySelector<HTMLElement>('[data-sub="q:1"]')!;
    const measured = vi.spyOn(sub(), 'getBoundingClientRect');
    await act(async () => {
      await src.postAs('owner', note('n2', [900, 0, 200, 60], { anchor: { item: 'a1', sub: 'q:1', box: [0, 0, 10, 10] } }) as never);
    });
    expect(root(container, 'a1').hasAttribute(PLAYS)).toBe(true);
    expect(measured).not.toHaveBeenCalled();
    await over();
    expect(measured).toHaveBeenCalled();
  });
});

describe('the variations on the board', () => {
  it('a placeholder arrives as a picture does; finished, it is held out of sight until it has its place, then pulled to it', async () => {
    reduceMotion(false);
    const made = watchAnimations();
    const { src, container } = open();
    await act(async () => {
      await src.postAs('agent', text('p1', { answers: ['m1'], status: 'drawing' }) as never);
    });
    // A spot on this page only: nothing is posted for it.
    expect(src.state.items.p1?.item.box).toBeUndefined();
    expect(root(container, 'p1').hasAttribute(PLAYS)).toBe(true);
    await over();
    expect(marked(container)).toBe(0);
    const before = made.length;
    const spot = item(container, 'p1').dataset.box;
    // Each time something is held out of sight: what it was, where the page drew it, and whether the log had placed it.
    const held: Array<{ id: string | undefined; finished: boolean; box: string | undefined; placed: boolean }> = [];
    const set = Element.prototype.setAttribute;
    vi.spyOn(Element.prototype, 'setAttribute').mockImplementation(function (this: Element, name: string, value: string) {
      if (name === WAITS && this instanceof HTMLElement) {
        const id = this.dataset.item;
        held.push({ id, finished: !this.querySelector('[data-status="drawing"]'), box: this.dataset.box, placed: !!(id && src.state.items[id]?.item.box) });
      }
      return set.call(this, name, value);
    });
    await act(async () => {
      await src.postAs('agent', { type: 'item.update', item: 'p1', patch: { picture: CARD, status: 'done' } } as never);
    });
    // Finished, and still on the placeholder's spot, not placed yet: held out of sight.
    expect(held).toEqual([{ id: 'p1', finished: true, box: spot, placed: false }]);
    // Then placed by the page, in the same frame, and no longer held: pulled from where the placeholder was.
    expect(src.state.items.p1?.item.box).toBeDefined();
    expect(item(container, 'p1').hasAttribute(WAITS)).toBe(false);
    await frames(1);
    expect(root(container, 'p1').hasAttribute(PLAYS)).toBe(true);
    expect(made.slice(before).some((a) => (a.effect as KeyframeEffect).target === root(container, 'p1'))).toBe(true);
    await over();
    expect(marked(container)).toBe(0);
    expect(made.every((a) => a.playState === 'idle')).toBe(true);
  });

  it('an answer in words: its chip is written in, and a press on the mark it hangs under lands it', async () => {
    reduceMotion(false);
    const made = watchAnimations();
    const { src, container } = open();
    await act(async () => {
      await src.postAs('agent', { type: 'answer', answers: ['m1'], read: 'a small service' } as never);
    });
    const chip = container.querySelector<HTMLElement>('[data-read]')!;
    expect(chip.hasAttribute(PLAYS)).toBe(true);
    expect(made.some((a) => (a.effect as KeyframeEffect).target === chip)).toBe(true);
    act(() => {
      fireEvent.pointerDown(item(container, 'm1'), { pointerId: 1, button: 0, buttons: 1, isPrimary: true });
    });
    expect(marked(container)).toBe(0);
    expect(made.every((a) => a.playState === 'idle')).toBe(true);
  });
});

describe('what the board measures and turns into an image is the board at rest', () => {
  it('lands every arrival before each measure that reads the page', () => {
    const order: string[] = [];
    const reads = {
      measure: () => (order.push('measure'), []),
      measureAll: () => (order.push('measureAll'), []),
      targetBox: (_t: Target) => (order.push('targetBox'), undefined),
      noteTarget: (_x: number, _y: number) => (order.push('noteTarget'), {}),
    };
    const m = landFirst(reads, () => order.push('land'));
    m.measure();
    m.measureAll();
    m.targetBox({ item: 'x' });
    m.noteTarget(0, 0);
    expect(order).toEqual(['land', 'measure', 'land', 'measureAll', 'land', 'targetBox', 'land', 'noteTarget']);
  });
});

describe('a mark of the owner\'s that a play feeds in', () => {
  const fed = () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 320, 100]));
    b.must('agent', text('a1', { answers: ['m1'] }));
    return b.events;
  };

  it('is told by the source as made on this page; the agent\'s items and the page\'s own posts are not', async () => {
    const src = localSource();
    const told: Id[] = [];
    const off = src.onOwnMark((id) => told.push(id));
    src.feed(fed());
    expect(told).toEqual(['m1']);
    await src.post(note('m2', [0, 200, 100, 60]) as never);
    expect(told).toEqual(['m1']);
    off();
    src.feed([]);
    expect(told).toEqual(['m1']);
  });

  it('counts as the owner\'s last mark, with the view as it was when it came', () => {
    const src = localSource();
    const camera = new CameraStore({ x: 10, y: 20, z: 1 });
    const { result } = renderHook(() =>
      useLog(src, camera, () => undefined, () => undefined, { begin: () => undefined, together: () => undefined, notComing: () => undefined } as never),
    );
    act(() => src.feed(fed()));
    expect(result.current.lastMark.current).toEqual({ mark: 'm1', cam: { x: 10, y: 20, z: 1 } });
  });
});
