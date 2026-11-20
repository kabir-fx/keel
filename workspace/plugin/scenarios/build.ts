// One real build, end to end, driven by the real board server. A toy repository with a
// passing `make check`; a board seeded with a solid chapter of three parts, its pipeline and its
// blueprint; the server started with one --link, the hosted module, which gives it both the
// agent and the builder. The owner presses "Build this" over HTTP, and at once pins a change on
// the last part, which is decided: "also accept x for times". The agent must reopen that part
// and change it; the build waits; the owner decides the part again; the builder builds the
// change. What must hold: the branch has the records and one commit per part, each part went
// building then built through board_check, the chapter is built, the owner's checkout is
// untouched, and the built command does what the owner pinned: `calc 3 x 4` prints 12.
//
//   npx tsx scenarios/build.ts [builder-model=sonnet] [builder-effort=medium] ...   (from workspace/plugin)
//
// Build first, from workspace/: npm run build. KEEP=1 keeps the temporary folder.
// It costs two builder runs (the start, and the run after the owner decides the part again)
// and three agent turns ("Build this", the pinned note, the owner's decision).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BoardEvent, BoardState } from '@keel/protocol';
import { admitAll, emptyState } from '@keel/protocol';
import type { TranscriptLine } from './check';
import { HOSTED, RUNS, SERVER_BIN, missingBuild, ownerToken, readTranscript } from './serve';

const say = (line: string) => process.stdout.write(`${line}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CH = 'calc';

function sh(cwd: string, cmd: string, ...args: string[]): string {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/** The toy: a version module and its test, a Makefile whose check runs node's own test runner. */
function toyRepo(dir: string): void {
  const files: Record<string, string> = {
    'README.md': '# calc\n\nA tiny calculator.\n',
    'Makefile': 'check:\n\tnode --test\n',
    'package.json': '{ "name": "calc", "private": true, "type": "module" }\n',
    '.gitignore': '.keel/\nnode_modules/\n',
    'src/version.js': "export const version = '0.1.0';\n",
    'test/version.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { version } from '../src/version.js';\n\ntest('the version', () => assert.equal(version, '0.1.0'));\n",
  };
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  sh(dir, 'git', 'init', '--quiet', '-b', 'main');
  sh(dir, 'git', 'config', 'user.name', 'Toy owner');
  sh(dir, 'git', 'config', 'user.email', 'owner@toy.invalid');
  sh(dir, 'git', 'config', 'commit.gpgsign', 'false');
  sh(dir, 'git', 'add', '.');
  sh(dir, 'git', 'commit', '--quiet', '-m', 'A version, and make check');
}

/** The board: a solid chapter of three parts, and the blueprint with the check. "Build this" is the owner's, later. */
function seedBoard(): BoardEvent[] {
  let state: BoardState = emptyState();
  const events: BoardEvent[] = [];
  let t = Date.parse('2026-11-17T15:00:00Z');
  const step = (by: 'owner' | 'agent' | 'system', ...drafts: unknown[]) => {
    t += 20_000;
    const r = admitAll(state, drafts, by, new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z'));
    if (!r.ok) throw new Error(`seed refused under ${r.rule}: ${r.reason}`);
    state = r.state;
    events.push(...r.events);
  };
  step('system', { type: 'board.open', name: 'calc' });
  step(
    'owner',
    { type: 'chapter.open', chapter: CH, title: 'A calculator on the command line' },
    { type: 'item.add', chapter: CH, item: { id: 'note-1', kind: 'note', box: [80, 80, 300, 90], text: 'I want a tiny calculator I can run in the terminal: calc 2 + 3 prints 5.' } },
  );
  step('agent', {
    type: 'model.patch',
    chapter: CH,
    ops: [
      { op: 'lane.set', lane: { id: 'user', name: 'You', note: 'a terminal' } },
      { op: 'lane.set', lane: { id: 'cli', name: 'Command line' } },
      { op: 'lane.set', lane: { id: 'core', name: 'Core' } },
      { op: 'part.set', part: { id: 'terminal', name: 'Terminal', lane: 'user', col: 1, external: true } },
      { op: 'part.set', part: { id: 'calc', name: 'The calculator', plain: 'calculate(a, op, b): + - * /', lane: 'core', col: 3, files: ['src/calc.js'] } },
      { op: 'part.set', part: { id: 'parse', name: 'The command', plain: 'bin/calc.mjs: reads 2 + 3, prints 5', lane: 'cli', col: 2, files: ['bin/calc.mjs'] } },
      { op: 'part.set', part: { id: 'usage', name: 'The usage line', plain: 'one example in the README' } },
      { op: 'edge.set', edge: { from: 'terminal', to: 'parse', label: 'calc 2 + 3' } },
      { op: 'edge.set', edge: { from: 'parse', to: 'calc', label: '2, +, 3' } },
      {
        op: 'walk.set',
        walk: {
          id: 'one-sum',
          name: 'Follow one sum',
          steps: [
            { n: 1, part: 'terminal', text: 'You type: node bin/calc.mjs 2 + 3' },
            { n: 2, part: 'parse', text: 'The command reads 2, + and 3' },
            { n: 3, part: 'calc', text: 'The calculator adds them: 5' },
            { n: 4, part: 'parse', text: 'The command prints 5. A bad input prints a usage line and exits 2' },
          ],
        },
      },
    ],
  });
  step('agent', {
    type: 'item.add',
    chapter: CH,
    item: { id: 'pipe', kind: 'picture', answers: ['note-1'], picture: { kind: 'pipeline', title: 'Your calculator', view: 'flat', walk: 'one-sum' } },
  });
  // The owner solidifies, and the blueprint answers it: nothing is open when the server starts.
  step('owner', { type: 'solidify', chapter: CH, picks: ['note-1', 'pipe'], parts: ['calc', 'parse', 'usage'] });
  const solidify = events[events.length - 1]!.id;
  step('agent', {
    type: 'item.add',
    chapter: CH,
    item: {
      id: 'blueprint',
      kind: 'picture',
      answers: ['note-1', solidify],
      picture: {
        kind: 'blueprint',
        title: 'The blueprint',
        summary: 'A pure calculator, and a thin command line in front of it.',
        picks: [
          { text: 'A pure function for the sums, with its own tests', from: { item: 'note-1' } },
          { text: 'calc 2 + 3 prints 5', from: { item: 'note-1' } },
        ],
        leftOut: [{ text: 'No brackets and no order of operations.', why: 'One operator per line is enough to try it.' }],
        proof: ['node bin/calc.mjs 2 + 3 prints 5.', 'node bin/calc.mjs 7 / 0 says it cannot divide by zero.'],
        parts: ['calc', 'usage', 'parse'],
        check: 'make check',
        walk: 'one-sum',
      },
    },
  });
  return events;
}

async function api<T>(url: string, token: string, route: string, body?: unknown): Promise<T> {
  const r = await fetch(`${url}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!r.ok) throw new Error(`${route}: ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

type Info = { link: string; builder: string; open: number; build?: { state: string; built: number; total: number; part?: string } };

/** Wait until `test` holds, checking every second. */
async function until(what: string, ms: number, test: () => Promise<boolean>): Promise<void> {
  const t0 = Date.now();
  while (!(await test())) {
    if (Date.now() - t0 > ms) throw new Error(`gave up waiting ${Math.round(ms / 60_000)} min for ${what}`);
    await sleep(1000);
  }
}

function ownerView(repo: string) {
  return {
    head: sh(repo, 'git', 'rev-parse', 'HEAD'),
    branch: sh(repo, 'git', 'rev-parse', '--abbrev-ref', 'HEAD'),
    status: sh(repo, 'git', 'status', '--porcelain'),
    files: sh(repo, 'git', 'ls-files'),
  };
}

async function main(): Promise<number> {
  const missing = missingBuild();
  if (missing) {
    say(missing);
    return 2;
  }
  const opts = Object.fromEntries(process.argv.slice(2).map((kv) => kv.split('=') as [string, string]));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.join(RUNS, `build-${stamp}`);
  fs.mkdirSync(out, { recursive: true });
  const transcript = path.join(out, 'transcript.jsonl');

  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keel-build-')));
  const repo = path.join(tmp, 'calc');
  const keelState = path.join(tmp, 'keel-state');
  toyRepo(repo);
  const seed = seedBoard();
  fs.mkdirSync(path.join(repo, '.keel', 'board'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.keel', 'board', 'log.jsonl'), `${seed.map((e) => JSON.stringify(e)).join('\n')}\n`);
  const before = ownerView(repo);
  say(`Toy repository ${repo} at ${before.head.slice(0, 7)}; board seeded with ${seed.length} events.`);

  // The real board server, with one --link: the hosted module gives it the agent and the builder.
  const transcriptAgent = path.join(out, 'agent-transcript.jsonl');
  const linkOpts = Object.entries({ transcript: transcriptAgent, 'builder-transcript': transcript, ...opts }).flatMap(([k, v]) => ['--link-opt', `${k}=${v}`]);
  const server = spawn(process.execPath, [SERVER_BIN, 'open', repo, '--port', '0', '--no-browser', '--link', HOSTED, ...linkOpts], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, KEEL_STATE_DIR: keelState },
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += String(d)));
  server.stderr.on('data', (d) => (serverLog += String(d)));
  const serverFile = path.join(repo, '.keel', 'board', 'server.json');
  await until('the board server', 20_000, async () => fs.existsSync(serverFile) && /code=/.test(serverLog));
  const sf = JSON.parse(fs.readFileSync(serverFile, 'utf8')) as { port: number };
  const url = `http://127.0.0.1:${sf.port}`;
  // The address the server prints holds a code that works once: trade it for the owner's token, as the page does.
  const owner = await ownerToken(url, /\?code=([A-Za-z0-9_-]+)/.exec(serverLog)![1]!);
  const info = () => api<Info>(url, owner, '/api/board');
  const state = () => api<BoardState>(url, owner, '/api/state');
  const press = (draft: object) => api(url, owner, '/api/events', { drafts: [draft] });
  const steps: string[] = [];
  const t0 = Date.now();
  const at = () => `${((Date.now() - t0) / 60_000).toFixed(1)} min`;
  const note = (line: string) => {
    steps.push(`${at()} ${line}`);
    say(`  ${at()} ${line}`);
  };

  let result: { outcome: string; note?: string } = { outcome: 'not run' };
  let changed = '';
  let reopened = false;
  try {
    const i0 = await info();
    note(`server up: link "${i0.link}", builder "${i0.builder}"`);
    await press({ type: 'build.start', chapter: CH, track: ['calc', 'usage', 'parse'], blueprint: 'blueprint', check: 'make check' });
    note('the owner pressed "Build this"');
    // At once, a change on the last part, which is decided and not built yet.
    await press({
      type: 'item.add',
      chapter: CH,
      item: {
        id: 'note-x',
        kind: 'note',
        box: [40, 40, 300, 80],
        text: 'also accept x for times: calc 3 x 4 prints 12',
        on: { item: 'pipe', sub: 'part:parse' },
        anchor: { item: 'pipe', sub: 'part:parse', box: [0, 0, 100, 100] },
      },
    });
    note('the owner pinned "also accept x for times" on the command, a decided part');
    reopened = await until('the agent to reopen the command', 3 * 60_000, async () => (await state()).model.parts.parse?.state === 'idea').then(
      () => true,
      () => false,
    );
    if (reopened) {
      note('the agent reopened the command');
      await until('the build to wait for the owner, and the agent to finish its turn', 15 * 60_000, async () => {
        const i = await info();
        return i.build?.state === 'waiting' && i.open === 0;
      });
      const p = (await state()).model.parts.parse!;
      changed = `"${p.name}": ${p.plain ?? ''}${p.note ? ` · note: ${p.note}` : ''}`;
      note(`the build waits; the part now says ${changed}`);
      await press({ type: 'part.state', part: 'parse', state: 'solid' });
      note('the owner decided the command again');
    } else {
      note('the agent did not reopen the command; the build went on');
    }
    await until('the chapter to be built', 40 * 60_000, async () => (await state()).chapters[CH]?.state === 'built');
    note('the chapter is built');
    await until('the run to end and the agent to answer everything', 5 * 60_000, async () => {
      const i = await info();
      return i.build === undefined && i.open === 0;
    });
    // The server says so in the feed when a run ends with the build not done and nobody paused it.
    const feed = (await state()).feed;
    const stop = feed.find((f) => f.kind === 'problem' && f.by === 'system' && /^The build(er)? /.test(f.text));
    result = stop ? { outcome: 'failed', note: stop.text } : { outcome: 'done' };
  } finally {
    const minutes = (Date.now() - t0) / 60_000;
    const final = await state().catch(() => undefined);
    server.kill('SIGTERM');
    await new Promise<void>((r) => (server.exitCode !== null ? r() : server.once('exit', () => r())));
    const after = ownerView(repo);
    const events = fs
      .readFileSync(path.join(repo, '.keel', 'board', 'log.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as BoardEvent)
      .slice(seed.length);
    const branchLog = spawnSync('git', ['log', '--reverse', '--format=%h %s', `${before.head}..board/${CH}`], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    const lines = readTranscript(transcript);
    // What the owner pinned, run on the built branch.
    const built = path.join(tmp, 'built');
    fs.mkdirSync(built);
    const tar = spawnSync('git', ['archive', `board/${CH}`], { cwd: repo });
    spawnSync('tar', ['-x', '-C', built], { input: tar.stdout });
    const run = (...a: string[]) => spawnSync(process.execPath, ['bin/calc.mjs', ...a], { cwd: built, encoding: 'utf8' }).stdout.trim();
    const proof = { times: run('3', 'x', '4'), plus: run('2', '+', '3') };
    const report = [
      summarise({ result, minutes, state: final, events, branchLog, before, after, lines, agent: readTranscript(transcriptAgent) }),
      `  ${proof.times === '12' ? 'ok  ' : 'FAIL'} the built command has the owner's change: calc 3 x 4 prints "${proof.times}" (and 2 + 3 prints "${proof.plus}")`,
      `  ${reopened && changed ? 'ok  ' : 'FAIL'} the agent reopened the part and changed it: ${changed || '(never)'}`,
      '  steps:',
      ...steps.map((x) => `    ${x}`),
    ].join('\n');
    fs.writeFileSync(path.join(out, 'log.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'));
    fs.writeFileSync(path.join(out, 'server.log'), serverLog);
    fs.writeFileSync(path.join(out, 'report.txt'), `${report}\n`);
    say(`\n${report}\n\nWritten to ${out}`);
    if (process.env.KEEP) say(`Kept ${tmp}`);
    else fs.rmSync(tmp, { recursive: true, force: true });
  }
  return result.outcome === 'done' && reopened ? 0 : 1;
}

function summarise(o: {
  result: { outcome: string; note?: string };
  minutes: number;
  state: BoardState | undefined;
  events: BoardEvent[];
  branchLog: string;
  before: ReturnType<typeof ownerView>;
  after: ReturnType<typeof ownerView>;
  lines: TranscriptLine[];
  agent: TranscriptLine[];
}): string {
  const parts = ['calc', 'usage', 'parse'];
  const states = parts.map((p) => `${p}: ${o.events.filter((e) => e.type === 'part.state' && e.part === p).map((e) => `${e.by} ${(e as { state: string }).state}${(e as { commit?: string }).commit ? ` ${(e as { commit?: string }).commit}` : ''}`).join(' → ')}`);
  const results = o.lines.filter((l) => l.type === 'result');
  // Each turn's own cost, as the builder worked it out: the stream gives a running total.
  const costs = o.lines.filter((l) => l.keel === 'turn-cost').map((l) => l.usd ?? 0);
  const refusals: string[] = [];
  const names = new Map<string, string>();
  for (const l of o.lines) {
    for (const c of l.message?.content ?? []) {
      if (l.type === 'assistant' && c.type === 'tool_use') names.set(String(c.id), String(c.name));
      if (l.type === 'user' && c.type === 'tool_result' && c.is_error === true) {
        const body = Array.isArray(c.content) ? (c.content as Array<{ text?: string }>).map((x) => x.text ?? '').join(' ') : String(c.content ?? '');
        refusals.push(`${(names.get(String(c.tool_use_id)) ?? '?').replace(/^mcp__board__/, '')}: ${body.replace(/\s+/g, ' ').slice(0, 160)}`);
      }
    }
  }
  const problems = o.events.filter((e) => e.type === 'feed.add' && e.kind === 'problem').map((e) => `${e.by}: ${(e as { text: string }).text}`);
  const ok = (b: boolean) => (b ? 'ok  ' : 'FAIL');
  const agentTurns = o.agent.filter((l) => l.keel === 'turn-cost').map((l) => ({ total_cost_usd: l.usd }));
  const cards: string[] = [];
  for (const e of o.events) {
    if (e.by === 'agent' && e.type === 'item.add' && e.item.kind === 'picture') cards.push(`"${'title' in e.item.picture ? String(e.item.picture.title) : e.item.picture.kind}"`);
  }
  return [
    `BUILD · ${o.result.outcome}${o.result.note ? ` · ${o.result.note}` : ''}`,
    `  ${ok(o.state?.chapters[CH]?.state === 'built')} the chapter is ${o.state?.chapters[CH]?.state ?? '?'}`,
    `  ${ok(JSON.stringify(o.before) === JSON.stringify(o.after))} the owner's checkout is untouched (HEAD ${o.after.head.slice(0, 7)} on ${o.after.branch}, status "${o.after.status}")`,
    `  ${ok(parts.every((p) => o.events.some((e) => e.type === 'part.state' && e.part === p && e.by === 'agent' && e.state === 'building') && o.events.some((e) => e.type === 'part.state' && e.part === p && e.by === 'system' && e.state === 'built')))} each part went building (builder) then built (system, board_check)`,
    '  part states:',
    ...states.map((s) => `    ${s}`),
    '  the branch, after the owner\'s HEAD:',
    ...o.branchLog.split('\n').map((l) => `    ${l}`),
    `  minutes ${o.minutes.toFixed(1)} · turns ${results.length} · cost per turn ${costs.map((c) => `$${c.toFixed(3)}`).join(' ')} · sum $${costs.reduce((a, b) => a + b, 0).toFixed(3)}`,
    `  tool refusals ${refusals.length}${refusals.length ? `:\n    ${refusals.join('\n    ')}` : ''}`,
    `  problems on the board ${problems.length}${problems.length ? `:\n    ${problems.join('\n    ')}` : ''}`,
    `  the board agent: ${agentTurns.length} turns, $${agentTurns.reduce((a, r) => a + (r.total_cost_usd ?? 0), 0).toFixed(3)}; its cards: ${cards.join(', ')}`,
    '  feed:',
    ...o.events.filter((e) => e.type === 'feed.add').map((e) => `    ${e.by} ${(e as { kind?: string }).kind ?? 'update'}: ${(e as { text: string }).text}`),
  ].join('\n');
}

process.exitCode = await main();
