import { expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The way from a note to a running build, on the real board server with the stand-in planner
 * and the scripted builder: a note in, a model out, lasso both, Solidify, the blueprint, and
 * "Build this". Shared by the specs that need a build.
 */

export type Ev = { id: string; type: string; by: string; part?: string; state?: string; commit?: string; item?: { id: string; kind: string } };

/** The board's log, one event per line. */
export const logPath = (repo: string): string => join(repo, '.keel/board/log.jsonl');

export const readLog = (repo: string): Ev[] =>
  readFileSync(logPath(repo), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Ev);

/** Wait until nothing is being measured, and the board has stood still a moment. */
export const settle = async (page: Page): Promise<void> => {
  await expect(page.locator('[data-measure]')).toHaveCount(0);
  await page.waitForTimeout(400);
};

/** Fit the whole board in view, as the owner would with "1". */
export const fitAll = async (page: Page): Promise<void> => {
  await page.keyboard.press('Escape');
  await page.keyboard.press('1');
  await page.waitForTimeout(300);
};

/** Collect page errors and console errors on a tab. The list fills as the test goes. */
export const watchErrors = (page: Page): string[] => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return errors;
};

/**
 * Open the board, write a note, wait for the model, lasso it with the note, Solidify, wait for
 * the blueprint, and press "Build this". `blueprintShot` is where to save a picture of the
 * blueprint just before the press.
 */
export async function startBuild(page: Page, url: string, opts: { blueprintShot?: string } = {}): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('presence')).toHaveAttribute('data-state', 'listening');
  await page.evaluate(() => document.fonts.ready);

  // A note in: the agent draws the idea as a model.
  await page.getByRole('button', { name: 'Write a note' }).click();
  await page.mouse.click(220, 260);
  await page.keyboard.type('One engine that takes many requests at once');
  await page.keyboard.press('Enter');
  const model = page.locator('[data-item^="model-"]');
  await expect(model).toBeVisible({ timeout: 15_000 });
  await settle(page);
  await fitAll(page);

  // Lasso the model and the note, and Solidify.
  const note = page.locator('[data-item][data-kind="note"]').first();
  const [a, b] = [(await note.boundingBox())!, (await model.boundingBox())!];
  const [l, t] = [Math.min(a.x, b.x) - 24, Math.min(a.y, b.y) - 24];
  const [r, btm] = [Math.max(a.x + a.width, b.x + b.width) + 24, Math.max(a.y + a.height, b.y + b.height) + 24];
  await page.keyboard.press('l');
  const loop: Array<[number, number]> = [];
  for (let i = 0; i <= 10; i++) loop.push([l + ((r - l) * i) / 10, t]);
  for (let i = 1; i <= 10; i++) loop.push([r, t + ((btm - t) * i) / 10]);
  for (let i = 1; i <= 10; i++) loop.push([r - ((r - l) * i) / 10, btm]);
  for (let i = 1; i <= 9; i++) loop.push([l, btm - ((btm - t) * i) / 10]);
  await page.mouse.move(loop[0]![0], loop[0]![1]);
  await page.mouse.down();
  for (const [x, y] of loop.slice(1)) await page.mouse.move(x, y);
  await page.mouse.up();
  const solidify = page.locator('[data-tool="solidify"]');
  await expect(solidify).toBeEnabled();
  await solidify.click();
  await expect(page.getByTestId('chapter-state')).toHaveText('solid');

  // The agent reads it back: the blueprint, with "Build this".
  const blueprint = page.locator('[data-item^="blueprint-"]');
  await expect(blueprint).toBeAttached({ timeout: 15_000 });
  await settle(page);
  await fitAll(page);
  if (opts.blueprintShot) await page.screenshot({ path: opts.blueprintShot });
  await blueprint.getByRole('button', { name: 'Build this' }).click();
}
