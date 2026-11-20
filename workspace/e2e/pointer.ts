import type { Page } from '@playwright/test';

/**
 * What a MacBook sends, for browser tests on the system Chrome. Chrome's own input makes the
 * plain mouse, the wheel in pixels and the keyboard by letter; those go through Playwright's
 * real devices. What Chrome cannot make here (a wheel in lines or pages, Safari's gesture
 * events, a key whose letter is not the one at its place) is dispatched in the page, as an
 * event built the way that browser builds it. Points are page coordinates.
 */

/** A point on the page: clientX and clientY. */
export type XY = readonly [x: number, y: number];

export interface Modifiers {
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

/** Where the board's camera is: screen = world * z + (x, y), from the board's top-left corner. */
export interface Camera {
  x: number;
  y: number;
  z: number;
}

const KEY_NAMES: Record<keyof Modifiers, string> = { alt: 'Alt', ctrl: 'Control', meta: 'Meta', shift: 'Shift' };

const held = (m: Modifiers) => (Object.keys(KEY_NAMES) as Array<keyof Modifiers>).filter((k) => m[k]).map((k) => KEY_NAMES[k]);

/** Let one frame pass in the page, so what an event set off has been drawn. */
export async function nextFrame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}

/**
 * One turn of the wheel, in pixels, through Chrome's real input, with the modifiers held on the
 * real keyboard. A trackpad pinch in Chrome and Firefox arrives as this with `ctrl`.
 */
export async function wheel(page: Page, { at, dx = 0, dy = 0, ...modifiers }: { at: XY; dx?: number; dy?: number } & Modifiers): Promise<void> {
  await page.mouse.move(at[0], at[1]);
  const keys = held(modifiers);
  for (const k of keys) await page.keyboard.down(k);
  await page.mouse.wheel(dx, dy);
  for (const k of keys.reverse()) await page.keyboard.up(k);
  await nextFrame(page);
}

/**
 * A real trackpad pinch about `at`, by `scale` (2 is in to twice the size), through Chrome's
 * DevTools input. Chrome delivers it to the page as a run of trusted wheel events with `ctrlKey`
 * and small pixel deltas, as a MacBook's trackpad does. `speed` is in pixels a second.
 */
export async function pinch(page: Page, { at, scale, speed = 800 }: { at: XY; scale: number; speed?: number }): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.synthesizePinchGesture', { x: at[0], y: at[1], scaleFactor: scale, relativeSpeed: speed, gestureSourceType: 'mouse' });
  } finally {
    await cdp.detach();
  }
  await nextFrame(page);
}

/**
 * One wheel event built in the page, sent to the element under `at`: the way to send deltas in
 * lines or pages, which Chrome's input cannot make. A page with `cancelable` events like
 * Chrome's. Resolves to false when the page called `preventDefault`.
 */
export async function syntheticWheel(
  page: Page,
  { at, dx = 0, dy = 0, mode = 'pixel', ...modifiers }: { at: XY; dx?: number; dy?: number; mode?: 'pixel' | 'line' | 'page' } & Modifiers,
): Promise<boolean> {
  const open = await page.evaluate(
    ({ at: [clientX, clientY], dx, dy, mode, m }) => {
      const el = document.elementFromPoint(clientX, clientY) ?? document.body;
      const deltaMode = { pixel: 0, line: 1, page: 2 }[mode];
      const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, composed: true, clientX, clientY, deltaX: dx, deltaY: dy, deltaMode, altKey: !!m.alt, ctrlKey: !!m.ctrl, metaKey: !!m.meta, shiftKey: !!m.shift });
      return el.dispatchEvent(e);
    },
    { at, dx, dy, mode, m: modifiers },
  );
  await nextFrame(page);
  return open;
}

/**
 * One of Safari's gesture events, built in the page and sent to the element under `at`. Safari
 * sends a trackpad pinch as `gesturestart`, then `gesturechange` with the `scale` since the
 * start, then `gestureend`. Chrome never sends them. Resolves to false when the page called
 * `preventDefault`.
 */
export async function gesture(page: Page, type: 'gesturestart' | 'gesturechange' | 'gestureend', { at, scale, rotation = 0 }: { at: XY; scale: number; rotation?: number }): Promise<boolean> {
  return page.evaluate(
    ({ type, at: [clientX, clientY], scale, rotation }) => {
      const el = document.elementFromPoint(clientX, clientY) ?? document.body;
      const e = new UIEvent(type, { bubbles: true, cancelable: true, composed: true });
      const fields = { scale, rotation, clientX, clientY, screenX: clientX, screenY: clientY, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
      for (const [k, v] of Object.entries(fields)) Object.defineProperty(e, k, { value: v });
      return el.dispatchEvent(e);
    },
    { type, at, scale, rotation },
  );
}

/** A whole Safari pinch at `at`: start at scale 1, a change for each of `scales`, and an end at the last one. */
export async function safariPinch(page: Page, { at, scales }: { at: XY; scales: readonly number[] }): Promise<void> {
  await gesture(page, 'gesturestart', { at, scale: 1 });
  for (const scale of scales) {
    await gesture(page, 'gesturechange', { at, scale });
    await nextFrame(page);
  }
  await gesture(page, 'gestureend', { at, scale: scales[scales.length - 1] ?? 1 });
  await nextFrame(page);
}

/**
 * A key by its place and its letter, built in the page and sent to the focused element: down,
 * then up. `key` is what the owner's layout types, `code` the place, named for a US layout: the
 * Z place on a Russian layout is `{ key: 'я', code: 'KeyZ' }`. Chrome's real keyboard always
 * types the US letter of a place, so for that plain case use `page.keyboard.press`. Resolves
 * to false when the page called `preventDefault` on the down.
 */
export async function keyAt(page: Page, { key, code, capsLock = false, ...modifiers }: { key: string; code: string; capsLock?: boolean } & Modifiers): Promise<boolean> {
  const open = await page.evaluate(
    ({ key, code, capsLock, m }) => {
      const el = document.activeElement ?? document.body;
      const init = { bubbles: true, cancelable: true, composed: true, key, code, altKey: !!m.alt, ctrlKey: !!m.ctrl, metaKey: !!m.meta, shiftKey: !!m.shift, modifierCapsLock: capsLock };
      const open = el.dispatchEvent(new KeyboardEvent('keydown', init));
      el.dispatchEvent(new KeyboardEvent('keyup', init));
      return open;
    },
    { key, code, capsLock, m: modifiers },
  );
  await nextFrame(page);
  return open;
}

/** The board's camera, read from the transform on `.world`. */
export async function readCamera(page: Page): Promise<Camera> {
  const t = await page.locator('.world').evaluate((el) => (el as HTMLElement).style.transform);
  const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(t);
  if (!m) throw new Error(`the world's transform is not a camera: "${t}"`);
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}

/** Where a point of the board's world is on the page now. */
export async function worldToPage(page: Page, [wx, wy]: XY): Promise<XY> {
  const cam = await readCamera(page);
  const r = await page.getByTestId('board').boundingBox();
  if (!r) throw new Error('the board is not on screen');
  return [r.x + wx * cam.z + cam.x, r.y + wy * cam.z + cam.y];
}

/** How many pixels two screenshots of one size differ in, counted by the page's own image decoder. */
export function pixelsApart(page: Page, a: Buffer, b: Buffer): Promise<number> {
  return page.evaluate(
    async ([x, y]) => {
      const read = async (b64: string) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const g = new OffscreenCanvas(image.width, image.height).getContext('2d');
        if (!g) throw new Error('no 2d canvas');
        g.drawImage(image, 0, 0);
        return g.getImageData(0, 0, image.width, image.height).data;
      };
      const [p, q] = await Promise.all([read(x), read(y)]);
      let n = 0;
      for (let i = 0; i < p.length; i += 4) if (p[i] !== q[i] || p[i + 1] !== q[i + 1] || p[i + 2] !== q[i + 2]) n++;
      return n;
    },
    [a.toString('base64'), b.toString('base64')] as const,
  );
}
