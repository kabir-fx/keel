import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { standIn, upTo } from './stand-in';

/**
 * What a walk of the whole owner journey found, fixed and held: Delete and Undo on an agent's
 * picture, a build the owner never agreed to on this machine, a reload that keeps the owner's
 * place, the Note tool that waits for its click, and a fit that keeps clear of the toolbar and
 * the panels. On the system Chrome, from the golden fixture or a stand-in server.
 */

const SHOTS = fileURLToPath(new URL('./shots', import.meta.url));

interface Admitted {
  id: string;
  type: string;
  by: string;
  item?: unknown;
}

async function openFixture(page: Page, at: number) {
  await page.addInitScript(() => {
    const w = window as unknown as { __admitted: unknown[] };
    w.__admitted = [];
    window.addEventListener('keel:admit', (e) => w.__admitted.push((e as CustomEvent).detail));
  });
  await page.goto(`/?fixture=engine-loop&at=${at}`);
  await expect(page.getByTestId('board')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('[data-measure]')).toHaveCount(0);
  await page.waitForTimeout(500);
}

const admitted = (page: Page) => page.evaluate(() => (window as unknown as { __admitted: Admitted[] }).__admitted);

async function settle(page: Page) {
  await expect(page.getByTestId('board')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('[data-measure]')).toHaveCount(0);
  await page.waitForTimeout(500);
}

test('Delete takes an agent’s picture off the board, and Undo puts it back', async ({ page }) => {
  await openFixture(page, 3);
  const card = page.locator('[data-item="hint"]');
  await expect(card).toBeVisible();
  const head = (await card.locator('.kp-card__head, h3').first().boundingBox())!;
  await page.mouse.click(head.x + 20, head.y + head.height / 2);
  await expect(card).toHaveClass(/item--selected/);
  const n = (await admitted(page)).length;
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await admitted(page)).slice(n).map((e) => [e.type, e.by, e.item])).toEqual([['item.remove', 'owner', 'hint']]);
  await expect(card).toHaveCount(0);
  await expect(page.getByTestId('toast')).toContainText('Taken off the board. Undo');
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await admitted(page)).slice(n).map((e) => e.type)).toEqual(['item.remove', 'item.restore']);
  await expect(page.locator('[data-item="hint"]')).toBeVisible();
});

test('a build not agreed on this machine: the panel says so, shows the check and the remarks the builder will follow, and one Resume agrees to it', async ({ page }) => {
  // A log from elsewhere can hold anyone's words: here, a note pinned on a decided part that is not built yet.
  const events = upTo('e69');
  const pinned = {
    by: 'owner',
    chapter: 'engine-loop',
    type: 'item.add',
    item: { id: 'remark-x', kind: 'note', box: [-200, 1400, 320, 80], text: 'Also log every refused request.', on: { item: 'pipe', sub: 'part:engine-client' } },
    id: `e${events.length + 1}`,
    at: '2026-11-17T14:05:00Z',
  };
  const server = await standIn(page, [...events, pinned], {
    build: { chapter: 'engine-loop', title: 'The engine loop', state: 'unagreed', built: 2, total: 7, check: 'make check' },
  });
  await page.goto('/?token=owner-token');
  await settle(page);
  const watch = page.getByTestId('watch');
  await expect(watch).toHaveAttribute('data-state', 'unagreed');
  await expect(page.getByTestId('watch-status')).toContainText('you have not pressed "Build this" or Resume for the board as it is now, on this machine');
  await expect(page.getByTestId('watch-agree').locator('code')).toHaveText('make check');
  await expect(page.getByTestId('watch-status')).toContainText('Resume is your agreement to build what this board says (the parts on the track below, and the remarks on them listed here)');
  await expect(page.getByTestId('watch-remarks')).toContainText('The builder will also follow these remarks on the parts:');
  await expect(page.getByTestId('watch-remarks').locator('li')).toHaveText(['EngineClient: Also log every refused request.']);
  await expect(watch.getByRole('button', { name: 'Pause' })).toHaveCount(0);
  await expect(page.getByTestId('watch-leave')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/journey-unagreed.png` });
  await watch.getByRole('button', { name: 'Resume' }).click();
  // The page also places the pictures it is given; the build's posts are the two of Resume.
  const builds = () => server.posts.filter((p) => String(p.draft.type).startsWith('build.'));
  await expect.poll(() => builds().map((p) => p.draft.type)).toEqual(['build.pause', 'build.resume']);
  expect(builds().every((p) => p.draft.chapter === 'engine-loop')).toBe(true);
  // The server agrees, and runs it.
  server.send({ t: 'build', build: { chapter: 'engine-loop', title: 'The engine loop', state: 'running', built: 2, total: 7, part: 'Engine loop' } });
  await expect(watch).toHaveAttribute('data-state', 'running');
  await expect(page.getByTestId('watch-leave')).toContainText('You can leave.');
});

test('a reload keeps the owner’s place: the pill and the panel follow where the owner is', async ({ page }) => {
  await standIn(page, upTo('e88'));
  await page.goto('/?token=owner-token');
  await settle(page);
  // Nothing kept yet: the first view is the idea in work, not the old build. The log is from
  // before canvases, so both ideas are on one canvas, and the pill names the one in view after it.
  const pill = page.locator('header.pill--board');
  await expect(page.getByTestId('board-name')).toContainText('API server');
  await expect(pill).toHaveAttribute('data-chapter', 'api-server');
  await expect(page.getByTestId('watch')).toHaveCount(0);
  await page.reload();
  await settle(page);
  await expect(pill).toHaveAttribute('data-chapter', 'api-server');
  await expect(page.getByTestId('watch')).toHaveCount(0);
  // The owner goes to the old idea, at its blueprint, and reloads there.
  await page.getByRole('button', { name: 'Story' }).click();
  await page.locator('[data-moment="e53"]').click();
  await expect(pill).toHaveAttribute('data-chapter', 'engine-loop');
  await expect(page.getByTestId('board-name')).toContainText('The engine loop');
  await page.waitForTimeout(600);
  const before = await page.locator('.world').getAttribute('style');
  await page.reload();
  await settle(page);
  await expect(pill).toHaveAttribute('data-chapter', 'engine-loop');
  // The engine loop is built and the API server is in work: the done build's panel stays out of the way.
  await expect(page.getByTestId('watch')).toHaveCount(0);
  expect(await page.locator('.world').getAttribute('style')).toBe(before);
  // The Story is kept too.
  await page.getByRole('button', { name: 'Story' }).click();
  await page.waitForTimeout(600);
  await page.reload();
  await settle(page);
  await expect(page.getByTestId('story')).toBeVisible();
});

test('the Note tool waits for its click: a click on a panel says where to click, and typed letters stay letters', async ({ page }) => {
  await openFixture(page, 6);
  await page.getByRole('button', { name: 'Write a note' }).click();
  const watch = (await page.getByTestId('watch').boundingBox())!;
  await page.mouse.click(watch.x + watch.width / 2, watch.y + watch.height / 2);
  await expect(page.getByRole('textbox', { name: 'Your note' })).toHaveCount(0);
  await expect(page.getByTestId('toast')).toContainText('A note goes on the board: click on the board where it goes');
  await page.keyboard.type('help');
  await expect(page.locator('.app')).toHaveAttribute('data-tool', 'note');
  await page.screenshot({ path: `${SHOTS}/journey-note-on-panel.png` });
  // A click on the board places it.
  const n = (await admitted(page)).length;
  await page.mouse.click(120, 400);
  await expect(page.getByRole('textbox', { name: 'Your note' })).toBeFocused();
  await page.keyboard.type('is the queue bounded?');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await admitted(page)).slice(n).filter((e) => e.type === 'item.add').length).toBe(1);
});

test('a fit keeps clear of the toolbar and the panels: the blueprint, from the Story, while it builds', async ({ page }) => {
  await openFixture(page, 6);
  await page.getByRole('button', { name: 'Story' }).click();
  await page.locator('[data-moment="e53"]').click();
  await expect(page.getByTestId('story')).toHaveCount(0);
  await page.waitForTimeout(300);
  const bp = (await page.locator('[data-item="blueprint"]').boundingBox())!;
  const toolbar = (await page.getByRole('toolbar', { name: 'Tools' }).boundingBox())!;
  const watch = (await page.getByTestId('watch').boundingBox())!;
  expect(bp.y + bp.height).toBeLessThanOrEqual(toolbar.y);
  expect(bp.x + bp.width).toBeLessThanOrEqual(watch.x);
  await expect(page.locator('[data-item="blueprint"]').getByText('How you will know it works')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/journey-fit-blueprint.png` });
});
