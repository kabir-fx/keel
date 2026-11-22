import { expect, test, type JSHandle, type Page } from '@playwright/test';
import { ECHO, appIsBuilt, startBoard, type RunningBoard } from './board-server';
import { readCamera, worldToPage } from './pointer';

/**
 * A picture the owner drops in shows as the picture, on the system Chrome: a real PNG, made by
 * the page's own canvas, dropped on the `tools` fixture, which announces each admitted event as
 * a `keel:admit` window event; and dropped on the real board server, where the page reads it
 * with its token under the server's Content Security Policy.
 */

type Box = [number, number, number, number];
interface Item {
  id: string;
  kind: string;
  box: Box;
  name?: string;
  mime?: string;
}

async function open(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __admitted: unknown[] };
    w.__admitted = [];
    window.addEventListener('keel:admit', (e) => w.__admitted.push((e as CustomEvent).detail));
  });
  await page.goto('/?fixture=tools&at=1');
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.locator('[data-measure]')).toHaveCount(0);
}

const adds = (page: Page) =>
  page.evaluate(() => (window as unknown as { __admitted: Array<{ type: string; item?: unknown }> }).__admitted.filter((e) => e.type === 'item.add').map((e) => e.item as Item));

/** A drag that holds one real PNG, 240 by 160, as the page's canvas makes it. */
function pngDrag(page: Page): Promise<JSHandle<DataTransfer>> {
  return page.evaluateHandle(async () => {
    const c = document.createElement('canvas');
    c.width = 240;
    c.height = 160;
    const g = c.getContext('2d')!;
    g.fillStyle = '#1d4ed8';
    g.fillRect(0, 0, 240, 160);
    g.fillStyle = '#fff0e0';
    g.fillRect(30, 30, 120, 60);
    const png = await new Promise<Blob>((done) => c.toBlob((b) => done(b!), 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([png], 'sketch.png', { type: 'image/png' }));
    return dt;
  });
}

test('a dropped PNG shows as itself, at its own shape, centred where it was dropped; Open opens it', async ({ page }) => {
  await open(page);
  const n0 = (await adds(page)).length;
  const at = { clientX: 1100, clientY: 640 };
  const data = await pngDrag(page);
  await page.getByTestId('board').dispatchEvent('dragover', { dataTransfer: data, ...at });
  await page.getByTestId('board').dispatchEvent('drop', { dataTransfer: data, ...at });
  await expect.poll(async () => (await adds(page)).length, { timeout: 5000 }).toBeGreaterThan(n0);
  const item = (await adds(page))[n0]!;
  expect(item).toMatchObject({ kind: 'file', name: 'sketch.png', mime: 'image/png' });

  // Its box has the picture's shape, and its middle is where it was dropped.
  const [x, y, w, h] = item.box;
  expect(Math.abs(w / h - 240 / 160)).toBeLessThan(0.01);
  const mid = await worldToPage(page, [x + w / 2, y + h / 2]);
  expect(Math.abs(mid[0] - at.clientX)).toBeLessThanOrEqual(1);
  expect(Math.abs(mid[1] - at.clientY)).toBeLessThanOrEqual(1);
  const { z } = await readCamera(page);
  expect(h).toBe(Math.round(Math.min(160, Math.min(Math.max(900 - 120, 160), Math.floor(900 * 0.5) / z))));

  // The picture itself, decoded, filling the box on the screen.
  const img = page.locator(`[data-item="${item.id}"] img`);
  await expect(img).toHaveAttribute('alt', 'sketch.png');
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(240);
  expect(await img.evaluate((el) => (el as HTMLImageElement).naturalHeight)).toBe(160);
  await expect(page.locator(`[data-item="${item.id}"] .file-picture__wait`)).toHaveCount(0);
  const shown = (await img.boundingBox())!;
  expect(Math.abs(shown.width - w * z)).toBeLessThanOrEqual(1);
  expect(Math.abs(shown.height - h * z)).toBeLessThanOrEqual(1);

  // Open shows when the pointer is on it, and opens the file in a tab.
  const openBtn = page.locator(`[data-item="${item.id}"]`).getByRole('button', { name: 'Open sketch.png' });
  await expect(openBtn).toBeHidden();
  await page.mouse.move(at.clientX, at.clientY);
  await expect(openBtn).toBeVisible();
  const popup = page.waitForEvent('popup');
  await openBtn.click();
  const tab = await popup;
  await expect.poll(() => tab.url()).toMatch(/^blob:/);
});

test.describe('on the real board server', () => {
  let board: RunningBoard | undefined;

  test.beforeAll(async () => {
    test.skip(!appIsBuilt(), 'build first: npm run build, from workspace/');
    board = await startBoard({ link: `script:${ECHO}` });
  });

  test.afterAll(async () => {
    test.setTimeout(60_000);
    await board?.stop();
  });

  test('a dropped PNG is drawn from the bytes read with the token, and a circle drawn round it goes with a snapshot', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.goto(board!.url);
    await expect(page.getByTestId('board')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    const at = { clientX: 700, clientY: 450 };
    const data = await pngDrag(page);
    await page.getByTestId('board').dispatchEvent('dragover', { dataTransfer: data, ...at });
    await page.getByTestId('board').dispatchEvent('drop', { dataTransfer: data, ...at });
    const img = page.locator('[data-kind="file"] img[alt="sketch.png"]');
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 10_000 }).toBe(240);
    await expect(page.locator('[data-measure]')).toHaveCount(0);

    // A loop round the picture with the pen: its snapshot goes up as the ink mark's own PNG.
    const snapshot = page.waitForRequest((r) => r.method() === 'POST' && /[?&]name=m\d+\.png$/.test(r.url()), { timeout: 10_000 });
    const b = (await img.boundingBox())!;
    const [cx, cy, rx, ry] = [b.x + b.width / 2, b.y + b.height / 2, b.width / 2 + 30, b.height / 2 + 30];
    await page.keyboard.press('p');
    await page.mouse.move(cx, cy - ry);
    await page.mouse.down();
    for (let i = 1; i <= 50; i++) {
      const t = -Math.PI / 2 + (i / 50) * 2.1 * Math.PI;
      await page.mouse.move(cx + rx * Math.cos(t), cy + ry * Math.sin(t));
    }
    await page.mouse.up();
    const stored = await (await snapshot).response();
    expect(stored?.status()).toBe(200);
    expect(await stored?.json()).toMatchObject({ asset: expect.stringMatching(/^assets\/m\d+\.png$/) });
    expect(errors).toEqual([]);
  });
});
