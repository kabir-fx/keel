import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { REST_PX } from '../app/src/motion/timing';
import { DRAWER, ECHO, PLANNER, appIsBuilt, startBoard, type RunningBoard } from './board-server';

/** The stand-in agent that answers a note with two pictures in one post. */
const TWO = fileURLToPath(new URL('./agents/two.mjs', import.meta.url));
/** The stand-in agent that answers a note with a card placeholder, finished as a wide picture. */
const WIDE = fileURLToPath(new URL('./agents/wide.mjs', import.meta.url));

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
   * While the band is seen, each time the board wrote the cursor's place for a frame: how far its
   * tip was from the band's far corner (here its bottom right: the card is placed right of the
   * note), read in the same task, and whether it was inside it.
   */
  samples: Array<{ gap: number; inside: boolean }>;
  /** Each time the board wrote the cursor's place while the card was drawn on: what was set on the root that would move or size it. */
  moved: string[];
}

/** Watch for the agent's card from now on: what its first frame holds, and when its arrival ends. */
function watch(page: Page): Promise<void> {
  return page.evaluate(() => {
    const w: Watched = { samples: [], moved: [] };
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
      const band = item.querySelector<HTMLElement>('.arrival-band');
      const tip = new MutationObserver(() => {
        if (!root.hasAttribute('data-arrival')) return tip.disconnect();
        const rs = getComputedStyle(root);
        const moved = [rs.transform, rs.scale, rs.translate].filter((v) => v !== 'none' && v !== '').join(' ');
        if (moved) w.moved.push(moved);
        // Only while the band is seen: dragged out, or going. At its first frames it is only its borders, round the tip.
        if (!band?.isConnected || parseFloat(getComputedStyle(band).opacity) < 0.02) return;
        const r = band.getBoundingClientRect();
        const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(cursor.style.transform);
        if (!m) return;
        const [x, y] = [Number(m[1]) + board.left, Number(m[2]) + board.top];
        w.samples.push({ gap: Math.hypot(x - r.right, y - r.bottom), inside: (r.width > 4 || r.height > 4) && (x < r.right - 0.5 || y < r.bottom - 0.5) });
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

  // On every frame of the drag the cursor's tip is on the band's corner, never further out than it
  // rests (the board's rest gap, on the screen), never inside it: the cursor and the band keep one
  // time. The card itself is never scaled or moved.
  await expect.poll(async () => (await watched()).ended !== undefined, { timeout: 10_000 }).toBe(true);
  const { samples, moved } = await watched();
  expect(samples.length, 'frames sampled during the drag').toBeGreaterThan(10);
  for (const [i, s] of samples.entries()) {
    expect(s.gap, `frame ${i}`).toBeLessThanOrEqual(REST_PX * Math.SQRT2 + 2);
    expect(s.inside, `frame ${i}`).toBe(false);
  }
  expect(moved).toEqual([]);

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
  /** The band it is dragged out as, while it is seen: its size on the page. */
  band: { w: number; h: number } | null;
}

/** Record every state the drawer's picture is left in from now on, as the owner could see it. */
function record(page: Page): Promise<void> {
  return page.evaluate(() => {
    const w = window as unknown as { __states: PlanState[] };
    w.__states = [];
    const look = () => {
      const item = document.querySelector<HTMLElement>('.layer [data-item^="drawn-"]');
      if (!item) return w.__states.push({ is: 'none', hidden: true, playing: false, w: 0, h: 0, moving: 0, band: null });
      const root = item.querySelector<HTMLElement>('[data-build]');
      const r = root?.getBoundingClientRect();
      const band = item.querySelector<HTMLElement>('.arrival-band');
      const b = band && parseFloat(getComputedStyle(band).opacity) > 0.02 ? band.getBoundingClientRect() : null;
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
        band: b && { w: b.width, h: b.height },
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
    // The band stands at the box the placeholder had from the first state it is drawn on, and is
    // dragged to the finished one; the picture itself is never drawn at another size.
    expect(finished[0]!.playing).toBe(true);
    expect(finished[0]!.band, 'the band stands where the placeholder was').not.toBeNull();
    expect(Math.abs(finished[0]!.band!.w - was.w)).toBeLessThan(2);
    expect(Math.abs(finished[0]!.band!.h - was.h)).toBeLessThan(2);
    const done = finished[finished.length - 1]!;
    expect(Math.abs(done.w - was.w) + Math.abs(done.h - was.h), 'the finished picture has a size of its own').toBeGreaterThan(20);
    expect(finished.filter((s) => Math.abs(s.w - done.w) > 0.5 || Math.abs(s.h - done.h) > 0.5)).toEqual([]);
    expect(finished.some((s) => s.band && Math.abs(s.band.w - done.w) < 2 && Math.abs(s.band.h - done.h) < 2), 'the band reaches the finished box').toBe(true);
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
    // On every frame of the drag the tip is on the band's corner, by no more than the rest gap:
    // the camera has stopped before the band is dragged.
    const { samples, moved } = await watched();
    expect(samples.length, 'frames sampled during the drag').toBeGreaterThan(10);
    for (const [i, s] of samples.entries()) expect(s.gap, `frame ${i}`).toBeLessThanOrEqual(REST_PX * Math.SQRT2 + 2);
    expect(moved).toEqual([]);
    // At rest, the board's rest gap below the card's real corner, and right of it.
    const rest = await page.evaluate(() => {
      const item = document.querySelector<HTMLElement>('.layer [data-item][data-kind="picture"]')!;
      const card = item.querySelector('[data-build]')!.getBoundingClientRect();
      const board = document.querySelector('[data-testid="board"]')!.getBoundingClientRect();
      const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(document.querySelector<HTMLElement>('[data-testid="agent-cursor"]')!.style.transform)!;
      const size = document.querySelector('.agent-cursor__drop')!.getBoundingClientRect().width;
      return [Number(m[1]) + board.left - card.right, Number(m[2]) + board.top - card.bottom, board.right - size - card.right];
    });
    // Right of it as far as the board lets the cursor be: it is kept inside the board's right edge by its own size.
    expect(Math.abs(rest[0]! - Math.min(REST_PX, rest[2]!)), `${rest[0]} px right of the corner`).toBeLessThan(1);
    expect(Math.abs(rest[1]! - REST_PX), `${rest[1]} px below the corner`).toBeLessThan(2);
    expect(errors).toEqual([]);
  });
});

/** One frame of a post of two pictures, as the page drew it. */
interface TwoFrame {
  /** The agent's pictures drawn on now. */
  playing: number;
  /** The agent's pictures on the board, and those held out of sight. */
  pictures: number;
  held: number;
  /** The agent's pictures the minimap draws. */
  mapped: number;
  cursors: number;
  droplets: number;
}

test.describe('one post that brings two pictures', () => {
  let two: RunningBoard | undefined;
  test.beforeAll(async () => {
    test.skip(!appIsBuilt(), 'the app is not built for this run');
    two = await startBoard({ link: `script:${TWO}` });
  });
  test.afterAll(async () => {
    test.setTimeout(60_000);
    await two?.stop();
  });

  test('both are drawn at once, each by its own cursor; the minimap never draws what the board holds out of sight; the cursors merge', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(two!.url);
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByTestId('presence')).toHaveAttribute('data-state', 'listening');
    await page.evaluate(() => document.fonts.ready);
    // Every frame, before it is painted: what is drawn on, held, and on the map.
    await page.evaluate(() => {
      const w = window as unknown as { __frames: TwoFrame[] };
      w.__frames = [];
      const frame = () => {
        const items = [...document.querySelectorAll<HTMLElement>('.layer [data-item][data-kind="picture"]')];
        w.__frames.push({
          playing: items.filter((i) => i.querySelector('[data-build]')?.hasAttribute('data-arrival')).length,
          pictures: items.length,
          held: items.filter((i) => i.hasAttribute('data-arrival-waits')).length,
          mapped: document.querySelectorAll('[data-testid="minimap"] .mm-item--agent').length,
          cursors: document.querySelectorAll('[data-testid="agent-cursor"]').length,
          droplets: document.querySelectorAll('[data-testid="agent-droplet"]').length,
        });
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });

    await page.getByRole('button', { name: 'Write a note' }).click();
    await page.mouse.click(260, 300);
    await page.keyboard.type('remind people of a bill before it is due');
    await page.keyboard.press('Enter');

    const frames = () => page.evaluate(() => (window as unknown as { __frames: TwoFrame[] }).__frames);
    await expect.poll(async () => (await frames()).some((f) => f.pictures === 2), { timeout: 15_000 }).toBe(true);
    await expect(page.getByTestId('presence')).toHaveAttribute('data-state', 'listening', { timeout: 20_000 });
    await expect.poll(async () => page.locator('[data-arrival], [data-arrival-waits], .arrival-band').count(), { timeout: 10_000 }).toBe(0);
    await expect.poll(async () => page.locator('[data-testid="agent-droplet"]').count(), { timeout: 5_000 }).toBe(0);
    const seen = (await frames()).filter((f) => f.pictures > 0);
    // Drawn at once: frames with both drawn on, and a cursor for each.
    const both = seen.filter((f) => f.playing === 2);
    expect(both.length, 'frames both are drawn on').toBeGreaterThan(10);
    expect(both.every((f) => f.cursors === 1 && f.droplets === 1), 'two cursors while both are drawn on').toBe(true);
    // The map draws exactly what the board shows: never a picture held out of sight.
    expect(seen.some((f) => f.held > 0), 'a picture was held a moment').toBe(true);
    for (const [i, f] of seen.entries()) expect(f.mapped, `frame ${i}`).toBe(f.pictures - f.held);
    // And the cursors merge into one.
    const end = (await frames()).at(-1)!;
    expect([end.cursors, end.droplets]).toEqual([1, 0]);
    expect(errors).toEqual([]);
  });
});

/** One frame of a placeholder finished as a wide picture, as the page drew it. */
interface WideFrame {
  is: 'placeholder' | 'finished';
  /** Where the board says it is, `data-box`. */
  box: string;
  /** While the band is seen: how far its top left corner is from the picture's, on the page. */
  band: { dx: number; dy: number } | null;
  /** True when the picture itself is seen: its root, through every element it is in. */
  shown: boolean;
  /** The figure's pose. */
  pose: string | null;
  /** The board's transform: it changes while the camera moves. */
  camera: string;
}

test.describe('a placeholder finished as a wide picture', () => {
  let wide: RunningBoard | undefined;
  test.beforeAll(async () => {
    test.skip(!appIsBuilt(), 'the app is not built for this run');
    wide = await startBoard({ link: `script:${WIDE}` });
  });
  test.afterAll(async () => {
    test.setTimeout(60_000);
    await wide?.stop();
  });

  test('grows from the corner its placeholder stood at, and is placed there; while the camera brings it into view its frame stands and the figure is at work', async ({ page }) => {
    test.setTimeout(60_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(wide!.url);
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByTestId('presence')).toHaveAttribute('data-state', 'listening');
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => {
      const w = window as unknown as { __wide: WideFrame[] };
      w.__wide = [];
      const look = () => {
        const item = document.querySelector<HTMLElement>('.layer [data-item^="wide-"]');
        if (!item) return;
        const band = item.querySelector<HTMLElement>('.arrival-band');
        /** How much of an element gets through to the page, up to the picture's own element. */
        const through = (el: Element | null): number => {
          let o = 1;
          for (let e = el; e; e = e === item ? null : e.parentElement) o *= parseFloat(getComputedStyle(e).opacity);
          return el ? o : 0;
        };
        const seen = through(band) > 0.02;
        const [b, i] = [band?.getBoundingClientRect(), item.getBoundingClientRect()];
        w.__wide.push({
          is: item.querySelector('[data-status="drawing"]') ? 'placeholder' : 'finished',
          box: item.dataset.box!,
          band: seen && b ? { dx: b.left - i.left, dy: b.top - i.top } : null,
          shown: through(item.querySelector('[data-build]')) > 0.02,
          pose: document.querySelector('[data-testid="agent-cursor"]')?.getAttribute('data-pose') ?? null,
          camera: document.querySelector<HTMLElement>('.world')!.style.transform,
        });
      };
      new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true });
      const frame = () => {
        look();
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });

    // Far enough right that the card fits on the screen and the finished picture does not: the
    // camera must bring it into view before it is drawn.
    await page.getByRole('button', { name: 'Write a note' }).click();
    await page.mouse.click(700, 300);
    await page.keyboard.type('remind people of a bill before it is due');
    await page.keyboard.press('Enter');

    await expect(page.locator('.layer [data-item^="wide-"] [data-status="drawing"]')).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator('.layer [data-item^="wide-"] [data-status="drawing"]')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId('presence')).toHaveAttribute('data-state', 'listening', { timeout: 20_000 });
    await expect.poll(async () => page.locator('[data-arrival], [data-arrival-waits], .arrival-band').count(), { timeout: 10_000 }).toBe(0);

    const frames = await page.evaluate(() => (window as unknown as { __wide: WideFrame[] }).__wide);
    const corner = (box: string) => box.split(',').slice(0, 2).map(Number);
    const placeholder = frames.filter((f) => f.is === 'placeholder').at(-1)!;
    const done = frames.at(-1)!;
    expect(done.is).toBe('finished');
    expect(done.box, 'the finished picture has a size of its own').not.toBe(placeholder.box);
    expect(corner(done.box), 'placed at the corner its placeholder stood at').toEqual(corner(placeholder.box));
    // Finished, its band is dragged out from that corner on every frame it is seen: it never travels.
    const dragged = frames.filter((f) => f.is === 'finished' && f.band);
    expect(dragged.length, 'frames the band is seen').toBeGreaterThan(10);
    for (const [i, f] of dragged.entries()) {
      expect(Math.abs(f.band!.dx), `frame ${i}`).toBeLessThan(1);
      expect(Math.abs(f.band!.dy), `frame ${i}`).toBeLessThan(1);
    }
    // The camera moved first, with nothing drawn on. For all of that the place was not empty: the
    // card's frame stood there. And the figure was at work, though the agent's turn was over.
    const finished = frames.filter((f) => f.is === 'finished');
    const before = finished.slice(0, finished.findIndex((f) => f.shown));
    expect(new Set(before.map((f) => f.camera)).size, 'frames the camera moved in, before the picture showed').toBeGreaterThan(10);
    for (const [i, f] of before.entries()) {
      expect(f.band, `frame ${i}: the frame stands`).not.toBeNull();
      expect(f.pose, `frame ${i}: the figure`).toBe('led');
    }
    const animated = await page.evaluate(() => document.getAnimations().filter((a) => {
      const t = (a.effect as KeyframeEffect | null)?.target;
      return t instanceof Element && !!t.closest('.layer [data-item^="wide-"]');
    }).length);
    expect(animated).toBe(0);
    expect(errors).toEqual([]);
  });
});
