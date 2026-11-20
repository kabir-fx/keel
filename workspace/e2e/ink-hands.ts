import { chromium } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Kind, P } from './hand';
import { DEVICES, draw, hand, random, shapes, sleep, zoomTo } from './hand';
import { readCamera } from './pointer';

/**
 * Record the strokes of `app/test/fixtures/hands.json`: circles, crosses, lines and scribbles,
 * from a mouse and from a trackpad, drawn fast and slow, at 25%, 100% and 400% zoom.
 *
 * What is real and what is not. The browser is real: the system Chrome, with the Pen in hand
 * on the built app, fed by Chrome's own mouse input in real time at the device's rate, and what
 * is kept is what the board's pointer events delivered (every coalesced sample, and how many
 * came with each event). The hand is not: it is the model in `hand.ts`. The timing of the
 * samples is the browser's, so two runs differ a little. Run it from workspace/e2e, and check
 * in what it writes:
 *
 *   npx tsx ink-hands.ts
 */

const OUT = fileURLToPath(new URL('../app/test/fixtures/hands.json', import.meta.url));
const APP = fileURLToPath(new URL('../app', import.meta.url));
const PORT = 5900 + (process.pid % 90);
const DIST = join(tmpdir(), `keel-ink-hands-${PORT}`);

const ZOOMS = [0.25, 1, 4] as const;
const KINDS: readonly Kind[] = ['circle', 'cross', 'line', 'scribble'];

/**
 * In the page: keep what the board's pointer events deliver while a button is down. It is
 * source text and not a function, because the tool that runs this file wraps a function's inner
 * functions in a helper the page does not have.
 */
const LISTEN = `
  window.__strokes = [];
  {
    let cur;
    const corner = () => document.querySelector('[data-testid="board"]').getBoundingClientRect();
    window.addEventListener('pointerdown', (e) => {
      const r = corner();
      cur = { at: [e.clientX - r.left, e.clientY - r.top], events: [], t0: e.timeStamp, t1: e.timeStamp };
      window.__strokes.push(cur);
    }, true);
    window.addEventListener('pointermove', (e) => {
      if (!cur || e.buttons === 0) return;
      const r = corner();
      const all = e.getCoalescedEvents();
      const got = all.length > 0 ? all : [e];
      for (const s of got) cur.at.push(s.clientX - r.left, s.clientY - r.top);
      cur.events.push(got.length);
      cur.t1 = e.timeStamp;
    }, true);
    window.addEventListener('pointerup', () => { cur = undefined; }, true);
  }
`;

/** One stroke as the page kept it. */
interface Heard {
  at: number[];
  events: number[];
  t0: number;
  t1: number;
}

async function main() {
  const built = spawnSync('npx', ['vite', 'build', '--logLevel', 'warn', '--outDir', DIST, '--emptyOutDir'], { cwd: APP, stdio: 'inherit' });
  if (built.status !== 0) throw new Error('the app did not build');
  const server = spawn('npx', ['vite', 'preview', '--outDir', DIST, '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: APP, stdio: 'ignore' });
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    await page.addInitScript(LISTEN);
    for (let i = 0; ; i++) {
      try {
        await page.goto(`http://127.0.0.1:${PORT}/?fixture=tools&at=1`);
        break;
      } catch (e) {
        if (i > 40) throw e;
        await sleep(250);
      }
    }
    await page.getByTestId('board').waitFor({ state: 'visible' });
    await page.evaluate(() => document.fonts.ready);
    await sleep(800);
    await page.keyboard.press('p');
    const cdp = await page.context().newCDPSession(page);

    const gos: unknown[] = [];
    let seed = 20261119;
    for (const zoom of ZOOMS) {
      await zoomTo(page, zoom);
      const camera = await readCamera(page);
      for (const device of ['mouse', 'trackpad'] as const) {
        for (const speed of ['fast', 'slow'] as const) {
          for (const kind of KINDS) {
            const rnd = random(seed++);
            const size = [0.55, 1, 1.5][Math.floor(rnd() * 3)]!;
            // About the middle of the board, where the fixture leaves bare ground at 100%.
            const centre: P = [720 + (rnd() - 0.5) * 120, 430 + (rnd() - 0.5) * 80];
            const from = await page.evaluate(() => (window as unknown as { __strokes: Heard[] }).__strokes.length);
            for (const path of shapes(kind, rnd, size, centre)) {
              const [lo, hi] = DEVICES[device].ms[speed];
              const ms = lo + rnd() * (hi - lo);
              await draw(cdp, hand(path, ms, device, rnd), ms, device, rnd);
              await sleep(120);
            }
            // Let the pen rest, so the next go is a go of its own.
            await sleep(850);
            const strokes = await page.evaluate((n) => (window as unknown as { __strokes: Heard[] }).__strokes.slice(n), from);
            gos.push({
              name: `${kind}, ${device}, ${speed}, ${zoom * 100}%`,
              kind,
              device,
              speed,
              camera,
              strokes: strokes.map((s) => ({ ms: Math.round(s.t1 - s.t0), events: s.events, at: s.at.map((n) => Math.round(n * 100) / 100) })),
            });
            process.stdout.write(`${gos.length} ${kind} ${device} ${speed} ${zoom}: ${strokes.map((s) => s.at.length / 2).join('+')} samples\n`);
          }
        }
      }
    }
    const about =
      'Strokes for the tests of the pen and of the reading of ink: circles, crosses, lines and scribbles, from a mouse and from a trackpad, drawn fast and slow, at 25%, 100% and 400% zoom. ' +
      'Made by e2e/ink-hands.ts: a model of a hand (e2e/hand.ts) moved the pointer of the system Chrome in real time, with the Pen in hand on the built app, and what is kept is what the board’s pointer events delivered. ' +
      'The browser, its timing and its coalescing are real; the hand is a model, not a person. ' +
      'Each go has the camera it was drawn under (screen = board units * z + x, y) and its strokes: `at` is every sample as flat x,y pairs in screen pixels from the board’s corner, the press first; ' +
      '`events` is how many samples each pointer move carried; `ms` is how long the stroke took. A circle reads as a circle, a cross as a cross, a line as an underline, a scribble as nothing.';
    writeFileSync(OUT, `${JSON.stringify({ about, gos })}\n`);
    process.stdout.write(`written to ${OUT}\n`);
  } finally {
    await browser.close();
    server.kill();
  }
}

await main();
