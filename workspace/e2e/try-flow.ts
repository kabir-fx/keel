import { expect, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BUILDER, PLANNER, startBoard, type RunningBoard } from './board-server';
import { fitAll, settle } from './build-flow';

/**
 * The way through "try it, approve it, merge it" on the real board server, for the specs that
 * walk it: a repository with a bare repository as its remote, the stand-in planner, which names
 * the blueprint's setup and show, and the scripted builder, which makes each canvas's branch,
 * runs the show for real, joins the home branch in and takes a build away.
 */

export const APP = { kind: 'app', run: 'node app.mjs' } as const;
export const BROKEN = { kind: 'app', run: 'node broken.mjs' } as const;
export const TERMINAL = { kind: 'terminal', run: 'node greet.mjs' } as const;
export const PAGE = { kind: 'page' } as const;
export const SETUP = 'mkdir -p .deps && echo ready > .deps/ok';

/** Run git in `dir` as a test user, and give what it printed, trimmed. */
export const git = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Keel test', '-c', 'user.email=test@keel.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: dir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();

export const gitOk = (dir: string, ...args: string[]): boolean => {
  try {
    git(dir, ...args);
    return true;
  } catch {
    return false;
  }
};

/** Where the bare remote and the other clone live: beside the repository, so `stop` takes them away. */
export const remoteOf = (repo: string): string => join(dirname(repo), 'remote.git');
export const otherOf = (repo: string): string => join(dirname(repo), 'other');

/** Make a bare repository beside the folder, push main to it, and let main follow it. */
export function addRemote(repo: string): void {
  const remote = remoteOf(repo);
  git(dirname(repo), 'init', '-q', '--bare', '-b', 'main', remote);
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
}

/** Someone else commits these files to the remote's main. Returns the commit. */
export function remoteMoves(repo: string, files: Record<string, string>, message = 'From elsewhere'): string {
  const other = otherOf(repo);
  if (!gitOk(other, 'rev-parse', '--git-dir')) git(dirname(repo), 'clone', '-q', remoteOf(repo), other);
  git(other, 'pull', '-q', '--ff-only');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(other, name)), { recursive: true });
    writeFileSync(join(other, name), text);
  }
  git(other, 'add', '--', ...Object.keys(files));
  git(other, 'commit', '-q', '-m', message);
  git(other, 'push', '-q', 'origin', 'main');
  return git(other, 'rev-parse', 'HEAD');
}

/** The commit a ref names, or undefined. */
export const commitOf = (dir: string, ref: string): string | undefined => {
  try {
    return git(dir, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
  } catch {
    return undefined;
  }
};

export const branches = (repo: string): string[] =>
  git(repo, 'branch', '--format=%(refname:short)')
    .split('\n')
    .filter(Boolean);

/** A board on a repository with a remote, the planner, and the scripted builder. */
export function tryBoard(opts: { show?: object; setup?: string; remote?: boolean; prepare?: (repo: string) => void; env?: Record<string, string>; step?: number } = {}): Promise<RunningBoard> {
  return startBoard({
    link: `script:${PLANNER}`,
    builder: BUILDER,
    git: true,
    linkOptions: { 'builder-step-ms': String(opts.step ?? 150) },
    env: {
      ...(opts.show ? { KEEL_E2E_SHOW: JSON.stringify(opts.show) } : {}),
      ...(opts.setup ? { KEEL_E2E_SETUP: opts.setup } : {}),
      ...opts.env,
    },
    prepare: (repo) => {
      if (opts.remote !== false) addRemote(repo);
      opts.prepare?.(repo);
    },
  });
}

/** Open the board, as the owner, and wait until the agent listens. */
export async function openBoard(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('presence')).toHaveAttribute('data-state', 'listening');
  await page.evaluate(() => document.fonts.ready);
}

/** Write a note where the board is clear. */
export async function writeNote(page: Page, text: string, at: [number, number] = [220, 260]): Promise<void> {
  await page.getByRole('button', { name: 'Write a note' }).click();
  await page.mouse.click(at[0], at[1]);
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

/** Draw a lasso around two boxes. */
async function lassoAround(page: Page, a: Locator, b: Locator): Promise<void> {
  const [x, y] = [(await a.boundingBox())!, (await b.boundingBox())!];
  const [l, t] = [Math.min(x.x, y.x) - 24, Math.min(x.y, y.y) - 24];
  const [r, btm] = [Math.max(x.x + x.width, y.x + y.width) + 24, Math.max(x.y + x.height, y.y + y.height) + 24];
  await page.keyboard.press('l');
  const loop: Array<[number, number]> = [];
  for (let i = 0; i <= 10; i++) loop.push([l + ((r - l) * i) / 10, t]);
  for (let i = 1; i <= 10; i++) loop.push([r, t + ((btm - t) * i) / 10]);
  for (let i = 1; i <= 10; i++) loop.push([r - ((r - l) * i) / 10, btm]);
  for (let i = 1; i <= 9; i++) loop.push([l, btm - ((btm - t) * i) / 10]);
  await page.mouse.move(loop[0]![0], loop[0]![1]);
  await page.mouse.down();
  for (const [px, py] of loop.slice(1)) await page.mouse.move(px, py);
  await page.mouse.up();
}

/**
 * From a note to the blueprint, on the canvas in view: the note, the agent's model, a lasso
 * around both, Solidify. Returns the newest blueprint, with "Build this" not yet pressed.
 */
export async function toBlueprint(page: Page, text: string, at?: [number, number]): Promise<Locator> {
  const models = page.locator('[data-item^="model-"]');
  const before = await models.count();
  await writeNote(page, text, at);
  await expect(models).toHaveCount(before + 1, { timeout: 15_000 });
  const model = models.last();
  await settle(page);
  await fitAll(page);
  const note = page.locator('[data-item][data-kind="note"]', { hasText: text });
  const blueprints = page.locator('[data-item^="blueprint-"]');
  const had = await blueprints.count();
  await lassoAround(page, note, model);
  const solidify = page.locator('[data-tool="solidify"]');
  await expect(solidify).toBeEnabled();
  await solidify.click();
  await expect(page.getByTestId('chapter-state')).toHaveText('solid');
  await expect(blueprints).toHaveCount(had + 1, { timeout: 15_000 });
  await settle(page);
  await fitAll(page);
  return blueprints.last();
}

/** From a note to a finished build, on the canvas in view. */
export async function buildIdea(page: Page, text: string, at?: [number, number]): Promise<void> {
  const blueprint = await toBlueprint(page, text, at);
  await blueprint.getByRole('button', { name: 'Build this' }).click();
  await expect(page.getByTestId('chapter-state')).toHaveText('building');
  await built(page);
}

/**
 * Wait until the build panel says every part is built and the builder's run has ended: Approve
 * is ready, so the branch has the builder's last commit.
 */
export async function built(page: Page): Promise<void> {
  await expect(page.getByTestId('watch')).toHaveAttribute('data-state', 'built', { timeout: 40_000 });
  await expect(page.getByTestId('chapter-state')).toHaveText('built');
  await expect(page.getByTestId('watch').getByTestId('approve')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
}

/** The builder's copy of the canvas's branch: the one worktree of the repository that is not the folder. */
export const copyDir = (repo: string): string =>
  git(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length))
    .find((d) => d.includes('copy-'))!;

/** The subject of a commit. */
export const subjectOf = (repo: string, ref: string): string => git(repo, 'log', '-1', '--format=%s', ref);

/** Post drafts as the owner, with the token the page holds, as a script on the owner's machine could. */
export async function postAsOwner(page: Page, ...drafts: object[]): Promise<{ status: number; reason?: string }> {
  const token = await page.evaluate(() => localStorage.getItem('keel.board.token'));
  const r = await fetch(new URL('/api/events', page.url()), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ drafts }) });
  const body = (await r.json()) as { reason?: string };
  return { status: r.status, ...(body.reason !== undefined ? { reason: body.reason } : {}) };
}

export async function openStory(page: Page): Promise<Locator> {
  const story = page.getByTestId('story');
  if (!(await story.isVisible())) await page.getByRole('button', { name: 'Story', exact: true }).click();
  await expect(story).toBeVisible();
  return story;
}

/** The Story's card of the canvas whose name is given. */
export const card = (page: Page, name: string): Locator => page.getByTestId('story').locator('article[data-canvas]', { has: page.locator('h3', { hasText: name }) });
