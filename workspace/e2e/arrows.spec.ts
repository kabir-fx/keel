import { expect, test, type Page } from '@playwright/test';
import { zoomTo } from './hand';
import { nextFrame, pixelsApart, readCamera, screenshotWhole } from './pointer';

/**
 * The owner's arrows on the system Chrome: an arrow drawn between two pictures holds on to both
 * when one moves, and an end dragged by its handle ties to a third; what is drawn while the
 * pointer is down is drawn on the same pixels once it is saved, for an arrow tied at both ends
 * and for an end dragged by its handle; the outline round what an end would tie to keeps its
 * width on screen; the words of an arrow hide the line behind them. The fixture page announces
 * each admitted event as a `keel:admit` window event.
 */

type Box = [number, number, number, number];
interface Target {
  item: string;
  sub?: string;
}
interface Tie {
  at: [number, number];
  mode: 'inside' | 'outline';
}
interface Admitted {
  type: string;
  item?: { id: string; kind: string; fromTarget?: Target; toTarget?: Target; fromTie?: Tie; toTie?: Tie } | string;
  patch?: { box?: Box; arrowTo?: { at: [number, number]; target?: Target; tie?: Tie } };
}
type XY = [number, number];

async function open(page: Page, url: string) {
  await page.addInitScript(() => {
    const w = window as unknown as { __admitted: unknown[] };
    w.__admitted = [];
    window.addEventListener('keel:admit', (e) => w.__admitted.push((e as CustomEvent).detail));
  });
  await page.goto(url);
  await expect(page.getByTestId('board')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('[data-measure]')).toHaveCount(0);
  await page.waitForTimeout(500);
}

const admitted = (page: Page) => page.evaluate(() => (window as unknown as { __admitted: Admitted[] }).__admitted);

/** Wait for the events posted since `from`, until there are `n` of them. */
async function postedSince(page: Page, from: number, n = 1): Promise<Admitted[]> {
  await expect.poll(async () => (await admitted(page)).length - from, { timeout: 5000 }).toBeGreaterThanOrEqual(n);
  return (await admitted(page)).slice(from);
}

async function rectOf(page: Page, selector: string) {
  const b = await page.locator(selector).boundingBox();
  if (!b) throw new Error(`${selector} is not on screen`);
  return b;
}

/** A drag with the mouse through these page points, in small steps. */
async function drag(page: Page, from: XY, to: XY, { lift = true }: { lift?: boolean } = {}) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / 10, from[1] + ((to[1] - from[1]) * i) / 10);
  await nextFrame(page);
  if (lift) await page.mouse.up();
}

/** Where an arrow's line begins and ends on the page, read from the path Chrome draws. */
function lineEnds(page: Page, id: string): Promise<[XY, XY]> {
  return page.locator(`[data-item="${id}"] svg.line-mark > path`).first().evaluate((el) => {
    const path = el as SVGPathElement;
    const m = path.getScreenCTM()!;
    const at = (len: number): [number, number] => {
      const q = path.getPointAtLength(len);
      return [q.x * m.a + q.y * m.c + m.e, q.x * m.b + q.y * m.d + m.f];
    };
    return [at(0), at(path.getTotalLength())];
  });
}

/** A point of a box as shares of it. */
const sharesIn = (p: XY, b: { x: number; y: number; width: number; height: number }): XY => [(p[0] - b.x) / b.width, (p[1] - b.y) / b.height];

test('an arrow drawn between two pictures holds on to both when one moves, and an end dragged to a third ties to it', async ({ page }) => {
  await open(page, '/?fixture=sample&at=3');
  const z = (await readCamera(page)).z;
  const a1 = await rectOf(page, '[data-item="a1"]');
  const a3 = await rectOf(page, '[data-item="a3"]');
  let n = (await admitted(page)).length;

  // From inside the first card to just above the third: an exact spot, and the thing by its outline.
  await page.keyboard.press('a');
  const from: XY = [a1.x + a1.width * 0.6, a1.y + a1.height * 0.8];
  const to: XY = [a3.x + a3.width * 0.4, a3.y - 8];
  await drag(page, from, to, { lift: false });
  // While it is drawn, the third card is outlined in the board's blue, two pixels wide, just outside it.
  const ring = await rectOf(page, '[data-testid="tie-outline"]');
  expect(Math.abs(ring.x - (a3.x - 2))).toBeLessThanOrEqual(1);
  expect(Math.abs(ring.width - (a3.width + 4))).toBeLessThanOrEqual(1);
  await expect(page.getByTestId('tie-outline')).toHaveCSS('border-top-width', '2px');
  await expect(page.getByTestId('tie-outline')).toHaveCSS('border-top-color', 'rgb(29, 78, 216)');
  await page.mouse.up();
  await expect(page.getByTestId('tie-outline')).toBeHidden();
  await page.keyboard.type('feeds');
  await page.keyboard.press('Enter');
  const [add] = await postedSince(page, n);
  const arrow = add!.item as Exclude<Admitted['item'], string | undefined>;
  expect(arrow).toMatchObject({ kind: 'arrow', fromTarget: { item: 'a1' }, fromTie: { mode: 'inside' }, toTarget: { item: 'a3' }, toTie: { mode: 'outline' } });
  const [tail, head] = await lineEnds(page, arrow.id);
  expect(Math.abs(tail[0] - from[0])).toBeLessThan(1);
  // The head stops 6.5 board units short of the card it points at.
  expect(a3.y - head[1]).toBeCloseTo(6.5 * z, 0);
  // Tying the head has not turned the arrow: it lies on the line the hand drew, from where it began through where it stopped.
  const offLine = ((head[0] - from[0]) * (to[1] - from[1]) - (head[1] - from[1]) * (to[0] - from[0])) / Math.hypot(to[0] - from[0], to[1] - from[1]);
  expect(Math.abs(offLine)).toBeLessThan(1);

  // Move the first card: the tail stays on its spot on it; the head stays where it was.
  await page.keyboard.press('Escape');
  n = (await admitted(page)).length;
  // Cmd held: the card is not pulled onto an edge of the cards placed round it, so it moves exactly as far as the hand.
  await page.keyboard.down('Meta');
  await drag(page, [a1.x + 40, a1.y + 12], [a1.x + 140, a1.y - 48]);
  await page.keyboard.up('Meta');
  await postedSince(page, n);
  const moved = await rectOf(page, '[data-item="a1"]');
  expect(moved.x).toBeCloseTo(a1.x + 100, 0);
  const [tail2, head2] = await lineEnds(page, arrow.id);
  const [sx, sy] = sharesIn(tail2, moved);
  const [sx0, sy0] = sharesIn(tail, a1);
  expect(sx).toBeCloseTo(sx0, 2);
  expect(sy).toBeCloseTo(sy0, 2);
  // The head still points at the third card, and still stops 6.5 units short of it.
  expect(a3.y - head2[1]).toBeCloseTo(6.5 * z, 0);
  expect(head2[0]).toBeGreaterThan(a3.x);
  expect(head2[0]).toBeLessThan(a3.x + a3.width);

  // Take the arrow by its head's handle and point it at the second card instead.
  await page.mouse.click((tail2[0] + head2[0]) / 2 + 30, (tail2[1] + head2[1]) / 2 + 30 * ((head2[1] - tail2[1]) / (head2[0] - tail2[0])));
  await expect(page.locator('.end-handle[data-end="to"]')).toBeVisible();
  const handle = await rectOf(page, '.end-handle[data-end="to"]');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await nextFrame(page);
  expect(await page.getByTestId('board').evaluate((el) => (el as HTMLElement).style.cursor)).toBe('pointer');
  const a2 = await rectOf(page, '[data-item="a2"]');
  const onA2: XY = [a2.x + a2.width * 0.5, a2.y + 10];
  n = (await admitted(page)).length;
  await drag(page, [handle.x + handle.width / 2, handle.y + handle.height / 2], onA2);
  const [update] = await postedSince(page, n);
  expect(update!.patch?.arrowTo).toMatchObject({ target: { item: 'a2' }, tie: { mode: 'inside' } });
  const [, head3] = await lineEnds(page, arrow.id);
  expect(Math.abs(head3[0] - onA2[0])).toBeLessThan(1);
  expect(Math.abs(head3[1] - onA2[1])).toBeLessThan(1);
});

test('the words of an arrow hide its line: none of it shows on their chip', async ({ page }) => {
  await open(page, '/?fixture=tools&at=1');
  await page.keyboard.press('a');
  await drag(page, [900, 700], [1180, 700]);
  await page.keyboard.type('why');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await page.mouse.move(300, 850);
  const chip = page.locator('.line-mark__text').last();
  await expect(chip).toHaveCSS('background-color', 'rgb(238, 241, 245)');
  const b = (await chip.boundingBox())!;
  // The strip of the chip the line runs through, between its edge and its words: the ground's colour, with no line in it.
  const shot = await page.screenshot({ clip: { x: Math.ceil(b.x) + 1, y: 698, width: 3, height: 5 } });
  const colours = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const g = new OffscreenCanvas(image.width, image.height).getContext('2d')!;
    g.drawImage(image, 0, 0);
    const d = g.getImageData(0, 0, image.width, image.height).data;
    const out = new Set<string>();
    for (let i = 0; i < d.length; i += 4) out.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
    return [...out];
  }, shot.toString('base64'));
  expect(colours).toEqual(['238,241,245']);
});

test('the words of the arrow selected slide along its line: an open hand over them, and one change when they land', async ({ page }) => {
  await open(page, '/?fixture=tools&at=1');
  await page.keyboard.press('a');
  await drag(page, [900, 700], [1180, 700]);
  await page.keyboard.type('why');
  await page.keyboard.press('Enter');
  // The new arrow is selected: its words take a press.
  await expect(page.locator('.end-handle[data-end="to"]')).toBeVisible();
  const chip = page.locator('.line-mark__text').last();
  const b = (await chip.boundingBox())!;
  const middle: XY = [b.x + b.width / 2, b.y + b.height / 2];
  await page.mouse.move(middle[0], middle[1]);
  await nextFrame(page);
  expect(await page.getByTestId('board').evaluate((el) => (el as HTMLElement).style.cursor)).toBe('grab');
  const n = (await admitted(page)).length;
  // A quarter of the way along: 70 px from the tail.
  await drag(page, middle, [970, 720]);
  const [update] = await postedSince(page, n);
  expect(update!.patch).toEqual({ labelAt: 0.25 });
  const after = (await chip.boundingBox())!;
  expect(after.x + after.width / 2).toBeCloseTo(970, 0);
});

test('at 400%, a click on a side of an arrow’s head, clear of its line, selects the arrow', async ({ page }) => {
  await open(page, '/?fixture=tools&at=1');
  await zoomTo(page, 4);
  await page.keyboard.press('a');
  await drag(page, [900.3, 690.3], [1150.3, 700.3]);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.locator('.end-handle[data-end="to"]')).toBeHidden();
  // A point of the head as Chrome draws it: three quarters of the way out along one side, 15 px from the line.
  const wing = await page
    .locator('.layer [data-kind="arrow"] svg.line-mark > path.line-mark__head')
    .last()
    .evaluate((el) => {
      const path = el as SVGPathElement;
      const m = path.getScreenCTM()!;
      const q = path.getPointAtLength(path.getTotalLength() * 0.125);
      return [q.x * m.a + q.y * m.c + m.e, q.x * m.b + q.y * m.d + m.f];
    });
  await page.mouse.click(wing[0]!, wing[1]!);
  await expect(page.locator('.end-handle[data-end="to"]')).toBeVisible();
});

/** Hide what is drawn over the board in screen space: the line round a selection, the handles, the outline of a tie. Only the marks are compared. */
const hideOverlay = (page: Page) => page.addStyleTag({ content: '.overlay { visibility: hidden !important; }' });

for (const dpr of [1, 2]) {
  test.describe(`at pixel density ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });
    for (const z of [1, 4]) {
      test(`at ${z * 100}%, an arrow tied at both ends: not one pixel of it moves when it is saved`, async ({ page }) => {
        await open(page, '/?fixture=tools&at=1');
        await zoomTo(page, z);
        // Two boxes of the owner's on bare board, to tie to.
        for (const [x0, x1] of [
          [880, 960],
          [1100, 1180],
        ] as const) {
          await page.keyboard.press('b');
          await drag(page, [x0, 650], [x1, 760]);
          await page.keyboard.press('Enter');
        }
        await page.keyboard.press('Escape');
        await hideOverlay(page);
        const n = (await admitted(page)).length;
        await page.keyboard.press('a');
        // From inside the first box to 8 px short of the second: its spot, and the second by its outline.
        await drag(page, [920.3, 705.3], [1092.3, 705.3], { lift: false });
        const clip = { x: 890, y: 660, width: 208, height: 90 };
        const seenLive = await screenshotWhole(page, clip);
        await page.mouse.up();
        await page.keyboard.press('Enter');
        const [add] = await postedSince(page, n);
        expect(add!.item).toMatchObject({ kind: 'arrow', fromTie: { mode: 'inside' }, toTie: { mode: 'outline' } });
        await expect(page.locator('[data-testid="live"] svg.live-line')).toHaveCount(0);
        await page.keyboard.press('Escape');
        await page.mouse.move(300, 850);
        await nextFrame(page);
        expect(await pixelsApart(page, seenLive, await screenshotWhole(page, clip))).toBe(0);
      });

      test(`at ${z * 100}%, an end dragged to just short of a thing, where it ties: not one pixel of the arrow moves when it lands`, async ({ page }) => {
        await open(page, '/?fixture=tools&at=1');
        await zoomTo(page, z);
        await page.keyboard.press('b');
        await drag(page, [1100, 650], [1180, 760]);
        await page.keyboard.press('Enter');
        await page.keyboard.press('Escape');
        await page.keyboard.press('a');
        await drag(page, [900.3, 690.3], [1000.3, 740.3]);
        await page.keyboard.press('Enter');
        const handle = page.locator('.end-handle[data-end="to"]');
        await expect(handle).toBeVisible();
        const h = (await handle.boundingBox())!;
        await hideOverlay(page);
        const n = (await admitted(page)).length;
        // To 8 px short of the box: the head ties to it by its outline, and is drawn short of it.
        await drag(page, [h.x + h.width / 2, h.y + h.height / 2], [1092.3, 705.3], { lift: false });
        const clip = { x: 870, y: 650, width: 228, height: 110 };
        const whileHeld = await page.screenshot({ clip });
        await page.mouse.up();
        const [update] = await postedSince(page, n);
        expect(update!.patch?.arrowTo).toMatchObject({ tie: { mode: 'outline' } });
        await page.keyboard.press('Escape');
        await page.mouse.move(300, 850);
        await nextFrame(page);
        expect(await pixelsApart(page, whileHeld, await page.screenshot({ clip }))).toBe(0);
      });

      test(`at ${z * 100}%, an end dragged by its handle: not one pixel of the arrow moves when it lands`, async ({ page }) => {
        await open(page, '/?fixture=tools&at=1');
        await zoomTo(page, z);
        await page.keyboard.press('a');
        await drag(page, [900.3, 690.3], [1150.3, 700.3]);
        await page.keyboard.press('Enter');
        // The new arrow is selected: its end has a handle.
        const handle = page.locator('.end-handle[data-end="to"]');
        await expect(handle).toBeVisible();
        const h = (await handle.boundingBox())!;
        await hideOverlay(page);
        const n = (await admitted(page)).length;
        await drag(page, [h.x + h.width / 2, h.y + h.height / 2], [1100.3, 765.3], { lift: false });
        const clip = { x: 870, y: 650, width: 320, height: 140 };
        const whileHeld = await page.screenshot({ clip });
        await page.mouse.up();
        const [update] = await postedSince(page, n);
        expect(update!.patch?.arrowTo).toBeDefined();
        await page.keyboard.press('Escape');
        await page.mouse.move(300, 850);
        await nextFrame(page);
        expect(await pixelsApart(page, whileHeld, await page.screenshot({ clip }))).toBe(0);
      });
    }
  });
}
