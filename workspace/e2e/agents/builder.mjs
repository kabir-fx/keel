import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A scripted builder for browser tests, in the shape of the server's fake builder
 * (server/test/fake-builder.mjs), loaded with `--builder <this file>`. It does what a real
 * builder does, with no model behind it: it works in its own git worktree of the board's
 * repository, on its own branch, and builds the track one part at a time. For each part it
 * says "building" as the agent, writes a line, commits it, runs the agreed check, and reports
 * "built" as the system, with the real commit id and the check that passed. The server checks
 * that commit with git.
 *
 * `--link-opt builder-step-ms=<ms>` sets how long each part takes (default 700), so a test can
 * watch the parts fill in one by one. `pause()` ends the run after the current part.
 *
 * Every builder the server creates is kept in `builders`, newest last.
 */
export const builders = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createBuilder(ctx) {
  const step = Number(ctx.options['builder-step-ms'] ?? 700);
  const state = { ctx, calls: [], jobs: [], pausing: false, running: false, worktree: undefined };
  builders.push(state);

  const git = (cwd, ...args) =>
    execFileSync(
      'git',
      ['-c', 'user.name=Keel test builder', '-c', 'user.email=builder@keel.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    ).trim();

  /** Post drafts as the build's tools do: as the system, or as the agent. */
  const post = async (drafts, as = 'system') => {
    const token = as === 'system' ? ctx.systemToken : ctx.agentToken;
    const res = await fetch(`${ctx.serverUrl}/api/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ drafts: Array.isArray(drafts) ? drafts : [drafts] }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`${body.rule ?? res.status}: ${body.reason ?? body.error}`);
    return body.events;
  };

  /** The builder's own copy of the repository, on its own branch. Made once, kept across runs. */
  const worktree = (job) => {
    if (state.worktree && existsSync(state.worktree)) return state.worktree;
    const home = ctx.stateDir ?? join(ctx.repoDir, '..', '.keel-builder');
    mkdirSync(home, { recursive: true });
    const dir = join(home, `worktree-${job.chapter}`);
    git(ctx.repoDir, 'worktree', 'add', '-q', '-B', `keel/${job.chapter}`, dir, 'HEAD');
    state.worktree = dir;
    return dir;
  };

  const check = (cmd, cwd) => {
    try {
      execFileSync('sh', ['-c', cmd], { cwd, stdio: 'ignore', timeout: 20_000 });
      return true;
    } catch {
      return false;
    }
  };

  return {
    name: ctx.options['builder-name'] ?? 'scripted-builder',
    async run(job) {
      state.calls.push('run');
      state.jobs.push(job);
      state.pausing = false;
      state.running = true;
      try {
        const dir = worktree(job);
        writeFileSync(join(dir, 'BRIEF.md'), job.brief || `# ${job.title}\n`);
        const cmd = job.check ?? 'true';
        for (const part of job.track) {
          if (state.pausing) return { outcome: 'paused' };
          // "Building" is the agent's word; "built" and the commit come from the build's own tools.
          await post({ type: 'part.state', part: part.id, state: 'building' }, 'agent');
          ctx.presence({ state: 'building', note: `building ${part.name}` });
          await sleep(step);
          appendFileSync(join(dir, 'parts.txt'), `${part.id}: ${part.name}\n`);
          git(dir, 'add', 'parts.txt', 'BRIEF.md');
          git(dir, 'commit', '-q', '-m', `Build ${part.name}`);
          const commit = git(dir, 'rev-parse', '--short=7', 'HEAD');
          if (!check(cmd, dir)) {
            await post({ type: 'feed.add', chapter: job.chapter, kind: 'problem', part: part.id, commit, check: { cmd, passed: false }, text: `The check failed after ${part.name}.` });
            return { outcome: 'failed', note: `the check "${cmd}" failed after ${part.name}` };
          }
          await post({ type: 'part.state', part: part.id, state: 'built', commit, check: { cmd, passed: true } });
          await post({ type: 'feed.add', chapter: job.chapter, kind: 'commit', part: part.id, commit, check: { cmd, passed: true }, text: `${part.name} is built. One line in parts.txt.` });
        }
        return { outcome: state.pausing ? 'paused' : 'done' };
      } finally {
        state.running = false;
      }
    },
    async pause() {
      state.calls.push('pause');
      state.pausing = true;
    },
    async close() {
      state.calls.push('close');
      state.pausing = true;
    },
  };
}
