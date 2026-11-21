import { expect, test, type Page } from '@playwright/test';
import { zoomTo } from './hand';
import { nextFrame, readCamera, wheel } from './pointer';

/**
 * The eraser and the live lasso on the system Chrome: what the eraser reaches fades under a grey
 * trail and goes when the pointer lifts, as one step Undo brings back; a lasso being drawn is a
 * trail with marching dashes, and what it holds lights up until the pointer lifts. The page is
 * the app's own `tools` fixture, which announces each admitted event as a `keel:admit` event.
 */

interface Admitted {
  type: string;
  item?: { id: string; kind: string; targets?: Array<{ item: string }> } | string;
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

/** What was admitted since `from`, as its type and the item it was on. */
const since = async (page: Page, from: number) => (await admitted(page)).slice(from).map((e) => [e.type, typeof e.item === 'string' ? e.item : e.item?.id]);

/** Draw one stroke with the button down, through these page points. */
async function stroke(page: Page, pts: ReadonlyArray<readonly [number, number]>) {
  await page.mouse.move(pts[0]![0], pts[0]![1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(x, y);
  await page.mouse.up();
}

/** Draw a stroke with the pen and wait for its ink mark to reach the board. Answers its id. */
async function ink(page: Page, pts: ReadonlyArray<readonly [number, number]>): Promise<string> {
  const n = (await admitted(page)).length;
  await page.keyboard.press('p');
  await stroke(page, pts);
  await expect.poll(async () => (await admitted(page)).slice(n).filter((e) => e.type === 'item.add').length, { timeout: 5000 }).toBe(1);
  const add = (await admitted(page)).slice(n).find((e) => e.type === 'item.add')!;
  return (add.item as { id: string }).id;
}

const upright = (x: number, y0: number, y1: number): Array<[number, number]> => Array.from({ length: 13 }, (_, i) => [x, y0 + ((y1 - y0) * i) / 12]);

test('one sweep of the eraser over two strokes: both fade, both go when it lifts, and one Undo brings both back', async ({ page }) => {
  await open(page);
  const one = await ink(page, upright(900, 560, 720));
  const two = await ink(page, upright(1040, 560, 720));
  const n0 = (await admitted(page)).length;

  await page.keyboard.press('e');
  await expect(page.getByRole('button', { name: 'Erase your ink, boxes, arrows and pins, or a picture' })).toHaveAttribute('aria-pressed', 'true');
  // A fast sweep: three samples, each far from the last, crossing both strokes between them.
  await page.mouse.move(820, 640);
  await page.mouse.down();
  await page.mouse.move(970, 642);
  await page.mouse.move(1120, 644);
  await nextFrame(page);
  for (const id of [one, two]) {
    await expect(page.locator(`[data-item="${id}"]`)).toHaveAttribute('data-erasing', '');
    // Faded to a fifth, and still on the board.
    expect(await page.locator(`[data-item="${id}"]`).evaluate((el) => getComputedStyle(el).opacity)).toBe('0.2');
  }
  // Its trail is a soft grey from keel's own palette.
  const trail = page.locator('[data-testid="trails"] path.trail--eraser');
  await expect(trail).toHaveCount(1);
  expect(await trail.evaluate((el) => [getComputedStyle(el).fill, getComputedStyle(el).fillOpacity])).toEqual(['rgb(142, 153, 171)', '0.4']);
  expect(await since(page, n0)).toEqual([]);

  await page.mouse.up();
  await expect.poll(() => since(page, n0)).toEqual([
    ['item.remove', one],
    ['item.remove', two],
  ]);
  await expect(page.locator(`[data-item="${one}"]`)).toHaveCount(0);
  await expect(page.locator(`[data-item="${two}"]`)).toHaveCount(0);
  // With "reduce motion", as every test page asks, the trail goes with the press.
  await expect(page.locator('[data-testid="trails"] path')).toHaveCount(0);

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await since(page, n0)).slice(2).map(([type]) => type)).toEqual(['item.restore', 'item.restore']);
  for (const id of [one, two]) {
    await expect(page.locator(`[data-item="${id}"] svg.ink`)).toBeVisible();
    await expect(page.locator(`[data-item="${id}"]`)).not.toHaveAttribute('data-erasing');
  }
});

test('with motion, the eraser’s trail fades behind the pointer to a dot under it, and is gone soon after the lift', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await open(page);
  await page.keyboard.press('e');
  await page.mouse.move(820, 640);
  await page.mouse.down();
  await page.mouse.move(1120, 640, { steps: 20 });
  await nextFrame(page);
  const trail = page.locator('[data-testid="trails"] path.trail--eraser');
  const moving = (await trail.boundingBox())!;
  expect(moving.width).toBeGreaterThan(40);
  // The pointer rests: the line behind it fades, and a dot of 5 px stays under it.
  await page.waitForTimeout(400);
  const dot = (await trail.boundingBox())!;
  expect(dot.width).toBeLessThan(12);
  expect(dot.height).toBeLessThan(12);
  expect(Math.abs(dot.x + dot.width / 2 - 1120)).toBeLessThan(4);
  await page.mouse.up();
  await expect(page.locator('[data-testid="trails"] path')).toHaveCount(0, { timeout: 1000 });
});

/** The id of the one mark of this kind admitted since `from`. */
async function made(page: Page, from: number, kind: string): Promise<string> {
  const ofKind = async () => (await admitted(page)).slice(from).filter((e) => e.type === 'item.add' && typeof e.item === 'object' && e.item.kind === kind);
  await expect.poll(async () => (await ofKind()).length, { timeout: 5000 }).toBe(1);
  return ((await ofKind())[0]!.item as { id: string }).id;
}

/** Pan with the wheel until what `selector` draws is about the middle of the board. */
async function bringToMiddle(page: Page, selector: string) {
  for (let i = 0; i < 8; i++) {
    const b = await page.locator(selector).first().boundingBox();
    if (!b) throw new Error(`${selector} is not drawn`);
    const [dx, dy] = [b.x + b.width / 2 - 720, b.y + b.height / 2 - 450];
    if (Math.abs(dx) < 40 && Math.abs(dy) < 40) return;
    await wheel(page, { at: [720, 450], dx, dy });
  }
}

/** Press the eraser at a page point, say whether the thing faded, and end the press with Esc so nothing is taken off. */
async function fadesAt(page: Page, id: string, x: number, y: number): Promise<boolean> {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await nextFrame(page);
  const faded = (await page.locator(`[data-item="${id}"]`).getAttribute('data-erasing')) !== null;
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await nextFrame(page);
  return faded;
}

// The eraser works out what it reaches from numbers that mirror the styles (a box's line, an
// arrow's line, a pin's icon: `markSizes.ts`). Only the browser can say they are what is drawn.
for (const z of [0.25, 1, 4]) {
  test(`at ${z * 100}% the eraser reaches a box's line, an arrow's line and a pin's icon exactly as far as Chrome draws them`, async ({ page }) => {
    await open(page);
    let n = (await admitted(page)).length;
    await page.keyboard.press('b');
    await stroke(page, [[900, 600], [970, 640], [1040, 680]]);
    await page.keyboard.type('x');
    await page.keyboard.press('Enter');
    const box = await made(page, n, 'box');
    n = (await admitted(page)).length;
    await page.keyboard.press('a');
    await stroke(page, [[900, 720], [1000, 745], [1100, 770]]);
    await page.keyboard.type('y');
    await page.keyboard.press('Enter');
    const arrow = await made(page, n, 'arrow');
    n = (await admitted(page)).length;
    const m2 = (await page.locator('[data-item="m2"]').boundingBox())!;
    await page.keyboard.press('i');
    await page.mouse.click(m2.x + 60, m2.y + m2.height / 2);
    await page.keyboard.press('Enter');
    const pin = await made(page, n, 'pin');
    await page.keyboard.press('Escape');

    await zoomTo(page, z);
    expect((await readCamera(page)).z).toBe(z);
    // The eraser reaches 5 px past a line, and never less than 2.25 board units.
    const reach = Math.max(2.25 * z, 5);
    await page.keyboard.press('e');

    // The box, from above its top edge and from inside it, below its line 2.5 units wide.
    await bringToMiddle(page, `[data-item="${box}"] .drawn-box`);
    const b = (await page.locator(`[data-item="${box}"] .drawn-box`).boundingBox())!;
    const bx = b.x + b.width / 2;
    expect(await fadesAt(page, box, bx, b.y - (reach - 1)), 'box, just in reach from outside').toBe(true);
    expect(await fadesAt(page, box, bx, b.y - (reach + 1)), 'box, just out of reach from outside').toBe(false);
    const inner = b.y + 2.5 * z;
    expect(await fadesAt(page, box, bx, inner + (reach - 1)), 'box, just in reach from inside').toBe(true);
    expect(await fadesAt(page, box, bx, inner + (reach + 1)), 'box, just out of reach from inside').toBe(false);

    // The arrow, off the side of its line, which is 3 px wide on screen at any zoom.
    await bringToMiddle(page, `[data-item="${arrow}"] svg.line-mark`);
    const line = await page.locator(`[data-item="${arrow}"] svg.line-mark > path`).first().evaluate((el) => {
      const path = el as SVGPathElement;
      const m = path.getScreenCTM()!;
      const at = (len: number) => {
        const q = path.getPointAtLength(len);
        return [q.x * m.a + q.y * m.c + m.e, q.x * m.b + q.y * m.d + m.f] as const;
      };
      const total = path.getTotalLength();
      return { a: at(0), b: at(total), on: at(total * 0.3) };
    });
    const len = Math.hypot(line.b[0] - line.a[0], line.b[1] - line.a[1]);
    const [nx, ny] = [-(line.b[1] - line.a[1]) / len, (line.b[0] - line.a[0]) / len];
    const off = (d: number) => [line.on[0] + nx * d, line.on[1] + ny * d] as const;
    expect(await fadesAt(page, arrow, ...off(reach + 1.5 - 1)), 'arrow, just in reach').toBe(true);
    expect(await fadesAt(page, arrow, ...off(reach + 1.5 + 1)), 'arrow, just out of reach').toBe(false);

    // The pin, from the left of its icon, and inside it.
    await bringToMiddle(page, `[data-item="${pin}"] .pin__icon`);
    const p = (await page.locator(`[data-item="${pin}"] .pin__icon`).boundingBox())!;
    expect(p.width).toBeCloseTo(26 * z, 1);
    expect(await fadesAt(page, pin, p.x - (reach - 1), p.y + p.height / 2), 'pin, just in reach').toBe(true);
    expect(await fadesAt(page, pin, p.x - (reach + 1), p.y + p.height / 2), 'pin, just out of reach').toBe(false);
    expect(await fadesAt(page, pin, p.x + p.width / 2, p.y + p.height / 2), 'pin, inside its icon').toBe(true);

    // The trail's dot is under the pointer, after the zoom and the pans.
    await page.mouse.move(700, 300);
    await page.mouse.down();
    await nextFrame(page);
    const dot = (await page.locator('[data-testid="trails"] path.trail--eraser').boundingBox())!;
    expect(Math.abs(dot.x + dot.width / 2 - 700)).toBeLessThan(0.5);
    expect(Math.abs(dot.y + dot.height / 2 - 300)).toBeLessThan(0.5);
    await page.keyboard.press('Escape');
    await page.mouse.up();
  });
}

test('the eraser takes the agent’s picture off as Delete does, and Undo puts it back; a sweep over a line drawn on it takes only the line', async ({ page }) => {
  await open(page);
  const card = (await page.locator('[data-item="a1"]').boundingBox())!;
  // A line of the owner's across the lower part of the card.
  const y = card.y + card.height - 30;
  const line = await ink(page, Array.from({ length: 9 }, (_, i): [number, number] => [card.x + 40 + i * 20, y]));
  await page.keyboard.press('e');

  // Down across the line: the line fades, the card under it does not, and only the line goes.
  let n = (await admitted(page)).length;
  const x = card.x + 100;
  await page.mouse.move(x, y - 40);
  await page.mouse.down();
  await page.mouse.move(x, y + 10, { steps: 6 });
  await nextFrame(page);
  await expect(page.locator(`[data-item="${line}"]`)).toHaveAttribute('data-erasing', '');
  await expect(page.locator('[data-item="a1"]')).not.toHaveAttribute('data-erasing');
  await page.mouse.up();
  await expect.poll(() => since(page, n)).toEqual([['item.remove', line]]);

  // A sweep inside the card, on nothing of the owner's: the card fades, and goes when the pointer lifts.
  n = (await admitted(page)).length;
  await page.mouse.move(card.x + card.width - 60, card.y + 20);
  await page.mouse.down();
  await page.mouse.move(card.x + card.width - 30, card.y + 40, { steps: 4 });
  await nextFrame(page);
  await expect(page.locator('[data-item="a1"]')).toHaveAttribute('data-erasing', '');
  await page.mouse.up();
  await expect.poll(() => since(page, n)).toEqual([['item.remove', 'a1']]);
  await expect(page.locator('[data-item="a1"]')).toHaveCount(0);
  await expect(page.getByText(/^Taken off the board\. Undo \(.+\) puts it back\.$/)).toBeVisible();

  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await since(page, n)).slice(1)).toEqual([['item.restore', 'a1']]);
  await expect(page.locator('[data-item="a1"]')).toBeVisible();
  await expect(page.locator('[data-item="a1"]')).not.toHaveAttribute('data-erasing');
});

test('in the focus view the eraser reaches only what stands above the dim', async ({ page }) => {
  await open(page, 'engine-loop&at=4');
  await expect(page.locator('.app')).toHaveAttribute('data-focus', 'focus');
  const n0 = (await admitted(page)).length;
  await page.keyboard.press('e');
  /** Sweep across everything a selector draws, corner to corner both ways, and leave the pointer down. */
  const sweepOver = async (selector: string) => {
    await bringToMiddle(page, selector);
    const r = (await page.locator(selector).first().boundingBox())!;
    await page.mouse.move(r.x - 8, r.y - 8);
    await page.mouse.down();
    await page.mouse.move(r.x + r.width + 8, r.y + r.height + 8, { steps: 12 });
    await page.mouse.move(r.x + r.width + 8, r.y - 8, { steps: 4 });
    await page.mouse.move(r.x - 8, r.y + r.height + 8, { steps: 12 });
    await nextFrame(page);
  };

  // Ink that lies under the dim: the sweep goes right across it, and it stays.
  await expect(page.locator('[data-item="cross-b"]')).not.toHaveClass(/item--raised/);
  await sweepOver('[data-item="cross-b"] svg.ink');
  await expect(page.locator('.app')).toHaveAttribute('data-focus', 'focus');
  await expect(page.locator('[data-erasing]')).toHaveCount(0);
  await page.mouse.up();
  await nextFrame(page);
  expect(await since(page, n0)).toEqual([]);

  // Ink above the dim fades under the same sweep.
  await expect(page.locator('[data-item="cross-queue"]')).toHaveClass(/item--raised/);
  await sweepOver('[data-item="cross-queue"] svg.ink');
  await expect(page.locator('[data-item="cross-queue"]')).toHaveAttribute('data-erasing', '');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect(await since(page, n0)).toEqual([]);
});

test('Esc in the middle of a sweep brings everything back, and nothing is posted', async ({ page }) => {
  await open(page);
  const one = await ink(page, upright(900, 560, 720));
  const n0 = (await admitted(page)).length;
  await page.keyboard.press('e');
  await page.mouse.move(820, 640);
  await page.mouse.down();
  await page.mouse.move(1000, 640, { steps: 6 });
  await nextFrame(page);
  await expect(page.locator(`[data-item="${one}"]`)).toHaveAttribute('data-erasing', '');
  await page.keyboard.press('Escape');
  await expect(page.locator(`[data-item="${one}"]`)).not.toHaveAttribute('data-erasing');
  expect(await page.locator(`[data-item="${one}"]`).evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  await expect(page.locator('[data-testid="trails"] path')).toHaveCount(0);
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect(await since(page, n0)).toEqual([]);
});

test('a lasso being drawn is a trail with marching dashes, and what it holds lights up until it lifts', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await open(page);
  const n0 = (await admitted(page)).length;
  await page.keyboard.press('l');
  const m1 = (await page.locator('[data-item="m1"]').boundingBox())!;
  const [l, t, r, b] = [m1.x - 30, m1.y - 30, m1.x + m1.width + 30, m1.y + m1.height + 30];
  await page.mouse.move(l, t);
  await page.mouse.down();
  await page.mouse.move(r, t, { steps: 8 });
  await nextFrame(page);
  // Not yet round it: nothing lit.
  await expect(page.locator('[data-item="m1"]')).not.toHaveAttribute('data-lassoed');
  await page.mouse.move(r, b, { steps: 8 });
  await page.mouse.move(l, b, { steps: 8 });
  await nextFrame(page);
  await expect(page.locator('[data-item="m1"]')).toHaveAttribute('data-lassoed', '');
  await expect(page.locator('[data-item="m2"]')).not.toHaveAttribute('data-lassoed');
  // The note's paper shows the light: an outline in the owner's soft orange.
  expect(await page.locator('[data-item="m1"] > .note').evaluate((el) => getComputedStyle(el).outlineColor)).toBe('rgb(242, 185, 143)');
  const trail = page.locator('[data-testid="trails"] path.trail--lasso');
  await expect(trail).toHaveCount(1);
  expect(await trail.evaluate((el) => getComputedStyle(el).strokeDasharray)).toBe('7px, 7px');
  expect(await trail.evaluate((el) => getComputedStyle(el).animationName)).toBe('trail-march');
  // The dashes march one dash and one gap, 14 px, in 0.3 s, and on for as long as it is drawn.
  const march = await trail.evaluate((el) => {
    const a = el.getAnimations()[0]!;
    const timing = a.effect!.getComputedTiming();
    return { frames: (a.effect as KeyframeEffect).getKeyframes().map((k) => k.strokeDashoffset), ms: timing.duration, times: timing.iterations };
  });
  expect(march).toEqual({ frames: ['0px', '-14px'], ms: 300, times: Infinity });
  // The trail runs round the note on screen.
  const drawn = (await trail.boundingBox())!;
  expect(drawn.x).toBeLessThan(m1.x);
  expect(drawn.x + drawn.width).toBeGreaterThan(m1.x + m1.width);

  // With "reduce motion" the dashes stand still.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await trail.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  await page.mouse.move(l, t + 10, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator('[data-item="m1"]')).not.toHaveAttribute('data-lassoed');
  await expect(page.locator('[data-testid="trails"] path')).toHaveCount(0);
  await expect.poll(async () => (await admitted(page)).slice(n0).find((e) => e.type === 'item.add')?.item).toMatchObject({ kind: 'lasso', targets: [{ item: 'm1' }] });
});

/** Draw a loop round a page box with the lasso, and keep the pointer down. */
async function loopRound(page: Page, b: { x: number; y: number; width: number; height: number }, room: number) {
  const [l, t, r, d] = [b.x - room, b.y - room, b.x + b.width + room, b.y + b.height + room];
  await page.mouse.move(l, t);
  await page.mouse.down();
  for (const [x, y] of [[r, t], [r, d], [l, d], [l, t + 10]] as const) await page.mouse.move(x, y, { steps: 8 });
  await nextFrame(page);
}

test('a loop round a card lights the card; a loop round one question in it lights that question alone', async ({ page }) => {
  await open(page);
  await page.keyboard.press('l');
  const soft = 'rgb(242, 185, 143)';
  await loopRound(page, (await page.locator('[data-item="a1"]').boundingBox())!, 20);
  await expect(page.locator('[data-item="a1"]')).toHaveAttribute('data-lassoed', '');
  expect(await page.locator('[data-item="a1"] > *').first().evaluate((el) => [getComputedStyle(el).outlineStyle, getComputedStyle(el).outlineColor])).toEqual(['solid', soft]);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('[data-item="a1"]')).not.toHaveAttribute('data-lassoed');

  const q = page.locator('[data-item="a1"] [data-sub="q:2"]');
  await loopRound(page, (await q.boundingBox())!, 6);
  await expect(q).toHaveAttribute('data-lassoed', '');
  await expect(page.locator('[data-item="a1"]')).not.toHaveAttribute('data-lassoed');
  expect(await q.evaluate((el) => [getComputedStyle(el).outlineStyle, getComputedStyle(el).outlineColor])).toEqual(['solid', soft]);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(q).not.toHaveAttribute('data-lassoed');
});

test('ink and a pin the loop holds light up too', async ({ page }) => {
  await open(page);
  const id = await ink(page, upright(900, 560, 720));
  // A pin on the second note.
  const m2 = (await page.locator('[data-item="m2"]').boundingBox())!;
  const n = (await admitted(page)).length;
  await page.keyboard.press('i');
  await page.mouse.click(m2.x + 60, m2.y + m2.height / 2);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await admitted(page)).slice(n).filter((e) => e.type === 'item.add').length).toBe(1);
  const pin = ((await admitted(page)).slice(n).find((e) => e.type === 'item.add')!.item as { id: string }).id;

  await page.keyboard.press('l');
  await loopRound(page, (await page.locator(`[data-item="${id}"] svg.ink`).boundingBox())!, 20);
  await expect(page.locator(`[data-item="${id}"]`)).toHaveAttribute('data-lassoed', '');
  expect(await page.locator(`[data-item="${id}"] > svg.ink`).evaluate((el) => getComputedStyle(el).filter)).toContain('drop-shadow(rgb(242, 185, 143)');
  await page.keyboard.press('Escape');
  await page.mouse.up();

  await loopRound(page, (await page.locator(`[data-item="${pin}"] .pin__icon`).boundingBox())!, 20);
  await expect(page.locator(`[data-item="${pin}"]`)).toHaveAttribute('data-lassoed', '');
  expect(await page.locator(`[data-item="${pin}"] .pin__icon`).evaluate((el) => getComputedStyle(el).strokeWidth)).toBe('2.6px');
  await page.keyboard.press('Escape');
  await page.mouse.up();
});
