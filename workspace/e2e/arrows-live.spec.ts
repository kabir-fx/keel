import { expect, test, type Page } from '@playwright/test';
import { ECHO, appIsBuilt, startBoard, type RunningBoard } from './board-server';
import { nextFrame } from './pointer';

/**
 * The owner's arrows against the real board server, where a change takes a moment to come back:
 * an end dragged by its handle, and an arrow moved whole, stay drawn where they were dropped in
 * every frame after the lift. The fixture page answers at once, so only a real server shows the
 * arrow as the log still has it for a frame.
 *
 * Needs a build first: `npm run build` from workspace/. `npm run e2e` does both.
 */

let board: RunningBoard | undefined;

test.beforeAll(async () => {
  test.skip(!appIsBuilt(), 'build first: npm run build, from workspace/');
  board = await startBoard({ link: `script:${ECHO}` });
});

test.afterAll(async () => {
  test.setTimeout(60_000);
  await board?.stop();
});

type XY = [number, number];

const lineOf = (page: Page, id: string) => page.evaluate((id) => document.querySelector(`[data-item="${id}"] svg.line-mark path`)?.getAttribute('d') ?? 'none', id);

/** Keep the arrow's line as it is drawn on each of the next 40 frames. */
async function watchFrames(page: Page, id: string) {
  await page.evaluate((id) => {
    const w = window as unknown as { __lines: string[] };
    w.__lines = [];
    let n = 0;
    const tick = () => {
      w.__lines.push(document.querySelector(`[data-item="${id}"] svg.line-mark path`)?.getAttribute('d') ?? 'none');
      if (++n < 40) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, id);
}

/** The different lines those frames drew, in order. */
const linesSeen = async (page: Page) => [...new Set(await page.evaluate(() => (window as unknown as { __lines: string[] }).__lines))];

async function drag(page: Page, from: XY, to: XY, { lift = true }: { lift?: boolean } = {}) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / 10, from[1] + ((to[1] - from[1]) * i) / 10);
  await nextFrame(page);
  if (lift) await page.mouse.up();
}

test('an end dragged, and an arrow moved whole, stay drawn where they were dropped while the board answers', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(board!.url);
  await expect(page.getByTestId('board')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  // Two boxes of the owner's, and an arrow from inside the first to just short of the second.
  for (const [a, b] of [
    [
      [500, 400],
      [600, 520],
    ],
    [
      [800, 400],
      [920, 520],
    ],
  ] as Array<[XY, XY]>) {
    await page.keyboard.press('b');
    await drag(page, a, b);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
  }
  await expect(page.locator('.layer [data-kind="box"]')).toHaveCount(2);
  await page.keyboard.press('a');
  await drag(page, [550.3, 460.3], [791.7, 470.3]);
  await page.keyboard.press('Enter');
  const arrow = page.locator('.layer [data-kind="arrow"]');
  await expect(arrow).toHaveCount(1);
  const id = await arrow.evaluate((e) => (e as HTMLElement).dataset.item!);
  await expect(page.locator('.end-handle[data-end="to"]')).toBeVisible();
  await page.waitForTimeout(600);

  const handle = (await page.locator('.end-handle[data-end="to"]').boundingBox())!;
  await drag(page, [handle.x + handle.width / 2, handle.y + handle.height / 2], [840, 500], { lift: false });
  const heldEnd = await lineOf(page, id);
  await watchFrames(page, id);
  await page.mouse.up();
  await page.waitForTimeout(1000);
  expect(await linesSeen(page)).toEqual([heldEnd]);

  // The whole arrow, taken by its line and moved 60 px down: it lets go of both boxes.
  await page.keyboard.press('Escape');
  await page.mouse.click(675, 480);
  await expect(page.locator('.end-handle[data-end="to"]')).toBeVisible();
  await drag(page, [675, 480], [675, 540], { lift: false });
  const heldWhole = await lineOf(page, id);
  expect(heldWhole).not.toBe(heldEnd);
  await watchFrames(page, id);
  await page.mouse.up();
  await page.waitForTimeout(1000);
  expect(await linesSeen(page)).toEqual([heldWhole]);
});
