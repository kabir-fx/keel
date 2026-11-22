import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentLink, LinkContext, PresenceUpdate, Wake } from '@keel/protocol';
import { digest, emptyState } from '@keel/protocol';
import type { Writing } from '../src/hosted-link';
import { AGENT_FILE, DENIED_FILES, PICTURE_READ_MAX, createLink, followCall, hostedSettings, readSessionCost, readSessionId, stateDirOf, stripFrontmatter, turnCost } from '../src/hosted-link';
import { THINKING_PRESENCE, toolPresence } from '../src/presence';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, 'fake-claude.mjs');
const SKILL = path.join(here, '..', 'skills', 'board', 'SKILL.md');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let tmp: string;
let repo: string;
let boardDir: string;
let stateDir: string;
let bin: string;
let logFile: string;
let presence: PresenceUpdate[];
let logs: string[];
let links: AgentLink[];
const saved = { ...process.env };

type Rec = { start?: boolean; args?: string[]; leaked?: string[]; skill?: string; mcp?: string; settings?: string; env?: Record<string, string>; cwd?: string; wake?: string; closed?: boolean; pid: number };

function records(): Rec[] {
  try {
    return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Rec);
  } catch {
    return [];
  }
}
const starts = () => records().filter((r) => r.start);
const flag = (args: string[] | undefined, name: string) => {
  const i = args?.indexOf(name) ?? -1;
  return i >= 0 ? args?.[i + 1] : undefined;
};

function ctx(options: Record<string, string> = {}): LinkContext {
  return {
    repoDir: repo,
    boardDir,
    stateDir,
    serverUrl: 'http://127.0.0.1:4999',
    agentToken: 'agent-secret',
    options: { bin, mcp: FAKE, ...options },
    presence: (u) => presence.push(u),
    log: (m) => logs.push(m),
  };
}

async function link(options: Record<string, string> = {}): Promise<AgentLink> {
  const l = await createLink(ctx(options));
  links.push(l);
  return l;
}

const wake = (text: string): Wake => ({ digest: digest(emptyState()), text, reason: 'marks' });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-link-'));
  repo = path.join(tmp, 'repo');
  boardDir = path.join(repo, '.keel', 'board');
  stateDir = path.join(tmp, 'state');
  fs.mkdirSync(boardDir, { recursive: true });
  logFile = path.join(tmp, 'claude.log');
  // spawn() needs an executable: a shell wrapper around the fake.
  bin = path.join(tmp, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
  process.env.FAKE_CLAUDE_LOG = logFile;
  process.env.CLAUDE_CODE_LEAK = '1';
  process.env.CLAUDECODE = '1';
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  presence = [];
  logs = [];
  links = [];
});

afterEach(async () => {
  for (const l of links) await l.close();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the hosted link', () => {
  it('starts claude on the first wake, with the flags S1 proved', async () => {
    const l = await link();
    expect(starts()).toHaveLength(0);

    const r = await l.wake(wake('BOARD demo · e3 · 2 items · 1 open'));
    expect(r).toEqual({ ok: true });

    const [s] = starts();
    const args = s!.args!;
    expect(args.slice(0, 6)).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']);
    // The model's messages as they are written, so the pill can say "drawing" when a call begins.
    expect(args).toContain('--include-partial-messages');
    expect(flag(args, '--model')).toBe('sonnet');
    expect(flag(args, '--effort')).toBe('low');
    expect(args).toContain('--strict-mcp-config');
    expect(args).toContain('--disable-slash-commands');
    // Read and Glob only, and only the board tools pre-approved: a read outside the repository is denied.
    expect(flag(args, '--tools')).toBe('Read,Glob');
    expect(flag(args, '--allowedTools')).toBe(
      'mcp__board__board_read,mcp__board__board_post,mcp__board__board_answer,mcp__board__board_model,mcp__board__board_part,mcp__board__board_update',
    );
    expect(flag(args, '--permission-mode')).toBe('dontAsk');
    // No settings file of the user's or the repository's: --restricted loads only --settings.
    expect(args).toContain('--restricted');
    expect(args).not.toContain('--setting-sources');
    expect(JSON.parse(s!.settings!)).toEqual(hostedSettings(repo));
    expect(args).not.toContain('--bare');
    expect(args).not.toContain('--resume');
    expect(fs.realpathSync(s!.cwd!)).toBe(fs.realpathSync(repo));

    // A new session, saved for the next start in the private folder, never in the repository.
    const id = flag(args, '--session-id');
    expect(id).toMatch(UUID);
    expect(readSessionId(stateDir)).toBe(id);
    expect(fs.existsSync(path.join(boardDir, AGENT_FILE))).toBe(false);

    // No API key and nothing from a parent Claude Code session; CLAUDE.md, memory and the git snapshot off.
    expect([...s!.leaked!].sort()).toEqual(['CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS']);
    expect(s!.env).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1' });

    // The skill without its frontmatter, then the grammar; the board server only, with the agent's token.
    expect(s!.skill!.startsWith('# The board')).toBe(true);
    expect(s!.skill!).toContain('\n\n# The picture grammar\n');
    expect(s!.skill!.indexOf('# The picture grammar')).toBeGreaterThan(s!.skill!.indexOf('## A wake'));
    const mcp = JSON.parse(s!.mcp!) as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
    expect(Object.keys(mcp.mcpServers)).toEqual(['board']);
    expect(mcp.mcpServers.board).toEqual({
      command: process.execPath,
      args: [FAKE],
      env: { KEEL_BOARD_URL: 'http://127.0.0.1:4999', KEEL_BOARD_TOKEN: 'agent-secret' },
    });

    // The wake is one user line holding the digest text.
    expect(records().filter((x) => x.wake !== undefined).map((x) => x.wake)).toEqual(['BOARD demo · e3 · 2 items · 1 open']);

    // Presence from the stream: drawing when the call begins, a card once its kind is written, its
    // title once that is written, the cursor on the note when the call is whole, listening at the result.
    expect(presence).toEqual(POST_TURN);
  });

  it('keeps one process across wakes, and takes options', async () => {
    const l = await link({ model: 'haiku', effort: 'medium' });
    expect((await l.wake(wake('one'))).ok).toBe(true);
    expect((await l.wake(wake('two'))).ok).toBe(true);
    expect(starts()).toHaveLength(1);
    expect(flag(starts()[0]!.args, '--model')).toBe('haiku');
    expect(flag(starts()[0]!.args, '--effort')).toBe('medium');
  });

  it('keeps a transcript when asked: the wake, every whole stream line and each block\'s start, each with its time', async () => {
    const file = path.join(tmp, 'transcript.jsonl');
    const l = await link({ transcript: file });
    expect((await l.wake(wake('BOARD demo · e3'))).ok).toBe(true);
    const lines = transcriptOf(file);
    expect(lines[0]).toMatchObject({ keel: 'wake', text: 'BOARD demo · e3' });
    // Of the partial stream, only the line that starts each block: no deltas, no stops, no message events.
    expect(lines.map(kindOf).filter(Boolean)).toEqual(['system', 'start tool_use', 'assistant', 'user', 'start text', 'assistant', 'result']);
    expect(lines.every((x) => typeof x.t === 'number')).toBe(true);
  });

  it('a crash mid-turn resolves not ok, and the next wake resumes the session', async () => {
    const l = await link();
    const crashed = await l.wake(wake('CRASH please'));
    expect(crashed.ok).toBe(false);
    expect(crashed.note).toMatch(/exit 3/);
    expect(crashed.note).toMatch(/boom/);

    const again = await l.wake(wake('are you back?'));
    expect(again).toEqual({ ok: true });
    const [first, second] = starts();
    const id = flag(first!.args, '--session-id');
    expect(flag(second!.args, '--resume')).toBe(id);
    expect(second!.args).not.toContain('--session-id');
  });

  it('close ends the input and waits for the process to exit', async () => {
    const l = await link();
    await l.wake(wake('hello'));
    const pid = starts()[0]!.pid;
    await l.close();
    expect(records().some((r) => r.closed && r.pid === pid)).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await l.wake(wake('after close'))).toEqual({ ok: false, note: 'the link is closed' });
  });

  it('a restarted server resumes the saved session', async () => {
    const a = await link();
    await a.wake(wake('first'));
    await a.close();
    const id = readSessionId(stateDir);

    const b = await link();
    expect((await b.wake(wake('second'))).ok).toBe(true);
    expect(flag(starts()[1]!.args, '--resume')).toBe(id);
  });

  it('keeps what the session has cost with the session, so the first turn after a restart is costed as its own', async () => {
    const a = await link();
    await a.wake(wake('first'));
    await a.close();
    const id = readSessionId(stateDir)!;
    // The fake reports a running total of $0.0012.
    expect(readSessionCost(stateDir, id)).toBe(0.0012);
    expect(readSessionCost(stateDir, '11111111-2222-4333-8444-555555555555')).toBeUndefined();
    // A resumed session's total carries on: the turn's own cost is the difference.
    expect(turnCost(0.2811, 0.2594)).toBeCloseTo(0.0217, 4);
    // A total that began again is the turn's own.
    expect(turnCost(0.0217, 0.2594)).toBe(0.0217);
    expect(turnCost(0.05, 0)).toBe(0.05);
  });

  it('a saved session that is gone starts a new one in the same wake', async () => {
    const gone = '11111111-2222-4333-8444-555555555555';
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, AGENT_FILE), JSON.stringify({ sessionId: gone }));
    process.env.FAKE_CLAUDE_GONE = gone;
    const l = await link();
    expect(await l.wake(wake('hello'))).toEqual({ ok: true });
    const [first, second] = starts();
    expect(flag(first!.args, '--resume')).toBe(gone);
    const fresh = flag(second!.args, '--session-id');
    expect(fresh).toMatch(UUID);
    expect(fresh).not.toBe(gone);
    expect(readSessionId(stateDir)).toBe(fresh);
  });

  it('a claude that cannot run fails the wake, not the server', async () => {
    const l = await link({ bin: path.join(tmp, 'no-such-claude') });
    const r = await l.wake(wake('hello'));
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/ENOENT/);
  });

  it('a claude too old for the agent\'s flags is never started, and the wake says what to do', async () => {
    const old = path.join(tmp, 'old-claude');
    fs.writeFileSync(old, `#!/bin/sh\nFAKE_CLAUDE_VERSION=2.1.200 exec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
    const l = await link({ bin: old });
    const r = await l.wake(wake('hello'));
    expect(r).toEqual({ ok: false, note: "Claude Code 2.1.200 is too old for the board: the board needs 2.1.316 or newer. Open the board in a new tab to update it." });
    expect(starts()).toEqual([]);
  });

  it('a link closed while a wake asks the version starts no agent', async () => {
    const slow = path.join(tmp, 'slow-claude');
    fs.writeFileSync(slow, `#!/bin/sh\n[ "$1" = --version ] && sleep 0.5\nexec "${process.execPath}" "${FAKE}" "$@"\n`, { mode: 0o755 });
    const l = await link({ bin: slow });
    const waking = l.wake(wake('hello'));
    await l.close();
    expect(await waking).toEqual({ ok: false, note: 'the link is closed' });
    expect(starts()).toEqual([]);
    expect(fs.existsSync(path.join(stateDir, 'run'))).toBe(false);
  });

  it('refuses to start without the board tools bundle', () => {
    expect(() => createLink(ctx({ mcp: path.join(tmp, 'missing.js') }))).toThrow(/npm run build/);
  });
});

type Line = { t: number; keel?: string; text?: string; type?: string; event?: { type?: string; content_block?: { type?: string } } };

function transcriptOf(file: string): Line[] {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((x) => JSON.parse(x) as Line);
}

/** A transcript line in short: its type, or for a block's start, `start <block type>`. */
const kindOf = (x: Line) => (x.type === 'stream_event' ? `${x.event?.type === 'content_block_start' ? 'start' : x.event?.type} ${x.event?.content_block?.type ?? ''}`.trim() : x.type);

/** The fake's call, as it writes it. */
const POST = { pictures: [{ picture: { kind: 'text', title: 'How I read your note' }, answers: ['m1'] }] };
/** What a turn of the fake reports: the call begins, its first picture is a card, the card's title is written, the call is whole, the turn ends. */
const POST_TURN: PresenceUpdate[] = [
  { state: 'drawing', note: 'drawing', doing: 'drawing' },
  { state: 'drawing', note: 'drawing a card', doing: 'drawing', picture: { kind: 'text' } },
  { state: 'drawing', note: 'drawing a card', doing: 'drawing', picture: { kind: 'text', title: 'How I read your note' } },
  { state: 'drawing', note: 'drawing a card', doing: 'drawing', picture: { kind: 'text', title: 'How I read your note' }, cursor: { item: 'm1' } },
  { state: 'listening' },
];

describe('presence while the model writes a call', () => {
  it('reports drawing when the call begins, before its whole line, and ends where the whole call says', async () => {
    const file = path.join(tmp, 'transcript.jsonl');
    // What the transcript holds at each report: the link records a line before it acts on it.
    const seen: string[][] = [];
    const l = await createLink({ ...ctx({ transcript: file }), presence: (u) => (presence.push(u), seen.push(transcriptOf(file).map(kindOf).filter((k): k is string => !!k))) });
    links.push(l);
    expect(await l.wake(wake('hello'))).toEqual({ ok: true });

    expect(presence).toEqual(POST_TURN);
    // The first report comes as the call begins: no part of the call is whole yet.
    expect(seen[0]).toEqual(['system', 'start tool_use']);
    // The kind and then the title come while the input streams in, still before the whole line.
    expect(seen[1]).toEqual(['system', 'start tool_use']);
    expect(seen[2]).toEqual(['system', 'start tool_use']);
    expect(seen[3]).toEqual(['system', 'start tool_use', 'assistant']);
    // The last word on the call is what the board tool itself reports when it runs.
    expect(presence[3]).toEqual(toolPresence('mcp__board__board_post', POST));
  });

  it('a thinking block reports thinking as it begins, and a text block reports nothing', async () => {
    const l = await link();
    expect(await l.wake(wake('THINK, then answer'))).toEqual({ ok: true });
    expect(presence).toEqual([...POST_TURN.slice(0, 4), THINKING_PRESENCE, { state: 'listening' }]);
  });

  it('an older claude, which writes no stream_event line, reports as before: the whole call, then the end', async () => {
    process.env.FAKE_CLAUDE_STREAM = 'old';
    const file = path.join(tmp, 'transcript.jsonl');
    const l = await link({ transcript: file });
    expect(await l.wake(wake('one'))).toEqual({ ok: true });
    expect(await l.wake(wake('two'))).toEqual({ ok: true });
    expect(presence).toEqual([toolPresence('mcp__board__board_post', POST), { state: 'listening' }, toolPresence('mcp__board__board_post', POST), { state: 'listening' }]);
    const one = ['system', 'assistant', 'user', 'assistant', 'result'];
    expect(transcriptOf(file).map(kindOf).filter(Boolean)).toEqual([...one, ...one.slice(1)]);
    expect(transcriptOf(file).filter((x) => x.keel === 'turn-cost')).toHaveLength(2);
    expect(starts()).toHaveLength(1);
  });

  it('ignores malformed stream_event lines, and the turn goes on as if they were not there', async () => {
    process.env.FAKE_CLAUDE_STREAM = 'junk';
    const l = await link();
    expect(await l.wake(wake('hello'))).toEqual({ ok: true });
    expect(presence).toEqual(POST_TURN);
  });

  it('nothing read while a call is written reports after its whole line', async () => {
    process.env.FAKE_CLAUDE_STREAM = 'late';
    const l = await link();
    expect(await l.wake(wake('hello'))).toEqual({ ok: true });
    expect(presence).toEqual([POST_TURN[0], POST_TURN[3], POST_TURN[4]]);
  });

  it('logs in debug only the starts of blocks and what it reported, not each piece', async () => {
    const l = await link({ debug: '1' });
    expect(await l.wake(wake('hello'))).toEqual({ ok: true });
    const said = logs.filter((m) => m.startsWith('stream') || m.startsWith('tool'));
    expect(said).toEqual([
      'stream block tool_use begins',
      'tool mcp__board__board_post being written → {"state":"drawing","note":"drawing","doing":"drawing"}',
      'tool mcp__board__board_post being written → {"state":"drawing","note":"drawing a card","doing":"drawing","picture":{"kind":"text"}}',
      'tool mcp__board__board_post being written → {"state":"drawing","note":"drawing a card","doing":"drawing","picture":{"kind":"text","title":"How I read your note"}}',
      expect.stringMatching(/^tool mcp__board__board_post \(input object: .*\) → \{"state":"drawing","note":"drawing a card","doing":"drawing","picture":\{"kind":"text","title":"How I read your note"\},"cursor":\{"item":"m1"\}\}$/),
      'stream user',
      'stream block text begins',
      'stream result/success',
    ]);
  });
});

/** The stream events of one call, in the shapes the real stream has (2026-11-20, Claude Code 2.1.329). */
const start = (index: number, content_block: object) => ({ type: 'content_block_start', index, content_block });
const delta = (index: number, partial_json: string) => ({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } });
const stop = (index: number) => ({ type: 'content_block_stop', index });
const postStart = start(0, { type: 'tool_use', id: 'toolu_1', name: 'mcp__board__board_post', input: {}, caller: { type: 'direct' } });

/** Feed events one by one, keeping what each one reported. */
function follow(events: unknown[], from?: Writing): { writing: Writing | undefined; reports: PresenceUpdate[] } {
  let writing = from;
  const reports: PresenceUpdate[] = [];
  for (const e of events) {
    const r = followCall(writing, e);
    writing = r.writing;
    if (r.report) reports.push(r.report);
  }
  return { writing, reports };
}

describe('following a call as it is written', () => {
  it('reports what a tool does as soon as its block begins', () => {
    const r = follow([{ type: 'message_start', message: { content: [] } }, start(0, { type: 'tool_use', id: 'toolu_0177', name: 'Glob', input: {}, caller: { type: 'direct' } })]);
    expect(r.reports).toEqual([{ state: 'drawing', note: 'reading the code', doing: 'reading' }]);
    expect(r.writing).toMatchObject({ index: 0, id: 'toolu_0177', tool: 'Glob', refining: false });
    // The input of any tool but board_post changes nothing.
    expect(follow([delta(0, '{"pattern": "*.none'), delta(0, '"}')], r.writing).reports).toEqual([]);
  });

  it('a board_post: drawing at its start, then its first picture\'s kind once, then its title once, whatever the pieces', () => {
    const input = JSON.stringify({ pictures: [{ answers: ['m1'], picture: { kind: 'mini', title: 'Why two' } }, { picture: { kind: 'text', title: 'Not this' } }] });
    const begins = { state: 'drawing', note: 'drawing', doing: 'drawing' };
    const kind = { state: 'drawing', note: 'drawing a small picture', doing: 'drawing', picture: { kind: 'mini' } };
    const titled = { ...kind, picture: { kind: 'mini', title: 'Why two' } };
    for (const size of [1, 3, 7, 12, input.length]) {
      const pieces = [delta(0, '')];
      for (let i = 0; i < input.length; i += size) pieces.push(delta(0, input.slice(i, i + size)));
      const r = follow([postStart, ...pieces]);
      // Pieces small enough to end between the kind and the title report each; one piece with both reports them together.
      expect(r.reports, `pieces of ${size}`).toEqual(size < input.length ? [begins, kind, titled] : [begins, titled]);
      // Nothing more is kept or read once the title is read.
      expect(r.writing).toMatchObject({ refining: false, input: '' });
    }
  });

  it('a board_post whose title comes before its kind reports both at once, and one whose picture has no title keeps reading', () => {
    const first = follow([postStart, delta(0, '{"pictures":[{"picture":{"title":"Why"'), delta(0, ',"kind":"text"')]);
    expect(first.reports).toEqual([
      { state: 'drawing', note: 'drawing', doing: 'drawing' },
      { state: 'drawing', note: 'drawing a card', doing: 'drawing', picture: { kind: 'text', title: 'Why' } },
    ]);
    expect(first.writing).toMatchObject({ refining: false, input: '' });
    const untitled = '{"pictures":[{"picture":{"kind":"shelf","tiles":[]}},{"picture":{"kind":"text","title":"Not this"}}]}';
    const r = follow([postStart, delta(0, untitled)]);
    expect(r.reports).toEqual([{ state: 'drawing', note: 'drawing', doing: 'drawing' }, { state: 'drawing', note: 'drawing a shelf', doing: 'drawing', picture: { kind: 'shelf' } }]);
    expect(r.writing).toMatchObject({ refining: true, input: untitled });
  });

  it('a board_post\'s first picture is looked for in its first PICTURE_READ_MAX characters only: past them nothing is kept or read', () => {
    /** A post whose model comes first, so the first picture's kind ends `at` characters in, and its title right after. */
    const post = (at: number) => {
      const head = '{"model": {"note": "';
      const tail = '"}, "pictures": [{"picture": {"kind": "text"';
      return `${head}${'x'.repeat(at - head.length - tail.length)}${tail}, "title": "t"}}]}`;
    };
    const titleEnd = (input: string) => input.indexOf('"t"}') + '"t"'.length;
    /** The post in pieces of 12, as the stream gives it, and the call after each. */
    const pieces = (input: string) => {
      const out: unknown[] = [];
      for (let i = 0; i < input.length; i += 12) out.push(delta(0, input.slice(i, i + 12)));
      return out;
    };
    const inside = post(PICTURE_READ_MAX);
    expect(inside.indexOf('"text"') + '"text"'.length).toBe(PICTURE_READ_MAX);
    // The kind is inside the bound and its title is past it: the title is never read.
    expect(follow([postStart, ...pieces(inside)]).reports).toEqual([
      { state: 'drawing', note: 'drawing', doing: 'drawing' },
      { state: 'drawing', note: 'drawing a card', doing: 'drawing', picture: { kind: 'text' } },
    ]);
    // A title that ends on the bound is read.
    const titled = post(PICTURE_READ_MAX - (titleEnd(inside) - PICTURE_READ_MAX));
    expect(titleEnd(titled)).toBe(PICTURE_READ_MAX);
    expect(follow([postStart, ...pieces(titled)]).reports.at(-1)).toEqual({ state: 'drawing', note: 'drawing a card', doing: 'drawing', picture: { kind: 'text', title: 't' } });

    const past = post(PICTURE_READ_MAX + 1);
    let writing = followCall(undefined, postStart).writing;
    let read = 0;
    for (const piece of pieces(past)) {
      const r = followCall(writing, piece);
      writing = r.writing;
      read += (piece as { delta: { partial_json: string } }).delta.partial_json.length;
      expect(r.report, `at ${read}`).toBeUndefined();
      // Kept while within the bound; from the piece that crosses it on, neither kept nor read.
      expect(writing, `at ${read}`).toMatchObject(read > PICTURE_READ_MAX ? { refining: false, input: '' } : { refining: true, input: past.slice(0, read) });
    }
    expect(read).toBeGreaterThan(PICTURE_READ_MAX);
  });

  it('a thinking block reports thinking as it begins, a text block nothing, and either ends the call before it', () => {
    const thinking = start(0, { type: 'thinking', thinking: '', signature: '' });
    const redacted = start(0, { type: 'redacted_thinking', data: 'x' });
    const text = start(1, { type: 'text', text: '' });
    expect(follow([thinking, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } }, stop(0)])).toEqual({ writing: undefined, reports: [THINKING_PRESENCE] });
    expect(follow([redacted, stop(0)])).toEqual({ writing: undefined, reports: [THINKING_PRESENCE] });
    expect(follow([text, { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'done' } }])).toEqual({ writing: undefined, reports: [] });
    expect(follow([postStart, text]).writing).toBeUndefined();
    expect(follow([postStart, thinking]).writing).toBeUndefined();
  });

  it('nothing reports after the block stops, or for another block', () => {
    const late = follow([postStart, delta(0, '{"pictures":[{"picture":{"kind":"te'), stop(0), delta(0, 'xt"')]);
    expect(late.reports).toEqual([{ state: 'drawing', note: 'drawing', doing: 'drawing' }]);
    expect(late.writing).toBeUndefined();
    expect(follow([postStart, delta(1, '{"pictures":[{"picture":{"kind":"text"')]).reports).toEqual([{ state: 'drawing', note: 'drawing', doing: 'drawing' }]);
    expect(follow([postStart, { type: 'message_stop' }, delta(0, '{"pictures":[{"picture":{"kind":"text"')]).reports).toEqual([{ state: 'drawing', note: 'drawing', doing: 'drawing' }]);
  });

  it('a malformed event changes nothing and never throws', () => {
    const open = follow([postStart, delta(0, '{"pictures":[{"picture":')]).writing!;
    const junk: unknown[] = [
      undefined,
      null,
      'content_block_start',
      42,
      [1, 2],
      {},
      { type: 'content_block_start' },
      { type: 'content_block_start', index: 0, content_block: null },
      { type: 'content_block_start', index: '0', content_block: { type: 'text', text: '' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 7 } },
      { type: 'content_block_start', index: 1, content_block: [] },
      { type: 'content_block_delta', index: 0 },
      { type: 'content_block_delta', index: 0, delta: 'x' },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 5 } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"kind":"text"' } },
      { type: 'content_block_stop' },
      { type: 'content_block_stop', index: '0' },
      { type: 'something_new', index: 0 },
    ];
    for (const e of junk) expect(followCall(open, e), JSON.stringify(e) ?? String(e)).toEqual({ writing: open });
    // And the call goes on as if they were not there.
    expect(follow([...junk, delta(0, '{"kind":"lanes"')], open).reports).toEqual([{ state: 'drawing', note: 'drawing lanes', doing: 'drawing', picture: { kind: 'lanes' } }]);
  });
});

describe('what the hosted agent may read', () => {
  it('denies the board server file, environment files and key files, by absolute path', () => {
    const real = fs.realpathSync(repo);
    const deny = (hostedSettings(repo) as { permissions: { deny: string[] } }).permissions.deny;
    expect(deny).toContain(`Read(/${real}/.keel/board/server.json)`);
    // The git folder: its config can hold a remote with a password in it.
    expect(deny).toContain(`Read(/${real}/.git/**)`);
    expect(deny).toContain(`Read(/${real}/**/.git/**)`);
    expect(deny).toContain(`Read(/${real}/**/.env)`);
    expect(deny).toContain(`Read(/${real}/**/id_rsa*)`);
    expect(deny).toHaveLength(DENIED_FILES.length);
    expect(deny.every((r) => r.startsWith(`Read(//`))).toBe(true);
    expect(hostedSettings(repo)).toMatchObject({ disableAllHooks: true, permissions: { blockReadsOutsideWorkingDirectories: true } });
  });
});

describe('where the link keeps its session', () => {
  it('uses the server\'s private folder when it gives one', () => {
    expect(stateDirOf({ stateDir: '/private/state', boardDir })).toBe('/private/state');
  });

  it('else a folder in the user\'s cache, keyed by the board folder, outside the repository', () => {
    const home = path.join(tmp, 'home');
    const a = stateDirOf({ boardDir }, home);
    const other = path.join(tmp, 'other', '.keel', 'board');
    fs.mkdirSync(other, { recursive: true });
    expect(a.startsWith(path.join(home, '.cache', 'keel-board') + path.sep)).toBe(true);
    expect(a).not.toBe(stateDirOf({ boardDir: other }, home));
    expect(a.startsWith(repo)).toBe(false);
    expect(stateDirOf({ boardDir }, home)).toBe(a);
  });

  it('replaces a link at agent.json and never writes through it', async () => {
    const victim = path.join(tmp, 'victim.txt');
    fs.writeFileSync(victim, 'keep me');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.symlinkSync(victim, path.join(stateDir, AGENT_FILE));
    expect(readSessionId(stateDir)).toBeUndefined();
    const l = await link();
    expect((await l.wake(wake('hello'))).ok).toBe(true);
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep me');
    expect(fs.lstatSync(path.join(stateDir, AGENT_FILE)).isSymbolicLink()).toBe(false);
    expect(readSessionId(stateDir)).toMatch(UUID);
  });
});

describe('the skill for the system prompt', () => {
  it('loses its frontmatter and nothing else', () => {
    const text = fs.readFileSync(SKILL, 'utf8');
    expect(text.startsWith('---\nname: board\n')).toBe(true);
    const body = stripFrontmatter(text);
    expect(body.startsWith('# The board')).toBe(true);
    expect(body).not.toContain('name: board');
    expect(stripFrontmatter('# No frontmatter\n')).toBe('# No frontmatter\n');
  });
});
