import type { BoardEvent } from '@keel/protocol';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { localSource } from '../src/source';
import { note, openBoard } from './helpers';
import { Keyboard, Pointer, frame, frames, resetInput, wheel } from './pointer';

/**
 * The input helpers themselves, against today's app: what each event carries, and that a wheel,
 * a tool key and a drag reach the board the way a browser's would.
 */

afterEach(() => {
  cleanup();
  resetInput();
  vi.useRealTimers();
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

/** Every event of these types that reaches `el`, as it arrived. */
function record<E extends Event>(el: EventTarget, ...types: string[]): E[] {
  const seen: E[] = [];
  for (const type of types) el.addEventListener(type, (e) => seen.push(e as E));
  return seen;
}

const tool = () => document.querySelector('.app')!.getAttribute('data-tool');

describe('Pointer', () => {
  it('sends a drag as a browser does: buttons and pressure while down, the type, the id, and the place', () => {
    const { board } = open();
    const seen = record<PointerEvent>(board, 'pointerdown', 'pointermove', 'pointerup');
    new Pointer('mouse', 7).drag([100, 100], [130, 140], { steps: 2 });
    expect(seen.map((e) => [e.type, e.clientX, e.clientY, e.button, e.buttons, e.pressure])).toEqual([
      ['pointermove', 100, 100, -1, 0, 0],
      ['pointerdown', 100, 100, 0, 1, 0.5],
      ['pointermove', 115, 120, -1, 1, 0.5],
      ['pointermove', 130, 140, -1, 1, 0.5],
      ['pointerup', 130, 140, 0, 0, 0],
    ]);
    expect(seen.every((e) => e.pointerId === 7 && e.pointerType === 'mouse' && e.isPrimary)).toBe(true);
  });

  it('a right press asks for the context menu and sends no click; a second finger is not primary', () => {
    const { board } = open();
    const seen = record<MouseEvent>(board, 'pointerdown', 'contextmenu', 'click');
    new Pointer().click([10, 10], 'right');
    expect(seen.map((e) => [e.type, e.button, e.buttons])).toEqual([
      ['pointerdown', 2, 2],
      ['contextmenu', 2, 2],
    ]);
    const fingers = record<PointerEvent>(board, 'pointerdown');
    new Pointer('touch', 2).down([10, 10]);
    new Pointer('touch', 3).down([50, 10]);
    expect(fingers.map((e) => [e.pointerId, e.isPrimary])).toEqual([
      [2, true],
      [3, false],
    ]);
  });

  it('modifiers held by withModifierKeys, or by a modifier key that is down, go on every pointer and wheel event', async () => {
    const { board } = open();
    const seen = record<MouseEvent>(board, 'pointerdown', 'wheel');
    const mouse = new Pointer();
    Keyboard.withModifierKeys({ shift: true, alt: true }, () => mouse.click([1, 1]));
    await Keyboard.withModifierKeys({ meta: true }, async () => {
      wheel(board, { dy: 1 });
    });
    Keyboard.keyDown('Control');
    mouse.click([1, 1]);
    Keyboard.keyUp('Control');
    mouse.click([1, 1]);
    expect(seen.map((e) => [e.type, e.shiftKey, e.altKey, e.metaKey, e.ctrlKey, e.getModifierState('Shift')])).toEqual([
      ['pointerdown', true, true, false, false, true],
      ['wheel', false, false, true, false, false],
      ['pointerdown', false, false, false, true, false],
      ['pointerdown', false, false, false, false, false],
    ]);
  });
});

describe('Keyboard', () => {
  it('names the typed character and the place apart, and reports Caps Lock', () => {
    open();
    const seen = record<KeyboardEvent>(window, 'keydown');
    Keyboard.press('я', 'KeyZ', { meta: true });
    Keyboard.press('CapsLock');
    Keyboard.press('B');
    expect(seen.map((e) => [e.key, e.code, e.metaKey, e.getModifierState('CapsLock')])).toEqual([
      ['я', 'KeyZ', true, false],
      ['CapsLock', 'CapsLock', false, true],
      ['B', 'KeyB', false, true],
    ]);
  });

  it('a tool key picks its tool', () => {
    open();
    Keyboard.press('b');
    expect(tool()).toBe('box');
    Keyboard.press('Escape');
    expect(tool()).toBe('select');
    Keyboard.press('p', 'KeyP');
    expect(tool()).toBe('pen');
  });
});

describe('wheel', () => {
  it('a plain wheel pans the camera by its delta, and the board keeps the page from scrolling', () => {
    const { container, board } = open();
    const before = camera(container);
    expect(wheel(board, { dx: 30, dy: 50 })).toBe(false);
    expect(camera(container)).toEqual({ x: before.x - 30, y: before.y - 50, z: before.z });
  });

  it('a wheel with Ctrl, a trackpad pinch, zooms in for a negative delta', () => {
    const { container, board } = open();
    const before = camera(container);
    wheel(board, { dy: -10, ctrl: true, at: [200, 200] });
    expect(camera(container).z).toBeGreaterThan(before.z);
  });
});

describe('a whole gesture', () => {
  it('the Box tool: a drag round the note, then Enter, posts a box where it was drawn', () => {
    const { src, container } = open();
    const n = src.events.length;
    Keyboard.press('b');
    const c = camera(container);
    const at = (wx: number, wy: number) => [wx * c.z + c.x, wy * c.z + c.y] as const;
    new Pointer().drag(at(-20, -20), at(340, 120));
    const words = screen.getByRole('textbox', { name: 'A few words' });
    expect(document.activeElement).toBe(words);
    Keyboard.press('Enter');
    return vi.waitFor(() => {
      const adds = src.events.slice(n).filter((e: BoardEvent) => e.type === 'item.add');
      expect(adds).toHaveLength(1);
      const item = (adds[0] as Extract<BoardEvent, { type: 'item.add' }>).item;
      expect(item).toMatchObject({ kind: 'box' });
      expect(item.box?.map(Math.round)).toEqual([-20, -20, 360, 140]);
    });
  });
});

describe('frames', () => {
  it('lets animation frames pass with real timers', async () => {
    let n = 0;
    const tick = () => {
      n++;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    await frames(3);
    expect(n).toBeGreaterThanOrEqual(3);
  });

  it('and with fake timers', async () => {
    vi.useFakeTimers();
    let n = 0;
    requestAnimationFrame(() => n++);
    await frame();
    expect(n).toBe(1);
  });
});
