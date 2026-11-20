import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { FeedAdd, Id, oneLine } from '@keel/protocol';
import { BoardClient, BoardError, RefusedError, refusalText } from './client';
import { dirtyFiles, headOf, isAncestor, pinEnv, shortOf } from './git';
import type { SandboxKind } from './sandbox';
import { sandboxPlan } from './sandbox';
import { readStarts, recordStart } from './starts';
import type { PostInput } from './tools';
import { PostPicture, ReadInput, checkSpecs, itemView, modelView, postDrafts } from './tools';

/**
 * The builder's board tools. The builder reads the board, says a part is "building", writes
 * to the feed, posts a choice it made, tries the check, and asks for the check. It never says
 * "built": that is `board_check`, which is our code. It runs the one command the owner agreed
 * to on this machine, which the builder hands it and never the model, on a new commit, boxed
 * in (see `sandbox.ts`), and only then posts "built" as the system.
 *
 * The tools find their place from the environment the builder starts them with:
 *   KEEL_BOARD_URL, KEEL_BOARD_TOKEN   the board, with the agent's token
 *   KEEL_BOARD_SYSTEM_TOKEN            the token "built" is posted with
 *   KEEL_BUILD_CHAPTER                 the chapter being built
 *   KEEL_BUILD_CHECK                   the check the owner agreed to, from the job
 *   KEEL_BUILD_WORKDIR                 the repository's folder in the builder's worktree
 *   KEEL_BUILD_TREE                    the top of that worktree
 *   KEEL_BUILD_GIT_DIR                 the worktree's own git folder, which git is pinned to
 *   KEEL_BUILD_STATE                   the builder's private folder (outside the worktree)
 *   KEEL_BUILD_DENY_READ               folders the check may not read, as a JSON list
 *   KEEL_BUILD_CHECK_TIMEOUT           seconds a check may run, 600 by default
 */

export interface BuildEnv {
  chapter: string;
  /** The check the owner agreed to on this machine, from the job. Never from the board, never from the model. */
  check?: string;
  /** The repository's folder in the builder's worktree: where the check runs. */
  workdir: string;
  /** The worktree's top: what the check may read and write. */
  tree?: string;
  /** The worktree's own git folder. Git is pinned to it, so it never reads a `.git` the code under test could have written. */
  gitDir?: string;
  /** The builder's private folder: when each part started, and the checks that run. */
  stateDir: string;
  systemToken?: string;
  checkTimeoutMs: number;
  /** Folders the check may not read. */
  denyRead?: string[];
}

export const ROLE_ENV = 'KEEL_BOARD_ROLE';

export function buildEnvFrom(env: NodeJS.ProcessEnv = process.env): BuildEnv | undefined {
  if (env[ROLE_ENV] !== 'builder') return undefined;
  const seconds = Number(env.KEEL_BUILD_CHECK_TIMEOUT ?? 600);
  const out: BuildEnv = {
    chapter: env.KEEL_BUILD_CHAPTER ?? '',
    workdir: env.KEEL_BUILD_WORKDIR ?? '',
    stateDir: env.KEEL_BUILD_STATE ?? '',
    checkTimeoutMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 600_000,
  };
  if (env.KEEL_BOARD_SYSTEM_TOKEN) out.systemToken = env.KEEL_BOARD_SYSTEM_TOKEN;
  if (env.KEEL_BUILD_CHECK) out.check = env.KEEL_BUILD_CHECK;
  if (env.KEEL_BUILD_TREE) out.tree = env.KEEL_BUILD_TREE;
  if (env.KEEL_BUILD_GIT_DIR) out.gitDir = env.KEEL_BUILD_GIT_DIR;
  try {
    const deny = JSON.parse(env.KEEL_BUILD_DENY_READ ?? '[]') as unknown;
    if (Array.isArray(deny)) out.denyRead = deny.filter((d): d is string => typeof d === 'string' && path.isAbsolute(d));
  } catch {
    // No list: the box still denies the state folder below.
  }
  return out;
}

/* ------------------------------------------------------------- the check */

export interface CheckRun {
  /** The exit code, or null when it was stopped. */
  code: number | null;
  timedOut: boolean;
  output: string;
  seconds: number;
  /** The box it ran in. */
  sandbox: SandboxKind;
}

const OUTPUT_KEPT = 64 * 1024;

/** The process groups of the checks that run now. They die with this process. */
/** Each running check's process group, and its temp folder. */
const running = new Map<number, string>();
export const CHECKS_DIR = 'checks';

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Gone already.
  }
}

/** Stop every check this process started, with its whole process group. */
export function stopAllChecks(): void {
  for (const [pid, tmp] of running) {
    killGroup(pid, 'SIGKILL');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  running.clear();
}

/** Stop the checks a builder's tools left behind, from the pid files in its private folder. */
export function stopLeftoverChecks(stateDir: string): void {
  const dir = path.join(stateDir, CHECKS_DIR);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const pid = Number(n);
    if (Number.isInteger(pid) && pid > 1) killGroup(pid, 'SIGKILL');
    fs.rmSync(path.join(dir, n), { force: true });
  }
}

/** The environment for git in the builder's worktree: pinned to its own git folder when the builder gave one. */
export function gitPin(build: Pick<BuildEnv, 'gitDir' | 'tree' | 'workdir'> | undefined): NodeJS.ProcessEnv {
  return build?.gitDir ? pinEnv(build.gitDir, build.tree ?? build.workdir) : {};
}

/** What a check's places are, from the builder's: it may not change the worktree's link to its git folder. */
function checkPlaces(build: BuildEnv): CheckPlaces {
  const root = build.tree ?? build.workdir;
  return { ...(build.tree ? { root: build.tree } : {}), stateDir: build.stateDir, denyRead: build.denyRead ?? [], denyWrite: [path.join(root, '.git')] };
}

export interface CheckPlaces {
  /** The worktree's top: what the check may read and write. Left out: the folder it runs in. */
  root?: string;
  /** Paths inside it that the check may not change. */
  denyWrite?: string[];
  /** The builder's private folder: a pid file per running check goes there. */
  stateDir?: string;
  denyRead?: string[];
}

/**
 * Run one command in `cwd`, boxed in where the system has a box, with an allow-listed
 * environment and a time limit. The whole process group is stopped at the limit.
 */
export function runCheck(cmd: string, cwd: string, timeoutMs: number, places: CheckPlaces = {}): Promise<CheckRun> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keel-check-')));
    const denyRead = [...(places.denyRead ?? []), ...(places.stateDir ? [places.stateDir] : [])];
    const plan = sandboxPlan(cmd, { workdir: places.root ?? cwd, tmp, denyRead, denyWrite: places.denyWrite ?? [] });
    const p = spawn(plan.bin, plan.args, { cwd, env: plan.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true });
    const pidFile = places.stateDir && p.pid ? path.join(places.stateDir, CHECKS_DIR, String(p.pid)) : undefined;
    if (p.pid) running.set(p.pid, tmp);
    if (pidFile) {
      try {
        fs.mkdirSync(path.dirname(pidFile), { recursive: true, mode: 0o700 });
        fs.writeFileSync(pidFile, '', { mode: 0o600 });
      } catch {
        // The builder's own clean-up is the second line; this process's is the first.
      }
    }
    let output = '';
    let timedOut = false;
    const keep = (d: Buffer) => {
      output = (output + d.toString('utf8')).slice(-OUTPUT_KEPT);
    };
    p.stdout.on('data', keep);
    p.stderr.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      if (p.pid) killGroup(p.pid, 'SIGTERM');
      setTimeout(() => p.pid && killGroup(p.pid, 'SIGKILL'), 5000).unref();
    }, timeoutMs);
    p.on('error', (e) => {
      output += `\n${e.message}`;
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (p.pid) {
        // Whatever the check left running in its group goes with it.
        killGroup(p.pid, 'SIGKILL');
        running.delete(p.pid);
      }
      if (pidFile) fs.rmSync(pidFile, { force: true });
      fs.rmSync(tmp, { recursive: true, force: true });
      resolve({ code: timedOut ? null : code, timedOut, output, seconds: Math.round((Date.now() - t0) / 100) / 10, sandbox: plan.kind });
    });
  });
}

/** The last lines of the output, at most `chars` long. */
export function tailOf(output: string, lines = 40, chars = 4000): string {
  const all = output.replace(/\r/g, '').trimEnd().split('\n');
  const tail = all.slice(-lines).join('\n');
  return tail.length > chars ? `…${tail.slice(-(chars - 1))}` : tail;
}

const flat = (s: string, max: number) => {
  const f = s.replace(/\s+/g, ' ').trim();
  return f.length > max ? `${f.slice(0, max - 1)}…` : f;
};

/* ----------------------------------------------------------------- inputs */

export const BuilderPartInput = z.strictObject({
  part: Id.describe('The part you start now, from the build track.'),
  state: z.literal('building').describe('Always "building". "built" comes from board_check.'),
});

export const BuilderUpdateInput = z.strictObject({
  text: FeedAdd.shape.text.describe('One or two plain sentences for the build feed.'),
  part: FeedAdd.shape.part,
  kind: z.enum(['update', 'problem']).optional().describe('"problem" when something stops you or needs the owner.'),
});

export const BuilderPostInput = z.strictObject({
  pictures: z
    .array(
      PostPicture.pick({ picture: true, from: true, name: true, near: true, side: true }).extend({
        picture: z.looseObject({ kind: z.literal('choice') }).describe('A choice picture, as grammar.md gives it.'),
      }),
    )
    .min(1)
    .max(3),
});

/** board_try takes nothing: the command is the one the owner agreed to. */
export const TryInput = z.strictObject({});

export const CheckInput = z.strictObject({
  part: Id.describe('The part you committed. The command is the one the owner agreed to; you do not give it.'),
});

/* ------------------------------------------------------------------ tools */

const ok = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });

const NOT_BUILDER = 'board_check works only inside the builder, which starts it with the board\'s system token and its own worktree.';

export interface CheckOutcome {
  ok: boolean;
  text: string;
}

/**
 * The check, as `board_check` runs it. Refuses unless the part is building and the branch has
 * a commit since the part started, and the worktree holds nothing uncommitted. Runs the
 * command the owner agreed to on this machine, which the builder handed this process, and
 * refuses when the board names another one. Posts "built" or a problem as the system.
 */
export async function boardCheck(agent: BoardClient, system: BoardClient | undefined, build: BuildEnv | undefined, part: string): Promise<CheckOutcome> {
  if (!build || !system || !build.systemToken || !build.workdir || !build.stateDir || !build.chapter) return { ok: false, text: NOT_BUILDER };
  const state = await agent.state();
  const c = state.chapters[build.chapter];
  if (!c) return { ok: false, text: `There is no chapter "${build.chapter}" on the board.` };
  const p = state.model.parts[part];
  if (!p || p.dropped) return { ok: false, text: `There is no part "${part}".` };
  if (!c.track.includes(part)) return { ok: false, text: `Part "${part}" is not on the build track of "${oneLine(c.title, 90)}": ${c.track.join(', ')}.` };
  if (p.state === 'built') return { ok: false, text: `Part "${part}" is built already, at ${p.commit ?? 'its commit'}.` };
  if (p.state !== 'building') return { ok: false, text: `Part "${part}" is ${p.state}. Only a part that is building is checked: call board_part with "building" first.` };
  const cmd = build.check;
  if (!cmd) return { ok: false, text: 'The builder was given no agreed check, so no part can be built. Post a problem with board_update, and stop.' };
  if (c.check !== cmd) {
    return { ok: false, text: `The board names the check "${oneLine(c.check ?? 'none', 120)}", but the owner agreed to "${oneLine(cmd, 120)}" here. Nothing was run. Post a problem with board_update, and stop.` };
  }
  const start = readStarts(build.stateDir)[part]?.start;
  if (!start) return { ok: false, text: `The builder has no record of when part "${part}" started. Post a problem with board_update, and stop.` };

  const pin = gitPin(build);
  const head = await headOf(build.workdir, pin);
  if (!head) return { ok: false, text: 'The worktree has no commit. Commit the part first.' };
  const startShort = await shortOf(build.workdir, start, pin).catch(() => start.slice(0, 7));
  if (head === start) {
    return { ok: false, text: `There is no new commit since part "${part}" started at ${startShort}. Commit the part first (git add, then git commit), then call board_check again.` };
  }
  if (!(await isAncestor(build.workdir, start, head, pin))) {
    return { ok: false, text: `The branch no longer holds ${startShort}, where part "${part}" started. Build on top of it, commit, and call board_check again.` };
  }
  const dirty = await dirtyFiles(build.workdir, pin);
  if (dirty.length) {
    const list = dirty.slice(0, 5).map((l) => l.slice(3)).join(', ');
    return { ok: false, text: `Some changes are not committed: ${list}${dirty.length > 5 ? `, and ${dirty.length - 5} more` : ''}. The check runs on the commit: commit them or take them out, then call board_check again.` };
  }

  const commit = await shortOf(build.workdir, head, pin);
  const run = await runCheck(cmd, build.workdir, build.checkTimeoutMs, checkPlaces(build));
  if (run.code === 0) {
    try {
      await system.post([{ type: 'part.state', part, state: 'built', commit, check: { cmd, passed: true } }]);
    } catch (e) {
      if (e instanceof RefusedError) return { ok: false, text: `\`${cmd}\` passed at ${commit}, but the board refused "built".\n${refusalText(e.refusal)}` };
      throw e;
    }
    return { ok: true, text: `Part "${part}" is built: \`${cmd}\` passed at ${commit} in ${run.seconds} s.` };
  }

  const why = run.timedOut ? `stopped after ${Math.round(build.checkTimeoutMs / 1000)} s` : `exit ${run.code ?? '?'}`;
  const tail = tailOf(run.output);
  const head1 = `The check \`${cmd}\` failed for ${oneLine(p.name, 60)} at ${commit} (${why}).`;
  const problem = (text: string) => system.post([{ type: 'feed.add', chapter: build.chapter, kind: 'problem', part, commit, check: { cmd, passed: false }, text: flat(text, 400) }]);
  try {
    await problem(`${head1} ${tailOf(run.output, 4, 300)}`);
  } catch (e) {
    // The board takes no words that look like a secret, and a failing check may print one.
    // The owner must still learn that the check failed: say so without the output.
    if (e instanceof RefusedError) {
      try {
        await problem(`${head1} Its output is not shown here: the board refused it (${e.refusal.rule}).`);
      } catch {
        // The feed is for the owner. The tail still goes back to the builder.
      }
    }
  }
  return { ok: false, text: `${head1} The part is still building. The end of its output:\n${tail || '(no output)'}\nFix it, commit again, and call board_check again.` };
}

/** The agreed check on the files as they are: no commit needed, nothing posted, nothing built. */
export async function boardTry(build: BuildEnv | undefined): Promise<CheckOutcome> {
  if (!build?.workdir || !build.check) return { ok: false, text: 'board_try works only inside the builder, which hands it the agreed check and its worktree.' };
  const run = await runCheck(build.check, build.workdir, build.checkTimeoutMs, checkPlaces(build));
  const tail = tailOf(run.output) || '(no output)';
  if (run.code === 0) return { ok: true, text: `\`${build.check}\` passes on the files as they are (${run.seconds} s). Nothing is built until you commit and call board_check.\n${tailOf(run.output, 8, 800)}` };
  const why = run.timedOut ? `stopped after ${Math.round(build.checkTimeoutMs / 1000)} s` : `exit ${run.code ?? '?'}`;
  return { ok: false, text: `\`${build.check}\` fails on the files as they are (${why}). The end of its output:\n${tail}` };
}

export function createBuilderMcp(agent: BoardClient, build: BuildEnv | undefined, system?: BoardClient): McpServer {
  const server = new McpServer(
    { name: 'board', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: 'The owner\'s board, seen from the builder. Say "building" with board_part, try the check with board_try, commit, then board_check. Only board_check makes a part built.' },
  );
  const chapter = () => {
    if (!build?.chapter) throw new BoardError('The builder\'s chapter is not set.');
    return build.chapter;
  };
  const run = async (fn: () => Promise<string>, what?: (i: number) => string): Promise<CallToolResult> => {
    try {
      return ok(await fn());
    } catch (e) {
      if (e instanceof RefusedError) return fail(refusalText(e.refusal, what));
      if (e instanceof BoardError) return fail(e.message);
      throw e;
    }
  };

  server.registerTool(
    'board_read',
    {
      description: 'The board now: with no input, the digest. "items": pictures or marks in full, such as the blueprint. "model": the whole model.',
      inputSchema: ReadInput,
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      run(async () => {
        if (!args.items && !args.model) return (await agent.digest()).text;
        const state = await agent.state();
        const out: string[] = [];
        for (const id of args.items ?? []) out.push(itemView(state, id));
        if (args.model) out.push(`MODEL ${modelView(state)}`);
        return out.join('\n\n');
      }),
  );

  server.registerTool(
    'board_part',
    {
      description: 'Say you start a part of the build track: "building". Call it first, before you write the part. Only board_check makes a part built.',
      inputSchema: BuilderPartInput,
    },
    async (args) =>
      run(async () => {
        const [ev] = await agent.post([{ type: 'part.state', part: args.part, state: 'building', chapter: chapter() }]);
        const head = build?.workdir ? await headOf(build.workdir, gitPin(build)) : undefined;
        if (head && build?.stateDir) recordStart(build.stateDir, args.part, head);
        return `Part ${args.part} is building${ev ? ` (${ev.id})` : ''}.`;
      }),
  );

  server.registerTool(
    'board_update',
    {
      description: 'One entry in the build feed: what a part does now, or a problem that stops you. Plain words.',
      inputSchema: BuilderUpdateInput,
    },
    async (args) =>
      run(async () => {
        const draft: Record<string, unknown> = { type: 'feed.add', chapter: chapter(), text: args.text, kind: args.kind ?? 'update' };
        if (args.part) draft.part = args.part;
        const [ev] = await agent.post([draft]);
        return `Added to the feed${ev ? ` (${ev.id})` : ''}.`;
      }),
  );

  server.registerTool(
    'board_post',
    {
      description: 'Post a choice you made alone while building: a "choice" picture, with the option in force as "chosen". It never waits for the owner.',
      inputSchema: BuilderPostInput,
    },
    async (args) => {
      let labels: string[] = [];
      return run(
        async () => {
          const input = args as unknown as PostInput;
          const bad = checkSpecs(input);
          if (bad) throw new BoardError(bad);
          const ch = chapter();
          const state = await agent.state();
          const blueprint = state.chapters[ch]?.blueprint;
          const pictures = input.pictures.map((p) => (p.from?.length || !blueprint ? p : { ...p, from: [blueprint] }));
          const built = postDrafts({ pictures }, () => ch, state);
          labels = built.labels;
          await agent.post(built.drafts);
          return [`Posted: ${built.ids.join(', ')}`, ...built.notes].join('\n');
        },
        (i) => labels[i] ?? `entry ${i + 1}`,
      );
    },
  );

  let checking = false;
  server.registerTool(
    'board_try',
    {
      description:
        'Run the check the owner agreed to now, on the files as they are, before you commit. It marks nothing built. It runs boxed in: no network, and writes only inside your worktree.',
      inputSchema: TryInput,
    },
    async () =>
      run(async () => {
        if (checking) throw new BoardError('A check runs already. Wait for it, then call again.');
        checking = true;
        try {
          const r = await boardTry(build);
          if (!r.ok) throw new BoardError(r.text);
          return r.text;
        } finally {
          checking = false;
        }
      }),
  );

  server.registerTool(
    'board_check',
    {
      description:
        'Run the check the owner agreed to on your latest commit. When it passes, the part is built. When it fails, you get the end of its output. It needs the part to be building and a commit since the part started.',
      inputSchema: CheckInput,
    },
    async (args) =>
      run(async () => {
        if (checking) throw new BoardError('A check runs already. Wait for it, then call board_check again.');
        checking = true;
        try {
          const r = await boardCheck(agent, system, build, args.part);
          if (!r.ok) throw new BoardError(r.text);
          return r.text;
        } finally {
          checking = false;
        }
      }),
  );

  return server;
}

/** The builder's tools, with the agent's client and the system's, from the environment. */
export function builderMcpFromEnv(env: NodeJS.ProcessEnv = process.env): McpServer {
  const build = buildEnvFrom(env);
  const url = (env.KEEL_BOARD_URL ?? '').replace(/\/+$/, '');
  const system = build?.systemToken && url ? new BoardClient(() => ({ url, token: build.systemToken! })) : undefined;
  return createBuilderMcp(new BoardClient(), build, system);
}
