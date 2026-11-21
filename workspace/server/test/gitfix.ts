import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempRepo } from './helpers';

/**
 * Real git repositories for the tests, in temp folders: a bare repository as the remote, and
 * clones of it. The owner's own git config is kept out, so no credential helper or default
 * of theirs plays a part.
 */

const quietConfig = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'keel-gitconfig-')), 'config');
fs.writeFileSync(quietConfig, '');
process.env.GIT_CONFIG_GLOBAL = quietConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';

export type Git = (...args: string[]) => string;

/** Run git in `dir`, as a test user, with no hook and no signing. */
export function gitIn(dir: string): Git {
  return (...args) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

/** Write files in `dir`, add them, and commit. Returns the commit. */
export function commitFiles(dir: string, files: Record<string, string>, message = 'change'): string {
  const git = gitIn(dir);
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
  }
  git('add', '--', ...Object.keys(files));
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}

export interface Fixture {
  /** The owner's folder: a clone of the remote, on main, which follows origin/main. */
  repo: string;
  git: Git;
  /** The bare repository the clone calls origin. */
  remote: string;
  /** Another clone, where "someone else" commits and pushes. */
  other: string;
  otherGit: Git;
}

/** A remote with one commit on main, and the owner's clone of it. */
export function withRemote(): Fixture {
  const remote = tempRepo('remote.git');
  gitIn(remote)('init', '-q', '--bare', '-b', 'main');
  const other = tempRepo('other');
  const otherGit = gitIn(other);
  otherGit('init', '-q', '-b', 'main');
  commitFiles(other, { 'a.txt': 'one\n' }, 'first');
  otherGit('remote', 'add', 'origin', remote);
  otherGit('push', '-q', '-u', 'origin', 'main');
  const repo = tempRepo('demo');
  gitIn(path.dirname(repo))('clone', '-q', remote, repo);
  return { repo, git: gitIn(repo), remote, other, otherGit };
}

/** Someone else commits and pushes to the remote. Returns the commit. */
export function remoteMoves(f: Fixture, files: Record<string, string>): string {
  const c = commitFiles(f.other, files, 'from elsewhere');
  f.otherGit('push', '-q', 'origin', 'main');
  return c;
}

/** Make a branch from `from` with one commit of these files, without touching the folder. Returns its commit. */
export function branchWith(repo: string, branch: string, from: string, files: Record<string, string>): string {
  const git = gitIn(repo);
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-wt-'));
  fs.rmSync(wt, { recursive: true });
  git('worktree', 'add', '-q', '-b', branch, wt, from);
  const c = commitFiles(wt, files, `build ${branch}`);
  git('worktree', 'remove', '--force', wt);
  return c;
}
