import { expect, test, type ConsoleMessage } from '@playwright/test';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { BUILDER, PLANNER, SHOTS, appIsBuilt, startBoard, type RunningBoard } from './board-server';
import { logPath, settle, startBuild, watchErrors } from './build-flow';

/**
 * What a finished build shows, on the real board server. The scripted builder writes a small
 * page of its own (a heading, a count, a button, a script and a style sheet) into its private
 * folder and hands it over when the run is done. The server serves it from a port of its own,
 * and the build panel shows "Try it", which opens the try room with the page framed in it and a
 * link that opens it in a tab of its own.
 *
 * The page is code a model wrote, so it must never get near the owner's token: it is on another
 * origin, its tab has no way back to the board's tab, only the board's origin may frame it, and
 * the board refuses anything it sends. The address holds a key, and is never written into the log.
 *
 * The agent and the system are never told the address either. That is not reachable from a
 * browser without their tokens, so it is left to the server's unit tests.
 *
 * Needs a build first: `npm run build` from workspace/. `npm run e2e` does both.
 */

/** The feed line the server posts when it does not open a browser itself (`--no-browser`). */
const SHOW_WAITS = 'You can look at it: press "Try it" on the build panel.';
/** Where the page keeps the owner's token (`app/src/source.ts`). */
const TOKEN_KEY = 'keel.board.token';

let board: RunningBoard | undefined;

test.beforeAll(async () => {
  test.skip(!appIsBuilt(), 'build first: npm run build, from workspace/');
  board = await startBoard({ link: `script:${PLANNER}`, builder: BUILDER, git: true, linkOptions: { 'builder-step-ms': '300', 'builder-show': '1' } });
});

test.afterAll(async () => {
  test.setTimeout(60_000);
  await board?.stop();
});

/**
 * A GET sent exactly as written. A URL parser folds "%2e%2e" into a step up before it sends,
 * so the server would never see it.
 */
const rawGet = (origin: string, path: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const { hostname, port } = new URL(origin);
    const req = http.request({ host: hostname, port, path, method: 'GET' }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });

test('a finished build shows its page: "Try it" frames it, its link opens it in a tab of its own, on its own origin, and the board refuses it', async ({ page, context, request }) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  const { url, repo } = board!;
  await startBuild(page, url);
  const boardOrigin = new URL(page.url()).origin;
  const watch = page.getByTestId('watch');
  const tryIt = page.getByTestId('watch-try');
  const room = page.getByTestId('try-room');
  const seeIt = page.getByTestId('try-tab');

  await test.step('nothing to see while the parts are building', async () => {
    await expect(watch).toBeVisible();
    await expect(page.getByTestId('chapter-state')).toHaveText('building');
    const building = page.locator('[data-testid="track"] > li[data-state="building"]');
    await expect(building, 'a part is building').toHaveCount(1, { timeout: 10_000 });
    await expect(tryIt, 'no "Try it" while the chapter is still building').toHaveCount(0);
    // Every look until the chapter is built finds no link.
    const deadline = Date.now() + 40_000;
    let looks = 0;
    while (Date.now() < deadline && (await page.getByTestId('chapter-state').textContent()) !== 'built') {
      expect(await tryIt.count(), 'no "Try it" before the chapter is built').toBe(0);
      looks++;
      await page.waitForTimeout(50);
    }
    expect(looks, 'the panel was looked at while the parts were building').toBeGreaterThan(0);
    await expect(watch).toHaveAttribute('data-state', 'built');
    await expect(page.getByTestId('chapter-state')).toHaveText('built');
  });

  // The link: a new tab, with no way back, to a port that is not the board's.
  await expect(tryIt, '"Try it" shows once the chapter is built').toBeVisible({ timeout: 10_000 });
  await tryIt.click();
  await expect(room).toHaveAttribute('data-kind', 'page');
  await expect(seeIt).toHaveText('Open in a new tab');
  await expect(seeIt, 'it opens in a tab of its own').toHaveAttribute('target', '_blank');
  const rel = ((await seeIt.getAttribute('rel')) ?? '').split(/\s+/);
  expect(rel, 'the shown tab gets no handle on the board, and no referrer').toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
  const href = (await seeIt.getAttribute('href'))!;
  const m = href.match(/^http:\/\/127\.0\.0\.1:(\d+)\/([^/]+)\/([^/]+)\/index\.html$/);
  expect(m, `the address is http://127.0.0.1:<port>/<key>/<chapter>/index.html, not ${href}`).not.toBeNull();
  const [, port, key, chapter] = m!;
  const showOrigin = `http://127.0.0.1:${port}`;
  expect(showOrigin, "the page is served on a port of its own, never the board's").not.toBe(boardOrigin);
  const showBase = `${showOrigin}/${key}/${chapter}`;

  await test.step('the feed says where to look, and the log never holds the address', async () => {
    await page.keyboard.press('Escape');
    await expect(room).toHaveCount(0);
    const line = page.getByTestId('feed').locator('.feed__line', { hasText: SHOW_WAITS });
    await expect(line, 'the feed says to press "Try it"').toHaveCount(1);
    await expect(line, 'an update from the build, not a commit or a problem').toHaveAttribute('data-kind', 'update');
    await expect(line.locator('.feed__text'), 'the line is just that, with no address').toHaveText(SHOW_WAITS);
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/live-show-1-panel.png` });
    const log = readFileSync(logPath(repo), 'utf8');
    expect(log, 'the log holds the feed line').toContain('press \\"Try it\\" on the build panel');
    // The port alone is a short number that a time or an id can hold by chance: look for it as an address.
    for (const host of ['127.0.0.1', 'localhost']) expect(log.includes(`${host}:${port}`), "the show's address is not in the log").toBe(false);
    expect(log.includes(key!), "the show's key is not in the log").toBe(false);
  });

  // The shown tab. Its console errors are kept apart: the refused calls below make some on purpose.
  const shownErrors: Array<{ text: string; url: string }> = [];
  const keep = (m: ConsoleMessage) => m.type() === 'error' && shownErrors.push({ text: m.text(), url: m.location().url });
  await tryIt.click();
  const [shown] = await Promise.all([context.waitForEvent('page'), seeIt.click()]);
  shown.on('console', keep);
  shown.on('pageerror', (e) => shownErrors.push({ text: e.message, url: '' }));

  await test.step('the shown page opens in a new tab and works as it would by hand', async () => {
    await shown.waitForLoadState();
    expect(shown.url(), 'the new tab is the shown page').toBe(href);
    await expect(shown.getByRole('heading', { name: 'The engine is built' })).toBeVisible();
    await expect(shown.locator('html'), 'its module script loaded from a relative address').toHaveAttribute('data-ready', '1');
    await expect(shown.locator('html'), 'it has no handle on the board tab').toHaveAttribute('data-opener', 'no');
    const color = await shown.getByRole('heading').evaluate((h) => getComputedStyle(h).color);
    expect(color, 'its style sheet loaded').toBe('rgb(32, 64, 128)');
    const count = shown.getByTestId('count');
    await expect(count).toHaveText('0');
    await shown.getByRole('button', { name: 'Send a request' }).click();
    await expect(count, 'the button works').toHaveText('1');
    await shown.screenshot({ path: `${SHOTS}/live-show-2-page.png` });
    expect(await shown.evaluate(() => localStorage.length), 'the shown origin holds nothing: no token').toBe(0);
    expect(new URL(page.url()).origin, 'the board tab stayed on the board').toBe(boardOrigin);
    await expect(page.getByTestId('board')).toBeVisible();
    // The same page, framed in the try room on the board's tab.
    await expect(page.frameLocator('[data-testid="try-frame"]').getByRole('heading', { name: 'The engine is built' })).toBeVisible();
    await expect(page.getByTestId('try-frame')).toHaveAttribute('src', href);
    expect(shownErrors, 'the shown page loads with no error').toEqual([]);
  });

  await test.step('the board refuses what the shown origin sends, even with the token', async () => {
    const token = await page.evaluate((k) => localStorage.getItem(k), TOKEN_KEY);
    expect(token, 'the board tab holds the owner token').toBeTruthy();
    const auth = { authorization: `Bearer ${token}` };

    // Over HTTP, with the token: refused from the shown origin, answered with no origin.
    const fromShow = await request.get(`${boardOrigin}/api/board`, { headers: { ...auth, origin: showOrigin } });
    expect(fromShow.status(), 'a request from the shown origin is refused').toBe(403);
    const plain = await request.get(`${boardOrigin}/api/board`, { headers: auth });
    expect(plain.status(), 'the same request with no origin is answered: the token was good').toBe(200);

    // From inside the shown tab: the browser sends its origin, and the call fails.
    const fetched = await shown.evaluate(
      async ({ at, t }) => {
        try {
          const res = await fetch(`${at}/api/board`, { headers: { authorization: `Bearer ${t}` } });
          return res.ok ? 'ok' : `status ${res.status}`;
        } catch {
          return 'rejected';
        }
      },
      { at: boardOrigin, t: token! },
    );
    expect(fetched, "the shown page cannot read the board, even with the owner's token").not.toBe('ok');

    // Over the websocket too: the same token opens a socket from the board, and not from the shown page.
    const wsUrl = `${boardOrigin.replace('http:', 'ws:')}/ws?token=${encodeURIComponent(token!)}`;
    const connect = (u: string) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(u);
        ws.onopen = () => {
          ws.close();
          resolve('open');
        };
        ws.onerror = () => resolve('refused');
        setTimeout(() => resolve('no answer'), 5_000);
      });
    expect(await page.evaluate(connect, wsUrl), 'the token opens a socket from the board').toBe('open');
    expect(await shown.evaluate(connect, wsUrl), 'the shown page cannot open a socket to the board').toBe('refused');

    // The only errors on the shown tab are the refused fetch (a CORS refusal, and its failed
    // load) and the refused socket, all to the board's address. Anything else is a fault.
    // The socket's error names its address, token and all: the token is masked before any report.
    const others = shownErrors.filter((e) => !e.text.includes(boardOrigin) && !e.url.startsWith(boardOrigin) && !e.text.includes(boardOrigin.replace('http:', 'ws:')));
    expect(others.map((e) => `${e.text} (${e.url})`.split(token!).join('<token>')), 'no error on the shown tab but the refused calls').toEqual([]);
  });

  await test.step('a wrong key or a hidden file finds nothing', async () => {
    const good = await request.get(href);
    expect(good.status(), 'the good address answers').toBe(200);
    expect(good.headers()['x-content-type-options'], 'nothing is sniffed').toBe('nosniff');
    expect(good.headers()['x-frame-options'], 'framing is said by the policy alone').toBeUndefined();
    // The board's own origin may frame it, by either name of this machine, and nothing else. The owner's app runs as it would by hand.
    const boardPort = new URL(boardOrigin).port;
    expect(good.headers()['content-security-policy']).toBe(`frame-ancestors http://127.0.0.1:${boardPort} http://localhost:${boardPort}`);

    const k = key!;
    const wrongKey = (k[0] === 'A' ? 'B' : 'A') + k.slice(1);
    const wrong = await request.get(`${showOrigin}/${wrongKey}/${chapter}/index.html`);
    expect(wrong.status(), 'a key off by one character finds nothing').toBe(404);
    expect((await request.get(`${showBase}/.git/config`)).status(), 'a hidden folder is never served').toBe(404);
    expect((await request.get(`${showBase}/%2e%2e/board.json`)).status(), 'a step up finds nothing').toBe(404);
    expect(await rawGet(showOrigin, `/${key}/${chapter}/%2e%2e/board.json`), 'a step up, sent as written, finds nothing').toBe(404);
  });

  await test.step('"Try it" is still there after a reload, and when the panel is folded', async () => {
    await page.reload();
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(tryIt, '"Try it" is back after a reload').toBeVisible({ timeout: 10_000 });
    await tryIt.click();
    await expect(seeIt, 'to the same address').toHaveAttribute('href', href);
    await page.getByTestId('try-close').click();
    await expect(room).toHaveCount(0);
    await page.getByRole('button', { name: 'Fold the build away' }).click();
    await expect(watch).toHaveClass(/watch--folded/);
    await expect(tryIt, '"Try it" shows on the folded panel').toBeVisible();
    await tryIt.click();
    await expect(seeIt).toHaveAttribute('href', href);
  });

  await shown.close();
  expect(errors, 'no error on the board tab').toEqual([]);
});
