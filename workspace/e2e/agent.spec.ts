import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOSTED, SHOTS, appIsBuilt, startBoard, type RunningBoard } from './board-server';

/**
 * The same proof with the real agent: the board server hosts a headless Claude Code process,
 * and it answers a typed note with a card. This spends a little of the owner's plan, so it
 * runs only when asked: `KEEL_LIVE_AGENT=1 npx playwright test agent.spec.ts`.
 */

const LIVE = process.env.KEEL_LIVE_AGENT === '1';
let board: RunningBoard | undefined;

test.beforeAll(async () => {
  test.skip(!LIVE, 'set KEEL_LIVE_AGENT=1 to run with the real agent');
  test.skip(!appIsBuilt() || !existsSync(HOSTED), 'build first: npm run build, from workspace/');
  board = await startBoard({
    link: HOSTED,
    name: 'daily-notes',
    files: {
      'README.md': '# daily-notes\n\nOne markdown file per day in notes/, named by date. Nothing reads them yet.\n',
      'notes/2026-11-16.md': '- met Sam about the launch\n- fixed the login bug\n- idea: weekly digest?\n',
    },
  });
});

test.afterAll(async () => {
  test.setTimeout(60_000);
  await board?.stop();
});

test('the real agent answers a typed note with a card that says how it read it', async ({ page }) => {
  test.setTimeout(180_000);
  const { url, repo } = board!;
  await page.goto(url);
  await expect(page.getByTestId('board')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  await page.getByRole('button', { name: 'Write a note' }).click();
  await page.mouse.click(260, 300);
  await page.keyboard.type('I want a short summary of my week every Friday, made from my daily notes');
  const t0 = Date.now();
  await page.keyboard.press('Enter');
  await expect.poll(async () => Number(await page.getByTestId('open-count').getAttribute('data-n'))).toBe(1);

  // The agent's card arrives, and the mark is no longer open.
  const card = page.locator('[data-item] .kp');
  await expect(card.first()).toBeVisible({ timeout: 120_000 });
  const seconds = (Date.now() - t0) / 1000;
  await expect.poll(async () => Number(await page.getByTestId('open-count').getAttribute('data-n')), { timeout: 60_000 }).toBe(0);
  await expect(page.locator('[data-measure]')).toHaveCount(0);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/agent-real-card.png` });

  const log = readFileSync(join(repo, '.keel/board/log.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { type: string; by: string; item?: { id: string; kind: string; answers?: string[]; picture?: { kind: string; title?: string } } });
  const note = log.find((e) => e.type === 'item.add' && e.by === 'owner')!;
  const answers = log.filter((e) => e.type === 'item.add' && e.by === 'agent');
  expect(answers.length).toBeGreaterThan(0);
  expect(answers.some((e) => e.item!.answers?.includes(note.item!.id))).toBe(true);
  console.log(`the card arrived ${seconds.toFixed(1)} s after the note: ${answers.map((e) => `${e.item!.picture!.kind} "${e.item!.picture!.title}"`).join(', ')}`);
});
