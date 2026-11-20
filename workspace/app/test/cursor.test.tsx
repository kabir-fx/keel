import type { Presence } from '@keel/protocol';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { PILL_NOTE_MAX } from '../src/chrome';
import { CURSOR_GLIDE_MS } from '../src/input/constants';
import { CURSOR_SIZE, cursorPoint, cursorSays, placeCursor } from '../src/overlay/cursorPlace';
import { localSource } from '../src/source';
import { note, openBoard } from './helpers';
import { frame, frames, resetInput, wheel } from './pointer';
import { reduceMotion } from './reducedMotion';

const presence = (p: Omit<Presence, 'since'>): Presence => ({ since: '2026-11-19T10:00:00Z', ...p });

describe('where the agent’s cursor is drawn', () => {
  const size = { w: 1000, h: 800 };
  const cam = { x: 100, y: 50, z: 2 };

  it('at its world point through the camera, in board pixels', () => {
    expect(placeCursor([200, 150], cam, size)).toEqual({ x: 500, y: 350, off: false });
  });

  it('is on the board up to each edge, and off one pixel past it', () => {
    // Screen x = wx * 2 + 100: the left edge is wx = -50, the right one wx = 450.
    expect(placeCursor([-50, 100], cam, size).off).toBe(false);
    expect(placeCursor([-50.5, 100], cam, size).off).toBe(true);
    expect(placeCursor([450, 100], cam, size).off).toBe(false);
    expect(placeCursor([450.5, 100], cam, size).off).toBe(true);
    // Screen y = wy * 2 + 50: the top edge is wy = -25, the bottom one wy = 375.
    expect(placeCursor([100, -25], cam, size).off).toBe(false);
    expect(placeCursor([100, -25.5], cam, size).off).toBe(true);
    expect(placeCursor([100, 375], cam, size).off).toBe(false);
    expect(placeCursor([100, 375.5], cam, size).off).toBe(true);
  });

  it('off the board, it waits at the edge nearest its place, seen whole', () => {
    expect(placeCursor([-5000, 100], cam, size)).toEqual({ x: 0, y: 250, off: true });
    expect(placeCursor([100, -5000], cam, size)).toEqual({ x: 300, y: 0, off: true });
    expect(placeCursor([5000, 5000], cam, size)).toEqual({ x: size.w - CURSOR_SIZE, y: size.h - CURSOR_SIZE, off: true });
    // On the board but too near the far edges to be seen whole: in by its own size, still on.
    expect(placeCursor([445, 370], cam, size)).toEqual({ x: size.w - CURSOR_SIZE, y: size.h - CURSOR_SIZE, off: false });
  });

  it('points at a point of the board, or near the corner of an item; away, still where it was', () => {
    const boxOf = (id: string) => (id === 'a1' ? ([10, 20, 300, 200] as const) : undefined);
    expect(cursorPoint(presence({ state: 'drawing', cursor: { at: [5, 6] } }), boxOf)).toEqual([5, 6]);
    expect(cursorPoint(presence({ state: 'drawing', cursor: { item: 'a1' } }), boxOf)).toEqual([10 + 300 - 28, 20 + 200 - 18]);
    expect(cursorPoint(presence({ state: 'drawing', cursor: { item: 'gone' } }), boxOf)).toBeUndefined();
    expect(cursorPoint(presence({ state: 'drawing' }), boxOf)).toBeUndefined();
    expect(cursorPoint(presence({ state: 'away', cursor: { at: [5, 6] } }), boxOf)).toEqual([5, 6]);
  });

  it('says a note too long for the pill beside it; away it says nothing, the pill says why', () => {
    const long = 'x'.repeat(PILL_NOTE_MAX + 1);
    expect(cursorSays(presence({ state: 'drawing', note: long }), [])).toBe(long);
    expect(cursorSays(presence({ state: 'drawing', note: 'x'.repeat(PILL_NOTE_MAX) }), [])).toBeUndefined();
    expect(cursorSays(presence({ state: 'away', note: long }), [])).toBeUndefined();
  });

  it('a note that is only a chapter’s title is not said beside it, however long: the pill does not say it either', () => {
    const title = 'Tell me when the engine goes over what one request may cost';
    expect(title.length).toBeGreaterThan(PILL_NOTE_MAX);
    expect(cursorSays(presence({ state: 'drawing', note: title }), ['One engine, many requests', title])).toBeUndefined();
    expect(cursorSays(presence({ state: 'drawing', note: `“${title}”` }), [title])).toBeUndefined();
    // A note that only begins as a title does is the agent's own words.
    expect(cursorSays(presence({ state: 'drawing', note: `${title}, and why` }), [title])).toBe(`${title}, and why`);
    expect(cursorSays(presence({ state: 'drawing', note: title }), ['One engine, many requests'])).toBe(title);
  });
});

describe('the agent’s cursor on the board', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    resetInput();
    vi.useRealTimers();
  });

  function open(p: Omit<Presence, 'since'> = { state: 'drawing', cursor: { at: [400, 300] } }, chapter?: string) {
    const b = openBoard();
    if (chapter) b.must('owner', { type: 'chapter.open', chapter: 'second', title: chapter });
    b.must('owner', note('m1', [0, 0, 320, 100]));
    b.must('owner', note('m2', [900, 700, 320, 100]));
    const src = localSource({ events: b.events, presence: p });
    const commits = { n: 0 };
    const view = render(
      <Profiler id="board" onRender={() => (commits.n += 1)}>
        <App source={src} />
      </Profiler>,
    );
    return { src, commits, board: screen.getByTestId('board'), ...view };
  }

  const cursor = () => screen.getByTestId('agent-cursor');
  const at = () => {
    const m = /^translate\(([-\d.e]+)px, ([-\d.e]+)px\)$/.exec(cursor().style.transform);
    if (!m) throw new Error(`not a place: "${cursor().style.transform}"`);
    return [Number(m[1]), Number(m[2])];
  };
  const camera = (container: HTMLElement) => {
    const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(container.querySelector<HTMLElement>('.world')!.style.transform)!;
    return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
  };

  it('a note too long for the pill is drawn beside the cursor, where no screen reader looks: the pill says it to one, and shows it whole in its tip', async () => {
    const long = 'reading the three notes you pinned on the engine, then drawing how they fit';
    expect(long.length).toBeGreaterThan(PILL_NOTE_MAX);
    open({ state: 'drawing', note: long, cursor: { at: [400, 300] } });
    await frames(2);
    const pill = screen.getByTestId('presence');
    expect(cursor().textContent).toContain(long);
    expect(cursor().closest('[aria-hidden="true"]')).not.toBeNull();
    // What is seen in the pill is the state alone; what is read from it is the note as well.
    expect(pill.querySelector('.pill__said')!.textContent).toBe('The agent: drawing');
    expect(pill.querySelector('.for-reader')!.textContent).toBe(long);
    expect(pill.closest('[aria-hidden="true"]')).toBeNull();
    expect(pill.getAttribute('role')).toBe('status');
    expect(pill.dataset.tip).toBe(`The agent: ${long}`);
  });

  it('a long note that is only a chapter’s title is said nowhere: the pill and its tip say the state, and the cursor has no words', async () => {
    const title = 'Tell me when the engine goes over what one request may cost';
    open({ state: 'drawing', note: title, cursor: { at: [400, 300] } }, title);
    await frames(2);
    const pill = screen.getByTestId('presence');
    expect(cursor().textContent).not.toContain(title);
    expect(pill.querySelector('.pill__said')!.textContent).toBe('The agent: drawing');
    expect(pill.querySelector('.for-reader')).toBeNull();
    expect(pill.dataset.tip).toBe('The agent: drawing');
  });

  it('with no cursor on the board the pill says the long note itself, once; and a short note is never said twice', async () => {
    const long = 'reading the three notes you pinned on the engine, then drawing how they fit';
    const { unmount } = open({ state: 'drawing', note: long });
    await frames(2);
    expect(screen.queryByTestId('agent-cursor')).toBeNull();
    expect(screen.getByTestId('presence').querySelector('.pill__said')!.textContent).toBe(`The agent: ${long}`);
    expect(screen.getByTestId('presence').querySelector('.for-reader')).toBeNull();
    unmount();
    open({ state: 'drawing', note: 'two pictures', cursor: { at: [400, 300] } });
    await frames(2);
    expect(screen.getByTestId('presence').querySelector('.pill__said')!.textContent).toBe('The agent: two pictures');
    expect(screen.getByTestId('presence').querySelector('.for-reader')).toBeNull();
  });

  it('is drawn in the overlay, in screen space: its place is the camera’s, with no scale of its own', async () => {
    const { container, board } = open();
    await frames(2);
    expect(cursor().closest('.overlay')).not.toBeNull();
    expect(cursor().closest('.world')).toBeNull();
    const c = camera(container);
    expect(at()).toEqual([400 * c.z + c.x, 300 * c.z + c.y]);
    wheel(board, { dy: -40, ctrl: true, at: [300, 200] });
    await frame();
    const z = camera(container);
    expect(z.z).not.toBe(c.z);
    expect(at()).toEqual([400 * z.z + z.x, 300 * z.z + z.y]);
    expect(cursor().style.transform).not.toContain('scale');
  });

  it('a pan moves it frame after frame, and no React commit happens', async () => {
    const { board, commits } = open();
    await frames(2);
    commits.n = 0;
    const seen = new Set<string>();
    for (let i = 0; i < 10; i++) {
      wheel(board, { dx: 15, dy: 9 });
      await frame();
      seen.add(cursor().style.transform);
    }
    expect(seen.size).toBe(10);
    expect(commits.n).toBe(0);
  });

  it('a zoom moves it frame after frame, and commits no more than the same zoom with no cursor on the board', async () => {
    /** The commits ten frames of zoom make, and the places the cursor took. */
    const zoom = async (p: Omit<Presence, 'since'>) => {
      const { board, commits } = open(p);
      await frames(2);
      commits.n = 0;
      const seen = new Set<string>();
      for (let i = 0; i < 10; i++) {
        wheel(board, { dy: -6, ctrl: true, at: [300, 200] });
        await frame();
        seen.add(screen.queryByTestId('agent-cursor')?.style.transform ?? '');
      }
      cleanup();
      return { commits: commits.n, places: seen.size };
    };
    const without = await zoom({ state: 'drawing' });
    const withCursor = await zoom({ state: 'drawing', cursor: { at: [400, 300] } });
    expect(withCursor.places).toBe(10);
    expect(withCursor.commits).toBe(without.commits);
  });

  it('keeps inside the board by the size it is drawn at', () => {
    open();
    expect(cursor().querySelector('svg')?.getAttribute('width')).toBe(String(CURSOR_SIZE));
    expect(cursor().querySelector('svg')?.getAttribute('height')).toBe(String(CURSOR_SIZE));
  });

  it('says a note too long for the pill beside it, and a short one not', () => {
    const long = 'reading the three marks you made on the queue, then drawing the two ways it could go';
    const { src } = open({ state: 'drawing', note: long, cursor: { at: [400, 300] } });
    expect(cursor().querySelector('.agent-cursor__said')?.textContent).toBe(long);
    act(() => src.setPresence({ state: 'drawing', note: 'drawing', cursor: { at: [400, 300] } }));
    expect(cursor().querySelector('.agent-cursor__said')).toBeNull();
  });

  it('is faint, and not hidden, while the agent is away', () => {
    const { src } = open();
    expect(cursor().hasAttribute('data-away')).toBe(false);
    act(() => src.setPresence({ state: 'away', cursor: { at: [400, 300] } }));
    expect(cursor().hasAttribute('data-away')).toBe(true);
  });

  it('off the board it waits at the edge, and says it is off; back in view, it is on again', async () => {
    const { board } = open();
    await frames(2);
    expect(cursor().hasAttribute('data-off')).toBe(false);
    wheel(board, { dx: -40000 });
    await frame();
    expect(cursor().hasAttribute('data-off')).toBe(true);
    expect(at()[0]).toBe(window.innerWidth - CURSOR_SIZE);
    wheel(board, { dx: 40000 });
    await frame();
    expect(cursor().hasAttribute('data-off')).toBe(false);
  });

  it('travels to a new place over the frames of the board’s loop, and lands on it', async () => {
    reduceMotion(false);
    const { src, container, commits } = open();
    await frames(2);
    const c = camera(container);
    const from = at();
    act(() => src.setPresence({ state: 'drawing', cursor: { at: [700, 500] } }));
    commits.n = 0;
    const to = [700 * c.z + c.x, 500 * c.z + c.y];
    await frame();
    const early = at();
    expect(early).not.toEqual(from);
    expect(early).not.toEqual(to);
    expect(early[0]).toBeGreaterThan(from[0]!);
    expect(early[0]).toBeLessThan(to[0]!);
    await frames(Math.ceil(CURSOR_GLIDE_MS / 16) + 2);
    expect(at()).toEqual(to);
    expect(commits.n).toBe(0);
  });

  it('sets off fast and slows as it arrives: more than an even share of the way in its first frame', async () => {
    reduceMotion(false);
    const { src, container } = open();
    await frames(2);
    const c = camera(container);
    const from = at()[0]!;
    act(() => src.setPresence({ state: 'drawing', cursor: { at: [700, 300] } }));
    await frame();
    const to = 700 * c.z + c.x;
    const share = (at()[0]! - from) / (to - from);
    // One frame is 16 ms of the trip: an even pace would have gone 16 / CURSOR_GLIDE_MS of the way.
    expect(share).toBeGreaterThan((3 * 16) / CURSOR_GLIDE_MS);
    expect(share).toBeLessThan(1);
  });

  it('takes the board’s own time to arrive: 0.6 s', async () => {
    expect(CURSOR_GLIDE_MS).toBe(600);
    // And the trip is that long: one frame, 16 ms, is the eased share of 16 in 600 of the way.
    reduceMotion(false);
    const { src, container } = open();
    await frames(2);
    const c = camera(container);
    const from = at()[0]!;
    act(() => src.setPresence({ state: 'drawing', cursor: { at: [700, 300] } }));
    await frame();
    const to = 700 * c.z + c.x;
    expect((at()[0]! - from) / (to - from)).toBeCloseTo(1 - (1 - 16 / 600) ** 4, 9);
  });

  it('is kept inside the board when the window changes size', async () => {
    const { board } = open();
    await frames(2);
    wheel(board, { dx: -40000 });
    await frame();
    expect(at()[0]).toBe(window.innerWidth - CURSOR_SIZE);
    const was = { width: window.innerWidth, height: window.innerHeight };
    try {
      act(() => {
        (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width: was.width - 200, height: was.height });
        window.dispatchEvent(new Event('resize'));
      });
      expect(at()[0]).toBe(was.width - 200 - CURSOR_SIZE);
    } finally {
      (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport(was);
    }
  });

  it('with reduced motion it jumps to a new place', () => {
    const { src, container } = open();
    const c = camera(container);
    act(() => src.setPresence({ state: 'drawing', cursor: { at: [700, 500] } }));
    expect(at()).toEqual([700 * c.z + c.x, 500 * c.z + c.y]);
  });

  it('a new place before the last is reached: the next trip starts from where it is', async () => {
    reduceMotion(false);
    const { src, container } = open();
    await frames(2);
    const c = camera(container);
    act(() => src.setPresence({ state: 'drawing', cursor: { at: [700, 500] } }));
    await frames(5);
    const midway = at();
    act(() => src.setPresence({ state: 'drawing', cursor: { at: [100, 100] } }));
    expect(at()).toEqual(midway);
    await frame();
    // On its way back, from where it was: not from either end.
    expect(at()[0]).toBeLessThan(midway[0]!);
    expect(at()[0]).toBeGreaterThan(100 * c.z + c.x);
    await frames(Math.ceil(CURSOR_GLIDE_MS / 16) + 2);
    expect(at()).toEqual([100 * c.z + c.x, 100 * c.z + c.y]);
  });

  it('goes when presence names no place, and comes back with one', () => {
    const { src } = open();
    act(() => src.setPresence({ state: 'listening' }));
    expect(screen.queryByTestId('agent-cursor')).toBeNull();
    act(() => src.setPresence({ state: 'listening', cursor: { at: [10, 10] } }));
    expect(cursor().dataset.at).toBe('10,10');
  });
});
