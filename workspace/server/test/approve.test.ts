import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Actor, BuilderContext, BuildJob, RefreshRequest, ShowPlan } from '@keel/protocol';
import { ROUTES } from '@keel/protocol';
import type { RunningServer, ServerOptions } from '../src/server';
import { APPROVE_WHILE_BUILDING, TRY_WHILE_BUILDING, deleteWhileMerging, startServer } from '../src/server';
import { readPrivate } from '../src/private';
import { run } from '../src/cli';
import { Client, call, tempRepo, until } from './helpers';
import type { Fixture } from './gitfix';
import { branchWith, commitFiles, gitIn, remoteMoves, withRemote } from './gitfix';

/**
 * Approve (plan 5.4) and delete (5.6), by canvas, with real repositories and a scripted
 * builder: the home branch moves by fast-forward only, to a commit every agreed check passed
 * on, and nothing of the owner's is stashed or overwritten.
 */

const FAKE = fileURLToPath(new URL('./fake-builder.mjs', import.meta.url));

interface Fake {
  ctx: BuilderContext;
  jobs: BuildJob[];
  calls: string[];
  shows: Array<{ stopped: boolean }>;
  refreshes: RefreshRequest[];
  refreshWith: unknown;
  discards: Array<{ canvas: string; branch: boolean }>;
  discardWith?: (req: { canvas: string; branch: boolean }) => unknown;
  pauseEnds: boolean;
  current?: unknown;
  finish(result?: unknown): void;
  post(drafts: unknown, as?: 'system' | 'agent'): Promise<unknown>;
}

let fakes: Fake[];
beforeAll(async () => {
  ({ fakes } = (await import(pathToFileURL(FAKE).href)) as { fakes: Fake[] });
});

const running: RunningServer[] = [];
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
});

async function start(repoDir: string, opts: Partial<ServerOptions> = {}): Promise<{ s: RunningServer; fake: Fake }> {
  const n = fakes.length;
  const s = await startServer({ port: 0, appDir: path.join(repoDir, 'no-app'), log: () => {}, builder: FAKE, ...opts, repoDir });
  running.push(s);
  return { s, fake: fakes.length > n ? fakes.at(-1)! : (undefined as unknown as Fake) };
}

const as = (s: RunningServer, by: Actor) => (...drafts: unknown[]) => {
  const r = s.board.post(drafts, by);
  if (!r.ok) throw new Error(`${r.rule}: ${r.reason}`);
  return r.events;
};

/** Add a commit to a branch that exists, without touching the folder. */
function commitOn(repo: string, branch: string, files: Record<string, string>): string {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-wt-'));
  fs.rmSync(wt, { recursive: true });
  gitIn(repo)('worktree', 'add', '-q', wt, branch);
  const c = commitFiles(wt, files, `more on ${branch}`);
  gitIn(repo)('worktree', 'remove', '--force', wt);
  return c;
}

/** A refresh as the builder does it when nothing conflicts: main merged into the canvas's branch. */
const joiner = (repo: string) => (req: RefreshRequest) => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-wt-'));
  fs.rmSync(wt, { recursive: true });
  gitIn(repo)('worktree', 'add', '-q', wt, `board/${req.canvas}`);
  gitIn(wt)('merge', '-q', '--no-edit', req.home.commit);
  gitIn(repo)('worktree', 'remove', '--force', wt);
  return { outcome: 'joined' };
};

/** Open an idea on a canvas and press "Build this" for it. Resolves with its job. */
async function press(s: RunningServer, fake: Fake, chapter: string, canvas?: string, show?: ShowPlan): Promise<BuildJob> {
  const part = `${chapter}-part`;
  if (canvas && !s.board.state.canvases[canvas]) as(s, 'owner')({ type: 'canvas.open', canvas });
  as(s, 'owner')({ type: 'chapter.open', chapter, title: `Idea ${chapter}`, ...(canvas ? { canvas } : {}) });
  as(s, 'agent')({ type: 'model.patch', chapter, ops: [{ op: 'lane.set', lane: { id: `${chapter}-lane`, name: 'Main' } }, { op: 'part.set', part: { id: part, name: `Part ${chapter}`, lane: `${chapter}-lane` } }] });
  as(s, 'owner')({ type: 'solidify', chapter, picks: [], parts: [part] });
  const jobs = fake.jobs.length;
  as(s, 'owner')({ type: 'build.start', chapter, track: [part], check: 'npm test', ...(show ? { show } : {}) });
  await until(() => fake.jobs.length > jobs);
  return fake.jobs.at(-1)!;
}

/** The builder's part of a run: a commit on the canvas's branch, the place, the part built. Resolves with the branch's tip. */
async function buildIt(s: RunningServer, fake: Fake, repo: string, job: BuildJob, files: Record<string, string>): Promise<string> {
  const branch = `board/${job.canvas}`;
  const exists = gitIn(repo)('branch', '--list', branch) !== '';
  const tip = exists ? commitOn(repo, branch, files) : branchWith(repo, branch, job.base?.commit ?? 'main', files);
  fake.ctx.place!(job.canvas, { branch });
  const part = job.track[0]!.id;
  await fake.post({ type: 'part.state', part, state: 'building' }, 'agent');
  await fake.post({ type: 'part.state', part, state: 'built', commit: tip, check: { cmd: 'npm test', passed: true } }, 'system');
  fake.finish({ outcome: 'done' });
  await until(() => !s.builds.busy && s.board.state.chapters[job.chapter]?.state === 'built');
  return tip;
}

async function built(s: RunningServer, fake: Fake, f: { repo: string }, chapter: string, canvas?: string, files: Record<string, string> = { [`${chapter}.txt`]: chapter }): Promise<string> {
  const job = await press(s, fake, chapter, canvas);
  return buildIt(s, fake, f.repo, job, files);
}

const approve = (s: RunningServer, canvas: string) => as(s, 'owner')({ type: 'canvas.approve', canvas });
const merged = (s: RunningServer, chapter: string) => s.board.state.chapters[chapter]?.merged;
const problems = (s: RunningServer, chapter: string) => s.board.state.feed.filter((x) => x.chapter === chapter && x.kind === 'problem').map((x) => x.text);
const updates = (s: RunningServer, chapter: string) => s.board.state.feed.filter((x) => x.chapter === chapter && x.by === 'system' && x.kind === 'update').map((x) => x.text);
const idle = (s: RunningServer, canvas: string) => until(() => s.works()[canvas]?.busy === undefined);

describe('the works', () => {
  it('counts a commit the builder made after the last part was built, once its run ends', async () => {
    const f = withRemote();
    const { s, fake } = await start(f.repo);
    const job = await press(s, fake, 'one');
    const tip = branchWith(f.repo, 'board/one', job.base!.commit, { 'one.txt': 'one' });
    fake.ctx.place!(job.canvas, { branch: 'board/one' });
    const part = job.track[0]!.id;
    await fake.post({ type: 'part.state', part, state: 'building' }, 'agent');
    await fake.post({ type: 'part.state', part, state: 'built', commit: tip, check: { cmd: 'npm test', passed: true } }, 'system');
    await until(() => s.works()[job.canvas]?.ahead === 1);
    await new Promise((r) => setTimeout(r, 1500));
    // The hosted builder commits the brief with the result after the last part, and posts no event for it.
    commitOn(f.repo, 'board/one', { 'brief.md': 'the result' });
    await new Promise((r) => setTimeout(r, 300));
    expect(s.works()[job.canvas]?.ahead).toBe(1);
    fake.finish({ outcome: 'done' });
    await until(() => s.works()[job.canvas]?.ahead === 2);
    expect(s.works()[job.canvas]).toMatchObject({ branch: 'board/one', ahead: 2, behind: 0 });
  });
});

describe('while the builder runs on a canvas', () => {
  it('says the canvas is building from the run\'s start to its end, and refuses Approve and Try it there until then', async () => {
    const f = withRemote();
    const { s, fake } = await start(f.repo);
    const owner = await Client.connect(`ws://127.0.0.1:${s.port}${ROUTES.ws}?token=${s.tokens.owner}`);
    const job = await press(s, fake, 'one');
    expect(s.works().one?.busy).toBe('building');
    await owner.next((m) => m.t === 'works' && m.works.one?.busy === 'building');

    // The last part is built, and the builder has not ended its run: its last commit is still to come.
    const tip = branchWith(f.repo, 'board/one', job.base!.commit, { 'one.txt': 'one' });
    fake.ctx.place!('one', { branch: 'board/one' });
    const part = job.track[0]!.id;
    await fake.post({ type: 'part.state', part, state: 'building' }, 'agent');
    await fake.post({ type: 'part.state', part, state: 'built', commit: tip, check: { cmd: 'npm test', passed: true } }, 'system');
    expect(s.board.state.chapters.one?.state).toBe('built');
    const main = f.git('rev-parse', 'main');
    const seq = s.board.state.seq;

    expect(s.board.post([{ type: 'canvas.approve', canvas: 'one' }], 'owner')).toEqual({ ok: false, rule: 'R8', reason: APPROVE_WHILE_BUILDING, index: 0 });
    owner.send({ t: 'post', ref: 'approve-1', draft: { type: 'canvas.approve', canvas: 'one' } });
    expect(await owner.next((m) => m.t === 'refused' && m.ref === 'approve-1')).toMatchObject({ rule: 'R8', reason: APPROVE_WHILE_BUILDING });
    const tried = await call(s.origin, s.tokens.owner, ROUTES.show, { method: 'POST', json: { action: 'start', chapter: 'one', run: 'npm test' } });
    expect(tried).toMatchObject({ status: 409, body: { reason: TRY_WHILE_BUILDING } });
    expect(fake.shows).toEqual([]);
    expect(s.board.state.seq).toBe(seq);
    expect(f.git('rev-parse', 'main')).toBe(main);
    expect(s.works().one?.busy).toBe('building');

    const last = commitOn(f.repo, 'board/one', { 'brief.md': 'the result' });
    fake.finish({ outcome: 'done' });
    await until(() => s.works().one?.busy === undefined);
    await owner.next((m) => m.t === 'works' && m.works.one !== undefined && m.works.one.busy === undefined);
    approve(s, 'one');
    await until(() => merged(s, 'one') !== undefined);
    expect(f.git('rev-parse', 'main')).toBe(last);
    owner.close();
  });

  it('lets a delete stop the run, and refuses a delete while the branch is joined to main', async () => {
    const f = withRemote();
    const { s, fake } = await start(f.repo);
    await built(s, fake, f, 'one');
    remoteMoves(f, { 'b.txt': 'b' });
    let release: (r: unknown) => void = () => {};
    fake.refreshWith = () => new Promise((r) => (release = r));
    approve(s, 'one');
    await until(() => s.works().one?.busy === 'joining');
    expect(s.board.post([{ type: 'canvas.remove', canvas: 'one' }], 'owner')).toEqual({ ok: false, rule: 'R8', reason: deleteWhileMerging('main'), index: 0 });
    expect(s.board.state.canvases.one).toBeDefined();
    expect(fake.discards).toEqual([]);
    release(joiner(f.repo)(fake.refreshes[0]!));
    await until(() => merged(s, 'one') !== undefined);
    await idle(s, 'one');
    expect(f.git('rev-parse', 'main')).toBe(merged(s, 'one')!.commit);
  });
});

describe('approve', () => {
  it('fast-forwards main to the canvas\'s branch, says merged on each idea, and takes the branch away', async () => {
    const f = withRemote();
    const { s, fake } = await start(f.repo);
    const job = await press(s, fake, 'one');
    expect(job.base).toEqual({ branch: 'main', commit: f.git('rev-parse', 'main') });
    const tip = await buildIt(s, fake, f.repo, job, { 'one.txt': 'one' });
    await until(() => s.works()[job.canvas]?.ahead === 1);
    expect(s.works()[job.canvas]).toMatchObject({ branch: 'board/one', ahead: 1, behind: 0 });
    fs.writeFileSync(path.join(f.repo, 'mine.txt'), 'kept');

    approve(s, job.canvas);
    await until(() => merged(s, 'one') !== undefined);
    expect(merged(s, 'one')).toMatchObject({ commit: tip, into: 'main' });
    expect(f.git('rev-parse', 'main')).toBe(tip);
    expect(fs.readFileSync(path.join(f.repo, 'one.txt'), 'utf8')).toBe('one');
    expect(fs.readFileSync(path.join(f.repo, 'mine.txt'), 'utf8')).toBe('kept');
    expect(s.board.events.filter((e) => e.type === 'canvas.merged')).toEqual([expect.objectContaining({ by: 'system', canvas: job.canvas, commit: tip, into: 'main' })]);
    expect(s.board.state.feed.filter((x) => x.chapter === 'one' && x.kind === 'state').map((x) => x.text)).toContain('Merged into main.');
    await until(() => fake.discards.length === 1);
    expect(fake.discards).toEqual([{ canvas: job.canvas, branch: true }]);
    await idle(s, job.canvas);
    expect(readPrivate(s.board.dir)?.works).toBeUndefined();
    await until(() => s.home()?.sync === 'ahead');
    expect(s.home()).toMatchObject({ sync: 'ahead', ahead: 1 });
    expect(problems(s, 'one')).toEqual([]);
    // Twice: the rules refuse it once merged.
    expect(s.board.post([{ type: 'canvas.approve', canvas: job.canvas }], 'owner')).toMatchObject({ ok: false, rule: 'R8' });
  });

  it('says it in the feed, and keeps the place, when the builder does not take the build away', async () => {
    const f = withRemote();
    const { s, fake } = await start(f.repo);
    await built(s, fake, f, 'one');
    fake.discardWith = () => {
      throw new Error('git refused to delete board/one');
    };
    approve(s, 'one');
    await until(() => problems(s, 'one').length === 1);
    expect(merged(s, 'one')).toBeDefined();
    expect(problems(s, 'one')[0]).toBe('It is merged into main, but its build was not taken away: git refused to delete board/one.');
    expect(readPrivate(s.board.dir)?.works).toEqual([{ canvas: 'one', branch: 'board/one' }]);
  });

  it('merges two built ideas on one canvas with one approval', async () => {
    const f = withRemote();
    const { s, fake } = await start(f.repo);
    await built(s, fake, f, 'one');
    const job2 = await press(s, fake, 'two', 'one');
    expect(job2.canvas).toBe('one');
    const tip = await buildIt(s, fake, f.repo, job2, { 'two.txt': 'two' });
    approve(s, 'one');
    await until(() => merged(s, 'two') !== undefined);
    expect(merged(s, 'one')).toMatchObject({ commit: tip });
    expect(f.git('rev-parse', 'main')).toBe(tip);
    expect(s.board.events.filter((e) => e.type === 'canvas.merged')).toHaveLength(1);
  });

  it('stops the shows of the canvas\'s ideas first', async () => {
    const f = withRemote();
    const { s, fake } = await start(f.repo);
    await built(s, fake, f, 'one');
    const r = await call(s.origin, s.tokens.owner, ROUTES.show, { method: 'POST', json: { action: 'start', chapter: 'one', run: 'npm test' } });
    expect(r.status).toBe(200);
    approve(s, 'one');
    await until(() => merged(s, 'one') !== undefined);
    expect(fake.shows[0]!.stopped).toBe(true);
    expect(s.shows()).toEqual({});
  });

  it('says this machine has no branch for the idea, and merges nothing', async () => {
    const f = withRemote();
    const { s, fake } = await start(f.repo);
    const job = await press(s, fake, 'one');
    const part = job.track[0]!.id;
    const c = f.git('rev-parse', 'main');
    await fake.post({ type: 'part.state', part, state: 'building' }, 'agent');
    await fake.post({ type: 'part.state', part, state: 'built', commit: c, check: { cmd: 'npm test', passed: true } }, 'system');
    fake.finish();
    await until(() => s.board.state.chapters.one?.state === 'built');
    approve(s, 'one');
    await until(() => problems(s, 'one').length === 1);
    expect(problems(s, 'one')).toEqual(['This machine has no branch for this idea, so there is nothing to merge.']);
    expect(merged(s, 'one')).toBeUndefined();
  });

  it('finds the work already in main when the owner merged it by hand, and asks no refresh', async () => {
    const f = withRemote();
    const { s, fake } = await start(f.repo);
    const tip = await built(s, fake, f, 'one');
    f.git('merge', '-q', '--ff-only', 'board/one');
    approve(s, 'one');
    await until(() => merged(s, 'one') !== undefined);
    expect(merged(s, 'one')?.commit).toBe(tip);
    expect(fake.refreshes).toEqual([]);
  });

  it('when main moved, has the builder join it with every agreed check, then fast-forwards', async () => {
    const f = withRemote();
    const { s, fake } = await start(f.repo);
    await built(s, fake, f, 'one');
    const theirs = remoteMoves(f, { 'b.txt': 'b' });
    fake.refreshWith = joiner(f.repo);
    approve(s, 'one');
    await until(() => merged(s, 'one') !== undefined);
    expect(fake.refreshes).toEqual([{ canvas: 'one', home: { branch: 'main', commit: theirs }, checks: ['npm test'], setups: [] }]);
    const tip = f.git('rev-parse', 'board/one');
    expect(f.git('rev-parse', 'main')).toBe(tip);
    expect(merged(s, 'one')?.commit).toBe(tip);
  });

  it('stops after a resolved join, to be tried again, and after a failed one, with the note', async () => {
    const f = withRemote();
    const { s, fake } = await start(f.repo);
    await built(s, fake, f, 'one');
    remoteMoves(f, { 'b.txt': 'b' });
    fake.refreshWith = { outcome: 'resolved' };
    approve(s, 'one');
    await until(() => updates(s, 'one').some((t) => /try it again/.test(t)));
    await idle(s, 'one');
    expect(merged(s, 'one')).toBeUndefined();

    fake.refreshWith = { outcome: 'failed', note: 'npm test failed: 2 tests' };
    const main = f.git('rev-parse', 'main');
    approve(s, 'one');
    await until(() => problems(s, 'one').length === 1);
    expect(problems(s, 'one')[0]).toBe('main could not be joined into this idea, so nothing was merged: npm test failed: 2 tests.');
    expect(f.git('rev-parse', 'main')).toBe(main);
  });

  it('says what is missing when main moved and the builder cannot join', async () => {
    const f = withRemote();
    const { s, fake } = await start(f.repo, { linkOptions: { 'builder-extras': 'none' } });
    await built(s, fake, f, 'one');
    remoteMoves(f, { 'b.txt': 'b' });
    approve(s, 'one');
    await until(() => problems(s, 'one').length === 1);
    expect(problems(s, 'one')[0]).toBe('main has changed since this was built, and the builder linked here cannot join the two. Nothing was merged.');
  });

  it('moves nothing when the owner\'s files are in the way, and names them', async () => {
    const f = withRemote();
    const { s, fake } = await start(f.repo);
    await built(s, fake, f, 'one', undefined, { 'a.txt': 'built' });
    const main = f.git('rev-parse', 'main');
    fs.writeFileSync(path.join(f.repo, 'a.txt'), 'mine');
    approve(s, 'one');
    await until(() => problems(s, 'one').length === 1);
    expect(problems(s, 'one')[0]).toBe('Your changes in a.txt are in the way of main. Commit or stash them, then approve again.');
    expect(f.git('rev-parse', 'main')).toBe(main);
    expect(fs.readFileSync(path.join(f.repo, 'a.txt'), 'utf8')).toBe('mine');
    expect(f.git('stash', 'list')).toBe('');
  });

  it('makes main\'s first commit in a repository that had none', async () => {
    const repo = tempRepo('unborn');
    const git = gitIn(repo);
    git('init', '-q', '-b', 'main');
    const { s, fake } = await start(repo);
    const job = await press(s, fake, 'one');
    expect(job.base).toBeUndefined();
    const root = git('commit-tree', git('mktree'), '-m', 'start');
    const tip = branchWith(repo, 'board/one', root, { 'one.txt': 'one' });
    fake.ctx.place!('one', { branch: 'board/one' });
    await fake.post({ type: 'part.state', part: 'one-part', state: 'building' }, 'agent');
    await fake.post({ type: 'part.state', part: 'one-part', state: 'built', commit: tip, check: { cmd: 'npm test', passed: true } }, 'system');
    fake.finish();
    await until(() => s.board.state.chapters.one?.state === 'built');
    approve(s, 'one');
    await until(() => merged(s, 'one') !== undefined);
    expect(git('rev-parse', 'main')).toBe(tip);
    expect(fs.readFileSync(path.join(repo, 'one.txt'), 'utf8')).toBe('one');
  });

  it('is done once while it runs, holds a build that starts on the canvas, and lets another canvas build', async () => {
    const f = withRemote();
    const { s, fake } = await start(f.repo);
    await built(s, fake, f, 'one');
    remoteMoves(f, { 'b.txt': 'b' });
    let release: (r: unknown) => void = () => {};
    fake.refreshWith = () => new Promise((r) => (release = r));
    approve(s, 'one');
    await until(() => s.works().one?.busy === 'joining');
    approve(s, 'one');

    // A build on the canvas being merged waits; one on another canvas goes.
    const jobs = fake.jobs.length;
    as(s, 'owner')({ type: 'chapter.open', chapter: 'two', title: 'Idea two', canvas: 'one' });
    as(s, 'agent')({ type: 'model.patch', chapter: 'two', ops: [{ op: 'lane.set', lane: { id: 'two-lane', name: 'Main' } }, { op: 'part.set', part: { id: 'two-part', name: 'Part two', lane: 'two-lane' } }] });
    as(s, 'owner')({ type: 'solidify', chapter: 'two', picks: [], parts: ['two-part'] });
    as(s, 'owner')({ type: 'build.start', chapter: 'two', track: ['two-part'], check: 'npm test' });
    const other = press(s, fake, 'three', 'elsewhere');
    const job3 = await other;
    expect(job3.canvas).toBe('elsewhere');
    expect(fake.jobs.length).toBe(jobs + 1);
    fake.finish({ outcome: 'paused' });
    await until(() => !s.builds.busy);
    expect(fake.jobs.length).toBe(jobs + 1);

    release({ outcome: 'resolved' });
    // Once the merge is done, the build held on the canvas starts, and the canvas is busy with it.
    await until(() => fake.jobs.length === jobs + 2);
    expect(fake.refreshes).toHaveLength(1);
    expect(fake.jobs.at(-1)).toMatchObject({ chapter: 'two', canvas: 'one' });
    expect(s.works().one?.busy).toBe('building');
  });

  it('merges nothing by itself after a stop in the middle; Approve again finishes it', async () => {
    const f = withRemote();
    const first = await start(f.repo);
    await built(first.s, first.fake, f, 'one');
    remoteMoves(f, { 'b.txt': 'b' });
    first.fake.refreshWith = () => new Promise(() => {});
    approve(first.s, 'one');
    await until(() => first.s.works().one?.busy === 'joining');
    await first.s.close();
    running.splice(0);

    const second = await start(f.repo);
    await new Promise((r) => setTimeout(r, 200));
    expect(merged(second.s, 'one')).toBeUndefined();
    expect(second.fake.refreshes).toEqual([]);
    second.fake.refreshWith = joiner(f.repo);
    approve(second.s, 'one');
    await until(() => merged(second.s, 'one') !== undefined);
  });

  it('refuses an approval while another idea on the canvas builds', async () => {
    const f = withRemote();
    const { s, fake } = await start(f.repo);
    await built(s, fake, f, 'one');
    await press(s, fake, 'two', 'one');
    expect(s.board.post([{ type: 'canvas.approve', canvas: 'one' }], 'owner')).toMatchObject({ ok: false, rule: 'R8' });
  });

  it('reads the counts again after a join, before it says anything', async () => {
    const f = withRemote();
    const { s, fake } = await start(f.repo);
    await built(s, fake, f, 'one');
    remoteMoves(f, { 'b.txt': 'b' });
    await call(s.origin, s.tokens.owner, ROUTES.sync, { method: 'POST', json: {} });
    await until(() => s.works().one?.behind === 1);
    let atLine: unknown;
    s.board.subscribe((events) => {
      if (events.some((e) => e.type === 'feed.add' && e.chapter === 'one')) atLine ??= { ...s.works().one };
    });

    // Resolved: the branch has main now, and the owner is asked to try it again.
    fake.refreshWith = (req: RefreshRequest) => (joiner(f.repo)(req), { outcome: 'resolved' });
    approve(s, 'one');
    await until(() => updates(s, 'one').some((t) => /try it again/.test(t)));
    expect(atLine).toMatchObject({ behind: 0, ahead: 2 });

    // Joined, and then the owner's files are in the way: the counts are right when that is said.
    await idle(s, 'one');
    remoteMoves(f, { 'c.txt': 'c' });
    await call(s.origin, s.tokens.owner, ROUTES.sync, { method: 'POST', json: {} });
    await until(() => s.works().one?.behind === 1);
    fs.writeFileSync(path.join(f.repo, 'one.txt'), 'mine');
    fake.refreshWith = joiner(f.repo);
    atLine = undefined;
    approve(s, 'one');
    await until(() => problems(s, 'one').length === 1);
    expect(problems(s, 'one')[0]).toBe('Your changes in one.txt are in the way of main. Commit or stash them, then approve again.');
    expect(atLine).toMatchObject({ behind: 0 });
  });

  it('merges here when main and its remote have both moved, and says so', async () => {
    const f = withRemote();
    const { s, fake } = await start(f.repo);
    const tip = await built(s, fake, f, 'one');
    commitFiles(f.repo, { 'mine.txt': 'mine' }, 'mine');
    remoteMoves(f, { 'b.txt': 'b' });
    await call(s.origin, s.tokens.owner, ROUTES.sync, { method: 'POST', json: {} });
    expect(s.home()?.sync).toBe('diverged');
    fake.refreshWith = joiner(f.repo);
    approve(s, 'one');
    await until(() => merged(s, 'one') !== undefined);
    expect(f.git('rev-parse', 'main')).not.toBe(tip);
    expect(f.git('rev-parse', 'main')).toBe(merged(s, 'one')!.commit);
    await until(() => updates(s, 'one').length > 0);
    expect(updates(s, 'one')).toEqual(["main here and origin/main have both moved, so this merge is in main on this machine only. Run git pull in the board's folder, then push."]);
    expect(problems(s, 'one')).toEqual([]);
  });

  it('tells the page again once the branch is gone after a merge', async () => {
    const f = withRemote();
    const { s, fake } = await start(f.repo);
    await built(s, fake, f, 'one');
    const owner = await Client.connect(`ws://127.0.0.1:${s.port}${ROUTES.ws}?token=${s.tokens.owner}`);
    let gone = -1;
    fake.discardWith = async () => {
      await new Promise((r) => setTimeout(r, 100));
      gitIn(f.repo)('branch', '-D', 'board/one');
      gone = owner.messages.length;
    };
    approve(s, 'one');
    await until(() => gone >= 0);
    await until(() => owner.messages.slice(gone).some((m) => m.t === 'works'));
    const after = owner.messages.slice(gone).filter((m) => m.t === 'works');
    expect(after.at(-1)).toMatchObject({ t: 'works', works: {} });
    expect(gitIn(f.repo)('branch', '--list', 'board/one')).toBe('');
    owner.close();
  });

  it('admits canvas.merged only for a commit main holds', async () => {
    const f = withRemote();
    const { s, fake } = await start(f.repo);
    const tip = await built(s, fake, f, 'one');
    const post = (commit: string, into = 'main') => s.board.post([{ type: 'canvas.merged', canvas: 'one', commit, into }], 'system');
    expect(post(tip)).toMatchObject({ ok: false, rule: 'R2' });
    expect(post('0123456789abcdef0123456789abcdef01234567')).toMatchObject({ ok: false, rule: 'R2' });
    expect(post(f.git('rev-parse', 'main'), 'board/one')).toMatchObject({ ok: false, rule: 'R2' });
    expect(s.board.post([{ type: 'canvas.merged', canvas: 'one', commit: f.git('rev-parse', 'main'), into: 'main' }], 'agent')).toMatchObject({ ok: false });
    expect(post(f.git('rev-parse', 'main'))).toMatchObject({ ok: true });
  });
});

describe('delete a canvas', () => {
  it('stops the build that runs on it, then takes away its branch and forgets its ideas', async () => {
    const f = withRemote();
    const { s, fake } = await start(f.repo);
    await built(s, fake, f, 'one');
    await call(s.origin, s.tokens.owner, ROUTES.show, { method: 'POST', json: { action: 'start', chapter: 'one', run: 'npm test' } });
    const job2 = await press(s, fake, 'two', 'one');
    expect(job2.canvas).toBe('one');
    let runEndedFirst: boolean | undefined;
    fake.discardWith = () => {
      runEndedFirst = fake.current === undefined;
      gitIn(f.repo)('branch', '-D', 'board/one');
    };
    expect(readPrivate(s.board.dir)?.consents?.map((c) => c.chapter)).toEqual(['one', 'two']);

    as(s, 'owner')({ type: 'canvas.remove', canvas: 'one' });
    await until(() => fake.discards.length === 1);
    expect(fake.calls).toContain('pause');
    expect(fake.shows[0]!.stopped).toBe(true);
    expect(fake.discards).toEqual([{ canvas: 'one', branch: true }]);
    expect(runEndedFirst).toBe(true);
    expect(gitIn(f.repo)('branch', '--list', 'board/one')).toBe('');
    await idle(s, 'one');
    const priv = readPrivate(s.board.dir);
    expect(priv?.consents).toBeUndefined();
    expect(priv?.works).toBeUndefined();
    expect(s.works()).toEqual({});
  });

  it('drops a build waiting its turn on the canvas', async () => {
    const f = withRemote();
    const { s, fake } = await start(f.repo);
    await press(s, fake, 'one');
    const jobs = fake.jobs.length;
    as(s, 'owner')({ type: 'canvas.open', canvas: 'second' });
    as(s, 'owner')({ type: 'chapter.open', chapter: 'three', title: 'Idea three', canvas: 'second' });
    as(s, 'agent')({ type: 'model.patch', chapter: 'three', ops: [{ op: 'lane.set', lane: { id: 'l3', name: 'Main' } }, { op: 'part.set', part: { id: 'p3', name: 'P3', lane: 'l3' } }] });
    as(s, 'owner')({ type: 'solidify', chapter: 'three', picks: [], parts: ['p3'] });
    as(s, 'owner')({ type: 'build.start', chapter: 'three', track: ['p3'], check: 'npm test' });
    as(s, 'owner')({ type: 'canvas.remove', canvas: 'second' });
    fake.finish({ outcome: 'paused' });
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.jobs.length).toBe(jobs);
  });

  it('has nothing to take away on a blank canvas, and leaves main as it is after a merged one', async () => {
    const f = withRemote();
    const { s, fake } = await start(f.repo);
    as(s, 'owner')({ type: 'canvas.open', canvas: 'blank' });
    as(s, 'owner')({ type: 'canvas.remove', canvas: 'blank' });
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.discards).toEqual([]);

    const tip = await built(s, fake, f, 'one', 'kept');
    approve(s, 'kept');
    await until(() => merged(s, 'one') !== undefined);
    await until(() => fake.discards.length === 1);
    as(s, 'owner')({ type: 'canvas.remove', canvas: 'kept' });
    await until(() => fake.discards.length === 2);
    expect(f.git('rev-parse', 'main')).toBe(tip);
  });
});

describe('keel-board status', () => {
  it('lists each canvas with its branch and its ideas', async () => {
    const f: Fixture = withRemote();
    const opened = await run(['open', f.repo, '--no-browser', '--port', '0', '--app-dir', path.join(f.repo, 'no-app'), '--builder', FAKE, '--link', 'none'], { out: () => {}, err: () => {} });
    const s = opened.server!;
    running.push(s);
    const fake = fakes.at(-1)!;
    await built(s, fake, f, 'one');
    await until(() => s.works().one?.ahead === 1);
    const out: string[] = [];
    await run(['status', f.repo], { out: (l) => out.push(l), err: () => {} });
    expect(out.filter((l) => l.startsWith('canvas'))).toEqual(['canvas   Idea one · board/one (1 ahead of main) · Idea one (built)']);
  });
});
