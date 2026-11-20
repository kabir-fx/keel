import { expect, test } from '@playwright/test';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ECHO, SHOTS, appIsBuilt, startBoard, type RunningBoard } from './board-server';

/**
 * The skeleton, joined: the real board server, the built app, and a stand-in agent.
 * A note goes in, a card comes out, and the open marks go from 1 to 0. Then the page is
 * reloaded, and the board is still there, because the log is the memory.
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

const count = async (page: import('@playwright/test').Page, id: string) => Number(await page.getByTestId(id).getAttribute('data-n'));

test('a note in, a card out, open marks from 1 to 0', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  const { url, repo } = board!;
  await page.goto(url);
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('board-name')).toContainText('demo-repo');
  // The one-time code is out of the address bar, and no token was ever in it.
  expect(page.url()).not.toContain('code=');
  expect(page.url()).not.toContain('token=');
  await expect(page.getByTestId('presence')).toHaveAttribute('data-state', 'listening');
  expect(await count(page, 'open-count')).toBe(0);
  await page.evaluate(() => document.fonts.ready);

  await page.getByRole('button', { name: 'Write a note' }).click();
  await page.mouse.click(260, 300);
  await expect(page.getByRole('textbox', { name: 'Your note' })).toBeFocused();
  await page.keyboard.type('I want one engine that takes many requests at once');
  await page.keyboard.press('Enter');

  // The mark is open first, then the agent's card closes it.
  const card = page.locator('[data-item]').filter({ hasText: 'How I read your note' });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card).toContainText('You wrote: I want one engine that takes many requests at once');
  await expect.poll(() => count(page, 'open-count')).toBe(0);
  expect(await count(page, 'item-count')).toBe(2);
  await expect(page.locator('[data-measure]')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/live-note-and-card.png` });

  // The log on disk tells the same story: the owner's note, the agent's answer, the placement.
  const log = readFileSync(join(repo, '.keel/board/log.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { type: string; by: string; item?: { id: string; kind: string; answers?: string[] } | string });
  const note = log.find((e) => e.type === 'item.add' && e.by === 'owner');
  const answer = log.find((e) => e.type === 'item.add' && e.by === 'agent');
  expect(note).toBeTruthy();
  expect((answer!.item as { answers: string[] }).answers).toEqual([(note!.item as { id: string }).id]);
  expect(log.filter((e) => e.type === 'item.place')).toHaveLength(1);
  expect(log.findIndex((e) => e === note)).toBeLessThan(log.findIndex((e) => e === answer));

  // A reload reads the same board back.
  await page.reload();
  await expect(page.locator('[data-item]').filter({ hasText: 'How I read your note' })).toBeVisible();
  await expect(page.locator('[data-item]').filter({ hasText: 'I want one engine' }).first()).toBeVisible();
  expect(await count(page, 'open-count')).toBe(0);
  expect(errors).toEqual([]);
});

test('a circle drawn round the agent’s card is one ink mark with a snapshot, and the agent answers it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const { url, repo } = board!;
  await page.goto(url);
  await expect(page.getByTestId('board')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  // A note of its own, so this test stands alone; the agent answers it with a card.
  await page.getByRole('button', { name: 'Write a note' }).click();
  await page.mouse.click(260, 640);
  await page.keyboard.type('circle me');
  await page.keyboard.press('Enter');
  const card = page.locator('[data-item]').filter({ hasText: 'You wrote: circle me' });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => count(page, 'open-count')).toBe(0);
  await expect(page.locator('[data-measure]')).toHaveCount(0);
  await page.waitForTimeout(300);

  // Draw a loop round the card with the pen.
  const cardId = await card.getAttribute('data-item');
  const b = (await card.boundingBox())!;
  const [cx, cy, rx, ry] = [b.x + b.width / 2, b.y + b.height / 2, b.width / 2 + 30, b.height / 2 + 30];
  await page.keyboard.press('p');
  await page.mouse.move(cx, cy - ry);
  await page.mouse.down();
  for (let i = 1; i <= 50; i++) {
    const t = -Math.PI / 2 + (i / 50) * 2.1 * Math.PI;
    await page.mouse.move(cx + rx * Math.cos(t), cy + ry * Math.sin(t));
  }
  await page.mouse.up();

  // The mark is open first, then the agent's next card answers it.
  await expect.poll(() => count(page, 'open-count'), { timeout: 10_000 }).toBe(1);
  const read = () =>
    readFileSync(join(repo, '.keel/board/log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; by: string; item?: { id: string; kind: string; hint?: string; targets?: unknown[]; snapshot?: string; answers?: string[] } });
  const ink = read().find((e) => e.type === 'item.add' && e.item?.kind === 'ink')!.item!;
  expect(ink.hint).toBe('circle');
  expect(ink.targets).toEqual([{ item: cardId }]);
  expect(ink.snapshot).toMatch(/^assets\/m\d+\.png$/);
  expect(existsSync(join(repo, '.keel/board', ink.snapshot!))).toBe(true);
  // Keep a copy to look at: it is what the agent sees of the sketch.
  copyFileSync(join(repo, '.keel/board', ink.snapshot!), `${SHOTS}/live-snapshot.png`);
  await expect.poll(() => count(page, 'open-count'), { timeout: 15_000 }).toBe(0);
  expect(read().some((e) => e.type === 'item.add' && e.by === 'agent' && e.item?.answers?.includes(ink.id))).toBe(true);
  await expect(page.locator('[data-measure]')).toHaveCount(0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/live-circle-answered.png` });
  expect(errors).toEqual([]);
});

test('the bare address works in the same browser: the token kept by this origin carries the owner, with no cookie', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const { url } = board!;
  // Opened once with the token, the page keeps it in its own origin's storage...
  await page.goto(url);
  await expect(page.getByTestId('presence')).toHaveAttribute('data-state', /listening|drawing|waiting/);
  // ...so the bare address, with no token in it and no cookie at all, opens the same board.
  await page.context().clearCookies();
  await page.goto(new URL(url).origin + '/');
  await expect(page.getByTestId('board-name')).toContainText('demo-repo');
  await expect(page.getByTestId('connection')).toHaveCount(0);
  expect(page.url()).not.toContain('token');
  // It is the owner's page: a note goes on the board.
  const items = await count(page, 'item-count');
  await page.getByRole('button', { name: 'Write a note' }).click();
  await page.mouse.click(260, 420);
  await page.keyboard.type('a note from the bare address');
  await page.keyboard.press('Enter');
  await expect.poll(() => count(page, 'item-count')).toBeGreaterThan(items);
  // A file goes up with the token, and is read back with it: no link holds an address.
  await page.getByTestId('file-input').setInputFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# notes\n') });
  const open = page.locator('[data-item][data-kind="file"]').getByRole('button', { name: 'Open' }).first();
  await expect(open).toBeVisible();
  const popup = page.waitForEvent('popup');
  await open.click();
  const tab = await popup;
  await expect.poll(() => tab.url()).toMatch(/^blob:/);
  await expect(tab.locator('body')).toContainText('# notes');
  expect(errors).toEqual([]);
});
