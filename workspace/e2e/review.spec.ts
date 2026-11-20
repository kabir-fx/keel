import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { standIn, upTo } from './stand-in';

/**
 * The journey reviewer's second pass, on the system Chrome with a stand-in server: lines that
 * came with the log from outside, and a page that posts nothing of its own on a reconnect or a
 * reload.
 */

const SHOTS = fileURLToPath(new URL('./shots', import.meta.url));

async function settle(page: Page) {
  await expect(page.getByTestId('board')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('[data-measure]')).toHaveCount(0);
  await page.waitForTimeout(500);
}

test('what came with the log from outside is tagged, the banner says so, and Keep them makes it the board’s own', async ({ page }) => {
  // e3..e11: the owner's first note, a dropped file and a sketch, from a clone.
  const server = await standIn(page, upTo('e11'), { foreign: [{ from: 3, to: 11 }] });
  await page.goto('/?token=owner-token');
  await settle(page);
  const banner = page.getByTestId('foreign');
  await expect(banner).toBeVisible();
  const n = Number(await banner.getAttribute('data-n'));
  expect(n).toBeGreaterThan(3);
  await expect(banner).toContainText(`${n} items on this board were not made on this machine.`);
  await expect(banner).toContainText('The agent leaves them alone until you keep them.');
  await expect(page.locator('[data-foreign]')).toHaveCount(n);
  await expect(page.locator('[data-foreign="n-first"]')).toHaveText('not made here');
  await page.screenshot({ path: `${SHOTS}/review-foreign.png` });
  await banner.getByRole('button', { name: 'Show them' }).click();
  await expect(page.locator('[data-item="n-first"]')).toBeInViewport();
  await banner.getByRole('button', { name: 'Keep them' }).click();
  await expect(page.getByTestId('foreign')).toHaveCount(0);
  await expect(page.locator('[data-foreign]')).toHaveCount(0);
  expect(server.kept()).toBe(true);
  const keep = server.calls.find((c) => c.url.endsWith('/api/keep'))!;
  expect(keep.method).toBe('POST');
  expect(keep.headers.authorization).toBe('Bearer owner-token');
  // A reload asks again: nothing is foreign any more.
  await page.reload();
  await settle(page);
  await expect(page.getByTestId('foreign')).toHaveCount(0);
});

test('a reconnect and a reload post nothing: the page places a picture once, and never moves one by itself', async ({ page }) => {
  const server = await standIn(page, upTo('e53'));
  await page.goto('/?token=owner-token');
  await settle(page);
  // The page placed what had no place yet: that, and only that, it posts.
  expect(server.posts.every((p) => p.draft.type === 'item.place')).toBe(true);
  const placed = server.posts.length;
  expect(placed).toBeGreaterThan(5);
  // "Build this" on the blueprint: the blueprint grows (its track fills in) while the page is open.
  server.emit({ type: 'build.start', chapter: 'engine-loop', track: ['request', 'scheduler', 'engine-loop'], blueprint: 'blueprint', check: 'make check' }, 'owner');
  server.emit({ type: 'part.state', part: 'request', state: 'building' }, 'agent');
  await page.waitForTimeout(400);
  // The server restarts: the socket closes, and the page reconnects and reads the board again.
  const sockets = server.sockets.length;
  server.drop();
  await expect.poll(() => server.sockets.length, { timeout: 10_000 }).toBeGreaterThan(sockets);
  await settle(page);
  await page.waitForTimeout(800);
  expect(server.posts.slice(placed)).toEqual([]);
  // A reload: the same.
  await page.reload();
  await settle(page);
  await page.waitForTimeout(800);
  expect(server.posts.slice(placed)).toEqual([]);
});
