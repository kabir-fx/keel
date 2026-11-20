import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { zoomTo } from './hand';
import { nextFrame, pixelsApart, readCamera } from './pointer';

/**
 * The owner's tools, end to end, on the system Chrome. Each test opens the app's own `tools`
 * fixture (a note, a card with three questions, a small picture), uses one tool with a synthetic
 * pointer path, and checks the event the app posted: its kind, targets, hint and anchor. The
 * fixture page announces each admitted event as a `keel:admit` window event.
 */

const SHOTS = fileURLToPath(new URL('./shots', import.meta.url));
mkdirSync(SHOTS, { recursive: true });

type Box = [number, number, number, number];
type Target = {
  item: string;
  sub?: string;
};
interface Item {
  id: string;
  kind: string;
  box: Box;
  hint?: string;
  targets?: Target[];
  anchor?: Target & { box: Box };
  text?: string;
  on?: Target;
  fromTarget?: Target;
  toTarget?: Target;
  at?: [number, number];
  strokes?: Array<{ pts: number[]; w?: number }>;
  snapshot?: string;
  name?: string;
  asset?: string;
  mime?: string;
  size?: number;
}
interface Admitted {
  id: string;
  type: string;
  by: string;
  item?: Item | string;
  patch?: { box?: Box };
  picks?: string[];
  lasso?: string;
}

async function open(page: Page, init?: () => void) {
  await page.addInitScript(() => {
    const w = window as unknown as { __admitted: unknown[] };
    w.__admitted = [];
    window.addEventListener('keel:admit', (e) => w.__admitted.push((e as CustomEvent).detail));
  });
  if (init) await page.addInitScript(init);
  await page.goto('/?fixture=tools&at=1');
  await expect(page.getByTestId('board')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('[data-measure]')).toHaveCount(0);
  await page.waitForTimeout(500);
}

const admitted = (page: Page) => page.evaluate(() => (window as unknown as { __admitted: Admitted[] }).__admitted);

/** The marks the app added since `from`. */
async function addsSince(page: Page, from: number): Promise<Item[]> {
  return (await admitted(page))
    .slice(from)
    .filter((e) => e.type === 'item.add')
    .map((e) => e.item as Item);
}

/** Wait for the next mark, and return it. */
async function nextMark(page: Page, from: number): Promise<Item> {
  await expect.poll(async () => (await addsSince(page, from)).length, { timeout: 5000 }).toBeGreaterThan(0);
  return (await addsSince(page, from))[0]!;
}

async function box(page: Page, selector: string) {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`${selector} is not on screen`);
  return b;
}

const zoom = async (page: Page) => Number((await page.getByTestId('zoom').textContent())!.replace('%', '')) / 100;

/** Move the mouse along a path with the button down: one stroke. */
async function draw(page: Page, pts: Array<[number, number]>) {
  await page.mouse.move(pts[0]![0], pts[0]![1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(x, y);
  await page.mouse.up();
}

const ellipse = (cx: number, cy: number, rx: number, ry: number, turns = 1.06, n = 48): Array<[number, number]> =>
  Array.from({ length: n + 1 }, (_, i) => {
    const t = -Math.PI / 2 + (i / n) * turns * 2 * Math.PI;
    return [cx + rx * Math.cos(t) * (1 + 0.02 * Math.sin(5 * t)), cy + ry * Math.sin(t)];
  });

const line = (x0: number, y0: number, x1: number, y1: number, n = 14): Array<[number, number]> =>
  Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);

/** The anchor's box is where the thing is drawn, in board units: its size is the screen size over the zoom. */
async function expectAnchorOn(page: Page, item: Item, target: Target, selector: string) {
  expect(item.anchor).toMatchObject(target);
  const z = await zoom(page);
  const b = await box(page, selector);
  expect(Math.abs(item.anchor!.box[2] - b.width / z)).toBeLessThan(3);
  expect(Math.abs(item.anchor!.box[3] - b.height / z)).toBeLessThan(3);
}

const Q = (n: number) => `[data-item="a1"] [data-sub="q:${n}"]`;

test('the toolbar: every tool works, and says its key', async ({ page }) => {
  await open(page);
  const tools = page.getByRole('toolbar', { name: 'Tools' });
  await expect(tools.getByRole('button')).toHaveCount(12);
  await expect(tools.getByRole('button', { name: 'Draw with the pen' })).toHaveAttribute('data-tip', 'Draw with the pen (P)');
  await expect(tools.getByRole('button', { name: 'Lasso several items' })).toHaveAttribute('data-tip', 'Lasso several items (L)');
  await page.keyboard.press('p');
  await expect(tools.getByRole('button', { name: 'Draw with the pen' })).toHaveAttribute('aria-pressed', 'true');
  // The agent's cursor is on the card that presence names.
  const card = await box(page, '[data-item="a1"]');
  const cursor = await box(page, '[data-testid="agent-cursor"]');
  expect(cursor.x).toBeGreaterThan(card.x + card.width / 2);
  expect(cursor.y).toBeGreaterThan(card.y + card.height / 2);
  await page.screenshot({ path: `${SHOTS}/tools-1-board.png` });
});

test('the pen: a loop round a question is one ink mark, a circle on that question, once the pen rests', async ({ page }) => {
  await open(page);
  const n0 = (await admitted(page)).length;
  await page.keyboard.press('p');
  const q = await box(page, Q(2));
  await draw(page, ellipse(q.x + q.width / 2, q.y + q.height / 2, q.width / 2 + 16, q.height / 2 + 14));
  // The stroke shows at once, and is not a mark yet.
  await expect(page.locator('[data-testid="live"] svg.ink')).toHaveCount(1);
  await page.waitForTimeout(250);
  expect(await addsSince(page, n0)).toHaveLength(0);
  const ink = await nextMark(page, n0);
  expect(ink.kind).toBe('ink');
  expect(ink.hint).toBe('circle');
  expect(ink.targets).toEqual([{ item: 'a1', sub: 'q:2' }]);
  await expectAnchorOn(page, ink, { item: 'a1', sub: 'q:2' }, Q(2));
  expect(ink.snapshot).toBeUndefined(); // local mode: no snapshot
  expect(ink.strokes).toHaveLength(1);
  // The card shows the question circled; the board counts one more open mark.
  await expect(page.locator(Q(2))).toHaveClass(/kp--circled/);
  await expect(page.locator(`[data-item="${ink.id}"] svg.ink`)).toBeVisible();
  await expect(page.locator('[data-testid="live"] svg.ink')).toHaveCount(0);
});

test('the pen: two crossed strokes in one go are one cross; a line under a question underlines it', async ({ page }) => {
  await open(page);
  let n0 = (await admitted(page)).length;
  await page.keyboard.press('p');
  const q3 = await box(page, Q(3));
  const [l, t, r, b] = [q3.x + 20, q3.y - 4, q3.x + q3.width - 20, q3.y + q3.height + 4];
  await draw(page, line(l, t, r, b));
  await draw(page, line(r, t, l, b));
  const cross = await nextMark(page, n0);
  expect(cross).toMatchObject({ kind: 'ink', hint: 'cross', targets: [{ item: 'a1', sub: 'q:3' }] });
  expect(cross.strokes).toHaveLength(2);
  await expectAnchorOn(page, cross, { item: 'a1', sub: 'q:3' }, Q(3));
  await expect(page.locator(Q(3))).toHaveClass(/kp--crossed/);

  n0 = (await admitted(page)).length;
  const q1 = await box(page, Q(1));
  await draw(page, line(q1.x + 10, q1.y + q1.height + 3, q1.x + q1.width * 0.7, q1.y + q1.height + 5));
  const under = await nextMark(page, n0);
  expect(under).toMatchObject({ kind: 'ink', hint: 'underline', targets: [{ item: 'a1', sub: 'q:1' }] });
  await expectAnchorOn(page, under, { item: 'a1', sub: 'q:1' }, Q(1));
  await page.screenshot({ path: `${SHOTS}/tools-2-pen.png` });
});

test('the pen: a sketch on bare ground has no targets and no anchor; a loop round a test double takes its sub', async ({ page }) => {
  await open(page);
  // A test double: a thing with a data-sub inside a picture whose renderer may not draw subs yet.
  await page.evaluate(() => {
    const host = document.querySelector('[data-item="a2"]')!.firstElementChild!;
    const el = document.createElement('div');
    el.dataset.sub = 'part:bridge';
    el.textContent = 'the bridge';
    el.style.cssText = 'width: 120px; height: 40px; margin: 12px; border: 2px dashed #1D4ED8; border-radius: 6px; display: flex; align-items: center; justify-content: center; font: 600 14px Inter';
    host.appendChild(el);
  });
  let n0 = (await admitted(page)).length;
  await page.keyboard.press('p');
  const d = await box(page, '[data-item="a2"] [data-sub="part:bridge"]');
  await draw(page, ellipse(d.x + d.width / 2, d.y + d.height / 2, d.width / 2 + 14, d.height / 2 + 12));
  const ring = await nextMark(page, n0);
  expect(ring).toMatchObject({ kind: 'ink', hint: 'circle', targets: [{ item: 'a2', sub: 'part:bridge' }], anchor: { item: 'a2', sub: 'part:bridge' } });

  n0 = (await admitted(page)).length;
  const vp = page.viewportSize()!;
  const [x, y] = [vp.width - 360, vp.height - 330];
  await draw(page, [
    [x, y],
    [x + 30, y + 40],
    [x + 60, y],
    [x + 90, y + 40],
    [x + 120, y],
    [x + 150, y + 40],
  ]);
  const sketch = await nextMark(page, n0);
  expect(sketch).toMatchObject({ kind: 'ink', hint: 'none', targets: [] });
  expect(sketch.anchor).toBeUndefined();
});

test('a box round a note hangs on it, with a label typed on it', async ({ page }) => {
  await open(page);
  const n0 = (await admitted(page)).length;
  await page.keyboard.press('b');
  const m1 = await box(page, '[data-item="m1"]');
  await draw(page, line(m1.x - 14, m1.y - 14, m1.x + m1.width + 14, m1.y + m1.height + 14, 6));
  await expect(page.getByRole('textbox', { name: 'A few words' })).toBeFocused();
  await page.keyboard.type('where it starts');
  await page.keyboard.press('Enter');
  const b = await nextMark(page, n0);
  expect(b).toMatchObject({ kind: 'box', text: 'where it starts', anchor: { item: 'm1' } });
  await expect(page.locator(`[data-item="${b.id}"]`)).toContainText('where it starts');
});

test('an arrow takes the thing under each end, and a label', async ({ page }) => {
  await open(page);
  const n0 = (await admitted(page)).length;
  await page.keyboard.press('a');
  const m2 = await box(page, '[data-item="m2"]');
  const q1 = await box(page, Q(1));
  await draw(page, line(m2.x + m2.width / 2, m2.y + 10, q1.x + 30, q1.y + q1.height / 2, 8));
  await page.keyboard.type('why?');
  await page.keyboard.press('Enter');
  const a = await nextMark(page, n0);
  expect(a).toMatchObject({ kind: 'arrow', text: 'why?', fromTarget: { item: 'm2' }, toTarget: { item: 'a1', sub: 'q:1' } });
  await expectAnchorOn(page, a, { item: 'a1', sub: 'q:1' }, Q(1));
});

for (const dpr of [1, 2]) {
  test.describe(`at pixel density ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });
    for (const z of [1, 4]) {
      test(`at ${z * 100}%, an arrow whose ends are off the whole board unit: not one pixel of it moves when it is saved`, async ({ page }) => {
        await open(page);
        await zoomTo(page, z);
        expect((await readCamera(page)).z).toBe(z);
        await page.keyboard.press('a');
        // On bare board, 0.3 px off the whole pixel: at either zoom its ends are a fraction of a board unit off.
        const [x0, y0, x1, y1] = [900.3, 700.3, 1180.3, 760.3];
        await page.mouse.move(x0, y0);
        await page.mouse.down();
        for (let i = 1; i <= 10; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10);
        await nextFrame(page);
        await expect(page.locator('[data-testid="live"] svg.live-line')).toHaveCount(1);
        // Its tail end, clear of the middle where its words go.
        const clip = { x: 880, y: 680, width: 110, height: 60 };
        const seenLive = await page.screenshot({ clip });
        const n0 = (await admitted(page)).length;
        await page.mouse.up();
        await page.keyboard.type('x');
        await page.keyboard.press('Enter');
        const arrow = await nextMark(page, n0);
        expect(arrow.kind).toBe('arrow');
        await expect(page.locator(`[data-item="${arrow.id}"] svg.line-mark`)).toBeVisible();
        await expect(page.locator('[data-testid="live"] svg.live-line')).toHaveCount(0);
        // Nothing selected, and the pointer away from it.
        await page.keyboard.press('Escape');
        await page.mouse.move(300, 850);
        await nextFrame(page);
        await expect(page.locator(`[data-item="${arrow.id}"]`)).not.toHaveClass(/item--selected/);
        expect(await pixelsApart(page, seenLive, await page.screenshot({ clip }))).toBe(0);
      });
    }
  });
}

test('a pin: a click on a thing, then a few words', async ({ page }) => {
  await open(page);
  const n0 = (await admitted(page)).length;
  await page.keyboard.press('i');
  const q3 = await box(page, Q(3));
  await page.mouse.click(q3.x + 40, q3.y + q3.height / 2);
  await page.keyboard.type('this one');
  await page.keyboard.press('Enter');
  const p = await nextMark(page, n0);
  expect(p).toMatchObject({ kind: 'pin', text: 'this one', on: { item: 'a1', sub: 'q:3' } });
  await expectAnchorOn(page, p, { item: 'a1', sub: 'q:3' }, Q(3));
  await expect(page.locator(`[data-item="${p.id}"] .pin__text`)).toHaveText('this one');
});

test('a pin’s words wrap within a short width, so they do not run across the next card', async ({ page }) => {
  await open(page);
  const n0 = (await admitted(page)).length;
  await page.keyboard.press('i');
  const q3 = await box(page, Q(3));
  await page.mouse.click(q3.x + 40, q3.y + q3.height / 2);
  const words = 'this one, and also the second half of the next answer, which the agent has not read at all yet';
  await page.keyboard.type(words);
  await page.keyboard.press('Enter');
  const p = await nextMark(page, n0);
  const label = page.locator(`[data-item="${p.id}"] .pin__text`);
  await expect(label).toHaveText(words);
  const b = (await label.boundingBox())!;
  const z = Number((await page.getByTestId('zoom').textContent())!.replace('%', '')) / 100;
  // At most 240 units of words, with the padding and the border, at the board's zoom.
  expect(b.width).toBeLessThanOrEqual((240 + 2 * 10 + 4) * z + 1);
  expect(b.height).toBeGreaterThan(40 * z);
});

test('a lasso takes the items mostly inside it, is drawn round them, and Solidify posts them as picks', async ({ page }) => {
  await open(page);
  const n0 = (await admitted(page)).length;
  const solidify = page.locator('[data-tool="solidify"]');
  await expect(solidify).toBeDisabled();
  await page.keyboard.press('l');
  const m1 = await box(page, '[data-item="m1"]');
  const a1 = await box(page, '[data-item="a1"]');
  const [l, t] = [m1.x - 30, Math.min(m1.y, a1.y) - 30];
  const [r, b] = [a1.x + a1.width + 30, Math.max(m1.y + m1.height, a1.y + a1.height) + 30];
  await draw(page, [...line(l, t, r, t, 10), ...line(r, t, r, b, 10).slice(1), ...line(r, b, l, b, 10).slice(1), ...line(l, b, l, t + 10, 10).slice(1)]);
  const lasso = await nextMark(page, n0);
  expect(lasso).toMatchObject({ kind: 'lasso', targets: [{ item: 'm1' }, { item: 'a1' }] });
  expect(lasso.anchor).toBeUndefined();
  // Drawn as a tidy outline round its targets, not as the raw path, with how many it holds.
  await expect(page.locator(`[data-item="${lasso.id}"] .lasso-outline`)).toBeVisible();
  await expect(page.locator(`[data-item="${lasso.id}"] .lasso-pill`)).toHaveText('2 picked');
  const outline = await box(page, `[data-item="${lasso.id}"] .lasso-outline`);
  expect(outline.x).toBeLessThan(m1.x);
  expect(outline.x).toBeGreaterThan(l - 10);
  await expect(solidify).toBeEnabled();
  await expect(solidify).toHaveAttribute('data-tip', 'Solidify the 2 items in your lasso (Shift+S)');
  await page.screenshot({ path: `${SHOTS}/tools-3-lasso.png` });

  // A note written inside the lasso, off its items (in the margin under the note), hangs on the lasso.
  await page.keyboard.press('n');
  await page.mouse.click(m1.x + 12, m1.y + m1.height + 7);
  await page.keyboard.type('yes. this is it.');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await addsSince(page, n0)).some((i) => i.kind === 'note')).toBe(true);
  const yes = (await addsSince(page, n0)).find((i) => i.kind === 'note')!;
  expect(yes.anchor?.item).toBe(lasso.id);
  expect(yes.on).toBeUndefined();

  const n1 = (await admitted(page)).length;
  await solidify.click();
  await expect.poll(async () => (await admitted(page)).slice(n1).map((e) => e.type)).toContain('solidify');
  const act = (await admitted(page)).slice(n1).find((e) => e.type === 'solidify')!;
  expect(act).toMatchObject({ by: 'owner', picks: ['m1', 'a1'], lasso: lasso.id });
  await expect(solidify).toBeDisabled();
  await expect(page.getByTestId('chapter-state')).toHaveText('solid');
});

test('drop in: the file picker and a drop onto a card each add a file', async ({ page }) => {
  await open(page);
  let n0 = (await admitted(page)).length;
  await page.getByTestId('file-input').setInputFiles({ name: 'roadmap notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Roadmap\n\nOne engine.\n') });
  const picked = await nextMark(page, n0);
  expect(picked).toMatchObject({ kind: 'file', name: 'roadmap notes.md', asset: 'assets/roadmap-notes.md', mime: 'text/markdown', size: 23 });

  n0 = (await admitted(page)).length;
  const card = await box(page, '[data-item="a1"]');
  const data = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['a,b\n1,2\n'], 'queue-depth.csv', { type: 'text/csv' }));
    return dt;
  });
  const at = { clientX: card.x + 60, clientY: card.y + 40 };
  await page.getByTestId('board').dispatchEvent('dragover', { dataTransfer: data, ...at });
  await expect(page.getByTestId('drop-hint')).toBeVisible();
  await page.getByTestId('board').dispatchEvent('drop', { dataTransfer: data, ...at });
  const dropped = await nextMark(page, n0);
  expect(dropped).toMatchObject({ kind: 'file', name: 'queue-depth.csv', asset: 'assets/queue-depth.csv', anchor: { item: 'a1' } });
  await expect(page.getByTestId('drop-hint')).toHaveCount(0);
  await expect(page.locator(`[data-item="${dropped.id}"]`)).toContainText('queue-depth.csv');
  // The tile opens the file it holds: a button that reads the file, not a link to copy.
  const popup = page.waitForEvent('popup');
  await page.locator(`[data-item="${dropped.id}"]`).getByRole('button', { name: 'Open' }).click();
  const tab = await popup;
  await expect.poll(() => tab.url()).toMatch(/^blob:/);
});

test('talk: hold T over a question, say it, let go: a spoken remark on that question', async ({ page }) => {
  await open(page, () => {
    // A stand-in for the browser's speech recognition, which needs a microphone and a network.
    class Fake {
      lang = '';
      continuous = false;
      interimResults = false;
      onresult: ((e: unknown) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        setTimeout(() => this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: 'so this cap is per client' }], { isFinal: false })] }), 50);
      }
      stop() {
        this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: 'so this cap is per client?' }], { isFinal: true })] });
        setTimeout(() => this.onend?.(), 20);
      }
      abort() {
        this.onend?.();
      }
    }
    // Chrome has both names; the app takes the plain one first.
    Object.assign(window, { SpeechRecognition: Fake, webkitSpeechRecognition: Fake });
  });
  const n0 = (await admitted(page)).length;
  const q1 = await box(page, Q(1));
  await page.mouse.move(q1.x + 60, q1.y + q1.height / 2);
  await page.keyboard.down('t');
  await expect(page.getByTestId('talk-caption')).toContainText('so this cap is per client');
  await page.screenshot({ path: `${SHOTS}/tools-4-talk.png` });
  await page.keyboard.up('t');
  const v = await nextMark(page, n0);
  expect(v).toMatchObject({ kind: 'voice', text: 'so this cap is per client?', on: { item: 'a1', sub: 'q:1' } });
  await expectAnchorOn(page, v, { item: 'a1', sub: 'q:1' }, Q(1));
  await expect(page.getByTestId('talk-caption')).toHaveCount(0);
});

test('select: a click selects a mark, Delete takes it off, Cmd+Z puts it back and then takes back the step before, a drag moves a picture and its marks', async ({ page }) => {
  await open(page);
  await page.keyboard.press('p');
  const q2 = await box(page, Q(2));
  let n0 = (await admitted(page)).length;
  await draw(page, ellipse(q2.x + q2.width / 2, q2.y + q2.height / 2, q2.width / 2 + 16, q2.height / 2 + 14));
  const ring = await nextMark(page, n0);
  n0 = (await admitted(page)).length;
  const q3 = await box(page, Q(3));
  await draw(page, line(q3.x + 10, q3.y + q3.height + 3, q3.x + q3.width * 0.6, q3.y + q3.height + 4));
  const under = await nextMark(page, n0);

  // Drag the card: it moves, and the ring on its question moves with it.
  await page.keyboard.press('v');
  const card = await box(page, '[data-item="a1"]');
  const ringBefore = await box(page, `[data-item="${ring.id}"] svg`);
  n0 = (await admitted(page)).length;
  await page.mouse.move(card.x + 30, card.y + 14);
  await page.mouse.down();
  await page.mouse.move(card.x + 130, card.y + 64, { steps: 5 });
  await page.mouse.move(card.x + 230, card.y + 114, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await admitted(page)).slice(n0).filter((e) => e.type === 'item.update' && e.item === 'a1').length).toBe(1);
  const cardAfter = await box(page, '[data-item="a1"]');
  const ringAfter = await box(page, `[data-item="${ring.id}"] svg`);
  expect(Math.round(cardAfter.x - card.x)).toBe(200);
  expect(Math.abs(ringAfter.x - ringBefore.x - 200)).toBeLessThan(2);
  expect(Math.abs(ringAfter.y - ringBefore.y - 100)).toBeLessThan(2);
  await page.screenshot({ path: `${SHOTS}/tools-5-moved.png` });

  // A click on the ring's line selects it; Delete takes it off.
  const r = await box(page, `[data-item="${ring.id}"] svg`);
  n0 = (await admitted(page)).length;
  await page.mouse.click(r.x + r.width / 2, r.y + 8);
  await expect(page.locator(`[data-item="${ring.id}"]`)).toHaveClass(/item--selected/);
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await admitted(page)).slice(n0).map((e) => [e.type, e.item])).toContainEqual(['item.remove', ring.id]);
  await expect(page.locator(`[data-item="${ring.id}"]`)).toHaveCount(0);
  await expect(page.locator(Q(2))).not.toHaveClass(/kp--circled/);

  // Cmd+Z undoes the last step: it puts back what Delete took off. Again, and it takes back the
  // step before that, the move of the card; again, and the mark drawn before the move comes off.
  n0 = (await admitted(page)).length;
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => (await admitted(page)).slice(n0).map((e) => [e.type, e.item])).toEqual([['item.restore', ring.id]]);
  await expect(page.locator(`[data-item="${ring.id}"]`)).toHaveCount(1);
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => (await admitted(page)).slice(n0).map((e) => [e.type, e.item])).toEqual([['item.restore', ring.id], ['item.update', 'a1']]);
  await expect.poll(async () => Math.round((await box(page, '[data-item="a1"]')).x - card.x)).toBe(0);
  await page.keyboard.press('Meta+z');
  await expect.poll(async () => (await admitted(page)).slice(n0).map((e) => [e.type, e.item])).toEqual([['item.restore', ring.id], ['item.update', 'a1'], ['item.remove', under.id]]);
});

test('moving ink keeps its id: one item.update of its box, drawn where it lands', async ({ page }) => {
  await open(page);
  await page.keyboard.press('p');
  const q1 = await box(page, Q(1));
  const q2 = await box(page, Q(2));
  let n0 = (await admitted(page)).length;
  await draw(page, ellipse(q2.x + q2.width / 2, q2.y + q2.height / 2, q2.width / 2 + 16, q2.height / 2 + 12));
  const ring = await nextMark(page, n0);
  expect(ring.targets).toEqual([{ item: 'a1', sub: 'q:2' }]);
  // Everything inside the mark is counted from the corner of its box.
  const xs = ring.strokes!.flatMap((s) => s.pts.filter((_, i) => i % 2 === 0));
  expect(Math.min(...xs)).toBeLessThan(1);

  // Take the ring by its line and drop it one row up.
  await page.keyboard.press('v');
  const svg = await box(page, `[data-item="${ring.id}"] svg`);
  const grab = { x: svg.x + svg.width / 2, y: svg.y + 9 };
  const dy = q2.y - q1.y;
  n0 = (await admitted(page)).length;
  // Cmd held: the ring lands where it is put, not on an edge it passes near.
  await page.keyboard.down('Meta');
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x, grab.y - dy / 2, { steps: 4 });
  await page.mouse.move(grab.x, grab.y - dy, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Meta');
  await expect.poll(async () => (await admitted(page)).slice(n0).length).toBe(1);
  const [move] = (await admitted(page)).slice(n0);
  expect(move).toMatchObject({ type: 'item.update', item: ring.id });
  expect(Object.keys(move!.patch!)).toEqual(['box']);
  // The same mark, with the same strokes and targets, now drawn one row up.
  await expect(page.locator(`[data-item="${ring.id}"]`)).toHaveCount(1);
  const after = await box(page, `[data-item="${ring.id}"] svg`);
  expect(Math.abs(after.y - (svg.y - dy))).toBeLessThan(2);
  expect(Math.abs(after.x - svg.x)).toBeLessThan(2);

  // A free sketch on bare ground moves the same way.
  await page.keyboard.press('p');
  const vp = page.viewportSize()!;
  const [x, y] = [vp.width - 360, vp.height - 330];
  n0 = (await admitted(page)).length;
  await draw(page, [[x, y], [x + 30, y + 40], [x + 60, y], [x + 90, y + 40], [x + 120, y]]);
  const sketch = await nextMark(page, n0);
  await page.keyboard.press('v');
  n0 = (await admitted(page)).length;
  await page.mouse.move(x + 30, y + 40);
  await page.mouse.down();
  await page.mouse.move(x - 20, y + 60, { steps: 4 });
  await page.mouse.move(x - 70, y + 80, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await admitted(page)).slice(n0).map((e) => [e.type, e.item])).toEqual([['item.update', sketch.id]]);
  await page.screenshot({ path: `${SHOTS}/tools-7-ink-moved.png` });
});

test('every mark on one card, as the owner would leave them: a picture to look at', async ({ page }) => {
  await open(page);
  const q = [await box(page, Q(1)), await box(page, Q(2)), await box(page, Q(3))] as const;
  let n0 = (await admitted(page)).length;
  await page.keyboard.press('p');
  await draw(page, ellipse(q[1].x + q[1].width / 2, q[1].y + q[1].height / 2, q[1].width / 2 + 16, q[1].height / 2 + 14));
  await nextMark(page, n0);
  n0 = (await admitted(page)).length;
  await draw(page, line(q[2].x + 20, q[2].y - 4, q[2].x + q[2].width - 20, q[2].y + q[2].height + 4));
  await draw(page, line(q[2].x + q[2].width - 20, q[2].y - 4, q[2].x + 20, q[2].y + q[2].height + 4));
  await nextMark(page, n0);
  n0 = (await admitted(page)).length;
  await page.keyboard.press('a');
  const m2 = await box(page, '[data-item="m2"]');
  await draw(page, line(m2.x + m2.width - 20, m2.y + 8, q[0].x + 30, q[0].y + q[0].height, 8));
  await page.keyboard.type('a cap per client?');
  await page.keyboard.press('Enter');
  await nextMark(page, n0);
  n0 = (await admitted(page)).length;
  await page.keyboard.press('i');
  await page.mouse.click(q[0].x + q[0].width - 40, q[0].y + q[0].height / 2);
  await page.keyboard.type('yes, 64');
  await page.keyboard.press('Enter');
  await nextMark(page, n0);
  await page.keyboard.press('v');
  await page.mouse.click(5, 450);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/tools-6-marks.png` });
});
