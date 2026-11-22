import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appIsBuilt, type RunningBoard } from './board-server';
import { readLog, watchErrors } from './build-flow';
import { APP, TERMINAL, branches, buildIdea, card, commitOf, git, gitOk, openBoard, openStory, postAsOwner, remoteMoves, remoteOf, subjectOf, toBlueprint, tryBoard } from './try-flow';

/**
 * Approve and Push (record 0014), on the real board server: a repository whose main follows a
 * bare repository, the scripted builder on a branch of the canvas's own, and git looked at after
 * each press. The home branch only moves by fast-forward, to a commit the check passed on, and
 * only on the owner's press. The home line on top of the Story says how main stands at open.
 *
 * Needs a build first: `npm run build` from workspace/. `npm run e2e` does both.
 */

const SHOTS = process.env.KEEL_J2_SHOTS;
const IDEA = 'One engine that takes many requests at once';
const TITLE = 'One engine that takes many requests';
const BRANCH = 'board/one-engine-that-takes-many-requests';

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

/** Keep every state and busy line the Approve block shows, as it changes, however briefly. */
async function recordApprove(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __approve: string[] };
    w.__approve = [];
    const note = () => {
      const a = document.querySelector('[data-testid="approve"]');
      const busy = document.querySelector('[data-testid="approve-busy"]')?.textContent;
      const line = `${a?.getAttribute('data-state') ?? '-'}${busy ? `: ${busy}` : ''}`;
      if (w.__approve[w.__approve.length - 1] !== line) w.__approve.push(line);
    };
    new MutationObserver(note).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  });
}
const approveSeen = (page: Page) => page.evaluate(() => (window as unknown as { __approve: string[] }).__approve);

/** Does `ancestor` lie in the history of `of`? */
const holds = (repo: string, of: string, ancestor: string) => gitOk(repo, 'merge-base', '--is-ancestor', ancestor, of);

test('Approve with main level: the busy words, then merged; the Story says so; main holds the commits and the branch is gone', async ({ page }) => {
  const errors = watchErrors(page);
  await recordApprove(page);
  const board = await open();
  await openBoard(page, board.url);
  await buildIdea(page, IDEA);
  const before = commitOf(board.repo, 'main')!;
  const tip = commitOf(board.repo, BRANCH)!;

  await page.getByTestId('approve-press').click();
  await expect(page.getByTestId('approve')).toHaveAttribute('data-state', 'merged', { timeout: 20_000 });
  expect(await approveSeen(page)).toContain(`busy: Merging ${BRANCH} into main.`);
  const merged = page.getByTestId('merged-line');
  await expect(merged).toContainText(`Merged into main at ${tip.slice(0, 7)} ·`);

  // git: main moved to the build by fast-forward, the folder has its files, and the branch went.
  expect(commitOf(board.repo, 'main')).toBe(tip);
  expect(subjectOf(board.repo, 'main'), 'main is at the builder\'s last commit').toBe(`${TITLE}: the brief, with the result`);
  expect(git(board.repo, 'rev-list', '--count', `${before}..main`)).toBe('5');
  expect(git(board.repo, 'rev-list', '--merges', '--count', `${before}..main`), 'no merge commit on main').toBe('0');
  expect(git(board.repo, 'show', 'main:parts.txt').trim().split('\n')).toHaveLength(4);
  expect(git(board.repo, 'status', '--porcelain', '--', 'parts.txt'), 'the owner folder is on main and has the files').toBe('');
  // The board says merged, then takes the branch away: the branch goes a moment after the words.
  await expect.poll(() => branches(board.repo), { timeout: 15_000 }).toEqual(['main']);
  const ev = readLog(board.repo).find((e) => e.type === 'canvas.merged') as unknown as { by: string; commit: string; into: string };
  expect(ev).toMatchObject({ by: 'system', into: 'main' });
  expect(tip.startsWith(ev.commit) || ev.commit.startsWith(tip.slice(0, 7))).toBe(true);

  // The Story: the card says merged into main.
  await openStory(page);
  const c = card(page, TITLE);
  await expect(c.getByTestId('idea-state')).toHaveText('merged into main');
  await expect(c.getByTestId('idea-try')).toHaveCount(0);
  await expect(c.getByTestId('idea-branch')).toHaveText(`in main at ${tip.slice(0, 7)}`);
  await expect(page.getByTestId('home-words')).toHaveText(`main · ${tip.slice(0, 7)} · 5 commits to push to origin`);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/story-after-merge.png` });
  expect(errors).toEqual([]);
});

test('Approve after main moved on the remote with no conflict: joined in, checked, merged in one press', async ({ page }) => {
  const errors = watchErrors(page);
  await recordApprove(page);
  const board = await open();
  await openBoard(page, board.url);
  await buildIdea(page, IDEA);
  const theirs = remoteMoves(board.repo, { 'NOTES.md': 'from someone else\n' });
  const tip = commitOf(board.repo, BRANCH)!;

  await page.getByTestId('approve-press').click();
  await expect(page.getByTestId('approve')).toHaveAttribute('data-state', 'merged', { timeout: 30_000 });
  const seen = await approveSeen(page);
  expect(seen).toContain(`busy: main has moved since this build began. Joining its new commits into ${BRANCH} and running the check again.`);

  const main = commitOf(board.repo, 'main')!;
  expect(holds(board.repo, main, theirs), 'main has the remote commit').toBe(true);
  expect(holds(board.repo, main, tip), 'and the build').toBe(true);
  expect(git(board.repo, 'show', 'main:NOTES.md')).toBe('from someone else');
  // The board says merged, then takes the branch away: the branch goes a moment after the words.
  await expect.poll(() => branches(board.repo), { timeout: 15_000 }).toEqual(['main']);
  expect(errors).toEqual([]);
});

test('Approve after main moved with a conflict: the builder joins the two, the page says try it again, and main takes the build only on the second press', async ({ page }) => {
  const errors = watchErrors(page);
  const board = await open();
  await openBoard(page, board.url);
  await buildIdea(page, IDEA);
  const theirs = remoteMoves(board.repo, { 'parts.txt': 'elsewhere: a part from someone else\n' });
  const tip = commitOf(board.repo, BRANCH)!;

  await page.getByTestId('approve-press').click();
  const approve = page.getByTestId('approve');
  await expect(approve).toHaveAttribute('data-state', 'again', { timeout: 30_000 });
  await expect(page.getByTestId('approve-again')).toHaveText(
    'Not merged. main had changed the same places as this idea. The builder joined the two and the checks passed. What you tried has changed: try it again, then approve again.',
  );
  // main came level with the remote, and has not taken the build.
  const main = commitOf(board.repo, 'main')!;
  expect(main).toBe(theirs);
  const joined = commitOf(board.repo, BRANCH)!;
  expect(joined).not.toBe(tip);
  expect(holds(board.repo, joined, theirs), 'the branch holds the remote commit now').toBe(true);
  expect(git(board.repo, 'show', `${BRANCH}:parts.txt`)).toContain('elsewhere: a part from someone else');
  expect(git(board.repo, 'show', `${BRANCH}:parts.txt`)).not.toContain('<<<<<<<');
  await expect(page.getByTestId('approve-press')).toBeEnabled();

  // The second press merges what was joined.
  await page.getByTestId('approve-press').click();
  await expect(approve).toHaveAttribute('data-state', 'merged', { timeout: 30_000 });
  expect(commitOf(board.repo, 'main')).toBe(joined);
  expect(errors).toEqual([]);
});

test('Approve with the owner’s file in the way: the file is named and nothing moved', async ({ page }) => {
  const errors = watchErrors(page);
  const board = await open();
  await openBoard(page, board.url);
  await buildIdea(page, IDEA);
  const main = commitOf(board.repo, 'main')!;
  const tip = commitOf(board.repo, BRANCH)!;
  writeFileSync(join(board.repo, 'parts.txt'), 'my own notes, not committed\n');

  await page.getByTestId('approve-press').click();
  const approve = page.getByTestId('approve');
  await expect(approve).toHaveAttribute('data-state', 'again', { timeout: 30_000 });
  await expect(page.getByTestId('approve-again')).toHaveText('Not merged. Your changes in parts.txt are in the way of main. Commit or stash them, then approve again.');
  expect(commitOf(board.repo, 'main')).toBe(main);
  expect(commitOf(board.repo, BRANCH)).toBe(tip);
  expect(git(board.repo, 'show', ':0:README.md').length).toBeGreaterThan(0);
  expect((await import('node:fs')).readFileSync(join(board.repo, 'parts.txt'), 'utf8')).toBe('my own notes, not committed\n');
  expect(errors).toEqual([]);
});

test('Push: the home line says commits to push, the press pushes, the remote has them, and the line goes quiet', async ({ page }) => {
  const errors = watchErrors(page);
  const board = await open();
  await openBoard(page, board.url);
  await buildIdea(page, IDEA);
  await page.getByTestId('approve-press').click();
  await expect(page.getByTestId('approve')).toHaveAttribute('data-state', 'merged', { timeout: 20_000 });
  const main = commitOf(board.repo, 'main')!;
  const remote = remoteOf(board.repo);
  expect(commitOf(remote, 'main')).not.toBe(main);

  await openStory(page);
  const line = page.getByTestId('home-line');
  await expect(page.getByTestId('home-words')).toHaveText(`main · ${main.slice(0, 7)} · 5 commits to push to origin`);
  const push = page.getByTestId('home-push');
  await expect(push).toHaveText('Push main to origin');
  await push.click();
  await expect(page.getByTestId('home-said')).toBeVisible({ timeout: 30_000 });
  expect(commitOf(remote, 'main'), 'the bare remote has the commit').toBe(main);
  await expect(page.getByTestId('home-words')).toHaveText(`main · ${main.slice(0, 7)} · level with origin`);
  await expect(line).toHaveAttribute('data-tone', 'quiet');
  await expect(push).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a push the remote refuses: the plain sentence, git’s line under the fold, main reads as diverged with the git pull sentence, and nothing is forced', async ({ page }) => {
  const errors = watchErrors(page);
  const board = await open();
  await openBoard(page, board.url);
  await buildIdea(page, IDEA);
  await page.getByTestId('approve-press').click();
  await expect(page.getByTestId('approve')).toHaveAttribute('data-state', 'merged', { timeout: 20_000 });
  const main = commitOf(board.repo, 'main')!;
  // Someone else pushes first.
  const theirs = remoteMoves(board.repo, { 'NOTES.md': 'from someone else\n' });

  await openStory(page);
  await expect(page.getByTestId('home-words')).toHaveText(`main · ${main.slice(0, 7)} · 5 commits to push to origin`);
  await page.getByTestId('home-push').click();
  const said = page.getByTestId('home-said');
  await expect(said.locator('> span')).toHaveText('origin has commits that main here does not have, so it did not take the push.', { timeout: 30_000 });
  const more = page.getByTestId('home-said-more');
  await expect(more.locator('summary')).toHaveText('What git said');
  await expect(more.locator('pre'), 'git’s own line is folded away').toBeHidden();
  await more.locator('summary').click();
  await expect(more.locator('pre')).toHaveText('! [rejected] main -> main (fetch first)');

  // The board read origin again: the two have both moved, and the line says the one command.
  const line = page.getByTestId('home-line');
  await expect(line).toHaveAttribute('data-sync', 'diverged');
  await expect(line).toHaveAttribute('data-tone', 'needs');
  await expect(page.getByTestId('home-words')).toHaveText("main and origin/main have both moved, so the board did not pull. Run git pull in the board's folder, then look again.");
  await expect(page.getByTestId('home-look')).toHaveText('Look at origin again');
  await expect(page.getByTestId('home-push')).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/push-refused.png` });

  // Nothing was forced: origin keeps the other push, and main here keeps the merge.
  expect(commitOf(remoteOf(board.repo), 'main')).toBe(theirs);
  expect(commitOf(board.repo, 'main')).toBe(main);
  expect(errors).toEqual([]);
});

test.describe('between the last part and the end of the builder’s run', () => {
  const HELD = 'The builder is finishing: its last commit is not in yet.';
  const APPROVE_WHILE_BUILDING = 'The builder has not finished on this canvas yet. Approve it when the build says done.';
  /** Let the scripted builder take its last step. */
  const go = (board: RunningBoard) => writeFileSync(join(dirname(board.repo), 'last-step.go'), '');
  const startOf = (repo: string) => readLog(repo).find((e) => e.type === 'build.start') as unknown as { chapter: string };
  const canvasOf = async (page: Page) => (await card(page, TITLE).getAttribute('data-canvas'))!;

  test('a build with no app: built, and held until the builder’s last commit is in; an Approve over the API is refused and main does not move; then Approve merges that last commit', async ({ page }) => {
    const errors = watchErrors(page);
    const board = await open({ show: TERMINAL, env: { KEEL_E2E_HOLD_LAST_STEP: '1' } });
    await openBoard(page, board.url);
    const main = commitOf(board.repo, 'main')!;
    const blueprint = await toBlueprint(page, IDEA);
    await blueprint.getByRole('button', { name: 'Build this' }).click();

    // Every part is built, so the idea is: the builder's run has not ended.
    const watch = page.getByTestId('watch');
    await expect(watch).toHaveAttribute('data-state', 'built', { timeout: 40_000 });
    await expect(page.getByTestId('chapter-state')).toHaveText('built');
    await expect(watch.getByTestId('approve')).toHaveAttribute('data-state', 'busy');
    await expect(watch.getByTestId('approve-busy')).toHaveText(HELD);
    await expect(watch.getByTestId('approve-press')).toBeDisabled();
    const tryIt = page.getByTestId('watch-try');
    await expect(tryIt).toHaveText('Try it');
    await expect(tryIt).toBeDisabled();
    await expect(tryIt).toHaveAttribute('data-tip', HELD);
    await openStory(page);
    const c = card(page, TITLE);
    await expect(c.getByTestId('idea-try')).toBeDisabled();
    await expect(c.getByTestId('approve-busy')).toHaveText(HELD);
    await expect(c.getByTestId('approve-press')).toBeDisabled();

    // The server refuses what the page holds back.
    expect(await postAsOwner(page, { type: 'canvas.approve', canvas: await canvasOf(page) })).toEqual({ status: 422, reason: APPROVE_WHILE_BUILDING });
    const token = await page.evaluate(() => localStorage.getItem('keel.board.token'));
    const tried = await fetch(new URL('/api/show', page.url()), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'start', chapter: startOf(board.repo).chapter, run: TERMINAL.run }) });
    expect([tried.status, ((await tried.json()) as { reason?: string }).reason]).toEqual([409, 'The builder has not finished on this canvas yet. Try it when the build says done.']);
    expect(subjectOf(board.repo, BRANCH)).toBe('Build Reply stream');
    expect(commitOf(board.repo, 'main'), 'main has not moved').toBe(main);
    expect(readLog(board.repo).filter((e) => e.type === 'canvas.approve')).toEqual([]);

    // The run ends with the brief and its result.
    go(board);
    await expect(c.getByTestId('approve')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
    await expect(c.getByTestId('idea-try')).toBeEnabled();
    const tip = commitOf(board.repo, BRANCH)!;
    expect(subjectOf(board.repo, BRANCH)).toBe(`${TITLE}: the brief, with the result`);
    await c.getByTestId('approve-press').click();
    await expect(c.getByTestId('idea-state')).toHaveText('merged into main', { timeout: 20_000 });
    expect(commitOf(board.repo, 'main'), 'main is at the builder’s last commit').toBe(tip);
    expect(errors).toEqual([]);
  });

  test('an app: building with every part built until it has started and answered; nothing to try or approve, an Approve over the API is refused and main does not move; then it is built, and Approve merges the builder’s last commit', async ({ page }) => {
    const errors = watchErrors(page);
    const board = await open({ show: APP, env: { KEEL_E2E_HOLD_LAST_STEP: '1' } });
    await openBoard(page, board.url);
    const main = commitOf(board.repo, 'main')!;
    const blueprint = await toBlueprint(page, IDEA);
    await blueprint.getByRole('button', { name: 'Build this' }).click();

    const watch = page.getByTestId('watch');
    await expect(page.locator('[data-testid="track"] > li[data-state="built"]')).toHaveCount(4, { timeout: 40_000 });
    await expect(page.getByTestId('watch-status')).toHaveText('Every part is built. The builder is starting the app once, as you will try it, to see that it answers.');
    await expect(watch).toHaveAttribute('data-state', 'running');
    await expect(page.getByTestId('chapter-state')).toHaveText('building');
    await expect(page.getByTestId('watch-try')).toHaveCount(0);
    await expect(watch.getByTestId('approve')).toHaveCount(0);
    await openStory(page);
    const c = card(page, TITLE);
    await expect(c.getByTestId('idea-state')).toHaveText('every part built: starting the app once');
    await expect(c.getByTestId('idea-try')).toHaveCount(0);
    await expect(c.getByTestId('approve-press')).toHaveCount(0);

    // The idea is still building, so the board's own rule refuses it before the server's.
    const { chapter } = startOf(board.repo);
    expect(await postAsOwner(page, { type: 'canvas.approve', canvas: await canvasOf(page) })).toEqual({ status: 422, reason: `"${TITLE}" is still building on this canvas, and every idea on a canvas shares its branch. Approve when it is built.` });
    expect(readLog(board.repo).filter((e) => e.type === 'build.proved' || e.type === 'canvas.approve')).toEqual([]);
    expect(commitOf(board.repo, 'main'), 'main has not moved').toBe(main);

    go(board);
    await expect(c.getByTestId('approve')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    await expect(c.getByTestId('idea-state')).toHaveText('built: try it');
    expect(readLog(board.repo).filter((e) => e.type === 'build.proved').map((e) => [e.by, (e as unknown as { chapter: string }).chapter])).toEqual([['system', chapter]]);
    const tip = commitOf(board.repo, BRANCH)!;
    expect(subjectOf(board.repo, BRANCH)).toBe(`${TITLE}: the brief, with the result`);
    await c.getByTestId('approve-press').click();
    await expect(c.getByTestId('idea-state')).toHaveText('merged into main', { timeout: 20_000 });
    expect(commitOf(board.repo, 'main'), 'main is at the builder’s last commit').toBe(tip);
    expect(errors).toEqual([]);
  });
});

test.describe('the home line at open', () => {
  const homeAtOpen = async (page: Page, board: RunningBoard) => {
    await openBoard(page, board.url);
    await openStory(page);
    return page.getByTestId('home-words');
  };

  test('level with its remote', async ({ page }) => {
    const board = await open();
    const words = await homeAtOpen(page, board);
    await expect(words).toHaveText(`main · ${commitOf(board.repo, 'main')!.slice(0, 7)} · level with origin`);
    await expect(page.getByTestId('home-look')).toHaveText('Look at origin again');
    await expect(page.getByTestId('home-push')).toHaveCount(0);
  });

  test('ahead: a commit to push', async ({ page }) => {
    const board = await open({
      prepare: (repo) => {
        writeFileSync(join(repo, 'local.txt'), 'mine\n');
        git(repo, 'add', 'local.txt');
        git(repo, 'commit', '-q', '-m', 'Mine, not pushed');
      },
    });
    const words = await homeAtOpen(page, board);
    await expect(words).toHaveText(`main · ${commitOf(board.repo, 'main')!.slice(0, 7)} · 1 commit to push to origin`);
    await expect(page.getByTestId('home-push')).toHaveText('Push main to origin');
  });

  test('behind, with the owner’s files in the way: named, and nothing moved', async ({ page }) => {
    let main = '';
    const board = await open({
      prepare: (repo) => {
        main = commitOf(repo, 'main')!;
        remoteMoves(repo, { 'README.md': '# demo, from elsewhere\n' });
        writeFileSync(join(repo, 'README.md'), '# demo, my own edit\n');
      },
    });
    const words = await homeAtOpen(page, board);
    await expect(page.getByTestId('home-line')).toHaveAttribute('data-tone', 'needs');
    await expect(words).toContainText('Your changes in README.md are in the way: commit or stash them.');
    await expect(words).toHaveText('origin has one new commit. Your changes in README.md are in the way: commit or stash them.');
    expect(commitOf(board.repo, 'main')).toBe(main);
  });

  test('unreachable: a remote that does not answer', async ({ page }) => {
    const board = await open({ prepare: (repo) => git(repo, 'remote', 'set-url', 'origin', 'http://127.0.0.1:9/nobody.git') });
    const words = await homeAtOpen(page, board);
    await expect(words).toHaveText(`origin did not answer. Building from main as it is here, at ${commitOf(board.repo, 'main')!.slice(0, 7)}.`);
    await expect(page.getByTestId('home-line')).toHaveAttribute('data-tone', 'soft');
  });

  test('the Board view says it once when main is behind with a file in the way, in the server’s words; it leads to the Story, and can be dismissed', async ({ page }) => {
    const WORDS = 'origin has one new commit. Your changes in README.md are in the way: commit or stash them.';
    const board = await open({
      prepare: (repo) => {
        remoteMoves(repo, { 'README.md': '# demo, from elsewhere\n' });
        writeFileSync(join(repo, 'README.md'), '# demo, my own edit\n');
      },
    });
    await openBoard(page, board.url);
    const notice = page.getByTestId('home-notice');
    await expect(notice.locator('> span').first()).toHaveText(`Home branch. ${WORDS}`);
    await page.getByTestId('home-notice-show').click();
    await expect(page.getByTestId('story')).toBeVisible();
    await expect(page.getByTestId('home-words')).toHaveText(WORDS);
    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(notice, 'said once').toHaveCount(0);

    await page.reload();
    await expect(notice).toBeVisible();
    await page.getByTestId('home-notice-dismiss').click();
    await expect(notice).toHaveCount(0);
    await expect(page.getByTestId('story')).toHaveCount(0);
  });

  test('the Board view says nothing of a main that is level', async ({ page }) => {
    const board = await open();
    const words = await homeAtOpen(page, board);
    await expect(words).toHaveText(`main · ${commitOf(board.repo, 'main')!.slice(0, 7)} · level with origin`);
    await page.getByRole('button', { name: 'Board', exact: true }).click();
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByTestId('home-notice')).toHaveCount(0);
  });

  test('no remote', async ({ page }) => {
    const board = await open({ remote: false });
    const words = await homeAtOpen(page, board);
    await expect(words).toHaveText(`main · ${commitOf(board.repo, 'main')!.slice(0, 7)} · follows no remote`);
    await expect(page.getByTestId('home-look')).toHaveCount(0);
  });
});
