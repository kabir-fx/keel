import { act, cleanup, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { CameraStore } from '../src/camera/camera';
import { useWorldTransform } from '../src/camera/world';
import { localSource } from '../src/source';
import { note, openBoard } from './helpers';
import { Keyboard, Pointer, frame, frames, resetInput, wheel } from './pointer';
import { reduceMotion } from './reducedMotion';

/**
 * The camera's glide on the whole board: what glides, what lands, and what stops it.
 *
 * Time is the test's own: a frame is 16 ms, so a glide of 500 ms lands on its 32nd frame.
 */

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

function open() {
  const b = openBoard();
  b.must('owner', note('m1', [0, 0, 320, 100]));
  b.must('owner', note('m2', [900, 700, 320, 100]));
  const src = localSource({ events: b.events });
  const { container } = render(<App source={src} />);
  return { src, container, board: screen.getByTestId('board') };
}

function camera(container: HTMLElement) {
  const t = container.querySelector<HTMLElement>('.world')!.style.transform;
  const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(t)!;
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}

describe('the camera shows where it goes', () => {
  it('a fit glides there over frames, and lands exactly where the jump would have', async () => {
    const { container, board } = open();
    // With reduced motion the fit is a jump: that is where the glide must land.
    wheel(board, { dx: 600, dy: 300 });
    Keyboard.press('1');
    const target = camera(container);
    wheel(board, { dx: 600, dy: 300 });
    const away = camera(container);
    expect(away).not.toEqual(target);

    reduceMotion(false);
    Keyboard.press('1');
    expect(camera(container)).toEqual(away);
    await frame();
    await frame();
    const between = camera(container);
    expect(between).not.toEqual(away);
    expect(between).not.toEqual(target);
    // 500 ms: the 31st frame is not there yet, the 32nd is.
    await frames(29);
    expect(camera(container)).not.toEqual(target);
    await frame();
    expect(camera(container)).toEqual(target);
    await landed();
    expect(camera(container)).toEqual(target);
  });
});

/** Pan away by the wheel, and answer where a fit from there lands, by a fit with reduced motion. */
function awayFromFit(container: HTMLElement, board: HTMLElement) {
  wheel(board, { dx: 600, dy: 300 });
  Keyboard.press('1');
  const target = camera(container);
  wheel(board, { dx: 600, dy: 300 });
  return { target, away: camera(container) };
}

describe('what stops a glide', () => {
  it('a wheel event during it stops it where it is, and it moves no more', async () => {
    const { container, board } = open();
    const { target, away } = awayFromFit(container, board);
    reduceMotion(false);
    Keyboard.press('1');
    await frames(3);
    const mid = camera(container);
    expect(mid).not.toEqual(away);
    wheel(board, { dy: 10 });
    const stopped = camera(container);
    expect(stopped).toEqual({ ...mid, y: mid.y - 10 });
    await landed();
    expect(camera(container)).toEqual(stopped);
    expect(stopped).not.toEqual(target);
  });

  it('a press on the board stops it where it is', async () => {
    const { container, board } = open();
    awayFromFit(container, board);
    reduceMotion(false);
    Keyboard.press('1');
    await frames(3);
    new Pointer().down([500, 400]);
    const stopped = camera(container);
    await landed();
    expect(camera(container)).toEqual(stopped);
  });

  it('the board leaving the page stops it: the camera moves no more, and no frame is asked for', async () => {
    const camera = new CameraStore({ x: 0, y: 0, z: 1 }, { reduced: () => false });
    function World() {
      const board = useRef<HTMLDivElement>(null);
      const ground = useRef<HTMLDivElement>(null);
      const world = useRef<HTMLDivElement>(null);
      useWorldTransform(camera, world, ground, board);
      return (
        <div ref={board}>
          <div ref={ground} />
          <div ref={world} data-testid="world" />
        </div>
      );
    }
    const { unmount } = render(<World />);
    camera.glide({ x: 900, y: -300, z: 2 });
    await frames(3);
    expect(camera.gliding()).toBe(true);
    expect(screen.getByTestId('world').style.transform).toBe(`translate(${camera.get().x}px, ${camera.get().y}px) scale(${camera.get().z})`);
    unmount();
    expect(camera.gliding()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const left = camera.get();
    await landed();
    expect(camera.get()).toBe(left);
  });
});

describe('with reduced motion', () => {
  it('a fit lands at once: no glide asks for frames', () => {
    const { container, board } = open();
    const { target } = awayFromFit(container, board);
    const asked: number[] = [];
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb) => {
      asked.push(1);
      return raf(cb);
    };
    try {
      act(() => {
        Keyboard.press('1');
      });
    } finally {
      window.requestAnimationFrame = raf;
    }
    expect(camera(container)).toEqual(target);
    // One frame, for what renders once a frame (the zoom label); none for a glide.
    expect(asked.length).toBeLessThanOrEqual(1);
  });
});

describe('the zoom buttons glide', () => {
  it('a press zooms in one step about the middle, over frames, and two presses add up', async () => {
    const { container } = open();
    const z0 = camera(container).z;
    reduceMotion(false);
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' });
    zoomIn.click();
    zoomIn.click();
    expect(camera(container).z).toBe(z0);
    await landed();
    expect(camera(container).z).toBeCloseTo(z0 * 1.25 * 1.25, 6);
  });
});

describe('a fit and the panels', () => {
  /** Make an element say it sits at this rectangle on the page: a test page has no layout. */
  function placeAt(el: Element, x: number, y: number, w: number, h: number) {
    Object.defineProperty(el, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(x, y, w, h) });
  }

  it('keeps the content clear of every panel, measured from the panels themselves: a pill that wrapped, a taller toolbar', () => {
    const { container, board } = open();
    const panels: Array<[number, number, number, number]> = [
      [24, 20, 400, 200],
      [200, 600, 640, 150],
    ];
    placeAt(screen.getByRole('banner', { name: 'Board' }), ...panels[0]!);
    placeAt(screen.getByRole('toolbar', { name: 'Tools' }), ...panels[1]!);
    wheel(board, { dx: 300 });
    Keyboard.press('1');
    const c = camera(container);
    const notes: Array<[number, number, number, number]> = [
      [0, 0, 320, 100],
      [900, 700, 320, 100],
    ];
    for (const [x, y, w, h] of notes) {
      const [sx, sy, sw, sh] = [x * c.z + c.x, y * c.z + c.y, w * c.z, h * c.z];
      for (const [px, py, pw, ph] of panels) {
        const meets = sx < px + pw && px < sx + sw && sy < py + ph && py < sy + sh;
        expect(meets).toBe(false);
      }
      expect(sx).toBeGreaterThanOrEqual(24);
      expect(sy).toBeGreaterThanOrEqual(220 + 24);
      expect(sy + sh).toBeLessThanOrEqual(600 - 24 + 1e-9);
    }
  });

  it('the room is the board’s, not the window’s: on a board smaller than its window a fit stays inside the board', async () => {
    // The board sits at (100, 50) and is 800 by 500, in a window of 1024 by 768.
    const real = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'board' ? new DOMRect(100, 50, 800, 500) : real.call(this);
    });
    const { container, board } = open();
    wheel(board, { dx: 300 });
    Keyboard.press('1');
    const c = camera(container);
    // The camera counts from the board's corner: both notes are inside the board, 24 px in.
    for (const [x, y, w, h] of [
      [0, 0, 320, 100],
      [900, 700, 320, 100],
    ] as const) {
      expect(x * c.z + c.x).toBeGreaterThanOrEqual(24 - 1e-9);
      expect(y * c.z + c.y).toBeGreaterThanOrEqual(24 - 1e-9);
      expect((x + w) * c.z + c.x).toBeLessThanOrEqual(800 - 24 + 1e-9);
      expect((y + h) * c.z + c.y).toBeLessThanOrEqual(500 - 24 + 1e-9);
    }
    // A zoom button zooms about the middle of the board, not of the window.
    const w = [(400 - c.x) / c.z, (250 - c.y) / c.z] as const;
    act(() => screen.getByRole('button', { name: 'Zoom in' }).click());
    const zoomed = camera(container);
    expect(zoomed.z).toBeCloseTo(c.z * 1.25, 6);
    expect(Math.abs(w[0] * zoomed.z + zoomed.x - 400)).toBeLessThan(0.5);
    expect(Math.abs(w[1] * zoomed.z + zoomed.y - 250)).toBeLessThan(0.5);
    // A wheel in pages pans by the board's height.
    wheel(board, { dy: 1, mode: 'page' });
    expect(camera(container).y).toBeCloseTo(zoomed.y - 500, 6);
  });
});
