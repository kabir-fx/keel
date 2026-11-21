import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { BUILDER, PLANNER, SHOTS, appIsBuilt, startBoard, type RunningBoard } from './board-server';
import { readLog, settle, startBuild, watchErrors } from './build-flow';

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

test('solidify, the blueprint, "Build this": the parts fill in one by one, the chapter is built, the Story shows it', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  const { url, repo } = board!;
  await startBuild(page, url, { blueprintShot: `${SHOTS}/live-build-1-blueprint.png` });

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

  // The Story shows the canvas with its idea built, and the whole pipeline filled in.
  await page.getByRole('button', { name: 'Story' }).click();
  const chapter = page.getByTestId('story').locator('article[data-canvas]');
  await expect(chapter).toHaveCount(1);
  await expect(chapter).toHaveAttribute('data-state', 'built');
  await expect(chapter.getByTestId('idea-state')).toHaveText('built: try it');
  await expect(page.getByTestId('progress-chapters')).toContainText('1 of 1 idea built');
  await expect(page.getByTestId('progress-parts')).toContainText('4 of 4 parts built');
  await page.screenshot({ path: `${SHOTS}/live-build-4-story.png` });
  expect(errors).toEqual([]);
});
