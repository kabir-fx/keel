import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The few git calls the builder makes itself: its worktree, the records commit, and the
 * commit a check is run on. No shell. A repository's own config must not make these run
 * anything of the repository's: no fsmonitor, and no hooks on the builder's own commits.
 *
 * In the worktree, git is always told where its own folder is (`pinEnv`). Git otherwise finds
 * it by reading `.git` in the folder it stands in, and that file is inside the worktree, where
 * the code a check runs can write. A changed `.git` could point git at a config of the
 * code's own making, and git runs programs a config names: a filter, a signing program, a
 * hook. With the folder pinned, git never looks.
 */

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  override name = 'GitError';
}

/** What a parent process may have set to point git somewhere, or to give it settings. None of it is taken over. */
const INHERITED = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_CEILING_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_EXTERNAL_DIFF', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'GIT_EDITOR', 'GIT_PAGER', 'GIT_EXEC_PATH'];

/** The environment for git: no prompt, nothing from a parent process that points elsewhere, then what the caller pins. */
export function gitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (INHERITED.includes(k) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) delete env[k];
  return { ...env, ...extra, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
}

/**
 * Settings for every git that runs in the builder's worktree, ours and the builder's own.
 * They come from the environment, which wins over any config file: no hook (a hook is a
 * program, and `core.hooksPath` may name a folder inside the worktree), no fsmonitor program,
 * no signing program, no pager.
 */
const PINNED_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ['core.hooksPath', '/dev/null'],
  ['core.fsmonitor', 'false'],
  ['commit.gpgsign', 'false'],
  ['tag.gpgsign', 'false'],
  ['core.pager', 'cat'],
];

/**
 * The environment that pins git to one worktree: its own git folder, its work tree, and the
 * settings above. With `GIT_DIR` set, git does not look for a `.git` in the folder it stands
 * in or in any folder above it.
 */
export function pinEnv(gitDir: string, tree: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_DIR: gitDir, GIT_WORK_TREE: tree, GIT_CONFIG_COUNT: String(PINNED_CONFIG.length) };
  PINNED_CONFIG.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

export function git(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    const p = spawn('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, env: gitEnv(env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    p.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    p.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    p.on('error', (e) => resolve({ code: 127, stdout, stderr: `${stderr}${e.message}` }));
    p.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** Run git and return its output, trimmed, or throw with what git said. */
export async function gitOk(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  const r = await git(cwd, args, env);
  if (r.code !== 0) throw new GitError(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
  return r.stdout.trim();
}

/** The top of the repository `dir` is in, or undefined when it is not a git repository. */
export async function repoTop(dir: string): Promise<string | undefined> {
  const r = await git(dir, ['rev-parse', '--show-toplevel']);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/** The commit HEAD points at, or undefined in a repository with no commit yet. */
export async function headOf(dir: string, env: NodeJS.ProcessEnv = {}): Promise<string | undefined> {
  const r = await git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], env);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

export async function shortOf(dir: string, rev: string, env: NodeJS.ProcessEnv = {}): Promise<string> {
  return gitOk(dir, ['rev-parse', '--short', rev], env);
}

/** The branch HEAD is on, or `HEAD` when it is detached. */
export async function branchOf(dir: string, env: NodeJS.ProcessEnv = {}): Promise<string> {
  return gitOk(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], env);
}

export async function branchExists(dir: string, branch: string): Promise<boolean> {
  return (await git(dir, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
}

/** True when `a` is an ancestor of `b`, or the same commit. */
export async function isAncestor(dir: string, a: string, b: string, env: NodeJS.ProcessEnv = {}): Promise<boolean> {
  return (await git(dir, ['merge-base', '--is-ancestor', a, b], env)).code === 0;
}

/** Changed or new files that are not ignored, one per line as `git status --porcelain` gives them. */
export async function dirtyFiles(dir: string, env: NodeJS.ProcessEnv = {}): Promise<string[]> {
  const out = await gitOk(dir, ['status', '--porcelain=v1', '--untracked-files=all'], env);
  return out ? out.split('\n').filter(Boolean) : [];
}

/** The commits on `rev` that `base` does not have, oldest first: hash and subject. */
export async function commitsSince(dir: string, base: string, rev = 'HEAD', env: NodeJS.ProcessEnv = {}): Promise<Array<{ hash: string; subject: string }>> {
  const out = await gitOk(dir, ['log', '--reverse', '--format=%h%x09%s', `${base}..${rev}`], env);
  return out
    ? out.split('\n').map((l) => {
        const i = l.indexOf('\t');
        return { hash: l.slice(0, i), subject: l.slice(i + 1) };
      })
    : [];
}

/** True when commits made here have an author: the owner's git config, or the environment. */
export async function hasIdentity(dir: string, env: NodeJS.ProcessEnv = {}): Promise<boolean> {
  const name = await git(dir, ['config', 'user.name'], env);
  const email = await git(dir, ['config', 'user.email'], env);
  return name.code === 0 && email.code === 0 && name.stdout.trim() !== '' && email.stdout.trim() !== '';
}

/** Who the builder's commits are by, when git has no identity of the owner's. */
export const BUILDER_IDENTITY = {
  GIT_AUTHOR_NAME: 'Keel builder',
  GIT_AUTHOR_EMAIL: 'builder@keel.invalid',
  GIT_COMMITTER_NAME: 'Keel builder',
  GIT_COMMITTER_EMAIL: 'builder@keel.invalid',
} as const;

/**
 * The git folder of the worktree at `dir`, found from the owner's repository and never from
 * inside the worktree: git keeps one folder per worktree under `<git folder>/worktrees/`, and
 * each holds a `gitdir` file that names the worktree's `.git`. Undefined when the owner's
 * repository knows no worktree there.
 */
export async function worktreeGitDir(repo: string, dir: string): Promise<string | undefined> {
  const r = await git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (r.code !== 0) return undefined;
  const root = path.join(r.stdout.trim(), 'worktrees');
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return undefined;
  }
  const want = path.join(dir, '.git');
  for (const name of names) {
    try {
      const st = fs.lstatSync(path.join(root, name));
      if (!st.isDirectory()) continue;
      if (samePath(fs.readFileSync(path.join(root, name, 'gitdir'), 'utf8').trim(), want)) return path.join(root, name);
    } catch {
      // Not a worktree's folder.
    }
  }
  return undefined;
}

/** Is `.git` in the worktree still the plain file git wrote, naming this git folder? */
function linkIntact(dir: string, gitDir: string): boolean {
  try {
    const link = path.join(dir, '.git');
    if (!fs.lstatSync(link).isFile()) return false;
    const m = /^gitdir: (.+)$/.exec(fs.readFileSync(link, 'utf8').trim());
    return m !== null && samePath(m[1]!, gitDir);
  } catch {
    return false;
  }
}

/**
 * The builder's worktree for one chapter, on its own branch, made from the owner's HEAD the
 * first time and reused after. `dir` is the builder's private folder: anything there that is
 * not this worktree is the builder's own leftover, and is cleared. So is a worktree whose
 * `.git` was changed: its commits are on the branch, and it is made again from there.
 * `gitDir` is the worktree's own git folder: run every git in the worktree with `pinEnv`.
 */
export async function ensureWorktree(repo: string, dir: string, branch: string): Promise<{ created: boolean; base?: string; gitDir: string }> {
  if (fs.existsSync(dir)) {
    const known = await worktreeGitDir(repo, dir);
    if (known !== undefined && linkIntact(dir, known) && (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], pinEnv(known, dir))).stdout.trim() === branch) {
      return { created: false, gitDir: known };
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  await git(repo, ['worktree', 'prune']);
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
  const made = async (created: boolean, base?: string) => {
    const gitDir = await worktreeGitDir(repo, dir);
    if (gitDir === undefined) throw new GitError(`git made a worktree at ${dir}, but the repository does not list it.`);
    return { created, ...(base !== undefined ? { base } : {}), gitDir };
  };
  if (await branchExists(repo, branch)) {
    await gitOk(repo, ['worktree', 'add', '--quiet', dir, branch]);
    return made(false);
  }
  const head = await headOf(repo);
  // What is missing, and no more: how to try again is said by who reports this, which knows what the page offers.
  if (!head) throw new GitError('The repository has no commit yet, so there is nothing to build on. Make a first commit.');
  // From the commit, not the owner's branch name: the owner's branch never moves.
  await gitOk(repo, ['worktree', 'add', '--quiet', '-b', branch, dir, head]);
  return made(true, head);
}

/** Take the worktree away and keep its branch: the branch is what the owner merges. */
export async function removeWorktree(repo: string, dir: string): Promise<void> {
  if (!fs.existsSync(dir)) return;
  const r = await git(repo, ['worktree', 'remove', dir]);
  if (r.code !== 0) await git(repo, ['worktree', 'remove', '--force', dir]);
  await git(repo, ['worktree', 'prune']);
}

export function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
}
