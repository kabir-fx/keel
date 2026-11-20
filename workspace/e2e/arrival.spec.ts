import { expect, test, type Page } from '@playwright/test';
import { EASE } from '../app/src/motion/ease';
import { APPROACH_MAX_MS, CURSOR_NEAR_PX, CURSOR_NUDGE_MS, lineMs, pullMs, REST_PX, travelMs } from '../app/src/motion/timing';
import { openReplay, playStatus, renderAt, replayUrl } from './replay';

/**
 * The agent's picture arriving, on the arrival fixture's first scene, played on the manual clock:
 * the owner's note, then the agent's card, drawn on from the note by the agent's cursor. Each
 * frame is asked for in turn, so what the page shows can be checked frame by frame.
 */

/** Drawn in software, so a frame is the same every time (see `replay.spec.ts`). */
test.use({ launchOptions: { args: ['--disable-gpu'] } });

/** The length of one frame of the manual clock. */
const FRAME = 1000 / 60;

/** The first frame at or after `ms`. */
const frameFrom = (ms: number) => Math.ceil((ms * 60) / 1000 - 1e-9);

/** What one frame shows of the card, its arrow and the cursor. */
interface Seen {
  ms: number;
  /** The card is on the board. */
  placed: boolean;
  /** How much of the arrow is drawn, from 0 to 1, and whether its head shows. */
  drawn: number;
  head: boolean;
  /** Each part of the card, in the order the page has them: whether it shows at all. */
  shows: boolean[];
  /** Where the cursor is drawn, in page pixels. */
  cursor: [number, number] | null;
  /** The card's rectangle on the page. */
  card: { left: number; top: number; right: number; bottom: number } | null;
}

/** Read the frame the page shows now. */
function look(page: Page, ms: number): Promise<Seen> {
  return page.evaluate((ms) => {
    const item = document.querySelector<HTMLElement>('.layer [data-item="read"]');
    const path = document.querySelector<SVGPathElement>('[data-lineage$=">read"]');
    let drawn = 0;
    let head = false;
    if (path) {
      const s = getComputedStyle(path);
      const length = path.getTotalLength();
      const dash = s.strokeDasharray === 'none' ? [] : s.strokeDasharray.split(/[ ,]+/).map(parseFloat);
      const offset = parseFloat(s.strokeDashoffset) || 0;
      // With no dash the line is whole; with one, what is drawn is the dash from the start up to the offset.
      drawn = dash.length === 0 ? 1 : Math.max(0, Math.min(1, (length - offset) / length));
      head = s.markerEnd !== 'none' && s.visibility !== 'hidden';
    }
    const parts = item ? [...item.querySelectorAll<HTMLElement>('[data-build]')] : [];
    // A part shows when it, and every part it sits on, is not wholly faded out.
    const shows = parts.map((el) => {
      for (let e: HTMLElement | null = el; e && e !== item; e = e.parentElement) if (parseFloat(getComputedStyle(e).opacity) < 0.02) return false;
      return true;
    });
    const c = document.querySelector<HTMLElement>('[data-testid="agent-cursor"]');
    const m = c && /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(c.style.transform);
    const r = item?.querySelector('[data-build]')?.getBoundingClientRect();
    const board = document.querySelector('[data-testid="board"]')!.getBoundingClientRect();
    return {
      ms,
      placed: !!item,
      drawn,
      head,
      shows,
      cursor: m ? ([Number(m[1]) + board.left, Number(m[2]) + board.top] as [number, number]) : null,
      card: r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null,
    };
  }, ms);
}

/** The steepest an easing goes: its largest share of the way per share of the time. */
function steepest(e: (t: number) => number): number {
  let most = 0;
  for (let i = 0; i < 1000; i++) most = Math.max(most, Math.abs(e((i + 1) / 1000) - e(i / 1000)) * 1000);
  return most;
}

/** The arrow into the card on the page: its length on the screen, and its two ends, in page pixels. */
function arrowOf(page: Page) {
  return page.evaluate(() => {
    const path = document.querySelector<SVGPathElement>('[data-lineage$=">read"]')!;
    const ctm = path.getScreenCTM()!;
    const onPage = (p: DOMPoint): [number, number] => [ctm.a * p.x + ctm.c * p.y + ctm.e, ctm.b * p.x + ctm.d * p.y + ctm.f];
    const length = path.getTotalLength();
    return { px: length * ctm.a, start: onPage(path.getPointAtLength(0)), end: onPage(path.getPointAtLength(length)), zoom: ctm.a };
  });
}

/** The frame at which the card's event reaches the board. */
async function landing(page: Page): Promise<number> {
  for (let n = frameFrom(7000); n < frameFrom(9000); n++) {
    await renderAt(page, n * FRAME);
    if ((await look(page, n * FRAME)).placed) return n;
  }
  throw new Error('The card never arrived.');
}

/** Everything about the card and its arrow that the page draws from, with each part's computed look. */
function restingLook(page: Page) {
  return page.evaluate(() => {
    const PROPS = ['opacity', 'transform', 'scale', 'translate', 'transform-origin', 'transform-box', 'visibility', 'stroke-dasharray', 'stroke-dashoffset', 'marker-end'];
    const item = document.querySelector<HTMLElement>('.layer [data-item="read"]')!;
    const path = document.querySelector<SVGPathElement>('[data-lineage$=">read"]')!;
    const styles = [item, ...item.querySelectorAll('*'), path].map((el) => {
      const s = getComputedStyle(el);
      return PROPS.map((p) => `${p}: ${s.getPropertyValue(p)}`).join('; ');
    });
    const animated = document.getAnimations().filter((a) => {
      const target = (a.effect as KeyframeEffect | null)?.target;
      return target instanceof Element && (item.contains(target) || target === path);
    }).length;
    return { item: item.outerHTML, path: path.outerHTML, styles, animated };
  });
}

test('the first scene: the card is drawn on from the note, in order, under the cursor, and nothing of it shows before', async ({ page }) => {
  test.setTimeout(180_000);
  await openReplay(page, { fixture: 'arrival', at: 1, manual: true });
  const land = await landing(page);

  // The frame its event lands in: before the page is painted, every part is in its first pose.
  const first = await look(page, land * FRAME);
  expect(first.shows.every((s) => !s), 'no part of the card shows as its event lands').toBe(true);
  expect(first.drawn).toBe(0);
  // And the page shows nothing where the card rests that was not there a frame before. The
  // cursor is left out: led now, its tag is shorter than it was.
  const clip = await page.evaluate(() => {
    const r = document.querySelector('.layer [data-item="read"]')!.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
  const NO_CURSOR = '[data-testid="agent-cursor"] { visibility: hidden !important; }';
  const hidden = await page.addStyleTag({ content: NO_CURSOR });
  const shot = await page.screenshot({ clip, animations: 'allow' });
  const fresh = await page.context().newPage();
  try {
    await openReplay(fresh, { fixture: 'arrival', at: 1, manual: true });
    await renderAt(fresh, (land - 1) * FRAME);
    await fresh.addStyleTag({ content: NO_CURSOR });
    expect(shot.equals(await fresh.screenshot({ clip, animations: 'allow' })), 'the card\'s place looks as it did the frame before').toBe(true);
  } finally {
    await fresh.close();
  }
  await hidden.evaluate((el) => (el as Element).remove());

  const film: Seen[] = [first];
  for (let n = land + 1; n < land + 120; n++) {
    await renderAt(page, n * FRAME);
    film.push(await look(page, n * FRAME));
  }

  // The arrow's drawn length never goes back, and its head shows only once the line is whole.
  for (let i = 1; i < film.length; i++) expect(film[i]!.drawn, `the arrow at ${Math.round(film[i]!.ms)} ms`).toBeGreaterThanOrEqual(film[i - 1]!.drawn - 1e-6);
  for (const f of film) if (f.head) expect(f.drawn, `the head at ${Math.round(f.ms)} ms`).toBe(1);
  expect(film.some((f) => f.drawn > 0 && f.drawn < 1), 'the arrow is seen drawn part of the way').toBe(true);
  expect(film[film.length - 1]!.head).toBe(true);

  // The parts come in in the order the card is drawn on: each first shows no earlier than the one before it.
  const n = first.shows.length;
  const firstShown = Array.from({ length: n }, (_, i) => film.findIndex((f) => f.shows[i]));
  expect(firstShown.every((k) => k >= 0), 'every part comes in').toBe(true);
  for (let i = 1; i < n; i++) expect(firstShown[i], `part ${i}`).toBeGreaterThanOrEqual(firstShown[i - 1]!);
  // Never all at once: the last part comes in well after the card.
  expect(firstShown[n - 1]! - firstShown[0]!).toBeGreaterThan(10);

  // The cursor moves each frame no further than its legs' easings allow: a leg's length, by its
  // easing's steepest slope, by a frame's share of the leg's time. The pull is fast in its middle.
  const arrow = await arrowOf(page);
  const at = film.map((f) => f.cursor).filter((c): c is [number, number] => !!c);
  const rest = at[at.length - 1]!;
  const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!);
  const approach = dist(first.cursor!, arrow.start);
  const legs = [
    // The approach is a gentle curve: a little longer than the straight way.
    { px: approach * 1.1, ms: approach < CURSOR_NEAR_PX ? CURSOR_NUDGE_MS : Math.min(APPROACH_MAX_MS, travelMs(approach)), ease: EASE.move },
    { px: arrow.px, ms: lineMs(arrow.px), ease: EASE.draw },
    { px: dist(arrow.end, rest), ms: pullMs(dist(arrow.end, rest)), ease: EASE.pull },
  ];
  const bound = Math.max(...legs.map((l) => (l.px * steepest(l.ease) * FRAME) / l.ms)) * 1.05 + 0.5;
  for (let i = 1; i < at.length; i++) expect(dist(at[i]!, at[i - 1]!), `frame ${i}`).toBeLessThanOrEqual(bound);

  // Once the arrow is whole, the cursor's tip rides the card's far corner (here, the arrow coming
  // from the left, its bottom right) as it is pulled
  // out: never further from it than it rests, just outside it.
  for (const f of film.filter((f) => f.head && f.card && f.cursor)) {
    expect(dist(f.cursor!, [f.card!.right, f.card!.bottom]), `the corner at ${Math.round(f.ms)} ms`).toBeLessThanOrEqual(REST_PX * arrow.zoom * Math.SQRT2 * 1.02 + 1.5);
    expect(f.cursor![0], `outside the corner at ${Math.round(f.ms)} ms`).toBeGreaterThanOrEqual(f.card!.right - 1);
  }
  const last = film[film.length - 1]!;
  expect(last.cursor![0]).toBeGreaterThan(last.card!.right);
  expect(last.cursor![1]).toBeGreaterThan(last.card!.bottom);
  expect(dist(at[at.length - 1]!, at[at.length - 2]!)).toBe(0);
});

/** The whole board as drawn: the items, the chips and the arrows, with each element's computed look, and the animations on them. */
function boardLook(page: Page) {
  return page.evaluate(() => {
    const PROPS = ['opacity', 'transform', 'scale', 'translate', 'transform-origin', 'transform-box', 'visibility', 'clip-path', 'stroke-dasharray', 'stroke-dashoffset', 'marker-end'];
    const parts = [document.querySelector('.layer')!, document.querySelector('svg.lineage')!];
    const all = parts.flatMap((p) => [p, ...p.querySelectorAll('*')]);
    const styles = all.map((el) => {
      const s = getComputedStyle(el);
      return PROPS.map((p) => `${p}: ${s.getPropertyValue(p)}`).join('; ');
    });
    const animated = document.getAnimations().filter((a) => {
      const target = (a.effect as KeyframeEffect | null)?.target;
      return target instanceof Element && parts.some((p) => p.contains(target));
    }).length;
    return { html: parts.map((p) => p.outerHTML), styles, animated };
  });
}

/** What each checkpoint plays: the card, a chip, a placeholder arriving then finished, a redraw. */
for (const [at, what] of [
  [1, 'a card'],
  [3, 'a chip of words'],
  [5, 'a placeholder, then finished'],
  [6, 'a redraw'],
] as const) {
  test(`once ${what} is over (checkpoint ${at}) the board is exactly as a board with reduced motion: the same DOM, the same computed styles, no animation`, async ({ browser }) => {
    test.setTimeout(120_000);
    const end = async (motion: boolean) => {
      // Tall enough that what plays is in view.
      const page = await browser.newPage({ viewport: { width: 1440, height: 2000 } });
      try {
        if (motion) await openReplay(page, { fixture: 'arrival', at, manual: true });
        else {
          await page.emulateMedia({ reducedMotion: 'reduce' });
          await page.goto(replayUrl({ fixture: 'arrival', at, manual: true }));
          await page.waitForFunction(() => (window as unknown as { __keel?: { ready(): boolean } }).__keel?.ready() === true);
        }
        // Whether anything was drawn on while it played.
        await page.evaluate(() => {
          const w = window as unknown as { __drawnOn: boolean };
          w.__drawnOn = false;
          new MutationObserver((records) => {
            if (records.some((r) => r.target instanceof Element && r.target.hasAttribute('data-arrival'))) w.__drawnOn = true;
          }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-arrival'] });
        });
        const { length } = await playStatus(page);
        await renderAt(page, length + 3000);
        return { look: await boardLook(page), drawnOn: await page.evaluate(() => (window as unknown as { __drawnOn: boolean }).__drawnOn) };
      } finally {
        await page.close();
      }
    };
    const played = await end(true);
    const still = await end(false);
    expect(played.drawnOn, 'it was drawn on').toBe(true);
    expect(still.drawnOn, 'with reduced motion nothing was').toBe(false);
    expect(played.look.animated).toBe(0);
    expect(played.look).toEqual(still.look);
  });
}

test('with reduced motion nothing plays: no animation on the card or its arrow, no attribute, the card whole as it lands', async ({ page }) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(replayUrl({ fixture: 'arrival', at: 1, manual: true }));
  await page.waitForFunction(() => (window as unknown as { __keel?: { ready(): boolean } }).__keel?.ready() === true);
  const land = await landing(page);
  for (let n = land; n < land + 40; n += 4) {
    await renderAt(page, n * FRAME);
    const seen = await look(page, n * FRAME);
    expect(seen.shows.every((s) => s)).toBe(true);
    expect(seen.drawn).toBe(1);
    const { animated } = await restingLook(page);
    expect(animated).toBe(0);
    expect(await page.locator('[data-arrival], [data-arrival-waits]').count()).toBe(0);
  }
});

test('a press on the card while it is drawn on lands it at once, and the press selects it', async ({ page }) => {
  test.setTimeout(120_000);
  await openReplay(page, { fixture: 'arrival', at: 1, manual: true });
  const land = await landing(page);
  await renderAt(page, (land + 40) * FRAME);
  const mid = await look(page, (land + 40) * FRAME);
  expect(mid.shows.some((s) => !s), 'still being drawn on').toBe(true);
  const c = mid.card!;
  await page.mouse.move(c.left + 40, c.top + 12);
  await page.mouse.down();
  await page.mouse.up();
  const after = await look(page, (land + 40) * FRAME);
  expect(after.shows.every((s) => s)).toBe(true);
  expect(after.drawn).toBe(1);
  expect(after.head).toBe(true);
  expect(await page.locator('[data-arrival]').count()).toBe(0);
  expect((await restingLook(page)).animated).toBe(0);
  await expect(page.locator('.layer [data-item="read"]')).toHaveClass(/item--selected/);
});

/**
 * Every state the page is left in, as it is left: after each change to the page (a mutation
 * observer's turn) and at each real frame. What the placeholder of checkpoint 5 is in each.
 */
function watchPlan(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __plan: Array<{ is: 'none' | 'placeholder' | 'finished'; box?: string; waits: boolean; shows: boolean; moving: boolean }> };
    w.__plan = [];
    const look = () => {
      const el = document.querySelector<HTMLElement>('.layer [data-item="plan"]');
      if (!el) return w.__plan.push({ is: 'none', waits: false, shows: false, moving: false });
      const moving = document.getAnimations().some((a) => {
        const target = (a.effect as KeyframeEffect | null)?.target;
        return target instanceof Element && el.contains(target);
      });
      w.__plan.push({
        is: el.querySelector('[data-status="drawing"]') ? 'placeholder' : 'finished',
        box: el.dataset.box,
        waits: el.hasAttribute('data-arrival-waits'),
        shows: parseFloat(getComputedStyle(el).opacity) > 0.02,
        moving,
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

for (const motion of [true, false]) {
  test(`a placeholder finished ${motion ? 'goes straight from the placeholder to the pull' : 'with reduced motion is never shown whole on the placeholder\'s spot'}, one clock frame at a time`, async ({ browser }) => {
    test.setTimeout(120_000);
    // Tall enough that the placeholder is in view.
    const page = await browser.newPage({ viewport: { width: 1440, height: 2000 } });
    try {
      if (motion) await openReplay(page, { fixture: 'arrival', at: 5, manual: true });
      else {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.goto(replayUrl({ fixture: 'arrival', at: 5, manual: true }));
        await page.waitForFunction(() => (window as unknown as { __keel?: { ready(): boolean } }).__keel?.ready() === true);
      }
      await renderAt(page, 3000);
      await watchPlan(page);
      // The placeholder is finished at about 4250 ms.
      for (let n = frameFrom(3000); n <= frameFrom(5000); n++) await renderAt(page, n * FRAME);
      const seen = await page.evaluate(() => (window as unknown as { __plan: Array<{ is: string; box?: string; waits: boolean; shows: boolean; moving: boolean }> }).__plan);
      const first = seen.findIndex((s) => s.is === 'finished');
      expect(seen[0]!.is, 'the placeholder is on the board before it is finished').toBe('placeholder');
      expect(first, 'it was finished').toBeGreaterThan(0);
      const spot = seen[first - 1]!.box;
      const after = seen.slice(first);
      // Never gone, never held out of sight, never at the placeholder's spot once finished.
      expect(after.filter((s) => s.is !== 'finished' || s.waits || !s.shows)).toEqual([]);
      expect(after.filter((s) => s.box === spot)).toEqual([]);
      // With motion it is being pulled from the first state it is seen finished in; with reduced motion nothing moves.
      if (motion) expect(after[0]!.moving).toBe(true);
      else expect(after.some((s) => s.moving)).toBe(false);
    } finally {
      await page.close();
    }
  });
}

test('the whole log: the placeholder finished larger than the room shows is pulled out, and the camera brings it into the free room', async ({ page }) => {
  test.setTimeout(180_000);
  await openReplay(page, { fixture: 'arrival', manual: true });
  // The placeholder is drawn on at about 27.5 to 28.7 s, and finished at about 29.4 s.
  await renderAt(page, 28_800);
  const look = () =>
    page.evaluate(() => {
      const item = document.querySelector<HTMLElement>('.layer [data-item="plan"]');
      const root = item?.querySelector<HTMLElement>('[data-build]');
      return { finished: !!item && !item.querySelector('[data-status="drawing"]'), playing: !!root?.hasAttribute('data-arrival'), width: root?.getBoundingClientRect().width ?? 0 };
    });
  const seen: Array<{ finished: boolean; playing: boolean; width: number }> = [];
  for (let n = frameFrom(28_800); n <= frameFrom(31_500); n++) {
    await renderAt(page, n * FRAME);
    seen.push(await look());
  }
  await renderAt(page, 34_000);
  const rest = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('.layer [data-item="plan"] [data-build]')!;
    const board = document.querySelector('[data-testid="board"]')!.getBoundingClientRect();
    const edges = (dock: string) => [...document.querySelectorAll<HTMLElement>(`[data-viewport-ui="${dock}"]`)].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    const r = root.getBoundingClientRect();
    return {
      picture: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width },
      // The free room: below what is docked at the top and above what is docked at the bottom, inside the board, with the fit's margin.
      room: {
        left: board.left + 24,
        right: board.right - 24,
        top: Math.max(board.top, ...edges('top').map((e) => e.bottom)) + 24,
        bottom: Math.min(board.bottom, ...edges('bottom').map((e) => e.top)) - 24,
      },
      playing: root.hasAttribute('data-arrival'),
      animated: root.getAnimations().length,
    };
  });
  const first = seen.findIndex((s) => s.finished);
  expect(first, 'it was finished').toBeGreaterThan(0);
  // From the first frame it is finished, it is being pulled out: never whole at rest before.
  expect(seen[first]!.playing).toBe(true);
  expect(seen.slice(first).some((s) => s.playing && s.width < rest.picture.width - 1), 'a frame of the pull, narrower than the picture').toBe(true);
  // Over: at rest, and wholly in the free room.
  expect([rest.playing, rest.animated]).toEqual([false, 0]);
  expect(rest.picture.left).toBeGreaterThanOrEqual(rest.room.left - 1);
  expect(rest.picture.right).toBeLessThanOrEqual(rest.room.right + 1);
  expect(rest.picture.top).toBeGreaterThanOrEqual(rest.room.top - 1);
  expect(rest.picture.bottom).toBeLessThanOrEqual(rest.room.bottom + 1);
});
