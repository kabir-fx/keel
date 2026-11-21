import type { Actor } from '@keel/protocol';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { LocalSource } from '../src/source';
import { localSource } from '../src/source';
import { CH, note, openBoard } from './helpers';
import { Keyboard, frame, frames, resetInput, wheel } from './pointer';

/**
 * What of the camera's chrome renders again, and when. The minimap and "back to the board" each
 * draw through a stand-in that puts the real one in a React profiler, which counts every commit
 * the real one rendered in: for its parent, and for the camera it listens to. The stand-in is a
 * memo when the real one is, and then compares as the real one does, so it skips exactly when
 * the real one would.
 */
const seen = vi.hoisted(() => ({ minimap: 0, back: 0 }));

/** What a memo made by React carries: the component it wraps, and how it compares. */
interface Memo<P> {
  $$typeof?: symbol;
  compare?: ((a: P, b: P) => boolean) | null;
}

vi.mock('../src/camera/Minimap', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/camera/Minimap')>();
  const { Profiler, createElement, memo } = await import('react');
  type Props = ComponentProps<typeof real.Minimap>;
  const count = () => {
    seen.minimap += 1;
  };
  const Counting = (props: Props) => createElement(Profiler, { id: 'minimap', onRender: count }, createElement(real.Minimap, props));
  const made = real.Minimap as unknown as Memo<Props>;
  return { ...real, Minimap: made.$$typeof === Symbol.for('react.memo') ? memo(Counting, made.compare ?? undefined) : Counting };
});

vi.mock('../src/camera/BackToBoard', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/camera/BackToBoard')>();
  const { Profiler, createElement, memo } = await import('react');
  type Props = ComponentProps<typeof real.BackToBoard>;
  const count = () => {
    seen.back += 1;
  };
  const Counting = (props: Props) => createElement(Profiler, { id: 'back', onRender: count }, createElement(real.BackToBoard, props));
  const made = real.BackToBoard as unknown as Memo<Props>;
  return { ...real, BackToBoard: made.$$typeof === Symbol.for('react.memo') ? memo(Counting, made.compare ?? undefined) : Counting };
});

function forget() {
  seen.minimap = 0;
  seen.back = 0;
}

beforeEach(() => {
  vi.useFakeTimers();
  forget();
});

afterEach(() => {
  cleanup();
  resetInput();
  vi.useRealTimers();
});

async function open() {
  const b = openBoard();
  b.must('owner', note('m1', [0, 0, 320, 100]));
  b.must('owner', note('m2', [900, 700, 320, 100]));
  const src = localSource({ events: b.events });
  const view = render(<App source={src} />);
  await frames(2);
  forget();
  return { src, board: screen.getByTestId('board'), ...view };
}

/** Post as an actor, and fail loudly on a refusal. */
async function post(src: LocalSource, by: Actor, draft: Record<string, unknown>) {
  const r = await act(() => src.postAs(by, draft as never));
  expect(r.ok, JSON.stringify(r)).toBe(true);
}

describe('the minimap and "back to the board" render only when what they show changes', () => {
  it('a pan and a zoom, frame after frame, render neither', async () => {
    const { board } = await open();
    for (let i = 0; i < 10; i++) {
      wheel(board, { dx: 20, dy: 12 });
      await frame();
    }
    for (let i = 0; i < 10; i++) {
      wheel(board, { dy: -6, ctrl: true, at: [300, 200] });
      await frame();
    }
    expect(seen).toEqual({ minimap: 0, back: 0 });
  });

  it('a pan and a zoom, frame after frame, read no panel’s place from the page', async () => {
    const { board } = await open();
    let reads = 0;
    const real = Element.prototype.getBoundingClientRect;
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.matches('[data-viewport-ui]')) reads += 1;
      return real.call(this);
    });
    // The board asks on every frame of a move whether something new has come into view, clear of
    // the panels. The first time after a render it measures the room they leave; then it remembers.
    wheel(board, { dx: 20 });
    await frame();
    const measured = reads;
    for (let i = 0; i < 10; i++) {
      wheel(board, { dx: 20, dy: 12 });
      await frame();
    }
    for (let i = 0; i < 10; i++) {
      wheel(board, { dy: -6, ctrl: true, at: [300, 200] });
      await frame();
    }
    expect(reads).toBe(measured);
    // A render of the board may have moved a panel, and so may a new size of the window: the
    // next move measures once more, and the ones after it remember again.
    const oneMove = async () => {
      const before = reads;
      wheel(board, { dx: 20 });
      await frame();
      return reads - before;
    };
    Keyboard.press('p');
    expect(await oneMove()).toBeGreaterThan(0);
    expect(await oneMove()).toBe(0);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(await oneMove()).toBeGreaterThan(0);
    expect(await oneMove()).toBe(0);
    spy.mockRestore();
  });

  it('the board rendering again for something else renders neither: a tool taken in hand, a chapter renamed', async () => {
    const { src } = await open();
    Keyboard.press('p');
    Keyboard.press('s');
    await frame();
    expect(screen.getByRole('toolbar', { name: 'Tools' })).toBeTruthy();
    expect(seen).toEqual({ minimap: 0, back: 0 });
    await post(src, 'owner', { type: 'chapter.rename', chapter: CH, title: 'One engine, many more requests' });
    expect(screen.getByTestId('board-name').textContent).toContain('many more requests');
    expect(seen).toEqual({ minimap: 0, back: 0 });
  });

  it('a new item renders both, once, and the minimap then draws it', async () => {
    const { src } = await open();
    await post(src, 'owner', note('m3', [400, 300, 320, 100]));
    expect(seen).toEqual({ minimap: 1, back: 1 });
    expect(screen.getByTestId('minimap').querySelectorAll('rect')).toHaveLength(3);
  });

  it('the button coming and going renders "back to the board" once each way, and the pans between them not at all', async () => {
    const { board } = await open();
    for (let i = 0; i < 5; i++) {
      wheel(board, { dx: 40000 });
      await frame();
    }
    expect(screen.getByTestId('back-to-board')).toBeTruthy();
    expect(seen).toEqual({ minimap: 0, back: 1 });
    for (let i = 0; i < 5; i++) {
      wheel(board, { dx: -40000 });
      await frame();
    }
    expect(screen.queryByTestId('back-to-board')).toBeNull();
    expect(seen).toEqual({ minimap: 0, back: 2 });
  });
});
