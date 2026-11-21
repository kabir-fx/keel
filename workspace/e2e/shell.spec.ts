import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The app shell, end to end, on the system Chrome. It replays a fixture with no server, so it
 * can watch exactly what the app posts: the fixture page announces each admitted event as a
 * `keel:admit` window event, and the test collects them.
 */

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const GOLDEN = here('../protocol/fixtures/engine-loop/log.jsonl');
const FIXTURE = existsSync(GOLDEN) ? 'engine-loop' : 'sample';
const CHECKPOINTS = JSON.parse(
  readFileSync(FIXTURE === 'engine-loop' ? here('../protocol/fixtures/engine-loop/checkpoints.json') : here('../app/src/fixtures/sample/checkpoints.json'), 'utf8'),
) as Array<{ screen: number; name: string }>;
const SHOTS = here('./shots');
mkdirSync(SHOTS, { recursive: true });

interface Admitted {
  id: string;
  type: string;
  by: string;
  item?: { id: string; kind: string; text?: string; box?: number[] } | string;
  patch?: { box?: number[]; text?: string };
}

async function watch(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __admitted: unknown[] };
    w.__admitted = [];
    window.addEventListener('keel:admit', (e) => w.__admitted.push((e as CustomEvent).detail));
  });
}

const admitted = (page: Page) => page.evaluate(() => (window as unknown as { __admitted: Admitted[] }).__admitted);

/** Open a checkpoint and wait until every picture has its place and the fonts are in. */
async function open(page: Page, at: number) {
  await page.goto(`/?fixture=${FIXTURE}&at=${at}`);
  await expect(page.getByTestId('board')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('[data-measure]')).toHaveCount(0);
  // The camera fits after placement; give the cursor's move one frame to settle.
  await page.waitForTimeout(700);
}

const count = async (page: Page, id: string) => Number(await page.getByTestId(id).getAttribute('data-n'));

/** A point to click where a new note (it opens a little up and left of the click) covers only bare ground. */
async function bareGround(page: Page): Promise<{ x: number; y: number }> {
  const p = await page.evaluate(() => {
    // Ink lets the pointer through, so look at what every item draws, not at what is hit.
    const taken = [...document.querySelectorAll('[data-item], [data-item] *, .chrome, .hint, .agent-cursor, .agent-cursor *')]
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

test('the first checkpoint: a calm board, and a note the owner types', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await watch(page);
  await open(page, 1);

  await expect(page.getByTestId('board-name')).toContainText('uLLM');
  await expect(page.getByTestId('presence')).toHaveAttribute('data-state', 'listening');
  await expect(page.getByTestId('agent-cursor')).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Tools' }).getByRole('button')).toHaveCount(12);
  expect(await page.locator('[data-item][data-box]').count()).toBeGreaterThan(0);
  await page.screenshot({ path: `${SHOTS}/shell-1.png` });

  const open0 = await count(page, 'open-count');
  const items0 = await count(page, 'item-count');
  const before = (await admitted(page)).length;

  await page.getByRole('button', { name: 'Write a note' }).click();
  const spot = await bareGround(page);
  await page.mouse.click(spot.x, spot.y);
  const area = page.getByRole('textbox', { name: 'Your note' });
  await expect(area).toBeFocused();
  await page.keyboard.type('Can the engine stream to every client at once?');
  await page.keyboard.press('Enter');

  await expect.poll(() => count(page, 'open-count')).toBe(open0 + 1);
  expect(await count(page, 'item-count')).toBe(items0 + 1);
  const posted = (await admitted(page)).slice(before);
  const adds = posted.filter((e) => e.type === 'item.add');
  expect(adds).toHaveLength(1);
  const item = adds[0]!.item as { kind: string; text: string; box: number[] };
  expect(adds[0]!.by).toBe('owner');
  expect(item.kind).toBe('note');
  expect(item.text).toBe('Can the engine stream to every client at once?');
  await expect(page.locator(`[data-item]`).filter({ hasText: 'Can the engine stream' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/shell-2.png` });
  expect(errors).toEqual([]);
});

test('Esc closes a note with nothing posted, and a dragged note posts its new place', async ({ page }) => {
  await watch(page);
  await open(page, 1);
  const before = (await admitted(page)).length;

  await page.keyboard.press('n');
  const spot = await bareGround(page);
  await page.mouse.click(spot.x, spot.y);
  await page.keyboard.type('never mind');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('textbox', { name: 'Your note' })).toHaveCount(0);
  expect((await admitted(page)).length).toBe(before);

  // Select is back on after a note; drag the first note by 120 by 60 screen pixels.
  await page.keyboard.press('s');
  const note = page.locator('[data-item][data-kind="note"]').first();
  const id = await note.getAttribute('data-item');
  const b = (await note.boundingBox())!;
  await page.mouse.move(b.x + 30, b.y + 20);
  await page.mouse.down();
  await page.mouse.move(b.x + 90, b.y + 50, { steps: 4 });
  await page.mouse.move(b.x + 150, b.y + 80, { steps: 4 });
  await page.mouse.up();
  const moves = (await admitted(page)).slice(before).filter((e) => e.type === 'item.update' && e.item === id);
  expect(moves).toHaveLength(1);
  expect(moves[0]!.patch?.box).toBeTruthy();
  const after = (await note.boundingBox())!;
  expect(Math.round(after.x - b.x)).toBeGreaterThan(100);

  // A double-click edits the note in place; Enter saves the new words.
  await note.dblclick();
  const area = page.getByRole('textbox', { name: 'Your note' });
  await expect(area).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.type(' Edited.');
  await page.keyboard.press('Enter');
  const edits = (await admitted(page)).filter((e) => e.type === 'item.update' && e.item === id && (e.patch as { text?: string }).text);
  expect(edits).toHaveLength(1);
  expect((edits[0]!.patch as { text: string }).text).toMatch(/Edited\.$/);
  await expect(note).toContainText('Edited.');
});

test('every checkpoint renders without an error', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await watch(page);
  for (const c of CHECKPOINTS) {
    await open(page, c.screen);
    await page.screenshot({ path: `${SHOTS}/at-${c.screen}-${c.name}.png` });
    // Each picture with no box is placed once: one item.place per picture, never two.
    const placements = (await admitted(page)).filter((e) => e.type === 'item.place').map((e) => e.item as string);
    expect(new Set(placements).size).toBe(placements.length);
    expect(await page.locator('[data-measure]').count()).toBe(0);
  }
  expect(errors).toEqual([]);
});

test('the server source: token out of the address bar, a note, the agent card beside it, and a refusal', async ({ page }) => {
  const events = readFileSync(here('../app/src/fixtures/sample/log.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .slice(0, 5);
  const posts: Array<{ ref: string; draft: Record<string, unknown> }> = [];
  let seq = events.length;
  let refuseNext = false;
  let server: { send: (m: string) => void } | undefined;
  const stamp = (draft: Record<string, unknown>, by: string) => ({
    ...draft,
    by,
    id: `e${++seq}`,
    at: new Date(Date.UTC(2026, 10, 17, 14, 0, seq)).toISOString(),
  });

  await page.routeWebSocket(/\/ws\?token=/, (ws) => {
    server = ws;
    ws.send(
      JSON.stringify({
        t: 'init',
        name: 'uLLM',
        role: 'owner',
        events,
        presence: { state: 'waiting', note: 'waiting for your go', since: '2026-11-17T13:00:00Z' },
      }),
    );
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw)) as { t: string; ref: string; draft: Record<string, unknown> };
      if (msg.t !== 'post') return;
      posts.push(msg);
      if (refuseNext) {
        ws.send(JSON.stringify({ t: 'refused', ref: msg.ref, rule: 'R7', reason: 'There is no chapter "x".' }));
        return;
      }
      ws.send(JSON.stringify({ t: 'ok', ref: msg.ref, event: stamp(msg.draft, 'owner') }));
    });
  });

  await page.goto('/?token=secret-owner-token');
  await expect(page.getByTestId('presence')).toHaveAttribute('data-state', 'waiting');
  expect(page.url()).not.toContain('token');
  await expect(page.getByTestId('board-name')).toContainText('uLLM');

  const open0 = await count(page, 'open-count');
  await page.getByRole('button', { name: 'Write a note' }).click();
  const spot = await bareGround(page);
  await page.mouse.click(spot.x, spot.y);
  await page.keyboard.type('one engine, many clients');
  await page.keyboard.press('Enter');
  await expect.poll(() => count(page, 'open-count')).toBe(open0 + 1);
  expect(posts.map((p) => p.draft.type)).toEqual(['item.add']);
  expect(posts[0]!.draft.by).toBeUndefined();
  const note = posts[0]!.draft.item as { id: string; box: [number, number, number, number] };

  // The agent answers the note with a card. The app measures it, finds the nearest clear spot
  // round the note (right, below, left or above it), and posts its box.
  const card = {
    type: 'item.add',
    chapter: posts[0]!.draft.chapter,
    item: {
      id: 'a9',
      kind: 'picture',
      answers: [note.id],
      picture: {
        kind: 'text',
        title: 'How I read your note',
        body: 'Many clients, one engine, text back as it is made.',
        lean: 'One engine thread, and a queue in front of it.',
        questions: ['Is one engine thread enough to start?'],
      },
    },
  };
  server!.send(JSON.stringify({ t: 'event', event: stamp(card, 'agent') }));
  await expect.poll(() => posts.length).toBe(2);
  expect(posts[1]!.draft).toMatchObject({ type: 'item.place', item: 'a9' });
  const box = posts[1]!.draft.box as [number, number, number, number];
  const [nx, ny, nw, nh] = note.box;
  const [x, y, w, h] = box;
  const near = (a: number, b: number) => Math.abs(a - b) <= 1;
  // Beside the note: level with it on the right or the left, or lined up with it above or below, at least the gap away.
  const side = [
    near(y, ny) && x >= nx + nw + 48 - 1 ? 'right' : '',
    near(x, nx) && y >= ny + nh + 48 - 1 ? 'below' : '',
    near(y, ny) && x + w <= nx - 48 + 1 ? 'left' : '',
    near(x, nx) && y + h <= ny - 48 + 1 ? 'above' : '',
  ].find(Boolean);
  expect(side, `the card ${box.join(',')} is not beside the note ${note.box.join(',')}`).toBeTruthy();
  // Close to it, and clear of everything else on the board.
  const away = Math.max(x - (nx + nw), nx - (x + w), y - (ny + nh), ny - (y + h));
  expect(away).toBeLessThan(48 + 600);
  await expect(page.locator('[data-item="a9"]')).toBeVisible();
  const drawn = await page.locator('.layer > [data-item][data-box]').evaluateAll((els) =>
    els.map((e) => ({ id: (e as HTMLElement).dataset.item!, box: (e as HTMLElement).dataset.box!.split(',').map(Number) })),
  );
  for (const o of drawn.filter((d) => d.id !== 'a9')) {
    const [ox, oy, ow, oh] = o.box as [number, number, number, number];
    expect(x < ox + ow && ox < x + w && y < oy + oh && oy < y + h, `the card overlaps ${o.id}`).toBe(false);
  }
  await expect(page.locator('[data-item="a9"] [data-sub="q:1"]')).toBeVisible();
  await expect.poll(() => count(page, 'open-count')).toBe(open0);
  await expect(page.locator('[data-lineage]')).not.toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/agent-card.png` });

  refuseNext = true;
  await page.getByRole('button', { name: 'Write a note' }).click();
  const spot2 = await bareGround(page);
  await page.mouse.click(spot2.x, spot2.y);
  await page.keyboard.type('this one is refused');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('toast')).toContainText('There is no chapter');
  await page.screenshot({ path: `${SHOTS}/refused.png` });
  // The refused text comes back, so nothing the owner wrote is lost.
  await expect(page.getByRole('textbox', { name: 'Your note' })).toHaveValue('this one is refused');
  await page.keyboard.press('Escape');

  // A refused edit of a note comes back too, with what was typed.
  await page.keyboard.press('s');
  await page.locator('[data-item]').filter({ hasText: 'one engine, many clients' }).first().dblclick();
  await expect(page.getByRole('textbox', { name: 'Your note' })).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.type(' and one queue');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('toast')).toContainText('There is no chapter');
  await expect(page.getByRole('textbox', { name: 'Your note' })).toHaveValue('one engine, many clients and one queue');
  // A note holds at most 2,000 characters.
  await expect(page.getByRole('textbox', { name: 'Your note' })).toHaveAttribute('maxlength', '2000');
});
