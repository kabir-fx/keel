import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyAt, nextFrame, readCamera, type XY } from './pointer';
import { GOLDEN, standIn, type Ev } from './stand-in';

/** The log of the app's own `tools` fixture: two notes, a card with three questions, a small picture. */
const TOOLS: Ev[] = readFileSync(fileURLToPath(new URL('../app/src/fixtures/tools/log.jsonl', import.meta.url)), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as Ev);

/**
 * Keys, tools, Undo, paste and drop on the system Chrome, against the built app: what a test
 * page with no layout and no real browser cannot show. Undo of a move, keys by their place on
 * the keyboard, Space and the window's focus, the tools that are used once, the browser's zoom
 * keys, a paste at the pointer, and a file dropped on a page that is not the owner's.
 */

interface Admitted {
  id: string;
  type: string;
  by: string;
  item?: { id: string; kind: string; box?: number[]; text?: string } | string;
  patch?: { box?: number[] };
}

async function open(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __admitted: unknown[]; __keys: Array<{ key: string; prevented: boolean }> };
    w.__admitted = [];
    w.__keys = [];
    window.addEventListener('keel:admit', (e) => w.__admitted.push((e as CustomEvent).detail));
    // Every key once the page is done with it: whether the board took it from the browser.
    window.addEventListener('keydown', (e) => setTimeout(() => w.__keys.push({ key: e.key, prevented: e.defaultPrevented })));
  });
  await page.goto('/?fixture=tools&at=1');
  await expect(page.getByTestId('board')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('[data-measure]')).toHaveCount(0);
  await page.waitForTimeout(500);
}

const admitted = (page: Page) => page.evaluate(() => (window as unknown as { __admitted: Admitted[] }).__admitted);
const keysSeen = (page: Page) => page.evaluate(() => (window as unknown as { __keys: Array<{ key: string; prevented: boolean }> }).__keys);
const tool = (page: Page) => page.locator('.app').getAttribute('data-tool');
const panning = (page: Page) => page.locator('.app').evaluate((el) => el.hasAttribute('data-pan'));
const zoom = async (page: Page) => (await readCamera(page)).z;

async function box(page: Page, selector: string) {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`${selector} is not on screen`);
  return b;
}

/** A point of bare ground: clear of the two notes, the two cards and every panel. */
const GROUND: XY = [1000, 700];

/** Drag the mouse from one point to another, in steps. */
async function drag(page: Page, from: XY, to: XY) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, { steps: 4 });
  await page.mouse.move(to[0], to[1], { steps: 4 });
  await page.mouse.up();
}

/** What reached the log since `from`: `[type, item id]`. */
async function since(page: Page, from: number) {
  return (await admitted(page)).slice(from).map((e) => [e.type, typeof e.item === 'string' ? e.item : e.item?.id]);
}

test('move a note, then Cmd+Z: it is back where it was and nothing else is touched; Cmd+Shift+Z moves it again', async ({ page }) => {
  await open(page);
  const n = (await admitted(page)).length;
  const before = await box(page, '[data-item="m2"]');
  // Cmd held: the note lands where it is put, not on an edge it passes near.
  await page.keyboard.down('Meta');
  await drag(page, [before.x + 40, before.y + 20], [before.x + 240, before.y + 120]);
  await page.keyboard.up('Meta');
  await expect.poll(() => since(page, n)).toEqual([['item.update', 'm2']]);
  const moved = await box(page, '[data-item="m2"]');
  expect(Math.round(moved.x - before.x)).toBe(200);

  await page.keyboard.press('Meta+z');
  await expect.poll(() => since(page, n)).toEqual([['item.update', 'm2'], ['item.update', 'm2']]);
  const back = (await admitted(page))[n + 1]!;
  expect(back.patch?.box).toEqual([0, 380, 320, 70]);
  await expect.poll(async () => Math.round((await box(page, '[data-item="m2"]')).x - before.x)).toBe(0);
  // No mark of the owner's came off: the old Undo took the newest one off here.
  await expect(page.locator('[data-item="m1"]')).toBeVisible();

  await page.keyboard.press('Meta+Shift+z');
  await expect.poll(() => since(page, n)).toHaveLength(3);
  await expect.poll(async () => Math.round((await box(page, '[data-item="m2"]')).x - before.x)).toBe(200);
  await expect(page.getByTestId('toast')).toHaveCount(0);
});

test('Undo during a drag does nothing; after the lift it takes the move back', async ({ page }) => {
  await open(page);
  const n = (await admitted(page)).length;
  const note = await box(page, '[data-item="m2"]');
  await page.mouse.move(note.x + 40, note.y + 20);
  await page.mouse.down();
  await page.mouse.move(note.x + 140, note.y + 80, { steps: 5 });
  await page.keyboard.press('Meta+z');
  await nextFrame(page);
  expect(await since(page, n)).toEqual([]);
  await expect(page.getByTestId('toast')).toHaveCount(0);
  // The key was taken from the browser all the same.
  expect((await keysSeen(page)).filter((k) => k.key === 'z')).toEqual([{ key: 'z', prevented: true }]);
  await page.mouse.up();
  await expect.poll(() => since(page, n)).toEqual([['item.update', 'm2']]);
  await page.keyboard.press('Meta+z');
  await expect.poll(() => since(page, n)).toHaveLength(2);
});

test('keys by their place: Undo and the Pen on a Russian keyboard, and Caps Lock changes nothing', async ({ page }) => {
  await open(page);
  // The key in the P place types "з": it is the Pen.
  expect(await keyAt(page, { key: 'з', code: 'KeyP' })).toBe(false);
  expect(await tool(page)).toBe('pen');
  expect(await keyAt(page, { key: 'М', code: 'KeyV', capsLock: true })).toBe(false);
  expect(await tool(page)).toBe('select');

  const n = (await admitted(page)).length;
  const note = await box(page, '[data-item="m2"]');
  await drag(page, [note.x + 40, note.y + 20], [note.x + 140, note.y + 80]);
  await expect.poll(() => since(page, n)).toHaveLength(1);
  expect(await keyAt(page, { key: 'я', code: 'KeyZ', meta: true })).toBe(false);
  await expect.poll(() => since(page, n)).toHaveLength(2);
  expect(await keyAt(page, { key: 'Я', code: 'KeyZ', meta: true, shift: true, capsLock: true })).toBe(false);
  await expect.poll(() => since(page, n)).toHaveLength(3);
});

test('Space, then the window loses focus, then a drag: no pan; Space with a press open arms nothing', async ({ page }) => {
  await open(page);
  await page.keyboard.press('b');
  const cam = await readCamera(page);
  await page.keyboard.down(' ');
  expect(await panning(page)).toBe(true);
  // The owner goes to another window with Space down: the page never hears it come up.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  expect(await panning(page)).toBe(false);
  await drag(page, GROUND, [GROUND[0] + 160, GROUND[1] + 90]);
  await expect(page.getByRole('textbox', { name: 'A few words' })).toBeFocused();
  expect(await readCamera(page)).toEqual(cam);
  await page.keyboard.press('Escape');
  await page.keyboard.up(' ');

  // A press is open: Space arms no pan, and the box goes on being drawn.
  await page.keyboard.press('b');
  await page.mouse.move(GROUND[0], GROUND[1] - 200);
  await page.mouse.down();
  await page.mouse.move(GROUND[0] + 100, GROUND[1] - 140, { steps: 4 });
  await page.keyboard.down(' ');
  expect(await panning(page)).toBe(false);
  await page.keyboard.up(' ');
  await page.mouse.up();
  await expect(page.getByRole('textbox', { name: 'A few words' })).toBeFocused();
  expect(await readCamera(page)).toEqual(cam);
});

test('a tool key during a press changes nothing; the Box drops back to Select after one box, with the new box selected', async ({ page }) => {
  await open(page);
  const n = (await admitted(page)).length;
  await page.keyboard.press('b');
  await page.mouse.move(GROUND[0], GROUND[1]);
  await page.mouse.down();
  await page.mouse.move(GROUND[0] + 120, GROUND[1] + 80, { steps: 4 });
  await page.keyboard.press('p');
  expect(await tool(page)).toBe('box');
  await page.mouse.up();
  // The box waits for its words, with the Box still in hand.
  await expect(page.getByRole('textbox', { name: 'A few words' })).toBeFocused();
  expect(await tool(page)).toBe('box');
  await page.keyboard.type('the slow part');
  await page.keyboard.press('Enter');
  await expect.poll(() => since(page, n)).toHaveLength(1);
  const added = (await admitted(page))[n]!.item as { id: string; kind: string };
  expect(added.kind).toBe('box');
  await expect.poll(() => tool(page)).toBe('select');
  await expect(page.locator(`[data-item="${added.id}"]`)).toHaveClass(/item--selected/);

  // The Pen stays in hand after a mark.
  await page.keyboard.press('p');
  await drag(page, [GROUND[0], GROUND[1] - 250], [GROUND[0] + 200, GROUND[1] - 240]);
  await expect.poll(() => since(page, n), { timeout: 5000 }).toHaveLength(2);
  expect(await tool(page)).toBe('pen');
});

test('after a click on the toolbar the focus is the page’s: the next Space pans, and does not press the button', async ({ page }) => {
  await open(page);
  await page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name: 'Draw a box' }).click();
  expect(await tool(page)).toBe('box');
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await page.keyboard.down(' ');
  expect(await panning(page)).toBe(true);
  await page.keyboard.up(' ');
  expect(await panning(page)).toBe(false);
  expect(await tool(page)).toBe('box');
});

test('Space on a toolbar button reached with Tab presses that button, and arms no pan', async ({ page }) => {
  await open(page);
  const button = page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name: 'Draw a box' });
  for (let i = 0; i < 40 && !(await button.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(button).toBeFocused();
  expect(await tool(page)).toBe('select');
  await page.keyboard.down(' ');
  expect(await panning(page)).toBe(false);
  await page.keyboard.up(' ');
  expect(await panning(page)).toBe(false);
  expect(await tool(page)).toBe('box');
  // Left to the browser: that is what presses the button.
  await expect.poll(async () => (await keysSeen(page)).filter((k) => k.key === ' ')).toEqual([{ key: ' ', prevented: false }]);
});

test('a button clicked with the mouse keeps the focus, and Space pans: it does not press the button again; Shift+Tab to a button, and Space presses that one', async ({ page }) => {
  await open(page);
  const zoomIn = page.getByRole('button', { name: 'Zoom in' });
  const z0 = await zoom(page);
  await zoomIn.click();
  // Unlike the toolbar, the zoom control keeps the focus where the click put it.
  await expect(zoomIn).toBeFocused();
  await expect.poll(() => zoom(page)).toBeCloseTo(z0 * 1.25, 5);
  const z1 = await zoom(page);
  expect(z1).not.toBeCloseTo(1, 3);

  await page.keyboard.down(' ');
  expect(await panning(page)).toBe(true);
  await page.keyboard.up(' ');
  expect(await panning(page)).toBe(false);
  await page.waitForTimeout(300);
  expect(await zoom(page)).toBe(z1);
  await expect.poll(async () => (await keysSeen(page)).filter((k) => k.key === ' ')).toEqual([{ key: ' ', prevented: true }]);

  // The keyboard moves the focus to the button before, "Back to 100%": Space is that button's.
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByTestId('zoom')).toBeFocused();
  await page.keyboard.press(' ');
  expect(await panning(page)).toBe(false);
  await expect.poll(() => zoom(page)).toBeCloseTo(1, 5);
  await expect.poll(async () => (await keysSeen(page)).filter((k) => k.key === ' ').at(-1)).toEqual({ key: ' ', prevented: false });
});

test('in the Story, Cmd with plus, minus and 0 are taken from the browser, so the page is never zoomed there', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Story' }).click();
  await expect(page.locator('.app')).toHaveAttribute('data-mode', 'story');
  for (const key of ['Meta+Equal', 'Meta+Minus', 'Meta+Digit0']) await page.keyboard.press(key);
  await expect.poll(async () => (await keysSeen(page)).filter((k) => k.key !== 'Meta')).toEqual([
    { key: '=', prevented: true },
    { key: '-', prevented: true },
    { key: '0', prevented: true },
  ]);
});

test('Cmd with plus and minus zooms the board, on the board, with a panel’s button in focus and while typing in a note', async ({ page }) => {
  await open(page);
  const z0 = await zoom(page);
  await page.keyboard.press('Meta+=');
  await nextFrame(page);
  const z1 = await zoom(page);
  expect(z1 / z0).toBeCloseTo(1.25, 5);
  await page.keyboard.press('Meta+Shift+=');
  await nextFrame(page);
  expect((await zoom(page)) / z1).toBeCloseTo(1.25, 5);
  await page.keyboard.press('Meta+-');
  await page.keyboard.press('Meta+-');
  await nextFrame(page);
  expect(await zoom(page)).toBeCloseTo(z0, 5);

  // With a button of a panel in focus.
  await page.getByRole('button', { name: 'Story' }).focus();
  await page.keyboard.press('Control+=');
  await nextFrame(page);
  expect((await zoom(page)) / z0).toBeCloseTo(1.25, 5);
  await page.keyboard.press('Control+-');
  await nextFrame(page);

  // While typing in a note: the board zooms, and the words stay as they are.
  await page.keyboard.press('n');
  await page.mouse.click(GROUND[0], GROUND[1]);
  const field = page.getByRole('textbox', { name: 'Your note' });
  await expect(field).toBeFocused();
  await page.keyboard.type('half a thought');
  await page.keyboard.press('Meta+=');
  await nextFrame(page);
  expect((await zoom(page)) / z0).toBeCloseTo(1.25, 5);
  await page.keyboard.press('Meta+0');
  await nextFrame(page);
  expect(await zoom(page)).toBe(1);
  await expect(field).toHaveValue('half a thought');
  await expect(field).toBeFocused();

  // Every one of those keys was taken from the browser, so the page itself never zoomed. This is
  // the check that holds: Playwright's keys never reach Chrome's own zoom, so the page's scale
  // would stay as it is whatever the board did with them.
  const zoomKeys = (await keysSeen(page)).filter((k) => ['=', '+', '-', '0'].includes(k.key));
  expect(zoomKeys).toHaveLength(8);
  expect(zoomKeys.every((k) => k.prevented)).toBe(true);
  await page.keyboard.press('Escape');
});

test('on a board server: the new box is selected once the server has it, and Undo and Redo post the opposite events', async ({ page }) => {
  // The same board as the fixture, from a stand-in server: its answer to a post reaches the page
  // before the page has drawn the event.
  const server = await standIn(page, TOOLS);
  await page.goto('/?token=owner-token');
  await expect(page.getByTestId('board')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('[data-measure]')).toHaveCount(0);
  await page.waitForTimeout(500);
  /** What the page posted for the owner: the pictures it places are its own business. */
  const posts = () => server.posts.map((p) => p.draft as { type: string; item?: { id: string; kind: string } | string; patch?: { box?: number[] } }).filter((d) => d.type !== 'item.place');
  const n = posts().length;

  await page.keyboard.press('b');
  await drag(page, GROUND, [GROUND[0] + 160, GROUND[1] + 90]);
  await expect(page.getByRole('textbox', { name: 'A few words' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => posts().length).toBe(n + 1);
  const added = posts()[n]!.item as { id: string; kind: string };
  expect(added.kind).toBe('box');
  await expect(page.locator(`[data-item="${added.id}"]`)).toHaveClass(/item--selected/);
  expect(await tool(page)).toBe('select');

  // Move a note, then Undo twice and Redo twice: each posts one event, the opposite of a step.
  const note = await box(page, '[data-item="m2"]');
  await drag(page, [note.x + 40, note.y + 20], [note.x + 140, note.y + 80]);
  await expect.poll(() => posts().length).toBe(n + 2);
  await page.keyboard.press('Meta+z');
  await page.keyboard.press('Meta+z');
  await page.keyboard.press('Meta+Shift+z');
  await page.keyboard.press('Meta+Shift+z');
  await expect.poll(() => posts().length).toBe(n + 6);
  const moved = posts()[n + 1]!.patch!.box!;
  expect(posts().slice(n + 2).map((d) => [d.type, d.item, d.patch?.box])).toEqual([
    ['item.update', 'm2', [0, 380, 320, 70]],
    ['item.remove', added.id, undefined],
    ['item.restore', added.id, undefined],
    ['item.update', 'm2', moved],
  ]);
  await expect(page.getByTestId('toast')).toHaveCount(0);
});

/** Paste what a clipboard holds into what has the focus. Resolves to false when the page took the paste from the browser. */
async function paste(page: Page, text: string): Promise<boolean> {
  const open = await page.evaluate((words) => {
    const data = new DataTransfer();
    data.setData('text/plain', words);
    return (document.activeElement ?? document.body).dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
  await nextFrame(page);
  return open;
}

test('a paste lands at the pointer; over a panel, and while typing a note, it makes no item', async ({ page }) => {
  await open(page);
  const n = (await admitted(page)).length;
  await page.mouse.move(GROUND[0], GROUND[1]);
  expect(await paste(page, 'what about retries?')).toBe(false);
  await expect.poll(() => since(page, n)).toHaveLength(1);
  const pasted = (await admitted(page))[n]!.item as { id: string; kind: string; text: string };
  expect(pasted).toMatchObject({ kind: 'note', text: 'what about retries?' });
  // The note's corner is where the pointer was.
  const at = await box(page, `[data-item="${pasted.id}"]`);
  expect(Math.abs(at.x - GROUND[0])).toBeLessThan(3);
  expect(Math.abs(at.y - GROUND[1])).toBeLessThan(3);

  // The pointer is over the toolbar: the paste is the browser's, and makes nothing.
  const bar = (await page.getByRole('toolbar', { name: 'Tools' }).boundingBox())!;
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
  expect(await paste(page, 'not on a panel')).toBe(true);
  await page.waitForTimeout(200);
  expect(await since(page, n)).toHaveLength(1);

  // While typing a note, a paste is the note's.
  await page.keyboard.press('n');
  await page.mouse.click(GROUND[0] - 300, GROUND[1] - 100);
  const field = page.getByRole('textbox', { name: 'Your note' });
  await expect(field).toBeFocused();
  await paste(page, 'into the note');
  await page.waitForTimeout(200);
  expect(await since(page, n)).toHaveLength(1);
  await expect(field).toBeFocused();
  await page.keyboard.press('Escape');
});

/** One drag event built in the page and sent to an element, with files as a browser lists them. */
async function dragEvent(page: Page, type: 'dragenter' | 'dragover' | 'dragleave' | 'drop', selector: string): Promise<boolean> {
  return page.locator(selector).first().evaluate((el, t) => {
    const data = new DataTransfer();
    data.items.add(new File(['a,b\n1,2\n'], 'depth.csv', { type: 'text/csv' }));
    const r = el.getBoundingClientRect();
    return el.dispatchEvent(new DragEvent(t, { dataTransfer: data, bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 20 }));
  }, type);
}

test('the "drop here" overlay: once for an enter into a card and a leave back out, gone on Esc and when the window loses focus', async ({ page }) => {
  await open(page);
  const overlay = page.getByTestId('drop-hint');
  await dragEvent(page, 'dragenter', '[data-testid="board"]');
  await expect(overlay).toBeVisible();
  // Onto a card: the browser enters the card, then leaves the ground.
  await dragEvent(page, 'dragenter', '[data-item="a1"]');
  await dragEvent(page, 'dragleave', '[data-testid="board"]');
  await expect(overlay).toHaveCount(1);
  // Back out onto the ground, then off the board.
  await dragEvent(page, 'dragenter', '[data-testid="board"]');
  await dragEvent(page, 'dragleave', '[data-item="a1"]');
  await expect(overlay).toHaveCount(1);
  await dragEvent(page, 'dragleave', '[data-testid="board"]');
  await expect(overlay).toHaveCount(0);

  await dragEvent(page, 'dragenter', '[data-testid="board"]');
  await expect(overlay).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(overlay).toHaveCount(0);

  await dragEvent(page, 'dragenter', '[data-testid="board"]');
  await expect(overlay).toHaveCount(1);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(overlay).toHaveCount(0);

  // A file let go over a panel is refused, not opened.
  expect(await dragEvent(page, 'dragover', '.toolbar')).toBe(false);
  expect(await dragEvent(page, 'drop', '.toolbar')).toBe(false);
});

/** A real drag of a file from outside the browser, through Chrome's own input: enter, over and let go at a point. */
async function dropFile(page: Page, path: string, at: XY) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const data = { items: [], files: [path], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop'] as const) await cdp.send('Input.dispatchDragEvent', { type, x: at[0], y: at[1], data });
  } finally {
    await cdp.detach();
  }
}

test('a file dropped on a page that is not the owner’s leaves the page where it is', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'keel-drop-'));
  const file = join(dir, 'dropped.txt');
  writeFileSync(file, 'a file from the desktop\n');

  /** Every tab the browser opened by itself. */
  const opened: string[] = [];
  page.context().on('page', (tab) => opened.push(tab.url()));

  // First, what a browser does with a page that does not refuse the drag: it opens the file.
  // Safari and Firefox open it in the tab, in place of the page; this Chrome opens a tab for it.
  // The page that says the board cannot open has no board on it, and refuses nothing.
  await page.goto('/?fixture=no-such-board');
  await expect(page.getByTestId('problem')).toBeVisible();
  await dropFile(page, file, [600, 400]);
  await expect.poll(() => opened.length + (page.url().startsWith('file:') ? 1 : 0)).toBe(1);
  opened.length = 0;

  // A viewer's page: the board as the agent's token opens it.
  const events = GOLDEN.slice(0, GOLDEN.findIndex((e) => e.id === 'e11') + 1);
  await page.routeWebSocket(/\/ws/, (ws) => {
    ws.send(JSON.stringify({ t: 'init', name: 'uLLM', role: 'agent', events, presence: { state: 'listening', since: '2026-11-17T13:00:00Z' } }));
  });
  await page.route('**/api/board', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ name: 'uLLM', seq: events.length, role: 'agent', open: 0 }) }));
  await page.goto('/?token=agent-token');
  await expect(page.getByTestId('board')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('[data-measure]')).toHaveCount(0);
  const board = page.url();

  // On the board, and on a panel: the tab stays on the board, the browser opens nothing, and no
  // overlay offers a drop.
  await dropFile(page, file, [700, 450]);
  const pill = (await page.getByTestId('board-name').boundingBox())!;
  await dropFile(page, file, [pill.x + 10, pill.y + 10]);
  await page.waitForTimeout(1000);
  expect(opened).toEqual([]);
  expect(page.url()).toBe(board);
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('drop-hint')).toHaveCount(0);
});
