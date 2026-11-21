import { expect, test, type Page } from '@playwright/test';
import { appIsBuilt, type RunningBoard } from './board-server';
import { readLog, settle, watchErrors } from './build-flow';
import { APP, branches, buildIdea, card, commitOf, git, openBoard, openStory, toBlueprint, tryBoard, writeNote } from './try-flow';

/**
 * Canvases (records 0014, plan 4a), on the real board server: a board has many, each owns a
 * branch, the Board view shows one at a time, the Story lists them and starts a new one, and a
 * canvas can be deleted in every state. git and the log are looked at after each step.
 *
 * Needs a build first: `npm run build` from workspace/. `npm run e2e` does both.
 */

const IDEA = 'One engine that takes many requests at once';
const TITLE = 'One engine that takes many requests';
const BRANCH = 'board/one-engine-that-takes-many-requests';
const SECOND = 'A typing calculator for the shell';
const SECOND_TITLE = 'A typing calculator for the shell';

let boards: RunningBoard[] = [];
const open = async (opts: Parameters<typeof tryBoard>[0] = {}) => {
  const b = await tryBoard({ show: APP, ...opts });
  boards.push(b);
  return b;
};

test.beforeEach(() => {
  test.skip(!appIsBuilt(), 'build first: npm run build, from workspace/');
  test.setTimeout(120_000);
});

test.afterEach(async () => {
  test.setTimeout(90_000);
  await Promise.all(boards.map((b) => b.stop()));
  boards = [];
});

type CanvasEv = { type: string; canvas?: string; chapter?: string; by: string };
const events = (repo: string) => readLog(repo) as unknown as CanvasEv[];
const canvasesOf = (repo: string) => {
  const evs = events(repo);
  const opened = evs.filter((e) => e.type === 'canvas.open').map((e) => e.canvas!);
  // A first chapter on a board with no canvas makes the canvas, with the chapter's id.
  const first = evs.find((e) => e.type === 'chapter.open');
  return { opened, first: first?.chapter, removed: evs.filter((e) => e.type === 'canvas.remove').map((e) => e.canvas!) };
};

/** The pill's canvas name, after the board's name: " · <canvas>". */
const pill = (page: Page) => page.getByTestId('canvas-name');

/** Start a new canvas from the Story. The Board view goes to it. */
async function newCanvas(page: Page): Promise<void> {
  await openStory(page);
  const box = page.getByTestId('new-canvas');
  await expect(box).toContainText('Each canvas gets a branch of its own, started from main. Ideas on one canvas are built together, on its branch.');
  await page.getByTestId('new-canvas-press').click();
  await expect(page.getByTestId('story')).toHaveCount(0);
  await expect(page.getByTestId('board')).toBeVisible();
}

/** Ask to delete a canvas from its card. Returns the dialog. */
async function askDelete(page: Page, name: string) {
  await openStory(page);
  await card(page, name).getByTestId('canvas-delete').click();
  const dialog = page.getByTestId('confirm-delete');
  await expect(dialog).toBeVisible();
  return dialog;
}

test('a blank board: the first note makes the first canvas, and the pill names it', async ({ page }) => {
  const errors = watchErrors(page);
  const board = await open();
  await openBoard(page, board.url);
  await expect(page.getByTestId('canvas-name')).toHaveCount(0);
  await openStory(page);
  await expect(page.getByTestId('no-ideas')).toBeVisible();
  await page.getByRole('button', { name: 'Board' }).click();
  await writeNote(page, IDEA);
  await expect(page.locator('[data-item^="model-"]')).toHaveCount(1, { timeout: 15_000 });
  await expect(pill(page)).toHaveText(` · ${TITLE}`);
  const boardNameIsWhole = () => page.locator('.pill__board').evaluate((el) => el.scrollWidth <= el.clientWidth);
  expect(await boardNameIsWhole(), 'the board name is not cut beside the canvas name').toBe(true);
  const c = canvasesOf(board.repo);
  expect(c.opened).toEqual([]);
  expect(c.first).toBeTruthy();
  await openStory(page);
  expect(await boardNameIsWhole(), 'the board name is not cut in the Story').toBe(true);
  await expect(page.getByTestId('story').locator('article[data-canvas]')).toHaveCount(1);
  await expect(card(page, TITLE)).toHaveAttribute('data-canvas', c.first!);
  await expect(card(page, TITLE).getByTestId('idea-state')).toHaveText('idea');
  expect(errors).toEqual([]);
});

test('"Start a new canvas" opens a blank canvas; a note there starts an idea on it, apart from the first', async ({ page }) => {
  const errors = watchErrors(page);
  const board = await open();
  await openBoard(page, board.url);
  await writeNote(page, IDEA);
  await expect(page.locator('[data-item^="model-"]')).toHaveCount(1, { timeout: 15_000 });
  await settle(page);
  await expect(page.locator('[data-item]')).not.toHaveCount(0);
  // One note answered: no open mark on the first canvas.
  await expect(page.getByTestId('open-count')).toContainText('0 open marks');

  await newCanvas(page);
  const [fresh] = canvasesOf(board.repo).opened;
  expect(fresh, 'the press posted canvas.open').toBeTruthy();
  await expect(page.locator('[data-item]'), 'the first canvas’s items are not on it').toHaveCount(0);
  await expect(pill(page)).toHaveText(' · Untitled canvas');

  // A note on it, while the agent has not answered: the open marks are this canvas's own.
  await writeNote(page, SECOND);
  await expect(page.locator('[data-item][data-kind="note"]')).toHaveCount(1);
  await expect(page.locator('[data-item^="model-"]')).toHaveCount(1, { timeout: 15_000 });
  await expect(pill(page)).toHaveText(` · ${SECOND_TITLE}`);
  await expect(page.locator('[data-item][data-kind="note"]', { hasText: IDEA })).toHaveCount(0);
  const open2 = events(board.repo).filter((e) => e.type === 'chapter.open');
  expect(open2).toHaveLength(2);
  expect((open2[1] as unknown as { canvas: string }).canvas, 'the second idea is on the new canvas').toBe(fresh);

  await openStory(page);
  const cards = page.getByTestId('story').locator('article[data-canvas]');
  await expect(cards.locator('h3'), 'newest first').toHaveText([SECOND_TITLE, TITLE]);
  // Open goes back to the first canvas, with its own items.
  await card(page, TITLE).getByRole('button', { name: 'Open' }).click();
  await expect(pill(page)).toHaveText(` · ${TITLE}`);
  await expect(page.locator('[data-item][data-kind="note"]', { hasText: IDEA })).toHaveCount(1);
  await expect(page.locator('[data-item][data-kind="note"]', { hasText: SECOND })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a reload keeps the canvas in view', async ({ page }) => {
  const board = await open();
  await openBoard(page, board.url);
  await writeNote(page, IDEA);
  await expect(pill(page)).toHaveText(` · ${TITLE}`);
  await newCanvas(page);
  await writeNote(page, SECOND);
  await expect(pill(page)).toHaveText(` · ${SECOND_TITLE}`);
  await openStory(page);
  await card(page, TITLE).getByRole('button', { name: 'Open' }).click();
  await expect(pill(page)).toHaveText(` · ${TITLE}`);
  // The page keeps the view a quarter second after it last moves.
  await page.waitForTimeout(600);
  await page.reload();
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(pill(page)).toHaveText(` · ${TITLE}`);
  await expect(page.locator('[data-item][data-kind="note"]', { hasText: IDEA })).toHaveCount(1);
});

test('the agent draws on a canvas that is not in view: the notice says so, and one press goes there', async ({ page }) => {
  const errors = watchErrors(page);
  const board = await open({ env: { KEEL_E2E_PLANNER_WAIT_MS: '2500' } });
  await openBoard(page, board.url);
  await writeNote(page, IDEA);
  await expect(pill(page)).toHaveText(` · ${TITLE}`);
  await newCanvas(page);
  await expect(page.locator('[data-item]')).toHaveCount(0);
  const notice = page.getByTestId('elsewhere');
  await expect(notice).toHaveText(new RegExp(`The agent drew a picture on “${TITLE}”`), { timeout: 15_000 });
  await expect(page.locator('[data-item^="model-"]'), 'not drawn here').toHaveCount(0);
  await page.getByTestId('elsewhere-go').click();
  await expect(pill(page)).toHaveText(` · ${TITLE}`);
  await expect(page.locator('[data-item^="model-"]')).toHaveCount(1);
  await expect(notice).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('two ideas on one canvas: one branch; Approve waits while the second builds, then one approval names both and merges both', async ({ page }) => {
  const errors = watchErrors(page);
  const board = await open({ step: 900 });
  await openBoard(page, board.url);
  await buildIdea(page, IDEA);
  const main = commitOf(board.repo, 'main')!;

  // A second note on the built canvas starts a second idea there, on the same branch.
  const blueprint = await toBlueprint(page, SECOND, [260, 640]);
  const chapters = events(board.repo).filter((e) => e.type === 'chapter.open') as unknown as Array<{ chapter: string; canvas?: string }>;
  expect(chapters).toHaveLength(2);
  expect(chapters[1]!.canvas, 'the second idea is on the first canvas').toBe(chapters[0]!.chapter);
  await expect(blueprint.getByTestId('blueprint-start')).toHaveText(`This build goes onto this canvas’s branch, ${BRANCH}, with “${TITLE}”.`);
  await blueprint.getByRole('button', { name: 'Build this' }).click();
  await expect(page.getByTestId('chapter-state')).toHaveText('building');

  // While it builds, Approve is held, with its reason.
  await openStory(page);
  const c = card(page, TITLE);
  await expect(c.getByTestId('approve')).toHaveAttribute('data-state', 'held');
  await expect(c.getByTestId('approve-press')).toBeDisabled();
  await expect(c.getByTestId('approve-why')).toHaveText(`“${SECOND_TITLE}” is still building on this canvas, and every idea on a canvas shares its branch. Approve when it is built.`);
  await expect(c).toContainText('2 ideas, one branch');

  await expect(c.getByTestId('approve')).toHaveAttribute('data-state', 'ready', { timeout: 40_000 });
  expect(branches(board.repo), 'one branch for the two').toEqual([BRANCH, 'main']);
  expect(git(board.repo, 'rev-list', '--count', `main..${BRANCH}`)).toBe('10');
  const press = c.getByTestId('approve-press');
  await expect(press).toHaveText(`Approve “${TITLE}” and “${SECOND_TITLE}”: merge into main…`);
  await press.click();
  const confirm = page.getByTestId('confirm-approve');
  await expect(confirm).toContainText(`They are built on one branch, ${BRANCH}, so they go into main together.`);
  await confirm.getByRole('button', { name: 'Not yet' }).click();
  await expect(confirm).toHaveCount(0);
  expect(commitOf(board.repo, 'main'), 'Not yet moved nothing').toBe(main);
  await press.click();
  await page.getByTestId('confirm-approve-press').click();
  await expect(c.getByTestId('idea-state')).toHaveText(['merged into main', 'merged into main'], { timeout: 20_000 });
  expect(git(board.repo, 'rev-list', '--count', `${main}..main`)).toBe('10');
  expect(branches(board.repo)).toEqual(['main']);
  expect(events(board.repo).filter((e) => e.type === 'canvas.merged')).toHaveLength(1);

  // Everything here is merged: the board says a note here goes on this canvas, and offers a new one.
  await c.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByTestId('canvas-done').first()).toContainText('start a new canvas');
  expect(errors).toEqual([]);
});

test.describe('delete a canvas', () => {
  test('a blank canvas: nothing is on it; with none left the board is one empty canvas', async ({ page }) => {
    const errors = watchErrors(page);
    const board = await open();
    await openBoard(page, board.url);
    await newCanvas(page);
    const dialog = await askDelete(page, 'Untitled canvas');
    await expect(dialog).toContainText('It is blank: nothing else goes.');
    await page.getByTestId('confirm-delete-press').click();
    await expect(page.getByTestId('story').locator('article[data-canvas]')).toHaveCount(0);
    await expect(page.getByTestId('no-ideas')).toBeVisible();
    expect(canvasesOf(board.repo).removed).toHaveLength(1);
    // The board is one empty canvas, ready for a first note.
    await page.getByRole('button', { name: 'Board' }).click();
    await writeNote(page, IDEA);
    await expect(pill(page)).toHaveText(` · ${TITLE}`);
    expect(errors).toEqual([]);
  });

  test('with a build not merged: the idea and the commits are named; Keep it keeps it; Delete takes the branch away and the view moves', async ({ page }) => {
    const errors = watchErrors(page);
    const board = await open();
    await openBoard(page, board.url);
    await buildIdea(page, IDEA);
    await newCanvas(page);
    await writeNote(page, SECOND);
    await expect(pill(page)).toHaveText(` · ${SECOND_TITLE}`);

    let dialog = await askDelete(page, TITLE);
    await expect(dialog).toContainText(`The idea “${TITLE}” leaves the board, with its notes and pictures.`);
    await expect(dialog).toContainText(`Its branch ${BRANCH} is deleted, with 5 commits that main does not have.`);
    await dialog.getByRole('button', { name: 'Keep it' }).click();
    await expect(dialog).toHaveCount(0);
    expect(branches(board.repo)).toEqual([BRANCH, 'main']);
    await expect(card(page, TITLE)).toHaveCount(1);

    // Delete it while it is in view: the view moves to the other canvas.
    await card(page, TITLE).getByRole('button', { name: 'Open' }).click();
    await expect(pill(page)).toHaveText(` · ${TITLE}`);
    dialog = await askDelete(page, TITLE);
    await page.getByTestId('confirm-delete-press').click();
    await expect(card(page, TITLE)).toHaveCount(0);
    await expect.poll(() => branches(board.repo), { timeout: 15_000 }).toEqual(['main']);
    expect(git(board.repo, 'worktree', 'list').split('\n'), 'the copy is gone').toHaveLength(1);
    await page.getByRole('button', { name: 'Board' }).click();
    await expect(pill(page)).toHaveText(` · ${SECOND_TITLE}`);
    expect(errors).toEqual([]);
  });

  test('while it builds: the build stops, and the branch goes', async ({ page }) => {
    const errors = watchErrors(page);
    const board = await open({ step: 1500 });
    await openBoard(page, board.url);
    const blueprint = await toBlueprint(page, IDEA);
    await blueprint.getByRole('button', { name: 'Build this' }).click();
    await expect(page.locator('[data-testid="track"] > li[data-state="built"]')).toHaveCount(1, { timeout: 20_000 });
    const dialog = await askDelete(page, TITLE);
    await expect(dialog).toContainText(`The build of “${TITLE}” stops.`);
    await expect(dialog).toContainText(`Its branch ${BRANCH} is deleted`);
    await page.getByTestId('confirm-delete-press').click();
    await expect(page.getByTestId('story').locator('article[data-canvas]')).toHaveCount(0);
    await expect.poll(() => branches(board.repo), { timeout: 20_000 }).toEqual(['main']);
    // No part is built after the delete.
    const n = readLog(board.repo).filter((e) => e.type === 'part.state' && e.state === 'built').length;
    await page.waitForTimeout(2500);
    expect(readLog(board.repo).filter((e) => e.type === 'part.state' && e.state === 'built').length).toBe(n);
    await expect(page.getByTestId('no-ideas')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('merged: the code stays in main', async ({ page }) => {
    const errors = watchErrors(page);
    const board = await open();
    await openBoard(page, board.url);
    await buildIdea(page, IDEA);
    await page.getByTestId('approve-press').click();
    await expect(page.getByTestId('approve')).toHaveAttribute('data-state', 'merged', { timeout: 20_000 });
    const main = commitOf(board.repo, 'main')!;
    const dialog = await askDelete(page, TITLE);
    await expect(dialog).toContainText(`“${TITLE}” is in main already: that code stays there.`);
    await page.getByTestId('confirm-delete-press').click();
    await expect(page.getByTestId('story').locator('article[data-canvas]')).toHaveCount(0);
    expect(commitOf(board.repo, 'main')).toBe(main);
    expect(git(board.repo, 'show', 'main:parts.txt').trim().split('\n')).toHaveLength(4);
    expect(branches(board.repo)).toEqual(['main']);
    expect(errors).toEqual([]);
  });
});
