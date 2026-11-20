import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dirtyFiles, ensureWorktree, gitEnv, gitOk, headOf, pinEnv, samePath, worktreeGitDir } from '../src/git';
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
    expect(await ensureWorktree(repo, tree, 'board/x')).toEqual({ created: false, gitDir: wt.gitDir });
  });

  it('is not made in a repository with no commit: the reason says what is missing, and how to try again is left to who reports it', async () => {
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    sh(empty, 'git', 'init', '--quiet');
    await expect(ensureWorktree(empty, tree, 'board/x')).rejects.toThrow(/^The repository has no commit yet, so there is nothing to build on\. Make a first commit\.$/);
    expect(fs.existsSync(tree)).toBe(false);
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
