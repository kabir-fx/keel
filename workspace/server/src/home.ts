import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { HomeInfo, Verdict } from '@keel/protocol';

/**
 * The home branch: the repository's main branch, where every build starts and where an
 * approved build goes (record 0014).
 * The board server brings it level with its remote by fast-forward only, and moves it to an
 * approved build the same way. Nothing of the owner's is ever stashed, committed or
 * overwritten: where git refuses, the board names the files and waits.
 *
 * Git never asks for anything here. It runs with no terminal (a session of its own) and no
 * askpass, so a remote that wants a password counts as one that did not answer. Every call
 * is bounded, a call to the remote most of all.
 */

/** How long one local git call may take. */
const LOCAL_MS = 10_000;
/** How long a fetch may take. */
export const FETCH_MS = 15_000;
/** How long a push may take. */
export const PUSH_MS = 60_000;
/** The most of git's own words a note carries. */
const SAID_MAX = 300;

/** What one git call gave. `code` is null when it did not end by itself: it ran past its limit, or git is not there. */
export interface GitOut {
  code: number | null;
  out: string;
  err: string;
}

/** Settings that keep a repository's config from running anything, or from stashing the owner's work. */
const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'merge.autoStash=false', '-c', 'credential.interactive=false'];

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GCM_INTERACTIVE: 'never',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
    LANG: 'C',
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined,
  };
}

/**
 * Run git in `cwd`, in a session of its own so that nothing it starts (ssh, a credential
 * helper) has a terminal to ask on. Past `ms`, or once `signal` aborts, the whole group is ended.
 */
export function git(cwd: string, args: readonly string[], ms = LOCAL_MS, signal?: AbortSignal): Promise<GitOut> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ code: null, out: '', err: 'stopped' });
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('git', [...SAFE, ...args], { cwd, env: gitEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true, windowsHide: true });
    } catch (e) {
      resolve({ code: null, out: '', err: e instanceof Error ? e.message : String(e) });
      return;
    }
    let out = '';
    let err = '';
    let done = false;
    const finish = (r: GitOut) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const kill = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const onAbort = () => {
      kill();
      finish({ code: null, out, err: `${err}\nstopped` });
    };
    signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      kill();
      finish({ code: null, out, err: `${err}\ngit took longer than ${Math.round(ms / 1000)} s.` });
    }, ms);
    child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => (err += c.toString('utf8')));
    child.on('error', (e) => finish({ code: null, out, err: e.message }));
    child.on('close', (code) => finish({ code, out, err }));
  });
}

/** One line of git's output, trimmed, or undefined when the call failed or said nothing. */
async function line(cwd: string, args: readonly string[]): Promise<string | undefined> {
  const r = await git(cwd, args);
  const s = r.out.trim();
  return r.code === 0 && s !== '' ? s : undefined;
}

/** Is `a` held by `b`: an ancestor of it, or the same commit? */
export async function holds(cwd: string, b: string, a: string): Promise<boolean> {
  return (await git(cwd, ['merge-base', '--is-ancestor', a, b])).code === 0;
}

/** The commit a ref names now, in full, or undefined. */
export function commitOf(cwd: string, ref: string): Promise<string | undefined> {
  return line(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
}

/** A branch name the builder may report: what `board/<slug>` and git's own rules allow, and nothing that reads as an option. */
export function branchNameOk(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) &&
    !name.includes('..') &&
    !name.includes('//') &&
    !name.endsWith('/') &&
    !name.endsWith('.') &&
    !name.endsWith('.lock') &&
    !name.split('/').some((p) => p.startsWith('.'))
  );
}

/** What git says about the home branch, read with no call to the remote. */
export interface HomeLook {
  /** The top of the worktree the board's folder is in, as a real path. */
  top: string;
  branch: string;
  /** Its commit, in full. Left out when the branch has no commit yet. */
  commit?: string;
  /** The worktree it is checked out in, as a real path, when it is. */
  checkedOut?: string;
  remote?: string;
  /** The branch on the remote it follows: `refs/heads/main`. */
  merge?: string;
  /** Where this repository keeps the remote's branch: `refs/remotes/origin/main`. */
  tracking?: string;
  /** `origin/main` */
  upstream?: string;
  /** The branch the board's folder is on, when it is not the home branch. */
  folderOn?: string;
}

/**
 * Find the home branch: the branch `origin/HEAD` names, else `main`, else `master`, else the
 * branch the folder is on. Undefined where the folder is no repository, or there is no branch
 * to call home (a detached folder with no `main` or `master`).
 */
export async function lookHome(repoDir: string): Promise<HomeLook | undefined> {
  const topRaw = await line(repoDir, ['rev-parse', '--show-toplevel']);
  if (topRaw === undefined) return undefined;
  let top: string;
  try {
    top = fs.realpathSync(topRaw);
  } catch {
    return undefined;
  }
  const exists = async (b: string) => (await git(top, ['show-ref', '--verify', '--quiet', `refs/heads/${b}`])).code === 0;
  const folder = await line(repoDir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  let branch: string | undefined;
  const originHead = await line(top, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (originHead?.startsWith('origin/')) {
    const named = originHead.slice('origin/'.length);
    if (await exists(named)) branch = named;
  }
  if (branch === undefined && (await exists('main'))) branch = 'main';
  if (branch === undefined && (await exists('master'))) branch = 'master';
  if (branch === undefined) branch = folder;
  if (branch === undefined || !branchNameOk(branch)) return undefined;

  const look: HomeLook = { top, branch };
  const commit = await commitOf(top, `refs/heads/${branch}`);
  if (commit) look.commit = commit;
  if (folder !== undefined && folder !== branch) look.folderOn = folder;
  const where = await worktreeOf(top, branch);
  if (where) look.checkedOut = where;
  const remote = await line(top, ['config', '--get', `branch.${branch}.remote`]);
  const merge = await line(top, ['config', '--get', `branch.${branch}.merge`]);
  if (remote && merge?.startsWith('refs/heads/')) {
    look.remote = remote;
    look.merge = merge;
    if (remote === '.') {
      look.tracking = merge;
      look.upstream = merge.slice('refs/heads/'.length);
    } else {
      const tracking = await line(top, ['rev-parse', '--symbolic-full-name', `refs/heads/${branch}@{upstream}`]);
      look.tracking = tracking ?? `refs/remotes/${remote}/${merge.slice('refs/heads/'.length)}`;
      look.upstream = look.tracking.startsWith('refs/remotes/') ? look.tracking.slice('refs/remotes/'.length) : `${remote}/${merge.slice('refs/heads/'.length)}`;
    }
  }
  return look;
}

/** The worktree that has `branch` checked out, as a real path, or undefined. */
async function worktreeOf(top: string, branch: string): Promise<string | undefined> {
  const r = await git(top, ['worktree', 'list', '--porcelain']);
  if (r.code !== 0) return undefined;
  let at: string | undefined;
  for (const l of r.out.split('\n')) {
    if (l.startsWith('worktree ')) at = l.slice('worktree '.length);
    else if (l === `branch refs/heads/${branch}` && at !== undefined) {
      try {
        return fs.realpathSync(at);
      } catch {
        return at;
      }
    }
  }
  return undefined;
}

/** The files git named as in the way of a merge: the indented lines after its "would be overwritten" line. */
export function filesInTheWay(said: string): string[] {
  const files: string[] = [];
  let inList = false;
  for (const l of said.split('\n')) {
    if (/would be overwritten by (merge|checkout)/.test(l)) inList = true;
    else if (inList && /^\t/.test(l)) files.push(l.trim());
    else inList = false;
  }
  return files;
}

/** Names for a sentence: "a.ts", "a.ts and b.ts", "a.ts, b.ts and 3 more". */
export function nameFiles(files: readonly string[]): string {
  if (files.length <= 1) return files[0] ?? 'some files';
  if (files.length === 2) return `${files[0]} and ${files[1]}`;
  if (files.length === 3) return `${files[0]}, ${files[1]} and ${files[2]}`;
  return `${files[0]}, ${files[1]} and ${files.length - 2} more`;
}

/** What git said, in one short line. */
export function gitSaid(r: GitOut): string {
  const s = `${r.err}\n${r.out}`
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !/^hint:/i.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > SAID_MAX ? `${s.slice(0, SAID_MAX - 1)}…` : s || 'git gave no reason';
}

export type MoveResult = { ok: true } | { ok: false; files?: string[]; note: string };

/**
 * Move the home branch to `to`, by fast-forward only. Where it is checked out, git does it in
 * that worktree and refuses when the owner's changes are in the way. Elsewhere the ref is
 * moved from the commit it was just read at, and from nothing else.
 */
export async function fastForward(look: HomeLook, to: string): Promise<MoveResult> {
  if (look.commit && !(await holds(look.top, to, look.commit))) {
    return { ok: false, note: `${to.slice(0, 7)} does not hold ${look.branch}: it would not be a fast-forward.` };
  }
  if (look.checkedOut) {
    const r = await git(look.checkedOut, ['merge', '--ff-only', '--no-autostash', '--quiet', to]);
    if (r.code === 0) return { ok: true };
    const files = filesInTheWay(r.err);
    return files.length > 0 ? { ok: false, files, note: gitSaid(r) } : { ok: false, note: gitSaid(r) };
  }
  const r = await git(look.top, ['update-ref', '-m', 'keel board: fast-forward', `refs/heads/${look.branch}`, to, look.commit ?? '']);
  return r.code === 0 ? { ok: true } : { ok: false, note: gitSaid(r) };
}

/** How many commits each side has that the other lacks: `[left, right]`. */
export async function aheadBehind(top: string, left: string, right: string): Promise<[number, number] | undefined> {
  const r = await git(top, ['rev-list', '--left-right', '--count', `${left}...${right}`]);
  const m = /^(\d+)\s+(\d+)/.exec(r.out.trim());
  return r.code === 0 && m ? [Number(m[1]), Number(m[2])] : undefined;
}

export interface SyncOptions {
  /** Look at the remote. Off, the remote branch is taken as this repository last saw it, and nothing moves. */
  fetch: boolean;
  /** True while the board runs: a fast-forward that would rewrite the board's log in its own folder is not done then. */
  protectLog: () => boolean;
  /** The board's log, as an absolute path. */
  logPath: string;
  now: () => Date;
  /** How long the fetch may take. Default `FETCH_MS`. */
  fetchMs?: number;
  /** Ends a fetch that still runs: the board is closing. */
  signal?: AbortSignal;
}

/** One sentence each, for the owner. */
export const HOME_NOTES = {
  unreachable: (remote: string, branch: string) => `${remote} did not answer. Building from ${branch} as it is here.`,
  inTheWay: (remote: string, n: number, files: readonly string[]) =>
    `${remote} has ${n === 1 ? 'one new commit' : `${n} new commits`}. Your changes in ${nameFiles(files)} are in the way: commit or stash them.`,
  refused: (remote: string, n: number, said: string) => `${remote} has ${n === 1 ? 'one new commit' : `${n} new commits`}, and git did not move to them: ${said}`,
  newerLog: (remote: string) => `${remote} has a newer copy of this board. Stop the board and open it again to take it.`,
  diverged: (branch: string, upstream: string) => `${branch} and ${upstream} have both moved, so the board did not pull. Run git pull in the board's folder, then look again.`,
};

/**
 * Look at the home branch, and bring it level with its remote when that is a fast-forward.
 * Undefined where there is no home branch. `look` is what was found, for a caller that goes on.
 */
export async function syncHome(repoDir: string, opts: SyncOptions): Promise<{ info: HomeInfo; look: HomeLook } | undefined> {
  let look = await lookHome(repoDir);
  if (!look) return undefined;
  const checkedAt = opts.now().toISOString();
  const base = (l: HomeLook): Omit<HomeInfo, 'sync'> => ({
    branch: l.branch,
    ...(l.commit ? { commit: l.commit.slice(0, 7) } : {}),
    ...(l.upstream ? { upstream: l.upstream } : {}),
    ...(l.folderOn ? { folderOn: l.folderOn } : {}),
  });
  if (!look.commit || !look.tracking || !look.remote) return { info: { ...base(look), sync: 'local' }, look };

  if (opts.fetch && look.remote !== '.') {
    const r = await git(look.top, ['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', look.remote, `+${look.merge}:${look.tracking}`], opts.fetchMs ?? FETCH_MS, opts.signal);
    if (r.code !== 0) {
      return { info: { ...base(look), sync: 'unreachable', note: HOME_NOTES.unreachable(look.remote, look.branch), checkedAt }, look };
    }
  }
  const counts = await aheadBehind(look.top, `refs/heads/${look.branch}`, look.tracking);
  if (!counts) return { info: { ...base(look), sync: 'unreachable', note: HOME_NOTES.unreachable(look.remote, look.branch), checkedAt }, look };
  const [ahead, behind] = counts;
  const stamp = opts.fetch ? { checkedAt } : {};
  if (ahead === 0 && behind === 0) return { info: { ...base(look), sync: 'level', ...stamp }, look };
  if (behind === 0) return { info: { ...base(look), sync: 'ahead', ahead, ...stamp }, look };
  const upstream = look.upstream ?? look.tracking;
  if (ahead > 0) return { info: { ...base(look), sync: 'diverged', ahead, behind, note: HOME_NOTES.diverged(look.branch, upstream), ...stamp }, look };

  const behindInfo = (note: string): { info: HomeInfo; look: HomeLook } => ({ info: { ...base(look!), sync: 'behind', behind, note, ...stamp }, look: look! });
  if (!opts.fetch) return { info: { ...base(look), sync: 'behind', behind, ...stamp }, look };
  if (look.checkedOut === look.top && opts.protectLog() && (await rewritesLog(look, opts.logPath))) return behindInfo(HOME_NOTES.newerLog(look.remote));
  const to = await commitOf(look.top, look.tracking);
  if (!to) return behindInfo(HOME_NOTES.refused(look.remote, behind, 'the remote branch could not be read'));
  const moved = await fastForward(look, to);
  if (!moved.ok) return behindInfo(moved.files ? HOME_NOTES.inTheWay(look.remote, behind, moved.files) : HOME_NOTES.refused(look.remote, behind, moved.note));
  look = (await lookHome(repoDir)) ?? look;
  return { info: { ...base(look), sync: 'level', ...stamp }, look };
}

/** Would moving home to its remote branch change the board's log file in the board's own folder? */
async function rewritesLog(look: HomeLook, logPath: string): Promise<boolean> {
  let rel: string;
  try {
    rel = path.relative(look.top, path.join(fs.realpathSync(path.dirname(logPath)), path.basename(logPath)));
  } catch {
    rel = path.relative(look.top, logPath);
  }
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const r = await git(look.top, ['diff', '--name-only', `refs/heads/${look.branch}`, look.tracking!, '--', rel.split(path.sep).join('/')]);
  return r.code !== 0 || r.out.trim() !== '';
}

/** Push the home branch to the remote branch it follows. Never forced. */
export async function pushHome(look: HomeLook, signal?: AbortSignal): Promise<{ ok: boolean; note: string }> {
  if (!look.remote || !look.merge || look.remote === '.') return { ok: false, note: `${look.branch} follows no remote, so there is nowhere to push it.` };
  const r = await git(look.top, ['push', '--quiet', '--no-verify', look.remote, `refs/heads/${look.branch}:${look.merge}`], PUSH_MS, signal);
  if (r.code === 0) return { ok: true, note: `Pushed ${look.branch} to ${look.remote}.` };
  const rejected = r.err
    .split('\n')
    .map((l) => l.trim().replace(/\s+/g, ' '))
    .find((l) => l.startsWith('! [rejected]'));
  if (rejected) return { ok: false, note: `${look.remote} has commits that ${look.branch} here does not have, so it did not take the push. ${rejected}` };
  return { ok: false, note: `${look.remote} did not take the push of ${look.branch}: ${gitSaid(r)}` };
}

/**
 * The check on `canvas.merged`: the commit is in the repository, and the home branch, by the
 * name the event gives, holds it. Synchronous, as posting is.
 */
export function mergedCheck(repoDir: string, home: () => string | undefined): (commit: string, into: string) => Verdict {
  return (commit, into) => {
    const no = (reason: string): Verdict => ({ ok: false, rule: 'R2', reason });
    if (!/^[0-9a-f]{4,64}$/i.test(commit)) return no(`"merged" needs the id of a commit. "${commit.slice(0, 40)}" is not one.`);
    const name = home();
    if (name === undefined || into !== name) return no(`"${into.slice(0, 80)}" is not the home branch${name ? `: that is ${name}` : ''}.`);
    const run = (args: string[]): boolean => {
      try {
        execFileSync('git', [...SAFE, ...args], { cwd: repoDir, stdio: 'ignore', timeout: 5000, env: gitEnv(), windowsHide: true });
        return true;
      } catch {
        return false;
      }
    };
    if (!run(['rev-parse', '--verify', '--quiet', `${commit}^{commit}`])) return no(`There is no commit ${commit} in this repository.`);
    if (!run(['merge-base', '--is-ancestor', commit, `refs/heads/${name}`])) return no(`${name} does not hold commit ${commit}. Only a commit the home branch has is merged.`);
    return { ok: true };
  };
}
