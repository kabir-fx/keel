import { execFileSync } from 'node:child_process';
import type { Verdict } from '@keel/protocol';

/**
 * "Built" needs a real commit (rule R2). Before the server admits `part.state` with
 * `state: "built"`, it asks git, in the repository, whether the commit exists.
 */

/** A commit id: 4 to 64 hex digits, as git prints it, short or full. */
const COMMIT_ID = /^[0-9a-f]{4,64}$/i;

export type CommitCheck = (commit: string) => Verdict;

/** Ask git whether `commit` names a commit in `repoDir`. No shell, and nothing git could run. */
export function gitCommitCheck(repoDir: string): CommitCheck {
  return (commit) => {
    if (!COMMIT_ID.test(commit)) {
      return { ok: false, rule: 'R2', reason: `"built" needs the id of the commit that built it, such as eb39c5b. "${commit.slice(0, 40)}" is not a commit id.` };
    }
    try {
      execFileSync(
        'git',
        // A repository's own config must not make this run anything.
        ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'rev-parse', '--verify', '--quiet', `${commit}^{commit}`],
        {
          cwd: repoDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 5000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_DIR: undefined, GIT_WORK_TREE: undefined },
          windowsHide: true,
        },
      );
      return { ok: true };
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { status?: number | null; stderr?: Buffer };
      if (err.code === 'ENOENT') return { ok: false, rule: 'R2', reason: 'git is not installed, so the server cannot check the commit. A part is built only when its commit can be checked.' };
      const said = String(err.stderr ?? '');
      if (err.status === 128 && /not a git repository/i.test(said)) {
        return { ok: false, rule: 'R2', reason: `The board's folder is not a git repository, so commit ${commit} cannot be checked. A part is built only by a commit in this repository.` };
      }
      if (err.status === 1) {
        return { ok: false, rule: 'R2', reason: `There is no commit ${commit} in this repository. Report "built" with the id of a commit that exists.` };
      }
      return { ok: false, rule: 'R2', reason: `git could not check commit ${commit}, so the part is not built yet. Try again.` };
    }
  };
}
