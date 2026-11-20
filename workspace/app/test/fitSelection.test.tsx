import type { Box } from '@keel/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { localSource } from '../src/source';
import { note, openBoard } from './helpers';
import { Keyboard, Pointer, resetInput, wheel } from './pointer';

/**
 * Key 2, "fit what is selected", on the whole board. A test page has no layout: the board is
 * the window, and a panel is only where a test puts it.
 */

afterEach(() => {
  cleanup();
  resetInput();
  vi.restoreAllMocks();
});

function open() {
  const b = openBoard();
  b.must('owner', note('m1', [0, 0, 320, 100]));
  b.must('owner', note('m2', [900, 700, 320, 100]));
  b.must('owner', note('big', [2000, 2000, 3000, 1500]));
  const { container } = render(<App source={localSource({ events: b.events })} />);
  return { container, board: screen.getByTestId('board') };
}

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

const select = (container: HTMLElement, id: string) => new Pointer().on(container.querySelector<HTMLElement>(`[data-item="${id}"]`)!).click([10, 10]);

/** The board's name along the top, 120 px tall, and the toolbar along the bottom, 80 px tall. */
const PANELS = { top: 120, bottom: 80 };

function layOutPanels() {
  const real = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('pill--board')) return new DOMRect(0, 0, window.innerWidth, PANELS.top);
    if (this.classList.contains('toolbar')) return new DOMRect(0, window.innerHeight - PANELS.bottom, window.innerWidth, PANELS.bottom);
    return real.call(this);
  });
}

describe('2 fits what is selected', () => {
  it('with nothing selected it fits the whole board, as 1 does', () => {
    const { container, board } = open();
    wheel(board, { dx: 600, dy: 300 });
    Keyboard.press('1');
    const whole = camera(container);
    wheel(board, { dx: 600, dy: 300 });
    expect(camera(container)).not.toEqual(whole);
    Keyboard.press('2');
    expect(camera(container)).toEqual(whole);
  });

  it('never zooms past 100%: a small note is shown at 100%, in the middle of the board', () => {
    const { container } = open();
    select(container, 'm1');
    Keyboard.press('2');
    const c = camera(container);
    // At 100% the note would fit three times over.
    expect(c.z).toBe(1);
    const r = onPage(container, [0, 0, 320, 100]);
    expect((r.left + r.right) / 2).toBeCloseTo(window.innerWidth / 2, 6);
    expect((r.top + r.bottom) / 2).toBeCloseTo(window.innerHeight / 2, 6);
  });

  it('fits a large selected note in the room the panels leave, clear of them by the margin', () => {
    layOutPanels();
    const { container } = open();
    select(container, 'big');
    Keyboard.press('2');
    expect(camera(container).z).toBeLessThan(1);
    const r = onPage(container, [2000, 2000, 3000, 1500]);
    const room = { left: 24, top: PANELS.top + 24, right: window.innerWidth - 24, bottom: window.innerHeight - PANELS.bottom - 24 };
    expect(r.left).toBeGreaterThanOrEqual(room.left - 1e-6);
    expect(r.right).toBeLessThanOrEqual(room.right + 1e-6);
    expect(r.top).toBeGreaterThanOrEqual(room.top - 1e-6);
    expect(r.bottom).toBeLessThanOrEqual(room.bottom + 1e-6);
    // It is in the middle of that room, not of the board.
    expect((r.top + r.bottom) / 2).toBeCloseTo((room.top + room.bottom) / 2, 6);
    expect((r.left + r.right) / 2).toBeCloseTo((room.left + room.right) / 2, 6);
  });
});

describe('a fit measures the room the panels leave as it is made', () => {
  it('a panel that came with no render of the board, the hint line when the agent starts to wait, is kept clear of by the next fit', () => {
    const HINT_TOP = window.innerHeight - 240;
    const real = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('toolbar')) return new DOMRect(0, window.innerHeight - PANELS.bottom, window.innerWidth, PANELS.bottom);
      if (this.dataset.testid === 'hint') return new DOMRect(0, HINT_TOP, window.innerWidth, 40);
      return real.call(this);
    });
    // Tall enough that a fit fills the height of the room, and not so tall that the smallest zoom cuts it off.
    const TALL: Box = [0, 0, 320, 2000];
    const b = openBoard();
    b.must('owner', note('tall', TALL));
    const src = localSource({ events: b.events });
    const { container } = render(<App source={src} />);
    const fitAll = () => fireEvent.click(screen.getByRole('button', { name: 'Fit the board' }));
    fitAll();
    // No hint yet: the note comes down to the toolbar, past where the hint will be.
    expect(screen.queryByTestId('hint')).toBeNull();
    expect(onPage(container, TALL).bottom).toBeGreaterThan(HINT_TOP);
    // The agent starts to wait. The hint line hears it for itself: the board is not drawn again.
    act(() => src.setPresence({ state: 'waiting' }));
    expect(screen.getByTestId('hint').dataset.viewportUi).toBe('bottom');
    fitAll();
    expect(onPage(container, TALL).bottom).toBeLessThanOrEqual(HINT_TOP);
  });
});
