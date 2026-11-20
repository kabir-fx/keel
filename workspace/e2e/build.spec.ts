import { expect, test, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILDER, PLANNER, SHOTS, appIsBuilt, startBoard, type RunningBoard } from './board-server';

/**
 * Screens 5, 6 and 7 joined, on the real board server: a stand-in agent that draws the idea as a
 * model and reads it back as a blueprint, and a scripted builder that commits each part in its
 * own git worktree of a temporary repository, so every commit the board shows is real.
 *
 * A note in, a model out. Lasso it, Solidify, the blueprint. "Build this", and the same model
 * fills in one part at a time while the feed says what happened. The chapter is built, and the
 * Story shows it.
 *
 * Needs a build first: `npm run build` from workspace/. `npm run e2e` does both.
 */

let board: RunningBoard | undefined;

test.beforeAll(async () => {
  test.skip(!appIsBuilt(), 'build first: npm run build, from workspace/');
  board = await startBoard({ link: `script:${PLANNER}`, builder: BUILDER, git: true, linkOptions: { 'builder-step-ms': '1100' } });
});

test.afterAll(async () => {
  test.setTimeout(60_000);
  await board?.stop();
});

type Ev = { id: string; type: string; by: string; part?: string; state?: string; commit?: string; item?: { id: string; kind: string } };
const readLog = (repo: string): Ev[] =>
  readFileSync(join(repo, '.keel/board/log.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Ev);

const settle = async (page: Page) => {
  await expect(page.locator('[data-measure]')).toHaveCount(0);
  await page.waitForTimeout(400);
};

/** Fit the whole board in view, as the owner would with "1". */
const fitAll = async (page: Page) => {
  await page.keyboard.press('Escape');
  await page.keyboard.press('1');
  await page.waitForTimeout(300);
};

test('solidify, the blueprint, "Build this": the parts fill in one by one, the chapter is built, the Story shows it', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const { url, repo } = board!;
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
  await page.screenshot({ path: `${SHOTS}/live-build-1-blueprint.png` });
  await blueprint.getByRole('button', { name: 'Build this' }).click();

  // The build: the panel shows, and the parts fill in one by one, each from a real commit.
  const watch = page.getByTestId('watch');
  await expect(watch).toBeVisible();
  await expect(page.getByTestId('chapter-state')).toHaveText('building');
  const builtCount = () => page.locator('[data-testid="track"] > li[data-state="built"]').count();
  await expect(page.locator('[data-testid="track"] > li')).toHaveCount(4);
  const seen: number[] = [];
  let shot = false;
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const n = await builtCount();
    if (seen[seen.length - 1] !== n) seen.push(n);
    if (n === 2 && !shot) {
      shot = true;
      await page.screenshot({ path: `${SHOTS}/live-build-2-building.png` });
    }
    if (n === 4) break;
    await page.waitForTimeout(80);
  }
  expect(seen).toEqual(seen.slice().sort((x, y) => x - y));
  expect(seen).toEqual(expect.arrayContaining([1, 2, 3, 4]));
  // The tab followed the build.
  await expect(watch).toHaveAttribute('data-state', 'built');
  await expect(page.getByTestId('chapter-state')).toHaveText('built');
  await expect(page.getByTestId('watch-where')).toHaveText('4 of 4 built');

  // The feed holds the four commits, and each is a real commit in the repository.
  const commits = await page.locator('[data-testid="feed"] .feed__line--commit .feed__commit').allTextContents();
  expect(commits).toHaveLength(4);
  for (const c of commits) expect(spawnSync('git', ['cat-file', '-e', `${c}^{commit}`], { cwd: repo }).status).toBe(0);
  const log = readLog(repo);
  const builtEvents = log.filter((e) => e.type === 'part.state' && e.state === 'built');
  expect(builtEvents.map((e) => e.by)).toEqual(['system', 'system', 'system', 'system']);
  expect(builtEvents.map((e) => e.commit)).toEqual(commits);
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/live-build-3-built.png` });

  // The Story shows the chapter built, and the whole pipeline filled in.
  await page.getByRole('button', { name: 'Story' }).click();
  const chapter = page.getByTestId('story').locator('article.chapter').first();
  await expect(chapter).toHaveAttribute('data-state', 'built');
  await expect(chapter.getByTestId('chapter-progress')).toContainText('4 of 4 parts built');
  await expect(page.getByTestId('progress-chapters')).toContainText('1 of 1 idea built');
  await expect(page.getByTestId('progress-parts')).toContainText('4 of 4 parts built');
  await page.screenshot({ path: `${SHOTS}/live-build-4-story.png` });
  expect(errors).toEqual([]);
});
