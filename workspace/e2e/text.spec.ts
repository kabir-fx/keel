import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { nextFrame, readCamera } from './pointer';
import { standIn, type Ev, type StandIn } from './stand-in';

/**
 * Typing on the board, end to end on the system Chrome: a note and the few words on a mark.
 * What matters is that the owner's words are never lost and never sent by accident, so each
 * test here ends a field one way (a key, a press, looking away, a reload, a refusal) and looks
 * at what was posted and what the field still holds.
 *
 * Two boards are used, both from the app's own `tools` log (two notes, a card with three
 * questions, a small picture). The fixture replays it with no server, announces each admitted
 * event as a `keel:admit` window event, and keeps nothing in the browser. The stand-in server
 * gives the same board as the owner's own opens: it remembers, so drafts are kept there.
 */

const TOOLS: Ev[] = readFileSync(fileURLToPath(new URL('../app/src/fixtures/tools/log.jsonl', import.meta.url)), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as Ev);

type Box = [number, number, number, number];
interface Item {
  id: string;
  kind: string;
  text?: string;
  box?: Box;
  on?: { item: string; sub?: string };
}
interface Admitted {
  type: string;
  item?: Item | string;
  patch?: { text?: string; box?: Box };
}

const note = (page: Page) => page.getByRole('textbox', { name: 'Your note' });
const label = (page: Page) => page.getByRole('textbox', { name: 'A few words' });
const toast = (page: Page) => page.getByTestId('toast');
const Q = (n: number) => `[data-item="a1"] [data-sub="q:${n}"]`;
const zoom = async (page: Page) => Number((await page.getByTestId('zoom').textContent())!.replace('%', '')) / 100;

async function settle(page: Page) {
  await expect(page.getByTestId('board')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('[data-measure]')).toHaveCount(0);
  await page.waitForTimeout(500);
}

/** The fixture: nothing is kept in the browser. */
async function openFixture(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __admitted: unknown[] };
    w.__admitted = [];
    window.addEventListener('keel:admit', (e) => w.__admitted.push((e as CustomEvent).detail));
  });
  await page.goto('/?fixture=tools&at=1');
  await settle(page);
}

const admitted = (page: Page) => page.evaluate(() => (window as unknown as { __admitted: Admitted[] }).__admitted);

/** The marks the fixture board took since its first `from` events. */
async function adds(page: Page, from = 0): Promise<Item[]> {
  return (await admitted(page))
    .slice(from)
    .filter((e) => e.type === 'item.add')
    .map((e) => e.item as Item);
}

/** The same board on the stand-in server: it remembers, as the owner's own does. */
async function openBoard(page: Page): Promise<StandIn> {
  const server = await standIn(page, TOOLS);
  await page.goto('/?token=owner-token');
  await settle(page);
  return server;
}

/** What the page posted that makes or changes a mark: the pictures it places are its own business. */
const marks = (server: StandIn) => server.posts.map((p) => p.draft as { type: string; item?: Item | string; patch?: { text?: string; box?: Box } }).filter((d) => d.type !== 'item.place');

interface Kept {
  text: string;
  at: [number, number];
  on?: { item: string; sub?: string };
}

/** Every draft of this kind kept in the browser for this board (the log names it "Tools"), by any page. */
const drafts = (page: Page, kind: 'note' | 'label') =>
  page.evaluate((k) => {
    const prefix = `keel.draft.${k}.Tools@`;
    const keys = Object.keys(localStorage).filter((key) => key.startsWith(prefix));
    return keys.map((key) => JSON.parse(localStorage.getItem(key) ?? 'null') as Kept);
  }, kind);

/** The words kept in the browser for this board: the note being typed, or the label. One page keeps them. */
async function draft(page: Page, kind: 'note' | 'label'): Promise<Kept | null> {
  const all = await drafts(page, kind);
  expect(all.length).toBeLessThan(2);
  return all[0] ?? null;
}

async function box(page: Page, selector: string) {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`${selector} is not on screen`);
  return b;
}

/** A point of bare ground, clear of every item and panel, with room for a note below and right of it. */
async function bareGround(page: Page): Promise<{ x: number; y: number }> {
  const p = await page.evaluate(() => {
    const taken = [...document.querySelectorAll('[data-item], [data-item] *, .item--editor, .label-editor, .chrome, .hint, .agent-cursor, .agent-cursor *')]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0);
    const clear = (x: number, y: number) => {
      const [l, t, r, b] = [x - 40, y - 40, x + 340, y + 110];
      return taken.every((k) => k.right < l || k.left > r || k.bottom < t || k.top > b);
    };
    for (let y = 150; y < window.innerHeight - 160; y += 30) {
      for (let x = 80; x < window.innerWidth - 400; x += 30) if (clear(x, y)) return { x, y };
    }
    return null;
  });
  if (!p) throw new Error('no bare ground on screen');
  return p;
}

/** Open a new note on bare ground and type into it. */
async function typeNote(page: Page, words: string) {
  await page.keyboard.press('n');
  const spot = await bareGround(page);
  await page.mouse.click(spot.x, spot.y);
  await expect(note(page)).toBeFocused();
  if (words) await page.keyboard.type(words);
  return spot;
}

/** Drag on bare ground with the tool in hand (the Box or the Arrow): its label opens. */
async function drag(page: Page, key: 'b' | 'a') {
  await page.keyboard.press(key);
  const spot = await bareGround(page);
  await page.mouse.move(spot.x, spot.y);
  await page.mouse.down();
  await page.mouse.move(spot.x + 120, spot.y + 40, { steps: 4 });
  await page.mouse.move(spot.x + 260, spot.y + 90, { steps: 4 });
  await page.mouse.up();
  await expect(label(page)).toBeFocused();
  return spot;
}

/** Put text on the clipboard's way into the focused field: a paste as the browser sends it, without touching this machine's clipboard. */
async function paste(page: Page, text: string): Promise<boolean> {
  return page.evaluate((t) => {
    const data = new DataTransfer();
    data.setData('text/plain', t);
    return document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

/**
 * The window really loses the focus, as when the owner goes to another app: Playwright keeps
 * every page focused by emulation, so that is turned off, and another page is brought to the
 * front. The answer gives the focus back to the board's window.
 */
async function lookAway(page: Page, context: BrowserContext): Promise<() => Promise<void>> {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  const other = await context.newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
  return async () => {
    await page.bringToFront();
    await other.close();
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
  };
}

/** The tab is hidden, as the browser says it. A headless window is never really hidden, so the page is told. */
async function hideTab(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

/** What must hold still while the owner types: the board's own scroll, the page's, the field's, and the camera. */
async function scrolls(page: Page) {
  const s = await page.evaluate(() => {
    const board = document.querySelector('[data-testid="board"]')!;
    const field = document.activeElement as HTMLTextAreaElement;
    return { board: [board.scrollLeft, board.scrollTop], page: [window.scrollX, window.scrollY], field: [field.scrollLeft, field.scrollTop] };
  });
  return { ...s, camera: await readCamera(page) };
}

/* ------------------------------------------------------------ looking away */

test('the window loses focus while a note is typed: nothing is posted, the note stays open, and typing goes on when the owner is back', async ({ page, context }) => {
  await openFixture(page);
  const n0 = (await admitted(page)).length;
  await typeNote(page, 'half a thought');
  const back = await lookAway(page, context);
  await page.waitForTimeout(300);
  expect((await admitted(page)).length).toBe(n0);
  await expect(note(page)).toHaveValue('half a thought');
  await back();
  // The focus is in the field again with the window: the next keys go on where the owner stopped.
  await expect(note(page)).toBeFocused();
  await page.keyboard.type(', finished');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await adds(page, n0)).map((i) => i.text)).toEqual(['half a thought, finished']);
});

test('the window loses focus while a label is typed: the mark is not posted, and its field stays open with the words', async ({ page, context }) => {
  await openFixture(page);
  const n0 = (await admitted(page)).length;
  await drag(page, 'b');
  await page.keyboard.type('the slow');
  const back = await lookAway(page, context);
  await page.waitForTimeout(300);
  expect((await admitted(page)).length).toBe(n0);
  await expect(label(page)).toHaveValue('the slow');
  // The box waits for its words drawn by its field.
  await expect(page.locator('.label-editor--box .drawn-box')).toHaveCount(1);
  await back();
  await expect(label(page)).toBeFocused();
  await page.keyboard.type(' part');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await adds(page, n0)).map((i) => [i.kind, i.text])).toEqual([['box', 'the slow part']]);
});

test('the tab is hidden while a note is typed: the words are kept in the browser at once, nothing is posted, and the note stays open', async ({ page, context }) => {
  const server = await openBoard(page);
  const n = marks(server).length;
  await typeNote(page, 'half a thought');
  await hideTab(page);
  // At once, with no wait for the pause after a key.
  expect(await draft(page, 'note')).toMatchObject({ text: 'half a thought' });
  const back = await lookAway(page, context);
  await page.waitForTimeout(300);
  expect(marks(server).length).toBe(n);
  await expect(note(page)).toHaveValue('half a thought');
  await back();
  await expect(note(page)).toBeFocused();
});

/* ------------------------------------------------------------ a reload */

test('a reload while a note is typed brings it back: the same words, in the same place, on the same thing; after Enter a reload brings nothing back', async ({ page }) => {
  const server = await openBoard(page);
  await page.keyboard.press('n');
  const q2 = await box(page, Q(2));
  await page.mouse.click(q2.x + 60, q2.y + q2.height / 2);
  await expect(note(page)).toBeFocused();
  await page.keyboard.type('is this the cap we want?');
  const before = (await note(page).boundingBox())!;
  const n = marks(server).length;
  // At once: the last words have not had their pause. The page going writes them, and posts nothing.
  await page.reload();
  await settle(page);
  expect(marks(server).length).toBe(n);
  await expect(note(page)).toHaveValue('is this the cap we want?');
  await expect(note(page)).toBeFocused();
  const after = (await note(page).boundingBox())!;
  expect(Math.abs(after.x - before.x)).toBeLessThan(1);
  expect(Math.abs(after.y - before.y)).toBeLessThan(1);
  await page.keyboard.type(' Or more?');
  await page.keyboard.press('Enter');
  await expect.poll(() => marks(server).length).toBe(n + 1);
  expect(marks(server)[n]).toMatchObject({ type: 'item.add', item: { kind: 'note', text: 'is this the cap we want? Or more?', on: { item: 'a1', sub: 'q:2' } } });
  await expect(page.locator('[data-item][data-kind="note"]').filter({ hasText: 'is this the cap we want?' })).toBeVisible();
  // The board has it: nothing is kept, and a reload opens no note.
  expect(await draft(page, 'note')).toBeNull();
  await page.reload();
  await settle(page);
  await expect(note(page)).toHaveCount(0);
  expect(marks(server).length).toBe(n + 1);
});

test('a reload after Esc brings nothing back, and a reload while a label is typed brings the mark back with its words', async ({ page }) => {
  const server = await openBoard(page);
  const n = marks(server).length;
  await typeNote(page, 'never mind');
  await page.waitForTimeout(600);
  expect(await draft(page, 'note')).toMatchObject({ text: 'never mind' });
  await page.keyboard.press('Escape');
  expect(await draft(page, 'note')).toBeNull();
  await page.reload();
  await settle(page);
  await expect(note(page)).toHaveCount(0);

  await drag(page, 'b');
  await page.keyboard.type('the slow part');
  await page.reload();
  await settle(page);
  expect(marks(server).length).toBe(n);
  await expect(label(page)).toHaveValue('the slow part');
  await expect(label(page)).toBeFocused();
  // The box waits for its words drawn by its field.
  await expect(page.locator('.label-editor--box .drawn-box')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect.poll(() => marks(server).length).toBe(n + 1);
  expect(marks(server)[n]).toMatchObject({ type: 'item.add', item: { kind: 'box', text: 'the slow part' } });
  expect(await draft(page, 'label')).toBeNull();
});

/* ------------------------------------------------------------ Esc and Undo */

test('Esc closes a note with nothing posted and says so; Undo opens it again in the same place with its words', async ({ page }) => {
  await openFixture(page);
  const n0 = (await admitted(page)).length;
  await typeNote(page, 'a long thought, nearly lost');
  const before = (await note(page).boundingBox())!;
  await page.keyboard.press('Escape');
  await expect(note(page)).toHaveCount(0);
  await expect(toast(page)).toContainText('Closed, and not sent. Undo');
  expect((await admitted(page)).length).toBe(n0);
  await page.keyboard.press('Meta+z');
  await expect(note(page)).toHaveValue('a long thought, nearly lost');
  await expect(note(page)).toBeFocused();
  const after = (await note(page).boundingBox())!;
  expect([Math.round(after.x), Math.round(after.y)]).toEqual([Math.round(before.x), Math.round(before.y)]);
  expect((await admitted(page)).length).toBe(n0);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await adds(page, n0)).map((i) => i.text)).toEqual(['a long thought, nearly lost']);
});

test('Esc on a box’s label keeps the box with no words; on a pin’s label it drops the pin, and Undo brings the pin back with its words', async ({ page }) => {
  await openFixture(page);
  const n0 = (await admitted(page)).length;
  await drag(page, 'b');
  await page.keyboard.press('Escape');
  await expect(label(page)).toHaveCount(0);
  await expect.poll(async () => (await adds(page, n0)).map((i) => [i.kind, i.text])).toEqual([['box', undefined]]);

  await page.keyboard.press('i');
  const q3 = await box(page, Q(3));
  const at = { x: q3.x + 40, y: q3.y + q3.height / 2 };
  await page.mouse.click(at.x, at.y);
  await expect(label(page)).toBeFocused();
  // The pin that waits for its words is drawn where it was clicked: its point is at the foot of the icon.
  const ghost = (await page.locator('.item--pin.item--ghost svg').boundingBox())!;
  expect(Math.abs(ghost.x + ghost.width / 2 - at.x)).toBeLessThan(3);
  expect(Math.abs(ghost.y + ghost.height - at.y)).toBeLessThan(8);
  await page.keyboard.type('this one');
  await page.keyboard.press('Escape');
  await expect(label(page)).toHaveCount(0);
  await expect(toast(page)).toContainText('The pin is dropped. Undo');
  expect(await adds(page, n0)).toHaveLength(1);
  await page.keyboard.press('Meta+z');
  await expect(label(page)).toHaveValue('this one');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await adds(page, n0)).map((i) => [i.kind, i.text])).toEqual([['box', undefined], ['pin', 'this one']]);
  expect((await adds(page, n0))[1]).toMatchObject({ on: { item: 'a1', sub: 'q:3' } });
});

/** Every line the board says from now on, as the page shows it. */
async function listen(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __said: string[] };
    w.__said = [];
    new MutationObserver(() => {
      const t = document.querySelector('[data-testid="toast"]')?.textContent;
      if (t && t !== w.__said.at(-1)) w.__said.push(t);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
}

const said = (page: Page) => page.evaluate(() => (window as unknown as { __said: string[] }).__said);

test('Esc on the note Undo opened puts it away: the next Undo takes back the move before it, and nothing is posted for the note', async ({ page }) => {
  await openFixture(page);
  const n0 = (await admitted(page)).length;
  const since = async () => (await admitted(page)).slice(n0).map((e) => [e.type, typeof e.item === 'string' ? e.item : e.item?.kind]);
  const before = await box(page, '[data-item="m2"]');
  await page.mouse.move(before.x + 40, before.y + 20);
  await page.mouse.down();
  await page.mouse.move(before.x + 140, before.y + 70, { steps: 4 });
  await page.mouse.move(before.x + 240, before.y + 120, { steps: 4 });
  await page.mouse.up();
  await expect.poll(since).toEqual([['item.update', 'm2']]);
  await listen(page);

  await typeNote(page, 'a thought, put away');
  await page.keyboard.press('Escape');
  await expect(note(page)).toHaveCount(0);
  await page.keyboard.press('Meta+z');
  await expect(note(page)).toHaveValue('a thought, put away');
  await expect(note(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(note(page)).toHaveCount(0);
  await page.keyboard.press('Meta+z');
  await expect.poll(since).toEqual([
    ['item.update', 'm2'],
    ['item.update', 'm2'],
  ]);
  await expect.poll(async () => Math.round((await box(page, '[data-item="m2"]')).x - before.x)).toBe(0);
  await page.waitForTimeout(300);
  await expect(note(page)).toHaveCount(0);
  expect(await since()).toHaveLength(2);
  expect((await said(page)).join('\n')).not.toContain('could not');
});

/* ------------------------------------------------------------ a press outside */

test('a press on the board saves the note once and does nothing else, also when the browser sends no blur', async ({ page }) => {
  await openFixture(page);
  const n0 = (await admitted(page)).length;
  const spot = await typeNote(page, 'saved by a press');
  // No press moves the focus now, so no blur comes with it: the save has only the press to go by.
  await page.evaluate(() => window.addEventListener('mousedown', (e) => e.preventDefault(), true));
  await page.mouse.click(spot.x + 500, spot.y + 200);
  await expect(note(page)).toHaveCount(0);
  await expect.poll(async () => (await adds(page, n0)).map((i) => i.text)).toEqual(['saved by a press']);
  await nextFrame(page);
  // One note, no second field, and the press selected and moved nothing.
  expect((await admitted(page)).length).toBe(n0 + 1);
  await expect(page.locator('.item--selected')).toHaveCount(0);
});

test('a press on a panel saves the note, with the blur a browser sends: once; a press on the note’s own paper keeps it open', async ({ page }) => {
  await openFixture(page);
  const n0 = (await admitted(page)).length;
  await typeNote(page, 'still typing');
  const paper = (await page.locator('.note--editing').boundingBox())!;
  // The edge of the paper, outside the words.
  await page.mouse.click(paper.x + 5, paper.y + paper.height - 4);
  await nextFrame(page);
  await expect(note(page)).toBeFocused();
  expect((await admitted(page)).length).toBe(n0);
  await page.keyboard.type(', then done');
  await page.getByTestId('zoom').click();
  await expect(note(page)).toHaveCount(0);
  await expect.poll(async () => (await adds(page, n0)).map((i) => i.text)).toEqual(['still typing, then done']);
  await nextFrame(page);
  expect(await adds(page, n0)).toHaveLength(1);
});

/* ------------------------------------------------------------ typing */

test('a paste is made plain and cut to what a note holds, and the field’s own Undo takes it back; Tab types spaces and stays in the note', async ({ page }) => {
  await openFixture(page);
  const n0 = (await admitted(page)).length;
  await typeNote(page, 'list:');
  // The caret moves, so what comes next is a step of its own for the field's Undo.
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowRight');
  expect(await paste(page, '\r\none\ttwo\rthree\r\n')).toBe(false);
  await expect(note(page)).toHaveValue('list:\none    two\nthree\n');
  // The paste went in as typing does, so the field's own Undo knows it.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(note(page)).toHaveValue('list:');
  await expect(note(page)).toBeFocused();

  await page.keyboard.press('Tab');
  await expect(note(page)).toBeFocused();
  await expect(note(page)).toHaveValue('list:    ');
  await page.keyboard.press('Shift+Tab');
  await expect(note(page)).toBeFocused();
  await expect(note(page)).toHaveValue('list:    ');

  // More than a note holds: cut at 2,000 letters, and the board says so.
  await paste(page, 'x'.repeat(2100));
  expect(await note(page).evaluate((el: HTMLTextAreaElement) => el.value.length)).toBe(2000);
  await expect(toast(page)).toContainText('A note holds 2,000 letters. The rest of what you pasted was left out.');
  expect((await admitted(page)).length).toBe(n0);
});

test('Enter while an input method composes a letter does not save the note; the next Enter does', async ({ page, context }) => {
  await openFixture(page);
  const n0 = (await admitted(page)).length;
  await typeNote(page, 'kanji: ');
  await page.evaluate(() => {
    const w = window as unknown as { __enters: boolean[] };
    w.__enters = [];
    window.addEventListener('keydown', (e) => e.key === 'Enter' && w.__enters.push(e.isComposing || e.keyCode === 229), true);
  });
  const cdp = await context.newCDPSession(page);
  // The input method holds a letter it has not given the field yet.
  await cdp.send('Input.imeSetComposition', { text: 'に', selectionStart: 1, selectionEnd: 1 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  // The browser itself says this Enter came in the middle of a composition.
  expect(await page.evaluate(() => (window as unknown as { __enters: boolean[] }).__enters)).toEqual([true]);
  expect((await admitted(page)).length).toBe(n0);
  await expect(note(page)).toBeFocused();
  // The input method gives the letter to the field, and the composition is over (a scripted one
  // lets its Enter start a line too). The next Enter is the owner's, and saves.
  await cdp.send('Input.insertText', { text: 'に' });
  expect(await note(page).inputValue()).toContain('kanji: に');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await adds(page, n0)).map((i) => i.text)).toEqual(['kanji: に']);
  expect(await page.evaluate(() => (window as unknown as { __enters: boolean[] }).__enters)).toEqual([true, false]);
});

/* ------------------------------------------------------------ no jumping */

test('a long line and many lines in a note scroll nothing: not the field, not the board, not the page, and the camera stays', async ({ page }) => {
  await openFixture(page);
  await typeNote(page, '');
  const top = (await note(page).boundingBox())!;
  const still = await scrolls(page);
  expect(still).toMatchObject({ board: [0, 0], page: [0, 0], field: [0, 0] });
  // One line with no place to break, far longer than the note is wide.
  await page.keyboard.type('x'.repeat(400));
  await nextFrame(page);
  expect(await scrolls(page)).toEqual(still);
  const wide = (await note(page).boundingBox())!;
  expect(wide.width).toBe(top.width);
  expect(wide.height).toBeGreaterThan(top.height * 3);
  // Lines until the caret is far below the window's lower edge.
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type(`line ${i}`);
  }
  await nextFrame(page);
  const tall = (await note(page).boundingBox())!;
  expect(tall.y + tall.height).toBeGreaterThan(900);
  expect(await scrolls(page)).toEqual(still);
  // The first line is where it was: nothing under the hand moved.
  expect([tall.x, tall.y]).toEqual([top.x, top.y]);
});

test('the field is 5% taller than its text, and the note’s paper is not: a saved note keeps its height when its words are changed', async ({ page }) => {
  await openFixture(page);
  const n0 = (await admitted(page)).length;
  await typeNote(page, 'two lines of words, long enough to wrap onto the second line of the note');
  const sizes = await page.evaluate(() => {
    const field = document.activeElement as HTMLTextAreaElement;
    const paper = field.closest('.note') as HTMLElement;
    const style = getComputedStyle(paper);
    const inner = paper.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    field.style.height = '0px';
    const text = field.scrollHeight;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return { text, field: field.offsetHeight, inner };
  });
  expect(sizes.text).toBeGreaterThan(40);
  expect(sizes.field).toBe(Math.ceil(sizes.text * 1.05));
  expect(sizes.inner).toBe(sizes.text);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await adds(page, n0)).length).toBe(1);
  const [made] = await adds(page, n0);
  // Changed with as many lines as before, it posts its words and no new height.
  await page.keyboard.press('s');
  const drawn = page.locator(`[data-item="${made!.id}"]`);
  const was = (await drawn.boundingBox())!;
  await drawn.dblclick();
  await expect(note(page)).toBeFocused();
  const editing = (await page.locator('.item--editor').boundingBox())!;
  expect(Math.abs(editing.height - was.height)).toBeLessThan(1.5);
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await admitted(page)).slice(n0).filter((e) => e.type === 'item.update').length).toBe(1);
  const change = (await admitted(page)).slice(n0).find((e) => e.type === 'item.update')!;
  expect(change.patch?.text).toMatch(/!$/);
  expect(change.patch?.box).toBeUndefined();
});

/* ------------------------------------------------------------ a box's words */

test('a box’s words are typed inside the box, wrap at its width, grow it down, and land where they were typed', async ({ page }) => {
  await openFixture(page);
  const n0 = (await admitted(page)).length;
  const z = await zoom(page);
  await drag(page, 'b');
  const field = page.locator('.label-editor--box');
  const frame = page.locator('.label-editor--box .drawn-box');
  const drawn = (await frame.boundingBox())!;
  await page.keyboard.type('create a 3d game where the owner goes through a maze and finds the way out in real time');
  const typed = (await label(page).boundingBox())!;
  const grown = (await frame.boundingBox())!;
  // The words stay inside the box: it keeps its width and grows down.
  expect(grown.x).toBeCloseTo(drawn.x, 0);
  expect(grown.width).toBeCloseTo(drawn.width, 0);
  expect(grown.height).toBeGreaterThan(drawn.height);
  expect(typed.x).toBeGreaterThanOrEqual(grown.x);
  expect(typed.x + typed.width).toBeLessThanOrEqual(grown.x + grown.width);
  // The field keeps a little room under the words, and gives it back to the box with a negative margin: the words end inside the box.
  const wordsEnd = await label(page).evaluate((el) => el.getBoundingClientRect().bottom + Number.parseFloat(getComputedStyle(el).marginBottom) * (el.getBoundingClientRect().height / el.offsetHeight));
  expect(wordsEnd).toBeLessThanOrEqual(grown.y + grown.height);
  // One box on screen: the live layer does not draw a second one under the field.
  await expect(page.getByTestId('live').locator('.live-box')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(field).toHaveCount(0);
  await expect.poll(async () => (await adds(page, n0)).length).toBe(1);
  const [box] = (await adds(page, n0)) as Array<Item & { box: [number, number, number, number] }>;
  // Posted at the size it was drawn at.
  expect(box!.box[3]).toBeCloseTo(grown.height / z, 0);
  // Drawn where it was typed: the box, and its words, not a pixel away.
  const saved = (await page.locator(`[data-item="${box!.id}"] .drawn-box`).boundingBox())!;
  for (const k of ['x', 'y', 'width', 'height'] as const) expect(saved[k], k).toBeCloseTo(grown[k], 0);
  const words = (await page.locator(`[data-item="${box!.id}"] .drawn-box__words`).boundingBox())!;
  expect(words.x).toBeCloseTo(typed.x, 0);
  expect(words.width).toBeCloseTo(typed.width, 0);
});

/* ------------------------------------------------------------ a label's width */

test('a label’s field starts at its old width, grows with its words up to a set width, then wraps; the arrow’s words are drawn wrapped at that width too', async ({ page }) => {
  await openFixture(page);
  const n0 = (await admitted(page)).length;
  const z = await zoom(page);
  await drag(page, 'a');
  const fit = page.locator('.label-editor__fit');
  const width = async () => (await fit.boundingBox())!.width / z;
  const height = async () => (await fit.boundingBox())!.height / z;
  expect(await width()).toBeCloseTo(240, 0);
  const line = await height();
  await page.keyboard.type('why?');
  expect(await width()).toBeCloseTo(240, 0);
  await page.keyboard.type(' because the queue in front of it fills up');
  const grown = await width();
  expect(grown).toBeGreaterThan(260);
  expect(grown).toBeLessThan(480);
  expect(await height()).toBeCloseTo(line, 0);
  await page.keyboard.type(' whenever more than sixty-four requests are open at once, and nothing says so');
  expect(await width()).toBeCloseTo(480, 0);
  expect(await height()).toBeGreaterThan(line * 1.8);
  expect(await label(page).evaluate((el: HTMLTextAreaElement) => [el.scrollLeft, el.scrollTop])).toEqual([0, 0]);
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await adds(page, n0)).length).toBe(1);
  const [arrow] = await adds(page, n0);
  const drawn = (await page.locator(`[data-item="${arrow!.id}"] .line-mark__text`).boundingBox())!;
  expect(drawn.width / z).toBeLessThanOrEqual(480 + 0.5);
  expect(drawn.width / z).toBeGreaterThan(400);
  expect(drawn.height / z).toBeGreaterThan(28 * 1.8);
});

/* ------------------------------------------------------------ a refusal */

test('a mark the board refuses comes back as it was drawn, with its words; so does a note, and each is posted once the board takes it', async ({ page }) => {
  // A board that can be told to refuse: the stand-in takes everything.
  let refuse = true;
  let seq = TOOLS.length;
  const posts: Array<{ type: string; item?: Item }> = [];
  await page.routeWebSocket(/\/ws/, (ws) => {
    ws.send(JSON.stringify({ t: 'init', name: 'uLLM', role: 'owner', events: TOOLS, presence: { state: 'listening', since: '2026-11-17T13:00:00Z' } }));
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw)) as { t: string; ref: string; draft: { type: string; item?: Item } };
      if (msg.t !== 'post') return;
      if (refuse && msg.draft.type !== 'item.place') {
        ws.send(JSON.stringify({ t: 'refused', ref: msg.ref, rule: 'R7', reason: 'There is no chapter "x".' }));
        return;
      }
      if (msg.draft.type !== 'item.place') posts.push(msg.draft);
      ws.send(JSON.stringify({ t: 'ok', ref: msg.ref, event: { ...msg.draft, by: 'owner', id: `e${++seq}`, at: new Date(Date.UTC(2026, 10, 17, 14, 0, seq)).toISOString() } }));
    });
  });
  await page.goto('/?token=owner-token');
  await settle(page);

  await drag(page, 'b');
  await page.keyboard.type('the slow part');
  await page.keyboard.press('Enter');
  await expect(toast(page)).toContainText('There is no chapter');
  await expect(label(page)).toHaveValue('the slow part');
  await expect(label(page)).toBeFocused();
  // The box waits for its words drawn by its field.
  await expect(page.locator('.label-editor--box .drawn-box')).toHaveCount(1);
  expect(posts).toHaveLength(0);
  refuse = false;
  await page.keyboard.press('Enter');
  await expect.poll(() => posts.length).toBe(1);
  expect(posts[0]).toMatchObject({ type: 'item.add', item: { kind: 'box', text: 'the slow part' } });
  await expect(label(page)).toHaveCount(0);

  refuse = true;
  await typeNote(page, 'refused once');
  await page.keyboard.press('Enter');
  await expect(note(page)).toHaveValue('refused once');
  // Refused, it is still only the owner's: a reload would bring it back too.
  expect(await draft(page, 'note')).toMatchObject({ text: 'refused once' });
  refuse = false;
  await page.keyboard.press('Enter');
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]).toMatchObject({ type: 'item.add', item: { kind: 'note', text: 'refused once' } });
  expect(await draft(page, 'note')).toBeNull();
});

/* ------------------------------------------------------------ one note, one id; one draft per tab */

test('the board takes a note and the socket drops before its answer: the note comes back, and Enter once the board is back posts nothing twice', async ({ page }) => {
  let seq = TOOLS.length;
  const log: Ev[] = [...TOOLS];
  const posts: Array<{ type: string; item?: Item }> = [];
  let drop = true;
  await page.routeWebSocket(/\/ws/, (ws) => {
    ws.send(JSON.stringify({ t: 'init', name: 'uLLM', role: 'owner', events: log, presence: { state: 'listening', since: '2026-11-17T13:00:00Z' } }));
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw)) as { t: string; ref: string; draft: { type: string; item?: Item } };
      if (msg.t !== 'post') return;
      const event = { ...msg.draft, by: 'owner', id: `e${++seq}`, at: new Date(Date.UTC(2026, 10, 17, 14, 0, seq)).toISOString() } as Ev;
      log.push(event);
      if (msg.draft.type !== 'item.place') posts.push(msg.draft);
      // The board takes the note, and the socket drops before the answer leaves.
      if (drop && msg.draft.type === 'item.add') {
        drop = false;
        void ws.close();
        return;
      }
      ws.send(JSON.stringify({ t: 'ok', ref: msg.ref, event }));
    });
  });
  await page.goto('/?token=owner-token');
  await settle(page);

  await typeNote(page, 'only once please');
  await page.keyboard.press('Enter');
  await expect(toast(page)).toContainText('not connected');
  await expect(note(page)).toHaveValue('only once please');
  // The page connects again and hears what the board holds: the note is there.
  await expect(page.locator('[data-item][data-kind="note"]').filter({ hasText: 'only once please' })).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(note(page)).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(posts.filter((d) => d.type === 'item.add' && d.item?.kind === 'note')).toHaveLength(1);
  await expect(page.locator('[data-item][data-kind="note"]').filter({ hasText: 'only once please' })).toHaveCount(1);
  expect(await draft(page, 'note')).toBeNull();
});

test('two tabs on one board: the second does not open what the first is typing, nor clears it; once the first is closed, the next page brings it back', async ({ page, context }) => {
  await openBoard(page);
  await typeNote(page, 'typed in tab one');
  await expect.poll(() => draft(page, 'note')).toMatchObject({ text: 'typed in tab one' });

  const two = await context.newPage();
  const server = await openBoard(two);
  await expect(note(two)).toHaveCount(0);
  await typeNote(two, 'typed in tab two');
  await two.keyboard.press('Enter');
  await expect.poll(() => marks(server).length).toBe(1);
  expect(marks(server)[0]).toMatchObject({ type: 'item.add', item: { kind: 'note', text: 'typed in tab two' } });
  // The first tab's words are still kept, and still its own.
  expect((await drafts(two, 'note')).map((d) => d.text)).toEqual(['typed in tab one']);
  await expect(note(page)).toHaveValue('typed in tab one');

  // The first tab is closed with its note half typed: the next page on the board brings it back.
  await page.close();
  const three = await context.newPage();
  await openBoard(three);
  await expect(note(three)).toHaveValue('typed in tab one');
  await expect(toast(three)).toContainText('The note you were typing is back');
  // The second tab, open all along, opened nothing of it.
  await expect(note(two)).toHaveCount(0);
});
