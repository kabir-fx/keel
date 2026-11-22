import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Look } from '../app/src/ink/stroke';
import { drawing, inkPath, keep, PEN } from '../app/src/ink/stroke';
import { STROKE_JOIN_POINTS, STROKE_MAX_POINTS } from '../app/src/input/constants';
import type { P, Path } from './hand';
import { hand, random, zoomTo } from './hand';
import { nextFrame, pixelsApart, rastersOnGpu, readCamera, worldToPage } from './pointer';

/**
 * Ink, end to end, on the system Chrome with its real mouse: the line under the pointer is the
 * line that stays, a lone click makes no mark, a loop closes. The last test draws no ink on the
 * board: it lays keel's line and the same strokes with Excalidraw's sine easing side by side, in
 * a picture for the owner to choose from.
 */

const SHOTS = fileURLToPath(new URL('./shots', import.meta.url));
mkdirSync(SHOTS, { recursive: true });

interface Mark {
  id: string;
  kind: string;
  box: [number, number, number, number];
  hint?: string;
  anchor?: unknown;
  strokes?: Array<{ pts: number[]; w?: number }>;
}

/** What one drawing of ink says: where it sits on the board, and its path. */
interface Drawn {
  place: string | null;
  viewBox: string | null;
  d: string | null;
}

async function open(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __admitted: unknown[] };
    w.__admitted = [];
    window.addEventListener('keel:admit', (e) => w.__admitted.push((e as CustomEvent).detail));
  });
  await page.goto('/?fixture=tools&at=1');
  await expect(page.getByTestId('board')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('[data-measure]')).toHaveCount(0);
  await page.waitForTimeout(500);
  await page.keyboard.press('p');
}

/** The marks the app has added. */
const added = (page: Page) =>
  page.evaluate(() => (window as unknown as { __admitted: Array<{ type: string; item?: unknown }> }).__admitted.filter((e) => e.type === 'item.add').map((e) => e.item)) as Promise<Mark[]>;

/** Every drawing of ink under a selector, as the page holds it. */
const ink = (page: Page, selector: string): Promise<Drawn[]> =>
  page.locator(selector).evaluateAll((svgs) => svgs.map((svg) => ({ place: svg.getAttribute('style'), viewBox: svg.getAttribute('viewBox'), d: svg.querySelector('path')?.getAttribute('d') ?? null })));

const LIVE = '[data-testid="live"] svg.ink';

/** A number as the page writes it, in ten-thousandths, so sums of them are exact. The page writes a path's numbers to two decimals and a viewBox's to four. */
function units(s: string): number {
  const m = /^(-?)(\d+)(?:\.(\d{1,4}))?$/.exec(s);
  if (!m) throw new Error(`"${s}" is not a number of at most four decimals`);
  const n = Number(m[2]) * 1e4 + Number((m[3] ?? '').padEnd(4, '0'));
  return (m[1] ? -n : n) + 0;
}

/**
 * Every path of ink under a selector, as the points of its outline on the board: flat x,y pairs
 * in ten-thousandths of a board unit. A point is its SVG's corner on the board plus the path's
 * number counted from the viewBox's corner; an SVG of ink is as wide as its viewBox.
 */
async function boardPaths(page: Page, selector: string): Promise<number[][]> {
  const svgs = await page.locator(selector).evaluateAll((els) =>
    els.map((svg) => {
      const { left, top, width, height } = (svg as SVGSVGElement).style;
      return { place: [left, top, width, height], viewBox: svg.getAttribute('viewBox') ?? '', ds: [...svg.querySelectorAll('path')].map((p) => p.getAttribute('d') ?? '') };
    }),
  );
  return svgs.flatMap(({ place, viewBox, ds }) => {
    const [left, top, width, height] = place.map((v) => units(v.replace(/px$/, '')));
    const [vx, vy, vw, vh] = viewBox.split(' ').map(units);
    if (width !== vw || height !== vh) throw new Error(`an SVG of ink is not as wide as its viewBox: ${place.join(' ')}, ${viewBox}`);
    const corner = [left! - vx!, top! - vy!];
    return ds.map((d) => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map((n, i) => units(n) + corner[i % 2]!));
  });
}

/**
 * Two drawings of ink are the same paths on the board, to the last digit a path is written to.
 * A path's numbers are worked out from points counted from its own SVG's corner and written to
 * hundredths. A number on a half hundredth comes out a hair to either side of it from two
 * corners, and is written a hundredth apart (seen: 502.295 written as 502.30 from one corner
 * and 502.29 from the other). So a number may differ by that hundredth, and by nothing more.
 */
function expectSamePaths(got: readonly number[][], want: readonly number[][]) {
  expect(got.map((p) => p.length)).toEqual(want.map((p) => p.length));
  const apart = got.flatMap((p, k) => p.flatMap((n, i) => (Math.abs(n - want[k]![i]!) > 100 ? [{ path: k, number: i, got: n / 1e4, want: want[k]![i]! / 1e4 }] : [])));
  expect(apart).toEqual([]);
}

/** The points of path `a` that path `b` does not have: what is left of `a` past the run of points the two share from the start and the run they share from the end. */
function unshared(a: readonly number[], b: readonly number[]): number[] {
  const same = (i: number, j: number) => a[i] === b[j] && a[i + 1] === b[j + 1];
  let head = 0;
  while (head < a.length && head < b.length && same(head, head)) head += 2;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && same(a.length - 2 - tail, b.length - 2 - tail)) tail += 2;
  return a.slice(head, a.length - tail);
}

/** Whether screenshots are compared byte for byte here: only where Chrome rasterises on a GPU (`rastersOnGpu`). Where they are not, the test says so. */
async function pixelsCompared(page: Page): Promise<boolean> {
  if (await rastersOnGpu(page)) return true;
  test.info().annotations.push({ type: 'pixels not compared', description: 'Chrome rasterises on the CPU here, where the same ink can come out a few edge pixels apart' });
  return false;
}

/** Press at the first point and move through the rest with Chrome's own mouse. The button stays down. */
async function press(page: Page, pts: readonly P[]) {
  await page.mouse.move(pts[0]![0], pts[0]![1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(x, y);
  await nextFrame(page);
}

/** A stroke of the model hand along a path, a sample every 8 ms of its time. */
function stroke(path: Path, ms: number, seed: number): P[] {
  const at = hand(path, ms, 'trackpad', random(seed));
  return Array.from({ length: Math.floor(ms / 8) + 1 }, (_, i) => at(i * 8));
}

/** Bare ground on the `tools` fixture at each zoom: where a stroke is on nothing, so the mark has no anchor to follow. */
const ZOOMS: Array<[name: string, zoom: number, centre: P]> = [
  ['25%', 0.25, [330, 440]],
  ['100%', 1, [720, 425]],
  ['400%', 4, [720, 430]],
];

for (const [name, zoom, [cx, cy]] of ZOOMS) {
  test(`at ${name}, the stroke under the pointer is the stroke that is saved: the same path, in the same place, the same pixels`, async ({ page }) => {
    await open(page);
    await zoomTo(page, zoom);
    expect((await readCamera(page)).z).toBe(zoom);
    // A wave, drawn as a hand draws it: slow at its ends, wobbling, on half pixels.
    const pts = stroke((u) => [cx - 120 + 240 * u, cy + 24 * Math.sin(u * 7)], 900, 7 + zoom);
    const clip = { x: cx - 160, y: cy - 70, width: 320, height: 140 };

    await press(page, pts);
    const under = await ink(page, LIVE);
    const seenUnder = await page.screenshot({ clip });
    await page.mouse.up();
    await nextFrame(page);
    const lifted = await ink(page, LIVE);
    const seenLifted = await page.screenshot({ clip });

    await expect.poll(async () => (await added(page)).length, { timeout: 5000 }).toBe(1);
    const [mark] = await added(page);
    await expect(page.locator(`[data-item="${mark!.id}"] svg.ink`)).toBeVisible();
    await expect(page.locator(LIVE)).toHaveCount(0);
    await nextFrame(page);
    const kept = await ink(page, `[data-item="${mark!.id}"] svg.ink`);
    const seenKept = await page.screenshot({ clip });

    expect(mark!.anchor).toBeUndefined();
    expect(under).toHaveLength(1);
    expect(under[0]!.d).toBeTruthy();
    expect(under).toEqual(kept);
    expect(lifted).toEqual(kept);
    // What the owner sees: not one pixel changes when the pen lifts, or when the mark is saved.
    expect(seenLifted.equals(seenUnder)).toBe(true);
    expect(seenKept.equals(seenUnder)).toBe(true);
    await page.screenshot({ path: `${SHOTS}/ink-${zoom * 100}.png`, clip });
  });
}

test('a lone click with the Pen draws nothing and makes no mark; a drag of 5 px draws', async ({ page }) => {
  await open(page);
  await page.mouse.move(720, 425);
  await page.mouse.down();
  await nextFrame(page);
  await expect(page.locator(LIVE)).toHaveCount(0);
  await page.mouse.up();
  await expect(page.locator(LIVE)).toHaveCount(0);
  await page.waitForTimeout(1000);
  expect(await added(page)).toEqual([]);

  await press(page, [[720, 425], [725, 425]]);
  await expect(page.locator(LIVE)).toHaveCount(1);
  await page.mouse.up();
  await expect.poll(async () => (await added(page)).length, { timeout: 5000 }).toBe(1);
});

test('a loop whose ends nearly meet is closed when the pen lifts, and saved closed', async ({ page }) => {
  await open(page);
  const [cx, cy] = [720, 425];
  // Round a ring, stopping about 6 px short of where it began.
  const ring = Array.from({ length: 60 }, (_, i): P => [cx + 60 * Math.cos((i / 59) * 2 * Math.PI * 0.984), cy + 50 * Math.sin((i / 59) * 2 * Math.PI * 0.984)]);
  await press(page, ring);
  const under = await ink(page, LIVE);
  await page.mouse.up();
  await nextFrame(page);
  const lifted = await ink(page, LIVE);
  expect(lifted[0]!.d).not.toBe(under[0]!.d);
  await expect.poll(async () => (await added(page)).length, { timeout: 5000 }).toBe(1);
  const [mark] = await added(page);
  const pts = mark!.strokes![0]!.pts;
  expect(pts.slice(-2)).toEqual(pts.slice(0, 2));
  expect(mark!.hint).toBe('circle');
  await expect(page.locator(`[data-item="${mark!.id}"] svg.ink`)).toBeVisible();
  expect(await ink(page, `[data-item="${mark!.id}"] svg.ink`)).toEqual(lifted);
});

/* ------------------------------------------------------------------ a stroke that fills up */

/**
 * Move the pressed mouse through the points with Chrome's own input, sixteen at a time as a
 * 1000 Hz mouse sends them, without waiting for the page to answer each one. Chrome hands the
 * page the moves of one frame as one pointer event; one move awaited at a time costs a frame each.
 */
async function sweep(page: Page, pts: readonly P[]) {
  const cdp = await page.context().newCDPSession(page);
  for (let i = 0; i < pts.length; i += 16) {
    await Promise.all(pts.slice(i, i + 16).map(([x, y]) => cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })));
  }
  await cdp.detach();
  await nextFrame(page);
}

for (const [name, zoom, [cx, cy]] of ZOOMS.filter(([, z]) => z >= 1)) {
  test(`at ${name}, a stroke that fills up carries on in a new one, and what is drawn does not thin`, async ({ page }) => {
    await open(page);
    await zoomTo(page, zoom);
    const pixels = await pixelsCompared(page);
    // Laps to and fro 256 px wide and 8 apart, a sample every 2 px: each one is kept, and the stroke fills up halfway along a lap.
    const lap = (i: number): P => {
      const n = Math.floor(i / 128);
      const x = (i % 128) * 2;
      return [cx - 128 + (n % 2 === 0 ? x : 256 - x), cy - 100 + 8 * n];
    };
    // The first laps, far from where the stroke fills up: 276 by 90 px.
    const early = { x: cx - 138, y: cy - 110, width: 276, height: 90 };
    // The ink already drawn behind where it fills up, along that lap only: 60 by 8 px.
    const [jx, jy] = lap(STROKE_MAX_POINTS - 1);
    const behind = { x: jx, y: jy - 4, width: 60, height: 8 };
    await press(page, [lap(0)]);
    await sweep(page, Array.from({ length: STROKE_MAX_POINTS - 11 }, (_, i) => lap(i + 1)));
    const seenBefore = await page.screenshot({ clip: early });
    const [drawnBefore] = await boardPaths(page, LIVE);
    // Full, to its last point.
    for (let i = STROKE_MAX_POINTS - 10; i < STROKE_MAX_POINTS; i++) await page.mouse.move(...lap(i));
    await nextFrame(page);
    await expect(page.locator(LIVE)).toHaveCount(1);
    const fullBehind = await page.screenshot({ clip: behind });
    for (let i = STROKE_MAX_POINTS; i < STROKE_MAX_POINTS + 40; i++) await page.mouse.move(...lap(i));
    await nextFrame(page);
    await expect(page.locator(LIVE)).toHaveCount(2);
    const seenAfter = await page.screenshot({ clip: early });
    const carriedBehind = await page.screenshot({ clip: behind });
    const [drawnAfter] = await boardPaths(page, LIVE);
    // Where the stroke filled up and the next one carried on: kept for the owner to look at.
    await page.screenshot({ path: `${SHOTS}/ink-join-${zoom * 100}.png`, clip: { x: jx - 40, y: jy - 20, width: 80, height: 40 } });
    await page.mouse.up();
    await nextFrame(page);
    // The join and the part carried on past it, which runs back along the lap: 100 by 24 px.
    const [ex] = lap(STROKE_MAX_POINTS + 39);
    const carried = { x: ex - 10, y: jy - 12, width: jx - ex + 20, height: 24 };
    const liveCarried = await page.screenshot({ clip: carried });
    const liveDrawn = await boardPaths(page, LIVE);
    // The ink already drawn stays as it was: the full stroke's outline is the one it had, point for
    // point. Only round the end it had then do points differ: perfect-freehand closes a stroke's
    // end from its last few samples, so that end is drawn again as the stroke goes on (seen:
    // within 3.5 px of it at 100%, 7.9 px at 400%). Thinned to make room, every point would move.
    const end = lap(STROKE_MAX_POINTS - 11);
    const redrawn = unshared(drawnBefore!, drawnAfter!);
    for (let i = 0; i < redrawn.length; i += 2) {
      const [x, y] = await worldToPage(page, [redrawn[i]! / 1e4, redrawn[i + 1]! / 1e4]);
      expect(Math.hypot(x - end[0], y - end[1])).toBeLessThan(10);
    }
    if (pixels) {
      // Chrome draws a few edge pixels of a growing stroke again a shade apart (seen: 1 at 100%, 25
      // at 400%, the same with no stroke filling up). Thinned to make room, the line moved thousands.
      expect(await pixelsApart(page, seenBefore, seenAfter)).toBeLessThan(60);
      // The new stroke begins under the full one's ink, behind the join: what was drawn there stays (seen: 0 at 100%, 4 edge pixels a shade apart at 400%).
      expect(await pixelsApart(page, fullBehind, carriedBehind)).toBeLessThan(10);
    }
    await expect.poll(async () => (await added(page)).length, { timeout: 5000 }).toBe(1);
    const [mark] = await added(page);
    await expect(page.locator(`[data-item="${mark!.id}"] svg.ink`)).toBeVisible();
    await expect(page.locator(LIVE)).toHaveCount(0);
    await nextFrame(page);
    // Saved as one mark, both strokes are the paths they were drawn as, on the same points of the board, over the join too.
    expectSamePaths(await boardPaths(page, `[data-item="${mark!.id}"] svg.ink`), liveDrawn);
    if (pixels) expect(await pixelsApart(page, liveCarried, await page.screenshot({ clip: carried }))).toBe(0);
    // Every sample is saved: the first stroke full, the next from under its last points with the 40 after them.
    expect(mark!.strokes!.map((s) => s.pts.length)).toEqual([STROKE_MAX_POINTS * 2, (1 + STROKE_JOIN_POINTS + 40) * 2]);
  });
}

/* ------------------------------------------------------------------ two strokes, one mark */

/** Press, move through the points, and lift: one whole stroke. */
async function strokeThrough(page: Page, pts: readonly P[]) {
  await press(page, pts);
  await page.mouse.up();
  await nextFrame(page);
}

for (const dpr of [1, 2]) {
  test.describe(`at pixel density ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });
    for (const [name, zoom, [cx, cy]] of ZOOMS.filter(([, z]) => z >= 1)) {
      test(`at ${name}, two strokes in one go, the second begun 0.3 of a board unit off the first: not one pixel moves when they are saved as one mark`, async ({ page }) => {
        await open(page);
        await zoomTo(page, zoom);
        expect((await readCamera(page)).z).toBe(zoom);
        const pixels = await pixelsCompared(page);
        // Each stroke alone is drawn in a box of its own; saved, both are drawn in the box round the two.
        const off = 0.3 * zoom;
        const first = Array.from({ length: 40 }, (_, i): P => [cx - 100 + i * 4, cy - 30 + Math.round(6 * Math.sin(i / 4))]);
        const second = Array.from({ length: 40 }, (_, i): P => [cx - 97 + off + i * 4, cy + 21 + off + Math.round(6 * Math.cos(i / 4))]);
        const clip = { x: cx - 130, y: cy - 60, width: 260, height: 120 };
        await strokeThrough(page, first);
        await strokeThrough(page, second);
        await expect(page.locator(LIVE)).toHaveCount(2);
        const seenLive = await page.screenshot({ clip });
        const liveDrawn = await boardPaths(page, LIVE);

        await expect.poll(async () => (await added(page)).length, { timeout: 5000 }).toBe(1);
        const [mark] = await added(page);
        expect(mark!.strokes).toHaveLength(2);
        expect(mark!.anchor).toBeUndefined();
        await expect(page.locator(`[data-item="${mark!.id}"] svg.ink`)).toBeVisible();
        await expect(page.locator(LIVE)).toHaveCount(0);
        await nextFrame(page);
        // Saved, both strokes are the paths they were drawn as, on the same points of the board.
        expect(liveDrawn).toHaveLength(2);
        expectSamePaths(await boardPaths(page, `[data-item="${mark!.id}"] svg.ink`), liveDrawn);
        if (pixels) expect(await pixelsApart(page, seenLive, await page.screenshot({ clip }))).toBe(0);
      });
    }
  });
}

/* ------------------------------------------------------------------ the sine easing, side by side */

interface Go {
  name: string;
  kind: string;
  device: string;
  speed: string;
  camera: { x: number; y: number; z: number };
  strokes: Array<{ at: number[] }>;
}

/** One row of the picture: a name, and strokes as the log keeps them, in a box. */
interface Row {
  name: string;
  size: [w: number, h: number];
  strokes: Array<{ pts: number[]; w?: number }>;
}

const fixture = (path: string) => JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')) as unknown;

/** A recorded go as the pen keeps it and the log gets it. */
function rowOf(go: Go): Row {
  const kept = go.strokes.map((s) => {
    const pts: Array<[number, number, number]> = [];
    for (let i = 0; i + 1 < s.at.length; i += 2) pts.push([(s.at[i]! - go.camera.x) / go.camera.z, (s.at[i + 1]! - go.camera.y) / go.camera.z, 0.5]);
    const made = drawing(pts[0]!, go.camera.z);
    made.add(pts.slice(1));
    made.lift();
    return made.pts;
  });
  const { box, strokes } = keep(kept, PEN.size);
  return { name: `${go.kind}, ${go.device}, ${go.speed}`, size: [box[2], box[3]], strokes };
}

/** Excalidraw's easing of the line's width (packages/element/src/shape.ts at 9fbeaed): a sine ease-out. */
const sine = (t: number) => Math.sin((t * Math.PI) / 2);

/** The three lines laid side by side. The easing makes a line 1.4 times as wide, so it is shown again at the width keel's line has. */
const LOOKS: Array<{ title: string; look: Look; width: number }> = [
  { title: 'Keel’s line, as it is today', look: PEN, width: 1 },
  { title: 'With the sine easing', look: { ...PEN, easing: sine }, width: 1 },
  { title: 'With the sine easing, as wide as today', look: { ...PEN, easing: sine }, width: Math.SQRT1_2 },
];

test('the sine easing beside keel’s line: the same strokes drawn three ways, for the owner to choose from', async ({ page }) => {
  const hands = (fixture('../app/test/fixtures/hands.json') as { gos: Go[] }).gos;
  const recorded = fixture('../app/test/fixtures/strokes.json') as Record<string, number[][]>;
  const picked = hands.filter((g) => g.camera.z === 1 && ((g.device === 'mouse' && g.speed === 'fast') || (g.device === 'trackpad' && g.speed === 'slow')));
  expect(picked).toHaveLength(8);
  const old = (name: string): Row => {
    const { box, strokes } = keep(recorded[name]!.map((flat) => Array.from({ length: flat.length / 2 }, (_, i) => [flat[2 * i]!, flat[2 * i + 1]!] as const)), PEN.size);
    return { name: `${name} (the older recording)`, size: [box[2], box[3]], strokes };
  };
  const rows = [...picked.map(rowOf), old('sketch'), old('circleRound'), old('tick')];

  const cell = (row: Row, { look, width }: (typeof LOOKS)[number]) => {
    const pad = 14;
    const paths = row.strokes.map((s) => `<path d="${inkPath(s.pts, (s.w ?? PEN.size) * width, 1, 1, look)}" fill="#C2410C"/>`).join('');
    return `<svg width="${row.size[0] + 2 * pad}" height="${row.size[1] + 2 * pad}" viewBox="${-pad} ${-pad} ${row.size[0] + 2 * pad} ${row.size[1] + 2 * pad}">${paths}</svg>`;
  };
  const html = `<!doctype html><meta charset="utf-8"><style>
    body { margin: 0; padding: 28px 32px; background: #eef1f5; color: #0f1b2d; font: 14px/20px Inter, system-ui, sans-serif; }
    h1 { font-size: 20px; line-height: 28px; margin: 0 0 4px; }
    p { margin: 0 0 20px; color: #46536a; max-width: 980px; }
    table { border-collapse: collapse; }
    th { text-align: left; font-weight: 600; padding: 0 28px 10px 0; }
    td { padding: 6px 28px 6px 0; vertical-align: middle; border-top: 1px solid #d5dbe6; }
    td.name { color: #46536a; white-space: nowrap; }
  </style>
  <h1>The pen’s line, three ways</h1>
  <p>The same recorded strokes, from the same saved points. Left is keel’s line as every board draws it today. The middle adds the sine easing Excalidraw uses, which makes a line about 1.4 times as wide. The right is the easing again at the width keel’s line has now, so only the shape of the line differs. Taking the easing changes how ink already on a board looks.</p>
  <table><tr><th></th>${LOOKS.map((l) => `<th>${l.title}</th>`).join('')}</tr>
  ${rows.map((row) => `<tr><td class="name">${row.name}</td>${LOOKS.map((l) => `<td>${cell(row, l)}</td>`).join('')}</tr>`).join('\n')}
  </table>`;

  await page.setContent(html);
  await page.screenshot({ path: `${SHOTS}/ink-easing.png`, fullPage: true });
  // Left is the line the board draws: the one function, with nothing passed. The easing draws another line from the same points.
  const first = rows[0]!.strokes[0]!;
  expect(inkPath(first.pts, first.w, 1, 1, PEN)).toBe(inkPath(first.pts, first.w));
  expect(inkPath(first.pts, first.w, 1, 1, { ...PEN, easing: sine })).not.toBe(inkPath(first.pts, first.w));
  expect(await page.locator('svg path').count()).toBe(3 * rows.reduce((n, r) => n + r.strokes.length, 0));
});
