import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Page } from '@playwright/test';

/**
 * Helpers for a fixture played on the board (`?fixture=<name>&at=<n>&play=1`), for the browser
 * tests and the visual review of the agent's motion. On a manual clock nothing on the page moves
 * by itself: `renderAt(page, ms)` moves the board to the moment `ms` of the play, and the same
 * address and the same moments give the same frames.
 */

/** What the page puts on `window` in fixture mode (`app/src/replay/page.ts`). */
interface ReplayWindow {
  __keel?: { ready(): boolean; ms(): number; readonly length: number; done(): boolean };
  renderAt?: (ms: number) => Promise<void>;
}

export interface Replay {
  fixture: string;
  /** The checkpoint to play up to, from the one before it. Left out, the whole log from a blank board. */
  at?: number;
  /** On the manual clock: the page moves only through `renderAt`. */
  manual?: boolean;
}

/** The address of a played fixture. */
export function replayUrl({ fixture, at, manual }: Replay): string {
  const q = new URLSearchParams({ fixture });
  if (at !== undefined) q.set('at', String(at));
  q.set('play', '1');
  if (manual) q.set('clock', 'manual');
  return `/?${q.toString()}`;
}

/** Open a played fixture with motion on, and wait until the board has opened and the play has begun. */
export async function openReplay(page: Page, replay: Replay): Promise<void> {
  // Every other browser test asks for reduced motion: a played board is for watching motion.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(replayUrl(replay));
  await page.waitForFunction(() => (window as unknown as ReplayWindow).__keel?.ready() === true, undefined, { timeout: 20_000 });
}

/** Move the board to the moment `ms` of the play, and wait until the page shows it. Manual clock only. */
export async function renderAt(page: Page, ms: number): Promise<void> {
  await page.evaluate((t) => (window as unknown as ReplayWindow).renderAt!(t), ms);
}

/** How the play stands: how far it has run, how long it is, and whether it is over. */
export async function playStatus(page: Page): Promise<{ ms: number; length: number; done: boolean }> {
  return page.evaluate(() => {
    const k = (window as unknown as ReplayWindow).__keel!;
    return { ms: k.ms(), length: k.length, done: k.done() };
  });
}

export interface Sheet {
  /** The moments to take, in ms, in the order they come. */
  times: readonly number[];
  /** Where the sheet's PNG goes. */
  out: string;
  /** The part of the page each frame shows. The whole page when left out. */
  clip?: { x: number; y: number; width: number; height: number };
  /** Frames per row. */
  columns?: number;
  /** How wide each frame is drawn on the sheet, in px. */
  width?: number;
}

/**
 * Take a frame at each moment and write them as one sheet, each with its time printed under it.
 * The sheet is put together in the browser, on a page of its own, so nothing new is needed to
 * draw it. The page must be on the manual clock. Answers where the sheet was written.
 */
export async function contactSheet(page: Page, { times, out, clip, columns = 4, width = 360 }: Sheet): Promise<string> {
  for (let i = 1; i < times.length; i++) {
    if (times[i]! < times[i - 1]!) throw new Error(`A contact sheet goes forward in time: ${times[i]} ms comes after ${times[i - 1]} ms.`);
  }
  const frames: Array<{ ms: number; png: string }> = [];
  for (const ms of times) {
    await renderAt(page, ms);
    // Animations are left as the clock set them: 'disabled' would run them to their end.
    const png = await page.screenshot({ ...(clip ? { clip } : {}), animations: 'allow' });
    frames.push({ ms, png: png.toString('base64') });
  }
  const sheet = await page.context().newPage();
  try {
    await sheet.setViewportSize({ width: columns * (width + 16) + 16, height: 400 });
    await sheet.setContent(
      `<!doctype html><html><body style="margin:0;padding:16px;background:#fff;font:600 14px/1.2 system-ui,sans-serif;color:#0f1b2d">` +
        `<div style="display:grid;grid-template-columns:repeat(${columns},${width}px);gap:16px">` +
        frames
          .map(
            (f) =>
              `<figure style="margin:0"><img src="data:image/png;base64,${f.png}" style="display:block;width:${width}px;border:1px solid #d5dbe3"/>` +
              `<figcaption style="padding-top:6px">${Math.round(f.ms)} ms</figcaption></figure>`,
          )
          .join('') +
        `</div></body></html>`,
      { waitUntil: 'load' },
    );
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, await sheet.screenshot({ fullPage: true }));
  } finally {
    await sheet.close();
  }
  return out;
}
