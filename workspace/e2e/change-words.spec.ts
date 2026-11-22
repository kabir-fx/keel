import { expect, test } from '@playwright/test';
import { ECHO, appIsBuilt, startBoard, type RunningBoard } from './board-server';

/**
 * A box's words changed on the board, against the real board server and the stand-in agent:
 * a double click with Select opens the box's label, Enter keeps the new words and takes the
 * agent's answer to the old words off, and one Undo brings both back (docs/adr/0020).
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

test('a double click opens a box’s label; new words take its answer off, and Undo brings both back', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(board!.url);
  await expect(page.getByTestId('presence')).toHaveAttribute('data-state', 'listening');

  await page.keyboard.press('b');
  await page.mouse.move(500, 400);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(500 + 16 * i, 400 + 8 * i);
  await page.mouse.up();
  await page.keyboard.type('the queue');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  const box = page.locator('.layer [data-kind="box"]');
  await expect(box).toHaveText('the queue');

  // A lone box may hold the agent: then "Answer now" asks for its read.
  const answer = page.getByTestId('presence-answer');
  const card = page.locator('.layer [data-item][data-kind="picture"]');
  await expect(card.or(answer).first()).toBeVisible({ timeout: 15_000 });
  if ((await card.count()) === 0) await answer.click();
  await expect(card).toHaveCount(1, { timeout: 15_000 });
  const old = await card.getAttribute('data-item');
  const oldCard = page.locator(`.layer [data-item="${old}"]`);
  await expect(oldCard).toContainText('the queue');

  await page.keyboard.press('s');
  // A box is hit by the board, not the page: double-click inside it.
  const b = (await box.boundingBox())!;
  await page.mouse.dblclick(b.x + b.width / 2, b.y + b.height / 2);
  const field = page.getByRole('textbox', { name: 'A few words' });
  await expect(field).toHaveValue('the queue');
  await field.fill('the slow part');
  await page.keyboard.press('Enter');
  await expect(field).toBeHidden();
  await expect(box).toHaveText('the slow part');
  await expect(oldCard).toHaveCount(0);
  // A changed label is work on the drawing: the agent holds, and no new answer comes by itself (docs/adr/0019).
  await expect(page.getByTestId('presence')).toHaveAttribute('data-hold', 'drawing');
  await page.waitForTimeout(2500);
  await expect(card).toHaveCount(0);

  await page.keyboard.press('ControlOrMeta+z');
  await expect(box).toHaveText('the queue');
  await expect(oldCard).toHaveCount(1);
  await expect(oldCard).toContainText('the queue');
});
