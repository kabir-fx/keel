import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Screens 3 and 4 of the storyboard, end to end on the system Chrome, from the golden fixture:
 * the read the agent gave with no picture, the walk and the pipeline lighting the same part,
 * the focus view, and the nudge for a picture that lands out of view. The last two need a
 * board that changes after the page opened: a stand-in server on a routed websocket plays
 * the agent.
 */

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const SHOTS = here('./shots');
mkdirSync(SHOTS, { recursive: true });

type Ev = { id: string; type: string; by: string; at: string; item?: unknown; [k: string]: unknown };
const LOG = readFileSync(here('../protocol/fixtures/engine-loop/log.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as Ev);
const upTo = (id: string) => LOG.slice(0, LOG.findIndex((e) => e.id === id) + 1);
const WALK = (LOG.find((e) => e.id === 'e32')!.ops as Array<{ op: string; walk?: { steps: Array<{ n: number; part: string }> } }>).find((o) => o.op === 'walk.set')!.walk!.steps;
const partOfStep = (n: number) => WALK.find((s) => s.n === n)!.part;

async function watch(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __admitted: unknown[] };
    w.__admitted = [];
    window.addEventListener('keel:admit', (e) => w.__admitted.push((e as CustomEvent).detail));
  });
}
const admitted = (page: Page) => page.evaluate(() => (window as unknown as { __admitted: Ev[] }).__admitted);

/** Open a checkpoint and wait until every picture has its place and the fonts are in. */
async function open(page: Page, at: number) {
  await page.goto(`/?fixture=engine-loop&at=${at}`);
  await expect(page.getByTestId('board')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('[data-measure]')).toHaveCount(0);
  await page.waitForTimeout(600);
}

async function box(page: Page, selector: string) {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`${selector} is not on screen`);
  return b;
}

/** Is most of the element inside the window? */
async function inView(page: Page, selector: string): Promise<boolean> {
  const b = await box(page, selector);
  const vp = page.viewportSize()!;
  const w = Math.max(0, Math.min(b.x + b.width, vp.width) - Math.max(b.x, 0));
  const h = Math.max(0, Math.min(b.y + b.height, vp.height) - Math.max(b.y, 0));
  return (w * h) / (b.width * b.height) > 0.6;
}

const ellipse = (cx: number, cy: number, rx: number, ry: number, n = 48): Array<[number, number]> =>
  Array.from({ length: n + 1 }, (_, i) => {
    const t = -Math.PI / 2 + (i / n) * 1.06 * 2 * Math.PI;
    return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];
  });

async function draw(page: Page, pts: Array<[number, number]>) {
  await page.mouse.move(pts[0]![0], pts[0]![1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(x, y);
  await page.mouse.up();
}

/**
 * Tap the bridge's floor in the layered pipeline, where no block stands. The lane's name sits
 * beside the floor and is not part of what a tap takes in, so the tap goes on the floor itself.
 */
async function tapBridge(page: Page) {
  const floor = page.locator('[data-item="pipe"] [data-sub="lane:bridge"] > polygon').first();
  const b = (await floor.boundingBox())!;
  // The top of the floor is a slanted slab: aim inside it, left of where the blocks stand.
  await floor.click({ position: { x: b.width * 0.1, y: b.height * 0.55 } });
}

const litPart = (page: Page) => page.locator('[data-item="pipe"] [data-lit]').first().getAttribute('data-part');

test('checkpoint 3 opens as its view says: the walk at step 8, the pipeline in Layers lighting that part', async ({ page }) => {
  await open(page, 3);
  await expect(page.locator('[data-item="pipe"] [data-kind="pipeline"]')).toHaveAttribute('data-view', 'layers');
  await expect(page.locator('[data-item="walk"] [aria-current="step"]')).toContainText('The model runs on the GPU');
  expect(await litPart(page)).toBe(partOfStep(8));
  await expect(page.getByTestId('presence')).toHaveAttribute('data-state', 'listening');
  await expect(page.getByTestId('focus-crumb')).toHaveCount(0);
  for (const id of ['pipe', 'walk', 'hint']) expect(await inView(page, `[data-item="${id}"]`)).toBe(true);
});

test('the read the agent gave with no picture is a chip under the mark it answers', async ({ page }) => {
  await open(page, 3);
  const chip = page.locator('.read-chip[data-mark="circle-bridge"]');
  await expect(chip).toBeVisible();
  await expect(chip).toHaveText('read as:Open the bridge');
  // It sits at the bottom of the circle round the bridge.
  const ring = await box(page, '[data-item="circle-bridge"] svg');
  const c = await box(page, '.read-chip[data-mark="circle-bridge"]');
  expect(c.y).toBeGreaterThan(ring.y + ring.height * 0.5);
  expect(c.y).toBeLessThan(ring.y + ring.height + 40);
  expect(c.x + c.width / 2).toBeGreaterThan(ring.x);
  expect(c.x + c.width / 2).toBeLessThan(ring.x + ring.width);
});

test('the walk steps light the same part in the pipeline, by button and by arrow key', async ({ page }) => {
  await open(page, 3);
  expect(await litPart(page)).toBe(partOfStep(8));
  await page.locator('[data-item="walk"]').getByRole('button', { name: 'Next step' }).click();
  await expect(page.locator('[data-item="walk"] [aria-current="step"]')).toContainText('output queue');
  await expect.poll(() => litPart(page)).toBe(partOfStep(9));
  // Select the walk, and the arrow keys play it.
  const head = await box(page, '[data-item="walk"] .kp-card__head');
  await page.mouse.click(head.x + head.width / 2, head.y + head.height / 2);
  await expect(page.locator('[data-item="walk"]')).toHaveClass(/item--selected/);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => litPart(page)).toBe(partOfStep(10));
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => litPart(page)).toBe(partOfStep(8));
  await page.screenshot({ path: `${SHOTS}/views-walk.png` });
});

test('checkpoint 4 opens in the focus view; a mark made in it hangs on the focus picture; Esc and the crumb go back', async ({ page }) => {
  await watch(page);
  await open(page, 4);
  const crumb = page.getByTestId('focus-crumb');
  await expect(crumb).toContainText('Pipeline');
  await expect(crumb).toContainText('The bridge');
  await expect(crumb).toContainText('2 parts · Esc goes back');
  await expect(page.locator('.app')).toHaveAttribute('data-focus', 'focus');
  expect(await inView(page, '[data-item="focus"]')).toBe(true);
  // The reply to the marks on it sits beside it, and the view holds both.
  expect(await inView(page, '[data-item="read-marks"]')).toBe(true);
  const large = await box(page, '[data-item="focus"]');
  expect(large.width).toBeGreaterThan(850);
  await page.screenshot({ path: `${SHOTS}/views-focus.png` });

  // A circle round the first option, drawn in the focus view.
  const n0 = (await admitted(page)).length;
  await page.keyboard.press('p');
  const opt = await box(page, '[data-item="focus"] [data-sub="option:cap-queue"]');
  await draw(page, ellipse(opt.x + opt.width / 2, opt.y + opt.height / 2, opt.width / 2 + 14, opt.height / 2 + 12));
  await expect.poll(async () => (await admitted(page)).slice(n0).filter((e) => e.type === 'item.add').length, { timeout: 5000 }).toBe(1);
  const ink = (await admitted(page)).slice(n0).find((e) => e.type === 'item.add')!.item as { id: string; hint: string; targets: unknown[]; anchor: { item: string; sub?: string } };
  expect(ink.hint).toBe('circle');
  expect(ink.targets).toEqual([{ item: 'focus', sub: 'option:cap-queue' }]);
  expect(ink.anchor).toMatchObject({ item: 'focus', sub: 'option:cap-queue' });
  await expect(page.locator(`[data-item="${ink.id}"]`)).toHaveClass(/item--raised/);

  // Esc goes back to the board; a tap on the bridge opens it again; the crumb goes back.
  await page.keyboard.press('s');
  await page.keyboard.press('Escape');
  await expect(crumb).toHaveCount(0);
  await expect(page.locator('[data-focus-dim]')).toHaveCount(0);
  await tapBridge(page);
  await expect(crumb).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/views-focus-marked.png` });
  await crumb.getByRole('button', { name: /Pipeline/ }).click();
  await expect(crumb).toHaveCount(0);
});

/** A stand-in board server on the page's websocket: it admits the owner's posts, and the test plays the agent. */
async function standIn(page: Page, events: Ev[]) {
  const posts: Array<{ ref: string; draft: Record<string, unknown> }> = [];
  let seq = events.length;
  let last = Date.parse(events[events.length - 1]!.at);
  let socket: { send: (m: string) => void } | undefined;
  const stamp = (draft: Record<string, unknown>, by: string): Ev => {
    last += 1000;
    return { ...draft, by, id: `e${++seq}`, at: new Date(last).toISOString().replace(/\.\d+Z$/, 'Z') } as Ev;
  };
  await page.routeWebSocket(/\/ws/, (ws) => {
    socket = ws;
    ws.send(JSON.stringify({ t: 'init', name: 'uLLM', role: 'owner', events, presence: { state: 'listening', since: '2026-11-17T13:00:00Z' } }));
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw)) as { t: string; ref: string; draft: Record<string, unknown> };
      if (msg.t !== 'post') return;
      posts.push(msg);
      ws.send(JSON.stringify({ t: 'ok', ref: msg.ref, event: stamp(msg.draft, 'owner') }));
    });
  });
  return {
    posts,
    /** The agent posts: the board gets the event. */
    agent: (draft: Record<string, unknown>) => {
      const ev = stamp(draft, 'agent');
      socket!.send(JSON.stringify({ t: 'event', event: ev }));
      return ev;
    },
  };
}

test('a tap on the bridge asks; the board says the agent is opening it, and opens it when it arrives', async ({ page }) => {
  const server = await standIn(page, upTo('e41'));
  await page.goto('/?token=owner-token');
  await expect(page.locator('[data-item="pipe"]')).toBeVisible();
  await expect(page.locator('[data-measure]')).toHaveCount(0);
  await page.waitForTimeout(500);
  await tapBridge(page);
  await expect.poll(() => server.posts.map((p) => p.draft.type)).toContain('ask');
  await expect(page.getByTestId('focus-opening')).toContainText('The agent is opening the bridge');
  await page.screenshot({ path: `${SHOTS}/views-opening.png` });
  const ask = server.posts.find((p) => p.draft.type === 'ask')!;
  expect(ask.draft).toMatchObject({ what: 'focus', lane: 'bridge', item: 'pipe' });
  const focus = LOG.find((e) => e.id === 'e43')!;
  const askId = `e${upTo('e41').length + server.posts.indexOf(ask) + 1}`;
  server.agent({ type: 'item.add', chapter: 'engine-loop', item: { ...(focus.item as Record<string, unknown>), answers: [askId] } });
  await expect(page.getByTestId('focus-crumb')).toContainText('The bridge');
  await expect(page.getByTestId('focus-opening')).toHaveCount(0);
  expect(await inView(page, '[data-item="focus"]')).toBe(true);
});

test('a picture that lands out of view is a quiet nudge; the view moves only when it is pressed', async ({ page }) => {
  const server = await standIn(page, upTo('e41'));
  await page.goto('/?token=owner-token');
  await expect(page.locator('[data-item="pipe"]')).toBeVisible();
  await expect(page.locator('[data-measure]')).toHaveCount(0);
  await page.waitForTimeout(500);
  // Look closely at the middle of the board: the owner's first sketch is far out of view.
  await page.keyboard.press('0');
  await page.waitForTimeout(200);
  expect(await inView(page, '[data-item="sketch"] svg')).toBe(false);
  const before = await page.locator('.world').getAttribute('style');

  server.agent({
    type: 'item.add',
    chapter: 'engine-loop',
    item: { id: 'late', kind: 'picture', picture: { kind: 'text', title: 'One more thought on your sketch', body: 'The middle can be a plain queue to start.' }, from: ['sketch'], place: { near: 'sketch', side: 'below' } },
  });
  const nudge = page.getByTestId('nudge');
  await expect(nudge).toContainText('New from the agent: One more thought on your sketch');
  await expect.poll(() => server.posts.filter((p) => p.draft.type === 'item.place' && p.draft.item === 'late').length).toBe(1);
  // The view did not move by itself.
  expect(await page.locator('.world').getAttribute('style')).toBe(before);
  expect(await inView(page, '[data-item="late"]')).toBe(false);
  await page.screenshot({ path: `${SHOTS}/views-nudge.png` });
  await nudge.click();
  await expect.poll(() => inView(page, '[data-item="late"]')).toBe(true);
  await expect(nudge).toHaveCount(0);
});

test('a session the server refuses says how to open the board again, and stops trying', async ({ page }) => {
  let sockets = 0;
  await page.routeWebSocket(/\/ws/, (ws) => {
    sockets += 1;
    // The server does not know this page: the socket closes at once, and the board answers 401.
    ws.close();
  });
  await page.route('**/api/board', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"A token is needed."}' }));
  await page.goto('/?token=stale-token');
  const notice = page.getByTestId('connection');
  await expect(notice).toHaveAttribute('data-state', 'refused');
  await expect(notice).toContainText('Open the board again from your terminal: keel-board open');
  await expect(page.getByTestId('presence')).toContainText('away · the board did not accept this page');
  const tries = sockets;
  await page.waitForTimeout(2500);
  expect(sockets).toBe(tries);
  await page.screenshot({ path: `${SHOTS}/views-refused.png` });
});
