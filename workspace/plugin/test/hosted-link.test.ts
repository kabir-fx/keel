import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentLink, LinkContext, PresenceUpdate, Wake } from '@keel/protocol';
import { digest, emptyState } from '@keel/protocol';
import { AGENT_FILE, DENIED_FILES, createLink, hostedSettings, readSessionCost, readSessionId, stateDirOf, stripFrontmatter, turnCost } from '../src/hosted-link';

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

    // Presence from the stream: drawing on the tool call, with the cursor on the note; listening at the result.
    expect(presence).toEqual([{ state: 'drawing', note: 'drawing', cursor: { item: 'm1' } }, { state: 'listening' }]);
  });

  it('keeps one process across wakes, and takes options', async () => {
    const l = await link({ model: 'haiku', effort: 'medium' });
    expect((await l.wake(wake('one'))).ok).toBe(true);
    expect((await l.wake(wake('two'))).ok).toBe(true);
    expect(starts()).toHaveLength(1);
    expect(flag(starts()[0]!.args, '--model')).toBe('haiku');
    expect(flag(starts()[0]!.args, '--effort')).toBe('medium');
  });

  it('keeps a transcript when asked: the wake, then every stream line, each with its time', async () => {
    const file = path.join(tmp, 'transcript.jsonl');
    const l = await link({ transcript: file });
    expect((await l.wake(wake('BOARD demo · e3'))).ok).toBe(true);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((x) => JSON.parse(x) as { t: number; keel?: string; text?: string; type?: string });
    expect(lines[0]).toMatchObject({ keel: 'wake', text: 'BOARD demo · e3' });
    expect(lines.map((x) => x.type).filter(Boolean)).toEqual(['system', 'assistant', 'user', 'assistant', 'result']);
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

  it('refuses to start without the board tools bundle', () => {
    expect(() => createLink(ctx({ mcp: path.join(tmp, 'missing.js') }))).toThrow(/npm run build/);
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
