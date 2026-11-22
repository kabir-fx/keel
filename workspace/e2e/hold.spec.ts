import { expect, test, type Page } from '@playwright/test';
import { ECHO, appIsBuilt, startBoard, type RunningBoard } from './board-server';

/**
 * The agent holds while the owner draws, against the real board server and the stand-in agent:
 * one box alone wakes nobody, after 10 s with no movement the page points the owner at "Answer
 * now", a mouse move takes that away, and "Answer now" brings one answer.
 *
 * Needs a build first: `npm run build` from workspace/. `npm run e2e` does both.
 */

let board: RunningBoard | undefined;

test.beforeAll(async () => {
  expect(appIsBuilt(), 'build first: npm run build, from workspace/').toBe(true);
  board = await startBoard({ link: `script:${ECHO}` });
});

test.afterAll(async () => {
  test.setTimeout(60_000);
  await board?.stop();
});

type XY = [number, number];

async function drawBox(page: Page, from: XY, to: XY, label: string) {
  await page.keyboard.press('b');
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / 10, from[1] + ((to[1] - from[1]) * i) / 10);
  await page.mouse.up();
  await page.keyboard.type(label);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
}

const ASK = "Press Answer now for the agent's read of your drawing, or write a note.";

test('one box alone holds the agent; after 10 s still the page points at Answer now, and Answer now brings one answer', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto(board!.url);
  const pill = page.getByTestId('presence');
  const hint = page.getByTestId('hint');
  const pointing = hint.filter({ hasText: ASK });
  const answer = page.getByTestId('presence-answer');
  await expect(pill).toHaveAttribute('data-state', 'listening');
  await expect(page.getByTestId('presence-hold')).toBeVisible();

  await drawBox(page, [500, 400], [640, 480], 'the queue');
  await expect(page.locator('.layer [data-kind="box"]')).toHaveCount(1);
  await expect(pill).toHaveAttribute('data-hold', 'drawing');
  await expect(pill).toContainText('holding while you draw · 1 mark waits');

  // Well past the 1.5 s a remark waits: still no answer, and no pointer yet.
  await page.waitForTimeout(4000);
  await expect(page.locator('.layer [data-item][data-kind="picture"]')).toHaveCount(0);
  await expect(pointing).toHaveCount(0);
  await expect(answer).not.toHaveAttribute('data-ask', /.*/);

  // Ten seconds from the owner's last key: the hint line and the button point at Answer now.
  await expect(hint).toHaveText(ASK, { timeout: 10_000 });
  await expect(answer).toHaveAttribute('data-ask', 'true');
  await expect(page.locator('.layer [data-item][data-kind="picture"]')).toHaveCount(0);

  await page.mouse.move(300, 300);
  await expect(pointing).toHaveCount(0);
  await expect(answer).not.toHaveAttribute('data-ask', /.*/);

  await answer.click();
  await expect(pill).not.toHaveAttribute('data-hold', /.+/);
  await expect(page.locator('.layer [data-item][data-kind="picture"]')).toHaveCount(1, { timeout: 10_000 });
  await expect(page.getByTestId('open-count')).toHaveText('0 open marks');
  // One wake: no second card comes.
  await page.waitForTimeout(2500);
  await expect(page.locator('.layer [data-item][data-kind="picture"]')).toHaveCount(1);
});
