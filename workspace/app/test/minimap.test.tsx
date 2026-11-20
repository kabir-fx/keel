import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { localSource } from '../src/source';
import { note, openBoard } from './helpers';
import { Keyboard, Pointer, frame, frames, resetInput, wheel } from './pointer';
import { reduceMotion } from './reducedMotion';

/**
 * The minimap and the zoom buttons on the whole board. A test page has no layout, so the
 * minimap's corner is the page's: a pointer at (x, y) is at (x, y) in the minimap.
 *
 * Time is the test's own: a frame is 16 ms, so a glide of 500 ms lands on its 32nd frame.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  resetInput();
  vi.useRealTimers();
});

/** Frames enough for any glide to land. */
const landed = () => frames(40);

/** A board with notes spread wide, so the content is larger than the view. */
function open() {
  const b = openBoard();
  b.must('owner', note('m1', [0, 0, 320, 100]));
  b.must('owner', note('m2', [3000, 1600, 320, 100]));
  b.must('owner', note('m3', [-2000, 2400, 320, 100]));
  const src = localSource({ events: b.events });
  const { container } = render(<App source={src} />);
  return { src, container, board: screen.getByTestId('board'), minimap: screen.getByTestId('minimap') };
}

function camera(container: HTMLElement) {
  const t = container.querySelector<HTMLElement>('.world')!.style.transform;
  const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(t)!;
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}

/** The view box in the minimap, in minimap pixels: it is placed by its transform, from the minimap's corner. */
function viewBox() {
  const s = screen.getByTestId('minimap-view').style;
  const m = /^translate\(([-\d.e]+)px, ([-\d.e]+)px\)$/.exec(s.transform);
  if (!m) throw new Error(`the view box is not placed by a transform: "${s.transform}"`);
  return { x: Number(m[1]), y: Number(m[2]), w: parseFloat(s.width), h: parseFloat(s.height) };
}

type Mini = readonly [x: number, y: number];

/** The transform the map is drawn with now: minimap = world * s + (tx, ty). */
function mapDrawn(minimap: HTMLElement) {
  const [s, , , , tx, ty] = minimap.querySelector('g')!.getAttribute('transform')!.match(/[-\d.e]+/g)!.map(Number) as [number, number, number, number, number, number];
  return { s, tx, ty };
}

/** The world point under a minimap point, by the map as it is drawn now. */
function worldUnder(minimap: HTMLElement, [mx, my]: Mini): [number, number] {
  const t = mapDrawn(minimap);
  return [(mx - t.tx) / t.s, (my - t.ty) / t.s];
}

/** The world point in the middle of what the board shows. */
function viewMiddle(container: HTMLElement): [number, number] {
  const c = camera(container);
  return [(window.innerWidth / 2 - c.x) / c.z, (window.innerHeight / 2 - c.y) / c.z];
}

/** A point of the minimap beside the view box, to its right where there is room, else to its left. */
const beside = (v: { x: number; y: number; w: number; h: number }): Mini => [v.x + v.w + 30 > 190 ? 6 : v.x + v.w + 30, 50];

const middleOf = (v: { x: number; y: number; w: number; h: number }): Mini => [v.x + v.w / 2, v.y + v.h / 2];

/** Drag in the minimap from a point inside the view box by (dx, dy) in steps, and check the grab point stays under the pointer at each. */
async function dragKeepsGrab(minimap: HTMLElement, dx: number, dy: number) {
  await frame();
  const v = viewBox();
  const grab = [v.x + Math.min(3, v.w / 4), v.y + Math.min(2, v.h / 4)] as const;
  const p = new Pointer().on(minimap);
  p.down(grab);
  for (let i = 1; i <= 5; i++) {
    p.move([grab[0] + (dx * i) / 5, grab[1] + (dy * i) / 5]);
    await frame();
    const now = viewBox();
    expect(now.x - v.x).toBeCloseTo((dx * i) / 5, 6);
    expect(now.y - v.y).toBeCloseTo((dy * i) / 5, 6);
  }
  p.up();
}

describe('a drag in the minimap', () => {
  it('keeps the grab point under the pointer, with the view inside the content', async () => {
    const { minimap } = open();
    await dragKeepsGrab(minimap, 14, 9);
  });

  it('keeps the grab point under the pointer, with the view outside the content: the map does not run away', async () => {
    const { board, minimap } = open();
    // Far off below and to the right of everything.
    for (let i = 0; i < 12; i++) wheel(board, { dx: 4000, dy: 4000 });
    await dragKeepsGrab(minimap, 30, 12);
    await dragKeepsGrab(minimap, -40, -20);
  });
});

describe('the minimap draws the items once', () => {
  it('a drag moves only the view box: the items and their layer stay as they were', async () => {
    const { minimap } = open();
    await frame();
    const rects = [...minimap.querySelectorAll('rect')];
    expect(rects).toHaveLength(3);
    const layer = minimap.querySelector('g')!;
    const t0 = layer.getAttribute('transform');
    const v = viewBox();
    const p = new Pointer().on(minimap);
    p.down([v.x + 1, v.y + 1]);
    p.move([v.x + 40, v.y + 20]);
    await frame();
    expect(viewBox().x).not.toBe(v.x);
    expect(layer.getAttribute('transform')).toBe(t0);
    expect([...minimap.querySelectorAll('rect')]).toEqual(rects);
    p.up();
  });
});

/** Write down every style property written on `el` from now on, by name. */
function watchStyle(el: HTMLElement): string[] {
  const written: string[] = [];
  const real = el.style;
  const watched = new Proxy(real, {
    get(target, prop) {
      if (prop === 'setProperty') {
        return (name: string, value: string | null, priority?: string) => {
          written.push(name);
          target.setProperty(name, value, priority);
        };
      }
      const value: unknown = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, prop, value) {
      written.push(String(prop));
      return Reflect.set(target, prop, value);
    },
  });
  Object.defineProperty(el, 'style', { configurable: true, get: () => watched });
  return written;
}

describe('the minimap costs a pan no layout', () => {
  it('a pan moves the view box by its transform alone: no left, top, width or height is written, and the items’ layer is left alone', async () => {
    const { board, minimap } = open();
    // Zoomed in, the view is inside the content: a pan then changes nothing but where the box is.
    for (let i = 0; i < 16; i++) wheel(board, { dy: -10, ctrl: true, at: [window.innerWidth / 2, window.innerHeight / 2] });
    await frame();
    const view = screen.getByTestId('minimap-view');
    const layer = minimap.querySelector('g')!;
    const styles = watchStyle(view);
    const attributes: string[] = [];
    const setAttribute = layer.setAttribute.bind(layer);
    layer.setAttribute = (name: string, value: string) => {
      attributes.push(name);
      setAttribute(name, value);
    };
    const before = viewBox();
    for (let i = 0; i < 6; i++) {
      wheel(board, { dx: 15, dy: 10 });
      await frame();
    }
    const after = viewBox();
    expect(after.x).toBeGreaterThan(before.x);
    expect(after.y).toBeGreaterThan(before.y);
    expect([after.w, after.h]).toEqual([before.w, before.h]);
    expect([...new Set(styles)]).toEqual(['transform']);
    expect(attributes).toEqual([]);
    expect([view.style.left, view.style.top]).toEqual(['', '']);
  });

  it('a zoom, which changes the box’s size, writes the size, and a pan after it does not write it again', async () => {
    const { board } = open();
    for (let i = 0; i < 16; i++) wheel(board, { dy: -10, ctrl: true, at: [window.innerWidth / 2, window.innerHeight / 2] });
    await frame();
    const styles = watchStyle(screen.getByTestId('minimap-view'));
    const before = viewBox();
    wheel(board, { dy: -10, ctrl: true, at: [window.innerWidth / 2, window.innerHeight / 2] });
    expect(viewBox().w).toBeLessThan(before.w);
    expect([...new Set(styles)].sort()).toEqual(['height', 'transform', 'width']);
    styles.length = 0;
    wheel(board, { dx: 15 });
    expect(styles).toEqual(['transform']);
  });
});

describe('the minimap and the wheel', () => {
  it('a wheel over the minimap zooms about the middle of the view, and the page does not get it', () => {
    const { container, minimap } = open();
    const c0 = camera(container);
    const mid = [window.innerWidth / 2, window.innerHeight / 2] as const;
    const w = [(mid[0] - c0.x) / c0.z, (mid[1] - c0.y) / c0.z] as const;
    expect(wheel(minimap, { dy: -10, at: [20, 20] })).toBe(false);
    const c1 = camera(container);
    expect(c1.z).toBeCloseTo(c0.z * Math.exp(0.1), 5);
    expect(Math.abs(w[0] * c1.z + c1.x - mid[0])).toBeLessThan(0.5);
    expect(Math.abs(w[1] * c1.z + c1.y - mid[1])).toBeLessThan(0.5);
  });
});

describe('a wheel over the minimap during a drag', () => {
  it('does nothing, for the drag holds the view to the pointer; the page still does not get it', async () => {
    const { container, minimap } = open();
    await frame();
    const v = viewBox();
    const p = new Pointer().on(minimap);
    p.down([v.x + 2, v.y + 2]);
    p.move([v.x + 12, v.y + 6]);
    const dragged = camera(container);
    expect(wheel(minimap, { dy: -10, at: [20, 20] })).toBe(false);
    expect(camera(container)).toEqual(dragged);
    p.up();
    expect(wheel(minimap, { dy: -10, at: [20, 20] })).toBe(false);
    expect(camera(container).z).toBeGreaterThan(dragged.z);
  });
});

describe('a click in the minimap', () => {
  it('outside the view box glides the view’s middle there, the box straight to where it was clicked; on the box it does nothing', async () => {
    const { container, minimap } = open();
    await frame();
    const v = viewBox();
    const p = new Pointer().on(minimap);
    p.click([v.x + v.w / 2, v.y + v.h / 2]);
    expect(viewBox()).toEqual(v);

    reduceMotion(false);
    const z = camera(container).z;
    const at = [v.x + v.w + 30 > 190 ? 6 : v.x + v.w + 30, 50] as const;
    // The world point under the click, by the map as it was drawn then.
    const [s, , , , tx, ty] = minimap.querySelector('g')!.getAttribute('transform')!.match(/[-\d.e]+/g)!.map(Number) as [number, number, number, number, number, number];
    const target = [(at[0] - tx) / s, (at[1] - ty) / s] as const;
    p.click(at);
    // A glide: it has not moved yet.
    expect(viewBox()).toEqual(v);
    const centres: Array<[number, number]> = [];
    for (let i = 0; i < 6; i++) {
      await frame();
      const b = viewBox();
      centres.push([b.x + b.w / 2, b.y + b.h / 2]);
    }
    // While it glides, the map holds still: the box heads straight for the click.
    const [c0, c1] = [centres[0]!, centres[centres.length - 1]!];
    expect(Math.hypot(c1[0] - at[0], c1[1] - at[1])).toBeLessThan(Math.hypot(c0[0] - at[0], c0[1] - at[1]));
    for (const c of centres) expect(Math.abs((at[0] - c0[0]) * (c[1] - c0[1]) - (at[1] - c0[1]) * (c[0] - c0[0]))).toBeLessThan(1e-6);
    await landed();
    const cam = camera(container);
    expect((window.innerWidth / 2 - cam.x) / cam.z).toBeCloseTo(target[0], 6);
    expect((window.innerHeight / 2 - cam.y) / cam.z).toBeCloseTo(target[1], 6);
    expect(cam.z).toBe(z);
  });
});

describe('the minimap while the camera glides', () => {
  it('a click goes on to the zoom the camera was gliding to, not the zoom it had got to (F3a)', async () => {
    const { container, minimap } = open();
    await frame();
    reduceMotion(false);
    const z0 = camera(container).z;
    screen.getByRole('button', { name: 'Zoom in' }).click();
    // 80 ms into the zoom.
    await frames(5);
    const mid = camera(container).z;
    expect(mid).toBeGreaterThan(z0);
    expect(mid).toBeLessThan(z0 * 1.25);
    const at = beside(viewBox());
    const target = worldUnder(minimap, at);
    new Pointer().on(minimap).click(at);
    await landed();
    expect(camera(container).z).toBeCloseTo(z0 * 1.25, 6);
    expect(viewMiddle(container)[0]).toBeCloseTo(target[0], 4);
    expect(viewMiddle(container)[1]).toBeCloseTo(target[1], 4);
  });

  it('a press that becomes a drag keeps that zoom too (F3a)', async () => {
    const { container, minimap } = open();
    await frame();
    reduceMotion(false);
    const z0 = camera(container).z;
    screen.getByRole('button', { name: 'Zoom in' }).click();
    await frames(5);
    const at = beside(viewBox());
    const p = new Pointer().on(minimap);
    p.down(at);
    await frames(2);
    p.move([at[0] + 9, at[1] + 2]);
    expect(camera(container).z).toBeCloseTo(z0 * 1.25, 6);
    p.up();
    await landed();
    expect(camera(container).z).toBeCloseTo(z0 * 1.25, 6);
  });

  it('a second click while the first still glides is judged by the map as it is drawn, and the map holds still (F3b)', async () => {
    const { container, minimap } = open();
    await frame();
    reduceMotion(false);
    const p = new Pointer().on(minimap);
    p.click(beside(viewBox()));
    await frames(5);
    const layer = minimap.querySelector('g')!;
    const held = layer.getAttribute('transform');
    const v = viewBox();
    const at: Mini = [v.x - 20 < 6 ? 190 : v.x - 20, 30];
    const target = worldUnder(minimap, at);
    p.click(at);
    await frame();
    expect(layer.getAttribute('transform')).toBe(held);
    // Up to the frame before it lands (the 31st of 32), the map is the one the owner clicked
    // on, and the box has all but reached the click.
    for (let i = 0; i < 30; i++) {
      await frame();
      expect(layer.getAttribute('transform')).toBe(held);
    }
    const b = middleOf(viewBox());
    expect(b[0]).toBeCloseTo(at[0], 4);
    expect(b[1]).toBeCloseTo(at[1], 4);
    await landed();
    expect(viewMiddle(container)[0]).toBeCloseTo(target[0], 4);
    expect(viewMiddle(container)[1]).toBeCloseTo(target[1], 4);
  });

  it('a press on the view box stops the glide: the box stays under the still pointer, and moves with it from there (F3c)', async () => {
    const { container, board, minimap } = open();
    wheel(board, { dx: 3000, dy: 1500 });
    await frame();
    reduceMotion(false);
    Keyboard.press('1');
    await frames(4);
    const v = viewBox();
    const grab = middleOf(v);
    const p = new Pointer().on(minimap);
    p.down(grab);
    const pressed = camera(container);
    await frames(6);
    expect(camera(container)).toEqual(pressed);
    expect(viewBox()).toEqual(v);
    p.move([grab[0] + 10, grab[1] + 5]);
    await frame();
    const now = viewBox();
    expect(now.x - v.x).toBeCloseTo(10, 6);
    expect(now.y - v.y).toBeCloseTo(5, 6);
    p.up();
  });

  it('a press outside the view box that becomes a drag: the box glides for the pointer, then is under it by its middle, and no glide is left', async () => {
    const { container, minimap } = open();
    await frame();
    reduceMotion(false);
    const v = viewBox();
    const at = beside(v);
    const z = camera(container).z;
    const far = (b: Mini) => Math.hypot(b[0] - at[0], b[1] - at[1]);
    const p = new Pointer().on(minimap);
    p.down(at);
    await frames(3);
    const onTheWay = far(middleOf(viewBox()));
    expect(onTheWay).toBeLessThan(far(middleOf(v)));
    expect(onTheWay).toBeGreaterThan(1);
    // Inside the click slop it is still a click: the glide goes on.
    p.move([at[0] + 3, at[1]]);
    await frame();
    expect(far(middleOf(viewBox()))).toBeLessThan(onTheWay);
    expect(far(middleOf(viewBox()))).toBeGreaterThan(1);
    // Past it, the view's middle is under the pointer.
    for (const [dx, dy] of [
      [8, 3],
      [15, -6],
      [-20, 10],
    ] as const) {
      p.move([at[0] + dx, at[1] + dy]);
      await frame();
      const b = middleOf(viewBox());
      expect(b[0]).toBeCloseTo(at[0] + dx, 6);
      expect(b[1]).toBeCloseTo(at[1] + dy, 6);
    }
    expect(camera(container).z).toBe(z);
    const dragged = camera(container);
    p.up();
    await landed();
    expect(camera(container)).toEqual(dragged);
  });
});

describe('a press in the minimap that hardly moves', () => {
  it('is a click up to 4 px from where it went down, and a drag from 5 px', async () => {
    const { container, minimap } = open();
    await frame();
    const at = beside(viewBox());
    const p = new Pointer().on(minimap);
    p.down(at);
    // With reduced motion the click lands at once.
    const clicked = camera(container);
    p.move([at[0] + 4, at[1]]);
    expect(camera(container)).toEqual(clicked);
    p.move([at[0] + 3, at[1] + 4]);
    expect(camera(container)).not.toEqual(clicked);
    const b = middleOf(viewBox());
    expect(b[0]).toBeCloseTo(at[0] + 3, 6);
    expect(b[1]).toBeCloseTo(at[1] + 4, 6);
    p.up();
  });
});

describe('the view box', () => {
  it('is never smaller than 6 px, about the middle of what the board shows', async () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 320, 100]));
    b.must('owner', note('m2', [400000, 200000, 320, 100]));
    const { container } = render(<App source={localSource({ events: b.events })} />);
    for (let i = 0; i < 30; i++) wheel(screen.getByTestId('board'), { dy: -10, ctrl: true });
    expect(camera(container).z).toBe(4);
    await frame();
    const v = viewBox();
    expect(v.w).toBe(6);
    expect(v.h).toBe(6);
  });
});

describe('the zoom buttons', () => {
  it('are grey at the limits: out at 20%, in at 400%, and both work one step inside', async () => {
    const { board } = open();
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' }) as HTMLButtonElement;
    const zoomOut = screen.getByRole('button', { name: 'Zoom out' }) as HTMLButtonElement;
    for (let i = 0; i < 30; i++) wheel(board, { dy: 10, ctrl: true });
    await frame();
    expect(screen.getByTestId('zoom').textContent).toBe('20%');
    expect(zoomOut.disabled).toBe(true);
    expect(zoomIn.disabled).toBe(false);
    wheel(board, { dy: -1, ctrl: true });
    await frame();
    expect(zoomOut.disabled).toBe(false);
    for (let i = 0; i < 60; i++) wheel(board, { dy: -10, ctrl: true });
    await frame();
    expect(screen.getByTestId('zoom').textContent).toBe('400%');
    expect(zoomIn.disabled).toBe(true);
    expect(zoomOut.disabled).toBe(false);
    wheel(board, { dy: 1, ctrl: true });
    await frame();
    expect(zoomIn.disabled).toBe(false);
  });
});

describe('back to the board', () => {
  it('shows when nothing on the board is in view, and a press goes back to the whole board', async () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 320, 100]));
    b.must('owner', note('m2', [900, 700, 320, 100]));
    const { container } = render(<App source={localSource({ events: b.events })} />);
    const board = screen.getByTestId('board');
    await frame();
    expect(screen.queryByTestId('back-to-board')).toBeNull();
    Keyboard.press('1');
    const fitted = camera(container);
    for (let i = 0; i < 5; i++) wheel(board, { dx: 40000 });
    await frame();
    const back = screen.getByTestId('back-to-board');
    expect(back.textContent).toBe('Nothing in view.Go back to the board');
    act(() => back.click());
    expect(camera(container)).toEqual(fitted);
    await frame();
    expect(screen.queryByTestId('back-to-board')).toBeNull();
  });

  it('never shows while the camera glides over empty ground, and shows once it rests with nothing in view', async () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 320, 100]));
    b.must('owner', note('m2', [5000, 0, 320, 100]));
    const { container } = render(<App source={localSource({ events: b.events })} />);
    const select = (id: string) => new Pointer().on(container.querySelector<HTMLElement>(`[data-item="${id}"]`)!).click([10, 10]);
    select('m1');
    Keyboard.press('2');
    await frame();
    expect(screen.queryByTestId('back-to-board')).toBeNull();
    reduceMotion(false);

    /** Each frame until the camera has long stood still: where it was, and whether the button showed. */
    async function film() {
      const seen: Array<{ at: ReturnType<typeof camera>; shown: boolean }> = [];
      for (let i = 0; i < 40; i++) {
        await frame();
        seen.push({ at: camera(container), shown: screen.queryByTestId('back-to-board') !== null });
      }
      const rest = seen[seen.length - 1]!.at;
      return { rest, moving: seen.filter((s) => s.at.x !== rest.x || s.at.y !== rest.y || s.at.z !== rest.z) };
    }

    // From one note to the other, 4680 px of empty ground apart at 100%: in the middle of the glide neither is in view.
    select('m2');
    Keyboard.press('2');
    const across = await film();
    expect(across.moving.filter((s) => s.at.x < -400 && s.at.x > -3900)).not.toEqual([]);
    expect(across.moving.filter((s) => s.shown)).toEqual([]);
    expect(screen.queryByTestId('back-to-board')).toBeNull();

    // Two pages down, off the bottom of the board: the last frames of the glide show nothing, and
    // the button comes once the camera rests there.
    Keyboard.press('PageDown');
    Keyboard.press('PageDown');
    const off = await film();
    expect(off.moving.length).toBeGreaterThan(20);
    expect(off.moving.filter((s) => s.shown)).toEqual([]);
    expect(screen.queryByTestId('back-to-board')).toBeTruthy();
  });

  it('goes to the nearest item when the board does not fit even at 20%', async () => {
    const b = openBoard();
    b.must('owner', note('near', [0, 0, 320, 100]));
    b.must('owner', note('far', [900000, 0, 320, 100]));
    const { container } = render(<App source={localSource({ events: b.events })} />);
    const board = screen.getByTestId('board');
    // Off to the far right of the near one, out past it.
    for (let i = 0; i < 4; i++) wheel(board, { dx: -2000 });
    await frame();
    act(() => screen.getByTestId('back-to-board').click());
    const c = camera(container);
    // The near note is in the middle of the room, at 100%.
    expect(c.z).toBe(1);
    expect(c.x + 160).toBeGreaterThan(0);
    expect(c.x + 160).toBeLessThan(window.innerWidth);
  });
});
