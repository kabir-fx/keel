import { expect, test, type Page } from '@playwright/test';
import { REST_PX } from '../app/src/motion/timing';
import { DRAWER, ECHO, PLANNER, appIsBuilt, startBoard, type RunningBoard } from './board-server';

/**
 * The arrival on a live board: the real server, the stand-in agent, and motion on. The owner
 * writes a note; the agent's card comes over the websocket, the page places it, and the server
 * echoes the placement. The card is drawn on all the same: posed before the page first paints
 * it, never landed by the echo, and left as it rests when it is over.
 *
 * The server serves this run's own build of the app (`board-server.ts`, `APP`). Run it with
 * `KEEL_BOARD_SOURCE=1`, so the server is the source under test too.
 */

let board: RunningBoard | undefined;

test.beforeAll(async () => {
  test.skip(!appIsBuilt(), 'the app is not built for this run');
  board = await startBoard({ link: `script:${ECHO}` });
});

test.afterAll(async () => {
  test.setTimeout(60_000);
  await board?.stop();
});

/** What the page saw of the card: as its element first appeared, and when its arrival ended. */
interface Watched {
  /** In the task the card's element first appeared in, before the page painted it. */
  first?: { playing: boolean; opacity: number; partsPosed: number; parts: number; arrowPosed: number };
  /** When the card appeared, and when its root stopped being drawn on, in the page's ms. */
  appeared?: number;
  ended?: number;
  /**
   * During the pull, each time the board wrote the cursor's place for a frame: how far its tip
   * was from the root's far corner (here its bottom right: the card is placed right of the
   * note), read in the same task, and whether it was inside it.
   */
  samples: Array<{ gap: number; inside: boolean }>;
}

/** Watch for the agent's card from now on: what its first frame holds, and when its arrival ends. */
function watch(page: Page): Promise<void> {
  return page.evaluate(() => {
    const w: Watched = { samples: [] };
    (window as unknown as { __watched: Watched }).__watched = w;
    const layer = document.querySelector('.layer')!;
    const seen = new MutationObserver(() => {
      const item = layer.querySelector<HTMLElement>('[data-item][data-kind="picture"]');
      if (!item || w.first) return;
      const root = item.querySelector<HTMLElement>('[data-build]')!;
      const parts = [...item.querySelectorAll('[data-build]')];
      const arrow = document.querySelector(`[data-lineage$=">${item.dataset.item}"]`);
      w.appeared = performance.now();
      w.first = {
        playing: root.hasAttribute('data-arrival'),
        opacity: parseFloat(getComputedStyle(root).opacity),
        partsPosed: parts.filter((p) => p.getAnimations().length > 0).length,
        parts: parts.length,
        arrowPosed: arrow ? arrow.getAnimations().length : -1,
      };
      seen.disconnect();
      // Each frame the board writes the cursor's place; the parts are drawn at that frame's time.
      const cursor = document.querySelector<HTMLElement>('[data-testid="agent-cursor"]')!;
      const board = document.querySelector('[data-testid="board"]')!.getBoundingClientRect();
      const tip = new MutationObserver(() => {
        if (!root.hasAttribute('data-arrival')) return tip.disconnect();
        const r = root.getBoundingClientRect();
        // Only while it is being pulled: at its size, or growing to it.
        if (r.width < 2 || parseFloat(getComputedStyle(root).opacity) === 0) return;
        const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(cursor.style.transform);
        if (!m) return;
        const [x, y] = [Number(m[1]) + board.left, Number(m[2]) + board.top];
        w.samples.push({ gap: Math.hypot(x - r.right, y - r.bottom), inside: x < r.right - 0.5 || y < r.bottom - 0.5 });
      });
      tip.observe(cursor, { attributes: true, attributeFilter: ['style'] });
      // When the root is no longer drawn on.
      const over = new MutationObserver(() => {
        if (root.hasAttribute('data-arrival')) return;
        w.ended = performance.now();
        over.disconnect();
      });
      over.observe(root, { attributes: true, attributeFilter: ['data-arrival'] });
    });
    seen.observe(layer, { childList: true, subtree: true });
  });
}

test('the agent\'s card is drawn on as it arrives, posed before its first paint, and left as it rests', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(board!.url);
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('presence')).toHaveAttribute('data-state', 'listening');
  await page.evaluate(() => document.fonts.ready);
  await watch(page);

  await page.getByRole('button', { name: 'Write a note' }).click();
  await page.mouse.click(260, 300);
  await page.keyboard.type('remind people of a bill before it is due');
  await page.keyboard.press('Enter');

  const watched = () => page.evaluate(() => (window as unknown as { __watched: Watched }).__watched);
  await expect.poll(async () => (await watched()).first !== undefined, { timeout: 15_000 }).toBe(true);
  const { first } = await watched();
  // Before the page painted it, every part was posed and the card was not seen; its arrow was posed too.
  expect(first!.playing).toBe(true);
  expect(first!.opacity).toBe(0);
  expect(first!.partsPosed).toBe(first!.parts);
  expect(first!.arrowPosed).toBeGreaterThan(0);

  // On every frame of the pull the cursor's tip is on the card's corner, as far out as it rests
  // (the board's rest gap, at this zoom), never inside it: the cursor and the parts keep one time.
  const zoom = await page.evaluate(() => Number(/scale\(([-\d.e]+)\)/.exec(document.querySelector<HTMLElement>('.world')!.style.transform)?.[1] ?? 1));
  await expect.poll(async () => (await watched()).ended !== undefined, { timeout: 10_000 }).toBe(true);
  const { samples } = await watched();
  expect(samples.length, 'frames sampled during the pull').toBeGreaterThan(10);
  for (const [i, s] of samples.entries()) {
    expect(s.gap, `frame ${i}`).toBeLessThanOrEqual(REST_PX * zoom * Math.SQRT2 + 2);
    expect(s.inside, `frame ${i}`).toBe(false);
  }

  // It plays out: the placement's echo from the server does not land it.
  await expect.poll(async () => (await watched()).ended !== undefined, { timeout: 10_000 }).toBe(true);
  const { appeared, ended } = await watched();
  expect(ended! - appeared!).toBeGreaterThan(500);

  // Over: nothing of it is left on the page, and the cursor rests just outside the card's far corner, its bottom right.
  const rest = await page.evaluate(() => {
    const item = document.querySelector<HTMLElement>('.layer [data-item][data-kind="picture"]')!;
    const arrow = document.querySelector(`[data-lineage$=">${item.dataset.item}"]`)!;
    const animated = document.getAnimations().filter((a) => {
      const t = (a.effect as KeyframeEffect | null)?.target;
      return t instanceof Element && (item.contains(t) || t === arrow);
    }).length;
    const card = item.querySelector('[data-build]')!.getBoundingClientRect();
    const board = document.querySelector('[data-testid="board"]')!.getBoundingClientRect();
    const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(document.querySelector<HTMLElement>('[data-testid="agent-cursor"]')!.style.transform)!;
    return {
      animated,
      marked: document.querySelectorAll('[data-arrival], [data-arrival-waits]').length,
      cursor: [Number(m[1]) + board.left, Number(m[2]) + board.top],
      corner: [card.right, card.bottom],
    };
  });
  expect(rest.animated).toBe(0);
  expect(rest.marked).toBe(0);
  expect(rest.cursor[0]).toBeGreaterThan(rest.corner[0]!);
  expect(rest.cursor[1]).toBeGreaterThan(rest.corner[1]!);
  expect(rest.cursor[0]! - rest.corner[0]!).toBeLessThan(24);
  expect(rest.cursor[1]! - rest.corner[1]!).toBeLessThan(24);
  expect(errors).toEqual([]);
});

test.describe('an answer in words', () => {
  let planner: RunningBoard | undefined;
  test.beforeAll(async () => {
    test.skip(!appIsBuilt(), 'the app is not built for this run');
    // The planner answers a mark it draws nothing for in words: its chip hangs under the mark.
    planner = await startBoard({ link: `script:${PLANNER}` });
  });
  test.afterAll(async () => {
    test.setTimeout(60_000);
    await planner?.stop();
  });

  test('its chip is written in from the left under the cursor, posed before its first paint, and left as it rests', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(planner!.url);
    await expect(page.getByTestId('board')).toBeVisible();
    await page.evaluate(() => {
      const w = window as unknown as { __chip?: { playing: boolean; clipped: boolean; ended: boolean } };
      const layer = document.querySelector('.layer')!;
      const seen = new MutationObserver(() => {
        const chip = layer.querySelector<HTMLElement>('[data-read]');
        if (!chip || w.__chip) return;
        w.__chip = { playing: chip.hasAttribute('data-arrival'), clipped: getComputedStyle(chip).clipPath.startsWith('inset'), ended: false };
        seen.disconnect();
        new MutationObserver(() => {
          if (!chip.hasAttribute('data-arrival')) w.__chip!.ended = true;
        }).observe(chip, { attributes: true, attributeFilter: ['data-arrival'] });
      });
      seen.observe(layer, { childList: true, subtree: true });
    });

    // A box drawn round nothing: the planner reads it, and answers in words.
    await page.getByRole('button', { name: 'Draw a box' }).click();
    await page.mouse.move(300, 300);
    await page.mouse.down();
    await page.mouse.move(420, 360, { steps: 6 });
    await page.mouse.up();
    // With no label: the box is kept as it is.
    await page.keyboard.press('Enter');

    const chip = () => page.evaluate(() => (window as unknown as { __chip?: { playing: boolean; clipped: boolean; ended: boolean } }).__chip);
    await expect.poll(async () => (await chip()) !== undefined, { timeout: 20_000 }).toBe(true);
    const first = (await chip())!;
    expect(first.playing, 'drawn on as it first appears').toBe(true);
    expect(first.clipped, 'clipped to nothing before its first paint').toBe(true);
    await expect.poll(async () => (await chip())!.ended, { timeout: 10_000 }).toBe(true);

    const rest = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-read]')!;
      const r = el.getBoundingClientRect();
      const board = document.querySelector('[data-testid="board"]')!.getBoundingClientRect();
      const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(document.querySelector<HTMLElement>('[data-testid="agent-cursor"]')!.style.transform)!;
      return {
        animated: el.getAnimations().length,
        style: el.getAttribute('style'),
        clip: getComputedStyle(el).clipPath,
        cursor: [Number(m[1]) + board.left, Number(m[2]) + board.top],
        right: r.right,
        bottom: r.bottom,
      };
    });
    expect(rest.animated).toBe(0);
    expect(rest.clip).toBe('none');
    expect(rest.style).not.toContain('clip');
    // At rest just past the chip's right end, on its lower edge.
    expect(rest.cursor[0]).toBeGreaterThan(rest.right);
    expect(rest.cursor[0]! - rest.right).toBeLessThan(16);
    expect(Math.abs(rest.cursor[1]! - rest.bottom)).toBeLessThan(2);
    expect(errors).toEqual([]);
  });
});

/** One state the page was left in, for the drawer's picture: after a change to the page, or at a frame. */
interface PlanState {
  is: 'none' | 'placeholder' | 'finished';
  /** Where the board says it is, `data-box`. */
  box?: string;
  /** Held out of sight, or its paper not shown. */
  hidden: boolean;
  /** Its root is being drawn on. */
  playing: boolean;
  /** The root's size on the page. */
  w: number;
  h: number;
  /** How many of its elements are being animated. */
  moving: number;
}

/** Record every state the drawer's picture is left in from now on, as the owner could see it. */
function record(page: Page): Promise<void> {
  return page.evaluate(() => {
    const w = window as unknown as { __states: PlanState[] };
    w.__states = [];
    const look = () => {
      const item = document.querySelector<HTMLElement>('.layer [data-item^="drawn-"]');
      if (!item) return w.__states.push({ is: 'none', hidden: true, playing: false, w: 0, h: 0, moving: 0 });
      const root = item.querySelector<HTMLElement>('[data-build]');
      const r = root?.getBoundingClientRect();
      w.__states.push({
        is: item.querySelector('[data-status="drawing"]') ? 'placeholder' : 'finished',
        box: item.dataset.box,
        hidden: item.hasAttribute('data-arrival-waits') || parseFloat(getComputedStyle(item).opacity) < 0.02,
        playing: !!root?.hasAttribute('data-arrival'),
        w: r?.width ?? 0,
        h: r?.height ?? 0,
        moving: document.getAnimations().filter((a) => {
          const t = (a.effect as KeyframeEffect | null)?.target;
          return t instanceof Element && item.contains(t);
        }).length,
      });
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    const frame = () => {
      look();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

const states = (page: Page) => page.evaluate(() => (window as unknown as { __states: PlanState[] }).__states.splice(0));

/** Nothing of an arrival is left on the drawer's picture, or anywhere on the page. */
const leftOver = (page: Page) =>
  page.evaluate(() => {
    const item = document.querySelector<HTMLElement>('.layer [data-item^="drawn-"]')!;
    return {
      moving: document.getAnimations().filter((a) => {
        const t = (a.effect as KeyframeEffect | null)?.target;
        return t instanceof Element && item.contains(t);
      }).length,
      marked: document.querySelectorAll('[data-arrival], [data-arrival-waits]').length,
    };
  });

test.describe('a placeholder, finished, then drawn again', () => {
  let drawer: RunningBoard | undefined;
  test.beforeAll(async () => {
    test.skip(!appIsBuilt(), 'the app is not built for this run');
    drawer = await startBoard({ link: `script:${DRAWER}` });
  });
  test.afterAll(async () => {
    test.setTimeout(60_000);
    await drawer?.stop();
  });

  test('the placeholder is drawn on; finished, it is pulled from its box to its finished one and never shown whole at the old; drawn again, it keeps its paper', async ({ page }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(drawer!.url);
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByTestId('presence')).toHaveAttribute('data-state', 'listening');
    await page.evaluate(() => document.fonts.ready);
    await record(page);

    const write = async (at: [number, number], words: string) => {
      await page.getByRole('button', { name: 'Write a note' }).click();
      await page.mouse.click(...at);
      await page.keyboard.type(words);
      await page.keyboard.press('Enter');
    };
    const over = async () => {
      await expect(page.getByTestId('presence')).toHaveAttribute('data-state', 'listening', { timeout: 20_000 });
      await expect.poll(async () => (await leftOver(page)).marked, { timeout: 10_000 }).toBe(0);
    };

    await write([260, 300], 'remind people of a bill before it is due');
    await expect(page.locator('.layer [data-item^="drawn-"] [data-status="drawing"]')).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('.layer [data-item^="drawn-"] [data-status="drawing"]')).toHaveCount(0, { timeout: 15_000 });
    await over();
    const made = (await states(page)).filter((s) => s.is !== 'none');
    const placeholder = made.filter((s) => s.is === 'placeholder');
    const first = made.findIndex((s) => s.is === 'finished');
    expect(placeholder.length, 'the placeholder was seen').toBeGreaterThan(0);
    expect(placeholder.some((s) => s.playing), 'the placeholder was drawn on').toBe(true);
    expect(first).toBeGreaterThan(0);
    const was = made[first - 1]!;
    const finished = made.slice(first);
    // From the placeholder straight to the pull: never gone, never held out of sight, never at the placeholder's spot.
    expect(finished.filter((s) => s.hidden)).toEqual([]);
    expect(finished.filter((s) => s.box === was.box)).toEqual([]);
    // The pull starts from the box the placeholder had, and ends at the finished one.
    expect(finished[0]!.playing).toBe(true);
    expect(Math.abs(finished[0]!.w - was.w)).toBeLessThan(2);
    expect(Math.abs(finished[0]!.h - was.h)).toBeLessThan(2);
    const done = finished[finished.length - 1]!;
    expect(Math.abs(done.w - was.w) + Math.abs(done.h - was.h), 'the finished picture has a size of its own').toBeGreaterThan(20);
    expect(await leftOver(page)).toEqual({ moving: 0, marked: 0 });

    await write([260, 650], 'and a second one the day it is due');
    await expect(page.locator('.layer [data-item^="drawn-"]')).toContainText('again', { timeout: 15_000 });
    await over();
    const again = (await states(page)).filter((s) => s.is === 'finished');
    const redrawn = again.filter((s) => s.playing);
    expect(redrawn.length, 'it was drawn on again').toBeGreaterThan(0);
    // Its paper stays: shown, at its size, the whole time; what is on it comes in again.
    expect(again.filter((s) => s.hidden)).toEqual([]);
    expect(redrawn.filter((s) => Math.abs(s.w - again[again.length - 1]!.w) > 0.5 || Math.abs(s.h - again[again.length - 1]!.h) > 0.5)).toEqual([]);
    expect(redrawn.some((s) => s.moving > 0)).toBe(true);
    expect(await leftOver(page)).toEqual({ moving: 0, marked: 0 });
    expect(errors).toEqual([]);
  });
});

test.describe('a picture that arrives as the camera zooms out to show it', () => {
  let zoomed: RunningBoard | undefined;
  test.beforeAll(async () => {
    test.skip(!appIsBuilt(), 'the app is not built for this run');
    zoomed = await startBoard({ link: `script:${ECHO}` });
  });
  test.afterAll(async () => {
    test.setTimeout(60_000);
    await zoomed?.stop();
  });

  test('is measured at the zoom it is drawn at: the tip rides its real corner, and rests just outside it', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(zoomed!.url);
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByTestId('presence')).toHaveAttribute('data-state', 'listening');
    await page.evaluate(() => document.fonts.ready);
    const zoomNow = () => page.evaluate(() => Number(/scale\(([-\d.e]+)\)/.exec(document.querySelector<HTMLElement>('.world')!.style.transform)?.[1] ?? 1));
    // Zoomed in far enough that the note and the card beside it cannot both be shown.
    for (let i = 0; i < 4; i++) await page.keyboard.press('=');
    await expect.poll(zoomNow).toBeGreaterThan(2);
    let before = 0;
    await expect.poll(async () => {
      const z = await zoomNow();
      const still = z === before;
      before = z;
      return still;
    }).toBe(true);
    await watch(page);

    await page.getByRole('button', { name: 'Write a note' }).click();
    await page.mouse.click(200, 300);
    await page.keyboard.type('remind people of a bill before it is due');
    await page.keyboard.press('Enter');

    const watched = () => page.evaluate(() => (window as unknown as { __watched: Watched }).__watched);
    await expect.poll(async () => (await watched()).ended !== undefined, { timeout: 15_000 }).toBe(true);
    const goal = await zoomNow();
    expect(goal, 'the camera zoomed out to show mark and card').toBeLessThan(before);
    // On every frame of the pull the tip is on the card's corner, by no more than the rest gap
    // as drawn on the way from the owner's zoom to the one the camera goes to.
    const { samples } = await watched();
    expect(samples.length, 'frames sampled during the pull').toBeGreaterThan(10);
    for (const [i, s] of samples.entries()) expect(s.gap, `frame ${i}`).toBeLessThanOrEqual(REST_PX * (before / goal) * Math.SQRT2 + 3);
    // At rest, the board's rest gap below the card's real corner, and right of it.
    const rest = await page.evaluate(() => {
      const item = document.querySelector<HTMLElement>('.layer [data-item][data-kind="picture"]')!;
      const card = item.querySelector('[data-build]')!.getBoundingClientRect();
      const board = document.querySelector('[data-testid="board"]')!.getBoundingClientRect();
      const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(document.querySelector<HTMLElement>('[data-testid="agent-cursor"]')!.style.transform)!;
      const size = document.querySelector('.agent-cursor__arrow')!.getBoundingClientRect().width;
      return [Number(m[1]) + board.left - card.right, Number(m[2]) + board.top - card.bottom, board.right - size - card.right];
    });
    // Right of it as far as the board lets the cursor be: it is kept inside the board's right edge by its own size.
    expect(Math.abs(rest[0]! - Math.min(REST_PX, rest[2]!)), `${rest[0]} px right of the corner`).toBeLessThan(1);
    expect(Math.abs(rest[1]! - REST_PX), `${rest[1]} px below the corner`).toBeLessThan(2);
    expect(errors).toEqual([]);
  });
});
