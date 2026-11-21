import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Actor, BuildJob, BuildResult, BuildShow, Builder, BuilderContext, FeedEntry, ShowPlan, Wake } from '@keel/protocol';
import { ROUTES, awaitsProof, renderBrief } from '@keel/protocol';
import { Board } from '../src/board';
import { BuildRunner, NO_BUILDER } from '../src/build';
import type { Io, RunDeps } from '../src/cli';
import { run } from '../src/cli';
import type { RunningServer, ServerOptions } from '../src/server';
import { SHOW_OPENED, SHOW_WAITS, startServer } from '../src/server';
import { CH, Client, call, chapter, ink, note, tempRepo, until } from './helpers';

const FAKE = fileURLToPath(new URL('./fake-builder.mjs', import.meta.url));

interface Fake {
  ctx: BuilderContext;
  calls: string[];
  jobs: BuildJob[];
  maxActive: number;
  throwOnRun?: string;
  auto?: BuildResult;
  plays: Array<(job: BuildJob, fake: Fake) => Promise<BuildResult>>;
  pauseEnds: boolean;
  current?: unknown;
  finish(result?: BuildResult): void;
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

async function start(opts: Partial<ServerOptions> = {}): Promise<{ s: RunningServer; fake: Fake }> {
  const repoDir = opts.repoDir ?? tempRepo();
  const n = fakes.length;
  const s = await startServer({
    port: 0,
    appDir: path.join(repoDir, 'no-app'),
    log: () => {},
    // The fake's commits are in no repository.
    checkCommits: false,
    builder: FAKE,
    ...opts,
    repoDir,
  });
  running.push(s);
  return { s, fake: fakes.length > n ? fakes.at(-1)! : (undefined as unknown as Fake) };
}

const as =
  (s: RunningServer, by: Actor) =>
  (...drafts: unknown[]) => {
    const r = s.board.post(drafts, by);
    if (!r.ok) throw new Error(`${r.rule}: ${r.reason}`);
    return r.events;
  };

/** A chapter whose parts the owner has decided, ready for "Build this". */
function solidChapter(s: RunningServer, id = CH, parts = ['door', 'bridge', 'engine']): void {
  as(s, 'owner')({ type: 'chapter.open', chapter: id, title: `Idea ${id}` });
  as(s, 'agent')({
    type: 'model.patch',
    chapter: id,
    ops: [{ op: 'lane.set', lane: { id: 'main', name: 'Main' } }, ...parts.map((p) => ({ op: 'part.set', part: { id: p, name: `The ${p}`, lane: 'main' } }))],
  });
  as(s, 'owner')({ type: 'solidify', chapter: id, picks: [], parts });
}

function buildThis(s: RunningServer, id = CH, track = ['door', 'bridge', 'engine']): void {
  as(s, 'owner')({ type: 'build.start', chapter: id, track, check: 'npm test' });
}

/** The fake builds one part as a real build's tools would: building, then built with a commit and a passed check. */
async function buildPart(fake: Fake, part: string): Promise<void> {
  await fake.post({ type: 'part.state', part, state: 'building' }, 'agent');
  await fake.post({ type: 'part.state', part, state: 'built', commit: 'abc1234', check: { cmd: 'npm test', passed: true } }, 'system');
}

/** What the server itself said in the feed. */
const said = (s: RunningServer): FeedEntry[] => s.board.state.feed.filter((f) => f.by === 'system' && (f.kind === 'update' || f.kind === 'problem'));
const problems = (s: RunningServer) => said(s).filter((f) => f.kind === 'problem');
const settle = () => new Promise((r) => setTimeout(r, 30));


/** The address of the page a finished build shows, as the owner's page hears it. */
const pageUrl = (s: RunningServer): string | undefined => {
  const show = s.shows()[CH];
  return show?.kind === 'page' ? show.url : undefined;
};

describe('the build', () => {
  it('starts the builder on "Build this", with the job and the context, and leaves out parts already built', async () => {
    const { s, fake } = await start();
    expect(s.builderName).toBe('fake-builder');
    solidChapter(s);
    // A part the repository already had, built, is on the track.
    as(s, 'agent')({
      type: 'model.patch',
      chapter: CH,
      ops: [{ op: 'part.set', part: { id: 'shelf', name: 'The shelf', lane: 'main', state: 'built', commit: 'abc1234', shelf: true } }],
    });
    buildThis(s, CH, ['shelf', 'door', 'bridge', 'engine']);
    await until(() => fake.jobs.length === 1);

    expect(fake.jobs[0]).toEqual({
      chapter: CH,
      // An old log's chapters are on the board's first canvas, named for the first chapter.
      canvas: CH,
      canvasTitle: `Idea ${CH}`,
      title: `Idea ${CH}`,
      track: [
        { id: 'door', name: 'The door' },
        { id: 'bridge', name: 'The bridge' },
        { id: 'engine', name: 'The engine' },
      ],
      check: 'npm test',
      brief: renderBrief(s.board.state, CH),
      resume: false,
    });
    expect(fake.jobs[0]!.brief).toMatch(/^# Idea first-idea/);
    expect(fake.ctx).toMatchObject({
      repoDir: s.board.repoDir,
      boardDir: s.board.dir,
      serverUrl: s.origin,
      agentToken: s.tokens.agent,
      systemToken: s.tokens.system,
      stateDir: path.join(s.stateDir, 'builder'),
    });
    expect(fs.statSync(fake.ctx.stateDir!).mode & 0o777).toBe(0o700);

    // The pill says what is in work, and the board info says how far the build is.
    expect(s.presence.get()).toMatchObject({ state: 'building', note: 'The door (part 2 of 4)' });
    const info = await call(s.origin, s.tokens.system, ROUTES.board);
    expect(info.body).toMatchObject({ builder: 'fake-builder', build: { chapter: CH, state: 'running', built: 1, total: 4, part: 'The door' } });

    await buildPart(fake, 'door');
    await until(() => s.presence.get().note === 'The bridge (part 3 of 4)');
    await buildPart(fake, 'bridge');
    await buildPart(fake, 'engine');
    fake.finish({ outcome: 'done' });
    await settle();

    // Done, and the parts say it: the server adds nothing.
    expect(s.board.state.chapters[CH]!.state).toBe('built');
    expect(said(s)).toEqual([]);
    expect(s.presence.get()).toMatchObject({ state: 'away', note: 'no agent is linked' });
    expect(fake.maxActive).toBe(1);
  });

  it('tells the page what the build does, when it changes, with no need to ask', async () => {
    const { s, fake } = await start();
    const page = await Client.connect(`${s.origin.replace('http', 'ws')}/ws?token=${s.tokens.owner}`);
    expect(page.messages.find((m) => m.t === 'init')).not.toHaveProperty('build');
    solidChapter(s);
    buildThis(s);
    await until(() => fake.jobs.length === 1);
    const running = await page.next((m) => m.t === 'build' && m.build?.state === 'running');
    expect(running).toMatchObject({ t: 'build', build: { chapter: CH, state: 'running', built: 0, total: 3 } });
    as(s, 'owner')({ type: 'build.pause', chapter: CH });
    await page.next((m) => m.t === 'build' && m.build?.state === 'paused');
    // A page that opens now learns it at once.
    const late = await Client.connect(`${s.origin.replace('http', 'ws')}/ws?token=${s.tokens.owner}`);
    expect(late.messages.find((m) => m.t === 'init')).toMatchObject({ build: { state: 'paused' } });
    page.close();
    late.close();
  });

  it('pauses on Pause, and carries on with resume: true on Resume', async () => {
    const { s, fake } = await start();
    solidChapter(s);
    buildThis(s);
    await until(() => fake.jobs.length === 1);

    as(s, 'owner')({ type: 'build.pause', chapter: CH });
    await until(() => !s.builds.busy);
    expect(fake.calls).toEqual(['run', 'pause']);
    await settle();
    expect(said(s)).toEqual([]);
    expect(s.builds.status()).toMatchObject({ state: 'paused' });
    expect(s.presence.get().state).toBe('away');

    as(s, 'owner')({ type: 'build.resume', chapter: CH });
    await until(() => fake.jobs.length === 2);
    expect(fake.jobs[1]).toMatchObject({ resume: true, track: [{ id: 'door' }, { id: 'bridge' }, { id: 'engine' }] });
    expect(said(s)).toEqual([]);
  });

  it('holds the build when the owner reopens a part on its track, says which, and carries on when it is decided again', async () => {
    const { s, fake } = await start();
    solidChapter(s);
    buildThis(s);
    await until(() => fake.jobs.length === 1);
    await buildPart(fake, 'door');

    as(s, 'owner')({ type: 'part.state', part: 'bridge', state: 'idea' });
    await until(() => fake.calls.includes('pause') && said(s).length === 1);
    expect(said(s)[0]).toMatchObject({ kind: 'update', chapter: CH, text: 'The build waits: you reopened "The bridge". Solidify it again and the build carries on.' });
    await settle();
    expect(fake.jobs).toHaveLength(1);
    expect(s.builds.status()).toMatchObject({ state: 'waiting', built: 1, total: 3 });

    // Pause and Resume while the part is still an idea: the build still waits, and says why.
    as(s, 'owner')({ type: 'build.pause', chapter: CH });
    as(s, 'owner')({ type: 'build.resume', chapter: CH });
    await until(() => said(s).length === 2);
    expect(said(s)[1]!.text).toMatch(/still waits: "The bridge" is an idea again/);
    await settle();
    expect(fake.jobs).toHaveLength(1);

    // Decided again: the build carries on, without the part already built.
    as(s, 'owner')({ type: 'part.state', part: 'bridge', state: 'solid' });
    await until(() => fake.jobs.length === 2);
    expect(fake.jobs[1]).toMatchObject({ resume: true, track: [{ id: 'bridge' }, { id: 'engine' }] });
    expect(problems(s)).toEqual([]);
  });

  it('holds the build when the agent reopens a part from the owner\'s mark', async () => {
    const { s, fake } = await start();
    solidChapter(s);
    as(s, 'owner')(note('n0', 'show me'));
    as(s, 'agent')({ type: 'item.add', chapter: CH, item: { id: 'pic', kind: 'picture', picture: { kind: 'text', title: 'The parts' }, answers: ['n0'] } });
    buildThis(s);
    await until(() => fake.jobs.length === 1);

    as(s, 'owner')(note('n1', 'the engine should batch', { on: { item: 'pic', sub: 'part:engine' } }));
    as(s, 'agent')({ type: 'part.state', part: 'engine', state: 'idea', because: ['n1'] });
    await until(() => fake.calls.includes('pause') && said(s).length === 1);
    expect(said(s)[0]!.text).toBe('The build waits: the agent reopened, from your mark, "The engine". Solidify it again and the build carries on.');
    expect(problems(s)).toEqual([]);
  });

  it('reports a failed run, a run that stops with parts not built, and a builder that throws: never a silent stop', async () => {
    const { s, fake } = await start();
    solidChapter(s);
    buildThis(s);
    await until(() => fake.jobs.length === 1);
    const again = async (n: number) => {
      as(s, 'owner')({ type: 'build.pause', chapter: CH });
      as(s, 'owner')({ type: 'build.resume', chapter: CH });
      await until(() => fake.calls.filter((c) => c === 'run').length === n);
    };

    fake.finish({ outcome: 'failed', note: 'the check would not pass' });
    await until(() => problems(s).length === 1);
    expect(problems(s)[0]!.text).toBe(`The build of "Idea ${CH}" stopped: the check would not pass. 0 of 3 parts are built. Press Try again to go on.`);
    expect(s.builds.status()).toMatchObject({ state: 'stopped' });

    await again(2);
    await buildPart(fake, 'door');
    fake.finish({ outcome: 'done' });
    await until(() => problems(s).length === 2);
    expect(problems(s)[1]!.text).toBe('The builder stopped (it said "done"), but nobody paused it and 2 parts are not built: "The bridge", "The engine". Press Try again to go on.');

    await again(3);
    fake.finish({ outcome: 'paused' });
    await until(() => problems(s).length === 3);
    expect(problems(s)[2]!.text).toMatch(/it said "paused"\), but nobody paused it/);

    fake.throwOnRun = 'out of disk';
    await again(4);
    await until(() => problems(s).length === 4);
    expect(problems(s)[3]!.text).toBe(`The builder failed: out of disk. The build of "Idea ${CH}" stopped, and 1 of 3 parts are built. Press Try again to go on.`);
    expect(s.builds.busy).toBe(false);
    // Each stop was said once, and nothing else was.
    expect(said(s)).toHaveLength(4);
  });

  it('says once that an app with every part built did not answer, keeps it building, and starts the app again on resume', async () => {
    const { s, fake } = await start();
    solidChapter(s, CH, ['door']);
    const app: ShowPlan = { kind: 'app', run: 'npm start' };
    fake.plays.push(
      async () => {
        await buildPart(fake, 'door');
        return { outcome: 'failed', note: 'the app did not answer on its port in 60 s' };
      },
      async () => {
        await fake.post({ type: 'build.proved', chapter: CH });
        return { outcome: 'done' };
      },
    );
    as(s, 'owner')({ type: 'build.start', chapter: CH, track: ['door'], check: 'npm test', show: app });
    await until(() => problems(s).length === 1 && !s.builds.busy);
    expect(problems(s).map((p) => p.text)).toEqual([`The build of "Idea ${CH}" stopped: the app did not answer on its port in 60 s. 1 of 1 parts are built. Press Try again to go on.`]);
    expect(s.board.state.chapters[CH]?.state).toBe('building');
    expect(awaitsProof(s.board.state, CH)).toBe(true);
    expect(s.builds.status()).toMatchObject({ state: 'stopped', built: 1, total: 1 });

    as(s, 'owner')({ type: 'build.pause', chapter: CH });
    as(s, 'owner')({ type: 'build.resume', chapter: CH });
    await until(() => fake.jobs.length === 2);
    expect(fake.jobs[1]).toMatchObject({ chapter: CH, resume: true, track: [], show: app });
    await until(() => s.board.state.chapters[CH]?.state === 'built' && !s.builds.busy);
    await settle();
    expect(problems(s)).toHaveLength(1);
  });

  it('says so when a run ends done and the app has not answered', async () => {
    const { s, fake } = await start();
    solidChapter(s, CH, ['door']);
    fake.plays.push(async () => {
      await buildPart(fake, 'door');
      return { outcome: 'done' };
    });
    as(s, 'owner')({ type: 'build.start', chapter: CH, track: ['door'], check: 'npm test', show: { kind: 'app', run: 'npm start' } });
    await until(() => problems(s).length === 1);
    expect(problems(s)[0]!.text).toBe(`The builder stopped (it said "done"), but the app of "Idea ${CH}" has not answered yet, so it is not built. Press Try again to go on.`);
    expect(s.board.state.chapters[CH]?.state).toBe('building');
  });

  it('ends a builder\'s reason with one full stop, when the reason brings its own', async () => {
    const { s, fake } = await start();
    solidChapter(s);
    buildThis(s);
    await until(() => fake.jobs.length === 1);

    fake.finish({ outcome: 'failed', note: 'The repository has no commit yet. Make a first commit.' });
    await until(() => problems(s).length === 1);
    expect(problems(s)[0]!.text).toBe(`The build of "Idea ${CH}" stopped: The repository has no commit yet. Make a first commit. 0 of 3 parts are built. Press Try again to go on.`);
  });

  it('says once that no builder is linked, and still admits "Build this"', async () => {
    const { s } = await start({ builder: 'none' });
    expect(s.builderName).toBe('none');
    solidChapter(s);
    buildThis(s);
    await until(() => said(s).length === 1);
    expect(said(s)[0]).toMatchObject({ kind: 'update', chapter: CH, text: NO_BUILDER });
    expect(s.board.state.chapters[CH]!.state).toBe('building');
    await settle();
    expect(said(s)).toHaveLength(1);
    const info = await call(s.origin, s.tokens.system, ROUTES.board);
    expect(info.body).toMatchObject({ builder: 'none', build: { chapter: CH, built: 0, total: 3 } });
  });

  it('runs one build at a time: a second one waits its turn, and says so', async () => {
    const { s, fake } = await start();
    solidChapter(s, 'a', ['a1', 'a2']);
    solidChapter(s, 'b', ['b1']);
    buildThis(s, 'a', ['a1', 'a2']);
    buildThis(s, 'b', ['b1']);
    await until(() => fake.jobs.length === 1 && said(s).length === 1);
    await settle();
    expect(fake.jobs.map((j) => j.chapter)).toEqual(['a']);
    expect(said(s)[0]).toMatchObject({ chapter: 'b', text: 'The build of "Idea b" waits its turn: "Idea a" builds first, one build at a time.' });
    expect(s.builds.status()).toMatchObject({ chapter: 'a', state: 'running' });

    await buildPart(fake, 'a1');
    await buildPart(fake, 'a2');
    fake.finish({ outcome: 'done' });
    await until(() => fake.jobs.length === 2);
    expect(fake.jobs[1]).toMatchObject({ chapter: 'b', resume: false, track: [{ id: 'b1' }] });
    expect(fake.maxActive).toBe(1);
    expect(problems(s)).toEqual([]);
  });

  it('pauses then closes the builder on shutdown, and carries on with resume: true after a restart', async () => {
    const repoDir = tempRepo();
    const first = await start({ repoDir });
    solidChapter(first.s);
    buildThis(first.s);
    await until(() => first.fake.jobs.length === 1);
    await buildPart(first.fake, 'door');
    await first.s.close();
    expect(first.fake.calls).toEqual(['run', 'pause', 'close']);
    // A stop on shutdown is not a problem: nothing was posted after it.
    expect(fs.readFileSync(first.s.board.logPath, 'utf8')).not.toMatch(/"kind":"problem"/);

    const second = await start({ repoDir });
    await until(() => second.fake.jobs.length === 1);
    expect(second.fake.jobs[0]).toMatchObject({ chapter: CH, resume: true, track: [{ id: 'bridge' }, { id: 'engine' }] });

    // A build the owner paused stays paused across a restart.
    as(second.s, 'owner')({ type: 'build.pause', chapter: CH });
    await until(() => !second.s.builds.busy);
    await second.s.close();
    const third = await start({ repoDir });
    await settle();
    expect(third.fake.calls).toEqual([]);
  });
});

describe('what a finished build shows', () => {
  /**
   * A runner on a board of its own, with no server: its builder ends each run with what the
   * test gives, and the runner's show option records what it is handed.
   */
  async function runOnce(result: unknown, opts: { buildParts?: boolean } = {}): Promise<{ shown: Array<[string, BuildShow]>; board: Board; log: string[] }> {
    const board = Board.open(tempRepo(), { checkCommits: false });
    const post = (by: Actor, ...drafts: unknown[]) => {
      const r = board.post(drafts, by);
      if (!r.ok) throw new Error(`${r.rule}: ${r.reason}`);
    };
    const parts = ['door', 'bridge'];
    post('owner', { type: 'chapter.open', chapter: CH, title: 'Idea' });
    post('agent', { type: 'model.patch', chapter: CH, ops: [{ op: 'lane.set', lane: { id: 'main', name: 'Main' } }, ...parts.map((p) => ({ op: 'part.set', part: { id: p, name: p, lane: 'main' } }))] });
    post('owner', { type: 'solidify', chapter: CH, picks: [], parts });
    post('owner', { type: 'build.start', chapter: CH, track: parts, check: 'npm test' });
    let finish: (r: unknown) => void = () => {};
    const builder: Builder = {
      name: 'inline',
      run: () => new Promise<BuildResult>((resolve) => (finish = resolve as (r: unknown) => void)),
      pause: async () => {},
      close: async () => {},
    };
    const shown: Array<[string, BuildShow]> = [];
    const log: string[] = [];
    const runner = new BuildRunner({
      builder,
      consent: () => ({ check: 'npm test', track: parts }),
      state: () => board.state,
      post: (drafts) => post('system', ...drafts),
      presence: { get: () => ({ state: 'away', since: '' }), set: () => undefined },
      inWake: () => false,
      rest: () => ({ state: 'away' }),
      show: (chapter, show) => shown.push([chapter, show]),
      log: (m) => log.push(m),
    });
    board.subscribe((events) => runner.notify(events));
    runner.start();
    await until(() => runner.busy);
    if (opts.buildParts !== false) {
      for (const part of parts) {
        post('agent', { type: 'part.state', part, state: 'building' });
        post('system', { type: 'part.state', part, state: 'built', commit: 'abc1234', check: { cmd: 'npm test', passed: true } });
      }
    }
    finish(result);
    await until(() => !runner.busy);
    await settle();
    await runner.close();
    board.close();
    return { shown, board, log };
  }

  it('hands over the folder and the page, and nothing else, when a run ends done and the chapter is built', async () => {
    const { shown, board } = await runOnce({ outcome: 'done', show: { dir: '/some/where', page: 'index.html', extra: 'left out' } });
    expect(board.state.chapters[CH]!.state).toBe('built');
    expect(shown).toEqual([[CH, { dir: '/some/where', page: 'index.html' }]]);
  });

  it('hands over nothing with no show, a show of the wrong shape, an outcome other than done, or a chapter not built', async () => {
    expect((await runOnce({ outcome: 'done' })).shown).toEqual([]);
    const odd = await runOnce({ outcome: 'done', show: { dir: '/some/where', page: 3 } });
    expect(odd.shown).toEqual([]);
    expect(odd.log.join('\n')).toMatch(/not a folder and a page/);
    expect((await runOnce({ outcome: 'done', show: 'index.html' })).shown).toEqual([]);
    expect((await runOnce({ outcome: 'done', show: null })).shown).toEqual([]);
    expect((await runOnce({ outcome: 'paused', show: { dir: '/d', page: 'index.html' } })).shown).toEqual([]);
    expect((await runOnce({ outcome: 'failed', show: { dir: '/d', page: 'index.html' } })).shown).toEqual([]);
    const unbuilt = await runOnce({ outcome: 'done', show: { dir: '/d', page: 'index.html' } }, { buildParts: false });
    expect(unbuilt.board.state.chapters[CH]!.state).toBe('building');
    expect(unbuilt.shown).toEqual([]);
  });
});

describe('presence while the build runs', () => {
  it('shows the part in work, gives way to a wake, and comes back after it, with a link module that also exports createBuilder', async () => {
    const repoDir = tempRepo();
    const mod = path.join(path.dirname(repoDir), 'link-and-builder.mjs');
    fs.writeFileSync(
      mod,
      `export { createBuilder } from ${JSON.stringify(pathToFileURL(FAKE).href)};
      export const ctl = { wakes: [], release: [] };
      export function createLink() {
        return {
          name: 'held-link',
          wake(w) { ctl.wakes.push(w); return new Promise((r) => ctl.release.push(() => r({ ok: true }))); },
          async close() {},
        };
      }\n`,
    );
    const { s, fake } = await start({ repoDir, link: mod, builder: undefined });
    const { ctl } = (await import(pathToFileURL(mod).href)) as { ctl: { wakes: Wake[]; release: Array<() => void> } };
    expect(s.linkName).toBe('held-link');
    expect(s.builderName).toBe('fake-builder');
    expect(s.presence.get().state).toBe('listening');

    solidChapter(s);
    buildThis(s);
    await until(() => fake.jobs.length === 1);
    expect(s.presence.get()).toMatchObject({ state: 'building', note: 'The door (part 1 of 3)' });

    // The owner's acts wake the agent after a short pause. The pill is the wake's then.
    await until(() => ctl.wakes.length === 1);
    expect(s.presence.get()).toMatchObject({ state: 'drawing', note: 'reading your marks' });
    expect(ctl.wakes[0]!.firstOfChapter).toBe(true);
    await buildPart(fake, 'door');
    expect(s.presence.get().state).toBe('drawing');

    // The wake ends: the pill shows the build again, with the part in work now.
    ctl.release.shift()!();
    await until(() => s.presence.get().state === 'building');
    expect(s.presence.get().note).toBe('The bridge (part 2 of 3)');

    // The builder may say more about what it does.
    fake.ctx.presence({ state: 'drawing', note: 'the bridge: running npm test' });
    expect(s.presence.get()).toMatchObject({ state: 'building', note: 'the bridge: running npm test' });

    await buildPart(fake, 'bridge');
    await buildPart(fake, 'engine');
    fake.finish();
    await until(() => s.presence.get().state === 'listening');
  });
});

describe('the items route', () => {
  it('returns each item in full with the owner\'s marks on it, without ink strokes or lasso paths', async () => {
    const { s } = await start({ builder: 'none' });
    const owner = as(s, 'owner');
    owner(chapter(), note('n0', 'start here'));
    as(s, 'agent')({ type: 'item.add', chapter: CH, item: { id: 'pic', kind: 'picture', picture: { kind: 'text', title: 'Two ways' }, answers: ['n0'] } });
    owner(
      ink('i1', { targets: [{ item: 'pic' }], hint: 'circle' }),
      note('n1', 'why this one?', { on: { item: 'pic', sub: 'q:1' } }),
      { type: 'item.add', chapter: CH, item: { id: 'l1', kind: 'lasso', box: [0, 0, 100, 100], path: [0, 0, 100, 0, 100, 100, 0, 100], targets: [{ item: 'pic' }, { item: 'n0' }] } },
      ink('i2', { targets: [{ item: 'pic' }], hint: 'cross' }),
      { type: 'item.remove', item: 'i2' },
    );

    const r = await call(s.origin, s.tokens.agent, `${ROUTES.items}?ids=pic, i1,l1,nope,pic,n0,i2`);
    expect(r.status).toBe(200);
    const items = r.body.items as Array<Record<string, any>>;
    expect(items.map((i) => i.item.id)).toEqual(['pic', 'i1', 'l1', 'n0', 'i2']);
    const [pic, i1, l1, n0, i2] = items;
    expect(pic).toMatchObject({ by: 'agent', chapter: CH, removed: false, event: expect.any(String), marks: ['i1', 'n1', 'l1'] });
    expect(pic!.item).toMatchObject({ kind: 'picture', picture: { kind: 'text', title: 'Two ways' }, answers: ['n0'] });
    expect(i1!.item).not.toHaveProperty('strokes');
    expect(i1!.item).toMatchObject({ kind: 'ink', hint: 'circle', targets: [{ item: 'pic' }], box: [0, 0, 50, 50] });
    expect(i1!.marks).toEqual([]);
    expect(l1!.item).not.toHaveProperty('path');
    expect(l1!.item.targets).toHaveLength(2);
    expect(n0!.marks).toEqual(['l1']);
    // A mark taken off the board is still an item, and no longer counts as a mark on anything.
    expect(i2).toMatchObject({ removed: true });

    expect((await call(s.origin, s.tokens.agent, ROUTES.items)).status).toBe(400);
    const many = Array.from({ length: 51 }, (_, i) => `x${i}`).join(',');
    expect((await call(s.origin, s.tokens.agent, `${ROUTES.items}?ids=${many}`)).status).toBe(400);
    expect((await call(s.origin, s.tokens.agent, `${ROUTES.items}?ids=pic`, { method: 'POST' })).status).toBe(405);
    expect((await call(s.origin, undefined, `${ROUTES.items}?ids=pic`)).status).toBe(401);
  });
});

describe('keel-board with a builder', () => {
  const servers: RunningServer[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
  });

  async function cli(...argv: string[]) {
    return cliWith({}, ...argv);
  }

  async function cliWith(deps: RunDeps, ...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l), stdin: async () => '' };
    const r = await run(argv, io, deps);
    if (r.server) servers.push(r.server);
    return { ...r, out, err };
  }

  /** A repository with one commit: the command checks that a built part's commit is there. */
  function gitRepo(): { repo: string; commit: string } {
    const repo = tempRepo();
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'first');
    return { repo, commit: git('rev-parse', 'HEAD') };
  }

  /** Build the chapter to done, and end the run with a page to show from the builder's own folder. */
  async function buildWithShow(s: RunningServer, fake: Fake, commit: string): Promise<void> {
    const dir = path.join(fake.ctx.stateDir!, 'show');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Built</h1>');
    solidChapter(s);
    buildThis(s);
    await until(() => fake.jobs.length === 1);
    for (const part of ['door', 'bridge', 'engine']) {
      await fake.post({ type: 'part.state', part, state: 'building' }, 'agent');
      await fake.post({ type: 'part.state', part, state: 'built', commit, check: { cmd: 'npm test', passed: true } }, 'system');
    }
    fake.finish({ outcome: 'done', show: { dir, page: 'index.html' } });
    await until(() => said(s).length === 1);
  }

  it('opens the page, then a finished build\'s page behind what the owner is doing, and neither with --no-browser', async () => {
    const browsed: Array<[string, boolean]> = [];
    const browse = (url: string, background: boolean) => browsed.push([url, background]);

    const { repo, commit } = gitRepo();
    let n = fakes.length;
    const opened = await cliWith({ browse }, 'open', repo, '--port', '0', '--app-dir', path.join(repo, 'no-app'), '--builder', FAKE);
    expect(opened.code).toBe(0);
    const s = opened.server!;
    expect(browsed).toEqual([[s.url, false]]);
    await buildWithShow(s, fakes[n]!, commit);
    expect(said(s).map((f) => f.text)).toEqual([SHOW_OPENED]);
    expect(browsed).toEqual([
      [s.url, false],
      [pageUrl(s), true],
    ]);

    const { repo: quiet, commit: other } = gitRepo();
    n = fakes.length;
    const q = await cliWith({ browse }, 'open', quiet, '--no-browser', '--port', '0', '--app-dir', path.join(quiet, 'no-app'), '--builder', FAKE);
    await buildWithShow(q.server!, fakes[n]!, other);
    expect(said(q.server!).map((f) => f.text)).toEqual([SHOW_WAITS]);
    expect(pageUrl(q.server!)).toBeDefined();
    expect(browsed).toHaveLength(2);
  });

  it('loads --builder, and status says which builder and how far the build is', async () => {
    const repo = tempRepo();
    const n = fakes.length;
    const opened = await cli('open', repo, '--no-browser', '--port', '0', '--app-dir', path.join(repo, 'no-app'), '--builder', FAKE);
    expect(opened.code).toBe(0);
    expect(opened.err.join('\n')).toMatch(/builder: fake-builder/);
    const s = opened.server!;
    const fake = fakes[n]!;

    expect((await cli('status', repo)).out).toContain('builder  fake-builder · nothing to build');
    solidChapter(s);
    buildThis(s);
    await until(() => fake.jobs.length === 1);
    expect((await cli('status', repo)).out).toContain(`builder  fake-builder · building "Idea ${CH}": 0 of 3 parts built, now The door`);
    as(s, 'owner')({ type: 'build.pause', chapter: CH });
    await until(() => !s.builds.busy);
    expect((await cli('status', repo)).out).toContain(`builder  fake-builder · "Idea ${CH}" is paused: 0 of 3 parts built`);
  });

  it('runs no builder with --builder none, and refuses a module with no createBuilder', async () => {
    const repo = tempRepo();
    const opened = await cli('open', repo, '--no-browser', '--port', '0', '--app-dir', path.join(repo, 'no-app'), '--builder', 'none');
    expect(opened.code).toBe(0);
    expect((await cli('status', repo)).out).toContain('builder  none · nothing to build');

    const other = tempRepo();
    const mod = path.join(path.dirname(other), 'not-a-builder.mjs');
    fs.writeFileSync(mod, 'export const nothing = 1;\n');
    const refused = await cli('open', other, '--no-browser', '--port', '0', '--builder', mod);
    expect(refused.code).toBe(1);
    expect(refused.err.join('\n')).toMatch(/does not export createBuilder/);
    expect(fs.existsSync(path.join(other, '.keel/board/server.json'))).toBe(false);
  });
});
