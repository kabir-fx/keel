import { expect, test, type Page } from '@playwright/test';
import { nextFrame, readCamera, worldToPage, type XY } from './pointer';

/**
 * The pointer on the board, end to end on the system Chrome with real mouse and key events: the
 * pen on a picture's button, the right button, a press the browser takes away, and Esc in the
 * middle of a press. A `pointercancel` cannot be made by a real mouse, so it is dispatched in
 * the page, for the pointer the real press used. The fixture page announces each admitted event
 * as a `keel:admit` window event.
 */

interface Admitted {
  type: string;
  item?: { id: string; kind: string; box: [number, number, number, number] } | string;
}

interface Seen {
  __admitted: Admitted[];
  /** Every context menu asked for: true where the page stopped it. */
  __menus: boolean[];
  /** The pointer id of the last press, as the browser gave it. */
  __pointer: number;
}

/** The pen's pause, and a little more: after it, a go of the pen has become a mark. */
const PEN_RESTS = 1000;

async function open(page: Page, fixture: string) {
  await page.addInitScript(() => {
    const w = window as unknown as Seen;
    w.__admitted = [];
    w.__menus = [];
    window.addEventListener('keel:admit', (e) => w.__admitted.push((e as CustomEvent).detail));
    // The window hears an event after the board has: by then the board has stopped it, or not.
    window.addEventListener('contextmenu', (e) => w.__menus.push(e.defaultPrevented));
    window.addEventListener('pointerdown', (e) => (w.__pointer = e.pointerId), true);
  });
  await page.goto(`/?fixture=${fixture}`);
  await expect(page.getByTestId('board')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('[data-measure]')).toHaveCount(0);
  await page.waitForTimeout(600);
}

const admitted = (page: Page) => page.evaluate(() => (window as unknown as Seen).__admitted);
const menus = (page: Page) => page.evaluate(() => (window as unknown as Seen).__menus);
const liveInk = (page: Page) => page.getByTestId('live').locator('svg.ink');
const toolButton = (page: Page, name: string) => page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name });

/** The marks added since the first `from` admitted events. */
async function addsSince(page: Page, from: number) {
  return (await admitted(page)).slice(from).filter((e) => e.type === 'item.add');
}

/** Take the pointer away in the middle of the press, as the browser does for a system gesture. */
async function cancelPress(page: Page) {
  await page.evaluate(() => {
    const board = document.querySelector('[data-testid="board"]')!;
    board.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: (window as unknown as Seen).__pointer, pointerType: 'mouse' }));
  });
}

/** The walk's Next button, the step the walk is on, and a point of bare ground. */
const next = (page: Page) => page.locator('[data-item="walk"]').getByRole('button', { name: 'Next step' });
const step = (page: Page) => page.locator('[data-item="walk"] [data-kind="walk"]').getAttribute('data-step');

async function centre(page: Page, selector: ReturnType<Page['locator']>): Promise<XY> {
  const b = await selector.boundingBox();
  if (!b) throw new Error('not on screen');
  return [b.x + b.width / 2, b.y + b.height / 2];
}

test('the pen on a picture’s button: a click presses the button and makes no ink; a drag from it draws from the first point', async ({ page }) => {
  await open(page, 'engine-loop&at=3');
  await page.keyboard.press('p');
  await expect(toolButton(page, 'Draw with the pen')).toHaveAttribute('aria-pressed', 'true');
  expect(await step(page)).toBe('8');
  const [x, y] = await centre(page, next(page));

  // A click: the button is pressed, and no ink is made, now or when the pen has rested.
  const n = (await admitted(page)).length;
  await page.mouse.click(x, y);
  await expect.poll(() => step(page)).toBe('9');
  await expect(liveInk(page)).toHaveCount(0);
  await page.waitForTimeout(PEN_RESTS);
  expect(await addsSince(page, n)).toHaveLength(0);

  // A press that wanders 3 px before it lifts is still a click.
  await page.mouse.move(x - 1, y);
  await page.mouse.down();
  await page.mouse.move(x + 2, y, { steps: 3 });
  await page.mouse.up();
  await expect.poll(() => step(page)).toBe('10');
  await expect(liveInk(page)).toHaveCount(0);

  // A drag that starts on the button: the button is not pressed, and the ink starts where the press went down.
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 6, y);
  await nextFrame(page);
  await expect(liveInk(page)).toHaveCount(0);
  await page.mouse.move(x + 40, y + 30, { steps: 6 });
  await nextFrame(page);
  await expect(liveInk(page)).toHaveCount(1);
  await page.mouse.up();
  await page.waitForTimeout(PEN_RESTS);
  expect(await step(page)).toBe('10');
  const adds = await addsSince(page, n);
  expect(adds).toHaveLength(1);
  const ink = adds[0]!.item as { kind: string; box: [number, number, number, number] };
  expect(ink.kind).toBe('ink');
  const [left, top] = await worldToPage(page, [ink.box[0], ink.box[1]]);
  const z = (await readCamera(page)).z;
  expect(Math.abs(left - x)).toBeLessThan(1.5);
  expect(Math.abs(top - y)).toBeLessThan(1.5);
  expect(Math.abs(ink.box[2] * z - 40)).toBeLessThan(1.5);

  // The button still works after the drag.
  await page.mouse.click(x, y);
  await expect.poll(() => step(page)).toBe('11');
});

test('Esc while the pen is held on a button takes the press back: the button is not pressed, and the Pen stays in hand', async ({ page }) => {
  await open(page, 'engine-loop&at=3');
  await page.keyboard.press('p');
  const [x, y] = await centre(page, next(page));
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await nextFrame(page);
  expect(await step(page)).toBe('8');
  await expect(toolButton(page, 'Draw with the pen')).toHaveAttribute('aria-pressed', 'true');
  // With no press open, Esc is the board's again: it puts the Pen down.
  await page.keyboard.press('Escape');
  await expect(toolButton(page, 'Select')).toHaveAttribute('aria-pressed', 'true');
});

test('Esc during a press on a part of a picture: the lift that follows is no tap; the same press with no Esc is one', async ({ page }) => {
  await open(page, 'engine-loop&at=3');
  const n = (await admitted(page)).length;
  const [x, y] = await centre(page, page.locator('[data-item="pipe"] [data-sub^="part:"]').first());
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect((await admitted(page)).slice(n)).toHaveLength(0);
  await expect(page.getByTestId('focus-opening')).toHaveCount(0);

  await page.mouse.click(x, y);
  await expect(page.getByTestId('focus-opening')).toHaveCount(1);
  expect((await admitted(page)).slice(n).map((e) => e.type)).toEqual(['ask']);
});

test('a press that lifts outside the board has ended: the next Esc is the board’s own', async ({ page }) => {
  await open(page, 'tools&at=1');
  await page.keyboard.press('n');
  const bar = (await page.getByRole('toolbar', { name: 'Tools' }).boundingBox())!;
  // Press on the board just above the toolbar, and let go over the toolbar.
  await page.mouse.move(bar.x + bar.width / 2, bar.y - 60);
  await page.mouse.down();
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2, { steps: 5 });
  await page.mouse.up();
  await nextFrame(page);
  // It was a drag, so no note opens. Were the press still open, this Esc would be used up on it.
  await expect(page.getByRole('textbox', { name: 'Your note' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(toolButton(page, 'Select')).toHaveAttribute('aria-pressed', 'true');
});

test('a right-click and a Ctrl-click open no menu and draw nothing; a right-button drag does not pan', async ({ page }) => {
  await open(page, 'tools&at=1');
  const ground: XY = [720, 640];
  const n = (await admitted(page)).length;
  await page.keyboard.press('p');

  await page.mouse.click(ground[0], ground[1], { button: 'right' });
  expect(await menus(page)).toEqual([true]);
  await page.mouse.move(ground[0], ground[1]);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(ground[0] + 80, ground[1] + 40, { steps: 4 });
  await nextFrame(page);
  await expect(liveInk(page)).toHaveCount(0);
  await page.mouse.up({ button: 'right' });

  // On a Mac, Ctrl with the main button is a right-click: it draws nothing either.
  if (await page.evaluate(() => /Mac/.test(navigator.platform))) {
    await page.keyboard.down('Control');
    await page.mouse.move(ground[0], ground[1]);
    await page.mouse.down();
    await page.mouse.move(ground[0] + 80, ground[1] + 40, { steps: 4 });
    await nextFrame(page);
    await expect(liveInk(page)).toHaveCount(0);
    await page.mouse.up();
    await page.keyboard.up('Control');
  }
  await page.waitForTimeout(PEN_RESTS);
  expect(await addsSince(page, n)).toHaveLength(0);

  // With the Pan tool in hand, the right button does not pan; the main button does.
  await page.keyboard.press('h');
  const before = await readCamera(page);
  await page.mouse.move(ground[0], ground[1]);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(ground[0] + 80, ground[1] + 40, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  await nextFrame(page);
  expect(await readCamera(page)).toEqual(before);
  await page.mouse.move(ground[0], ground[1]);
  await page.mouse.down();
  await page.mouse.move(ground[0] + 80, ground[1] + 40, { steps: 4 });
  await page.mouse.up();
  await nextFrame(page);
  expect(await readCamera(page)).toEqual({ ...before, x: before.x + 80, y: before.y + 40 });
});

test('a cancelled stroke is gone and is not saved; the next stroke is', async ({ page }) => {
  await open(page, 'tools&at=1');
  const n = (await admitted(page)).length;
  await page.keyboard.press('p');
  await page.mouse.move(600, 620);
  await page.mouse.down();
  await page.mouse.move(700, 660, { steps: 8 });
  await nextFrame(page);
  await expect(liveInk(page)).toHaveCount(1);
  await cancelPress(page);
  await expect(liveInk(page)).toHaveCount(0);
  // The real button comes up later: that is not the end of a stroke.
  await page.mouse.move(760, 700);
  await page.mouse.up();
  await page.waitForTimeout(PEN_RESTS);
  expect(await addsSince(page, n)).toHaveLength(0);

  await page.mouse.move(600, 620);
  await page.mouse.down();
  await page.mouse.move(700, 660, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await addsSince(page, n)).length, { timeout: 5000 }).toBe(1);
});

test('a cancelled move puts the note back where it was, with nothing left on it; the next move is saved', async ({ page }) => {
  await open(page, 'tools&at=1');
  const n = (await admitted(page)).length;
  const note = page.locator('[data-item="m2"]');
  const from = (await note.boundingBox())!;
  const grab: XY = [from.x + from.width / 2, from.y + from.height / 2];
  await page.mouse.move(grab[0], grab[1]);
  await page.mouse.down();
  await page.mouse.move(grab[0] + 120, grab[1] + 60, { steps: 6 });
  await nextFrame(page);
  expect((await note.boundingBox())!.x).toBeGreaterThan(from.x + 100);
  await cancelPress(page);
  expect(await note.boundingBox()).toEqual(from);
  expect(await note.evaluate((el) => [(el as HTMLElement).style.translate, el.className.includes('item--dragging')])).toEqual(['', false]);
  await page.mouse.up();
  await nextFrame(page);
  expect((await admitted(page)).slice(n)).toHaveLength(0);

  await page.mouse.move(grab[0], grab[1]);
  await page.mouse.down();
  await page.mouse.move(grab[0] + 120, grab[1] + 60, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await admitted(page)).slice(n).map((e) => e.type), { timeout: 5000 }).toEqual(['item.update']);
  expect((await note.boundingBox())!.x).toBeGreaterThan(from.x + 100);
});

test('Esc in the middle of a drag puts everything back, keeps the tool, and the lift that follows does nothing', async ({ page }) => {
  await open(page, 'tools&at=1');
  const n = (await admitted(page)).length;
  await page.keyboard.press('b');
  await page.mouse.move(600, 620);
  await page.mouse.down();
  await page.mouse.move(760, 720, { steps: 6 });
  await nextFrame(page);
  await expect(page.locator('.live-box')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.live-box')).toHaveCount(0);
  await expect(toolButton(page, 'Draw a box')).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(800, 760);
  await page.mouse.up();
  await nextFrame(page);
  await expect(page.locator('.live-box')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'A few words' })).toHaveCount(0);
  expect((await admitted(page)).slice(n)).toHaveLength(0);
});

test('a sideways swipe cannot go back a page, and nothing in an item is lifted by the browser’s own drag', async ({ page }) => {
  await open(page, 'tools&at=1');
  expect(await page.evaluate(() => [getComputedStyle(document.documentElement).overscrollBehaviorX, getComputedStyle(document.body).overscrollBehaviorX])).toEqual(['none', 'none']);
  // A link inside a note, as a picture may hold one: a drag that starts on it moves the note.
  const n = (await admitted(page)).length;
  await page.evaluate(() => {
    const a = document.createElement('a');
    a.href = 'https://example.com/';
    a.textContent = 'a link';
    a.dataset.testid = 'planted-link';
    a.style.display = 'block';
    document.querySelector('[data-item="m2"] .note')!.append(a);
  });
  const [x, y] = await centre(page, page.getByTestId('planted-link'));
  // With the Box tool in hand the drag draws a box: the browser does not lift the link as a
  // ghost, which would take the pointer away in the middle of the drag.
  await page.keyboard.press('b');
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 150, y + 90, { steps: 8 });
  await nextFrame(page);
  await expect(page.locator('.live-box')).toHaveCount(1);
  await page.mouse.up();
  await expect(page.getByRole('textbox', { name: 'A few words' })).toHaveCount(1);
  expect((await admitted(page)).slice(n)).toHaveLength(0);
});

test('with Note or Pin in hand, a click on a picture’s button presses the button and nothing else; beside the button the tool takes the click', async ({ page }) => {
  await open(page, 'engine-loop&at=3');
  const [x, y] = await centre(page, next(page));
  const note = page.getByRole('textbox', { name: 'Your note' });
  const words = page.getByRole('textbox', { name: 'A few words' });
  expect(await step(page)).toBe('8');

  // The Note tool: one click on "Next step" steps the walk, and opens no note.
  await page.keyboard.press('n');
  await expect(toolButton(page, 'Write a note')).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.click(x, y);
  await expect.poll(() => step(page)).toBe('9');
  await expect(note).toHaveCount(0);
  await expect(toolButton(page, 'Write a note')).toHaveAttribute('aria-pressed', 'true');

  // The Pin tool: the same click steps the walk, and opens no pin.
  await page.keyboard.press('Escape');
  await page.keyboard.press('i');
  await expect(toolButton(page, 'Pin a place inside an item')).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.click(x, y);
  await expect.poll(() => step(page)).toBe('10');
  await expect(words).toHaveCount(0);

  // On the picture, clear of its buttons, the Pin tool takes the click: its field opens, and the walk stays.
  const walk = (await page.locator('[data-item="walk"]').boundingBox())!;
  await page.mouse.click(walk.x + 24, walk.y + 14);
  await expect(words).toHaveCount(1);
  expect(await step(page)).toBe('10');
});
