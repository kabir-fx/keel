import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentLink, CreateLink, LinkContext, PresenceUpdate, Wake, WakeResult } from '@keel/protocol';
import { ClaudeSetup, findClaude } from './claude-setup';
import { bareToolName, toolPresence, writingPresence } from './presence';

/**
 * The hosted agent link (ADR 0003). The board server owns one long-lived headless Claude
 * Code process, and a wake is one line on its input. The process starts on the first wake.
 * Its session id lives in a private folder outside the repository, so a restart resumes the
 * conversation and nothing in the repository can point that file elsewhere.
 *
 * The agent gets the board tools and two read-only tools, Read and Glob, confined to the
 * repository. The repository is data, never configuration: no setting, hook, `env` or
 * CLAUDE.md of the repository's is loaded.
 */

/** The plugin's folder, from `src/` or from the bundle in `dist/`. */
const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));

export const BOARD_TOOLS = ['board_read', 'board_post', 'board_answer', 'board_model', 'board_part', 'board_update'] as const;
/**
 * The built-in tools there are. Not Grep: a `Read` deny rule does not filter a search of a
 * folder above the denied file, so a Grep of the repository could print a `.env` line.
 */
export const READ_TOOLS = ['Read', 'Glob'] as const;
export const AGENT_FILE = 'agent.json';

/**
 * Files inside the repository the agent never reads, as gitignore patterns under its root:
 * the board server's file, the git folder, environment files and the usual key files.
 */
export const DENIED_FILES = [
  '.keel/board/server.json',
  // The repository's git folder: its config can hold a remote with a password in it.
  '.git/**',
  '**/.git/**',
  '**/.env',
  '**/.env.*',
  '**/*.env',
  '**/.envrc',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/*.keystore',
  '**/id_rsa*',
  '**/id_dsa*',
  '**/id_ecdsa*',
  '**/id_ed25519*',
  '**/.ssh/**',
  '**/.aws/**',
  '**/.gnupg/**',
  '**/.netrc',
  '**/.npmrc',
  '**/.pypirc',
  '**/credentials*.json',
  '**/service-account*.json',
] as const;

export interface HostedOptions {
  /** `--model`. Default `sonnet`. */
  model: string;
  /** `--effort`. Default `low`: the agent draws fast and posts each picture when it is ready. */
  effort: string;
  /** The `claude` command. */
  bin: string;
  /** The board tools' bundle. */
  mcp: string;
  /** The board skill. Its frontmatter is stripped before it joins the system prompt. */
  skill: string;
  /** The picture grammar. It follows the skill in the system prompt, so no wake spends a call reading it. */
  grammar: string;
  /**
   * A file to append the stream's lines to, with the time each came: for the recorded boards.
   * Of the partial stream, only the line that starts each block.
   */
  transcript: string | undefined;
  /** A turn that runs longer than this is stopped. */
  timeoutMs: number;
  /** Log each line of the stream to the server's log. */
  debug: boolean;
}

/** Read the `--link-opt key=value` options. */
export function hostedOptions(o: Record<string, string> = {}): HostedOptions {
  const seconds = Number(o.timeout ?? 600);
  return {
    model: o.model || 'sonnet',
    effort: o.effort || 'low',
    bin: o.bin || 'claude',
    mcp: path.resolve(o.mcp || path.join(PLUGIN_ROOT, 'dist', 'board-mcp.js')),
    skill: path.resolve(o.skill || path.join(PLUGIN_ROOT, 'skills', 'board', 'SKILL.md')),
    grammar: path.resolve(o.grammar || path.join(PLUGIN_ROOT, 'skills', 'board', 'grammar.md')),
    transcript: o.transcript ? path.resolve(o.transcript) : undefined,
    timeoutMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 600_000,
    debug: o.debug === '1' || o.debug === 'true',
  };
}

/** A path rule's form of an absolute path: `//Users/x/repo`. */
export function ruleRoot(dir: string): string {
  return `/${dir.split(path.sep).join('/')}`.replace(/^\/+/, '//');
}

/**
 * The only settings the agent loads (`--restricted` loads no user, project or local file):
 * no hook of any kind, no read outside the working folder, and the denied files.
 */
export function hostedSettings(repoDir: string): object {
  const root = ruleRoot(realDir(repoDir));
  return {
    disableAllHooks: true,
    permissions: {
      blockReadsOutsideWorkingDirectories: true,
      deny: DENIED_FILES.map((f) => `Read(${root}/${f})`),
    },
  };
}

export function realDir(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** The flags S1 proved, locked down. Never `--bare`: it drops the subscription login. */
export function agentArgs(o: {
  model: string;
  effort: string;
  mcpConfig: string;
  skillFile: string;
  settingsFile: string;
  sessionId: string;
  resume: boolean;
}): string[] {
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    // The stream also says when the model begins each block, so the pill can say "drawing" while
    // the model writes a picture, not only once the picture is written.
    '--include-partial-messages',
    '--model', o.model,
    '--effort', o.effort,
    // No user, project or local settings: the repository's hooks, env and permissions never load.
    // The file tools stay inside the working folder. Only managed settings and --settings apply.
    '--restricted',
    '--settings', o.settingsFile,
    '--mcp-config', o.mcpConfig,
    '--strict-mcp-config', // the board server and no other, so the repository's .mcp.json is ignored
    '--disable-slash-commands', // no skills listing in the context
    '--tools', READ_TOOLS.join(','), // the only built-in tools there are
    // The board tools are approved. Reads in the working folder need no approval; any other read is denied.
    '--allowedTools', BOARD_TOOLS.map((t) => `mcp__board__${t}`).join(','),
    '--permission-mode', 'dontAsk', // what is not allowed is denied, and nothing prompts
    '--append-system-prompt-file', o.skillFile,
    ...(o.resume ? ['--resume', o.sessionId] : ['--session-id', o.sessionId]),
  ];
}

/**
 * No API key, so the child runs on the signed-in subscription, and no `CLAUDE*` from a parent
 * session. No CLAUDE.md, no auto memory and no git snapshot: the repository's words reach the
 * agent only as files it reads, never as instructions.
 */
export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Nothing of Claude Code's own session, no API key, and nothing of keel's (a state folder, a token) reaches the child.
  for (const [k, v] of Object.entries(base)) if (!k.startsWith('CLAUDE') && !k.startsWith('KEEL_') && k !== 'ANTHROPIC_API_KEY') env[k] = v;
  env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS = '1';
  return env;
}

/** What joins the system prompt: the skill's body, then the grammar. */
export function systemPromptText(skill: string, grammar: string): string {
  return `${stripFrontmatter(skill).trimEnd()}\n\n${grammar.trim()}\n`;
}

/** The skill without its frontmatter: the system prompt needs only the body. */
export function stripFrontmatter(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return (m ? text.slice(m[0].length) : text).replace(/^\s+/, '');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where the link keeps its own files: the server's private folder when it gives one, else a
 * folder in the user's cache keyed by the board's folder. Never inside the repository.
 */
export function stateDirOf(ctx: Pick<LinkContext, 'stateDir' | 'boardDir'>, home: string = os.homedir()): string {
  if (ctx.stateDir) return path.resolve(ctx.stateDir);
  const key = crypto.createHash('sha256').update(realDir(ctx.boardDir)).digest('hex').slice(0, 16);
  return path.join(home, '.cache', 'keel-board', key);
}

/** The saved session id, if a plain file holds one. A link in its place is not followed. */
export function readSessionId(stateDir: string): string | undefined {
  try {
    const file = path.join(stateDir, AGENT_FILE);
    if (!fs.lstatSync(file).isFile()) return undefined;
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as { sessionId?: unknown };
    return typeof v.sessionId === 'string' && UUID.test(v.sessionId) ? v.sessionId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What the saved session has cost so far, when the file says so. Claude Code reports a
 * session's running total, and a resumed session carries its total on, so the first turn
 * after a restart needs the total from before it.
 */
export function readSessionCost(stateDir: string, sessionId: string): number | undefined {
  try {
    const file = path.join(stateDir, AGENT_FILE);
    if (!fs.lstatSync(file).isFile()) return undefined;
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as { sessionId?: unknown; costUsd?: unknown };
    return v.sessionId === sessionId && typeof v.costUsd === 'number' && Number.isFinite(v.costUsd) && v.costUsd >= 0 ? v.costUsd : undefined;
  } catch {
    return undefined;
  }
}

/** Write the session id, and what it has cost so far, through a new file and a rename, so a link at the path is replaced, not followed. */
function writeSessionId(stateDir: string, sessionId: string, costUsd?: number): void {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, AGENT_FILE);
  const tmp = path.join(stateDir, `.${AGENT_FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(tmp, `${JSON.stringify({ sessionId, savedAt: new Date().toISOString(), ...(costUsd !== undefined ? { costUsd } : {}) }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
}

/**
 * This turn's own cost, from the session's running total and the total before the turn.
 * A total below the one before means the count began again, so the total is the turn's own.
 */
export function turnCost(total: number, before: number): number {
  return total >= before ? total - before : total;
}

function forgetSessionId(stateDir: string): void {
  fs.rmSync(path.join(stateDir, AGENT_FILE), { force: true });
}

const clip = (s: string, max = 200) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

interface Turn {
  done(result: WakeResult & { again?: boolean }): void;
}

type StreamLine = {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  duration_ms?: number;
  total_cost_usd?: number;
  mcp_servers?: Array<{ name?: string; status?: string }>;
  message?: { content?: Array<{ type?: string; id?: string; name?: string; input?: unknown }> };
  /** On a `stream_event` line: one event of the model's message as it is written. Read with care: nothing in it is checked. */
  event?: unknown;
};

/** A tool call the model is writing: its block in the message, its id, the tool, and the note last reported for it. */
export interface Writing {
  index: number;
  id: string | undefined;
  tool: string;
  note: string | undefined;
  /** True while the input may still make the note more exact: a `board_post` whose first picture's kind is not read yet, and not looked for past `KIND_READ_MAX`. */
  refining: boolean;
  /** The input written so far, kept only while `refining`. */
  input: string;
}

/**
 * How much of a `board_post`'s input is read for the kind of its first picture, in characters.
 * The kind is the first thing a model writes of a picture, so it comes well inside this; past
 * it, the note waits for the whole call, and the input is neither kept nor read again.
 */
export const KIND_READ_MAX = 4096;

const asObject = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/**
 * One event of the partial stream, for the tool call being written: the call as it is now, and
 * a presence to report, if any. A tool call that begins reports what the tool does. While a
 * `board_post`'s input comes in, the note is reported once more if it becomes more exact. A
 * block that is not a tool call reports nothing. An event that is malformed changes nothing.
 */
export function followCall(w: Writing | undefined, event: unknown): { writing: Writing | undefined; report?: PresenceUpdate } {
  const e = asObject(event);
  switch (e?.type) {
    case 'content_block_start': {
      const block = asObject(e.content_block);
      if (typeof e.index !== 'number' || typeof block?.type !== 'string') return { writing: w };
      // A new block ends the one before, whatever it is.
      if (block.type !== 'tool_use') return { writing: undefined };
      if (typeof block.name !== 'string') return { writing: w };
      const report = writingPresence(block.name, '');
      const id = typeof block.id === 'string' ? block.id : undefined;
      const refining = bareToolName(block.name) === 'board_post';
      return { writing: { index: e.index, id, tool: block.name, note: report.note, refining, input: '' }, report };
    }
    case 'content_block_delta': {
      const delta = asObject(e.delta);
      if (!w?.refining || e.index !== w.index || delta?.type !== 'input_json_delta' || typeof delta.partial_json !== 'string') return { writing: w };
      const input = w.input + delta.partial_json;
      const report = writingPresence(w.tool, input.slice(0, KIND_READ_MAX));
      // The note is as exact as it gets: no more reading of this call.
      if (report.note !== w.note) return { writing: { ...w, note: report.note, refining: false, input: '' }, report };
      // Read as far as the kind is looked for, and it was not there.
      if (input.length > KIND_READ_MAX) return { writing: { ...w, refining: false, input: '' } };
      return { writing: { ...w, input } };
    }
    case 'content_block_stop':
      return { writing: e.index === w?.index ? undefined : w };
    case 'message_start':
    case 'message_stop':
      return { writing: undefined };
    default:
      return { writing: w };
  }
}

export class HostedLink implements AgentLink {
  readonly name: string;
  readonly setup: ClaudeSetup;
  private proc: ChildProcessWithoutNullStreams | undefined;
  private turn: Turn | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private files: { dir: string; mcpConfig: string; skillFile: string; settingsFile: string } | undefined;
  /** The private folder for `agent.json`, outside the repository. */
  private readonly stateDir: string;
  private sessionId: string | undefined;
  private resumed = false;
  private sawOutput = false;
  /** The tool call the model is writing now, read from the partial stream. */
  private writing: Writing | undefined;
  /** The running total the stream last reported, for this process. */
  private costSoFar = 0;
  /** False for the first turn of a resumed session whose earlier total was not saved: its own cost cannot be told. */
  private costKnown = true;
  private stderrTail = '';
  private closed = false;

  constructor(
    private readonly ctx: LinkContext,
    private readonly opts: HostedOptions,
  ) {
    this.name = `claude (${opts.model}, hosted)`;
    this.stateDir = stateDirOf(ctx);
    this.setup = new ClaudeSetup({ bin: opts.bin, env: childEnv, log: ctx.log });
    for (const [what, file] of [['board tools', opts.mcp], ['board skill', opts.skill], ['picture grammar', opts.grammar]] as const) {
      if (!fs.existsSync(file)) throw new Error(`The ${what} are missing at ${file}. Build the plugin: npm run build -w @keel/board-plugin.`);
    }
  }

  /** The session the next start resumes, if any. */
  get session(): string | undefined {
    return this.sessionId ?? readSessionId(this.stateDir);
  }

  wake(w: Wake): Promise<WakeResult> {
    const next = this.chain.then(() => this.runWake(w.text));
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async runWake(text: string): Promise<WakeResult> {
    if (this.closed) return { ok: false, note: 'the link is closed' };
    let r = await this.turnOnce(text);
    // The saved session was gone: one more try, in a new session.
    if (r.again) r = await this.turnOnce(text);
    return r.note === undefined ? { ok: r.ok } : { ok: r.ok, note: r.note };
  }

  private turnOnce(text: string): Promise<WakeResult & { again?: boolean }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.ctx.log(`a turn ran past ${this.opts.timeoutMs / 1000} s; stopping the agent`);
        this.turn?.done({ ok: false, note: `the turn ran past ${this.opts.timeoutMs / 1000} s, so the agent was stopped` });
        this.proc?.kill('SIGTERM');
      }, this.opts.timeoutMs);
      this.turn = {
        done: (result) => {
          clearTimeout(timer);
          this.turn = undefined;
          resolve(result);
        },
      };
      try {
        const proc = this.proc ?? this.start();
        const line = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
        this.record({ keel: 'wake', text });
        proc.stdin.write(`${JSON.stringify(line)}\n`);
      } catch (e) {
        this.turn?.done({ ok: false, note: `the agent could not start: ${e instanceof Error ? e.message : String(e)}` });
      }
    });
  }

  private prepare(): { dir: string; mcpConfig: string; skillFile: string; settingsFile: string } {
    if (this.files) return this.files;
    // In the board's own private folder, not a new temp folder each start: a server that is
    // killed hard leaves nothing behind that the next start does not overwrite.
    const dir = path.join(this.stateDir, 'run');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const mcpConfig = path.join(dir, 'mcp.json');
    const config = {
      mcpServers: {
        board: {
          command: process.execPath,
          args: [this.opts.mcp],
          env: { KEEL_BOARD_URL: this.ctx.serverUrl, KEEL_BOARD_TOKEN: this.ctx.agentToken },
        },
      },
    };
    // It holds the agent's token: only this user reads it.
    fs.writeFileSync(mcpConfig, JSON.stringify(config), { mode: 0o600 });
    const skillFile = path.join(dir, 'board-skill.md');
    const prompt = systemPromptText(fs.readFileSync(this.opts.skill, 'utf8'), fs.readFileSync(this.opts.grammar, 'utf8'));
    fs.writeFileSync(skillFile, prompt, { mode: 0o600 });
    const settingsFile = path.join(dir, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify(hostedSettings(this.ctx.repoDir)), { mode: 0o600 });
    this.files = { dir, mcpConfig, skillFile, settingsFile };
    return this.files;
  }

  private start(): ChildProcessWithoutNullStreams {
    const { mcpConfig, skillFile, settingsFile } = this.prepare();
    const saved = this.sessionId ?? readSessionId(this.stateDir);
    const resume = saved !== undefined;
    const sessionId = saved ?? crypto.randomUUID();
    if (!resume) writeSessionId(this.stateDir, sessionId);
    this.sessionId = sessionId;
    this.resumed = resume;
    this.sawOutput = false;
    this.writing = undefined;
    this.stderrTail = '';
    // A resumed session carries its running total on: start from what it had cost before.
    const before = resume ? readSessionCost(this.stateDir, sessionId) : 0;
    this.costSoFar = before ?? 0;
    this.costKnown = before !== undefined;

    const args = agentArgs({ model: this.opts.model, effort: this.opts.effort, mcpConfig, skillFile, settingsFile, sessionId, resume });
    const env = childEnv();
    const proc = spawn(findClaude(this.opts.bin, env) ?? this.opts.bin, args, { cwd: this.ctx.repoDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.ctx.log(`${resume ? 'resumed' : 'started'} the agent: session ${sessionId}, pid ${proc.pid ?? '?'}`);

    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      buf += chunk;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const raw = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!raw) continue;
        let e: StreamLine;
        try {
          e = JSON.parse(raw) as StreamLine;
        } catch {
          continue;
        }
        this.onLine(e);
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    // A write to a process that just died must not take the board server down with it.
    proc.stdin.on('error', () => {});
    proc.on('error', (e) => {
      this.stderrTail = `${this.stderrTail}\n${e.message}`.slice(-2000);
    });
    proc.on('close', (code, signal) => this.onClose(proc, code, signal));
    return proc;
  }

  /** One line of the transcript, if one is kept. A lost line never fails a turn. */
  private record(line: object): void {
    if (!this.opts.transcript) return;
    try {
      fs.appendFileSync(this.opts.transcript, `${JSON.stringify({ t: Date.now(), ...line })}\n`);
    } catch {
      // The transcript is for measuring. The board does not depend on it.
    }
  }

  private onLine(e: StreamLine): void {
    this.sawOutput = true;
    if (e.type === 'stream_event') {
      this.onPartial(e);
      return;
    }
    this.record(e);
    if (e.type === 'system' && e.subtype === 'init') {
      if (e.session_id && UUID.test(e.session_id) && e.session_id !== this.sessionId) {
        this.sessionId = e.session_id;
        writeSessionId(this.stateDir, e.session_id);
      }
      const board = e.mcp_servers?.find((s) => s.name === 'board');
      if (board && board.status !== 'connected') this.ctx.log(`the board tools did not connect (${board.status ?? 'unknown'})`);
      return;
    }
    if (e.type === 'assistant') {
      for (const c of e.message?.content ?? []) {
        if (c.type !== 'tool_use' || typeof c.name !== 'string') continue;
        // The call is whole: nothing read while it was written may report after this.
        if (this.writing && c.id === this.writing.id) this.writing = undefined;
        const p = toolPresence(c.name, c.input);
        if (this.opts.debug) this.ctx.log(`tool ${c.name} (input ${typeof c.input}: ${clip(JSON.stringify(c.input) ?? '', 120)}) → ${JSON.stringify(p)}`);
        this.ctx.presence(p);
      }
      return;
    }
    if (this.opts.debug) this.ctx.log(`stream ${e.type}${e.subtype ? `/${e.subtype}` : ''}`);
    if (e.type === 'result') {
      this.ctx.presence({ state: 'listening' });
      const secs = typeof e.duration_ms === 'number' ? `${(e.duration_ms / 1000).toFixed(1)} s` : '';
      // The stream reports the session's running total: this turn's own cost is the difference.
      let cost = '';
      if (typeof e.total_cost_usd === 'number') {
        if (this.costKnown) {
          const own = turnCost(e.total_cost_usd, this.costSoFar);
          this.record({ keel: 'turn-cost', usd: own });
          cost = `, $${own.toFixed(4)}`;
        }
        this.costSoFar = e.total_cost_usd;
        this.costKnown = true;
        // Kept with the session, so a restart can tell the next turn's own cost.
        if (this.sessionId) {
          try {
            writeSessionId(this.stateDir, this.sessionId, e.total_cost_usd);
          } catch {
            // Only the next cost line depends on it.
          }
        }
      }
      if (e.is_error) {
        const note = clip(`the turn ended in an error: ${e.result ?? e.subtype ?? 'no reason given'}`);
        this.ctx.log(`${note} (${secs}${cost})`);
        this.turn?.done({ ok: false, note });
      } else {
        this.ctx.log(`turn done in ${secs}${cost}`);
        this.turn?.done({ ok: true });
      }
    }
  }

  /**
   * One line of the partial stream: the model's message as it is written. Only the start of a
   * block goes into the transcript and the debug log. That says when the model began each block,
   * without the many lines of its words, which the whole `assistant` line holds anyway.
   */
  private onPartial(e: StreamLine): void {
    const event = asObject(e.event);
    if (event?.type === 'content_block_start') {
      this.record(e);
      if (this.opts.debug) this.ctx.log(`stream block ${String(asObject(event.content_block)?.type)} begins`);
    }
    const { writing, report } = followCall(this.writing, e.event);
    this.writing = writing;
    if (!report) return;
    if (this.opts.debug) this.ctx.log(`tool ${writing?.tool ?? '?'} being written → ${JSON.stringify(report)}`);
    this.ctx.presence(report);
  }

  private onClose(proc: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.proc === proc) this.proc = undefined;
    const tail = clip(this.stderrTail, 300);
    const gone = this.resumed && !this.sawOutput && /no conversation found/i.test(this.stderrTail);
    if (gone) {
      this.ctx.log(`session ${this.sessionId} was not found; the next start opens a new one`);
      this.sessionId = undefined;
      forgetSessionId(this.stateDir);
    } else if (!this.closed) {
      this.ctx.log(`the agent exited (${code ?? signal})${tail ? `: ${tail}` : ''}`);
    }
    this.turn?.done({
      ok: false,
      note: clip(`the agent stopped mid-turn (exit ${code ?? signal})${tail ? `: ${tail}` : ''}`),
      again: gone && !this.closed,
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.setup.close();
    const proc = this.proc;
    if (proc) {
      const exited = new Promise<void>((resolve) => proc.once('close', () => resolve()));
      const within = (ms: number) => Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref())]);
      // Closing the input lets a running turn finish, then the process ends by itself.
      proc.stdin.end();
      if (!(await within(20_000))) {
        proc.kill('SIGTERM');
        if (!(await within(5_000))) proc.kill('SIGKILL');
      }
    }
    if (this.files) fs.rmSync(this.files.dir, { recursive: true, force: true });
    this.files = undefined;
  }
}

/** What the board server loads with `--link <this module>`. */
export const createLink: CreateLink = (ctx) => new HostedLink(ctx, hostedOptions(ctx.options));

/** The builder, from the same module, so one `--link` gives the server both seams. */
export { createBuilder } from './hosted-builder';
