// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FocusPicture, PictureItem } from '@keel/protocol';
import type { Browser } from 'playwright';
import { chromium } from 'playwright';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Picture } from '../src';
import { STRESS, examplesBoard } from './examples';
import { at, item } from './fixture';

/**
 * Layout can only be checked where there is layout: this test draws focus cards in the
 * system Chrome (no browser is downloaded), with the fonts the app loads, and measures every
 * line of text. No two lines may cross, and no chip may hold more text than it shows.
 */

const here = dirname(fileURLToPath(import.meta.url));
const modules = join(here, '..', '..', 'node_modules', '@fontsource');
const FONTS: Array<[string, number, string]> = [
  ['Inter', 400, 'inter/files/inter-latin-400-normal.woff2'],
  ['Inter', 500, 'inter/files/inter-latin-500-normal.woff2'],
  ['Inter', 600, 'inter/files/inter-latin-600-normal.woff2'],
  ['Inter', 700, 'inter/files/inter-latin-700-normal.woff2'],
  ['Space Grotesk', 600, 'space-grotesk/files/space-grotesk-latin-600-normal.woff2'],
];
const css = [
  ...FONTS.map(([family, weight, file]) => `@font-face{font-family:'${family}';font-weight:${weight};src:url(data:font/woff2;base64,${readFileSync(join(modules, file)).toString('base64')}) format('woff2');}`),
  readFileSync(join(here, '..', 'src', 'styles.css'), 'utf8'),
  'body{margin:0;padding:16px;background:#EEF1F5} .case{margin-bottom:24px;display:inline-block}',
].join('\n');

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ channel: 'chrome' });
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

interface Fault {
  case: string;
  what: string;
}

/** Draw each picture in Chrome and list every line of text that crosses another, and every chip that overflows. */
async function faults(cases: Array<{ name: string; html: string }>): Promise<Fault[]> {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const body = cases.map((c) => `<div class="case" data-case="${c.name}">${c.html}</div>`).join('');
  await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  const out = await page.evaluate(() => {
    const found: Array<{ case: string; what: string }> = [];
    for (const root of document.querySelectorAll<HTMLElement>('[data-case]')) {
      const name = root.dataset.case!;
      const lines: Array<{ r: DOMRect; text: string; node: number }> = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n = 0;
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        if (!t.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(t);
        for (const r of range.getClientRects()) if (r.width > 0.5 && r.height > 0.5) lines.push({ r, text: t.textContent.trim().slice(0, 30), node: n });
        n += 1;
      }
      for (let i = 0; i < lines.length; i++) {
        for (let j = i + 1; j < lines.length; j++) {
          const a = lines[i]!;
          const b = lines[j]!;
          if (a.node === b.node) continue;
          // One pixel of slack: two runs on one line touch, they do not cross.
          const cross = a.r.left + 1 < b.r.right - 1 && b.r.left + 1 < a.r.right - 1 && a.r.top + 1 < b.r.bottom - 1 && b.r.top + 1 < a.r.bottom - 1;
          if (cross) found.push({ case: name, what: `"${a.text}" crosses "${b.text}"` });
        }
      }
      for (const chip of root.querySelectorAll<HTMLElement>('.kp-mono')) {
        if (chip.scrollWidth > chip.clientWidth + 1) found.push({ case: name, what: `chip "${chip.textContent}" is wider than its box` });
      }
      for (const row of root.querySelectorAll<HTMLElement>('.kp-cross li')) {
        const [chip, note] = [row.children[0], row.children[1]].map((e) => e?.getBoundingClientRect());
        if (chip && note && chip.right > note.left + 1 && chip.bottom > note.top + 1 && note.bottom > chip.top + 1) {
          found.push({ case: name, what: `a crossing's chip and note overlap: "${row.textContent}"` });
        }
      }
    }
    return found;
  });
  await page.close();
  return out;
}

const html = (it: PictureItem, state: Parameters<typeof Picture>[0]['state']) => renderToStaticMarkup(<Picture item={it} state={state} />);

describe('the focus card, drawn in Chrome', () => {
  it('lets no line of text cross another, for one to eight crossings', async () => {
    const stress = examplesBoard(true);
    const big = STRESS['ex-focus-crossings'] as FocusPicture;
    const crosses = big.crosses ?? [];
    const cases: Array<{ name: string; html: string }> = [];
    for (let k = 1; k <= crosses.length; k++) {
      // Both directions, the longest crossings first: four come in, four go out.
      const p: FocusPicture = { ...big, crosses: [...crosses.slice(0, Math.ceil(k / 2)), ...crosses.slice(4, 4 + Math.floor(k / 2))] };
      cases.push({ name: `${k} crossings`, html: html({ id: `f${k}`, kind: 'picture', picture: p }, stress.state) });
    }
    const fx = at(4).state;
    cases.push({ name: 'the fixture focus', html: html(item(fx, 'focus'), fx) });
    cases.push({ name: 'the contract example', html: html(item(stress.state, 'ex-focus'), stress.state) });
    const found = await faults(cases);
    expect(found).toEqual([]);
  }, 60_000);

  it('finds the fault it guards against', async () => {
    // The old rule: a chip that may not wrap, squeezed to a fixed width, spills over its note.
    const stress = examplesBoard(true);
    const broken = html(item(stress.state, 'ex-focus-crossings'), stress.state);
    const page = `<style>.kp-cross li{flex-wrap:nowrap!important}.kp-cross .kp-mono{white-space:nowrap!important;max-width:none!important;flex:0 0 76px!important;min-width:76px!important;overflow:visible}</style>${broken}`;
    const found = await faults([{ name: 'broken', html: page }]);
    expect(found.length).toBeGreaterThan(0);
  }, 60_000);
});
