import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { localSource } from '../src/source';
import { panTool } from '../src/tools/pan';
import { fakeBoard, moveTo, pressAt } from './fakeBoard';
import { note, openBoard } from './helpers';
import { Keyboard, Pointer, frame, resetInput, wheel } from './pointer';
import { reduceMotion } from './reducedMotion';

/**
 * The wheel, Safari's pinch and a pan, on the whole board: what reaches the camera, and what
 * is left to the page.
 */

afterEach(() => {
  cleanup();
  resetInput();
});

function open() {
  const b = openBoard();
  b.must('owner', note('m1', [0, 0, 320, 100]));
  const src = localSource({ events: b.events });
  const { container } = render(<App source={src} />);
  return { src, container, board: screen.getByTestId('board') };
}

/** The camera, read back from the world's transform: screen = world * z + (x, y). */
function camera(container: HTMLElement) {
  const t = container.querySelector<HTMLElement>('.world')!.style.transform;
  const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(t)!;
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}

/** The world point under a board point, by the camera on the page. */
function worldAt(container: HTMLElement, sx: number, sy: number): [number, number] {
  const c = camera(container);
  return [(sx - c.x) / c.z, (sy - c.y) / c.z];
}

/** One of Safari's gesture events, built as Safari builds it: a scale since the start, and no centre. */
function gesture(el: Element, type: 'gesturestart' | 'gesturechange' | 'gestureend', scale: number): boolean {
  const e = new UIEvent(type, { bubbles: true, cancelable: true, composed: true });
  Object.defineProperty(e, 'scale', { value: scale });
  let open = true;
  act(() => {
    open = el.dispatchEvent(e);
  });
  return open;
}

describe('the wheel zooms by at most 10.5% an event', () => {
  it('a delta of 100 with Ctrl, a mouse notch, zooms by no more than exp(0.1) either way', () => {
    const { container, board } = open();
    const z0 = camera(container).z;
    wheel(board, { dy: 100, ctrl: true, at: [300, 200] });
    const z1 = camera(container).z;
    expect(z1).toBeLessThan(z0);
    expect(z0 / z1).toBeLessThanOrEqual(Math.exp(0.1) + 1e-6);
    wheel(board, { dy: -100, ctrl: true, at: [300, 200] });
    wheel(board, { dy: -100, ctrl: true, at: [300, 200] });
    const z2 = camera(container).z;
    expect(z2 / z1).toBeLessThanOrEqual(Math.exp(0.2) + 1e-6);
    expect(z2 / z1).toBeGreaterThanOrEqual(Math.exp(0.2) - 1e-5);
  });

  it('a delta of 5 zooms by exp(-0.05), and a delta of 10 and of 11 both by exp(-0.1)', () => {
    const { container, board } = open();
    const z0 = camera(container).z;
    wheel(board, { dy: 5, ctrl: true, at: [300, 200] });
    const z1 = camera(container).z;
    expect(z1).toBeCloseTo(z0 * Math.exp(-0.05), 6);
    wheel(board, { dy: 10, ctrl: true, at: [300, 200] });
    const z2 = camera(container).z;
    expect(z2).toBeCloseTo(z1 * Math.exp(-0.1), 6);
    wheel(board, { dy: 11, ctrl: true, at: [300, 200] });
    expect(camera(container).z).toBeCloseTo(z2 * Math.exp(-0.1), 6);
  });

  it('Cmd zooms as Ctrl does, and the world point under the pointer stays within half a pixel', () => {
    const { container, board } = open();
    const at = [413, 287] as const;
    const w = worldAt(container, ...at);
    for (const dy of [-7, -10, -3, 9, -10, -10]) wheel(board, { dy, meta: true, at });
    const c = camera(container);
    expect(c.z).not.toBe(1);
    expect(Math.abs(w[0] * c.z + c.x - at[0])).toBeLessThan(0.5);
    expect(Math.abs(w[1] * c.z + c.y - at[1])).toBeLessThan(0.5);
  });
});

describe('the wheel over the panels', () => {
  it('a Ctrl wheel over a panel does not zoom the board, and is not left to the browser', () => {
    const { container } = open();
    const before = camera(container);
    const toolbar = screen.getByRole('toolbar', { name: 'Tools' });
    expect(wheel(toolbar, { dy: -10, ctrl: true })).toBe(false);
    expect(wheel(toolbar, { dy: -10, meta: true })).toBe(false);
    expect(camera(container)).toEqual(before);
  });

  it('a plain wheel over a panel is the page’s: it scrolls the panel, and the board stays', () => {
    const { container } = open();
    const before = camera(container);
    expect(wheel(screen.getByRole('toolbar', { name: 'Tools' }), { dy: 40 })).toBe(true);
    expect(camera(container)).toEqual(before);
  });
});

describe('Safari’s trackpad pinch', () => {
  it('zooms the board by the scale since the start, about where the pointer last was, and keeps the page from zooming', () => {
    const { container, board } = open();
    const at = [380, 260] as const;
    new Pointer().move(at);
    const w = worldAt(container, ...at);
    const z0 = camera(container).z;
    expect(gesture(board, 'gesturestart', 1)).toBe(false);
    expect(gesture(board, 'gesturechange', 1.5)).toBe(false);
    expect(camera(container).z).toBeCloseTo(z0 * 1.5, 6);
    // The scale is from the start of the gesture: it does not add up from one change to the next.
    gesture(board, 'gesturechange', 1.8);
    expect(camera(container).z).toBeCloseTo(z0 * 1.8, 6);
    expect(gesture(board, 'gestureend', 1.8)).toBe(false);
    const c = camera(container);
    expect(Math.abs(w[0] * c.z + c.x - at[0])).toBeLessThan(0.5);
    expect(Math.abs(w[1] * c.z + c.y - at[1])).toBeLessThan(0.5);
  });

  it('over a panel it zooms nothing: the board stays as it is, and the page is still kept from zooming', () => {
    const { container, board } = open();
    const before = camera(container);
    const toolbar = screen.getByRole('toolbar', { name: 'Tools' });
    expect(gesture(toolbar, 'gesturestart', 1)).toBe(false);
    expect(gesture(toolbar, 'gesturechange', 1.5)).toBe(false);
    expect(gesture(toolbar, 'gesturechange', 2.2)).toBe(false);
    expect(gesture(toolbar, 'gestureend', 2.2)).toBe(false);
    expect(camera(container)).toEqual(before);
    // The next pinch, over the board, is the board's again.
    gesture(board, 'gesturestart', 1);
    gesture(board, 'gesturechange', 1.5);
    gesture(board, 'gestureend', 1.5);
    expect(camera(container).z).toBeCloseTo(before.z * 1.5, 6);
  });

  it('with the pointer never over the board, it zooms about the middle of the board', () => {
    const { container, board } = open();
    // A test page has no layout: the board is taken to fill the window.
    const mid = [window.innerWidth / 2, window.innerHeight / 2] as const;
    const w = worldAt(container, ...mid);
    const z0 = camera(container).z;
    gesture(board, 'gesturestart', 1);
    gesture(board, 'gesturechange', 1.7);
    gesture(board, 'gestureend', 1.7);
    const c = camera(container);
    expect(c.z).toBeCloseTo(z0 * 1.7, 6);
    expect(Math.abs(w[0] * c.z + c.x - mid[0])).toBeLessThan(0.5);
    expect(Math.abs(w[1] * c.z + c.y - mid[1])).toBeLessThan(0.5);
  });

  it('in the middle of a pan it lands the pan’s waiting move first, so the grabbed point stays under the pointer', () => {
    const { container, board } = open();
    Keyboard.press('h');
    const p = new Pointer();
    p.down([400, 300]);
    const grabbed = worldAt(container, 400, 300);
    p.move([420, 310]);
    p.move([460, 330]);
    gesture(board, 'gesturestart', 1);
    gesture(board, 'gesturechange', 1.5);
    gesture(board, 'gestureend', 1.5);
    p.move([480, 340]);
    p.up();
    const c = camera(container);
    expect(c.z).toBeCloseTo(1.5, 6);
    expect(Math.abs(grabbed[0] * c.z + c.x - 480)).toBeLessThan(0.5);
    expect(Math.abs(grabbed[1] * c.z + c.y - 340)).toBeLessThan(0.5);
  });
});

describe('a pan and the wheel at once', () => {
  it('a wheel pan in the middle of a pan drag: the board ends where the two add up to', () => {
    const { container } = open();
    Keyboard.press('h');
    const c0 = camera(container);
    const p = new Pointer();
    p.down([400, 300]);
    p.move([430, 300]);
    p.move([450, 300]);
    wheel(screen.getByTestId('board'), { dy: 30, at: [450, 300] });
    p.move([500, 320]);
    p.up();
    const c1 = camera(container);
    expect(c1.x).toBeCloseTo(c0.x + 100, 6);
    expect(c1.y).toBeCloseTo(c0.y + 20 - 30, 6);
    expect(c1.z).toBe(c0.z);
  });
});

describe('the wheel in lines and pages, and with nothing in it', () => {
  it('pans by 16 px a line and by the board’s height a page', () => {
    const { container, board } = open();
    const c0 = camera(container);
    wheel(board, { dy: 3, mode: 'line' });
    expect(camera(container)).toEqual({ ...c0, y: c0.y - 48 });
    wheel(board, { dy: -1, mode: 'page' });
    // A test page has no layout: the board is taken to fill the window.
    expect(camera(container)).toEqual({ ...c0, y: c0.y - 48 + window.innerHeight });
  });

  it('Shift turns a vertical wheel into a sideways pan', () => {
    const { container, board } = open();
    const c0 = camera(container);
    wheel(board, { dy: 40, shift: true });
    expect(camera(container)).toEqual({ ...c0, x: c0.x - 40 });
  });

  it('an event with zero deltas does nothing: not even a glide stops', async () => {
    const { container, board } = open();
    wheel(board, { dx: 900, dy: 500 });
    reduceMotion(false);
    Keyboard.press('1');
    await frame();
    await frame();
    const mid = camera(container);
    expect(wheel(board, { dx: 0, dy: 0, ctrl: true })).toBe(false);
    expect(camera(container)).toEqual(mid);
    await frame();
    expect(camera(container)).not.toEqual(mid);
  });
});

describe('a zoom in the middle of a pan', () => {
  it('lands the pan’s waiting move first, so the grabbed point stays under the pointer', () => {
    const { container } = open();
    Keyboard.press('h');
    const p = new Pointer();
    p.down([400, 300]);
    const grabbed = worldAt(container, 400, 300);
    p.move([420, 310]);
    p.move([460, 330]);
    wheel(screen.getByTestId('board'), { dy: -10, ctrl: true, at: [460, 330] });
    p.move([480, 340]);
    p.up();
    const c = camera(container);
    expect(c.z).not.toBe(1);
    expect(Math.abs(grabbed[0] * c.z + c.x - 480)).toBeLessThan(0.5);
    expect(Math.abs(grabbed[1] * c.z + c.y - 340)).toBeLessThan(0.5);
  });
});

describe('the hand on the camera', () => {
  it('is open while a pan is pressed, closed once it moves, and gone when it ends or is cut short', async () => {
    open();
    const board = screen.getByTestId('board');
    Keyboard.press('h');
    expect(board.dataset.grip).toBeUndefined();
    const p = new Pointer();
    p.down([400, 300]);
    expect(board.dataset.grip).toBe('armed');
    p.move([403, 300]);
    await frame();
    expect(board.dataset.grip).toBe('armed');
    p.move([410, 300]);
    await frame();
    expect(board.dataset.grip).toBe('moving');
    p.up();
    expect(board.dataset.grip).toBeUndefined();
    p.down([400, 300]);
    p.move([440, 300]);
    await frame();
    expect(board.dataset.grip).toBe('moving');
    p.cancel();
    expect(board.dataset.grip).toBeUndefined();
  });

  it('a middle-button pan with the Pen in hand grips too', async () => {
    open();
    const board = screen.getByTestId('board');
    Keyboard.press('p');
    const p = new Pointer();
    p.down([400, 300], 'middle');
    expect(board.dataset.grip).toBe('armed');
    p.move([450, 300]);
    await frame();
    expect(board.dataset.grip).toBe('moving');
    p.up();
    expect(board.dataset.grip).toBeUndefined();
  });
});

describe('the Pan tool alone', () => {
  it('applies each move from the last applied point, so a camera move between two moves stays', () => {
    const { board, camera, did } = fakeBoard({ tool: 'pan' });
    const pan = panTool();
    const press = pressAt(10, 10);
    pan.down(press, board);
    pan.move(moveTo(press, 30, 10), board);
    expect(camera.get()).toEqual({ x: 20, y: 0, z: 1 });
    // A wheel moves the camera between two moves of the drag.
    camera.set({ x: 20, y: -50, z: 1 });
    pan.move(moveTo(press, 45, 25), board);
    expect(camera.get()).toEqual({ x: 35, y: -35, z: 1 });
    pan.up(press, board);
    expect(did.sent).toHaveLength(0);
    expect(camera.grip()).toBe('none');
  });

  it('a cancelled pan leaves the camera where it got to, lets go, and posts nothing', () => {
    const { board, camera, did } = fakeBoard({ tool: 'pan' });
    const pan = panTool();
    const press = pressAt(10, 10);
    pan.down(press, board);
    pan.move(moveTo(press, 60, 40), board);
    expect(camera.grip()).toBe('moving');
    pan.cancel(press, board, 'blur');
    expect(camera.get()).toEqual({ x: 50, y: 30, z: 1 });
    expect(camera.grip()).toBe('none');
    expect(did.sent).toHaveLength(0);
    expect(did.dragEnds).toBe(0);
  });
});

describe('the camera written to the page', () => {
  it('a pan moves the ground by its transform and writes neither its cell size nor the zoom variable', () => {
    const { container, board } = open();
    const world = container.querySelector<HTMLElement>('.world')!;
    const ground = container.querySelector<HTMLElement>('.ground')!;
    const zSet: string[] = [];
    const setProperty = world.style.setProperty.bind(world.style);
    world.style.setProperty = (name: string, value: string | null, priority?: string) => {
      if (name === '--z') zSet.push(name);
      setProperty(name, value, priority);
    };
    const size = ground.style.backgroundSize;
    const slid = ground.style.transform;
    wheel(board, { dx: 7, dy: 3 });
    expect(zSet).toEqual([]);
    expect(ground.style.backgroundSize).toBe(size);
    expect(ground.style.backgroundPosition).toBe('');
    expect(ground.style.transform).not.toBe(slid);
    expect(ground.style.transform).toMatch(/^translate\([\d.e-]+px, [\d.e-]+px\)$/);
    wheel(board, { dy: -5, ctrl: true });
    expect(zSet).toEqual(['--z']);
    expect(world.style.getPropertyValue('--z')).toBe(String(camera(container).z));
    expect(ground.style.backgroundSize).not.toBe(size);
  });
});
