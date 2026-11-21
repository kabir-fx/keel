import { expect, test, type Page } from '@playwright/test';
import { EASE } from '../app/src/motion/ease';
import { APPROACH_MAX_MS, CURSOR_NEAR_PX, CURSOR_NUDGE_MS, HAND_STAGGER_MS, lineMs, pullMs, REST_PX, travelMs } from '../app/src/motion/timing';
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
  /** The band the card is dragged out as, while it is seen: its rectangle on the page. */
  band: { left: number; top: number; right: number; bottom: number } | null;
  /** What the film sets on the card's root that would move or size it: never anything. */
  rootMoved: string | null;
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
    const root = item?.querySelector<HTMLElement>('[data-build]');
    const r = root?.getBoundingClientRect();
    const board = document.querySelector('[data-testid="board"]')!.getBoundingClientRect();
    const bandEl = item?.querySelector<HTMLElement>('.arrival-band');
    const b = bandEl && parseFloat(getComputedStyle(bandEl).opacity) > 0.02 ? bandEl.getBoundingClientRect() : null;
    const rs = root && getComputedStyle(root);
    const moved = rs && [rs.transform, rs.scale, rs.translate].filter((v) => v !== 'none' && v !== '').join(' ');
    return {
      ms,
      placed: !!item,
      drawn,
      head,
      shows,
      cursor: m ? ([Number(m[1]) + board.left, Number(m[2]) + board.top] as [number, number]) : null,
      card: r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null,
      band: b ? { left: b.left, top: b.top, right: b.right, bottom: b.bottom } : null,
      rootMoved: moved || null,
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

  // The card itself is never scaled or moved: a band is dragged out to its rectangle, and the
  // cursor's tip rides the band's far corner (here, the arrow coming from the left, its bottom
  // right): never further from it than it rests, just outside it. Once whole, the band is the card.
  for (const f of film) expect(f.rootMoved, `the card's root at ${Math.round(f.ms)} ms`).toBeNull();
  const dragged = film.filter((f) => f.band && f.cursor);
  expect(dragged.length, 'frames of the drag').toBeGreaterThan(8);
  expect(dragged.some((f) => f.band!.right - f.band!.left < (f.card!.right - f.card!.left) / 2), 'the band seen small').toBe(true);
  for (const f of dragged) {
    expect(dist(f.cursor!, [f.band!.right, f.band!.bottom]), `the band's corner at ${Math.round(f.ms)} ms`).toBeLessThanOrEqual(REST_PX * arrow.zoom * Math.SQRT2 * 1.02 + 1.5);
    // A band of no size is still drawn as its two borders.
    expect(f.cursor![0], `outside the corner at ${Math.round(f.ms)} ms`).toBeGreaterThanOrEqual(f.band!.right - 1 - 3 * arrow.zoom);
  }
  const whole = dragged[dragged.length - 1]!;
  for (const k of ['left', 'top', 'right', 'bottom'] as const) expect(Math.abs(whole.band![k] - whole.card![k]), `the band's ${k} at its end`).toBeLessThan(1.5);
  // Nothing of the card shows before the band is whole.
  const firstWords = film.findIndex((f) => f.shows.slice(1).some(Boolean));
  expect(film.slice(0, firstWords).some((f) => f.band)).toBe(true);
  expect(film[firstWords - 1]!.band, 'the band is out when the words start').not.toBeNull();
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
  [7, 'two pictures in one post'],
  [8, 'a model, a pipeline, a walk and a redraw in one post'],
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
        // Without motion a picture the camera brings into view blinks, on the page's own timer.
        await page.waitForFunction(() => !document.querySelector('.item--flash'));
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
      const band = item?.querySelector<HTMLElement>('.arrival-band');
      const shown = band && parseFloat(getComputedStyle(band).opacity) > 0.02;
      return {
        finished: !!item && !item.querySelector('[data-status="drawing"]'),
        waits: !!item?.hasAttribute('data-arrival-waits'),
        playing: !!root?.hasAttribute('data-arrival'),
        width: root?.getBoundingClientRect().width ?? 0,
        band: shown ? band!.getBoundingClientRect().width : 0,
      };
    });
  const seen: Array<{ finished: boolean; waits: boolean; playing: boolean; width: number; band: number }> = [];
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
  // From the first frame it is finished it is held out of sight while the camera brings it into
  // view, then dragged out: never whole at rest before.
  const begins = seen.findIndex((s, i) => i >= first && s.playing);
  expect(begins).toBeGreaterThanOrEqual(first);
  expect(seen.slice(first, begins).every((s) => s.waits), 'held out of sight until it is drawn on').toBe(true);
  expect(seen.slice(first).some((s) => s.playing && s.band > 0 && s.band < rest.picture.width - 1), 'a frame of the drag, the band narrower than the picture').toBe(true);
  expect(seen.slice(first).every((s) => !s.playing || Math.abs(s.width - rest.picture.width) < 1), 'the picture never drawn at another size').toBe(true);
  // Over: at rest, and wholly in the free room.
  expect([rest.playing, rest.animated]).toEqual([false, 0]);
  expect(rest.picture.left).toBeGreaterThanOrEqual(rest.room.left - 1);
  expect(rest.picture.right).toBeLessThanOrEqual(rest.room.right + 1);
  expect(rest.picture.top).toBeGreaterThanOrEqual(rest.room.top - 1);
  expect(rest.picture.bottom).toBeLessThanOrEqual(rest.room.bottom + 1);
});

/** What one frame shows of a post's pictures, the cursors and the camera. */
interface PostFrame {
  ms: number;
  /** For each picture: whether it is on the board, waits out of sight, is drawn on, and its band's rectangle while the band is seen. */
  pictures: Record<string, { on: boolean; waits: boolean; plays: boolean; band: [number, number, number, number] | null; card: [number, number, number, number] | null }>;
  /** Where each cursor's tip is drawn, in page pixels: the agent's own first, then each droplet. */
  tips: Array<[number, number]>;
  droplets: number;
  /** The camera, as the world's transform. */
  camera: string;
  /** Anything of a film left on the page: attributes, bands, animations on the board's pictures and arrows. */
  left: number;
}

function postFrame(page: Page, ms: number, ids: readonly string[]): Promise<PostFrame> {
  return page.evaluate(
    ({ ms, ids }) => {
      const board = document.querySelector('[data-testid="board"]')!.getBoundingClientRect();
      const rect = (r: DOMRect): [number, number, number, number] => [r.left, r.top, r.right, r.bottom];
      const pictures: PostFrame['pictures'] = {};
      for (const id of ids) {
        const item = document.querySelector<HTMLElement>(`.layer [data-item="${id}"]`);
        const root = item?.querySelector<HTMLElement>('[data-build]');
        const band = item?.querySelector<HTMLElement>('.arrival-band');
        pictures[id] = {
          on: !!item,
          waits: !!item?.hasAttribute('data-arrival-waits'),
          plays: !!root?.hasAttribute('data-arrival'),
          band: band && parseFloat(getComputedStyle(band).opacity) > 0.02 ? rect(band.getBoundingClientRect()) : null,
          card: root ? rect(root.getBoundingClientRect()) : null,
        };
      }
      const tip = (el: HTMLElement): [number, number] | null => {
        const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(el.style.transform);
        return m ? [Number(m[1]) + board.left, Number(m[2]) + board.top] : null;
      };
      const cursors = [...document.querySelectorAll<HTMLElement>('[data-testid="agent-cursor"], [data-testid="agent-droplet"]')];
      const layer = document.querySelector('.layer')!;
      const lineage = document.querySelector('svg.lineage');
      const animated = document.getAnimations().filter((a) => {
        const t = (a.effect as KeyframeEffect | null)?.target;
        return t instanceof Element && (layer.contains(t) || !!lineage?.contains(t));
      }).length;
      return {
        ms,
        pictures,
        tips: cursors.map(tip).filter((t): t is [number, number] => !!t),
        droplets: document.querySelectorAll('[data-testid="agent-droplet"]').length,
        camera: document.querySelector<HTMLElement>('.world')!.style.transform,
        left: document.querySelectorAll('[data-arrival], [data-arrival-waits], .arrival-band').length + animated,
      };
    },
    { ms, ids },
  );
}

/** Play checkpoint `at` on the manual clock, a frame at a time from the moment the first of `ids` is on the board, to well after the play ends. */
async function playPost(page: Page, at: number, ids: readonly string[]): Promise<PostFrame[]> {
  await openReplay(page, { fixture: 'arrival', at, manual: true });
  const { length } = await playStatus(page);
  let n = 0;
  for (; n * FRAME < length; n += 6) {
    await renderAt(page, n * FRAME);
    const f = await postFrame(page, n * FRAME, ids);
    if (ids.some((id) => f.pictures[id]!.on)) break;
  }
  // From the frame before, to see the camera as it was.
  const film: PostFrame[] = [];
  for (let k = n; k * FRAME < length + 4000; k++) {
    await renderAt(page, k * FRAME);
    film.push(await postFrame(page, k * FRAME, ids));
  }
  return film;
}

const near = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!);

test('one post, two pictures (checkpoint 7): two cursors draw them on the same frames, then merge into one where the last finished, and nothing is left', async ({ page }) => {
  test.setTimeout(240_000);
  const ids = ['by-text', 'text-cost'];
  const film = await playPost(page, 7, ids);
  // The frames both pictures are drawn on: a cursor for each.
  const together = film.filter((f) => ids.every((id) => f.pictures[id]!.plays));
  expect(together.length, 'frames both are drawn on').toBeGreaterThan(20);
  expect(together.every((f) => f.droplets === 1 && f.tips.length === 2), 'two cursors while both are drawn on').toBe(true);
  // On every frame a band is dragged, a cursor's tip is on its far corner, never further out than
  // the cursor rests: `REST_PX` on the screen on each axis, the camera being still.
  for (const id of ids) {
    const dragged = film.filter((f) => f.pictures[id]!.band);
    expect(dragged.length, `frames ${id}'s band is dragged`).toBeGreaterThan(8);
    for (const f of dragged) {
      const [l, t, r, b] = f.pictures[id]!.band!;
      const corners = [[r, b], [l, b], [r, t]];
      const gap = Math.min(...f.tips.flatMap((tip) => corners.map((c) => near(tip, c))));
      expect(gap, `${id}'s band at ${Math.round(f.ms)} ms`).toBeLessThanOrEqual(REST_PX * Math.SQRT2 * 1.02 + 1.5);
    }
  }
  // The second begins a beat after the first: the stagger, to the frame.
  const begins = ids.map((id) => film.findIndex((f) => f.pictures[id]!.plays));
  expect(Math.abs(begins[1]! - begins[0]!) * FRAME, 'from the first under way to the second').toBeLessThan(HAND_STAGGER_MS + 2 * FRAME);
  // Then one cursor, where the film that ended last rests: just outside its far corner.
  const ends = ids.map((id) => film.findLastIndex((f) => f.pictures[id]!.plays));
  const last = ids[ends.indexOf(Math.max(...ends))]!;
  const end = film[film.length - 1]!;
  expect(end.droplets).toBe(0);
  expect(end.tips).toHaveLength(1);
  const card = end.pictures[last]!.card!;
  const rest = end.tips[0]!;
  const off = Math.min(...[[card[2], card[3]], [card[0], card[3]], [card[2], card[1]]].map((c) => near(rest, c)));
  expect(off, `the cursor rests by ${last}'s corner`).toBeLessThanOrEqual(REST_PX * Math.SQRT2 + 2);
  expect(end.left, 'nothing of either film is left').toBe(0);
});

test('one post with a model (checkpoint 8): the camera has stopped before anything is drawn on, and every picture of the post is under way soon after', async ({ page }) => {
  test.setTimeout(240_000);
  const ids = ['pipe', 'walk', 'text-cost'];
  const film = await playPost(page, 8, ids);
  const moves = film.map((f, i) => i > 0 && f.camera !== film[i - 1]!.camera);
  expect(moves.some(Boolean), 'the camera moves to show the post').toBe(true);
  const drawn = (f: PostFrame) => ids.filter((id) => f.pictures[id]!.plays);
  for (const [i, moved] of moves.entries()) {
    if (moved) expect([...drawn(film[i - 1]!), ...drawn(film[i]!)], `the camera moves at ${Math.round(film[i]!.ms)} ms`).toEqual([]);
  }
  const stopped = moves.lastIndexOf(true);
  // Every picture of the post is under way within half a second of the camera stopping.
  for (const id of ids) {
    const begins = film.findIndex((f) => f.pictures[id]!.plays);
    expect(begins, `${id} is drawn on`).toBeGreaterThan(stopped);
    expect(begins - stopped, `${id} under way after the camera stops`).toBeLessThan(30);
  }
  const end = film[film.length - 1]!;
  expect([end.droplets, end.tips.length, end.left]).toEqual([0, 1, 0]);
});
