import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BRANCH_MAX, GitError, OwnerFilesError, branchFor, branchNames, dirtyFiles, ensureWorktree, folderFiles, gitEnv, gitOk, headOf, ownerFiles, pinEnv, samePath, worktreeGitDir } from '../src/git';
import { makeRepo, sh } from './build-board';

/**
 * Git in the builder's worktree is told where its own git folder is. It never finds it by
 * reading `.git` in the worktree, because the code a check runs can write there, and git runs
 * the programs a config names.
 */

let tmp: string;
let repo: string;
let tree: string;
let marker: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keel-git-')));
  repo = makeRepo(path.join(tmp, 'repo'));
  tree = path.join(tmp, 'state', 'tree');
  marker = path.join(tmp, 'ran.txt');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A program that leaves a file behind when anything runs it. */
function tripwire(name: string): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, `#!/bin/sh\necho "${name}" >> '${marker}'\n`, { mode: 0o755 });
  return file;
}

describe('the worktree\'s own git folder', () => {
  it('is found from the owner\'s repository, under its worktrees folder', async () => {
    const wt = await ensureWorktree(repo, tree, 'board/x');
    expect(wt.created).toBe(true);
    expect(samePath(path.dirname(wt.gitDir), path.join(repo, '.git', 'worktrees'))).toBe(true);
    expect(await worktreeGitDir(repo, tree)).toBe(wt.gitDir);
    expect(await worktreeGitDir(repo, path.join(tmp, 'elsewhere'))).toBeUndefined();
    // Used again as it is.
    expect(await ensureWorktree(repo, tree, 'board/x')).toEqual({ created: false, gitDir: wt.gitDir, reused: true });
  });

  it('in a repository with no commit, starts its branch from nothing and leaves the owner\'s HEAD, index and files alone', async () => {
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(path.join(empty, '.keel', 'board'), { recursive: true });
    fs.writeFileSync(path.join(empty, '.keel', 'board', 'events.jsonl'), '{}\n');
    fs.writeFileSync(path.join(empty, '.DS_Store'), 'x');
    sh(empty, 'git', 'init', '--quiet');
    const statusBefore = sh(empty, 'git', 'status', '--porcelain');

    const wt = await ensureWorktree(empty, tree, 'board/x');
    expect(wt).toMatchObject({ created: true, fromNothing: true });
    // The branch's first commit: an empty tree, no parent, by the builder, saying what it is.
    expect(sh(empty, 'git', 'rev-parse', 'board/x')).toBe(wt.base);
    expect(sh(empty, 'git', 'log', '--format=%P|%cn|%s', 'board/x')).toBe('|Keel builder|The start of board/x, from an empty folder');
    expect(sh(empty, 'git', 'ls-tree', 'board/x')).toBe('');
    expect(await headOf(tree, pinEnv(wt.gitDir, tree))).toBe(wt.base);
    // The owner's side: HEAD still unborn, nothing staged, the files as they were.
    expect(await headOf(empty)).toBeUndefined();
    expect(sh(empty, 'git', 'ls-files')).toBe('');
    expect(sh(empty, 'git', 'status', '--porcelain')).toBe(statusBefore);
    expect(fs.readdirSync(empty).sort()).toEqual(['.DS_Store', '.git', '.keel']);

    // Used again as it is, and not started from nothing again.
    expect(await ensureWorktree(empty, tree, 'board/x')).toEqual({ created: false, gitDir: wt.gitDir, reused: true });
    // Its commits come into the owner's unborn branch with a merge.
    fs.writeFileSync(path.join(tree, 'part.txt'), 'the part\n');
    const pin = { ...pinEnv(wt.gitDir, tree), GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x.invalid', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x.invalid' };
    await gitOk(tree, ['add', '--', 'part.txt'], pin);
    await gitOk(tree, ['commit', '--quiet', '-m', 'the part'], pin);
    sh(empty, 'git', 'merge', '--quiet', 'board/x');
    expect(fs.readFileSync(path.join(empty, 'part.txt'), 'utf8')).toBe('the part\n');
  });

  it('refuses a repository with no commit that holds files of the owner\'s, staged or not, and makes nothing', async () => {
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    sh(empty, 'git', 'init', '--quiet');
    fs.writeFileSync(path.join(empty, 'notes.txt'), 'mine\n');
    fs.writeFileSync(path.join(empty, 'staged.txt'), 'mine\n');
    sh(empty, 'git', 'add', 'staged.txt');
    const err = await ensureWorktree(empty, tree, 'board/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OwnerFilesError);
    expect((err as OwnerFilesError).files.sort()).toEqual(['notes.txt', 'staged.txt']);
    expect(fs.existsSync(tree)).toBe(false);
    expect(sh(empty, 'git', 'branch', '--list')).toBe('');
    expect(sh(empty, 'git', 'ls-files')).toBe('staged.txt');
  });

  it('counts what git would commit: not an ignored file, not the board\'s .keel where the board is, not what a system drops', async () => {
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(path.join(empty, 'app', '.keel', 'board'), { recursive: true });
    sh(empty, 'git', 'init', '--quiet');
    fs.writeFileSync(path.join(empty, 'app', '.keel', 'board', 'events.jsonl'), '{}\n');
    fs.writeFileSync(path.join(empty, 'app', 'Thumbs.db'), 'x');
    fs.writeFileSync(path.join(empty, 'desktop.ini'), 'x');
    fs.writeFileSync(path.join(empty, 'secret.log'), 'x');
    fs.appendFileSync(path.join(empty, '.git', 'info', 'exclude'), 'secret.log\n');
    expect(await ownerFiles(empty, 'app')).toEqual([]);
    // The board's .keel is the one in its own folder: another is the owner's.
    expect(await ownerFiles(empty)).toEqual(['app/.keel/board/events.jsonl']);
    fs.writeFileSync(path.join(empty, 'app', 'na me "x".txt'), 'x');
    expect(await ownerFiles(empty, 'app')).toEqual(['app/na me "x".txt']);
  });

  it('looks in a plain folder only so far: a few names, and how many more', () => {
    const dir = path.join(tmp, 'plain');
    fs.mkdirSync(path.join(dir, '.keel'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'x');
    expect(folderFiles(dir)).toEqual({ names: [], more: 0 });
    fs.mkdirSync(path.join(dir, 'src'));
    for (const n of ['a', 'b', 'c', 'd']) fs.writeFileSync(path.join(dir, `${n}.txt`), 'x');
    const r = folderFiles(dir);
    expect(r.names).toHaveLength(3);
    expect(r.more).toBe(2);
    for (const n of r.names) expect(['src/', 'a.txt', 'b.txt', 'c.txt', 'd.txt']).toContain(n);
    // Past the bound, it stops counting.
    expect(folderFiles(dir, 3, 4).more).toBeUndefined();
  });

  it('does not go on in a worktree whose HEAD has no commit: it is made again', async () => {
    const wt = await ensureWorktree(repo, tree, 'board/x');
    // The branch is gone under the worktree: its HEAD names a branch with no commit.
    sh(repo, 'git', 'update-ref', '-d', 'refs/heads/board/x');
    expect(await headOf(tree, pinEnv(wt.gitDir, tree))).toBeUndefined();
    const again = await ensureWorktree(repo, tree, 'board/x');
    expect(again.created).toBe(true);
    expect(await headOf(tree, pinEnv(again.gitDir, tree))).toBe(sh(repo, 'git', 'rev-parse', 'main'));
  });

  it('pins git to it: a `.git` put in the worktree, with a config that names programs, is never read', async () => {
    const { gitDir } = await ensureWorktree(repo, tree, 'board/x');
    const pin = pinEnv(gitDir, tree);

    // What code run inside the worktree could leave behind: its own git folder, whose config names programs.
    fs.rmSync(path.join(tree, '.git'));
    sh(tree, 'git', 'init', '--quiet', '-b', 'other');
    const hooks = path.join(tree, 'hooks');
    fs.mkdirSync(hooks);
    fs.writeFileSync(path.join(hooks, 'pre-commit'), `#!/bin/sh\necho hook >> '${marker}'\n`, { mode: 0o755 });
    fs.appendFileSync(
      path.join(tree, '.git', 'config'),
      `[core]\n\tfsmonitor = ${tripwire('fsmonitor')}\n\thooksPath = ${hooks}\n[filter "x"]\n\tclean = ${tripwire('clean')}\n\tsmudge = cat\n[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = ${tripwire('gpg')}\n`,
    );
    fs.writeFileSync(path.join(tree, '.gitattributes'), '* filter=x\n');
    fs.writeFileSync(path.join(tree, 'part.txt'), 'the part\n');

    // Our own calls, pinned: status, add, commit.
    expect((await dirtyFiles(tree, pin)).some((l) => l.endsWith('part.txt'))).toBe(true);
    await gitOk(tree, ['add', '--', 'part.txt'], pin);
    await gitOk(tree, ['commit', '--quiet', '-m', 'the part'], pin);
    expect(fs.existsSync(marker)).toBe(false);

    // The commit is on the builder's branch in the owner's repository, not in the planted one.
    const head = await headOf(tree, pin);
    expect(sh(repo, 'git', 'rev-parse', 'board/x')).toBe(head);
    expect(sh(repo, 'git', 'log', '-1', '--format=%s', 'board/x')).toBe('the part');

    // A worktree whose `.git` was changed is made again from its branch, with its commits.
    const again = await ensureWorktree(repo, tree, 'board/x');
    expect(again.created).toBe(false);
    expect(fs.lstatSync(path.join(tree, '.git')).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(tree, 'part.txt'), 'utf8')).toBe('the part\n');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('runs no hook, even one the owner\'s own repository names inside the worktree', async () => {
    // As a tool that keeps hooks in the repository does: `core.hooksPath` is a folder of tracked files.
    fs.mkdirSync(path.join(repo, '.hooks'));
    fs.writeFileSync(path.join(repo, '.hooks', 'pre-commit'), `#!/bin/sh\necho hook >> '${marker}'\n`, { mode: 0o755 });
    sh(repo, 'git', 'config', 'core.hooksPath', '.hooks');
    sh(repo, 'git', 'add', '.hooks');
    sh(repo, 'git', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'hooks');
    const { gitDir } = await ensureWorktree(repo, tree, 'board/x');
    const pin = pinEnv(gitDir, tree);

    fs.writeFileSync(path.join(tree, 'part.txt'), 'the part\n');
    await gitOk(tree, ['add', '--', 'part.txt'], pin);
    await gitOk(tree, ['commit', '--quiet', '-m', 'the part'], pin);
    expect(fs.existsSync(marker)).toBe(false);
    expect(sh(repo, 'git', 'log', '-1', '--format=%s', 'board/x')).toBe('the part');
  });

  it('takes no pointer and no setting from the process that started it', () => {
    const before = { ...process.env };
    try {
      Object.assign(process.env, { GIT_DIR: '/elsewhere/.git', GIT_WORK_TREE: '/elsewhere', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: '/bin/false', GIT_SSH_COMMAND: 'x', GIT_EXTERNAL_DIFF: 'x' });
      const plain = gitEnv();
      for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_SSH_COMMAND', 'GIT_EXTERNAL_DIFF']) expect(plain[k], k).toBeUndefined();
      // What the caller pins is kept.
      const pinned = gitEnv(pinEnv('/state/git', '/state/tree'));
      expect(pinned).toMatchObject({ GIT_DIR: '/state/git', GIT_WORK_TREE: '/state/tree', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null' });
      expect(Number(pinned.GIT_CONFIG_COUNT)).toBeGreaterThanOrEqual(4);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
      Object.assign(process.env, before);
    }
  });
});

describe('a build\'s branch', () => {
  it('starts from the base commit it is given, never from the owner\'s HEAD', async () => {
    const base = sh(repo, 'git', 'rev-parse', 'main');
    // The owner's folder is on another branch, a commit ahead.
    sh(repo, 'git', 'checkout', '--quiet', '-b', 'feat/x');
    fs.writeFileSync(path.join(repo, 'mine.txt'), 'mine\n');
    sh(repo, 'git', 'add', 'mine.txt');
    sh(repo, 'git', 'commit', '--quiet', '-m', 'mine');
    const wt = await ensureWorktree(repo, tree, 'board/an-adder', { base });
    expect(wt).toMatchObject({ created: true, base });
    expect(await headOf(tree, pinEnv(wt.gitDir, tree))).toBe(base);
    expect(fs.existsSync(path.join(tree, 'mine.txt'))).toBe(false);
    expect(sh(repo, 'git', 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feat/x');
    // A base the repository does not have is refused, and nothing is made.
    const err = await ensureWorktree(repo, path.join(tmp, 'other'), 'board/b', { base: 'f'.repeat(40) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as Error).message).toContain('is not in this repository');
    expect(await branchNames(repo)).not.toContain('board/b');
  });

  it('is named from the title: ASCII, at most 60 characters, and -2, -3 when taken', () => {
    expect(branchFor('Animated typing calculator', 'c1', [])).toBe('board/animated-typing-calculator');
    expect(branchFor('Café: crème brûlée!', 'c1', [])).toBe('board/cafe-creme-brulee');
    expect(branchFor('计算器', 'calc', [])).toBe('board/calc');
    expect(branchFor('An adder', 'c1', ['board/an-adder'])).toBe('board/an-adder-2');
    expect(branchFor('An adder', 'c1', ['board/an-adder', 'board/an-adder-2'])).toBe('board/an-adder-3');
    // A branch under the name takes it too: git keeps a ref and a folder of refs apart.
    expect(branchFor('An adder', 'c1', ['board/an-adder/old'])).toBe('board/an-adder-2');
    const long = branchFor('a very long title '.repeat(10), 'c1', []);
    expect(long.length).toBeLessThanOrEqual(BRANCH_MAX);
    expect(long).toMatch(/^board\/[a-z0-9-]+[a-z0-9]$/);
    const taken = branchFor('a very long title '.repeat(10), 'c1', [long]);
    expect(taken.length).toBeLessThanOrEqual(BRANCH_MAX);
    expect(taken.endsWith('-2')).toBe(true);
    // Every name is one git takes.
    for (const name of [long, taken, branchFor('..lock//x', 'c1', [])]) sh(repo, 'git', 'check-ref-format', '--branch', name);
  });
});
