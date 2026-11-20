import { expect, test } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { standIn, upTo } from './stand-in';

/**
 * The page and the owner's token, on the system Chrome, with a stand-in server on the page's
 * websocket and HTTP calls. The token comes once in the address, is kept by this page's own
 * origin (a board's server has its own port), and goes with every call and the websocket. No
 * cookie is ever used: a cookie for 127.0.0.1 would go to every local port.
 */

const SHOTS = fileURLToPath(new URL('./shots', import.meta.url));
const DIST = fileURLToPath(new URL('../app/dist', import.meta.url));

test('with no token, the page says how to open the board, and opens no connection', async ({ page }) => {
  const server = await standIn(page, upTo('e11'));
  await page.goto('/');
  await expect(page.getByTestId('problem')).toContainText('Open the board from your terminal: keel-board open');
  await page.waitForTimeout(300);
  expect(server.sockets).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/security-no-token.png` });
});

test('the address holds a code that works once: the page trades it for the token, and the code is gone from the address', async ({ page }) => {
  const server = await standIn(page, upTo('e11'), { codes: { 'code-1': 'tok-run-1' } });
  await page.goto('/?code=code-1');
  await expect(page.getByTestId('board-name')).toContainText('uLLM');
  expect(page.url()).not.toContain('code');
  // The trade carried the code and nothing else: no token, no cookie.
  const trade = server.calls.find((c) => new URL(c.url).pathname === '/api/session')!;
  expect(trade.method).toBe('POST');
  expect(trade.headers.authorization).toBeUndefined();
  expect(trade.headers.cookie).toBeUndefined();
  // The token it got goes with the websocket, and is kept for a reload.
  expect(await page.evaluate(() => localStorage.getItem('keel.board.token'))).toBe('tok-run-1');
  expect(server.sockets.at(-1)).toContain('/ws?token=tok-run-1');
  // The same address again, in the same browser: the code is spent, the kept token still opens the board.
  await page.goto('/?code=code-1');
  await expect(page.getByTestId('board-name')).toContainText('uLLM');
  expect(page.url()).not.toContain('code');
});

test('a spent code in a browser that holds no token says how to get a new address', async ({ page }) => {
  const server = await standIn(page, upTo('e11'));
  await page.goto('/?code=old-code');
  await expect(page.getByTestId('problem')).toContainText('This address was used already, or is more than five minutes old');
  await expect(page.getByTestId('problem')).toContainText('keel-board link');
  expect(page.url()).not.toContain('code');
  expect(server.sockets).toEqual([]);
});

test('the token comes once in the address, stays with this origin, and goes with every call; a bare reload opens the board; no cookie', async ({ page }) => {
  const server = await standIn(page, upTo('e11'));
  await page.goto('/?token=tok-123');
  await expect(page.getByTestId('board-name')).toContainText('uLLM');
  // Out of the address bar, into this origin's own storage.
  expect(page.url()).not.toContain('token');
  expect(await page.evaluate(() => localStorage.getItem('keel.board.token'))).toBe('tok-123');
  expect(server.sockets.at(-1)).toContain('/ws?token=tok-123');
  // A bookmark of the bare address, in the same browser.
  await page.goto('/');
  await expect(page.getByTestId('board-name')).toContainText('uLLM');
  await expect(page.getByTestId('connection')).toHaveCount(0);
  expect(server.sockets).toHaveLength(2);
  expect(server.sockets[1]).toContain('/ws?token=tok-123');
  // Nothing set a cookie, and no call to the board sent one.
  expect(await page.context().cookies()).toEqual([]);
  for (const c of server.calls) {
    expect(c.headers.cookie).toBeUndefined();
    expect(c.headers.authorization).toBe('Bearer tok-123');
  }
});

test('a dropped-in file opens by reading it with the token, never by a bare address', async ({ page }) => {
  const server = await standIn(page, upTo('e11'), { files: { 'AGENT_ROADMAP.md': '# The roadmap\n' } });
  await page.goto('/?token=tok-9');
  await expect(page.locator('[data-measure]')).toHaveCount(0);
  await page.waitForTimeout(400);
  const open = page.locator('[data-item="drop-roadmap"]').getByRole('button', { name: 'Open' });
  // A button, not a link: no address to copy, and no token in one.
  expect(await page.locator('[data-item="drop-roadmap"] a').count()).toBe(0);
  const popup = page.waitForEvent('popup');
  await open.click();
  const tab = await popup;
  await expect.poll(() => tab.url()).toMatch(/^blob:/);
  await expect(tab.locator('body')).toContainText('# The roadmap');
  const read = server.calls.find((c) => c.url.endsWith('/api/assets/AGENT_ROADMAP.md'))!;
  expect(read.headers.authorization).toBe('Bearer tok-9');
  expect(read.headers.cookie).toBeUndefined();
});

test('a token the server refuses is forgotten, and the page says how to open the board again', async ({ page }) => {
  await page.routeWebSocket(/\/ws/, (ws) => ws.close());
  await page.route('**/api/board', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"A token is needed."}' }));
  await page.goto('/?token=stale');
  await expect(page.getByTestId('connection')).toHaveAttribute('data-state', 'refused');
  expect(await page.evaluate(() => localStorage.getItem('keel.board.token'))).toBeNull();
  await page.goto('/');
  await expect(page.getByTestId('problem')).toContainText('keel-board open');
});

test('the built page ships no source maps', () => {
  const files = readdirSync(join(DIST, 'assets'));
  expect(files.filter((f) => f.endsWith('.map'))).toEqual([]);
  for (const f of files.filter((x) => x.endsWith('.js'))) expect(readFileSync(join(DIST, 'assets', f), 'utf8')).not.toContain('sourceMappingURL');
});
