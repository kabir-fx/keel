// Screenshot the gallery on the system Chrome (no browser is downloaded): one image per
// picture, for every checkpoint of the golden fixture and for the contract's examples.
// Exits 1 if the page logs an error or a picture fails to draw.
//
//   node pictures/gallery/shoot.mjs            (from workspace/)
//   node pictures/gallery/shoot.mjs 3 5        (only these checkpoints)

import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'shots');
const only = process.argv.slice(2);
const pages = only.length ? only : ['1', '2', '3', '4', '5', '6', '7', 'examples'];

mkdirSync(out, { recursive: true });
if (!only.length) for (const f of readdirSync(out)) if (f.endsWith('.png')) rmSync(join(out, f));

const server = await createServer({ configFile: join(here, 'vite.config.ts'), logLevel: 'warn' });
await server.listen();
const base = server.resolvedUrls?.local[0] ?? 'http://127.0.0.1:5288/';

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1800, height: 1100 }, deviceScaleFactor: 1 });
const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

let shots = 0;
for (const at of pages) {
  await page.goto(`${base}?at=${at}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: '[data-no-shot] { display: none !important; }' });
  await page.waitForTimeout(150);
  const figs = await page.locator('[data-shot]').all();
  const expected = Number(await page.locator('main').getAttribute('data-pictures'));
  if (figs.length !== expected) problems.push(`at=${at}: ${figs.length} pictures drawn of ${expected}`);
  for (const fig of figs) {
    const id = await fig.getAttribute('data-shot');
    const plain = await fig.locator('.kp-plain').count();
    if (plain) problems.push(`at=${at} ${id}: drawn as a plain card`);
    await fig.screenshot({ path: join(out, `at-${at}-${id}.png`) });
    shots += 1;
    // A pipeline is shot in both views.
    const sw = fig.locator('.kp-switch__btn');
    if ((await sw.count()) === 2) {
      const now = await fig.locator('[data-view]').getAttribute('data-view');
      const other = now === 'layers' ? 'flat' : 'layers';
      await sw.nth(other === 'layers' ? 0 : 1).click();
      await fig.screenshot({ path: join(out, `at-${at}-${id}-${other}.png`) });
      shots += 1;
      await sw.nth(now === 'layers' ? 0 : 1).click();
    }
  }
}

await browser.close();
await server.close();
console.log(`${shots} screenshots in ${out}`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('no console error, no page error');
