import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Screens 5, 6 and 7 of the storyboard, end to end on the system Chrome, from the golden
 * fixture: the blueprint waiting for the go, the build being watched (the track, the feed,
 * Pause), and the Story (every chapter, the whole pipeline, the progress, the next idea).
 * The fixture page announces each admitted event as a `keel:admit` window event.
 */

const SHOTS = fileURLToPath(new URL('./shots', import.meta.url));
mkdirSync(SHOTS, { recursive: true });

type Box = [number, number, number, number];
interface Admitted {
  id: string;
  type: string;
  by: string;
  chapter?: string;
  title?: string;
  item?: { id: string; kind: string; text?: string; box?: Box } | string;
}

async function open(page: Page, at: number) {
  await page.addInitScript(() => {
    const w = window as unknown as { __admitted: unknown[] };
    w.__admitted = [];
    window.addEventListener('keel:admit', (e) => w.__admitted.push((e as CustomEvent).detail));
  });
  await page.goto(`/?fixture=engine-loop&at=${at}`);
  await expect(page.getByTestId('board')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('[data-measure]')).toHaveCount(0);
  await page.waitForTimeout(600);
}

const admitted = (page: Page) => page.evaluate(() => (window as unknown as { __admitted: Admitted[] }).__admitted);

/** Is most of the element inside the part of the window the chrome leaves free? */
async function inView(page: Page, selector: string): Promise<boolean> {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) return false;
  const vp = page.viewportSize()!;
  const panel = (await page.getByTestId('watch').count()) > 0 ? await page.getByTestId('watch').boundingBox() : null;
  const right = panel ? panel.x : vp.width;
  const w = Math.max(0, Math.min(b.x + b.width, right) - Math.max(b.x, 0));
  const h = Math.max(0, Math.min(b.y + b.height, vp.height) - Math.max(b.y, 0));
  return (w * h) / (b.width * b.height) > 0.6;
}


test('checkpoint 5 opens on the board: the blueprint waits for the go, and no build shows yet', async ({ page }) => {
  await open(page, 5);
  await expect(page.locator('.app')).toHaveAttribute('data-mode', 'board');
  await expect(page.getByTestId('story')).toHaveCount(0);
  await expect(page.getByTestId('watch')).toHaveCount(0);
  await expect(page.getByTestId('chapter-state')).toHaveText('solid');
  await expect(page.getByTestId('presence')).toContainText('waiting for your go');
  await expect(page.locator('[data-item="blueprint"]').getByRole('button', { name: 'Build this' })).toBeVisible();
  for (const sel of ['[data-item="lasso"] .lasso-outline', '[data-item="blueprint"]', '[data-item="note-yes"]']) await expect(page.locator(sel)).toBeVisible();
  // Each chapter has a quiet label at its first item.
  await expect(page.locator('[data-chapter-label="engine-loop"]')).toContainText('The engine loop');
});

test('checkpoint 6 opens with the build: the track at part 3 of 7, the feed newest last, a line that says you can leave', async ({ page }) => {
  await open(page, 6);
  const watch = page.getByTestId('watch');
  await expect(watch).toBeVisible();
  await expect(watch).toHaveAttribute('data-state', 'running');
  await expect(page.getByTestId('watch-where')).toHaveText('part 3 of 7');
  await expect(page.getByTestId('chapter-state')).toHaveText('building');
  const states = await page.locator('[data-testid="track"] > li').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.state));
  expect(states).toEqual(['built', 'built', 'building', 'solid', 'solid', 'solid', 'solid']);
  await expect(page.locator('[data-testid="track"] > li[data-now]')).toContainText('3 Engine loop · now');
  // The feed: newest last, with the commit ids and the checks; a state change is quiet.
  const feed = page.getByTestId('feed');
  await expect(feed.locator('> li').last()).toContainText('Engine loop: the five things one turn does');
  await expect(feed.locator('.feed__line--commit .feed__commit').first()).toHaveText('658b4ec');
  await expect(feed.locator('.feed__line--commit').filter({ hasText: 'Scheduler is built' }).locator('.feed__check')).toHaveText('make check · passed');
  expect(await feed.locator('.feed__line--state').count()).toBeGreaterThan(3);
  await expect(page.getByTestId('watch-leave')).toContainText('You can leave.');
  // What the checkpoint shows is in view, clear of the panel.
  for (const id of ['pipe-build', 'choice', 'reply-one']) expect(await inView(page, `[data-item="${id}"]`)).toBe(true);
  // The tab says how far the build is.
  expect(await page.title()).toMatch(/^Building 2\/7 · The engine loop · /);
  await page.screenshot({ path: `${SHOTS}/watch-6.png` });
});

test('the server says what its build driver does on the websocket, and says it again to a page that reconnects; the page never polls for it', async ({ page }) => {
  // A stand-in board server on the page's websocket, at checkpoint 6: the build of the engine loop goes.
  const LOG = readFileSync(fileURLToPath(new URL('../protocol/fixtures/engine-loop/log.jsonl', import.meta.url)), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { id: string });
  const events = LOG.slice(0, LOG.findIndex((e) => e.id === 'e69') + 1);
  const build = (state: string, extra: Record<string, unknown> = {}) => ({ chapter: 'engine-loop', title: 'The engine loop', state, built: 2, total: 7, ...extra });
  const presence = { state: 'building', note: 'building part 3 of 7', since: '2026-11-17T13:00:00Z' };
  const sockets: Array<{ send: (m: string) => void; close: () => Promise<void> }> = [];
  await page.routeWebSocket(/\/ws/, (ws) => {
    sockets.push(ws);
    // The first time a build waits its turn; when the page comes back, it has stopped.
    const said = sockets.length === 1 ? build('queued') : build('stopped');
    ws.send(JSON.stringify({ t: 'init', name: 'uLLM', role: 'owner', events, presence, build: said }));
  });
  // The board's info answers, as the server would; the test counts every look at it.
  const asked: string[] = [];
  await page.route('**/api/board', (route) => {
    asked.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ name: 'uLLM', seq: events.length, role: 'owner', open: 0, presence }) });
  });
  await page.goto('/?token=owner-token');
  const watch = page.getByTestId('watch');
  await expect(watch).toHaveAttribute('data-state', 'queued');
  await expect(page.getByTestId('watch-status')).toContainText('Waiting its turn');

  // The driver starts: the panel says so at once, with the part it is on.
  sockets[0]!.send(JSON.stringify({ t: 'build', build: build('running', { part: 'Engine loop' }) }));
  await expect(watch).toHaveAttribute('data-state', 'running');
  await expect(page.getByTestId('watch-status')).toHaveText('Building Engine loop now.');
  await page.screenshot({ path: `${SHOTS}/watch-build-message.png` });
  // No build goes: the board's own state says what it can.
  sockets[0]!.send(JSON.stringify({ t: 'build', build: null }));
  await expect(page.getByTestId('watch-status')).toHaveText('Building now.');
  // The board's info was asked once, on init, for what came from outside (it is not on the
  // socket); nothing polled it while the socket was open.
  await page.waitForTimeout(1500);
  expect(asked).toHaveLength(1);

  // The socket drops; the page comes back by itself, and init says the build stopped.
  await sockets[0]!.close();
  await expect.poll(() => sockets.length, { timeout: 10_000 }).toBe(2);
  await expect(watch).toHaveAttribute('data-state', 'stopped');
  await expect(page.getByTestId('watch-status')).toContainText('Stopped before it finished.');
  // The drop asked the board who the page is, at most once, and the new init asked once for
  // what came from outside; nothing polls after the page is back.
  const after = asked.length;
  expect(after).toBeLessThanOrEqual(3);
  await page.waitForTimeout(1500);
  expect(asked.length).toBe(after);
});

test('Pause posts build.pause and the panel says paused; Resume posts build.resume', async ({ page }) => {
  await open(page, 6);
  const n0 = (await admitted(page)).length;
  await page.getByTestId('watch').getByRole('button', { name: 'Pause' }).click();
  await expect.poll(async () => (await admitted(page)).slice(n0).map((e) => e.type)).toEqual(['build.pause']);
  const pause = (await admitted(page)).slice(n0)[0]!;
  expect(pause).toMatchObject({ by: 'owner', chapter: 'engine-loop' });
  await expect(page.getByTestId('watch')).toHaveAttribute('data-state', 'paused');
  await expect(page.getByTestId('watch-status')).toHaveText('Paused. Nothing is built while it is paused.');
  await expect(page.getByTestId('feed').locator('> li').last()).toContainText('Paused by the owner.');
  expect(await page.title()).toMatch(/^Paused 2\/7 · /);
  await page.screenshot({ path: `${SHOTS}/watch-paused.png` });
  await page.getByTestId('watch').getByRole('button', { name: 'Resume' }).click();
  await expect.poll(async () => (await admitted(page)).slice(n0).map((e) => e.type)).toEqual(['build.pause', 'build.resume']);
  await expect(page.getByTestId('watch')).toHaveAttribute('data-state', 'running');
});

test('the build folds away to one line, and comes back', async ({ page }) => {
  await open(page, 6);
  const watch = page.getByTestId('watch');
  await watch.getByRole('button', { name: 'Fold the build away' }).click();
  await expect(page.getByTestId('feed')).toHaveCount(0);
  await expect(page.getByTestId('watch-where')).toHaveText('part 3 of 7');
  await watch.getByRole('button', { name: 'Show the build' }).click();
  await expect(page.getByTestId('feed')).toBeVisible();
});

test('checkpoint 7 opens in the Story: the canvas with each idea on it, its moments, the whole pipeline, the progress', async ({ page }) => {
  await open(page, 7);
  const story = page.getByTestId('story');
  await expect(story).toBeVisible();
  await expect(page.locator('.app')).toHaveAttribute('data-mode', 'story');
  await expect(page.getByRole('button', { name: 'Story' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('board-name')).toHaveText('uLLM · the story');
  await expect(page.getByTestId('idea-count')).toHaveText('2 ideas · 1 built');
  // A log from before canvases puts every idea on one canvas, named by its first idea.
  const cards = story.locator('article[data-canvas]');
  await expect(cards).toHaveCount(1);
  const canvas = cards.first();
  await expect(canvas).toHaveAttribute('data-canvas', 'engine-loop');
  await expect(canvas.locator('.chapter__title h3')).toHaveText('The engine loop');
  await expect(canvas.locator('.chapter__when')).toContainText('2 ideas, one branch');
  const chapters = await canvas.locator('li[data-chapter]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.chapter));
  expect(chapters).toEqual(['engine-loop', 'api-server']);
  await expect(canvas.locator('li[data-chapter="engine-loop"]').getByTestId('idea-state')).toHaveText('built: try it');
  await expect(canvas.locator('li[data-chapter="api-server"]').getByTestId('idea-state')).toHaveText('idea');
  const moments = await canvas.locator('.moment:not(.moment--main) .moment__title').allTextContents();
  expect(moments).toEqual(['1 · Your note and sketch', '2 · Three ways, your marks', '3 · The model, one request', '4 · The bridge, opened', '5 · The blueprint', '6 · Built, part by part']);
  // Each moment is a small live drawing of its items.
  await expect(canvas.locator('[data-moment="e53"] [data-kind="blueprint"]')).toHaveCount(1);
  // The new idea has no moment yet: its note and the agent's placeholder stand for it.
  await expect(canvas.locator('.moment--main')).toHaveCount(2);
  await expect(canvas.locator('.moment--main').first()).toContainText('Now put HTTP in front of it');
  // The whole pipeline, flat and live, with the legend.
  const whole = page.getByTestId('whole-pipeline');
  await expect(whole.locator('[data-kind="pipeline"]')).toHaveAttribute('data-view', 'flat');
  await expect(whole.locator('.kp-legend')).toContainText('built');
  const parts = page.getByTestId('progress-parts');
  const [b, t] = [Number(await parts.getAttribute('data-built')), Number(await parts.getAttribute('data-total'))];
  expect(b).toBeGreaterThan(0);
  expect(b).toBeLessThan(t);
  await expect(parts).toContainText(`${b} of ${t} parts built`);
  await expect(page.getByTestId('progress-chapters')).toContainText('1 of 2 ideas built');
  await page.screenshot({ path: `${SHOTS}/story-7.png` });
  await story.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.screenshot({ path: `${SHOTS}/story-7-below.png` });
});

test('the Board / Story switch; a press on a moment goes to it on the board', async ({ page }) => {
  await open(page, 6);
  await page.getByRole('button', { name: 'Story' }).click();
  await expect(page.getByTestId('story')).toBeVisible();
  await expect(page.getByTestId('watch')).toHaveCount(0);
  await page.getByRole('button', { name: 'Board' }).click();
  await expect(page.getByTestId('story')).toHaveCount(0);
  await expect(page.getByTestId('watch')).toBeVisible();
  // Esc in the Story goes back to the board too.
  await page.getByRole('button', { name: 'Story' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('story')).toHaveCount(0);
  // A moment: the board shows it.
  await page.getByRole('button', { name: 'Story' }).click();
  await page.locator('[data-moment="e48"]').click();
  await expect(page.getByTestId('story')).toHaveCount(0);
  await expect.poll(() => inView(page, '[data-item="focus"]')).toBe(true);
  // A canvas: the board shows all of it.
  await page.getByRole('button', { name: 'Story' }).click();
  await page.locator('article[data-canvas="engine-loop"] .chapter__head').click();
  await expect(page.getByTestId('story')).toHaveCount(0);
  await expect(page.getByTestId('board-name')).toContainText('The engine loop');
});

test('the next idea starts on a new canvas: a blank board, and one note there starts it, apart from everything else', async ({ page }) => {
  await open(page, 7);
  const n0 = (await admitted(page)).length;
  const box = page.getByTestId('new-canvas');
  await expect(box).toContainText('Each canvas gets a branch of its own');
  await box.getByRole('button', { name: 'Start a new canvas' }).click();
  await expect.poll(async () => (await admitted(page)).slice(n0).map((e) => e.type)).toEqual(['canvas.open']);
  const opened = (await admitted(page))[n0] as Admitted & { canvas: string };
  expect(opened.by).toBe('owner');
  // The board shows again, on the blank canvas: nothing of the first canvas is on it.
  await expect(page.getByTestId('story')).toHaveCount(0);
  await expect(page.locator('.layer > [data-item]')).toHaveCount(0);
  await expect(page.getByTestId('canvas-name')).toHaveText(' · Untitled canvas');

  await page.getByRole('button', { name: 'Write a note' }).click();
  await page.mouse.click(420, 360);
  await page.keyboard.type('Batches of many requests at once');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await admitted(page)).slice(n0 + 1).map((e) => e.type)).toEqual(['chapter.open', 'item.add']);
  const [open1, add] = (await admitted(page)).slice(n0 + 1) as Array<Admitted & { canvas?: string }>;
  expect(open1).toMatchObject({ by: 'owner', title: 'Batches of many requests at once', canvas: opened.canvas });
  const item = add!.item as { id: string; kind: string; text: string; box: Box };
  expect(add!.chapter).toBe(open1!.chapter);
  expect(item).toMatchObject({ kind: 'note', text: 'Batches of many requests at once' });
  // The note is in view, alone on its canvas, and the pill follows the new idea.
  await expect(page.locator(`[data-item="${item.id}"]`)).toBeVisible();
  expect(await inView(page, `[data-item="${item.id}"]`)).toBe(true);
  await expect(page.locator('.layer > [data-item]')).toHaveCount(1);
  await expect(page.getByTestId('canvas-name')).toHaveText(' · Batches of many requests at once');
  await expect(page.getByTestId('chapter-state')).toHaveText('idea');
  await page.screenshot({ path: `${SHOTS}/story-next-idea.png` });
});
