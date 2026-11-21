import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { contactSheet, openReplay, playStatus, renderAt } from './replay';

/**
 * A fixture played on the board: the same address and the same moments give the same frames, a
 * play ends on the board its checkpoint opens on, a play on the page's own clock runs by itself,
 * and none of it is there on a board opened any other way. The arrival fixture's first
 * checkpoint: the owner's note at 5.4 s, the wake at 5.7 s, the call begun at 6.2 s and its kind
 * written at 6.4 s, the call whole at 7.7 s and the card landing at 7.8 s.
 */

/**
 * Drawn in software. With the GPU, Chrome now and then draws the edges of the chrome over the
 * board a shade apart between two loads of the same page (seen on 2026-11-20: 70 pixels, off by
 * up to 20 levels, with the same DOM, the same computed styles and no animation): that is the
 * GPU's rasteriser, not the board's clock. In software the same frame is the same, byte for byte.
 */
test.use({ launchOptions: { args: ['--disable-gpu'] } });

/** Contact sheets go here: `workspace/e2e/shots/` is kept out of git. */
const SHEETS = fileURLToPath(new URL('./shots/replay/', import.meta.url));

/** Moments of the first checkpoint: before, the note, the wake, the call being written, the card, the rest. */
const MOMENTS = [600, 5500, 5800, 6450, 7850, 8500];

/** Every item on the board and where it is, by its id. */
async function itemBoxes(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => Object.fromEntries([...document.querySelectorAll<HTMLElement>('.layer [data-item][data-box]')].map((el) => [el.dataset.item!, el.dataset.box!])));
}

test('the same address and the same moments give the same frames', async ({ browser }) => {
  test.setTimeout(120_000);
  const film = async () => {
    const page = await browser.newPage();
    try {
      await openReplay(page, { fixture: 'arrival', at: 1, manual: true });
      const frames: Buffer[] = [];
      for (const ms of MOMENTS) {
        await renderAt(page, ms);
        frames.push(await page.screenshot({ animations: 'allow' }));
      }
      return frames;
    } finally {
      await page.close();
    }
  };
  const first = await film();
  const second = await film();
  // Not a blank film: the board changes between the first moment and the last.
  expect(first[0]!.equals(first[first.length - 1]!)).toBe(false);
  for (const [i, ms] of MOMENTS.entries()) expect(first[i]!.equals(second[i]!), `the frame at ${ms} ms`).toBe(true);
});

for (const at of [undefined, 5]) {
  test(`played to its end, ${at ? `checkpoint ${at}` : 'the whole log'} holds the same items at the same boxes as the checkpoint opened`, async ({ page }) => {
    test.setTimeout(120_000);
    await openReplay(page, { fixture: 'arrival', ...(at ? { at } : {}), manual: true });
    const { length } = await playStatus(page);
    await renderAt(page, length + 500);
    expect((await playStatus(page)).done).toBe(true);
    await expect(page.getByTestId('presence')).toHaveAttribute('data-state', 'listening');
    const played = await itemBoxes(page);

    await page.goto(`/?fixture=arrival&at=${at ?? 8}`);
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.locator('[data-measure]')).toHaveCount(0);
    await expect.poll(() => itemBoxes(page)).toEqual(played);
    expect(Object.keys(played)).toEqual(expect.arrayContaining(['n-idea', 'read', 'path', 'pin-queue', 'ways', 'plan']));
  });
}

test('on the page clock a play runs to its end by itself', async ({ page }) => {
  test.setTimeout(60_000);
  await openReplay(page, { fixture: 'arrival', at: 1 });
  expect(await page.evaluate(() => typeof (window as { renderAt?: unknown }).renderAt)).toBe('undefined');
  const { length } = await playStatus(page);
  await expect.poll(async () => (await playStatus(page)).done, { timeout: length + 10_000 }).toBe(true);
  await expect(page.locator('.layer [data-item="read"]')).toBeVisible();
  await expect(page.getByTestId('presence')).toHaveAttribute('data-state', 'listening');
});

test('renderAt goes forward only', async ({ page }) => {
  await openReplay(page, { fixture: 'arrival', at: 1, manual: true });
  await renderAt(page, 1000);
  const back = await page.evaluate(() => (window as unknown as { renderAt(ms: number): Promise<void> }).renderAt(500).then(() => 'went back', (e: Error) => e.message));
  expect(back).toBe('The board shows 1000 ms already, and renderAt only goes forward. Load the page again to see 500 ms.');
  // The same moment again is no step back, and a later one still works.
  await renderAt(page, 1000);
  await renderAt(page, 1200);
  expect((await playStatus(page)).ms).toBeCloseTo(1200, 3);
});

test('the clock holds the page\'s animations, and lets go of one that was cancelled', async ({ page }) => {
  await openReplay(page, { fixture: 'arrival', at: 1, manual: true });
  await renderAt(page, 100);
  const seen = await page.evaluate(async () => {
    const render = (window as unknown as { renderAt(ms: number): Promise<void> }).renderAt;
    const el = document.querySelector<HTMLElement>('[data-testid="board"]')!;
    const kept = el.animate([{ opacity: 1 }, { opacity: 0.99 }], 10_000);
    const landed = el.animate([{ opacity: 1 }, { opacity: 0.98 }], 10_000);
    // Made between two moves of the clock: taken from the clock's time then, 100 ms.
    await render(200);
    const held = [kept.playState, kept.currentTime, landed.playState, landed.currentTime];
    landed.cancel();
    const listed = document.getAnimations().includes(landed);
    await render(300);
    return { held, listed, kept: [kept.playState, kept.currentTime], landed: [landed.playState, landed.currentTime] };
  });
  expect(seen.held).toEqual(['paused', 100, 'paused', 100]);
  // A cancelled animation is not on the page's list, and the clock does not bring it back.
  expect(seen.listed).toBe(false);
  expect(seen.landed).toEqual(['idle', null]);
  expect(seen.kept).toEqual(['paused', 200]);
});

test('a transition that begins and ends while renderAt waits on real frames is held on the clock', async ({ page }) => {
  await openReplay(page, { fixture: 'arrival', at: 1, manual: true });
  await renderAt(page, 100);
  const seen = await page.evaluate(async () => {
    const render = (window as unknown as { renderAt(ms: number): Promise<void> }).renderAt;
    // Its transition lasts 1 ms: less than one real frame, so it is over before the next one.
    const probe = document.createElement('div');
    probe.style.cssText = 'position: fixed; width: 1px; height: 1px; opacity: 1; transition: opacity 1ms linear';
    document.body.append(probe);
    getComputedStyle(probe).opacity;
    let transition: Animation | undefined;
    // Runs once renderAt has begun waiting on real frames for the page to settle.
    setTimeout(() => {
      probe.style.opacity = '0';
      getComputedStyle(probe).opacity;
      transition = probe.getAnimations()[0];
    }, 0);
    await render(200);
    const shown = { made: transition !== undefined, state: transition?.playState, opacity: getComputedStyle(probe).opacity };
    probe.remove();
    return shown;
  });
  // Paused at its start on the clock, as on a run where the wait was too short for it to end.
  expect(seen).toEqual({ made: true, state: 'paused', opacity: '1' });
});

test('renderAt waits while the page goes on changing after a moment of the play, and resolves once it is quiet', async ({ page }) => {
  await openReplay(page, { fixture: 'arrival', at: 1, manual: true });
  await renderAt(page, 5000);
  const seen = await page.evaluate(async () => {
    const render = (window as unknown as { renderAt(ms: number): Promise<void> }).renderAt;
    const busy = document.createElement('div');
    busy.hidden = true;
    document.body.append(busy);
    const before = document.querySelector('[data-item="n-idea"]') !== null;
    let over = false;
    // Once the owner's note of the play is on the board, the page changes on every real frame
    // for 300 ms: a step of the board that takes several frames to come to rest.
    const watch = new MutationObserver(() => {
      if (!document.querySelector('[data-item="n-idea"]')) return;
      watch.disconnect();
      const until = performance.now() + 300;
      const tick = () => {
        busy.toggleAttribute('data-tick');
        if (performance.now() < until) requestAnimationFrame(tick);
        else over = true;
      };
      requestAnimationFrame(tick);
    });
    watch.observe(document.body, { subtree: true, childList: true });
    await render(5500);
    const shown = { before, after: document.querySelector('[data-item="n-idea"]') !== null, over };
    watch.disconnect();
    busy.remove();
    return shown;
  });
  expect(seen).toEqual({ before: false, after: true, over: true });
});

test('a board opened with no fixture address has none of the hooks', async ({ page }) => {
  // No fixture and no token: the page says how to open the board, and that is all.
  await page.goto('/');
  await expect(page.getByTestId('problem')).toBeVisible();
  expect(await page.evaluate(() => ({ renderAt: typeof (window as { renderAt?: unknown }).renderAt, keel: typeof (window as { __keel?: unknown }).__keel }))).toEqual({ renderAt: 'undefined', keel: 'undefined' });
  // A fixture opened, not played, has none either.
  await page.goto('/?fixture=arrival&at=1');
  await expect(page.getByTestId('board')).toBeVisible();
  expect(await page.evaluate(() => ({ renderAt: typeof (window as { renderAt?: unknown }).renderAt, keel: typeof (window as { __keel?: unknown }).__keel }))).toEqual({ renderAt: 'undefined', keel: 'undefined' });
});

test('a contact sheet of the first checkpoint', async ({ page }) => {
  test.setTimeout(120_000);
  await openReplay(page, { fixture: 'arrival', at: 1, manual: true });
  const out = await contactSheet(page, {
    times: [0, 600, 3000, 5400, 5600, 5700, 5800, 6000, 6200, 6400, 6800, 7200, 7700, 7750, 7800, 7850, 7900, 8100, 8400, 8800],
    out: `${SHEETS}arrival-1.png`,
  });
  console.log(`contact sheet: ${out}`);
});
