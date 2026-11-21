import { expect, test, type Page } from '@playwright/test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appIsBuilt, type RunningBoard } from './board-server';
import { readLog, watchErrors } from './build-flow';
import { APP, BROKEN, PAGE, SETUP, TERMINAL, branches, buildIdea, built, card, commitOf, copyDir, git, openBoard, openStory, subjectOf, toBlueprint, tryBoard } from './try-flow';

/**
 * Trying a built idea on the board (record 0013), on the real board server: the blueprint says
 * what "Build this" agrees to and where the build starts, the scripted builder makes the
 * canvas's branch in a copy of its own, and the try room runs what the blueprint named, for
 * real: a web app in the frame, a command in a terminal, a page that stands alone. Nothing
 * here is mocked between the page and the processes it starts.
 *
 * Needs a build first: `npm run build` from workspace/. `npm run e2e` does both.
 */

const SHOTS = process.env.KEEL_J2_SHOTS;
/** Where this round's screenshots for the report go, when asked for. */
const J3_SHOTS = process.env.KEEL_J3_SHOTS;
const IDEA = 'One engine that takes many requests at once';
const TITLE = 'One engine that takes many requests';

let boards: RunningBoard[] = [];
const open = async (opts: Parameters<typeof tryBoard>[0]) => {
  const b = await tryBoard(opts);
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

/** Does anything answer at this address? Asked from the test, not the page. */
const answers = async (url: string): Promise<boolean> => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
};

/** Is a process with this pid alive? */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The text an xterm shows, row by row. */
const terminalText = (page: Page) => page.getByTestId('try-terminal').locator('.xterm-rows').innerText();

test('the blueprint shows what "Build this" agrees to and where the build starts; the build goes on a branch named from the canvas', async ({ page }) => {
  const errors = watchErrors(page);
  const board = await open({ show: APP, setup: SETUP });
  await openBoard(page, board.url);
  const main = commitOf(board.repo, 'main')!;
  const blueprint = await toBlueprint(page, IDEA);

  const agrees = blueprint.getByTestId('blueprint-agrees');
  await expect(agrees).toContainText('What “Build this” agrees to');
  await expect(agrees).toContainText('The check, after each part');
  await expect(agrees.locator('code', { hasText: 'test -s parts.txt' })).toHaveCount(1);
  await expect(agrees).toContainText('The setup, once before the first part');
  await expect(agrees.locator('code', { hasText: SETUP })).toHaveCount(1);
  await expect(agrees).toContainText('How you will try it');
  await expect(agrees).toContainText('An app. When you press Try it, the board runs node app.mjs in the build’s own copy and shows it here.');
  await expect(blueprint.getByTestId('blueprint-start')).toHaveText(`This build starts from main at ${main.slice(0, 7)}, on a branch of its own.`);

  await blueprint.getByRole('button', { name: 'Build this' }).click();
  await built(page);

  // The branch is named from the canvas's title, starts from main, and holds the four parts and
  // the builder's last commit, the brief with the result.
  const branch = `board/${TITLE.toLowerCase().replace(/ /g, '-')}`;
  expect(branches(board.repo)).toEqual([branch, 'main']);
  expect(git(board.repo, 'merge-base', main, branch)).toBe(main);
  expect(git(board.repo, 'rev-list', '--count', `main..${branch}`)).toBe('5');
  expect(subjectOf(board.repo, branch)).toBe(`${TITLE}: the brief, with the result`);
  expect(git(board.repo, 'show', `${branch}:parts.txt`).split('\n')).toHaveLength(4);
  // The app was started once in the copy, and answered: the board says so.
  expect(readLog(board.repo).filter((e) => e.type === 'build.proved').map((e) => e.by)).toEqual(['system']);
  await expect(page.getByTestId('feed').locator('.feed__line', { hasText: 'The app started and answered' }).locator('.feed__text')).toHaveText('The app started and answered, as you will try it: `node app.mjs`.');
  // The setup ran in the build's own copy, not in the owner's folder.
  const copy = copyDir(board.repo);
  expect(existsSync(join(copy, '.deps/ok')), 'the setup ran in the copy').toBe(true);
  expect(existsSync(join(board.repo, '.deps')), 'and not in the owner folder').toBe(false);
  expect(commitOf(board.repo, 'main'), 'main has not moved').toBe(main);

  // The press carried what the blueprint showed, word for word.
  const start = readLog(board.repo).find((e) => e.type === 'build.start') as unknown as { setup?: string; show?: unknown; check?: string };
  expect(start.setup).toBe(SETUP);
  expect(start.show).toEqual(APP);
  // The build panel says where it went.
  await expect(page.getByTestId('watch')).toContainText(`Approve merges ${branch} into main on this machine.`);
  expect(errors).toEqual([]);
});

test('try an app: Start, the built app in the frame, the proof list ticks, what it printed, Stop, Esc', async ({ page }) => {
  const errors = watchErrors(page);
  const board = await open({ show: APP });
  await openBoard(page, board.url);
  await buildIdea(page, IDEA);

  // Built: the watch panel leads to Try it.
  const tryIt = page.getByTestId('watch-try');
  await expect(tryIt).toHaveText('Try it');
  await tryIt.click();
  const room = page.getByTestId('try-room');
  await expect(room).toHaveAttribute('data-kind', 'app');
  await expect(room).toHaveAttribute('data-state', 'off');
  await expect(page.getByTestId('try-branch')).toHaveText(`board/${TITLE.toLowerCase().replace(/ /g, '-')}`);
  await expect(page.getByTestId('try-off')).toContainText('Press Start to run node app.mjs. Nothing runs before you do.');
  const press = page.getByTestId('try-press');
  await expect(press).toHaveText('Start');
  await expect(press, 'Start has the focus').toBeFocused();
  await expect(page.getByTestId('try-frame')).toHaveCount(0);

  await press.click();
  await expect(room).toHaveAttribute('data-state', 'on', { timeout: 30_000 });
  const words = (await page.getByTestId('try-words').textContent())!;
  const url = words.match(/Running at (http:\/\/127\.0\.0\.1:\d+\/)/)?.[1];
  expect(url, `the room says where it runs: ${words}`).toBeTruthy();
  await expect(page.getByTestId('try-tab')).toHaveAttribute('href', url!);
  await expect(page.getByTestId('try-unboxed'), 'the scripted builder has no box, and the room says so').toBeVisible();

  // The frame shows the app the build made, from the build's copy: its four parts.
  const frame = page.frameLocator('[data-testid="try-frame"]');
  await expect(frame.getByRole('heading', { name: 'The engine answers' })).toBeVisible({ timeout: 15_000 });
  await expect(frame.getByTestId('parts').locator('li')).toHaveText(['The door', 'Inbound queue', 'Engine loop', 'Reply stream']);
  await expect(page.getByTestId('try-frame')).toHaveAttribute('src', url!);

  // The proof list ticks.
  await expect(page.getByTestId('try-proof-count')).toHaveText('0 of 1');
  await page.getByTestId('try-proof').getByRole('checkbox').check();
  await expect(page.getByTestId('try-proof-count')).toHaveText('1 of 1');

  // What the app printed: its own lines.
  const printed = page.getByTestId('try-printed');
  await printed.locator('summary').click();
  await expect(printed.locator('pre')).toContainText(`the engine listens on 127.0.0.1:${new URL(url!).port}`);
  await expect(printed.locator('pre')).toContainText('GET /');
  await expect(room.getByTestId('approve-press')).toHaveText('Approve: merge into main');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/try-room-app.png` });

  // Stop ends it: the app no longer answers.
  expect(await answers(url!)).toBe(true);
  await expect(press).toHaveText('Stop');
  await press.click();
  await expect(room).toHaveAttribute('data-state', 'off', { timeout: 15_000 });
  await expect(press).toHaveText('Start');
  await expect(page.getByTestId('try-frame')).toHaveCount(0);
  await expect.poll(() => answers(url!), { timeout: 10_000 }).toBe(false);

  // Esc closes the room, and the focus goes back to Try it.
  await page.keyboard.press('Escape');
  await expect(room).toHaveCount(0);
  await expect(tryIt).toBeFocused();
  expect(errors).toEqual([]);
});

test('try a terminal: the prompt, the command typed in, an answer to what the owner types, the end with its code, Start again', async ({ page }) => {
  const errors = watchErrors(page);
  const board = await open({ show: TERMINAL });
  await openBoard(page, board.url);
  await buildIdea(page, IDEA);
  await page.getByTestId('watch-try').click();
  const room = page.getByTestId('try-room');
  await expect(room).toHaveAttribute('data-kind', 'terminal');
  await expect(room).toHaveAttribute('data-state', 'off');
  await expect(page.getByTestId('try-off')).toContainText('Press Start to run node greet.mjs.');
  await page.getByTestId('try-press').click();
  await expect(room).toHaveAttribute('data-state', 'on', { timeout: 15_000 });
  await expect(page.getByTestId('try-terminal')).toBeVisible();

  // The shell's prompt, the command it was given, and the tool's question.
  await expect.poll(() => terminalText(page), { timeout: 15_000 }).toContain('$ node greet.mjs');
  await expect.poll(() => terminalText(page), { timeout: 15_000 }).toContain('your name?');
  // The terminal has the keys: what the owner types goes to the tool, and its answer comes back.
  await page.keyboard.type('Ada');
  await page.keyboard.press('Enter');
  await expect.poll(() => terminalText(page), { timeout: 15_000 }).toContain('hello, Ada!');
  // Esc is the terminal's: the room stays. The shell took it as the start of a key, so the line is cleared.
  await page.keyboard.press('Escape');
  await expect(room).toBeVisible();
  await page.keyboard.press('Control+C');

  // The shell ends with a code of the owner's choosing.
  await page.keyboard.type('exit 3');
  await page.keyboard.press('Enter');
  await expect(room).toHaveAttribute('data-state', 'ended', { timeout: 15_000 });
  await expect(page.getByTestId('try-words')).toHaveText('The terminal ended with code 3.');
  await expect(page.getByTestId('try-press')).toHaveText('Start again');
  await expect(page.getByTestId('try-terminal'), 'what it printed stays to read').toBeVisible();

  await page.getByTestId('try-press').click();
  await expect(room).toHaveAttribute('data-state', 'on', { timeout: 15_000 });
  await expect.poll(() => terminalText(page), { timeout: 15_000 }).toContain('your name?');
  await page.getByTestId('try-press').click();
  await expect(room).toHaveAttribute('data-state', 'ended', { timeout: 15_000 });
  await page.getByTestId('try-close').click();
  await expect(room).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('try a page that stands alone: framed in the room, with nothing to start', async ({ page }) => {
  const errors = watchErrors(page);
  const board = await open({ show: PAGE });
  await openBoard(page, board.url);
  await buildIdea(page, IDEA);
  await page.getByTestId('watch-try').click();
  const room = page.getByTestId('try-room');
  await expect(room).toHaveAttribute('data-kind', 'page');
  await expect(page.getByTestId('try-words')).toHaveText('The page this build made, served from an address of its own. Nothing runs.');
  await expect(page.getByTestId('try-press'), 'a page has nothing to start').toHaveCount(0);
  const frame = page.frameLocator('[data-testid="try-frame"]');
  await expect(frame.getByRole('heading', { name: 'The engine is built' })).toBeVisible({ timeout: 15_000 });
  await frame.getByRole('button', { name: 'Send a request' }).click();
  await expect(frame.getByTestId('count'), 'its script runs in the frame').toHaveText('1');
  const src = (await page.getByTestId('try-frame').getAttribute('src'))!;
  expect(new URL(src).origin, 'served from an origin of its own').not.toBe(new URL(page.url()).origin);
  await expect(page.getByTestId('try-tab')).toHaveAttribute('href', src);
  // The frame's page is another origin: its keys never reach the board. Esc works from the room.
  await page.getByTestId('try-words').click();
  await page.keyboard.press('Escape');
  await expect(room).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('an app that answered when it was built and ends before it answers at the press: the reason, its last lines, that this is new, Start again, and Approve is still there', async ({ page }) => {
  const board = await open({ show: BROKEN });
  await openBoard(page, board.url);
  await buildIdea(page, IDEA);
  // It started and answered once in the build. Then its database went away.
  expect(readLog(board.repo).filter((e) => e.type === 'build.proved')).toHaveLength(1);
  writeFileSync(join(copyDir(board.repo), 'down'), '');
  await page.getByTestId('watch-try').click();
  const room = page.getByTestId('try-room');
  await page.getByTestId('try-press').click();
  await expect(room).toHaveAttribute('data-state', 'failed', { timeout: 20_000 });
  const failed = page.getByTestId('try-failed');
  await expect(failed.locator('h3')).toHaveText('The app did not start');
  await expect(failed).toContainText('The app ended before it answered (exit 3).');
  await expect(page.getByTestId('try-last')).toContainText('reading the settings');
  await expect(page.getByTestId('try-last')).toContainText('DATABASE_URL is not set: the engine cannot start');
  await expect(failed).toContainText('It started and answered when it was built, so this is new. Start again runs it once more.');
  await expect(failed).not.toContainText('You can still approve it');
  await expect(page.getByTestId('try-press')).toHaveText('Start again');
  await expect(room.getByTestId('approve-press')).toBeEnabled();
  await expect(room.getByTestId('approve-press')).toHaveText('Approve: merge into main');
});

test('a reload during a running show: the owner rejoins it, and the terminal’s kept output comes back', async ({ page }) => {
  const errors = watchErrors(page);
  const board = await open({ show: TERMINAL });
  await openBoard(page, board.url);
  await buildIdea(page, IDEA);
  await page.getByTestId('watch-try').click();
  await page.getByTestId('try-press').click();
  const room = page.getByTestId('try-room');
  await expect(room).toHaveAttribute('data-state', 'on', { timeout: 15_000 });
  await expect.poll(() => terminalText(page), { timeout: 15_000 }).toContain('your name?');
  await page.keyboard.type('Grace');
  await page.keyboard.press('Enter');
  await expect.poll(() => terminalText(page), { timeout: 15_000 }).toContain('hello, Grace!');

  await page.reload();
  await expect(page.getByTestId('board')).toBeVisible();
  await page.getByTestId('watch-try').click();
  await expect(room, 'the show still runs').toHaveAttribute('data-state', 'on', { timeout: 15_000 });
  await expect(page.getByTestId('try-press')).toHaveText('Stop');
  await expect.poll(() => terminalText(page), { timeout: 15_000 }).toContain('hello, Grace!');
  // It is the same shell: it takes keys still.
  await page.getByTestId('try-terminal').click();
  await page.keyboard.type('echo still-$((6*7))');
  await page.keyboard.press('Enter');
  await expect.poll(() => terminalText(page), { timeout: 15_000 }).toContain('still-42');
  await page.getByTestId('try-press').click();
  await expect(room).toHaveAttribute('data-state', 'ended', { timeout: 15_000 });
  expect(errors).toEqual([]);
});

test('the next idea’s line: with one canvas built and not approved, a blueprint on another canvas says this build will not have it, and the link opens its try room', async ({ page }) => {
  const errors = watchErrors(page);
  const board = await open({ show: APP });
  await openBoard(page, board.url);
  await buildIdea(page, IDEA);
  const first = readLog(board.repo).find((e) => e.type === 'build.start') as unknown as { chapter: string };

  await openStory(page);
  await page.getByTestId('new-canvas-press').click();
  await expect(page.getByTestId('story')).toHaveCount(0);
  const blueprint = await toBlueprint(page, 'A typing calculator for the shell');
  const main = commitOf(board.repo, 'main')!;
  const start = blueprint.getByTestId('blueprint-start');
  await expect(start).toContainText(`This build starts from main at ${main.slice(0, 7)}, on a branch of its own.`);
  await expect(start).toContainText(`“${TITLE}” is built and not approved yet, so this build will not have it.`);
  const link = start.locator('[data-try]');
  await expect(link).toHaveText(`Try “${TITLE}” first`);
  await link.click();
  const room = page.getByTestId('try-room');
  await expect(room).toHaveAttribute('data-chapter', first.chapter);
  await expect(room.locator('#try-title')).toHaveText(TITLE);
  await page.keyboard.press('Escape');
  await expect(room).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('an app that never answers: never built, the watch says why with Try again, nothing to try or approve, main does not move; Try again runs it again, and once it answers it is built, tried and approved', async ({ page }) => {
  const errors = watchErrors(page);
  const board = await open({ show: APP, env: { KEEL_E2E_APP_SILENT: '1', KEEL_E2E_APP_WAIT_MS: '1500' } });
  await openBoard(page, board.url);
  const main = commitOf(board.repo, 'main')!;
  const blueprint = await toBlueprint(page, IDEA);
  await blueprint.getByRole('button', { name: 'Build this' }).click();

  const watch = page.getByTestId('watch');
  await expect(watch).toHaveAttribute('data-state', 'stopped', { timeout: 40_000 });
  await expect(page.getByTestId('watch-status')).toHaveText('Stopped. Every part is built, and the app did not answer when the builder started it. See why in the feed');
  await expect(page.locator('[data-testid="track"] > li[data-state="built"]')).toHaveCount(4);
  await expect(page.getByTestId('chapter-state'), 'never “built”').toHaveText('building');
  const again = page.getByTestId('watch-again');
  await expect(again).toHaveText('Try again');
  await expect(page.getByTestId('watch-try')).toHaveCount(0);
  await expect(watch.getByTestId('approve')).toHaveCount(0);
  const stopped = page.getByTestId('feed').locator('.feed__line[data-kind="problem"]').last().locator('.feed__text');
  await expect(stopped).toHaveText(/^The build of "One engine that takes many requests" stopped: The app does not start: `node app\.mjs`\. The app did not answer on port \d+ within 1\.5 s\. It printed: "the engine waits for its database"\. 4 of 4 parts are built\. Press Try again to go on\.$/);
  if (J3_SHOTS) await page.screenshot({ path: `${J3_SHOTS}/stopped-app-try-again.png` });

  await openStory(page);
  const c = card(page, TITLE);
  await expect(c.getByTestId('idea-state')).toHaveText('every part built, and the app did not answer');
  await expect(c.getByTestId('idea-try')).toHaveCount(0);
  await expect(c.getByTestId('approve-press')).toHaveCount(0);
  expect(readLog(board.repo).filter((e) => e.type === 'build.proved')).toEqual([]);
  expect(commitOf(board.repo, 'main'), 'main has not moved').toBe(main);

  // Try again: the run starts again, straight at the app. This time it answers.
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await again.click();
  await built(page);
  const branch = `board/${TITLE.toLowerCase().replace(/ /g, '-')}`;
  expect(readLog(board.repo).filter((e) => e.type === 'build.proved').map((e) => e.by)).toEqual(['system']);
  expect(readLog(board.repo).filter((e) => e.type === 'part.state' && e.state === 'built')).toHaveLength(4);
  expect(git(board.repo, 'log', '--format=%s', '-2', branch).split('\n')).toEqual([`${TITLE}: the brief, with the result`, 'The app listens on PORT']);

  await page.getByTestId('watch-try').click();
  await page.getByTestId('try-press').click();
  const room = page.getByTestId('try-room');
  await expect(room).toHaveAttribute('data-state', 'on', { timeout: 30_000 });
  await expect(page.frameLocator('[data-testid="try-frame"]').getByRole('heading', { name: 'The engine answers' })).toBeVisible({ timeout: 15_000 });
  const tip = commitOf(board.repo, branch)!;
  await room.getByTestId('approve-press').click();
  await expect(room.getByTestId('approve')).toHaveAttribute('data-state', 'merged', { timeout: 20_000 });
  expect(commitOf(board.repo, 'main')).toBe(tip);
  expect(errors).toEqual([]);
});

test('a running app after the try room is closed and after a reload: the watch and the Story say it runs, one press opens the room on the same app, and the delete dialog says it is stopped', async ({ page }) => {
  const errors = watchErrors(page);
  const board = await open({ show: APP });
  await openBoard(page, board.url);
  await buildIdea(page, IDEA);
  const tryIt = page.getByTestId('watch-try');
  await tryIt.click();
  await page.getByTestId('try-press').click();
  const room = page.getByTestId('try-room');
  await expect(room).toHaveAttribute('data-state', 'on', { timeout: 30_000 });
  const url = (await page.getByTestId('try-words').textContent())!.match(/Running at (http:\/\/127\.0\.0\.1:\d+\/)/)![1]!;
  const printed = page.getByTestId('try-printed');
  await printed.locator('summary').click();
  await expect(printed.locator('pre')).toContainText(`the engine listens on 127.0.0.1:${new URL(url).port} as pid `);
  const pid = Number(/as pid (\d+)/.exec(await printed.locator('pre').innerText())![1]);
  expect(alive(pid)).toBe(true);
  await page.getByTestId('try-close').click();
  await expect(room).toHaveCount(0);

  // Closed, it still runs, and the board says so wherever it offers Try it.
  await expect(tryIt).toHaveText('Open the running app');
  await expect(tryIt).toHaveAttribute('data-running', 'app');
  await openStory(page);
  const c = card(page, TITLE);
  await expect(c.getByTestId('idea-state')).toHaveText('built: its app is running');
  await expect(c.getByTestId('idea-try')).toHaveText('Open the running app');
  await expect(c.getByTestId('idea-try')).toHaveAttribute('data-running', 'app');
  if (J3_SHOTS) await page.screenshot({ path: `${J3_SHOTS}/story-running-app.png` });

  // After a reload too.
  await page.reload();
  await expect(page.getByTestId('board')).toBeVisible();
  await openStory(page);
  await expect(c.getByTestId('idea-try')).toHaveText('Open the running app');
  await page.getByRole('button', { name: 'Board', exact: true }).click();
  await expect(tryIt).toHaveText('Open the running app');
  await expect(tryIt).toHaveAttribute('data-running', 'app');

  // One press opens the room on the app that runs: the same process, at the same address.
  await tryIt.click();
  await expect(room).toHaveAttribute('data-state', 'on');
  await expect(page.getByTestId('try-words')).toContainText(`Running at ${url}`);
  await expect(page.getByTestId('try-frame')).toHaveAttribute('src', url);
  await expect(page.frameLocator('[data-testid="try-frame"]').getByRole('heading', { name: 'The engine answers' })).toBeVisible({ timeout: 15_000 });
  await printed.locator('summary').click();
  const out = await printed.locator('pre').innerText();
  expect(out.match(/the engine listens/g), 'it was started once').toHaveLength(1);
  expect(out).toContain(`as pid ${pid}`);
  expect(alive(pid)).toBe(true);
  await page.getByTestId('try-close').click();

  // Delete says the running app is stopped, and it is.
  await openStory(page);
  await c.getByTestId('canvas-delete').click();
  const dialog = page.getByTestId('confirm-delete');
  await expect(dialog).toContainText(`The app of “${TITLE}” is running: it is stopped.`);
  await page.getByTestId('confirm-delete-press').click();
  await expect(c).toHaveCount(0);
  await expect.poll(() => alive(pid), { timeout: 15_000 }).toBe(false);
  await expect.poll(() => answers(url), { timeout: 10_000 }).toBe(false);
  expect(errors).toEqual([]);
});
