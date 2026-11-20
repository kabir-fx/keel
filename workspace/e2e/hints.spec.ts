import { expect, test, type Page } from '@playwright/test';
import { zoomTo } from './hand';
import { nextFrame, readCamera, wheel } from './pointer';

/**
 * The hint line, the chrome round the board, the tooltips and the agent's cursor, on the system
 * Chrome: what rests on the browser's own behaviour (what a press lands on, hover, layout, the
 * computed styles, React's commits) is tested here.
 */

type Rect = { x: number; y: number; width: number; height: number };

/** Count React commits through a minimal DevTools hook, installed before React looks for one: as the bench counts them. */
function countCommits() {
  const w = window as unknown as { __commits: number; __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown };
  w.__commits = 0;
  const renderers = new Map<number, unknown>();
  w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers,
    supportsFiber: true,
    isDisabled: false,
    inject: (renderer: unknown) => {
      renderers.set(renderers.size + 1, renderer);
      return renderers.size;
    },
    onScheduleFiberRoot: () => {},
    onCommitFiberRoot: () => {
      w.__commits += 1;
    },
    onCommitFiberUnmount: () => {},
    onPostCommitFiberRoot: () => {},
    checkDCE: () => {},
  };
}

const commits = (page: Page) => page.evaluate(() => (window as unknown as { __commits: number }).__commits);

async function open(page: Page, url = '/?fixture=tools&at=1') {
  await page.addInitScript(() => {
    const w = window as unknown as { __admitted: unknown[] };
    w.__admitted = [];
    window.addEventListener('keel:admit', (e) => w.__admitted.push((e as CustomEvent).detail));
  });
  await page.addInitScript(countCommits);
  await page.goto(url);
  await expect(page.getByTestId('board')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('[data-measure]')).toHaveCount(0);
  await page.waitForTimeout(500);
}

const inks = (page: Page) =>
  page.evaluate(() => (window as unknown as { __admitted: Array<{ type: string; item?: { kind?: string } }> }).__admitted.filter((e) => e.type === 'item.add' && e.item?.kind === 'ink').length);

async function rect(page: Page, selector: string): Promise<Rect> {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`${selector} is not on screen`);
  return b;
}

/** A point of the board where nothing is drawn and no panel lies. */
async function bareGround(page: Page): Promise<{ x: number; y: number }> {
  const p = await page.evaluate(() => {
    for (let y = 150; y < window.innerHeight - 200; y += 20) {
      for (let x = 100; x < window.innerWidth - 300; x += 20) {
        const el = document.elementFromPoint(x, y);
        if (el?.classList.contains('ground')) return { x, y };
      }
    }
    return null;
  });
  if (!p) throw new Error('no bare ground on screen');
  return p;
}

const hint = (page: Page) => page.getByTestId('hint');
const visibility = (page: Page) => page.locator('.hint-line').evaluate((el) => getComputedStyle(el).visibility);

test.describe('the hint line', () => {
  test('says the tool’s step, hides while the pointer is down on the board, then says what comes next', async ({ page }) => {
    await open(page);
    await expect(hint(page)).toHaveCount(0);
    await page.keyboard.press('p');
    await expect(hint(page)).toHaveText('Draw on a picture to mark it. Its buttons still work.');
    expect(await visibility(page)).toBe('visible');
    // One line, just above the toolbar, and quiet: no press reaches it.
    const line = await rect(page, '[data-testid="hint"]');
    const bar = await rect(page, '.toolbar');
    expect(line.height).toBeLessThanOrEqual(20);
    expect(line.y + line.height).toBeLessThanOrEqual(bar.y);
    expect(bar.y - (line.y + line.height)).toBeLessThanOrEqual(12);
    expect(await page.locator('.hint-line').evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
    expect(await hint(page).evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');

    await page.mouse.move(700, 300);
    await page.mouse.down();
    expect(await visibility(page)).toBe('hidden');
    for (let i = 1; i <= 8; i++) await page.mouse.move(700 + i * 12, 300 + i * 6);
    expect(await visibility(page)).toBe('hidden');
    await page.mouse.up();
    expect(await visibility(page)).toBe('visible');
    const undo = process.platform === 'darwin' ? 'Cmd+Z' : 'Ctrl+Z';
    await expect(hint(page)).toHaveText(`Keep drawing. It becomes one mark when you rest the pen. ${undo} takes back the last stroke.`);
    await expect(hint(page)).toHaveText('Draw on a picture to mark it. Its buttons still work.', { timeout: 3000 });
  });

  test('gives its place to a toast while one shows', async ({ page }) => {
    await open(page);
    await page.keyboard.press('n');
    await expect(hint(page)).toHaveText('Click where the note goes, then type.');
    expect(await visibility(page)).toBe('visible');
    // A letter while the Note tool waits says where to click, in a toast.
    await page.keyboard.press('x');
    await expect(page.getByTestId('toast')).toBeVisible();
    expect(await visibility(page)).toBe('hidden');
    await page.getByRole('button', { name: 'Dismiss' }).click();
    expect(await visibility(page)).toBe('visible');
  });

  test('a fit with the hint showing keeps everything clear of the toolbar and of the hint', async ({ page }) => {
    // A narrow window, where the zoom buttons are put away: the hint is then the panel lowest on
    // the board that is highest up, and a fit that fills the height comes to it.
    await page.setViewportSize({ width: 700, height: 600 });
    await open(page);
    await page.keyboard.press('p');
    await expect(hint(page)).toBeVisible();
    await page.keyboard.press('1');
    await nextFrame(page);
    const line = await rect(page, '[data-testid="hint"]');
    const bar = await rect(page, '.toolbar');
    const bottoms = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.layer > [data-item]')].map((el) => el.getBoundingClientRect().bottom));
    expect(bottoms.length).toBeGreaterThan(0);
    // The fit fills the height here: the lowest item comes near the hint, and stays above it.
    expect(Math.max(...bottoms)).toBeLessThanOrEqual(line.y);
    expect(Math.max(...bottoms)).toBeGreaterThan(line.y - 60);
    expect(Math.max(...bottoms)).toBeLessThan(bar.y);
  });
});

test.describe('the chrome lets the board have the pointer', () => {
  test('a press on the empty width of the hint line reaches the board', async ({ page }) => {
    await open(page);
    await page.keyboard.press('p');
    await expect(hint(page)).toBeVisible();
    const box = await rect(page, '.hint-line');
    const line = await rect(page, '[data-testid="hint"]');
    // Inside the hint line's own box, left of its words.
    const at = { x: box.x + 40, y: line.y + line.height / 2 };
    expect(at.x).toBeLessThan(line.x);
    expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-testid="board"]'), at)).toBe(true);
    const before = await inks(page);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(at.x + i * 10, at.y - i * 12);
    await page.mouse.up();
    await expect.poll(() => inks(page), { timeout: 4000 }).toBe(before + 1);
  });

  test('the column of notices takes no press beside a notice narrower than it', async ({ page }) => {
    await open(page);
    // Two notices: "back to the board" (out of view) and what the server says (offline).
    await page.mouse.move(700, 400);
    for (let i = 0; i < 4; i++) await page.mouse.wheel(20000, 0);
    await expect(page.getByTestId('back-to-board')).toBeVisible();
    await page.evaluate(() => {
      // A second, wider notice, as the column shows it: the column must still let presses through beside the narrower one.
      const n = document.createElement('div');
      n.className = 'notice';
      n.textContent = 'A wide notice that says something long about the board and its server, for this test';
      document.querySelector('.notices')!.appendChild(n);
    });
    const column = await rect(page, '.notices');
    const back = await rect(page, '[data-testid="back-to-board"]');
    expect(back.width).toBeLessThan(column.width - 40);
    const at = { x: column.x + 10, y: back.y + back.height / 2 };
    expect(at.x).toBeLessThan(back.x);
    expect(await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-testid="board"]'), at)).toBe(true);
  });

  test('while a press is open on the board, the chrome under the pointer hears nothing', async ({ page }) => {
    await open(page);
    const pen = page.getByRole('button', { name: 'Draw with the pen' });
    const b = await pen.boundingBox();
    if (!b) throw new Error('no pen button');
    const over = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const hit = () => page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.toolbar [data-tool]')?.getAttribute('data-tool') ?? null, over);
    expect(await hit()).toBe('pen');
    const background = () => pen.evaluate((el) => getComputedStyle(el).backgroundColor);
    const still = await background();

    // A press on bare ground with Select, held and not moved: no capture yet, the pointer free.
    const ground = await bareGround(page);
    await page.mouse.move(ground.x, ground.y);
    await page.mouse.down();
    await expect(page.locator('.app')).toHaveAttribute('data-pressing', '');
    expect(await hit()).toBeNull();
    await page.mouse.move(over.x, over.y, { steps: 6 });
    expect(await pen.evaluate((el) => el.matches(':hover'))).toBe(false);
    expect(await background()).toBe(still);
    await page.mouse.up();
    await expect(page.locator('.app')).not.toHaveAttribute('data-pressing', '');
    expect(await hit()).toBe('pen');
  });
});

test.describe('the hint line gives its place to what would cross it', () => {
  test('a note being typed where the line is: the line hides, and is back once the note is clear of it', async ({ page }) => {
    await open(page);
    await page.keyboard.press('n');
    await expect(hint(page)).toHaveText('Click where the note goes, then type.');
    const line = await rect(page, '[data-testid="hint"]');
    // A note opened just above the line: its paper reaches down across the line.
    await page.mouse.click(line.x + 40, line.y - 10);
    const field = page.getByRole('textbox', { name: 'Your note' });
    await expect(field).toBeFocused();
    expect(await visibility(page)).toBe('hidden');
    await page.keyboard.type('words where the line was');
    expect(await visibility(page)).toBe('hidden');
    // The board moves under the pointer and takes the note up, clear of the line: the line says how to keep the note.
    await wheel(page, { at: [200, 300], dy: 300 });
    await nextFrame(page);
    expect(await visibility(page)).toBe('visible');
    await expect(hint(page)).toHaveText('Type the note. Enter keeps it, Shift+Enter starts a new line.');
    // And back down across it.
    await wheel(page, { at: [200, 300], dy: -300 });
    await nextFrame(page);
    expect(await visibility(page)).toBe('hidden');
    await page.keyboard.press('Enter');
    await expect(field).toHaveCount(0);
    expect(await visibility(page)).toBe('visible');
  });

  test('a note that grows down onto the line as it is typed: the line hides when the note reaches it', async ({ page }) => {
    await open(page);
    await page.keyboard.press('n');
    const line = await rect(page, '[data-testid="hint"]');
    // One line of words ends above the hint line; a few more reach it.
    await page.mouse.click(line.x + 40, line.y - 90);
    await expect(page.getByRole('textbox', { name: 'Your note' })).toBeFocused();
    await page.keyboard.type('one');
    expect(await visibility(page)).toBe('visible');
    for (const word of ['two', 'three', 'four']) {
      await page.keyboard.press('Shift+Enter');
      await page.keyboard.type(word);
    }
    await expect.poll(() => visibility(page)).toBe('hidden');
  });

  test('the window made taller takes the line clear of a note typed across it: the line is back, with no move of the board', async ({ page }) => {
    await open(page);
    await page.keyboard.press('n');
    const line = await rect(page, '[data-testid="hint"]');
    await page.mouse.click(line.x + 40, line.y - 10);
    await expect(page.getByRole('textbox', { name: 'Your note' })).toBeFocused();
    expect(await visibility(page)).toBe('hidden');
    // The line stands at the window's foot and goes down with it; the note stays where the board has it.
    await page.setViewportSize({ width: 1440, height: 1300 });
    await expect.poll(() => visibility(page)).toBe('visible');
    await expect(hint(page)).toHaveText('Type the note. Enter keeps it, Shift+Enter starts a new line.');
  });

  test('a tooltip over a tool lands on the line, and the line waits; a tooltip elsewhere leaves it be', async ({ page }) => {
    await open(page);
    await page.keyboard.press('p');
    await expect(hint(page)).toHaveText('Draw on a picture to mark it. Its buttons still work.');
    await page.getByRole('button', { name: 'Draw a box' }).hover();
    await expect(page.getByRole('tooltip')).toHaveText('Draw a box (B)', { timeout: 1500 });
    expect(await visibility(page)).toBe('hidden');
    // The zoom control's tip is clear of the line.
    await page.getByRole('button', { name: 'Zoom in' }).hover();
    await expect(page.getByRole('tooltip')).toHaveText('Zoom in (+)', { timeout: 1500 });
    expect(await visibility(page)).toBe('visible');
    const ground = await bareGround(page);
    await page.mouse.move(ground.x, ground.y);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    expect(await visibility(page)).toBe('visible');
  });
});

test.describe('the tooltips', () => {
  const tip = (page: Page) => page.getByRole('tooltip');

  test('show the tool and its key after a rest, above the toolbar, and go on a press', async ({ page }) => {
    await open(page);
    const pen = page.getByRole('button', { name: 'Draw with the pen' });
    await expect(pen).not.toHaveAttribute('title');
    await pen.hover();
    await page.waitForTimeout(250);
    await expect(tip(page)).toHaveCount(0);
    await expect(tip(page)).toHaveText('Draw with the pen (P)', { timeout: 1000 });
    const t = await rect(page, '[role="tooltip"]');
    const b = await rect(page, '[data-tool="pen"]');
    expect(t.y + t.height).toBeLessThanOrEqual(b.y);
    expect(Math.abs(t.x + t.width / 2 - (b.x + b.width / 2))).toBeLessThan(1);
    expect(await tip(page).evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
    // The next tool along shows at once.
    await page.getByRole('button', { name: 'Draw a box' }).hover();
    await expect(tip(page)).toHaveText('Draw a box (B)', { timeout: 100 });
    // A press puts it away, and the press is the button's.
    await page.mouse.down();
    await expect(tip(page)).toHaveCount(0);
    await page.mouse.up();
    await expect(page.getByRole('button', { name: 'Draw a box' })).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(700);
    await expect(tip(page)).toHaveCount(0);
  });

  test('a pointer that leaves a button before its tip is due gets no tip out on the board', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Draw with the pen' }).hover();
    await page.waitForTimeout(150);
    const ground = await bareGround(page);
    await page.mouse.move(ground.x, ground.y);
    // Well past the delay: the wait ended when the pointer left.
    await page.waitForTimeout(900);
    await expect(tip(page)).toHaveCount(0);
  });

  test('nothing is left to the browser’s own tooltip: the focus crumb, a file’s tile and the Story say theirs with the board’s', async ({ page }) => {
    const titled = () => page.evaluate(() => [...document.querySelectorAll('[title]')].map((e) => e.outerHTML.slice(0, 80)));
    await open(page, '/?fixture=engine-loop&at=4');
    expect(await titled()).toEqual([]);
    // The crumb's way back says its key as this keyboard writes it.
    await page.locator('.crumb__back').hover();
    await expect(tip(page)).toHaveText('Back to the board (Esc)', { timeout: 1500 });
    await expect(page.locator('[data-kind="file"] .file-tile__open').first()).toHaveAttribute('data-tip', /^Open \S/);
    await page.keyboard.press('Escape');
    await expect(tip(page)).toHaveCount(0);
    await page.locator('.view-switch button', { hasText: 'Story' }).click();
    expect(await titled()).toEqual([]);
    await page.locator('.moment').first().hover();
    await expect(tip(page)).toHaveText(/^Go to ".+" on the board$/, { timeout: 1500 });
  });

  test('Solidify, waiting for a lasso, still says what it needs', async ({ page }) => {
    await open(page);
    const solidify = page.locator('[data-tool="solidify"]');
    await expect(solidify).toBeDisabled();
    await solidify.hover();
    await expect(tip(page)).toHaveText('Solidify: first lasso the pictures you pick (Shift+S)', { timeout: 1000 });
  });

  test('Esc puts the tip away, and a button with a tip is still reached with Tab and pressed with Space', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Draw an arrow' }).hover();
    await expect(tip(page)).toHaveText('Draw an arrow (A)', { timeout: 1000 });
    await page.keyboard.press('Escape');
    await expect(tip(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Draw with the pen' }).focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Draw a box' })).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.getByRole('button', { name: 'Draw a box' })).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('the agent’s cursor', () => {
  const arrow = '.agent-cursor__arrow';

  test('is the same size at 25% and at 400%, and stays on its card', async ({ page }) => {
    await open(page);
    const sizes: Rect[] = [];
    for (const z of [0.25, 1, 4]) {
      await zoomTo(page, z);
      await nextFrame(page);
      sizes.push(await rect(page, arrow));
    }
    for (const s of sizes) {
      expect(s.width).toBeCloseTo(sizes[0]!.width, 3);
      expect(s.height).toBeCloseTo(sizes[0]!.height, 3);
    }
    expect(sizes[0]!.width).toBeCloseTo(22, 0);
    // At 100% it sits near the bottom right of the card it names.
    await zoomTo(page, 1);
    const card = await rect(page, '[data-item="a1"]');
    const c = await rect(page, '[data-testid="agent-cursor"]');
    expect(c.x).toBeGreaterThan(card.x + card.width / 2);
    expect(c.y).toBeGreaterThan(card.y + card.height / 2);
  });

  test('moves with the camera with no React commit, as the bench counts them', async ({ page }) => {
    await open(page);
    // The pointer rests at the board's left edge, and the board moves right, away from it: no
    // picture passes under it, so the lineage, which follows the hovered one, has nothing to redraw.
    await page.mouse.move(40, 450);
    await nextFrame(page);
    const before = await commits(page);
    const places = new Set<string>();
    for (let i = 0; i < 20; i++) {
      await page.mouse.wheel(-12, 0);
      await nextFrame(page);
      places.add(await page.getByTestId('agent-cursor').evaluate((el) => (el as HTMLElement).style.transform));
    }
    expect(places.size).toBeGreaterThan(15);
    expect(await commits(page)).toBe(before);
  });

  test('wears a white halo, and is faint, not hidden, while the agent is away', async ({ page }) => {
    await open(page);
    const halo = await page.locator('.agent-cursor__halo').evaluate((el) => {
      const s = getComputedStyle(el);
      return [s.stroke, s.strokeWidth, s.strokeLinejoin];
    });
    expect(halo).toEqual(['rgb(255, 255, 255)', '4px', 'round']);
    expect(await page.locator('.agent-cursor__tag').evaluate((el) => getComputedStyle(el).boxShadow)).toContain('rgb(255, 255, 255)');
    const cursor = page.getByTestId('agent-cursor');
    await cursor.evaluate((el) => el.setAttribute('data-away', ''));
    expect(await cursor.evaluate((el) => getComputedStyle(el).opacity)).toBe('0.3');
    await expect(cursor).toBeVisible();
  });

  test('off screen it waits faint at the board’s edge, and is whole again back in view', async ({ page }) => {
    await open(page);
    const cursor = page.getByTestId('agent-cursor');
    expect(await cursor.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    const cam = await readCamera(page);
    await page.mouse.move(700, 400);
    for (let i = 0; i < 4; i++) await page.mouse.wheel(20000, 0);
    await nextFrame(page);
    expect((await readCamera(page)).x).toBeLessThan(cam.x - 40000);
    const c = await rect(page, arrow);
    const view = page.viewportSize()!;
    expect(c.x).toBeGreaterThanOrEqual(0);
    expect(c.x + c.width).toBeLessThanOrEqual(view.width);
    expect(c.x).toBeLessThan(10);
    expect(await cursor.evaluate((el) => getComputedStyle(el).opacity)).toBe('0.3');
    await expect(page.locator('.agent-cursor__tag')).toBeHidden();
    for (let i = 0; i < 4; i++) await page.mouse.wheel(-20000, 0);
    await nextFrame(page);
    expect(await cursor.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    await expect(page.locator('.agent-cursor__tag')).toBeVisible();
  });
});

/**
 * Put on the page one of each thing the styles animate that a fixture does not show by itself: a
 * tool that listens, an item that flashes, the agent's signs, a picture being drawn and one
 * crossed out. Each is drawn where it is drawn on the board, so the board's own rules reach it.
 */
function probeEveryMotion(): void {
  const add = (parent: Element | null, html: string) => parent?.insertAdjacentHTML('beforeend', html);
  add(document.querySelector('.toolbar'), '<button class="tool tool--owner tool--listening" data-probe></button>');
  add(document.querySelector('.layer'), '<div class="item item--flash" data-probe><div class="note">flash</div></div>');
  add(document.querySelector('.layer'), '<div class="item" data-probe><article class="kp kp--crossed"><div class="kp-drawing__bar"></div></article></div>');
  for (const sign of ['drawing', 'building']) add(document.querySelector('.app'), `<span class="presence-sign presence-sign--${sign}" data-probe><i></i><i></i><i></i></span>`);
}

/** Every animation and transition running or set on the page, read from the computed styles. */
function moving(): string[] {
  const out = document.getAnimations().map((a) => `running: ${(a as CSSAnimation).animationName ?? 'a transition'} on ${(a.effect as KeyframeEffect | null)?.target?.className ?? '?'}`);
  for (const el of document.querySelectorAll<HTMLElement>('.app, .app *')) {
    const s = getComputedStyle(el);
    const timed = (list: string) => list.split(',').some((d) => parseFloat(d) > 0);
    if (s.animationName !== 'none' && timed(s.animationDuration)) out.push(`animation ${s.animationName} on ${el.className}`);
    if (timed(s.transitionDuration)) out.push(`transition ${s.transitionProperty} on ${el.className}`);
  }
  return out;
}

test.describe('the layers', () => {
  test('each part of the board lies at its named layer, in the order the names give', async ({ page }) => {
    await open(page);
    await page.keyboard.press('p');
    await page.getByRole('button', { name: 'Draw a box' }).hover();
    await expect(page.getByRole('tooltip')).toBeVisible({ timeout: 1000 });
    const order = ['ground', 'world', 'overlay', 'hint', 'drop', 'story', 'panels', 'notices', 'tooltip', 'toast'];
    const read = await page.evaluate((names) => {
      const root = getComputedStyle(document.documentElement);
      const layer = (name: string) => Number(root.getPropertyValue(`--layer-${name}`));
      const z = (selector: string) => Number(getComputedStyle(document.querySelector(selector)!).zIndex);
      return {
        layers: names.map(layer),
        drawn: [
          [z('.ground'), layer('ground')],
          [z('.world'), layer('world')],
          [z('.overlay'), layer('overlay')],
          [z('.hint-line'), layer('hint')],
          [z('.toolbar'), layer('panels')],
          [z('.notices'), layer('notices')],
          [z('[role="tooltip"]'), layer('tooltip')],
        ],
      };
    }, order);
    expect(read.layers.every((n) => Number.isFinite(n))).toBe(true);
    // Each layer's place is said by its name in the styles, never by a bare number.
    const bare = await page.evaluate(() => {
      const layers = ['.ground', '.world', '.overlay', '.hint-line', '.drop-hint', '.story', '.chrome', '.notices', '.tooltip', '.toast', '.item--editor', '.label-editor'];
      const out: string[] = [];
      const walk = (rules: CSSRuleList) => {
        for (const r of rules) {
          if (r instanceof CSSStyleRule && layers.includes(r.selectorText)) {
            const z = r.style.getPropertyValue('z-index');
            if (z && !z.startsWith('var(--layer-')) out.push(`${r.selectorText}: ${z}`);
          } else if ('cssRules' in r) walk((r as CSSGroupingRule).cssRules);
        }
      };
      for (const sheet of document.styleSheets) walk(sheet.cssRules);
      return out;
    });
    expect(bare).toEqual([]);
    expect([...read.layers].sort((x, y) => x - y)).toEqual(read.layers);
    expect(new Set(read.layers).size).toBe(read.layers.length);
    for (const [z, named] of read.drawn) expect(z).toBe(named);
  });
});

test.describe('reduced motion', () => {
  for (const [name, url] of [
    ['the agent drawing', '/?fixture=engine-loop&at=2'],
    ['the agent building', '/?fixture=engine-loop&at=6'],
    ['the tools, with a tool hovered', '/?fixture=tools&at=1'],
  ] as const) {
    test(`with reduced motion asked, nothing on the page moves by itself: ${name}`, async ({ page }) => {
      await open(page, url);
      await page.getByRole('button', { name: 'Draw with the pen' }).hover();
      await page.waitForTimeout(600);
      await page.evaluate(probeEveryMotion);
      expect(await page.evaluate(moving)).toEqual([]);
      // The same page with motion allowed does move: what is read above is what moves.
      if (name !== 'the tools, with a tool hovered') {
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        expect((await page.evaluate(moving)).length).toBeGreaterThan(0);
      }
    });
  }
});
