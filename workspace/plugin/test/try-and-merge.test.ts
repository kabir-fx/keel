import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BuildJob, BuildPlace, Builder, BuilderContext, ShowPlan, ShowRequest, ShowSession } from '@keel/protocol';
import { canvasTitle, renderBrief } from '@keel/protocol';
import { runCheck } from '../src/build-tools';
import { buildPlaces, createBuilder, readPlace } from '../src/hosted-builder';
import { sandboxKind } from '../src/sandbox';
import { aliveInBox } from './box';
import { NO_PTY_LINE } from '../src/session';
import { BCH, buildBoard, makeRepo, sh } from './build-board';
import type { FakeBoard } from './fake-board';

/**
 * The builder's part of "try it, approve it, merge it" (records 0013 and 0014): the branch
 * from the home branch's commit, named from the title; the setup; the smoke run of an app;
 * the copy that stays; a show of an app or a terminal; refresh with each of its outcomes; and
 * discard. Real git, real processes, and the fake `claude` for the builder's turns.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, 'fake-builder-claude.mjs');
const MCP_SRC = path.join(here, 'mcp-src.mjs');
const CHECK = '! grep -rqs FAIL parts';

/** An app that answers at PORT on 127.0.0.1, and says where. */
const SERVER = "require('http').createServer((q, s) => s.end('hello from the app')).listen(+process.env.PORT, '127.0.0.1', () => console.log('listening on ' + process.env.PORT));\n";
/** An app that runs and never listens. */
const DEAF = "console.log('starting, and never listening'); setInterval(() => {}, 1000);\n";
const node = JSON.stringify(process.execPath);

let tmp: string;
let repo: string;
let stateDir: string;
let logFile: string;
let bin: string;
let board: FakeBoard;
let builders: Builder[];
let logs: string[];
let placed: Array<{ chapter: string; place: BuildPlace; events: number }>;
const saved = { ...process.env };

function ctx(options: Record<string, string> = {}): BuilderContext {
  return {
    repoDir: repo,
    boardDir: path.join(repo, '.keel', 'board'),
    stateDir,
    serverUrl: board.url,
    agentToken: board.tokens.agent,
    systemToken: board.tokens.system,
    options: { bin, mcp: MCP_SRC, 'app-wait': '3', ...options },
    presence: () => undefined,
    log: (m) => logs.push(m),
    place: (chapter, place) => placed.push({ chapter, place, events: board.events.length }),
  };
}

async function builder(options: Record<string, string> = {}): Promise<Builder> {
  const b = await createBuilder(ctx(options));
  builders.push(b);
  return b;
}

const main = () => sh(repo, 'git', 'rev-parse', 'main');

function job(o: { setup?: string; show?: ShowPlan } = {}): BuildJob {
  const c = board.state.chapters[BCH]!;
  return {
    chapter: BCH,
    canvas: c.canvas,
    canvasTitle: canvasTitle(board.state, c.canvas),
    title: c.title,
    track: c.track.filter((id) => board.state.model.parts[id]?.state !== 'built').map((id) => ({ id, name: board.state.model.parts[id]!.name })),
    check: c.check!,
    brief: renderBrief(board.state, BCH)!,
    resume: false,
    base: { branch: 'main', commit: main() },
    ...(o.setup ? { setup: o.setup } : {}),
    ...(o.show ? { show: o.show } : {}),
  };
}

function records(): Array<{ start?: boolean; turn?: string }> {
  try {
    return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { start?: boolean; turn?: string });
  } catch {
    return [];
  }
}

const branch = () => readPlace(stateDir, BCH)!.branch;
const pidFiles = () => {
  try {
    return fs.readdirSync(buildPlaces(stateDir, BCH).pids);
  } catch {
    return [];
  }
};
const until = async (what: () => boolean, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (what()) return;
  throw new Error('timed out');
};
/**
 * The builder has taken up a part: building, or built with the turn not yet over. A part is
 * "building" for about 20 ms where the check has no box, so a wait for that state alone can
 * sleep through it. FAKE_SLOW_MS holds the turn open after the part is built.
 */
const taken = (part: string) => ['building', 'built'].includes(board.state.model.parts[part]?.state ?? '');
const get = (url: string) =>
  new Promise<string>((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => (body += d.toString()));
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });

/** The subject of the branch's last commit at each `build.proved` the board is sent. */
function tipsAtProof(): string[] {
  const tips: string[] = [];
  const post = board.post.bind(board);
  board.post = (by, drafts) => {
    if (drafts.some((d) => (d as { type?: string }).type === 'build.proved')) tips.push(sh(repo, 'git', 'log', '-1', '--format=%s', branch()));
    return post(by, drafts);
  };
  return tips;
}

/** What a show printed and how it ended, as the server would collect it. */
function watch(plan: ShowRequest['plan'], extra: Partial<ShowRequest> = {}) {
  const seen = { out: '', exits: [] as Array<number | null> };
  const req: ShowRequest = { chapter: BCH, canvas: BCH, plan, onOutput: (t) => (seen.out += t), onExit: (c) => seen.exits.push(c), ...extra };
  return { req, seen };
}

/** A build of one part that commits these files, done. */
async function built(o: { setup?: string; show?: ShowPlan; files?: Record<string, string>; options?: Record<string, string> } = {}): Promise<Builder> {
  board = await buildBoard({ check: CHECK, parts: ['sum'], ...(o.setup ? { setup: o.setup } : {}), ...(o.show ? { show: o.show } : {}) });
  if (o.files) process.env.FAKE_FILES = JSON.stringify(o.files);
  const b = await builder(o.options);
  const r = await b.run(job(o));
  expect(r.outcome, r.note).toBe('done');
  delete process.env.FAKE_FILES;
  return b;
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keel-try-')));
  repo = makeRepo(path.join(tmp, 'repo'), { 'README.md': '# toy\n', '.gitignore': 'deps/\n' });
  stateDir = path.join(tmp, 'state');
  process.env.KEEL_STATE_DIR = stateDir;
  logFile = path.join(tmp, 'claude.log');
  bin = path.join(tmp, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  process.env.FAKE_CLAUDE_LOG = logFile;
  builders = [];
  logs = [];
  placed = [];
});

afterEach(async () => {
  for (const b of builders) await b.close();
  await board?.stop();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a build (5.2)', () => {
  it('starts from the home branch\'s commit, not from where the owner\'s folder is', async () => {
    const home = main();
    sh(repo, 'git', 'checkout', '--quiet', '-b', 'feat/mine');
    fs.writeFileSync(path.join(repo, 'mine.txt'), 'mine\n');
    sh(repo, 'git', 'add', 'mine.txt');
    sh(repo, 'git', 'commit', '--quiet', '-m', 'mine');
    board = await buildBoard({ check: CHECK, parts: ['sum'] });
    const r = await (await builder()).run({ ...job(), base: { branch: 'main', commit: home } });
    expect(r.outcome, r.note).toBe('done');
    expect(sh(repo, 'git', 'merge-base', branch(), 'feat/mine')).toBe(home);
    expect(sh(repo, 'git', 'ls-tree', '-r', '--name-only', branch())).not.toContain('mine.txt');
    expect(sh(repo, 'git', 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/mine');
    expect(board.state.feed.some((f) => f.text.includes(`from main at ${home.slice(0, 7)}`))).toBe(true);
  }, 60_000);

  it('names the branch from the title, -2 when the owner has that name, and tells the server before the first part', async () => {
    sh(repo, 'git', 'branch', 'board/an-adder');
    board = await buildBoard({ check: CHECK, parts: ['sum'] });
    const r = await (await builder()).run(job());
    expect(r.outcome, r.note).toBe('done');
    expect(branch()).toBe('board/an-adder-2');
    expect(placed.map((p) => [p.chapter, p.place])).toEqual([[BCH, { branch: 'board/an-adder-2' }]]);
    const firstBuilding = board.events.findIndex((e) => e.type === 'part.state');
    expect(placed[0]!.events).toBeLessThanOrEqual(firstBuilding);
    // The owner's branch of that name is untouched.
    expect(sh(repo, 'git', 'rev-parse', 'board/an-adder')).toBe(main());
    expect(sh(repo, 'git', 'ls-tree', '--name-only', '-r', branch())).toContain('docs/briefs/an-adder.md');
  }, 60_000);

  it('a chapter keeps the branch it has: its own from an earlier run, and board/<chapter id> from before names', async () => {
    sh(repo, 'git', 'branch', `board/${BCH}`);
    board = await buildBoard({ check: CHECK, parts: ['sum'] });
    const r = await (await builder()).run(job());
    expect(r.outcome, r.note).toBe('done');
    expect(branch()).toBe(`board/${BCH}`);
    expect(sh(repo, 'git', 'branch', '--list', 'board/*').split('\n').map((l) => l.replace(/^[*+ ]+/, ''))).toEqual([`board/${BCH}`]);
  }, 60_000);

  it('runs the setup once before the first part, with the network, and not again on a resumed run', async () => {
    const srv = net.createServer((s) => s.end()).listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const port = (srv.address() as net.AddressInfo).port;
    const reach = `${node} -e "require('net').connect(${port}, '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(9))"`;
    const setup = `${reach} && mkdir -p deps && echo ran >> deps/count`;
    try {
      board = await buildBoard({ check: CHECK, setup });
      process.env.FAKE_SLOW_MS = '400';
      const b = await builder();
      const first = b.run(job({ setup }));
      await until(() => taken('sum'));
      await b.pause();
      expect((await first).outcome).toBe('paused');
      delete process.env.FAKE_SLOW_MS;
      const r = await b.run({ ...job({ setup }), resume: true });
      expect(r.outcome, r.note).toBe('done');
      const count = path.join(buildPlaces(stateDir, BCH).tree, 'deps', 'count');
      expect(fs.readFileSync(count, 'utf8')).toBe('ran\n');
      const ready = board.state.feed.findIndex((f) => f.text.startsWith('The builder made its copy ready'));
      expect(ready).toBeGreaterThan(-1);
      expect(ready).toBeLessThan(board.state.feed.findIndex((f) => f.text.includes('The sum part is in')));
      // The check has no network: the same reach fails there.
      if (sandboxKind().kind !== 'none') expect((await runCheck(reach, tmp, 10_000)).code).toBe(9);
    } finally {
      srv.close();
    }
  }, 60_000);

  it('the setup may write to the package caches and the copy, and nowhere else in the home folder', async () => {
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home);
    process.env.HOME = home;
    const setup = 'mkdir -p "$HOME/.npm" && echo c > "$HOME/.npm/cached" && (echo x > "$HOME/stray" || true) && mkdir -p deps';
    await built({ setup });
    expect(fs.readFileSync(path.join(home, '.npm', 'cached'), 'utf8')).toBe('c\n');
    if (sandboxKind().kind !== 'none') expect(fs.existsSync(path.join(home, 'stray'))).toBe(false);
  }, 60_000);

  it('a setup that fails stops the build with the end of its output, before any part', async () => {
    board = await buildBoard({ check: CHECK, setup: 'echo resolving; echo "no such package: lefpad" >&2; exit 3' });
    const r = await (await builder()).run(job({ setup: 'echo resolving; echo "no such package: lefpad" >&2; exit 3' }));
    expect(r.outcome).toBe('failed');
    expect(r.note).toMatch(/^The setup `.*` failed \(exit 3\): .*no such package: lefpad/);
    expect(r.note!.length).toBeLessThanOrEqual(200);
    expect(records().some((x) => x.start)).toBe(false);
    expect(board.state.model.parts.sum?.state).toBe('solid');
  }, 60_000);

  it('a part that adds a dependency file gets one more setup run before its check; a part that adds none gets none', async () => {
    const setup = 'mkdir -p deps && echo ran >> deps/count';
    const count = () => fs.readFileSync(path.join(buildPlaces(stateDir, BCH).tree, 'deps', 'count'), 'utf8').split('\n').filter(Boolean).length;
    board = await buildBoard({ check: CHECK, parts: ['sum', 'cli'], setup });
    // The first part adds a manifest; the second changes none.
    process.env.FAKE_FILES = JSON.stringify({ 'package.json': '{"dependencies":{"left-pad":"1.3.0"}}\n' });
    const r = await (await builder()).run(job({ setup }));
    expect(r.outcome, r.note).toBe('done');
    expect(count()).toBe(2);
    expect(board.state.feed.filter((f) => f.kind === 'problem')).toEqual([]);
  }, 60_000);

  it('with no dependency file changed, the setup runs once for the whole build', async () => {
    const setup = 'mkdir -p deps && echo ran >> deps/count';
    board = await buildBoard({ check: CHECK, parts: ['sum', 'cli'], setup });
    const r = await (await builder()).run(job({ setup }));
    expect(r.outcome, r.note).toBe('done');
    expect(fs.readFileSync(path.join(buildPlaces(stateDir, BCH).tree, 'deps', 'count'), 'utf8')).toBe('ran\n');
  }, 60_000);

  it('a setup run again that fails is reported as the setup, not the check, and the part is not built', async () => {
    const setup = 'test ! -f package.json || { echo "no such package: lefpad" >&2; exit 7; }';
    board = await buildBoard({ check: CHECK, parts: ['sum'], setup });
    process.env.FAKE_FILES = JSON.stringify({ 'package.json': '{"dependencies":{"lefpad":"1"}}\n' });
    const r = await (await builder()).run(job({ setup }));
    expect(r.outcome).toBe('failed');
    expect(board.state.model.parts.sum?.state).toBe('building');
    const problems = board.state.feed.filter((f) => f.kind === 'problem').map((f) => f.text);
    expect(problems.some((t) => t.startsWith('A dependency file changed, and the setup') && t.includes('failed before the check of The sum') && t.includes('lefpad'))).toBe(true);
    expect(problems.some((t) => t.startsWith('The check'))).toBe(false);
    const tried = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { tool?: string; text?: string }).filter((x) => x.tool === 'board_try');
    expect(tried[0]?.text).toContain('the setup');
    expect(tried[0]?.text).toContain('The check did not run');
  }, 60_000);

  it('an app is started once when every part is built: it answered, the last commit is made, then build.proved, and nothing is left running', async () => {
    const show: ShowPlan = { kind: 'app', run: `${node} server.js` };
    board = await buildBoard({ check: CHECK, parts: ['sum'], show });
    const tips = tipsAtProof();
    process.env.FAKE_FILES = JSON.stringify({ 'server.js': SERVER });
    const r = await (await builder()).run(job({ show }));
    expect(r.outcome, r.note).toBe('done');
    expect(board.events.filter((e) => e.type === 'build.proved').map((e) => e.by)).toEqual(['system']);
    expect(tips).toEqual(['An adder: the brief, with the result']);
    expect(sh(repo, 'git', 'log', '-1', '--format=%s', branch())).toBe('An adder: the brief, with the result');
    expect(sh(repo, 'git', 'show', `${branch()}:docs/briefs/an-adder.md`)).toContain('**State:** built, 1 of 1 parts.');
    expect(board.state.chapters[BCH]?.state).toBe('built');
    expect(board.state.feed.filter((f) => f.text.startsWith('The app started and answered')).map((f) => f.text)).toEqual([`The app started and answered, as you will try it: \`${show.run}\`.`]);
    expect(records().filter((x) => x.turn?.startsWith('THE APP'))).toEqual([]);
    expect(logs.filter((l) => l.includes('no show:'))).toEqual([]);
    expect(pidFiles()).toEqual([]);
  }, 60_000);

  it('an app that never answers gets one builder turn, with its output; still not, and the run fails with what it printed, the idea building', async () => {
    const show: ShowPlan = { kind: 'app', run: 'sh app.sh' };
    board = await buildBoard({ check: CHECK, parts: ['sum'], show });
    process.env.FAKE_FILES = JSON.stringify({ 'server.js': DEAF, 'app.sh': `exec ${node} server.js\n` });
    const r = await (await builder()).run(job({ show }));
    expect(r.outcome).toBe('failed');
    expect(r.note).toMatch(/^The app does not start: `sh app\.sh`\. The app did not answer on port \d+ within 3 s\. The builder's turn made no fix\. It printed: "starting, and never listening"\.$/);
    expect(r.note!.length).toBeLessThanOrEqual(200);
    const turns = records().filter((x) => x.turn?.startsWith('THE APP DOES NOT START'));
    expect(turns).toHaveLength(1);
    expect(turns[0]!.turn).toContain('did not answer on port');
    expect(turns[0]!.turn).toContain('starting, and never listening');
    expect(board.state.feed.some((f) => f.kind === 'problem' && f.text.startsWith('The app did not start'))).toBe(true);
    expect(board.events.some((e) => e.type === 'build.proved')).toBe(false);
    expect(board.state.chapters[BCH]?.state).toBe('building');
    expect(board.state.feed.some((f) => /started and answered|Every part is built|Try it/.test(f.text))).toBe(false);
    expect(sh(repo, 'git', 'log', '--format=%s', branch())).not.toContain('with the result');
    expect(pidFiles()).toEqual([]);
  }, 60_000);

  it('an app that ends at once: the note says its exit and what it printed', async () => {
    const show: ShowPlan = { kind: 'app', run: 'sh quit.sh' };
    board = await buildBoard({ check: CHECK, parts: ['sum'], show });
    process.env.FAKE_FILES = JSON.stringify({ 'quit.js': "console.error('Error: missing .env'); process.exit(3);\n", 'quit.sh': `exec ${node} quit.js\n` });
    const r = await (await builder()).run(job({ show }));
    expect(r.outcome).toBe('failed');
    expect(r.note).toMatch(/^The app does not start: `sh quit\.sh`\. The app ended before it answered \(exit 3\)\. The builder's turn made no fix\. It printed: "Error: missing \.env"\.$/);
    expect(board.state.chapters[BCH]?.state).toBe('building');
  }, 60_000);

  it('a second run on an app that did not answer goes to the start check, in a copy made anew with its setup, builds no part again, and is proved once it answers', async () => {
    const show: ShowPlan = { kind: 'app', run: `${node} server.js` };
    const setup = 'mkdir -p deps && echo ran >> deps/count';
    board = await buildBoard({ check: CHECK, parts: ['sum', 'cli'], setup, show });
    process.env.FAKE_FILES = JSON.stringify({ 'server.js': DEAF });
    const b = await builder();
    expect((await b.run(job({ setup, show }))).outcome).toBe('failed');
    delete process.env.FAKE_FILES;
    const partsAt = board.events.filter((e) => e.type === 'part.state').length;
    const toolsAt = records().length;
    // The server restarted in between: the copy is gone.
    sh(repo, 'git', 'worktree', 'remove', '--force', buildPlaces(stateDir, BCH).tree);
    // The fixed app answers only when the setup ran in its copy.
    process.env.FAKE_START_FIX = JSON.stringify({ 'server.js': `require('fs').statSync('deps/count');\n${SERVER}` });
    const tips = tipsAtProof();
    const again = { ...job({ setup, show }), resume: true };
    // The server's job for an idea that waits for its app: no part left on the track.
    expect(again.track).toEqual([]);
    const feedAt = board.state.feed.length;
    const r = await b.run(again);
    expect(r.outcome, r.note).toBe('done');
    expect(board.events.filter((e) => e.type === 'part.state').length).toBe(partsAt);
    const later = records().slice(toolsAt) as Array<{ turn?: string; tool?: string }>;
    expect(later.filter((x) => x.tool === 'board_part' || x.tool === 'board_check')).toEqual([]);
    expect(later.filter((x) => x.turn).map((x) => x.turn!.split('.')[0])).toEqual(['THE APP DOES NOT START']);
    expect(board.state.feed.some((f) => f.text === `Every part is built on ${branch()}. The builder starts the app once, as you will try it, to see that it answers.`)).toBe(true);
    expect(tips).toEqual(['An adder: the brief, with the result']);
    expect(board.events.filter((e) => e.type === 'build.proved')).toHaveLength(1);
    expect(board.state.chapters[BCH]?.state).toBe('built');
    expect(board.state.feed.slice(feedAt).some((f) => /^(Building|Built):/.test(f.text))).toBe(false);
    expect(sh(repo, 'git', 'log', '--format=%s', `main..${branch()}`).split('\n').reverse()).toEqual([
      'An adder: the brief and the decision record',
      'sum: the part',
      'cli: the part',
      'the app starts',
      'An adder: the brief, with the result',
    ]);
  }, 60_000);

  it('an app the builder\'s turn fixes: its fix passes the check and comes before the last commit, the app answers, and the build is done', async () => {
    board = await buildBoard({ check: CHECK, parts: ['sum'], show: { kind: 'app', run: `${node} server.js` } });
    const tips = tipsAtProof();
    process.env.FAKE_FILES = JSON.stringify({ 'server.js': DEAF });
    process.env.FAKE_START_FIX = JSON.stringify({ 'server.js': SERVER });
    const r = await (await builder()).run(job({ show: { kind: 'app', run: `${node} server.js` } }));
    expect(r.outcome, r.note).toBe('done');
    expect(sh(repo, 'git', 'log', '--format=%s', '-2', branch()).split('\n')).toEqual(['An adder: the brief, with the result', 'the app starts']);
    expect(tips).toEqual(['An adder: the brief, with the result']);
    expect(board.state.chapters[BCH]?.state).toBe('built');
    expect(board.state.feed.filter((f) => f.text.startsWith('The app start')).map((f) => f.text)).toEqual([`The app started and answered, as you will try it: \`${node} server.js\`.`]);
  }, 60_000);

  it('a terminal or a page is not started at the end, is built with its last part, and looks for no page', async () => {
    await built({ show: { kind: 'terminal', run: 'echo hi > ran.txt' } });
    expect(fs.existsSync(path.join(buildPlaces(stateDir, BCH).tree, 'ran.txt'))).toBe(false);
    expect(board.state.feed.some((f) => f.text.includes('The app'))).toBe(false);
    expect(board.events.some((e) => e.type === 'build.proved')).toBe(false);
    expect(board.state.chapters[BCH]?.state).toBe('built');
    expect(logs.filter((l) => l.includes('no show:'))).toEqual([]);
  }, 60_000);

  it('with no show named, a build with no page says so in the log', async () => {
    await built();
    expect(logs.some((l) => l.includes('no show: no index.html'))).toBe(true);
  }, 60_000);
});

describe('try it (5.3, the builder\'s rows)', () => {
  it('an app: started with PORT on 127.0.0.1, answers, prints, and stop ends it and a child of its child', async () => {
    const run = `sh -c '(sleep 300 &) ; sleep 301 & echo "grand=$!"; exec ${process.execPath} server.js'`;
    const b = await built({ files: { 'server.js': SERVER } });
    const { req, seen } = watch({ kind: 'app', run });
    const s = await b.show!(req);
    const url = await s.ready!;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(await get(url)).toBe('hello from the app');
    await until(() => seen.out.includes('listening on'));
    const grand = Number(/grand=(\d+)/.exec(seen.out)![1]);
    expect(aliveInBox(grand)).toBe(true);
    expect(pidFiles()).toHaveLength(1);
    await s.stop();
    expect(aliveInBox(grand)).toBe(false);
    expect(sh(tmp, 'sh', '-c', 'ps -A -o command= | grep -c "[s]leep 30[01]" || true')).toBe('0');
    expect(seen.exits).toHaveLength(1);
    expect(pidFiles()).toEqual([]);
    await expect(get(url)).rejects.toThrow();
  }, 60_000);

  it('a show says it is not boxed in on a machine with no box, and says nothing when it is', async () => {
    const b = await built({ files: { 'server.js': SERVER } });
    const boxed = await b.show!(watch({ kind: 'app', run: `${node} server.js` }).req);
    await boxed.ready;
    expect(boxed.boxed).toBe(sandboxKind().kind === 'none' ? false : undefined);
    await boxed.stop();
    process.env.KEEL_SANDBOX = 'none';
    const app = await b.show!(watch({ kind: 'app', run: `${node} server.js` }).req);
    const term = await b.show!(watch({ kind: 'terminal', run: 'echo hi' }).req);
    await app.ready;
    expect([app.boxed, term.boxed]).toEqual([false, false]);
    await Promise.all([app.stop(), term.stop()]);
  }, 60_000);

  it('an app that never answers: ready rejects after the wait, and the app is stopped', async () => {
    const b = await built({ files: { 'server.js': DEAF }, options: { 'app-wait': '2' } });
    const { req, seen } = watch({ kind: 'app', run: `${node} server.js` });
    const s = await b.show!(req);
    await expect(s.ready!).rejects.toThrow(/^The app did not answer on port \d+ within 2 s\.$/);
    expect(seen.out).toContain('never listening');
    expect(seen.exits).toHaveLength(1);
    expect(pidFiles()).toEqual([]);
  }, 60_000);

  it('an app that ends before it answers: ready rejects with its exit code', async () => {
    const b = await built();
    const { req, seen } = watch({ kind: 'app', run: 'echo "missing .env" >&2; exit 4' });
    const s = await b.show!(req);
    await expect(s.ready!).rejects.toThrow('The app ended before it answered (exit 4).');
    expect(seen.out).toContain('missing .env');
    expect(seen.exits).toEqual([4]);
  }, 60_000);

  it('a fixed port that is taken: refused before anything runs; two apps get a port each', async () => {
    const b = await built({ files: { 'server.js': SERVER } });
    const other = net.createServer().listen(0, '127.0.0.1');
    await new Promise((r) => other.once('listening', r));
    const port = (other.address() as net.AddressInfo).port;
    try {
      const { req, seen } = watch({ kind: 'app', run: `${node} server.js`, port });
      await expect(b.show!(req)).rejects.toThrow(`Port ${port} is in use by another program.`);
      expect(seen.exits).toEqual([]);
      expect(pidFiles()).toEqual([]);
    } finally {
      other.close();
    }
    const one = await b.show!(watch({ kind: 'app', run: `${node} server.js` }).req);
    const two = await b.show!(watch({ kind: 'app', run: `${node} server.js` }).req);
    const [u1, u2] = await Promise.all([one.ready!, two.ready!]);
    expect(u1).not.toBe(u2);
    await Promise.all([one.stop(), two.stop()]);
  }, 60_000);

  it('a terminal: the size it was given, the command typed in, keys echoed, a resize, and its exit code', async () => {
    const b = await built();
    const { req, seen } = watch({ kind: 'terminal', run: 'echo started-$((1+2))' }, { cols: 101, rows: 33 });
    const s = await b.show!(req);
    await until(() => seen.out.includes('started-3'));
    s.write('stty size\r');
    await until(() => seen.out.includes('33 101'));
    s.write('echo typed-$((2*21))\r');
    await until(() => seen.out.includes('typed-42'));
    // The pty echoes what was typed, and ends its lines with CR LF.
    expect(seen.out).toContain('echo typed-$((2*21))\r\n');
    s.resize(120, 40);
    await new Promise((r) => setTimeout(r, 500));
    s.write('stty size\r');
    await until(() => seen.out.includes('40 120'));
    s.write('exit 5\r');
    await until(() => seen.exits.length > 0);
    expect(seen.exits).toEqual([5]);
    await s.stop();
    expect(pidFiles()).toEqual([]);
  }, 60_000);

  it('a terminal with no script command runs on pipes, and says so in its first line', async () => {
    const b = await built();
    // Git and what /bin holds stay on the PATH; `script` does not. On Linux /bin is /usr/bin, and holds `script`.
    const bin = path.join(tmp, 'no-script');
    fs.mkdirSync(bin);
    for (const name of fs.readdirSync('/bin')) if (name !== 'script') fs.symlinkSync(path.join('/bin', name), path.join(bin, name));
    if (!fs.existsSync(path.join(bin, 'git'))) fs.symlinkSync(sh(tmp, 'sh', '-c', 'command -v git'), path.join(bin, 'git'));
    process.env.PATH = bin;
    const { req, seen } = watch({ kind: 'terminal', run: 'echo piped-$((3+4))' });
    const s = await b.show!(req);
    expect(seen.out.startsWith(`${NO_PTY_LINE}\r\n`)).toBe(true);
    await until(() => seen.out.includes('piped-7\r\n'));
    s.write('echo again\r');
    await until(() => seen.out.includes('again\r\n'));
    expect(seen.out).toContain('echo again\r\n');
    s.write('exit 6\r');
    await until(() => seen.exits.length > 0);
    expect(seen.exits).toEqual([6]);
  }, 60_000);

  it('the copy gone: made again from the branch, with the setup; no branch: nothing to try', async () => {
    const setup = 'mkdir -p deps && echo ran >> deps/count';
    const b = await built({ setup });
    const places = buildPlaces(stateDir, BCH);
    sh(repo, 'git', 'worktree', 'remove', '--force', places.tree);
    const { req, seen } = watch({ kind: 'terminal', run: 'cat deps/count; ls parts' });
    const s = await b.show!(req);
    await until(() => seen.out.includes('sum.txt'));
    expect(seen.out).toContain('ran');
    await s.stop();
    expect(await b.discard!({ canvas: BCH, branch: true })).toMatchObject({ ok: true });
    await expect(b.show!(watch({ kind: 'terminal', run: 'true' }).req)).rejects.toThrow('This machine has no copy of this build, and no branch for it.');
  }, 60_000);

  it('a show a crash left running is ended when the next builder starts, by its pid file', async () => {
    const b = await built({ files: { 'server.js': SERVER } });
    const { req, seen } = watch({ kind: 'app', run: `sh -c 'echo "pid=$$"; exec ${process.execPath} server.js'` });
    const s = await b.show!(req);
    await s.ready;
    const pid = Number(/pid=(\d+)/.exec(seen.out)![1]);
    expect(pidFiles()).toHaveLength(1);
    await builder();
    expect(aliveInBox(pid)).toBe(false);
    expect(pidFiles()).toEqual([]);
    expect(logs.some((l) => l.includes('ended 1 show on canvas adder left from before'))).toBe(true);
  }, 60_000);

  it('close ends every show', async () => {
    const b = await built({ files: { 'server.js': SERVER } });
    const { req, seen } = watch({ kind: 'app', run: `${node} server.js` });
    const s: ShowSession = await b.show!(req);
    const url = await s.ready!;
    await b.close();
    expect(seen.exits).toHaveLength(1);
    await expect(get(url)).rejects.toThrow();
  }, 60_000);
});

describe('refresh (5.4, step 5)', () => {
  /** A commit on main in the owner's folder. */
  const onMain = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
    sh(repo, 'git', 'add', file);
    sh(repo, 'git', 'commit', '--quiet', '-m', `main: ${file}`);
    return main();
  };
  const refresh = (b: Builder) => b.refresh!({ canvas: BCH, home: { branch: 'main', commit: main() }, checks: [CHECK], setups: [] });

  it('level: the branch holds main already, nothing is done', async () => {
    const b = await built();
    const tip = sh(repo, 'git', 'rev-parse', branch());
    expect(await refresh(b)).toEqual({ outcome: 'level' });
    expect(sh(repo, 'git', 'rev-parse', branch())).toBe(tip);
  }, 60_000);

  it('joined: main is merged in in the copy, the check passes on the result, and main does not move', async () => {
    const b = await built();
    const home = onMain('other.txt', 'from main\n');
    const r = await refresh(b);
    expect(r.outcome, r.note).toBe('joined');
    expect(r.note).toMatch(/^main at [0-9a-f]{7} is joined in at [0-9a-f]{7,}, and `! grep -rqs FAIL parts` passed\.$/);
    expect(sh(repo, 'git', 'merge-base', '--is-ancestor', home, branch())).toBe('');
    expect(main()).toBe(home);
    expect(sh(repo, 'git', 'status', '--porcelain')).toBe('');
  }, 60_000);

  it('failed: the check does not pass on the joined result, and the branch is left as it was', async () => {
    const b = await built();
    const tip = sh(repo, 'git', 'rev-parse', branch());
    onMain('parts/bad.txt', 'FAIL\n');
    const r = await refresh(b);
    expect(r.outcome).toBe('failed');
    expect(r.note).toMatch(/^Joined with main at [0-9a-f]{7}, the check `! grep -rqs FAIL parts` fails \(exit 1\)/);
    expect(sh(repo, 'git', 'rev-parse', branch())).toBe(tip);
  }, 60_000);

  it('resolved: the two changed the same lines, a builder turn joins them, and the check passes', async () => {
    const b = await built();
    const home = onMain('parts/sum.txt', 'the sum part, as main has it\n');
    process.env.FAKE_RESOLVE = JSON.stringify({ 'parts/sum.txt': 'the sum part, joined\n' });
    const r = await refresh(b);
    expect(r.outcome, r.note).toBe('resolved');
    expect(r.note).toMatch(/^main had changed the same lines\. The builder joined the two at [0-9a-f]{7,}, and `.*` passed\.$/);
    const turn = records().find((x) => x.turn?.startsWith('JOIN main INTO'))!.turn!;
    expect(turn).toContain('parts/sum.txt');
    expect(sh(repo, 'git', 'show', `${branch()}:parts/sum.txt`)).toBe('the sum part, joined');
    expect(sh(repo, 'git', 'merge-base', '--is-ancestor', home, branch())).toBe('');
  }, 60_000);

  it('failed: a conflict the builder\'s turn does not join leaves the branch as it was, with no merge half done', async () => {
    const b = await built();
    const tip = sh(repo, 'git', 'rev-parse', branch());
    onMain('parts/sum.txt', 'the sum part, as main has it\n');
    const r = await refresh(b);
    expect(r.outcome).toBe('failed');
    expect(r.note).toContain('main and this idea changed the same lines in parts/sum.txt');
    expect(sh(repo, 'git', 'rev-parse', branch())).toBe(tip);
    const tree = buildPlaces(stateDir, BCH).tree;
    expect(fs.readFileSync(path.join(tree, 'parts', 'sum.txt'), 'utf8')).toBe('the sum part\n');
  }, 60_000);
});

describe('discard', () => {
  it('with the branch: the copy, the private files and the branch are gone; the owner\'s branch is not touched', async () => {
    const b = await built();
    const name = branch();
    const r = await b.discard!({ canvas: BCH, branch: true });
    expect(r).toEqual({ ok: true, note: `The copy and the branch ${name} are gone.` });
    expect(sh(repo, 'git', 'branch', '--list', name)).toBe('');
    expect(fs.existsSync(buildPlaces(stateDir, BCH).base)).toBe(false);
    expect(sh(repo, 'git', 'worktree', 'list', '--porcelain')).not.toContain(stateDir);
    expect(sh(repo, 'git', 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
  }, 60_000);

  it('without the branch: the copy goes and the branch stays, and a show makes the copy again', async () => {
    const b = await built();
    const name = branch();
    const tip = sh(repo, 'git', 'rev-parse', name);
    expect(await b.discard!({ canvas: BCH, branch: false })).toEqual({ ok: true, note: 'The copy is gone. The branch stays.' });
    expect(fs.existsSync(buildPlaces(stateDir, BCH).tree)).toBe(false);
    expect(sh(repo, 'git', 'rev-parse', name)).toBe(tip);
    const { req, seen } = watch({ kind: 'terminal', run: 'ls parts' });
    const s = await b.show!(req);
    await until(() => seen.out.includes('sum.txt'));
    await s.stop();
  }, 60_000);
});

describe('canvases: the branch and the copy are the canvas\'s', () => {
  /** A second idea on the board, decided and started: on `canvas`, made first when `title` is given. */
  function addChapter(chapter: string, name: string, parts: string[], canvas: string, title?: string): void {
    if (title) board.must('owner', { type: 'canvas.open', canvas, title });
    board.must(
      'owner',
      { type: 'chapter.open', chapter, title: name, canvas },
      { type: 'item.add', chapter, item: { id: `${chapter}-m1`, kind: 'note', box: [0, 0, 200, 100], text: `The ${name}` } },
    );
    board.must('agent', { type: 'model.patch', chapter, ops: parts.map((id) => ({ op: 'part.set', part: { id, name: `The ${id}`, plain: `the ${id} part` } })) });
    board.must('agent', {
      type: 'item.add',
      chapter,
      item: { id: `${chapter}-bp`, kind: 'picture', answers: [`${chapter}-m1`], picture: { kind: 'blueprint', title: 'The blueprint', picks: [{ text: name, from: { item: `${chapter}-m1` } }], proof: ['it works'], parts, check: CHECK } },
    });
    board.must('owner', { type: 'solidify', chapter, picks: [`${chapter}-bp`], parts });
    board.must('owner', { type: 'build.start', chapter, track: parts, blueprint: `${chapter}-bp`, check: CHECK });
  }

  function jobFor(chapter: string): BuildJob {
    const c = board.state.chapters[chapter]!;
    return {
      chapter,
      canvas: c.canvas,
      canvasTitle: canvasTitle(board.state, c.canvas),
      title: c.title,
      track: c.track.map((id) => ({ id, name: board.state.model.parts[id]!.name })),
      check: CHECK,
      brief: renderBrief(board.state, chapter)!,
      resume: false,
      base: { branch: 'main', commit: main() },
    };
  }

  it('two ideas on one canvas, one after the other: one branch, one copy, both sets of commits and records', async () => {
    const b = await built();
    const first = branch();
    addChapter('mul', 'A multiplier', ['times'], BCH);
    const r = await b.run(jobFor('mul'));
    expect(r.outcome, r.note).toBe('done');
    expect(branch()).toBe(first);
    expect(fs.readdirSync(path.join(stateDir, 'build'))).toEqual([BCH]);
    expect(placed.map((p) => p.place.branch)).toEqual([first, first]);
    const log = sh(repo, 'git', 'log', '--format=%s', `main..${first}`).split('\n').reverse();
    expect(log).toEqual([
      'An adder: the brief and the decision record',
      'sum: the part',
      'An adder: the brief, with the result',
      'A multiplier: the brief and the decision record',
      'times: the part',
      'A multiplier: the brief, with the result',
    ]);
    const files = sh(repo, 'git', 'ls-tree', '-r', '--name-only', first).split('\n');
    expect(files).toEqual(expect.arrayContaining(['docs/briefs/an-adder.md', 'docs/briefs/a-multiplier.md', 'docs/adr/0001-an-adder.md', 'docs/adr/0002-a-multiplier.md', 'parts/sum.txt', 'parts/times.txt']));
    expect(board.state.feed.some((f) => f.text.includes('on top of what the canvas built there before'))).toBe(true);
    expect(sh(repo, 'git', 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length).toBe(2);
  }, 60_000);

  it('a later idea on a canvas, in a copy made anew, gets the setups the canvas agreed to before its first part', async () => {
    const b = await built({ setup: 'mkdir -p deps && echo ran >> deps/count' });
    const tree = buildPlaces(stateDir, BCH).tree;
    sh(repo, 'git', 'worktree', 'remove', '--force', tree);
    addChapter('mul', 'A multiplier', ['times'], BCH);
    const r = await b.run(jobFor('mul'));
    expect(r.outcome, r.note).toBe('done');
    expect(fs.readFileSync(path.join(tree, 'deps', 'count'), 'utf8')).toBe('ran\n');
  }, 60_000);

  it('a brief and a decision record of the same name in the repository are the owner\'s: kept byte for byte, and the builder\'s land beside them', async () => {
    repo = makeRepo(path.join(tmp, 'owned'), { 'README.md': '# toy\n', 'docs/briefs/an-adder.md': 'OWNER BRIEF\n', 'docs/adr/0004-an-adder.md': 'OWNER RECORD\n' });
    await built();
    const files = sh(repo, 'git', 'ls-tree', '-r', '--name-only', branch()).split('\n');
    expect(files).toEqual(expect.arrayContaining(['docs/briefs/an-adder.md', 'docs/briefs/an-adder-2.md', 'docs/adr/0004-an-adder.md', 'docs/adr/0005-an-adder-2.md']));
    expect(sh(repo, 'git', 'diff', '--stat', `main..${branch()}`, '--', 'docs/briefs/an-adder.md', 'docs/adr/0004-an-adder.md')).toBe('');
    expect(sh(repo, 'git', 'show', `${branch()}:docs/briefs/an-adder-2.md`)).toContain('**State:** built, 1 of 1 parts.');
    expect(board.state.feed.some((f) => f.text.includes('It committed the brief (docs/briefs/an-adder-2.md) and the decision record (docs/adr/0005-an-adder-2.md) first.'))).toBe(true);
    expect(board.state.feed.some((f) => f.text.startsWith('The builder goes on'))).toBe(false);
  }, 60_000);

  it('a second canvas with the title of a merged one writes records of its own, on board/an-adder again', async () => {
    const b = await built();
    sh(repo, 'git', 'merge', '--quiet', '--ff-only', branch());
    expect((await b.discard!({ canvas: BCH, branch: true })).ok).toBe(true);
    const ownBrief = sh(repo, 'git', 'show', 'main:docs/briefs/an-adder.md');
    addChapter('adder2', 'An adder', ['times'], 'again', 'An adder');
    const r = await b.run(jobFor('adder2'));
    expect(r.outcome, r.note).toBe('done');
    const br = readPlace(stateDir, 'again')!.branch;
    expect(br).toBe('board/an-adder');
    expect(sh(repo, 'git', 'show', `${br}:docs/briefs/an-adder.md`)).toBe(ownBrief);
    expect(sh(repo, 'git', 'log', '--format=%s', `main..${br}`).split('\n').reverse()).toEqual([
      'An adder: the brief and the decision record',
      'times: the part',
      'An adder: the brief, with the result',
    ]);
    expect(sh(repo, 'git', 'ls-tree', '-r', '--name-only', br).split('\n')).toEqual(expect.arrayContaining(['docs/briefs/an-adder-2.md', 'docs/adr/0002-an-adder-2.md']));
    const feed = board.state.feed.filter((f) => f.chapter === 'adder2').map((f) => f.text);
    expect(feed.some((t) => t.startsWith('The builder goes on'))).toBe(false);
    expect(feed.some((t) => t.includes('It committed the brief (docs/briefs/an-adder-2.md)'))).toBe(true);
  }, 60_000);

  it('a second canvas with the title of one not merged yet: its own branch, board/an-adder-2', async () => {
    const b = await built();
    addChapter('adder2', 'An adder', ['times'], 'again', 'An adder');
    const r = await b.run(jobFor('adder2'));
    expect(r.outcome, r.note).toBe('done');
    expect(readPlace(stateDir, 'again')!.branch).toBe('board/an-adder-2');
    expect(sh(repo, 'git', 'ls-tree', '-r', '--name-only', 'board/an-adder-2')).toContain('docs/briefs/an-adder.md');
  }, 60_000);

  it('a real resume, with the copy made anew, finds the records it wrote and writes none', async () => {
    board = await buildBoard({ check: CHECK, parts: ['sum', 'cli'] });
    process.env.FAKE_SLOW_MS = '400';
    const b = await builder();
    const first = b.run(job());
    await until(() => taken('sum'));
    await b.pause();
    expect((await first).outcome).toBe('paused');
    delete process.env.FAKE_SLOW_MS;
    sh(repo, 'git', 'worktree', 'remove', '--force', buildPlaces(stateDir, BCH).tree);
    const r = await b.run({ ...job(), resume: true });
    expect(r.outcome, r.note).toBe('done');
    expect(board.state.feed.some((f) => f.text.startsWith('The builder goes on, on board/an-adder:'))).toBe(true);
    expect(sh(repo, 'git', 'ls-tree', '-r', '--name-only', branch()).split('\n').filter((f) => f.startsWith('docs/'))).toEqual(['docs/adr/0001-an-adder.md', 'docs/briefs/an-adder.md']);
    expect(sh(repo, 'git', 'log', '--format=%s', `main..${branch()}`).split('\n').filter((s) => s.endsWith('the decision record'))).toHaveLength(1);
  }, 60_000);

  it('two canvases: two branches and two copies, each from the same base', async () => {
    const b = await built();
    const base = main();
    addChapter('mul', 'A multiplier', ['times'], 'calc', 'Calculator');
    const r = await b.run(jobFor('mul'));
    expect(r.outcome, r.note).toBe('done');
    expect(readPlace(stateDir, 'calc')!.branch).toBe('board/calculator');
    expect(placed.map((p) => [p.chapter, p.place.branch])).toEqual([[BCH, 'board/an-adder'], ['calc', 'board/calculator']]);
    for (const br of ['board/an-adder', 'board/calculator']) expect(sh(repo, 'git', 'merge-base', br, 'main')).toBe(base);
    expect(sh(repo, 'git', 'ls-tree', '-r', '--name-only', 'board/calculator')).not.toContain('parts/sum.txt');
    expect(fs.readdirSync(path.join(stateDir, 'build')).sort()).toEqual([BCH, 'calc']);
  }, 60_000);

  it('a canvas whose branch was merged and taken away starts a new branch from the new base', async () => {
    const b = await built();
    const old = sh(repo, 'git', 'rev-parse', branch());
    // The server's approve: main moves to the build, then the branch is discarded.
    sh(repo, 'git', 'merge', '--quiet', '--ff-only', branch());
    expect((await b.discard!({ canvas: BCH, branch: true })).ok).toBe(true);
    addChapter('mul', 'A multiplier', ['times'], BCH);
    const r = await b.run(jobFor('mul'));
    expect(r.outcome, r.note).toBe('done');
    expect(branch()).toBe('board/an-adder');
    expect(sh(repo, 'git', 'merge-base', branch(), 'main')).toBe(old);
    expect(sh(repo, 'git', 'log', '--format=%s', `main..${branch()}`).split('\n').reverse()[0]).toBe('A multiplier: the brief and the decision record');
  }, 60_000);

  it('refresh with two checks: the second fails, and the note names it', async () => {
    const b = await built();
    const tip = sh(repo, 'git', 'rev-parse', branch());
    fs.writeFileSync(path.join(repo, 'other.txt'), 'from main\n');
    sh(repo, 'git', 'add', 'other.txt');
    sh(repo, 'git', 'commit', '--quiet', '-m', 'main moves');
    const r = await b.refresh!({ canvas: BCH, home: { branch: 'main', commit: main() }, checks: [CHECK, 'test -f parts/nope.txt'], setups: [] });
    expect(r.outcome).toBe('failed');
    expect(r.note).toMatch(/^Joined with main at [0-9a-f]{7}, the check `test -f parts\/nope\.txt` fails \(exit 1\)/);
    expect(sh(repo, 'git', 'rev-parse', branch())).toBe(tip);
    const ok = await b.refresh!({ canvas: BCH, home: { branch: 'main', commit: main() }, checks: [CHECK, 'test -f parts/sum.txt'], setups: [] });
    expect(ok.outcome, ok.note).toBe('joined');
    expect(ok.note).toContain('all 2 checks passed');
  }, 60_000);
});
