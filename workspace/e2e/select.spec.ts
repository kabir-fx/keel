import { expect, test, type Locator, type Page } from '@playwright/test';
import { zoomTo } from './hand';
import { nextFrame, readCamera, syntheticWheel, wheel, type XY } from './pointer';

/**
 * Select in the system Chrome: what rests on the browser itself. A move stays under the pointer
 * when the wheel moves the camera; the line round what is selected is one pixel wide and four
 * out at any zoom; a box drawn round a card lets a press through to the card; the cursor; a note
 * resized is as tall as its words; snapping, the box that selects, and the arrow keys. The board
 * is the `tools` fixture: two notes of the owner's (m1 and m2) and two of the agent's pictures
 * (a1, with three questions, and a2).
 */

type Box4 = [number, number, number, number];
interface Admitted {
  type: string;
  item?: { id: string; kind: string; box: Box4 } | string;
  patch?: { box?: Box4 };
}

async function open(page: Page, fixture = 'tools&at=1') {
  await page.addInitScript(() => {
    const w = window as unknown as { __admitted: unknown[] };
    w.__admitted = [];
    window.addEventListener('keel:admit', (e) => w.__admitted.push((e as CustomEvent).detail));
  });
  await page.goto(`/?fixture=${fixture}`);
  await expect(page.getByTestId('board')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('[data-measure]')).toHaveCount(0);
  await page.waitForTimeout(500);
}

const admitted = (page: Page) => page.evaluate(() => (window as unknown as { __admitted: Admitted[] }).__admitted);

/** The changes of a box posted since `from`, by item. */
async function updatesSince(page: Page, from: number): Promise<Array<[string, Box4 | undefined]>> {
  return (await admitted(page)).slice(from).flatMap((e) => (e.type === 'item.update' && typeof e.item === 'string' ? [[e.item, e.patch?.box] as [string, Box4 | undefined]] : []));
}

async function rect(page: Page, selector: string) {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`${selector} is not on screen`);
  return b;
}

const selected = (page: Page) => page.locator('.layer .item--selected').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.item));

/** The cursor the page shows over a point: the computed cursor of what is under it. */
const cursorAt = (page: Page, [x, y]: XY) => page.evaluate(([px, py]) => getComputedStyle(document.elementFromPoint(px, py)!).cursor, [x, y] as const);

test('a wheel pan and a wheel zoom in the middle of a move leave the note under the pointer, and it lands there', async ({ page }) => {
  await open(page);
  const n = (await admitted(page)).length;
  const start = await rect(page, '[data-item="m2"]');
  const grab: XY = [start.x + 40, start.y + 20];
  const at: XY = [grab[0] + 150, grab[1] + 100];
  // Cmd held all through: the note is not pulled onto an edge it passes, so it stays exactly where the pointer holds it.
  await page.keyboard.down('Meta');
  await page.mouse.move(grab[0], grab[1]);
  await page.mouse.down();
  await page.mouse.move(at[0], at[1], { steps: 6 });
  await nextFrame(page);
  const held = await rect(page, '[data-item="m2"]');
  // Where on the note the pointer holds it.
  const u = (at[0] - held.x) / held.width;
  const v = (at[1] - held.y) / held.height;

  // The wheel turns under a pointer that stands still. It is built in the page, so it says no
  // Cmd: with Cmd the wheel zooms. No pointer event comes with it.
  const before = await readCamera(page);
  await syntheticWheel(page, { at, dx: 60, dy: 180 });
  expect(await readCamera(page)).not.toEqual(before);
  const panned = await rect(page, '[data-item="m2"]');
  expect(Math.abs(panned.x - held.x)).toBeLessThan(1);
  expect(Math.abs(panned.y - held.y)).toBeLessThan(1);

  const z = (await readCamera(page)).z;
  // A zoom about another point, so the world moves under the pointer.
  await syntheticWheel(page, { at: [at[0] - 300, at[1] - 200], dy: -10, ctrl: true });
  expect((await readCamera(page)).z).toBeGreaterThan(z);
  const zoomed = await rect(page, '[data-item="m2"]');
  expect(zoomed.width).toBeGreaterThan(held.width);
  expect(Math.abs(zoomed.x - held.x)).toBeGreaterThan(1);
  expect(Math.abs((at[0] - zoomed.x) / zoomed.width - u)).toBeLessThan(0.005);
  expect(Math.abs((at[1] - zoomed.y) / zoomed.height - v)).toBeLessThan(0.005);

  await page.mouse.up();
  await page.keyboard.up('Meta');
  await expect.poll(async () => (await updatesSince(page, n)).length).toBe(1);
  await nextFrame(page);
  const landed = await rect(page, '[data-item="m2"]');
  // It lands where it was drawn under the pointer: on whole units, so within a unit at this zoom.
  const unit = (await readCamera(page)).z;
  expect(Math.abs(landed.x - zoomed.x)).toBeLessThanOrEqual(unit);
  expect(Math.abs(landed.y - zoomed.y)).toBeLessThanOrEqual(unit);
});

/** How many pixels of keel's blue are in a strip of the page, one pixel high, from `x0` to `x1` at `y`. */
async function bluePixels(page: Page, x0: number, x1: number, y: number): Promise<number> {
  const png = await page.screenshot({ clip: { x: x0, y, width: x1 - x0, height: 1 } });
  return page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const g = new OffscreenCanvas(image.width, image.height).getContext('2d')!;
    g.drawImage(image, 0, 0);
    const d = g.getImageData(0, 0, image.width, image.height).data;
    let n = 0;
    // #1D4ED8, and what the page blends it to at the edge of a line is not counted.
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i]! - 0x1d) < 24 && Math.abs(d[i + 1]! - 0x4e) < 24 && Math.abs(d[i + 2]! - 0xd8) < 24) n++;
    return n;
  }, png.toString('base64'));
}

for (const z of [0.25, 4]) {
  test(`the line round a selected note is one pixel wide and four pixels out at ${z * 100}%`, async ({ page }) => {
    await open(page);
    await page.mouse.click((await rect(page, '[data-item="m1"]')).x + 20, (await rect(page, '[data-item="m1"]')).y + 20);
    await page.keyboard.press('2');
    await zoomTo(page, z);
    await nextFrame(page);
    const item = await rect(page, '[data-item="m1"]');
    const ring = await rect(page, '[data-ring="m1"]');
    expect(await page.locator('[data-ring="m1"]').evaluate((e) => getComputedStyle(e).borderTopWidth)).toBe('1px');
    // The line's inside edge is four pixels from the note on every side, to the half pixel the page rounds to.
    expect(Math.abs(item.x - (ring.x + 1) - 4)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(item.y - (ring.y + 1) - 4)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(ring.x + ring.width - 1 - (item.x + item.width) - 4)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(ring.y + ring.height - 1 - (item.y + item.height) - 4)).toBeLessThanOrEqual(0.5);
    // On the screen: one blue pixel where the line crosses a row, on each side.
    const row = Math.round(ring.y + ring.height / 2);
    expect(await bluePixels(page, Math.round(ring.x) - 3, Math.round(ring.x) + 4, row)).toBe(1);
    expect(await bluePixels(page, Math.round(ring.x + ring.width) - 4, Math.round(ring.x + ring.width) + 3, row)).toBe(1);
  });
}

test('a press inside a box drawn round a card reaches the card; a press on its line selects the box', async ({ page }) => {
  await open(page);
  const n = (await admitted(page)).length;
  const card = await rect(page, '[data-item="a1"]');
  await page.keyboard.press('b');
  await page.mouse.move(card.x - 20, card.y - 20);
  await page.mouse.down();
  await page.mouse.move(card.x + card.width + 20, card.y + card.height + 20, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await admitted(page)).slice(n).filter((e) => e.type === 'item.add').length).toBe(1);
  const add = (await admitted(page)).slice(n).find((e) => e.type === 'item.add')!;
  const boxId = (add.item as { id: string }).id;
  await expect(page.locator('[data-item="a1"]')).not.toHaveClass(/item--selected/);

  // Inside the box, on the card's first question: the card's.
  const q = await rect(page, '[data-item="a1"] [data-sub="q:1"]');
  await page.mouse.click(q.x + 10, q.y + q.height / 2);
  expect(await selected(page)).toEqual(['a1']);
  // On the box's line: the box's.
  const b = await rect(page, `[data-item="${boxId}"]`);
  await page.mouse.click(b.x + 1, b.y + b.height / 2);
  expect(await selected(page)).toEqual([boxId]);
});

test('the cursor: an open hand on a note and a picture, a closed hand while moving, the default on the ground, a crosshair with the pen and the eraser', async ({ page }) => {
  await open(page);
  const m1 = await rect(page, '[data-item="m1"]');
  const a1 = await rect(page, '[data-item="a1"]');
  const onNote: XY = [m1.x + 30, m1.y + 30];
  const onCard: XY = [a1.x + a1.width - 20, a1.y + 12];
  const ground: XY = [m1.x + m1.width + 30, m1.y + m1.height + 200];
  await page.mouse.move(...onNote);
  await nextFrame(page);
  expect(await cursorAt(page, onNote)).toBe('grab');
  await page.mouse.move(...onCard);
  await nextFrame(page);
  expect(await cursorAt(page, onCard)).toBe('grab');
  await page.mouse.move(...ground);
  await nextFrame(page);
  expect(await cursorAt(page, ground)).toBe('default');

  await page.mouse.move(...onNote);
  await nextFrame(page);
  await page.mouse.down();
  await page.mouse.move(onNote[0] + 40, onNote[1] + 30, { steps: 4 });
  await nextFrame(page);
  expect(await cursorAt(page, [onNote[0] + 40, onNote[1] + 30])).toBe('grabbing');
  await page.keyboard.press('Escape');
  await page.mouse.up();

  await page.keyboard.press('p');
  await page.mouse.move(...onNote);
  await nextFrame(page);
  expect(await cursorAt(page, onNote)).toBe('crosshair');
  // The eraser picks nothing up: a crosshair over a note and over the ground, as soon as it is in hand.
  await page.keyboard.press('v');
  await nextFrame(page);
  expect(await cursorAt(page, onNote)).toBe('grab');
  await page.keyboard.press('e');
  await nextFrame(page);
  expect(await cursorAt(page, onNote)).toBe('crosshair');
  await page.mouse.move(...ground);
  await nextFrame(page);
  expect(await cursorAt(page, ground)).toBe('crosshair');
});

test('the cursor: a pointer over a picture’s button with any tool, and the resize arrows on a box’s corner', async ({ page }) => {
  await open(page, 'engine-loop&at=3');
  const button = await rect(page, '[data-item="walk"] [aria-label="Next step"], [data-item="walk"] button');
  const on: XY = [button.x + button.width / 2, button.y + button.height / 2];
  for (const key of ['v', 'p', 'b']) {
    await page.keyboard.press(key);
    await page.mouse.move(on[0] - 1, on[1]);
    await page.mouse.move(...on);
    await nextFrame(page);
    expect(await cursorAt(page, on), key).toBe('pointer');
  }
  // A stroke that passes over the button keeps the pen's crosshair: during a press a control shows no cursor of its own.
  const walk = await rect(page, '[data-item="walk"]');
  await page.mouse.move(walk.x + 12, walk.y + 12);
  await page.mouse.down();
  await page.mouse.move(...on, { steps: 6 });
  await nextFrame(page);
  expect(await page.locator('.app').getAttribute('data-pressing')).toBe('');
  expect(await cursorAt(page, on)).toBe('crosshair');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.keyboard.press('Escape');

  // A box of the owner's: its corner handle and its edge show the arrows it resizes along.
  await page.keyboard.press('b');
  const ground: XY = [200, 760];
  await page.mouse.move(...ground);
  await page.mouse.down();
  await page.mouse.move(ground[0] + 160, ground[1] + 80, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.press('Enter');
  await expect(page.locator('.select-handle[data-handle="se"]')).toBeVisible();
  const se = await rect(page, '.select-handle[data-handle="se"]');
  const corner: XY = [se.x + se.width / 2, se.y + se.height / 2];
  await page.mouse.move(...corner);
  await nextFrame(page);
  expect(await cursorAt(page, corner)).toBe('nwse-resize');
});

test('a note resized by its edge is as wide as it is dragged and as tall as its words: one change on release', async ({ page }) => {
  await open(page);
  const n = (await admitted(page)).length;
  const m1 = await rect(page, '[data-item="m1"]');
  await page.mouse.click(m1.x + 20, m1.y + 20);
  const z = (await readCamera(page)).z;
  // The right edge, on the line four pixels out; dragged in by 160 units.
  const edge: XY = [m1.x + m1.width + 4, m1.y + m1.height / 2];
  await page.keyboard.down('Meta');
  await page.mouse.move(...edge);
  await page.mouse.down();
  await page.mouse.move(edge[0] - 160 * z, edge[1] + 40, { steps: 6 });
  await nextFrame(page);
  // While it is resized the words wrap, and the line round it follows the paper as the page lays it out.
  const note = await rect(page, '[data-item="m1"]');
  const ring = await rect(page, '[data-ring="m1"]');
  expect(note.height).toBeGreaterThan(m1.height);
  expect(Math.abs(ring.y + ring.height - 1 - (note.y + note.height) - 4)).toBeLessThanOrEqual(0.5);
  await page.mouse.up();
  await page.keyboard.up('Meta');
  await expect.poll(async () => (await updatesSince(page, n)).length).toBe(1);
  const [[id, box]] = (await updatesSince(page, n)) as [[string, Box4]];
  expect(id).toBe('m1');
  expect(box[0]).toBe(0);
  expect(box[2]).toBe(160);
  // Narrower, the words take more lines: the note is as tall as its paper, and taller than it was.
  await nextFrame(page);
  const paper = await page.locator('[data-item="m1"] .note').evaluate((e) => (e as HTMLElement).offsetHeight);
  expect(box[3]).toBe(paper);
  expect(box[3]).toBeGreaterThan(110);
});

test('a box resized by a corner at 400%: the corner across from it does not move by a pixel when the pointer lifts', async ({ page }) => {
  await open(page);
  let n = (await admitted(page)).length;
  // Drawn where the board's units fall between whole ones: its box begins on a fraction.
  await page.keyboard.press('b');
  await page.mouse.move(900, 560);
  await page.mouse.down();
  await page.mouse.move(1060, 640, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await admitted(page)).slice(n).filter((e) => e.type === 'item.add').length).toBe(1);
  const made = (await admitted(page)).slice(n).find((e) => e.type === 'item.add')!.item as { id: string; box: Box4 };
  expect(made.box[1] % 1).not.toBe(0);
  const drawn = `[data-item="${made.id}"] .drawn-box`;

  await zoomTo(page, 4);
  for (let i = 0; i < 8; i++) {
    const b = await rect(page, drawn);
    const [dx, dy] = [b.x + b.width / 2 - 720, b.y + b.height / 2 - 450];
    if (Math.abs(dx) < 40 && Math.abs(dy) < 40) break;
    await wheel(page, { at: [720, 450], dx, dy });
  }
  await nextFrame(page);
  const before = await rect(page, drawn);
  const se = await rect(page, '.select-handle[data-handle="se"]');
  const from: XY = [se.x + se.width / 2, se.y + se.height / 2];
  n = (await admitted(page)).length;
  await page.keyboard.down('Meta');
  await page.mouse.move(...from);
  await page.mouse.down();
  await page.mouse.move(from[0] + 41, from[1] + 22, { steps: 6 });
  await nextFrame(page);
  const held = await rect(page, drawn);
  expect([held.x, held.y]).toEqual([before.x, before.y]);
  await page.mouse.up();
  await page.keyboard.up('Meta');
  await expect.poll(async () => (await updatesSince(page, n)).length).toBe(1);
  const [[, box]] = (await updatesSince(page, n)) as [[string, Box4]];
  // The sides dragged land on whole units; the corner held keeps its fraction.
  expect([box[0], box[1]]).toEqual([made.box[0], made.box[1]]);
  expect([box[2] % 1, box[3] % 1]).toEqual([0, 0]);
  await nextFrame(page);
  await nextFrame(page);
  const after = await rect(page, drawn);
  expect([after.x, after.y]).toEqual([before.x, before.y]);
  // The sides it dragged are within half a unit of where the pointer left them: 2 px at this zoom.
  expect(Math.abs(after.width - held.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(after.height - held.height)).toBeLessThanOrEqual(2);
});

test('a move snaps to the edge of a note near it, with a guide while it does; Shift and a drag on the ground selects what the box holds', async ({ page }) => {
  await open(page);
  const n = (await admitted(page)).length;
  const m1 = await rect(page, '[data-item="m1"]');
  const m2 = await rect(page, '[data-item="m2"]');
  const z = (await readCamera(page)).z;
  // m2 sits under m1, both from x 0. Dragged 6 units right, it comes back onto m1's left edge.
  await page.mouse.move(m2.x + 30, m2.y + 20);
  await page.mouse.down();
  await page.mouse.move(m2.x + 30 + 6 * z, m2.y + 60, { steps: 4 });
  await nextFrame(page);
  await expect(page.getByTestId('snap-guides').locator('path')).toHaveAttribute('d', /^M/);
  await page.mouse.up();
  await expect.poll(async () => (await updatesSince(page, n)).at(-1)?.[1]?.[0]).toBe(0);
  await expect(page.getByTestId('snap-guides').locator('path')).toHaveAttribute('d', '');

  // Shift and a drag on the ground round both notes selects both; a plain drag looks round.
  const a = await rect(page, '[data-item="m1"]');
  const b = await rect(page, '[data-item="m2"]');
  await page.keyboard.down('Shift');
  await page.mouse.move(Math.min(a.x, b.x) - 20, a.y - 20);
  await page.mouse.down();
  await page.mouse.move(Math.max(a.x + a.width, b.x + b.width) + 20, b.y + b.height + 20, { steps: 6 });
  await expect(page.getByTestId('select-marquee')).toBeVisible();
  await page.mouse.up();
  await page.keyboard.up('Shift');
  expect(await selected(page)).toEqual(['m1', 'm2']);
  const before = await readCamera(page);
  await page.mouse.move(m1.x + m1.width + 60, m1.y + m1.height + 260);
  await page.mouse.down();
  await page.mouse.move(m1.x + m1.width + 160, m1.y + m1.height + 300, { steps: 4 });
  await page.mouse.up();
  expect((await readCamera(page)).x).toBeCloseTo(before.x + 100, 0);
  expect(await selected(page)).toEqual(['m1', 'm2']);
});

test('five arrow presses move the selected note by five units: one change, and one Undo takes it back', async ({ page }) => {
  await open(page);
  const n = (await admitted(page)).length;
  const m1 = await rect(page, '[data-item="m1"]');
  await page.mouse.click(m1.x + 20, m1.y + 20);
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  await expect.poll(async () => updatesSince(page, n)).toEqual([['m1', [5, 0, 320, 110]]]);
  const z = (await readCamera(page)).z;
  expect((await rect(page, '[data-item="m1"]')).x).toBeCloseTo(m1.x + 5 * z, 1);
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => updatesSince(page, n)).toEqual([
    ['m1', [5, 0, 320, 110]],
    ['m1', [0, 0, 320, 110]],
  ]);
  // The note is drawn back where it was: nothing the keys drew ahead of the log is left over it.
  await expect.poll(async () => (await rect(page, '[data-item="m1"]')).x).toBeCloseTo(m1.x, 1);
});

/** Where a lineage arrow ends on the page: the last point of its line. */
const arrowEnd = (page: Page, edge: string) =>
  page.locator(`[data-lineage="${edge}"]`).evaluate((el) => {
    const path = el as SVGPathElement;
    const at = path.getPointAtLength(path.getTotalLength()).matrixTransform(path.getScreenCTM()!);
    return [at.x, at.y] as [number, number];
  });

/** How far a page point is from a box on the page: nothing when it is inside. */
const gapTo = ([x, y]: XY, b: { x: number; y: number; width: number; height: number }) => Math.hypot(Math.max(b.x - x, 0, x - (b.x + b.width)), Math.max(b.y - y, 0, y - (b.y + b.height)));

test('the lineage arrow into a picture stays on the picture while it is dragged, and does not jump when it lands', async ({ page }) => {
  await open(page);
  const n = (await admitted(page)).length;
  const z = (await readCamera(page)).z;
  // The arrow stops a few units short of the card. A little more is let through for the rounding of the page.
  const near = 6 * z + 3;
  const a1 = await rect(page, '[data-item="a1"]');
  expect(gapTo(await arrowEnd(page, 'm1>a1'), a1)).toBeLessThan(near);
  // Grabbed by its title bar, clear of its questions; Cmd held, so nothing snaps.
  const from: XY = [a1.x + a1.width - 30, a1.y + 12];
  await page.keyboard.down('Meta');
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(from[0] + 90, from[1] + 160, { steps: 6 });
  await nextFrame(page);
  expect(await updatesSince(page, n)).toEqual([]);
  const held = await rect(page, '[data-item="a1"]');
  expect(held.y).toBeCloseTo(a1.y + 160, 0);
  const whileHeld = await arrowEnd(page, 'm1>a1');
  expect(gapTo(whileHeld, held)).toBeLessThan(near);
  await page.mouse.up();
  await page.keyboard.up('Meta');
  await expect.poll(async () => (await updatesSince(page, n)).length).toBe(1);
  await nextFrame(page);
  const landed = await arrowEnd(page, 'm1>a1');
  expect(Math.hypot(landed[0] - whileHeld[0], landed[1] - whileHeld[1])).toBeLessThan(1);
});

test('ink on a card stays over the card while the card is dragged: it is not hidden under it', async ({ page }) => {
  await open(page);
  const a1 = await rect(page, '[data-item="a1"]');
  await page.keyboard.press('p');
  await page.mouse.move(a1.x + a1.width - 120, a1.y + a1.height - 30);
  await page.mouse.down();
  await page.mouse.move(a1.x + a1.width - 40, a1.y + a1.height - 20, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.press('v');
  await expect(page.locator('.layer [data-kind="ink"]')).toHaveCount(1);
  /** How far the ink is over the card in the stack: both lie in one layer, so the higher number is drawn on top. */
  const over = () =>
    page.evaluate(() => {
      const z = (selector: string) => Number(getComputedStyle(document.querySelector(selector)!).zIndex);
      return z('.layer [data-kind="ink"]') - z('[data-item="a1"]');
    });
  expect(await over()).toBeGreaterThan(0);
  const from: XY = [a1.x + a1.width - 30, a1.y + 12];
  await page.keyboard.down('Meta');
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(from[0] + 60, from[1] + 120, { steps: 5 });
  await nextFrame(page);
  expect(await page.locator('[data-item="a1"]').evaluate((el) => el.classList.contains('item--dragging'))).toBe(true);
  expect(await over()).toBeGreaterThan(0);
  await page.mouse.up();
  await page.keyboard.up('Meta');
  await nextFrame(page);
  expect(await over()).toBeGreaterThan(0);
});

test('in a focus view a dragged note is lifted too: over the ink beside it, which the rules that raise things would leave on top', async ({ page }) => {
  await open(page, 'engine-loop&at=4');
  await expect(page.locator('.app')).toHaveAttribute('data-focus', 'focus');
  // A note written on the focus picture hangs on it, and stands above the dim with it.
  const picture = await rect(page, '[data-item="focus"]');
  await page.keyboard.press('n');
  await page.mouse.click(picture.x + picture.width / 2, picture.y + 40);
  await page.keyboard.type('a note on the picture');
  await page.keyboard.press('Enter');
  await page.keyboard.press('v');
  const note = page.locator('.item--note.item--raised').last();
  await expect(note).toBeVisible();
  const layer = (of: Locator) => of.first().evaluate((el) => Number(getComputedStyle(el).zIndex));
  const ink = page.locator('[data-item="cross-queue"]');
  await expect(ink).toHaveClass(/item--raised/);
  // At rest the ink lies over the note, as it does on the board.
  expect(await layer(note)).toBeLessThan(await layer(ink));
  const at = (await note.boundingBox())!;
  await page.mouse.move(at.x + 20, at.y + 10);
  await page.mouse.down();
  await page.mouse.move(at.x + 80, at.y + 60, { steps: 6 });
  await nextFrame(page);
  await expect(note).toHaveClass(/item--dragging/);
  expect(await layer(note)).toBeGreaterThan(await layer(ink));
  // And over the picture it hangs on, and the dim.
  expect(await layer(note)).toBeGreaterThan(await layer(page.locator('[data-item="focus"]')));
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.item--dragging')).toHaveCount(0);
});

test('a note’s edge dragged out and back posts nothing, and the note keeps its height', async ({ page }) => {
  await open(page);
  const n = (await admitted(page)).length;
  const m2 = await rect(page, '[data-item="m2"]');
  await page.mouse.click(m2.x + 20, m2.y + 20);
  expect(await selected(page)).toEqual(['m2']);
  // The right edge of the line round it, 4 px out; Cmd held, so nothing snaps.
  const edge: XY = [m2.x + m2.width + 4, m2.y + m2.height / 2];
  await page.keyboard.down('Meta');
  await page.mouse.move(edge[0], edge[1]);
  await page.mouse.down();
  await page.mouse.move(edge[0] + 80, edge[1], { steps: 4 });
  await nextFrame(page);
  expect((await rect(page, '[data-item="m2"]')).width).toBeGreaterThan(m2.width + 40);
  await page.mouse.move(edge[0], edge[1], { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Meta');
  await nextFrame(page);
  await page.waitForTimeout(200);
  expect(await updatesSince(page, n)).toEqual([]);
  const after = await rect(page, '[data-item="m2"]');
  expect([after.width, after.height]).toEqual([m2.width, m2.height]);
});
