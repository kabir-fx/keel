import { expect, test } from '@playwright/test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOSTED, SHOTS, appIsBuilt, startBoard, type RunningBoard } from './board-server';

/**
 * The first page, joined: the real board server with the agent that ships with keel, the built
 * app, and a stand-in `claude` that is installed and signed out. The setup page stands before
 * the board, a press starts the sign-in, and the board opens by itself once Claude Code says it
 * is signed in. The stand-in takes a file coming to be for the owner's approval in the browser.
 *
 * Needs a build first: `npm run build` from workspace/. `npm run e2e` does both.
 */

const FAKE = fileURLToPath(new URL('../plugin/test/fake-claude-auth.mjs', import.meta.url));

let tmp: string;
let auth: string;
let board: RunningBoard | undefined;

async function start(bin: string): Promise<RunningBoard> {
  board = await startBoard({ link: HOSTED, linkOptions: { bin }, env: { FAKE_CLAUDE_AUTH: auth } });
  return board;
}

test.beforeEach(() => {
  test.skip(!appIsBuilt() || !existsSync(HOSTED), 'build first: npm run build, from workspace/');
  tmp = mkdtempSync(join(tmpdir(), 'keel-setup-e2e-'));
  auth = join(tmp, 'signed-in');
  writeFileSync(join(tmp, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
});

test.afterEach(async () => {
  test.setTimeout(60_000);
  await board?.stop();
  board = undefined;
  rmSync(tmp, { recursive: true, force: true });
});

test('signed out: the setup page signs in, then the board opens by itself', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  const b = await start(join(tmp, 'claude'));
  expect(b.output()).toContain('keel-board: Claude Code is not signed in. The page that opens signs you in.');

  await page.goto(b.url);
  await expect(page.getByTestId('setup')).toBeVisible();
  await expect(page.getByTestId('board')).toHaveCount(0);
  await expect(page.getByTestId('setup-install')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('setup-sign-in')).toHaveAttribute('data-state', 'now');
  await expect(page.getByTestId('setup-git')).toHaveAttribute('data-state', 'done');
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${SHOTS}/setup-signed-out.png` });

  await page.getByTestId('setup-sign-in-go').click();
  await expect(page.getByTestId('setup-waiting')).toBeVisible();
  await page.getByText('No tab opened, or the page shows a code').click();
  await expect(page.getByTestId('setup-sign-in-link')).toHaveAttribute('href', 'https://claude.ai/oauth/authorize?code=true&client_id=fake');
  await page.screenshot({ path: `${SHOTS}/setup-signing-in.png` });

  // A wrong code ends that sign-in, and the page says why in the words of Claude Code.
  await page.getByTestId('setup-code').fill('wrong');
  await page.getByTestId('setup-code-go').click();
  await expect(page.getByTestId('setup-note')).toContainText("That code wasn't accepted");

  // The owner signs in again and approves it in the other tab.
  await page.getByTestId('setup-sign-in-go').click();
  await expect(page.getByTestId('setup-waiting')).toBeVisible();
  writeFileSync(`${auth}.approve`, '');
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('setup')).toHaveCount(0);

  // Signed in, a new page goes straight to the board.
  await page.goto(b.url);
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('setup')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('not installed: the setup page offers the install, and the board can be opened without it', async ({ page }) => {
  const b = await start(join(tmp, 'no-claude-here'));
  expect(b.output()).toContain('keel-board: Claude Code is not installed. The page that opens installs it and signs you in.');

  await page.goto(b.url);
  await expect(page.getByTestId('setup-install')).toHaveAttribute('data-state', 'now');
  await expect(page.getByTestId('setup-sign-in')).toHaveAttribute('data-state', 'later');
  await expect(page.getByTestId('setup-install-go')).toHaveText('Install Claude Code');
  await expect(page.getByTestId('setup-sign-in-go')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${SHOTS}/setup-not-installed.png` });

  await page.getByTestId('setup-skip').click();
  await expect(page.getByTestId('board')).toBeVisible();
  // This tab does not ask again.
  await page.reload();
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('setup')).toHaveCount(0);
});
