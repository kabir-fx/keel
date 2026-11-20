import { expect, test, type Page } from '@playwright/test';
import { gesture, keyAt, pinch, readCamera, syntheticWheel, wheel, worldToPage, type XY } from './pointer';

/**
 * The input helpers on the system Chrome, against today's board: the wheel, a trackpad pinch,
 * a Safari gesture and keys by place and by letter. Each test pins what the board does now,
 * or only that the event arrived as built, where the board does not yet read it.
 */

async function open(page: Page) {
  await page.addInitScript(() => {
    // Every wheel, gesture and key event as the board's own listeners see it.
    const w = window as unknown as { __seen: Array<Record<string, unknown>> };
    w.__seen = [];
    for (const type of ['wheel', 'gesturestart', 'gesturechange', 'gestureend', 'keydown']) {
      window.addEventListener(
        type,
        (e) => {
          const f = e as Partial<WheelEvent & KeyboardEvent & { scale: number }>;
          w.__seen.push({ type, ctrl: f.ctrlKey, deltaMode: f.deltaMode, scale: f.scale, x: f.clientX, key: f.key, code: f.code, caps: f.getModifierState?.('CapsLock'), trusted: e.isTrusted });
        },
        { capture: true, passive: true },
      );
    }
  });
  await page.goto('/?fixture=tools&at=1');
  await expect(page.getByTestId('board')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('[data-measure]')).toHaveCount(0);
  await page.waitForTimeout(500);
}

const seen = (page: Page, type: string) => page.evaluate((t) => (window as unknown as { __seen: Array<Record<string, unknown>> }).__seen.filter((e) => e.type === t), type);

/** A point of bare ground in the middle of the screen. */
const MID: XY = [720, 520];

/** The world point under a page point. */
async function worldAt(page: Page, [px, py]: XY): Promise<XY> {
  const cam = await readCamera(page);
  const r = (await page.getByTestId('board').boundingBox())!;
  return [(px - r.x - cam.x) / cam.z, (py - r.y - cam.y) / cam.z];
}

test('the wheel: a plain turn pans by its delta; Ctrl, and a trackpad pinch, zoom about the pointer', async ({ page }) => {
  await open(page);
  const c0 = await readCamera(page);
  await wheel(page, { at: MID, dx: 40, dy: 90 });
  expect(await readCamera(page)).toEqual({ x: c0.x - 40, y: c0.y - 90, z: c0.z });

  // Ctrl with the wheel zooms in for a negative delta, and the point under the pointer stays put.
  const w = await worldAt(page, MID);
  await wheel(page, { at: MID, dy: -20, ctrl: true });
  const c1 = await readCamera(page);
  expect(c1.z).toBeGreaterThan(c0.z);
  const back = await worldToPage(page, w);
  expect(Math.abs(back[0] - MID[0])).toBeLessThan(0.5);
  expect(Math.abs(back[1] - MID[1])).toBeLessThan(0.5);

  // A real pinch arrives as trusted wheel events with Ctrl, and zooms in about the same point.
  await page.evaluate(() => ((window as unknown as { __seen: unknown[] }).__seen.length = 0));
  await pinch(page, { at: MID, scale: 1.5 });
  const pinched = await seen(page, 'wheel');
  expect(pinched.length).toBeGreaterThan(1);
  expect(pinched.every((e) => e.ctrl === true && e.trusted === true && e.deltaMode === 0)).toBe(true);
  expect((await readCamera(page)).z).toBeGreaterThan(c1.z);
  const still = await worldToPage(page, w);
  expect(Math.abs(still[0] - MID[0])).toBeLessThan(0.5);
  expect(Math.abs(still[1] - MID[1])).toBeLessThan(0.5);

  // A wheel in lines and one in pages arrive as built, and the board takes them: a turn down pans up.
  await page.evaluate(() => ((window as unknown as { __seen: unknown[] }).__seen.length = 0));
  const c2 = await readCamera(page);
  expect(await syntheticWheel(page, { at: MID, dy: 3, mode: 'line' })).toBe(false);
  expect(await syntheticWheel(page, { at: MID, dy: 1, mode: 'page' })).toBe(false);
  expect((await seen(page, 'wheel')).map((e) => e.deltaMode)).toEqual([1, 2]);
  expect((await readCamera(page)).y).toBeLessThan(c2.y);

  // Safari's gesture events arrive with their scale and place. Chrome never sends them.
  await gesture(page, 'gesturestart', { at: MID, scale: 1 });
  await gesture(page, 'gesturechange', { at: MID, scale: 1.4 });
  await gesture(page, 'gestureend', { at: MID, scale: 1.4 });
  expect((await seen(page, 'gesturechange'))[0]).toMatchObject({ scale: 1.4, x: MID[0] });
  expect(await seen(page, 'gestureend')).toHaveLength(1);
});

test('keys: the real keyboard and a key by place both pick tools; Caps Lock is reported', async ({ page }) => {
  await open(page);
  const pressed = (name: string) => page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name });
  await page.keyboard.press('b');
  await expect(pressed('Draw a box')).toHaveAttribute('aria-pressed', 'true');
  // A key the board uses is taken from the browser: the helper answers false.
  expect(await keyAt(page, { key: 'p', code: 'KeyP' })).toBe(false);
  await expect(pressed('Draw with the pen')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(pressed('Select')).toHaveAttribute('aria-pressed', 'true');

  // The letter and the place are sent apart, as a Russian layout sends them, with Caps Lock on.
  await keyAt(page, { key: 'я', code: 'KeyZ', meta: true, capsLock: true });
  expect((await seen(page, 'keydown')).at(-1)).toMatchObject({ key: 'я', code: 'KeyZ', caps: true, trusted: false });
});
