import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BoardState, BuildJob, BuildResult, Builder, BuilderContext, CreateBuilder } from '@keel/protocol';
import { STATE_DIR_ENV, oneLine, remarksOnPart, renderBrief } from '@keel/protocol';
import { stopLeftoverChecks } from './build-tools';
import { BoardClient, BoardError } from './client';
import { readStarts, recordStart } from './starts';
import { BUILDER_IDENTITY, GitError, OwnerFilesError, ensureWorktree, folderFiles, git, gitInstalled, gitOk, hasIdentity, headOf, pinEnv, removeWorktree, repoTop, samePath } from './git';
import { DENIED_FILES, childEnv, realDir, ruleRoot, stateDirOf, stripFrontmatter } from './hosted-link';
import { RecordPathError, renderDecision, replaceFile, safeDir, writeRecords } from './records';
import { NO_SANDBOX_NOTE, defaultDenyRead, sandboxKind } from './sandbox';
import { makeShow } from './show';

/**
 * The hosted builder: the second seam (`Builder` in the contract). When the owner presses
 * "Build this", the board server calls `run`. The builder makes its own git worktree on its
 * own branch, `board/<chapter>`, in a private folder outside the repository, commits the
 * brief and a decision record there, and then runs a headless Claude Code process in it,
 * one turn per part of the build track.
 *
 * The process is fenced like the hosted agent (ADR 0006): no settings, hooks or CLAUDE.md of
 * the repository's, the file tools kept inside the worktree, and the secret files denied. It
 * may edit and write there. Its shell runs a short allow-list and nothing else. A part is
 * built only through `board_check`, our code, never on the model's word.
 */

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));

export const BUILDER_TOOLS = ['board_read', 'board_part', 'board_update', 'board_post', 'board_try', 'board_check'] as const;
/** The built-in tools there are. Not Grep: a `Read` deny rule does not stop a search of the folder above a file. */
export const BUILDER_BUILTINS = ['Read', 'Glob', 'Edit', 'Write', 'Bash'] as const;

/*
 * The builder's shell fence. It is a list of names, matched on the command's text by Claude
 * Code's permission rules: it stops mistakes and a careless model, not an attacker. What holds
 * against an attacker is what the builder cannot reach: the tokens live outside the worktree,
 * the check is ours, and "built" needs our check to pass on a real commit.
 */

/**
 * The git the builder needs to commit, and git that reads commits and names: status, diff,
 * log and show. Not `grep`, `cat-file` or `archive`, which print a file's contents.
 */
export const GIT_ALLOWED = ['git status', 'git diff', 'git log', 'git show', 'git add', 'git commit', 'git rev-parse', 'git ls-files'] as const;

/**
 * Flags that would read or write a file outside the worktree, or run a program the repository
 * names: a diff of any two files, output to a file, a message from a file, a pathspec file.
 */
export const GIT_DENIED_FLAGS = ['--no-index', '--output', '--ext-diff', '--textconv', '--template', '--file', '--pathspec-from-file', '--exec', '--git-dir', '--work-tree', '--namespace', '--config-env'] as const;

/**
 * Git told to stand elsewhere or to take a setting from the command line: `git -C <dir>`,
 * `git -c <key>=<value>`, any long option before the command, and a `GIT_` setting written
 * in front of it. The builder's git is pinned to its worktree's own git folder, with no
 * hook. None of these may move it.
 */
export const GIT_DENIED_LEADS = ['git -C*', 'git -c*', 'git --*', 'GIT_*', 'env *', 'export *'] as const;

/**
 * Git that prints a file by its path at a revision (`git show HEAD:.env`), or a whole tree.
 * A path at a revision is caught when it has a dot or a slash; a secret's name is caught
 * anywhere by `secretNames`.
 */
export const GIT_DENIED_FORMS = ['git show *:*.*', 'git show *:*/*', 'git cat-file *', 'git archive *', 'git grep *'] as const;

/** The secret-file deny list as names a git command could carry: `.env`, `.pem`, `id_rsa`, `.ssh/`. */
export function secretNames(): string[] {
  const out: string[] = [];
  for (const f of DENIED_FILES) {
    const name = f
      .replace(/^(\*\*\/)+/, '')
      .replace(/\/\*\*$/, '/')
      .replace(/^\*/, '')
      .replace(/\*.*$/, '');
    if (name && !out.some((n) => name.includes(n))) out.push(name);
  }
  return out;
}

export interface BuilderOptions {
  /** `builder=none` switches the builder off: `run` fails at once and says so. */
  off: boolean;
  model: string;
  effort: string;
  bin: string;
  mcp: string;
  /** The builder's instructions. */
  prompt: string;
  /** The picture grammar: its `choice` section joins the instructions. */
  grammar: string;
  /** Commands the owner allows on top of the git list: `builder-allow=npm test;npm run lint`. */
  allow: string[];
  /** A part's turns together may run this long. */
  partTimeoutMs: number;
  /** The agreed check may run this long. */
  checkTimeoutMs: number;
  transcript: string | undefined;
  debug: boolean;
}

/** Read the builder's `--link-opt key=value` options. `bin` and `mcp` are shared with the link. */
export function builderOptions(o: Record<string, string> = {}): BuilderOptions {
  const secs = (v: string | undefined, d: number) => {
    const n = Number(v ?? d);
    return (Number.isFinite(n) && n > 0 ? n : d) * 1000;
  };
  return {
    off: o.builder === 'none' || o.builder === 'off',
    model: o['builder-model'] || 'sonnet',
    effort: o['builder-effort'] || 'medium',
    bin: o.bin || 'claude',
    mcp: path.resolve(o.mcp || path.join(PLUGIN_ROOT, 'dist', 'board-mcp.js')),
    prompt: path.resolve(o['builder-prompt'] || path.join(PLUGIN_ROOT, 'skills', 'board', 'builder.md')),
    grammar: path.resolve(o.grammar || path.join(PLUGIN_ROOT, 'skills', 'board', 'grammar.md')),
    allow: allowList(o['builder-allow']),
    partTimeoutMs: secs(o['builder-timeout'], 1800),
    checkTimeoutMs: secs(o['check-timeout'], 600),
    transcript: o['builder-transcript'] ? path.resolve(o['builder-transcript']) : undefined,
    debug: o.debug === '1' || o.debug === 'true',
  };
}

/** The owner's extra commands, one per `;`. A command that could break out of a rule is left out. */
export function allowList(value: string | undefined): string[] {
  return (value ?? '')
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && c.length <= 200 && !/[()\n\r]/.test(c));
}

/**
 * The shell rules: the git list with any arguments, and the owner's own. Not the agreed check:
 * a rule is a pattern, so a `*` in the check would widen it. The builder tries the check with
 * `board_try`, boxed in, instead.
 */
export function bashRules(allow: readonly string[]): { allow: string[]; deny: string[] } {
  const rule = (c: string) => `Bash(${c})`;
  return {
    allow: [...GIT_ALLOWED.map((c) => rule(`${c}:*`)), ...allow.map(rule)],
    deny: [
      ...GIT_DENIED_FLAGS.map((f) => rule(`git *${f}*`)),
      rule('git * -F *'),
      rule('git commit -F*'),
      ...GIT_DENIED_LEADS.map(rule),
      ...GIT_DENIED_FORMS.map(rule),
      ...secretNames().map((n) => rule(`git *${n}*`)),
    ],
  };
}

/**
 * The only settings the builder loads (`--restricted` loads no user, project or local file):
 * no hook, no read outside the worktree, the secret files denied for reading and writing, the
 * board's folder kept out of reach, and the shell rules.
 */
export function builderSettings(workdir: string, allow: readonly string[]): object {
  const root = ruleRoot(realDir(workdir));
  const bash = bashRules(allow);
  return {
    disableAllHooks: true,
    permissions: {
      blockReadsOutsideWorkingDirectories: true,
      // Files are written inside the builder's folder in its worktree, and nowhere else: not the
      // owner's checkout, not the owner's home. A bare `Edit` would allow any path.
      allow: [...BUILDER_TOOLS.map((t) => `mcp__board__${t}`), `Edit(${root}/**)`, `Write(${root}/**)`, ...bash.allow],
      deny: [
        ...DENIED_FILES.map((f) => `Read(${root}/${f})`),
        ...DENIED_FILES.map((f) => `Edit(${root}/${f})`),
        `Read(${root}/.keel/**)`,
        `Edit(${root}/.keel/**)`,
        // The worktree's link to its git folder is one file, `.git`: never the builder's to write.
        `Edit(${root}/.git)`,
        `Write(${root}/.git)`,
        ...bash.deny,
      ],
    },
  };
}

/** The flags the builder's process starts with. Never `--bare`, never a bypass mode. */
export function builderArgs(o: { model: string; effort: string; mcpConfig: string; promptFile: string; settingsFile: string }): string[] {
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', o.model,
    '--effort', o.effort,
    '--restricted',
    '--settings', o.settingsFile,
    '--mcp-config', o.mcpConfig,
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--tools', BUILDER_BUILTINS.join(','),
    '--allowedTools', [...BUILDER_TOOLS.map((t) => `mcp__board__${t}`), 'Edit', 'Write'].join(','),
    '--permission-mode', 'dontAsk',
    '--append-system-prompt-file', o.promptFile,
    '--no-session-persistence',
  ];
}

/** The `## choice` section of the grammar, so the builder can post a choice without reading a file. */
export function grammarSection(grammar: string, kind: string): string {
  const start = grammar.search(new RegExp(`^## ${kind}:`, 'm'));
  if (start < 0) return '';
  const rest = grammar.slice(start);
  const next = rest.slice(3).search(/^## /m);
  return (next < 0 ? rest : rest.slice(0, next + 3)).trim();
}

/** Where a chapter's build lives: its worktree, the builder's private files beside it, and the copy a finished build shows. */
export function buildPlaces(stateDir: string, chapter: string): { base: string; tree: string; own: string; show: string } {
  const base = path.join(stateDir, 'build', chapter);
  return { base, tree: path.join(base, 'tree'), own: path.join(base, 'own'), show: path.join(base, 'show') };
}

/** The board server clips a run's note at this length, and adds how to try again itself. */
const NOTE_MAX = 200;

/**
 * Why a build cannot start from nothing: the folder holds files of the owner's that no commit
 * has. It names a few of them and how many more (`undefined`: more than were counted), and
 * fits in `NOTE_MAX`, dropping names before it clips one.
 */
export function filesNote(kind: 'repo' | 'folder', names: readonly string[], more: number | undefined): string {
  const [lead, tail] =
    kind === 'repo'
      ? ['No commit yet: the builder\'s copy is made from commits, so it would lack your files (', '). Commit them first; the builder does not commit them for you.']
      : ['No git repository yet: the builder\'s copy is made from commits, so it would lack your files (', '). Run "git init" and commit them; the builder does not commit for you.'];
  const list = (shown: string[], rest: number | undefined) => {
    const others = rest === undefined ? 'more' : rest > 0 ? `${rest} more` : '';
    if (!others) return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown.join('');
    return `${shown.join(', ')} and ${others}`;
  };
  const room = NOTE_MAX - lead.length - tail.length;
  let shown = names.map((n) => clip(n, 40));
  let rest = more;
  while (shown.length > 1 && list(shown, rest).length > room) {
    shown = shown.slice(0, -1);
    rest = rest === undefined ? undefined : rest + 1;
  }
  const text = list(shown, rest);
  return `${lead}${text.length > room ? clip(text, room) : text}${tail}`;
}

/* ------------------------------------------------------------- the process */

interface Denial {
  tool: string;
  what: string;
}

interface TurnResult {
  ok: boolean;
  note?: string;
  costUsd?: number;
  denials: Denial[];
}

type StreamLine = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  permission_denials?: Array<{ tool_name?: string; tool_use_id?: string; tool_input?: Record<string, unknown> }>;
  message?: { content?: Array<{ type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: boolean; content?: unknown }> };
};

const clip = (s: string, max = 200) => {
  const f = s.replace(/\s+/g, ' ').trim();
  return f.length > max ? `${f.slice(0, max - 1)}…` : f;
};

const DENIED = /permission|denied|not allowed|requires approval|haven't granted/i;

/** One headless Claude Code process for one run. A turn is one line on its input. */
class BuildProcess {
  private readonly proc: ChildProcessWithoutNullStreams;
  private turn: ((r: TurnResult) => void) | undefined;
  private denials: Denial[] = [];
  private uses = new Map<string, Denial>();
  private stderrTail = '';
  /** The session's running total so far, as the stream reports it. */
  private costSoFar = 0;
  exited = false;

  constructor(
    bin: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    private readonly record: (line: object) => void,
    private readonly log: (m: string) => void,
  ) {
    this.proc = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    this.proc.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      buf += chunk;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const raw = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!raw) continue;
        try {
          this.onLine(JSON.parse(raw) as StreamLine);
        } catch {
          // Not a stream line.
        }
      }
    });
    this.proc.stderr.setEncoding('utf8').on('data', (c: string) => (this.stderrTail = (this.stderrTail + c).slice(-2000)));
    this.proc.stdin.on('error', () => {});
    this.proc.on('error', (e) => (this.stderrTail = `${this.stderrTail}\n${e.message}`.slice(-2000)));
    this.proc.on('close', (code, signal) => {
      this.exited = true;
      const tail = clip(this.stderrTail, 300);
      this.finish({ ok: false, note: `the builder's process stopped (exit ${code ?? signal})${tail ? `: ${tail}` : ''}`, denials: this.denials });
    });
  }

  get pid(): number | undefined {
    return this.proc.pid;
  }

  private finish(r: TurnResult): void {
    const t = this.turn;
    this.turn = undefined;
    this.denials = [];
    this.uses.clear();
    t?.(r);
  }

  private onLine(e: StreamLine): void {
    this.record(e);
    if (e.type === 'assistant') {
      for (const c of e.message?.content ?? []) {
        if (c.type === 'tool_use' && c.id && c.name && !c.name.startsWith('mcp__')) {
          this.uses.set(c.id, { tool: c.name, what: String(c.input?.command ?? c.input?.file_path ?? c.input?.pattern ?? '') });
        }
      }
      return;
    }
    if (e.type === 'user') {
      for (const c of e.message?.content ?? []) {
        if (c.type !== 'tool_result' || !c.is_error || !c.tool_use_id) continue;
        const use = this.uses.get(c.tool_use_id);
        const text = Array.isArray(c.content) ? c.content.map((x: { text?: string }) => x.text ?? '').join(' ') : String(c.content ?? '');
        if (use && DENIED.test(text) && !this.denials.some((d) => d.tool === use.tool && d.what === use.what)) this.denials.push(use);
      }
      return;
    }
    if (e.type === 'result') {
      for (const d of e.permission_denials ?? []) {
        const what = String(d.tool_input?.command ?? d.tool_input?.file_path ?? '');
        const tool = d.tool_name ?? '?';
        if (!tool.startsWith('mcp__') && !this.denials.some((x) => x.tool === tool && x.what === what)) this.denials.push({ tool, what });
      }
      const r: TurnResult = { ok: e.is_error !== true, denials: this.denials };
      // The stream reports the session's running total: this turn's own cost is the difference.
      if (typeof e.total_cost_usd === 'number') {
        r.costUsd = Math.max(0, e.total_cost_usd - this.costSoFar);
        this.costSoFar = e.total_cost_usd;
        this.record({ keel: 'turn-cost', usd: r.costUsd });
      }
      if (e.is_error) r.note = clip(`the turn ended in an error: ${e.result ?? e.subtype ?? 'no reason given'}`);
      this.finish(r);
    }
  }

  /** Send one message and wait for the turn to end, or for the time limit. */
  send(text: string, timeoutMs: number): Promise<TurnResult> {
    if (this.exited) return Promise.resolve({ ok: false, note: 'the builder\'s process is not running', denials: [] });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.log(`a part ran past ${Math.round(timeoutMs / 1000)} s; stopping the builder`);
        this.finish({ ok: false, note: `the part ran past ${Math.round(timeoutMs / 60_000)} minutes, so the builder was stopped`, denials: this.denials });
        this.proc.kill('SIGTERM');
      }, timeoutMs);
      this.turn = (r) => {
        clearTimeout(timer);
        resolve(r);
      };
      this.record({ keel: 'turn', text });
      this.proc.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null })}\n`);
    });
  }

  async stop(graceMs = 5000): Promise<void> {
    if (this.exited) return;
    const exited = new Promise<void>((r) => this.proc.once('close', () => r()));
    const within = (ms: number) => Promise.race([exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref())]);
    this.proc.stdin.end();
    if (!(await within(graceMs))) {
      this.proc.kill('SIGTERM');
      if (!(await within(5000))) this.proc.kill('SIGKILL');
    }
  }
}

/* ------------------------------------------------------------ the builder */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export class HostedBuilder implements Builder {
  readonly name: string;
  private running: Promise<BuildResult> | undefined;
  private pauseAsked = false;
  private closed = false;
  private proc: BuildProcess | undefined;
  private readonly agent: BoardClient;
  /** The private folder of the chapter in build: where the checks' pid files are. */
  private own: string | undefined;
  private saidNoSandbox = false;

  constructor(
    private readonly ctx: BuilderContext,
    private readonly opts: BuilderOptions,
  ) {
    this.name = opts.off ? 'builder (off)' : `claude builder (${opts.model}, worktree)`;
    this.agent = new BoardClient(() => ({ url: ctx.serverUrl.replace(/\/+$/, ''), token: ctx.agentToken }));
  }

  run(job: BuildJob): Promise<BuildResult> {
    if (this.running) return Promise.resolve({ outcome: 'failed', note: 'A build runs already. The builder runs one build at a time.' });
    if (this.closed) return Promise.resolve({ outcome: 'failed', note: 'The builder is closed.' });
    this.pauseAsked = false;
    const r = this.runJob(job)
      .catch((e: unknown): BuildResult => {
        const note = e instanceof Error ? e.message : String(e);
        this.ctx.log(`builder: the run failed: ${note}`);
        return { outcome: 'failed', note };
      })
      .finally(async () => {
        await this.proc?.stop().catch(() => undefined);
        // A check the tools left running dies with the run.
        if (this.own) stopLeftoverChecks(this.own);
        this.proc = undefined;
        this.running = undefined;
      });
    this.running = r;
    return r;
  }

  async pause(): Promise<void> {
    this.pauseAsked = true;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.pauseAsked = true;
    await this.proc?.stop(2000).catch(() => undefined);
    if (this.own) stopLeftoverChecks(this.own);
    await this.running?.catch(() => undefined);
  }

  /** Say something in the build feed. A lost entry never stops the build. */
  private async feed(chapter: string, text: string, kind: 'update' | 'problem' = 'update', part?: string): Promise<void> {
    try {
      await this.agent.post([{ type: 'feed.add', chapter, kind, text: clip(text, 400), ...(part ? { part } : {}) }]);
    } catch (e) {
      this.ctx.log(`builder: could not post to the feed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * The run cannot go on. The note is for the owner: the board server posts it to the feed as a
   * problem, with how many parts are built and how to try again, so the builder does not post it
   * twice. So a note says what went wrong and what to put right, and not what to press.
   */
  private async fail(chapter: string, note: string): Promise<BuildResult> {
    this.ctx.log(`builder: ${chapter}: ${note}`);
    return { outcome: 'failed', note };
  }

  private record(line: object): void {
    if (!this.opts.transcript) return;
    try {
      fs.appendFileSync(this.opts.transcript, `${JSON.stringify({ t: Date.now(), ...line })}\n`);
    } catch {
      // The transcript is for measuring.
    }
  }

  private async runJob(job: BuildJob): Promise<BuildResult> {
    const t0 = Date.now();
    const ch = job.chapter;
    if (this.opts.off) return { outcome: 'failed', note: 'The builder is off (builder=none), so nothing is built.' };
    if (!job.check) return this.fail(ch, 'The blueprint gave no check, so no part can be shown to work. Solidify again with a check.');

    if (!(await gitInstalled())) return this.fail(ch, 'Git is not installed here, and the builder works in a git copy of the folder. Install git.');
    let top = await repoTop(this.ctx.repoDir);
    let madeRepo = false;
    if (!top) {
      const made = await this.makeRepo(ch);
      if (typeof made !== 'string') return made;
      top = made;
      madeRepo = true;
    }
    const sub = path.relative(realDir(top), realDir(this.ctx.repoDir));
    const branch = `board/${ch}`;
    const places = buildPlaces(stateDirOf(this.ctx), ch);
    fs.mkdirSync(places.own, { recursive: true, mode: 0o700 });
    let gitDir: string;
    let fromNothing = false;
    try {
      ({ gitDir, fromNothing = false } = await ensureWorktree(top, places.tree, branch, { board: sub }));
    } catch (e) {
      if (e instanceof OwnerFilesError) return this.fail(ch, filesNote('repo', e.files.slice(0, 3), e.files.length - Math.min(3, e.files.length)));
      return this.fail(ch, `The builder could not make its own copy on ${branch}: ${e instanceof GitError ? e.message : String(e)}`);
    }
    // The board's folder may be one the commit does not hold, a new folder in the repository:
    // it is made in the worktree, and never through a link or outside it.
    let workdir = places.tree;
    if (sub) {
      try {
        workdir = safeDir(places.tree, sub);
      } catch (e) {
        if (e instanceof RecordPathError) return this.fail(ch, `The board's folder, ${oneLine(sub, 80)}, would leave the builder's copy or pass through a link in it, so nothing is built.`);
        throw e;
      }
    }
    if (samePath(workdir, this.ctx.repoDir)) return this.fail(ch, 'The builder\'s copy is the owner\'s own folder. It never builds there.');
    // Every git in the worktree, ours and the builder's own, is told where its git folder is:
    // it never reads a `.git` the code under test could have written. And no hook runs.
    const pin = pinEnv(gitDir, places.tree);
    // The owner is the author when git knows them; the committer is always the builder.
    const identity: NodeJS.ProcessEnv = (await hasIdentity(workdir, pin))
      ? { ...pin, GIT_COMMITTER_NAME: BUILDER_IDENTITY.GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL: BUILDER_IDENTITY.GIT_COMMITTER_EMAIL }
      : { ...pin, ...BUILDER_IDENTITY };

    let state = await this.agent.state();
    const c = state.chapters[ch];
    if (!c) return this.fail(ch, `There is no chapter "${ch}" on the board.`);
    if (c.state === 'built') return { outcome: 'done', note: `Every part of "${c.title}" is built already.` };
    if (c.state !== 'building') return this.fail(ch, `"${c.title}" is ${c.state}: the owner has not pressed "Build this".`);
    // The check is the one the owner agreed to on this machine, which the server puts in the job.
    // A board that names another one is not followed.
    const check = job.check;
    if (c.check !== check) {
      return this.fail(ch, `The board names the check "${oneLine(c.check ?? 'none', 120)}", but the owner agreed to "${oneLine(check, 120)}" on this machine. Nothing was built.`);
    }

    // The records, before any code. A resumed build finds them there and writes nothing.
    const date = new Date().toISOString().slice(0, 10);
    let rec: ReturnType<typeof writeRecords>;
    try {
      rec = writeRecords(workdir, ch, job.brief, (brief) => renderDecision(state, ch, { date, track: c.track, check, branch, brief }));
    } catch (e) {
      if (e instanceof RecordPathError) return this.fail(ch, `The records were not written: ${e.message}`);
      throw e;
    }
    if (rec.written) {
      await gitOk(workdir, ['add', '--', rec.brief, rec.decision], identity);
      await gitOk(workdir, ['-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--no-verify', '-m', `${oneLine(c.title, 72)}: the brief and the decision record`, '--', rec.brief, rec.decision], identity);
    }

    const ids = job.track.map((t) => t.id);
    const todo = ids.filter((id) => state.model.parts[id]?.state !== 'built');
    const builtBefore = c.track.length - c.track.filter((id) => state.model.parts[id]?.state !== 'built').length;
    if (fromNothing) {
      await this.feed(
        ch,
        madeRepo
          ? `This folder was no git repository, so the builder made it one with "git init". It had no commit to build on either, so the branch ${branch} starts from nothing: an empty first commit, then the build.`
          : `This folder has no commit yet, so the branch ${branch} starts from nothing: an empty first commit, then the build. Your own branch stays as it is.`,
      );
    }
    if (rec.written) {
      await this.feed(ch, `The builder started on its own branch, ${branch}, with ${plural(todo.length, 'part')} to build, one commit each. It committed the brief (${rec.brief}) and the decision record (${rec.decision}) first.`);
    } else {
      await this.feed(ch, `The builder goes on, on ${branch}: ${builtBefore} of ${plural(c.track.length, 'part')} built, ${todo.length} to go.`);
    }

    const box = sandboxKind();
    if (box.kind === 'none' && !this.saidNoSandbox) {
      this.saidNoSandbox = true;
      await this.feed(ch, NO_SANDBOX_NOTE);
    }

    // The process, fenced.
    this.own = places.own;
    const files = this.prepare(places.own, workdir, places.tree, gitDir, ch, check);
    let cost = 0;
    let first = true;
    const told = new Set<string>();
    try {
      for (const id of ids) {
        state = await this.agent.state();
        const chapter = state.chapters[ch];
        if (this.closed) return { outcome: 'paused', note: 'The board server stopped the builder. A resumed build goes on from here.' };
        if (this.pauseAsked || chapter?.paused) return this.paused(ch, state, chapter?.paused === true);
        const part = state.model.parts[id];
        if (!part || part.dropped) return this.fail(ch, `Part "${id}" is not in the model any more.`);
        if (part.state === 'built') continue;
        if (part.state !== 'solid' && part.state !== 'building') {
          // Reopened: the server holds the build and runs it again when the owner decides the part again.
          return { outcome: 'paused', note: `Stopped before ${part.name}: it is ${part.state} again. The build waits for the owner to decide it again.` };
        }
        if (part.state === 'building' && !readStarts(places.own)[id]) {
          const head = await headOf(workdir, identity);
          if (head) recordStart(places.own, id, head);
        }

        const n = chapter!.track.indexOf(id) + 1;
        const total = chapter!.track.length;
        this.ctx.presence({ state: 'building', note: clip(`building part ${n} of ${total}: ${part.name}`, 120) });
        this.proc ??= this.start(files, workdir, identity);

        const msg = this.partMessage(state, job, id, n, total, check, branch, first, told);
        first = false;
        const p0 = Date.now();
        let turn = await this.proc.send(msg, this.opts.partTimeoutMs);
        cost += turn.costUsd ?? 0;
        await this.reportDenials(ch, id, turn);
        state = await this.agent.state();
        if (turn.ok && state.model.parts[id]?.state !== 'built' && !this.closed) {
          const left = this.opts.partTimeoutMs - (Date.now() - p0);
          turn = await this.proc.send(this.nudge(state, id), Math.max(left, 60_000));
          cost += turn.costUsd ?? 0;
          await this.reportDenials(ch, id, turn);
          state = await this.agent.state();
        }
        if (this.closed) return { outcome: 'paused', note: 'The board server stopped the builder. A resumed build goes on from here.' };
        if (state.model.parts[id]?.state !== 'built') {
          const why = turn.ok ? `${part.name} is not built: no check passed on a new commit` : `${part.name} is not built: ${turn.note ?? 'the turn failed'}`;
          return this.fail(ch, `${why}. The build stops here. Resume it after a look at the feed.`);
        }
        this.ctx.log(`builder: ${id} built in ${((Date.now() - p0) / 60_000).toFixed(1)} min, $${cost.toFixed(4)} so far`);
      }
    } finally {
      fs.rmSync(files.dir, { recursive: true, force: true });
    }

    state = await this.agent.state();
    const done = state.chapters[ch];
    const minutes = ((Date.now() - t0) / 60_000).toFixed(1);
    if (done?.state !== 'built') {
      const left = (done?.track ?? []).filter((id) => state.model.parts[id]?.state !== 'built');
      return this.fail(ch, `The track ran out with ${plural(left.length, 'part')} not built: ${left.join(', ')}.`);
    }
    // The result: the brief again, from the board as it is now, as the branch's last commit.
    const result = await this.commitResult(workdir, rec.brief, state, ch, `${oneLine(done.title, 72)}: the brief, with the result`, identity);
    // What the owner can look at, copied out before the worktree goes. It never fails the build.
    const show = await makeShow({ workdir, env: pin, dest: places.show, log: (m) => this.ctx.log(`builder: ${ch}: ${m}`) }).catch((e: unknown) => {
      this.ctx.log(`builder: ${ch}: no show: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    });
    await this.feed(ch, `Every part is built, on the branch ${branch}${result ? `, with the brief brought up to date (${rec.brief})` : ''}. Merge it when you are ready: git merge ${branch}.`);
    await removeWorktree(top, places.tree).catch(() => undefined);
    return { outcome: 'done', note: `${plural(done.track.length, 'part')} built on ${branch} in ${minutes} min, $${cost.toFixed(2)}.`, ...(show ? { show } : {}) };
  }

  /**
   * The board's folder is no git repository. When it holds nothing of the owner's, the builder
   * makes it one, and the build starts from nothing. When it holds files, it stops: the
   * builder's copy is made from commits, and the owner's files are theirs to commit.
   * Returns the new repository's top, or the failed result.
   */
  private async makeRepo(ch: string): Promise<string | BuildResult> {
    const dir = this.ctx.repoDir;
    // A `.git` that git cannot read is not an empty folder: say what git says.
    if (fs.existsSync(path.join(dir, '.git'))) {
      const r = await git(dir, ['rev-parse', '--show-toplevel']);
      return this.fail(ch, `Git cannot read the repository in this folder, so the builder has no copy to work in: ${clip(r.stderr || r.stdout, 100)}`);
    }
    let theirs: ReturnType<typeof folderFiles>;
    try {
      theirs = folderFiles(dir);
    } catch (e) {
      return this.fail(ch, `The builder could not look in ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (theirs.names.length > 0) return this.fail(ch, filesNote('folder', theirs.names, theirs.more));
    await gitOk(dir, ['init', '--quiet']);
    const top = await repoTop(dir);
    if (!top) return this.fail(ch, 'The builder ran "git init" here, but git still finds no repository, so nothing is built.');
    this.ctx.log(`builder: ${ch}: ${dir} was no git repository; the builder made it one`);
    return top;
  }

  /**
   * Write the brief again from the board's state, and commit it when it changed. Only a build
   * that finished calls this: a build that stops or pauses leaves the brief as it was.
   */
  private async commitResult(workdir: string, briefRel: string, state: BoardState, ch: string, message: string, identity: NodeJS.ProcessEnv): Promise<boolean> {
    const text = renderBrief(state, ch);
    const file = path.join(workdir, briefRel);
    if (!text || !briefRel) return false;
    try {
      if (fs.lstatSync(file).isFile() && fs.readFileSync(file, 'utf8') === text) return false;
      replaceFile(workdir, briefRel, text);
      await gitOk(workdir, ['add', '--', briefRel], identity);
      await gitOk(workdir, ['-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '--no-verify', '-m', message, '--', briefRel], identity);
      return true;
    } catch (e) {
      this.ctx.log(`builder: the brief's result was not committed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /**
   * The run stops when asked. Only the owner's own pause is "paused" in the feed. A run the
   * server holds for a reopened part, or stops as it closes, says nothing: the server says why.
   */
  private async paused(ch: string, state: BoardState, byOwner: boolean): Promise<BuildResult> {
    const c = state.chapters[ch];
    const built = (c?.track ?? []).filter((id) => state.model.parts[id]?.state === 'built').length;
    const reopened = (c?.track ?? []).filter((id) => state.model.parts[id]?.state === 'idea').map((id) => state.model.parts[id]?.name ?? id);
    if (!byOwner) {
      const why = reopened.length ? `${reopened.join(', ')} ${reopened.length === 1 ? 'is' : 'are'} an idea again` : 'the board asked it to stop';
      return { outcome: 'paused', note: `Stopped after ${built} of ${plural(c?.track.length ?? 0, 'part')}: ${why}.` };
    }
    const note = `Paused after ${built} of ${plural(c?.track.length ?? 0, 'part')}. A resumed build goes on from the next part.`;
    await this.feed(ch, note);
    return { outcome: 'paused', note };
  }

  private async reportDenials(ch: string, part: string, turn: TurnResult): Promise<void> {
    if (turn.denials.length === 0) return;
    const list = turn.denials.slice(0, 3).map((d) => (d.tool === 'Bash' ? `\`${clip(d.what, 80)}\`` : `${d.tool} ${clip(d.what, 60)}`));
    const more = turn.denials.length > 3 ? `, and ${turn.denials.length - 3} more` : '';
    this.ctx.log(`builder: denied ${turn.denials.map((d) => `${d.tool} ${d.what}`).join(' | ')}`);
    await this.feed(ch, `The builder was denied ${list.join(', ')}${more}. Its shell runs git and the check only. To allow a command, add it to builder-allow.`, 'problem', part);
  }

  /** The message for one part. The first one carries the brief. */
  private partMessage(state: BoardState, job: BuildJob, id: string, n: number, total: number, check: string, branch: string, first: boolean, told: Set<string>): string {
    // Every piece of board text goes in on one line: a line break in it must not stand as a line of its own.
    const p = state.model.parts[id]!;
    const lines = [`BUILD ${oneLine(state.chapters[job.chapter]?.title ?? job.chapter, 90)} · part ${n} of ${total}: ${oneLine(p.name, 40)} (\`${id}\`)${p.plain ? `: ${oneLine(p.plain, 80)}` : ''}`];
    if (p.files?.length) lines.push(`Files it touches: ${p.files.map((f) => oneLine(f, 200)).join(', ')}`);
    if (p.note) lines.push(`Noted on the part: ${oneLine(p.note, 200)}`);
    for (const r of remarksOnPart(state, id)) lines.push(`The owner said, on this part: "${oneLine(r.text, 300)}". Build what the owner said.`);
    lines.push(`The check the owner agreed to: \`${oneLine(check, 300)}\`. Try it with board_try. You are on ${branch}, in your own worktree.`);
    if (p.state === 'building') lines.push('This part is building already, from an earlier run: carry on from the code on the branch, and do not call board_part again.');
    for (const s of Object.values(state.items)) {
      if (s.removed || s.chapter !== job.chapter || s.item.kind !== 'picture' || s.item.picture.kind !== 'choice') continue;
      const pic = s.item.picture;
      if (s.chosenBy !== 'owner' || s.chosen === undefined || s.chosen === pic.chosen) continue;
      const key = `${s.item.id}:${s.chosen}`;
      if (told.has(key)) continue;
      told.add(key);
      const label = pic.options.find((o) => o.id === s.chosen)?.label ?? s.chosen;
      lines.push(`The owner changed your choice "${oneLine(pic.title, 90)}" to "${oneLine(label, 60)}". Follow it from now on.`);
    }
    if (first) lines.push('', 'THE BRIEF', '', job.brief.trim());
    lines.push('', 'Build this part now: board_part, write it and the test that proves it, board_try, commit, board_check, then board_update naming that test. Then end with: done.');
    return lines.join('\n');
  }

  private nudge(state: BoardState, id: string): string {
    const p = state.model.parts[id];
    return `Part \`${id}\` is ${p?.state ?? 'not on the board'}, not built. It is built only when board_check passes on a new commit. Finish it now: commit your work, then call board_check with {"part": "${id}"}. If something stops you, say what with board_update and "kind": "problem", then end.`;
  }

  /** The private files of one run: the tools' config with the tokens, the settings, the instructions. */
  private prepare(own: string, workdir: string, tree: string, gitDir: string, chapter: string, check: string): { dir: string; mcpConfig: string; promptFile: string; settingsFile: string } {
    for (const [what, file] of [['board tools', this.opts.mcp], ['builder\'s instructions', this.opts.prompt]] as const) {
      if (!fs.existsSync(file)) throw new BoardError(`The ${what} are missing at ${file}. Build the plugin: npm run build -w @keel/board-plugin.`);
    }
    const dir = fs.mkdtempSync(path.join(own, 'run-'));
    const mcpConfig = path.join(dir, 'mcp.json');
    const env = {
      KEEL_BOARD_URL: this.ctx.serverUrl,
      KEEL_BOARD_TOKEN: this.ctx.agentToken,
      KEEL_BOARD_SYSTEM_TOKEN: this.ctx.systemToken,
      KEEL_BOARD_ROLE: 'builder',
      KEEL_BUILD_CHAPTER: chapter,
      KEEL_BUILD_CHECK: check,
      KEEL_BUILD_WORKDIR: workdir,
      KEEL_BUILD_TREE: tree,
      KEEL_BUILD_GIT_DIR: gitDir,
      KEEL_BUILD_STATE: own,
      KEEL_BUILD_DENY_READ: JSON.stringify(this.denyRead()),
      KEEL_BUILD_CHECK_TIMEOUT: String(Math.round(this.opts.checkTimeoutMs / 1000)),
      // The tools decide the box. They must decide as this process did, or the feed would say one thing and the check do another.
      ...(process.env.KEEL_SANDBOX ? { KEEL_SANDBOX: process.env.KEEL_SANDBOX } : {}),
    };
    // It holds both tokens: only this user reads it, it lives outside the worktree, and it goes when the run ends.
    fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { board: { command: process.execPath, args: [this.opts.mcp], env } } }), { mode: 0o600 });
    const promptFile = path.join(dir, 'builder.md');
    const grammar = fs.existsSync(this.opts.grammar) ? grammarSection(fs.readFileSync(this.opts.grammar, 'utf8'), 'choice') : '';
    fs.writeFileSync(promptFile, `${stripFrontmatter(fs.readFileSync(this.opts.prompt, 'utf8')).trimEnd()}\n\n${grammar}\n`, { mode: 0o600 });
    const settingsFile = path.join(dir, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify(builderSettings(workdir, this.opts.allow)), { mode: 0o600 });
    return { dir, mcpConfig, promptFile, settingsFile };
  }

  /** What the check may not read: the whole state root (every board's tokens), the board's private folder, the owner's .keel and keys. */
  private denyRead(): string[] {
    const home = path.join(os.homedir(), '.keel');
    const root = process.env[STATE_DIR_ENV] ? path.resolve(process.env[STATE_DIR_ENV]!) : home;
    // The usual private folder too, when this board keeps its own elsewhere: other boards may use it.
    return [...new Set([...defaultDenyRead({ stateRoot: root, ownerRepo: this.ctx.repoDir }), home, path.dirname(stateDirOf(this.ctx)), stateDirOf(this.ctx)])];
  }

  private start(files: { mcpConfig: string; promptFile: string; settingsFile: string }, workdir: string, identity: NodeJS.ProcessEnv): BuildProcess {
    const args = builderArgs({ model: this.opts.model, effort: this.opts.effort, ...files });
    const env = { ...childEnv(), ...identity, MCP_TOOL_TIMEOUT: String(this.opts.checkTimeoutMs + 120_000) };
    const p = new BuildProcess(this.opts.bin, args, workdir, env, (l) => this.record(l), (m) => this.ctx.log(`builder: ${m}`));
    this.ctx.log(`builder: started claude in ${workdir}, pid ${p.pid ?? '?'}`);
    return p;
  }
}

/** What the board server loads, beside `createLink`, from the same module. */
export const createBuilder: CreateBuilder = (ctx) => new HostedBuilder(ctx, builderOptions(ctx.options));
