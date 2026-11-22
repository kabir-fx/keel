import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Board, Info, World } from './join-board';
import { NODE, alive, buildIdea, built, cleanUp, copyOf, leftovers, listen, makeWorld, missingBundles, openBoard, remoteMoves, until } from './join-board';

/**
 * "Try it, approve it, merge it" with the real board server and the real hosted builder, over
 * HTTP and websockets, and no page: the fake `claude` stands in for the model. Each test has a
 * bare repository as the remote, the owner's clone, and a private state folder of its own, and
 * looks at git and at the log for what happened.
 *
 * Needs the bundles: `npm run build -w @keel/board-server -w @keel/board-plugin`.
 */

/** An app that answers at PORT on 127.0.0.1 and starts a child of its own, and says both pids. */
const APP_JS = [
  "const child = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
  "require('http').createServer((q, s) => s.end('hello from the built app')).listen(+process.env.PORT, '127.0.0.1', () => console.log('listening pid=' + process.pid + ' child=' + child.pid));",
  '',
].join('\n');
/**
 * The builder has taken up a part: building, or built with the turn not yet over. A part is
 * "building" for a few milliseconds on a fast machine, so a wait for that state alone can sleep
 * through it. FAKE_SLOW_MS holds the turn open after the part is built.
 */
const taken = (state: { model: { parts: Record<string, { state?: string } | undefined> } }, part: string) => ['building', 'built'].includes(state.model.parts[part]?.state ?? '');
/** A command line tool that asks a name and greets it. */
const GREET_JS = "process.stdout.write('your name? ');\nprocess.stdin.once('data', (d) => { console.log('hello, ' + String(d).trim() + '!'); process.exit(0); });\n";
const FILES = { 'app.js': APP_JS, 'greet.js': GREET_JS };
const SETUP = 'mkdir -p deps && echo ran >> deps/count';
const APP = { kind: 'app' as const, run: `"${NODE}" app.js` };
const TERMINAL = { kind: 'terminal' as const, run: `"${NODE}" greet.js` };

let w: World;
let boards: Board[];

test.beforeAll(() => {
  test.skip(missingBundles() !== undefined, `build first: npm run build -w @keel/board-server -w @keel/board-plugin (missing ${missingBundles()})`);
});

test.beforeEach(() => {
  test.setTimeout(180_000);
  w = makeWorld();
  boards = [];
});

test.afterEach(async () => {
  for (const b of boards) await b.stop();
  const left = await until('every process of the test to end', () => (leftovers(w).length === 0 ? true : undefined), 15_000).catch(() => leftovers(w));
  cleanUp(w);
  expect(left).toBe(true);
});

async function open(env: Record<string, string> = {}, linkOpts: Record<string, string> = {}): Promise<Board> {
  const b = await openBoard(w, { FAKE_FILES: JSON.stringify(FILES), ...env }, linkOpts);
  boards.push(b);
  return b;
}

/** An adder on the board's first canvas, with the setup and an app to try, built. */
async function builtAdder(env: Record<string, string> = {}): Promise<Board> {
  const b = await open(env);
  await buildIdea(b, { chapter: 'adder', title: 'An adder', parts: ['sum', 'cli'], setup: SETUP, show: APP });
  await built(b, 'adder');
  return b;
}

const tip = (ref: string) => w.git('rev-parse', ref);
const isAncestor = (a: string, b: string) => {
  try {
    w.git('merge-base', '--is-ancestor', a, b);
    return true;
  } catch {
    return false;
  }
};
const branches = () => w.git('branch', '--list', 'board/*').split('\n').map((l) => l.replace(/^[*+ ]+/, '')).filter(Boolean);
const ownerView = () => ({ head: tip('HEAD'), on: w.git('rev-parse', '--abbrev-ref', 'HEAD'), status: w.git('status', '--porcelain', '--untracked-files=all', '--', '.', ':!.keel') });
const merged = (b: Board) => b.log().filter((e) => e.type === 'canvas.merged');
const feedOf = (b: Board, chapter: string) => b.log().filter((e) => e.type === 'feed.add' && e.chapter === chapter);
const get = (url: string) =>
  new Promise<string>((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => (body += d.toString()));
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });

/** Start the app of a chapter, wait until it answers, and read its pid and its child's from what it printed. */
async function startApp(b: Board, chapter: string): Promise<{ url: string; pid: number; child: number }> {
  const r = await b.call('/api/show', { action: 'start', chapter, run: APP.run });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const on = await until('the app to answer', async () => {
    const s = (await b.info()).shows?.[chapter];
    if (s?.kind === 'app' && s.state === 'failed') throw new Error(`the app failed: ${s.note}`);
    return s?.kind === 'app' && s.state === 'on' ? s : undefined;
  });
  const show = await listen(b, `/ws/show?chapter=${chapter}`);
  const out = await until('the app to say its pids', () => show.messages.map((m) => (m.t === 'out' ? String(m.data) : '')).join('').match(/listening pid=(\d+) child=(\d+)/) ?? undefined);
  show.ws.close();
  return { url: on.url!, pid: Number(out[1]), child: Number(out[2]) };
}

async function approve(b: Board, canvas: string): Promise<void> {
  await b.must('owner', { type: 'canvas.approve', canvas });
}

/** Wait until the server is done with a canvas's branch: nothing busy. */
async function settled(b: Board, canvas: string): Promise<Info> {
  return until(`the server to be done with canvas "${canvas}"`, async () => {
    const i = await b.info();
    return i.works?.[canvas]?.busy === undefined ? i : undefined;
  });
}

test('the board opens: main is brought level with origin before it loads, and again before a build starts', async () => {
  const atOpen = remoteMoves(w, { 'news.txt': 'one\n' });
  expect(tip('main')).not.toBe(atOpen);
  const b = await open();
  expect(tip('main')).toBe(atOpen);
  const home = (await b.info()).home!;
  expect(home).toMatchObject({ branch: 'main', upstream: 'origin/main', sync: 'level', commit: atOpen.slice(0, 7) });
  expect(fs.readFileSync(path.join(w.repo, 'news.txt'), 'utf8')).toBe('one\n');

  const beforeBuild = remoteMoves(w, { 'more.txt': 'two\n' });
  await buildIdea(b, { chapter: 'adder', title: 'An adder', parts: ['sum'] });
  await built(b, 'adder');
  expect(tip('main')).toBe(beforeBuild);
  expect(w.git('merge-base', 'main', 'board/an-adder')).toBe(beforeBuild);
  expect((await b.info()).home).toMatchObject({ sync: 'level', commit: beforeBuild.slice(0, 7) });
  expect(feedOf(b, 'adder').some((e) => e.text?.includes(`from main at ${beforeBuild.slice(0, 7)}`))).toBe(true);
});

test('"Build this" with a setup and an app: the branch from the title and the home commit, the setup, each part through the check, the smoke run, the copy kept, the owner\'s folder untouched', async () => {
  const b = await open();
  const before = ownerView();
  const home = tip('main');
  await buildIdea(b, { chapter: 'adder', title: 'An adder', parts: ['sum', 'cli'], setup: SETUP, show: APP });
  await built(b, 'adder');

  expect(branches()).toEqual(['board/an-adder']);
  expect(w.git('merge-base', 'main', 'board/an-adder')).toBe(home);
  const ahead = Number(w.git('rev-list', '--count', 'main..board/an-adder'));
  expect(ahead).toBeGreaterThan(2);
  // Counted once the run has ended, with the builder's last commit, the brief's result.
  const work = await until('the branch to be counted', async () => {
    const x = (await b.info()).works?.adder;
    return x?.ahead === ahead ? x : undefined;
  }, 5_000);
  expect(work).toEqual({ branch: 'board/an-adder', ahead, behind: 0 });

  // The setup ran once, in the copy, before the first part.
  const copy = copyOf(w, 'adder');
  expect(fs.readFileSync(path.join(copy, 'deps', 'count'), 'utf8')).toBe('ran\n');
  const texts = feedOf(b, 'adder').map((e) => e.text ?? '');
  const ready = texts.findIndex((t) => t.startsWith('The builder made its copy ready'));
  expect(ready).toBeGreaterThan(-1);
  expect(ready).toBeLessThan(texts.findIndex((t) => t.includes('The sum part is in')));

  // Each part went building, by the builder, then built, by the server's check on a commit of the branch.
  for (const part of ['sum', 'cli']) {
    const states = b.log().filter((e) => e.type === 'part.state' && e.part === part);
    expect(states.map((e) => [e.by, e.state])).toEqual([
      ['agent', 'building'],
      ['system', 'built'],
    ]);
    expect(isAncestor(states[1]!.commit!, 'board/an-adder')).toBe(true);
  }
  // The app started and answered once: the server's side says so with build.proved, after the
  // last part, and the board writes the feed line itself.
  const log = b.log();
  const proved = log.filter((e) => e.type === 'build.proved');
  expect(proved.map((e) => [e.by, e.chapter])).toEqual([['system', 'adder']]);
  expect(log.indexOf(proved[0]!)).toBeGreaterThan(log.findLastIndex((e) => e.type === 'part.state' && e.state === 'built'));
  expect(texts.some((t) => t.startsWith('The app started and answered'))).toBe(false);
  const said = (await b.state()).feed.filter((f) => f.chapter === 'adder' && f.text.startsWith('The app started and answered'));
  expect(said.map((f) => [f.by, f.kind, f.text])).toEqual([['system', 'state', `The app started and answered, as you will try it: \`${APP.run}\`.`]]);
  expect(texts.at(-1)).toMatch(/^Every part is built, on the branch board\/an-adder.*Try it on the board, then approve it to merge it into main\.$/);

  // The copy stays, with what was built; the owner's folder and branch are as they were.
  expect(fs.readFileSync(path.join(copy, 'app.js'), 'utf8')).toBe(APP_JS);
  expect(ownerView()).toEqual(before);
  expect(fs.existsSync(path.join(w.repo, 'app.js'))).toBe(false);
  expect(tip('main')).toBe(home);
});

test('try it, an app: starting, then on at 127.0.0.1; it answers with what was built; the output is replayed; stop ends it and its child', async () => {
  const b = await builtAdder();
  const page = await listen(b, '/ws');
  const off = (await b.info()).shows?.adder;
  expect(off).toEqual({ kind: 'app', run: APP.run, state: 'off' });

  const started = await b.call('/api/show', { action: 'start', chapter: 'adder', run: APP.run });
  expect(started.status).toBe(200);
  expect(started.body.show).toMatchObject({ kind: 'app', state: 'starting' });
  const { url, pid, child } = await startApp(b, 'adder');
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  expect(await get(url)).toBe('hello from the built app');
  const states = page.messages.filter((m) => m.t === 'works').map((m) => (m.shows as Record<string, { state: string }>).adder?.state);
  expect(states.indexOf('starting')).toBeGreaterThan(-1);
  expect(states.indexOf('on')).toBeGreaterThan(states.indexOf('starting'));

  // A page that joins late hears what the app printed so far.
  const late = await listen(b, '/ws/show?chapter=adder');
  await until('the replay', () => late.messages.some((m) => m.t === 'out' && String(m.data).includes(`listening pid=${pid} child=${child}`)));
  expect(late.messages[0]).toMatchObject({ t: 'out' });

  expect(alive(pid) && alive(child)).toBe(true);
  const stopped = await b.call('/api/show', { action: 'stop', chapter: 'adder' });
  expect(stopped.status).toBe(200);
  expect(stopped.body.show).toEqual({ kind: 'app', run: APP.run, state: 'off' });
  await until('the app and its child to end', () => !alive(pid) && !alive(child));
  await late.closed;
  page.ws.close();
});

test('try it, a terminal on a second canvas: the prompt, what is typed, the command\'s output, and the exit code', async () => {
  const b = await builtAdder();
  await buildIdea(b, { chapter: 'greet', title: 'A greeter', canvas: 'tools', newCanvas: true, parts: ['hello'], show: TERMINAL });
  await built(b, 'greet');
  expect((await b.info()).shows?.greet).toEqual({ kind: 'terminal', run: TERMINAL.run, state: 'off' });

  const r = await b.call('/api/show', { action: 'start', chapter: 'greet', run: TERMINAL.run, cols: 100, rows: 30 });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.show).toEqual({ kind: 'terminal', run: TERMINAL.run, state: 'on' });
  const term = await listen(b, '/ws/show?chapter=greet');
  const out = () => term.messages.map((m) => (m.t === 'out' ? String(m.data) : '')).join('');
  await until('the command to ask', () => out().includes('your name? '));
  expect(out()).toContain('greet.js');
  term.ws.send(JSON.stringify({ t: 'in', data: 'Ada\r' }));
  await until('the greeting', () => out().includes('hello, Ada!'));
  expect(out().indexOf('Ada')).toBeLessThan(out().indexOf('hello, Ada!'));
  term.ws.send(JSON.stringify({ t: 'in', data: 'exit 7\r' }));
  await term.closed;
  expect(term.messages.at(-1)).toEqual({ t: 'end', code: 7 });
  expect((await b.info()).shows?.greet).toEqual({ kind: 'terminal', run: TERMINAL.run, state: 'ended', code: 7 });
});

test('a press that names a command that is not the idea\'s is refused, and nothing runs; the idea\'s own runs, and says it is not boxed in on a machine with no box', async () => {
  const b = await builtAdder({ KEEL_SANDBOX: 'none' });
  const marker = path.join(w.root, 'ran');
  const r = await b.call('/api/show', { action: 'start', chapter: 'adder', run: `touch ${marker}` });
  expect(r.status).toBe(409);
  expect(r.body.reason).toBe('That is not the command "An adder" is tried with. Nothing was run.');
  await new Promise((res) => setTimeout(res, 500));
  expect(fs.existsSync(marker)).toBe(false);
  expect((await b.info()).shows?.adder).toEqual({ kind: 'app', run: APP.run, state: 'off' });
  expect(leftovers(w).filter((l) => l.includes('app.js') || l.includes(marker))).toEqual([]);

  const { pid } = await startApp(b, 'adder');
  expect((await b.info()).shows?.adder).toMatchObject({ kind: 'app', state: 'on', boxed: false });
  await b.call('/api/show', { action: 'stop', chapter: 'adder' });
  await until('the app to end', () => !alive(pid, 'none'));
});

test('approve with main level: merged at the branch\'s tip, the owner\'s folder has the files, the branch and the copy are gone, the show is stopped', async () => {
  const b = await builtAdder();
  const at = tip('board/an-adder');
  const { pid, child } = await startApp(b, 'adder');
  await approve(b, 'adder');
  const [m] = await until('canvas.merged', () => (merged(b).length ? merged(b) : undefined));
  expect(m).toMatchObject({ by: 'system', canvas: 'adder', commit: at, into: 'main' });
  expect(tip('main')).toBe(at);
  expect(fs.readFileSync(path.join(w.repo, 'app.js'), 'utf8')).toBe(APP_JS);
  expect(fs.existsSync(path.join(w.repo, 'parts', 'cli.txt'))).toBe(true);
  expect(w.git('status', '--porcelain', '--', '.', ':!.keel')).toBe('');
  const info = await settled(b, 'adder');
  expect(branches()).toEqual([]);
  expect(fs.existsSync(copyOf(w, 'adder'))).toBe(false);
  expect(info.works?.adder?.branch).toBeUndefined();
  expect(info.shows?.adder).toBeUndefined();
  expect(alive(pid) || alive(child)).toBe(false);
  expect((await b.state()).chapters.adder?.merged).toMatchObject({ commit: at, into: 'main' });
});

test('approve after main moved without a conflict: main is joined in, the checks run, main fast-forwards to a commit that holds both', async () => {
  const b = await builtAdder();
  const built = tip('board/an-adder');
  const elsewhere = remoteMoves(w, { 'other.txt': 'theirs\n' });
  await approve(b, 'adder');
  const [m] = await until('canvas.merged', () => (merged(b).length ? merged(b) : undefined));
  expect(tip('main')).toBe(m!.commit);
  expect(isAncestor(elsewhere, 'main') && isAncestor(built, 'main')).toBe(true);
  expect(w.git('rev-list', '--parents', '-n', '1', 'main').split(' ')).toHaveLength(3);
  expect(fs.readFileSync(path.join(w.repo, 'other.txt'), 'utf8')).toBe('theirs\n');
  expect(fs.existsSync(path.join(w.repo, 'parts', 'sum.txt'))).toBe(true);
  expect(feedOf(b, 'adder').filter((e) => e.kind === 'problem')).toEqual([]);
});

test('approve after main moved with what fails the agreed check once joined: nothing moves, and the feed says why', async () => {
  const b = await builtAdder();
  const elsewhere = remoteMoves(w, { 'parts/theirs.txt': 'FAIL\n' });
  await approve(b, 'adder');
  const problem = await until('a problem in the feed', () => feedOf(b, 'adder').find((e) => e.kind === 'problem'));
  expect(problem.text).toMatch(/^main could not be joined into this idea, so nothing was merged: Joined with main at [0-9a-f]{7}, the check `! grep -rqs FAIL parts` fails \(exit 1\)/);
  await settled(b, 'adder');
  expect(tip('main')).toBe(elsewhere);
  expect(isAncestor(elsewhere, 'board/an-adder')).toBe(false);
  expect(merged(b)).toEqual([]);
});

test('approve after main moved with a conflict: the builder joins them, the owner is asked to try it again, main does not move; a second approve merges', async () => {
  const b = await builtAdder({ FAKE_FILES: JSON.stringify({ ...FILES, 'README.md': '# built\n' }), FAKE_RESOLVE: JSON.stringify({ 'README.md': '# joined\n' }) });
  const elsewhere = remoteMoves(w, { 'README.md': '# elsewhere\n' });
  await approve(b, 'adder');
  const again = await until('the feed to ask for another try', () => feedOf(b, 'adder').find((e) => e.text?.includes('try it again, then approve again')));
  expect(again).toMatchObject({ by: 'system', kind: 'update' });
  expect(again.text).toBe('main had changed the same places as this idea. The builder joined the two and the checks passed. What you tried has changed: try it again, then approve again.');
  await settled(b, 'adder');
  expect(merged(b)).toEqual([]);
  expect(tip('main')).toBe(elsewhere);
  expect(isAncestor(elsewhere, 'board/an-adder')).toBe(true);
  expect(w.git('show', 'board/an-adder:README.md')).toBe('# joined');
  const turns = fs.readFileSync(w.claudeLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { turn?: string });
  expect(turns.filter((t) => t.turn?.startsWith('JOIN main INTO board/an-adder.'))).toHaveLength(1);

  await approve(b, 'adder');
  const [m] = await until('canvas.merged', () => (merged(b).length ? merged(b) : undefined));
  expect(tip('main')).toBe(m!.commit);
  expect(fs.readFileSync(path.join(w.repo, 'README.md'), 'utf8')).toBe('# joined\n');
});

test('approve while the owner has an uncommitted change in a file the merge writes: nothing moves, the feed names the file, the change is intact', async () => {
  const b = await builtAdder({ FAKE_FILES: JSON.stringify({ ...FILES, 'README.md': '# built\n' }) });
  const home = tip('main');
  fs.writeFileSync(path.join(w.repo, 'README.md'), '# mine, not committed\n');
  await approve(b, 'adder');
  const problem = await until('a problem in the feed', () => feedOf(b, 'adder').find((e) => e.kind === 'problem'));
  expect(problem.text).toBe('Your changes in README.md are in the way of main. Commit or stash them, then approve again.');
  await settled(b, 'adder');
  expect(tip('main')).toBe(home);
  expect(fs.readFileSync(path.join(w.repo, 'README.md'), 'utf8')).toBe('# mine, not committed\n');
  expect(fs.existsSync(path.join(w.repo, 'app.js'))).toBe(false);
  expect(merged(b)).toEqual([]);
  expect(branches()).toEqual(['board/an-adder']);
});

test('two ideas on one canvas, one after the other: one branch with both, approve refused while the second builds, one approval merges both', async () => {
  const b = await builtAdder({ FAKE_SLOW_MS: '700' });
  const first = tip('board/an-adder');
  await buildIdea(b, { chapter: 'minus', title: 'A subtractor', canvas: 'adder', parts: ['diff', 'neg'] });
  await until('the second idea to build', async () => taken(await b.state(), 'diff'));
  const refused = await b.post('owner', { type: 'canvas.approve', canvas: 'adder' });
  expect(refused.ok).toBe(false);
  expect(refused.status).toBe(422);
  await built(b, 'minus');

  expect(branches()).toEqual(['board/an-adder']);
  expect(isAncestor(first, 'board/an-adder')).toBe(true);
  for (const e of b.log().filter((x) => x.type === 'part.state' && x.state === 'built')) expect(isAncestor(e.commit!, 'board/an-adder')).toBe(true);
  expect(b.log().filter((x) => x.type === 'part.state' && x.state === 'built').map((x) => x.part)).toEqual(['sum', 'cli', 'diff', 'neg']);
  const at = tip('board/an-adder');

  await approve(b, 'adder');
  const all = await until('canvas.merged', () => (merged(b).length ? merged(b) : undefined));
  expect(all).toHaveLength(1);
  expect(all[0]).toMatchObject({ canvas: 'adder', commit: at });
  const s = await b.state();
  expect([s.chapters.adder?.merged?.commit, s.chapters.minus?.merged?.commit]).toEqual([at, at]);
  for (const f of ['sum', 'cli', 'diff', 'neg']) expect(fs.existsSync(path.join(w.repo, 'parts', `${f}.txt`))).toBe(true);
});

test('two canvases: two branches, each from the same home commit', async () => {
  const home = tip('main');
  const b = await builtAdder();
  await buildIdea(b, { chapter: 'greet', title: 'A greeter', canvas: 'tools', newCanvas: true, parts: ['hello'], show: TERMINAL });
  await built(b, 'greet');
  expect(branches().sort()).toEqual(['board/a-greeter', 'board/an-adder']);
  expect(w.git('merge-base', 'main', 'board/an-adder')).toBe(home);
  expect(w.git('merge-base', 'main', 'board/a-greeter')).toBe(home);
  expect(w.git('merge-base', 'board/an-adder', 'board/a-greeter')).toBe(home);
  const works = await until('both branches counted', async () => {
    const x = (await b.info()).works;
    return x?.adder?.ahead !== undefined && x.tools?.ahead !== undefined ? x : undefined;
  });
  expect([works.adder?.branch, works.tools?.branch]).toEqual(['board/an-adder', 'board/a-greeter']);
});

test('push: the remote has the merged commit, and home goes from ahead to level', async () => {
  const b = await builtAdder();
  await approve(b, 'adder');
  const [m] = await until('canvas.merged', () => (merged(b).length ? merged(b) : undefined));
  const ahead = await until('home to be ahead', async () => {
    const h = (await b.info()).home;
    return h?.sync === 'ahead' ? h : undefined;
  });
  expect(ahead.ahead).toBe(Number(w.git('rev-list', '--count', 'origin/main..main')));
  const r = await b.call('/api/push', {});
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ ok: true, home: { branch: 'main', sync: 'level' } });
  expect(w.otherGit('ls-remote', 'origin', 'refs/heads/main').split('\t')[0]).toBe(m!.commit);
  expect((await b.info()).home?.sync).toBe('level');
});

test('delete a canvas while its idea builds, then one that is built and not merged: the run stops, the branch and copy go, the other is untouched', async () => {
  const b = await builtAdder({ FAKE_SLOW_MS: '1500' });
  const adderTip = tip('board/an-adder');
  await buildIdea(b, { chapter: 'greet', title: 'A greeter', canvas: 'tools', newCanvas: true, parts: ['one', 'two', 'three'], show: TERMINAL });
  await until('the greeter to build', async () => taken(await b.state(), 'one'));
  expect(branches().sort()).toEqual(['board/a-greeter', 'board/an-adder']);

  await b.must('owner', { type: 'canvas.remove', canvas: 'tools' });
  await until('the greeter\'s branch and copy to go', async () => {
    const i = await b.info();
    return !branches().includes('board/a-greeter') && !fs.existsSync(copyOf(w, 'tools')) && i.works?.tools === undefined && i.build === undefined;
  });
  expect(b.log().filter((e) => e.type === 'canvas.remove').map((e) => [e.by, e.canvas])).toEqual([['owner', 'tools']]);
  await until('the greeter\'s builder process to end', () => leftovers(w).every((l) => !l.includes('fake-builder-claude')));
  const s = await b.state();
  expect(s.chapters.greet).toBeUndefined();
  expect(s.removedCanvases.tools).toBeDefined();
  // The adder is as it was.
  expect(tip('board/an-adder')).toBe(adderTip);
  expect(fs.existsSync(path.join(copyOf(w, 'adder'), 'app.js'))).toBe(true);
  expect((await b.info()).works?.adder?.branch).toBe('board/an-adder');
  expect(s.chapters.adder?.state).toBe('built');

  await b.must('owner', { type: 'canvas.remove', canvas: 'adder' });
  await until('the adder\'s branch and copy to go', async () => !branches().length && !fs.existsSync(copyOf(w, 'adder')) && (await b.info()).works?.adder === undefined);
  expect(b.log().filter((e) => e.type === 'canvas.remove').map((e) => e.canvas)).toEqual(['tools', 'adder']);
  expect(merged(b)).toEqual([]);
  expect(fs.existsSync(path.join(w.repo, 'app.js'))).toBe(false);
});

test('the server stops and starts again between built and approve: the show starts again, nothing merged by itself, approve still works', async () => {
  const first = await builtAdder();
  const home = tip('main');
  const at = tip('board/an-adder');
  await first.stop();

  const b = await open();
  const info = await settled(b, 'adder');
  expect(info.works?.adder?.branch).toBe('board/an-adder');
  expect(info.shows?.adder).toEqual({ kind: 'app', run: APP.run, state: 'off' });
  expect(merged(b)).toEqual([]);
  expect(tip('main')).toBe(home);

  const { url, pid } = await startApp(b, 'adder');
  expect(await get(url)).toBe('hello from the built app');
  await approve(b, 'adder');
  const [m] = await until('canvas.merged', () => (merged(b).length ? merged(b) : undefined));
  expect(m).toMatchObject({ commit: at, into: 'main' });
  expect(tip('main')).toBe(at);
  await until('the show to end with the approval', () => !alive(pid));
});

/** The app of APP_JS, which waits for a database that is not there until `deps/db-up` is in its folder. */
const WAITING_APP_JS = [
  "if (!require('fs').existsSync('deps/db-up')) {",
  "  console.log('the app waits for its database');",
  '  setInterval(() => {}, 1000);',
  '} else {',
  APP_JS,
  '}',
  '',
].join('\n');

test('an app that never answers: the idea is never built, nothing is tried or approved, main does not move; Try again runs it again, and once it answers it is built, tried and merged', async () => {
  const b = await open({ FAKE_FILES: JSON.stringify({ 'app.js': WAITING_APP_JS }) }, { 'app-wait': '2' });
  const home = tip('main');
  await buildIdea(b, { chapter: 'adder', title: 'An adder', parts: ['sum', 'cli'], setup: SETUP, show: APP });
  const stopped = await until('the build to stop', () => feedOf(b, 'adder').find((e) => e.kind === 'problem' && e.by === 'system' && e.text?.startsWith('The build of')), 60_000);
  expect(stopped.text).toMatch(/^The build of "An adder" stopped: The app does not start: `"[^`]+`\. The app did not answer on port \d+ within 2 s\. The builder's turn made no fix\. It printed: "the app waits for(?: its database"\.|.*…) 2 of 2 parts are built\. Press Try again to go on\.$/);
  const turns = () => fs.readFileSync(w.claudeLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { turn?: string });
  expect(turns().filter((t) => t.turn?.startsWith('THE APP DOES NOT START'))).toHaveLength(1);

  // Every part is built, and the idea is not: no build.proved, nothing to try, nothing to approve.
  const s = await b.state();
  expect(s.chapters.adder?.state).toBe('building');
  expect([s.model.parts.sum?.state, s.model.parts.cli?.state]).toEqual(['built', 'built']);
  expect(b.log().filter((e) => e.type === 'build.proved')).toEqual([]);
  expect((await b.info()).build).toEqual(expect.objectContaining({ chapter: 'adder', state: 'stopped' }));
  const refused = await b.post('owner', { type: 'canvas.approve', canvas: 'adder' });
  expect([refused.status, refused.body.reason]).toEqual([422, '"An adder" is still building on this canvas, and every idea on a canvas shares its branch. Approve when it is built.']);
  const tried = await b.call('/api/show', { action: 'start', chapter: 'adder', run: APP.run });
  expect([tried.status, tried.body.reason]).toEqual([409, '"An adder" is not built yet, so there is nothing to try.']);
  expect(tip('main')).toBe(home);
  expect(merged(b)).toEqual([]);

  // The database is up now. Try again, as the page does it: pause, then resume. The run goes
  // straight to the start: no part is built twice.
  fs.writeFileSync(path.join(copyOf(w, 'adder'), 'deps', 'db-up'), '');
  await b.must('owner', { type: 'build.pause', chapter: 'adder' });
  await b.must('owner', { type: 'build.resume', chapter: 'adder' });
  await until('the idea to be built and the run to end', async () => {
    const c = (await b.state()).chapters.adder;
    const i = await b.info();
    return c?.state === 'built' && i.build?.chapter !== 'adder' && i.works?.adder?.busy === undefined;
  }, 60_000);
  expect(b.log().filter((e) => e.type === 'build.proved').map((e) => [e.by, e.chapter])).toEqual([['system', 'adder']]);
  expect(b.log().filter((e) => e.type === 'part.state' && e.state === 'built').map((e) => e.part)).toEqual(['sum', 'cli']);
  expect(turns().filter((t) => t.turn?.startsWith('THE APP DOES NOT START'))).toHaveLength(1);

  const { url } = await startApp(b, 'adder');
  expect(await get(url)).toBe('hello from the built app');
  const at = tip('board/an-adder');
  await approve(b, 'adder');
  const [m] = await until('canvas.merged', () => (merged(b).length ? merged(b) : undefined));
  expect(m).toMatchObject({ commit: at, into: 'main' });
  expect(tip('main')).toBe(at);
});

test('a second canvas with the title of a merged one: its brief and decision record get names of their own, and the merged brief in main is kept', async () => {
  const b = await builtAdder();
  await approve(b, 'adder');
  await until('canvas.merged', () => (merged(b).length ? merged(b) : undefined));
  await settled(b, 'adder');
  const brief = w.git('show', 'main:docs/briefs/an-adder.md');
  const decision = w.git('show', 'main:docs/adr/0001-an-adder.md');
  expect(brief).toContain('An adder');

  await buildIdea(b, { chapter: 'again', title: 'An adder', canvas: 'second', newCanvas: true, parts: ['carry'], show: APP });
  await built(b, 'again');
  const branch = (await settled(b, 'second')).works?.second?.branch;
  expect(branch).toBe('board/an-adder');
  const files = w.git('ls-tree', '-r', '--name-only', branch!).split('\n');
  expect(files.filter((f) => f.startsWith('docs/'))).toEqual(['docs/adr/0001-an-adder.md', 'docs/adr/0002-an-adder-2.md', 'docs/briefs/an-adder-2.md', 'docs/briefs/an-adder.md']);
  expect(w.git('show', `${branch}:docs/briefs/an-adder.md`)).toBe(brief);
  expect(w.git('show', `${branch}:docs/adr/0001-an-adder.md`)).toBe(decision);

  await approve(b, 'second');
  await until('the second canvas.merged', () => (merged(b).length === 2 ? merged(b) : undefined));
  expect(w.git('show', 'main:docs/briefs/an-adder.md')).toBe(brief);
  expect(w.git('show', 'main:docs/adr/0001-an-adder.md')).toBe(decision);
  expect(w.git('show', 'main:docs/briefs/an-adder-2.md')).toContain('An adder');
  expect(fs.readFileSync(path.join(w.repo, 'docs', 'briefs', 'an-adder.md'), 'utf8')).toBe(`${brief}\n`);
});
