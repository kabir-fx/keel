import { expect, test, type Page } from '@playwright/test';
import { gesture, nextFrame, readCamera, syntheticWheel, wheel, worldToPage, type Camera, type XY } from './pointer';

/**
 * The camera on the system Chrome: a fit keeps clear of every panel, Safari's pinch zooms the
 * board and never the page, and a glide lands where it says.
 */

type Rect = { x: number; y: number; width: number; height: number };

async function open(page: Page, url: string) {
  await page.goto(url);
  await expect(page.getByTestId('board')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('[data-measure]')).toHaveCount(0);
  await page.waitForTimeout(500);
}

/** Where each panel is on the page: everything over the board that stays put when the board moves. */
async function panels(page: Page): Promise<Array<{ name: string; r: Rect }>> {
  return page.evaluate(() => {
    const sel = '.pill, .view-switch, .toolbar, .zoom, .minimap, .crumb, .hint, [data-testid="watch"], [data-viewport-ui]';
    return [...document.querySelectorAll<HTMLElement>(sel)]
      .map((el) => {
        const b = el.getBoundingClientRect();
        return { name: el.className || el.tagName, r: { x: b.x, y: b.y, width: b.width, height: b.height } };
      })
      .filter((p) => p.r.width > 0 && p.r.height > 0);
  });
}

/** Where every item on the board is drawn on the page. */
async function items(page: Page): Promise<Array<{ id: string; r: Rect }>> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.layer > [data-item]')]
      .map((el) => {
        const b = el.getBoundingClientRect();
        return { id: el.dataset.item ?? '', r: { x: b.x, y: b.y, width: b.width, height: b.height } };
      })
      .filter((p) => p.r.width > 0 && p.r.height > 0),
  );
}

const overlap = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Every item clear of every panel. */
async function expectClear(page: Page) {
  const ps = await panels(page);
  const its = await items(page);
  expect(its.length).toBeGreaterThan(3);
  const under = its.flatMap((i) => ps.filter((p) => overlap(i.r, p.r)).map((p) => `${i.id} under ${p.name}`));
  expect(under).toEqual([]);
}

test('a fit keeps the content clear of every panel, with the watch panel open and folded', async ({ page }) => {
  // Tall enough that the whole board fits above the 20% floor: below it, no fit can keep clear.
  await page.setViewportSize({ width: 1600, height: 1300 });
  await open(page, '/?fixture=engine-loop&at=6');
  const watch = page.getByTestId('watch');
  await expect(watch).toBeVisible();
  await page.keyboard.press('1');
  await nextFrame(page);
  await expectClear(page);

  await watch.getByRole('button', { name: 'Fold the build away' }).click();
  await expect(watch).toHaveClass(/watch--folded/);
  await page.keyboard.press('1');
  await nextFrame(page);
  await expectClear(page);
});

test('on a narrow window with the build open, a fit is made in a room on the board and clear of every panel', async ({ page }) => {
  // The watch panel reaches 408 px in, past the middle of a board 800 wide.
  await page.setViewportSize({ width: 800, height: 900 });
  await open(page, '/?fixture=engine-loop&at=6');
  await expect(page.getByTestId('watch')).toBeVisible();
  await expect(page.getByTestId('watch')).not.toHaveClass(/watch--folded/);
  const board = (await page.getByTestId('board').boundingBox())!;
  const onBoard = (r: Rect) => r.x >= board.x && r.y >= board.y && r.x + r.width <= board.x + board.width && r.y + r.height <= board.y + board.height;
  const viewportUi = () =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-viewport-ui]')]
        .map((el) => {
          const b = el.getBoundingClientRect();
          return { name: el.className, r: { x: b.x, y: b.y, width: b.width, height: b.height } };
        })
        .filter((p) => p.r.width > 0 && p.r.height > 0),
    );
  const under = async (r: Rect) => (await viewportUi()).filter((p) => overlap(r, p.r)).map((p) => p.name);

  // The whole board is too large for the room at the smallest zoom here, so it runs past the
  // room on every side: its middle is the room's middle, on the board and under no panel.
  await page.keyboard.press('1');
  await nextFrame(page);
  expect((await readCamera(page)).z).toBe(0.2);
  const its = await items(page);
  const left = Math.min(...its.map((i) => i.r.x));
  const top = Math.min(...its.map((i) => i.r.y));
  const middle: Rect = { x: (left + Math.max(...its.map((i) => i.r.x + i.r.width))) / 2, y: (top + Math.max(...its.map((i) => i.r.y + i.r.height))) / 2, width: 1, height: 1 };
  expect(onBoard(middle)).toBe(true);
  expect(await under(middle)).toEqual([]);

  // One note fits that room whole: fitted alone, no part of it is under a panel or off the board.
  // It is one the owner can click: in view, under no panel, and with nothing over it.
  const ps = await viewportUi();
  const alone = its.find((i) => i.id.startsWith('note-') && onBoard(i.r) && !ps.some((p) => overlap(i.r, p.r)) && !its.some((o) => o !== i && overlap(i.r, o.r)));
  expect(alone).toBeDefined();
  const note = page.locator(`.layer > [data-item="${alone!.id}"]`);
  await note.click();
  await expect(note).toHaveClass(/item--selected/);
  await page.keyboard.press('2');
  await nextFrame(page);
  const r = (await note.boundingBox())!;
  expect((await readCamera(page)).z).toBeGreaterThan(0.2);
  expect(onBoard(r)).toBe(true);
  expect(await under(r)).toEqual([]);
});

test('Safari’s trackpad pinch zooms the board about the pointer, and never the page', async ({ page }) => {
  await open(page, '/?fixture=tools&at=1');
  const at: XY = [720, 520];
  await page.mouse.move(at[0], at[1]);
  const c0 = await readCamera(page);
  const r = (await page.getByTestId('board').boundingBox())!;
  const w: XY = [(at[0] - r.x - c0.x) / c0.z, (at[1] - r.y - c0.y) / c0.z];
  // Safari zooms the page on a gesture event the page lets through. Each one answering false
  // (the page called preventDefault) is what shows the page was never zoomed. Chrome sends no
  // gesture events of its own and these are made by hand, so the page's own zoom
  // (visualViewport.scale) stays 1 here whatever the board does, and is not checked.
  expect(await gesture(page, 'gesturestart', { at, scale: 1 })).toBe(false);
  expect(await gesture(page, 'gesturechange', { at, scale: 1.3 })).toBe(false);
  await nextFrame(page);
  expect(await gesture(page, 'gesturechange', { at, scale: 1.6 })).toBe(false);
  await nextFrame(page);
  expect(await gesture(page, 'gestureend', { at, scale: 1.6 })).toBe(false);
  const c1 = await readCamera(page);
  expect(c1.z).toBeCloseTo(Math.min(4, c0.z * 1.6), 5);
  const back = await worldToPage(page, w);
  expect(Math.abs(back[0] - at[0])).toBeLessThan(0.5);
  expect(Math.abs(back[1] - at[1])).toBeLessThan(0.5);
});

test('one notch of a mouse wheel with Ctrl zooms by at most 10.5%, about the pointer', async ({ page }) => {
  await open(page, '/?fixture=tools&at=1');
  const at: XY = [720, 520];
  const c0 = await readCamera(page);
  const r = (await page.getByTestId('board').boundingBox())!;
  const w: XY = [(at[0] - r.x - c0.x) / c0.z, (at[1] - r.y - c0.y) / c0.z];
  await wheel(page, { at, dy: 100, ctrl: true });
  const c1 = await readCamera(page);
  expect(c0.z / c1.z).toBeGreaterThan(1);
  expect(c0.z / c1.z).toBeLessThanOrEqual(Math.exp(0.1) + 1e-6);
  const back = await worldToPage(page, w);
  expect(Math.abs(back[0] - at[0])).toBeLessThan(0.5);
  expect(Math.abs(back[1] - at[1])).toBeLessThan(0.5);
});

test('a Ctrl wheel over a panel zooms neither the board nor the page; a plain one is the panel’s', async ({ page }) => {
  await open(page, '/?fixture=engine-loop&at=6');
  const c0 = await readCamera(page);
  const watch = (await page.getByTestId('watch').boundingBox())!;
  const over: XY = [watch.x + watch.width / 2, watch.y + watch.height / 2];
  expect(await syntheticWheel(page, { at: over, dy: -10, ctrl: true })).toBe(false);
  expect(await syntheticWheel(page, { at: over, dy: -10, meta: true })).toBe(false);
  expect(await syntheticWheel(page, { at: over, dy: 40 })).toBe(true);
  expect(await readCamera(page)).toEqual(c0);
});

/** Every camera the page shows, one a frame, until it has stood still for a few frames. */
async function filmCamera(page: Page): Promise<Camera[]> {
  return page.evaluate(
    () =>
      new Promise<Camera[]>((done) => {
        const world = document.querySelector<HTMLElement>('.world')!;
        const read = () => {
          const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(world.style.transform)!;
          return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
        };
        const seen = [read()];
        let still = 0;
        const tick = () => {
          const c = read();
          const last = seen[seen.length - 1]!;
          if (c.x === last.x && c.y === last.y && c.z === last.z) still += 1;
          else {
            still = 0;
            seen.push(c);
          }
          if (still >= 10 || seen.length > 200) done(seen);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

test('a fit glides: over frames, every point one way along a line, landing exactly where the jump lands', async ({ page }) => {
  await open(page, '/?fixture=tools&at=1');
  const board = (await page.getByTestId('board').boundingBox())!;
  const at: XY = [board.x + 700, board.y + 500];
  // With reduced motion (the default in these tests), a fit is a jump: that is the target.
  await wheel(page, { at, dx: 900, dy: 400 });
  await wheel(page, { at, dy: 10, ctrl: true });
  const away = await readCamera(page);
  await page.keyboard.press('1');
  // With reduced motion the fit is a jump: it has landed already.
  const target = await readCamera(page);
  expect(target).not.toEqual(away);

  // Away again by the wheel, and this time let it glide.
  await wheel(page, { at, dx: -900, dy: -400 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const start = await readCamera(page);
  const [, film] = await Promise.all([page.keyboard.press('1'), filmCamera(page)]);
  expect(film.length).toBeGreaterThan(10);
  expect(film[film.length - 1]).toEqual(target);
  const point = (c: Camera, w: XY) => [w[0] * c.z + c.x, w[1] * c.z + c.y] as const;
  for (const w of [
    [0, 0],
    [600, 300],
    [-400, 900],
  ] as const) {
    const xs = [point(start, w), ...film.map((c) => point(c, w))];
    for (const axis of [0, 1] as const) {
      const d = xs.slice(1).map((p, i) => p[axis] - xs[i]![axis]);
      expect(d.every((v) => v >= -1e-6) || d.every((v) => v <= 1e-6)).toBe(true);
    }
  }
});

test('a drag in the minimap keeps the grabbed point of the view box under the pointer', async ({ page }) => {
  await open(page, '/?fixture=engine-loop&at=6');
  const view = page.getByTestId('minimap-view');
  const v = (await view.boundingBox())!;
  const grab: XY = [v.x + 4, v.y + 3];
  await page.mouse.move(grab[0], grab[1]);
  await page.mouse.down();
  for (const [dx, dy] of [
    [-10, -6],
    [-25, 4],
    [-40, -12],
  ] as const) {
    await page.mouse.move(grab[0] + dx, grab[1] + dy);
    await nextFrame(page);
    const now = (await view.boundingBox())!;
    expect(now.x - v.x).toBeCloseTo(dx, 1);
    expect(now.y - v.y).toBeCloseTo(dy, 1);
  }
  await page.mouse.up();
});

test('the hand: open while a pan is pressed, closed while it moves', async ({ page }) => {
  await open(page, '/?fixture=tools&at=1');
  await page.keyboard.press('h');
  const cursor = () => page.getByTestId('board').evaluate((el) => getComputedStyle(el).cursor);
  expect(await cursor()).toBe('grab');
  await page.mouse.move(700, 500);
  await page.mouse.down();
  expect(await cursor()).toBe('grab');
  await page.mouse.move(760, 520, { steps: 4 });
  await nextFrame(page);
  expect(await cursor()).toBe('grabbing');
  await page.mouse.up();
  expect(await cursor()).toBe('grab');
});

test('the hand: Esc during a pan opens it at once, with the button still down', async ({ page }) => {
  await open(page, '/?fixture=tools&at=1');
  await page.keyboard.press('h');
  const cursor = () => page.getByTestId('board').evaluate((el) => getComputedStyle(el).cursor);
  await page.mouse.move(700, 500);
  await page.mouse.down();
  await page.mouse.move(760, 520, { steps: 4 });
  await nextFrame(page);
  expect(await cursor()).toBe('grabbing');
  await page.keyboard.press('Escape');
  await nextFrame(page);
  expect(await cursor()).not.toBe('grabbing');
  await page.mouse.up();
  await nextFrame(page);
  expect(await cursor()).toBe('grab');
});
