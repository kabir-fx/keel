import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';

/**
 * A scripted builder for browser tests, in the shape of the server's fake builder
 * (server/test/fake-builder.mjs), loaded with `--builder <this file>`. It does what a real
 * builder does, with no model behind it, so what the page shows is real:
 *
 * - Each canvas gets its own branch, `board/<the canvas's title>` (`-2`, `-3` when taken), made
 *   from `job.base.commit` in a git worktree of the board's repository, and reported with
 *   `ctx.place` as soon as it is there. Every later idea on the canvas is built on it.
 * - The agreed setup runs once, when the copy is made.
 * - Each part: "building" as the agent, a line in parts.txt, a commit, the agreed check, and
 *   "built" as the system with the real commit. The first part also writes the programs a show
 *   runs: `app.mjs` (a web app on `PORT`), `broken.mjs` (the same app, which ends before it
 *   answers once a file `down` is in its folder) and `greet.mjs` (a command line tool that asks
 *   a name).
 * - When every part is built, for an `app` show: the app is started once as the owner will try
 *   it, waited for until it answers, and stopped. One that does not answer ends the run
 *   `failed`. Then, for every build, the last commit: the brief, with the result. Then, for an
 *   app, `build.proved` as the system. A run for a chapter that only waits for its app has an
 *   empty track, and goes straight to the start.
 * - `show()` really runs the command in the canvas's copy: an app with `PORT` set, waited for
 *   until it answers; a terminal on `script`, with the command typed in. There is no box.
 * - `refresh()` merges the home commit into the branch in the copy. Where both changed the same
 *   lines it keeps both sides, commits, and says `resolved`. Then it runs every check.
 * - `discard()` takes the copy away, and the branch when asked.
 *
 * `--link-opt builder-step-ms=<ms>` sets how long each part takes (default 700), so a test can
 * watch the parts fill in one by one. `pause()` ends the run after the current part.
 *
 * `--link-opt builder-show=1`, or a blueprint whose show is a `page`, makes a finished run show
 * a small page that stands alone (a heading, a count and a button, with its own script and style
 * sheet), written as plain files into `show-<chapter>` inside the builder's private folder, and
 * returned as `show: { dir, page: 'index.html' }`. With no private folder, nothing is shown.
 *
 * Two settings come from the server's environment:
 *
 * - `KEEL_E2E_APP_SILENT=<n>`: the app never answers at the first n starts of the build. Its
 *   `app.mjs` waits for a database that is not there, and the start gives up after
 *   `KEEL_E2E_APP_WAIT_MS` (default 30000). At the next start the builder puts it right: the
 *   real app, in a commit of its own.
 * - `KEEL_E2E_HOLD_LAST_STEP=1`: after the last part, the run waits until a file `last-step.go`
 *   is beside the repository folder, then takes its last step. So a test can look at the board
 *   between the last part and the run's end for as long as it needs.
 *
 * Every builder the server creates is kept in `builders`, newest last.
 */
export const builders = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const APP_JS = `import http from 'node:http';
import fs from 'node:fs';
const port = Number(process.env.PORT);
const parts = () => fs.readFileSync('parts.txt', 'utf8').trim().split('\\n').map((l) => '<li>' + l.split(': ')[1] + '</li>').join('');
http
  .createServer((req, res) => {
    console.log('GET ' + req.url);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>The built app</title><h1>The engine answers</h1><ul data-testid="parts">' + parts() + '</ul><p data-testid="port">port ' + port + '</p>');
  })
  .listen(port, '127.0.0.1', () => console.log('the engine listens on 127.0.0.1:' + port + ' as pid ' + process.pid));
`;

const BROKEN_JS = `import fs from 'node:fs';
if (fs.existsSync('down')) {
  console.log('reading the settings');
  console.error('DATABASE_URL is not set: the engine cannot start');
  process.exit(3);
}
await import('./app.mjs');
`;

const SILENT_JS = `console.log('the engine waits for its database');
setInterval(() => undefined, 1000);
`;

const GREET_JS = `process.stdout.write('your name? ');
process.stdin.once('data', (d) => {
  console.log('hello, ' + String(d).trim() + '!');
  process.exit(0);
});
`;

/** A port nothing listens on now. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const answers = (url) =>
  new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });

/** A command, and every process in its group: signalled, then waited for. */
function running(proc, onExit) {
  let exited = false;
  let code = null;
  const done = new Promise((resolve) =>
    proc.once('exit', (c) => {
      exited = true;
      code = c;
      resolve();
    }),
  );
  let told = false;
  const tell = (c) => {
    if (told) return;
    told = true;
    onExit(c);
  };
  const signal = (sig) => {
    try {
      process.kill(-proc.pid, sig);
    } catch {
      // Gone already.
    }
  };
  return {
    get exited() {
      return exited;
    },
    get code() {
      return code;
    },
    done,
    tell,
    async stop() {
      signal('SIGTERM');
      const gone = await Promise.race([done.then(() => true), sleep(3000).then(() => false)]);
      if (!gone) {
        signal('SIGKILL');
        await done;
      }
      // Whatever is left in the group (a shell's children) goes too.
      signal('SIGKILL');
      tell(null);
    },
  };
}

export function createBuilder(ctx) {
  const step = Number(ctx.options['builder-step-ms'] ?? 700);
  const state = { ctx, calls: [], jobs: [], pausing: false, running: false, sessions: new Set(), silentLeft: Number(process.env.KEEL_E2E_APP_SILENT ?? 0) };
  const appWaitMs = Number(process.env.KEEL_E2E_APP_WAIT_MS ?? 30_000);
  builders.push(state);
  const home = ctx.stateDir ?? join(ctx.repoDir, '..', '.keel-builder');
  mkdirSync(home, { recursive: true });
  const placesFile = join(home, 'places.json');

  const git = (cwd, ...args) =>
    execFileSync(
      'git',
      ['-c', 'user.name=Keel test builder', '-c', 'user.email=builder@keel.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
    ).trim();
  const gitOk = (cwd, ...args) => {
    try {
      git(cwd, ...args);
      return true;
    } catch {
      return false;
    }
  };

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

  /** Each canvas's branch, kept on disk so a builder made after a restart finds it. */
  const places = () => (existsSync(placesFile) ? JSON.parse(readFileSync(placesFile, 'utf8')) : {});
  const keepPlace = (canvas, branch) => {
    const all = places();
    if (branch === undefined) delete all[canvas];
    else all[canvas] = branch;
    writeFileSync(placesFile, JSON.stringify(all));
  };
  const copyOf = (canvas) => join(home, `copy-${canvas}`);
  const hasBranch = (branch) => gitOk(ctx.repoDir, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`);

  const slug = (title) =>
    title
      .normalize('NFKD')
      .replace(/[^\x00-\x7f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 54)
      .replace(/-+$/, '') || 'idea';

  const runSetup = async (job, dir) => {
    if (!job.setup) return true;
    try {
      execFileSync('sh', ['-c', job.setup], { cwd: dir, stdio: 'ignore', timeout: 60_000 });
      return true;
    } catch {
      await post({ type: 'feed.add', chapter: job.chapter, kind: 'problem', text: `The setup "${job.setup}" failed.` });
      return false;
    }
  };

  /** The canvas's copy, on its branch: made from the home branch the first time, found again after. */
  const copyFor = async (job) => {
    const dir = copyOf(job.canvas);
    const known = places()[job.canvas];
    if (known && hasBranch(known)) {
      if (!existsSync(dir)) {
        git(ctx.repoDir, 'worktree', 'prune');
        git(ctx.repoDir, 'worktree', 'add', '-q', dir, known);
        if (!(await runSetup(job, dir))) return undefined;
      }
      ctx.place?.(job.canvas, { branch: known });
      return dir;
    }
    const base = slug(job.canvasTitle || job.title);
    let branch = `board/${base}`;
    for (let n = 2; hasBranch(branch); n++) branch = `board/${base}-${n}`;
    rmSync(dir, { recursive: true, force: true });
    git(ctx.repoDir, 'worktree', 'prune');
    git(ctx.repoDir, 'worktree', 'add', '-q', '-b', branch, dir, job.base?.commit ?? 'HEAD');
    keepPlace(job.canvas, branch);
    ctx.place?.(job.canvas, { branch });
    if (!(await runSetup(job, dir))) return undefined;
    return dir;
  };

  /** The copy a show or a refresh runs in, made again from the branch when it is gone. */
  const existingCopy = (canvas) => {
    const branch = places()[canvas];
    if (!branch || !hasBranch(branch)) return undefined;
    const dir = copyOf(canvas);
    if (!existsSync(dir)) {
      git(ctx.repoDir, 'worktree', 'prune');
      git(ctx.repoDir, 'worktree', 'add', '-q', dir, branch);
    }
    return dir;
  };

  /** The page a finished run shows: plain files, written fresh, in a folder of the builder's own. */
  const showPage = (job) => {
    if (!ctx.stateDir) return undefined;
    const dir = join(ctx.stateDir, `show-${job.chapter}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'index.html'),
      [
        '<!doctype html>',
        '<html lang="en">',
        '<head>',
        '<meta charset="utf-8">',
        '<title>What was built</title>',
        // An icon of its own: else the browser asks for /favicon.ico, which has no key, and gets a 404.
        '<link rel="icon" href="data:,">',
        '<link rel="stylesheet" href="style.css">',
        '<script type="module" src="app.js"></script>',
        '</head>',
        '<body>',
        '<h1>The engine is built</h1>',
        '<p>Requests taken: <output data-testid="count">0</output></p>',
        '<button type="button">Send a request</button>',
        '</body>',
        '</html>',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'app.js'),
      [
        "const count = document.querySelector('[data-testid=\"count\"]');",
        "document.querySelector('button').addEventListener('click', () => {",
        '  count.textContent = String(Number(count.textContent) + 1);',
        '});',
        "document.documentElement.dataset.opener = window.opener ? 'yes' : 'no';",
        "document.documentElement.dataset.ready = '1';",
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'style.css'),
      [
        'body { font-family: system-ui, sans-serif; margin: 48px; background: rgb(250, 248, 240); }',
        'h1 { color: rgb(32, 64, 128); }',
        'button { padding: 8px 16px; border-radius: 6px; }',
        '',
      ].join('\n'),
    );
    return { dir, page: 'index.html' };
  };

  const check = (cmd, cwd) => {
    try {
      execFileSync('sh', ['-c', cmd], { cwd, stdio: 'ignore', timeout: 20_000 });
      return true;
    } catch {
      return false;
    }
  };

  /** An app: `run` with PORT set, in its own process group, and its address once it answers. */
  const startApp = async (plan, dir, req, waitMs = 30_000) => {
    const port = plan.port ?? (await freePort());
    const proc = spawn('sh', ['-c', plan.run], { cwd: dir, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const run = running(proc, req.onExit);
    state.sessions.add(run);
    run.done.then(() => {
      state.sessions.delete(run);
      run.tell(run.code);
    });
    proc.stdout.setEncoding('utf8').on('data', req.onOutput);
    proc.stderr.setEncoding('utf8').on('data', req.onOutput);
    const url = `http://127.0.0.1:${port}/`;
    const ready = (async () => {
      const end = Date.now() + waitMs;
      while (!run.exited) {
        if (await answers(url)) return url;
        if (Date.now() >= end) {
          await run.stop();
          throw new Error(`The app did not answer on port ${port} within ${waitMs / 1000} s.`);
        }
        await Promise.race([sleep(150), run.done]);
      }
      throw new Error(`The app ended before it answered (exit ${run.code ?? 'by a signal'}).`);
    })();
    ready.catch(() => undefined);
    return { boxed: false, ready, write: () => undefined, resize: () => undefined, stop: () => run.stop() };
  };

  /**
   * A terminal: an interactive shell on a pty that `script` makes, with `run` typed in once it
   * has printed its prompt. macOS `script` refuses a socket on its input, so it reads a pipe
   * from `cat`. Its exit code comes back on fd 3.
   */
  const startTerminal = async (plan, dir, req) => {
    const cols = req.cols ?? 80;
    const rows = req.rows ?? 24;
    const inner = `stty rows ${rows} cols ${cols} 2>/dev/null; exec /bin/sh -i`;
    const pty = process.platform === 'linux' ? `script -qfec "$KEEL_CMD" /dev/null` : `script -q /dev/null /bin/sh -c "$KEEL_CMD"`;
    const wrap = `cat | { ${pty}; s=$?; printf '%s\\n' "$s" >&3; exit $s; }`;
    const proc = spawn('/bin/sh', ['-c', wrap], {
      cwd: dir,
      env: { ...process.env, KEEL_CMD: inner, PS1: '$ ', HISTFILE: '/dev/null', TERM: 'xterm-256color', ENV: '' },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      detached: true,
    });
    const run = running(proc, req.onExit);
    state.sessions.add(run);
    let code = null;
    proc.stdio[3].setEncoding('utf8').on('data', (s) => {
      const n = Number(s.trim());
      code = Number.isInteger(n) ? n : null;
      proc.stdin.end();
    });
    run.done.then(() => {
      state.sessions.delete(run);
      run.tell(code ?? run.code);
    });
    proc.stdin.on('error', () => undefined);
    let typed = false;
    const type = () => {
      if (typed || run.exited) return;
      typed = true;
      proc.stdin.write(`${plan.run}\r`);
    };
    const out = (s) => {
      req.onOutput(s);
      if (s.includes('$ ')) type();
    };
    proc.stdout.setEncoding('utf8').on('data', out);
    proc.stderr.setEncoding('utf8').on('data', out);
    setTimeout(type, 1500).unref();
    return {
      boxed: false,
      write: (data) => {
        if (!run.exited) proc.stdin.write(data);
      },
      resize: () => undefined,
      stop: () => run.stop(),
    };
  };

  /** False when the run is paused or closed while it waits for `last-step.go`. */
  const lastStepMay = async () => {
    if (process.env.KEEL_E2E_HOLD_LAST_STEP !== '1') return true;
    const go = join(ctx.repoDir, '..', 'last-step.go');
    const end = Date.now() + 120_000;
    while (!existsSync(go) && Date.now() < end) {
      if (state.pausing) return false;
      await sleep(50);
    }
    return !state.pausing;
  };

  /**
   * Start the app once as the owner will try it, wait until it answers, and stop it. An app
   * left silent from an earlier start is put right first, in a commit of its own. Returns why
   * the build stops, or undefined.
   */
  const startCheck = async (plan, dir, cmd) => {
    ctx.presence({ state: 'building', note: 'starting the app once, as you will try it' });
    if (state.silentLeft > 0) state.silentLeft -= 1;
    else if (readFileSync(join(dir, 'app.mjs'), 'utf8') === SILENT_JS) {
      writeFileSync(join(dir, 'app.mjs'), APP_JS);
      git(dir, 'add', 'app.mjs');
      git(dir, 'commit', '-q', '-m', 'The app listens on PORT');
      if (!check(cmd, dir)) return `The fix for the app's start fails the check "${cmd}".`;
    }
    let output = '';
    const s = await startApp(plan, dir, { onOutput: (t) => (output += t), onExit: () => undefined }, appWaitMs);
    try {
      await s.ready;
      return undefined;
    } catch (e) {
      const last = output.trim().split('\n').slice(-2).join(' ');
      return `The app does not start: \`${plan.run}\`. ${e.message}${last ? ` It printed: "${last}".` : ''}`;
    } finally {
      await s.stop();
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
        const dir = await copyFor(job);
        if (!dir) return { outcome: 'failed', note: `the setup "${job.setup}" failed` };
        writeFileSync(join(dir, 'BRIEF.md'), job.brief || `# ${job.title}\n`);
        const cmd = job.check ?? 'true';
        for (const part of job.track) {
          if (state.pausing) return { outcome: 'paused' };
          // "Building" is the agent's word; "built" and the commit come from the build's own tools.
          await post({ type: 'part.state', part: part.id, state: 'building' }, 'agent');
          ctx.presence({ state: 'building', note: `building ${part.name}` });
          await sleep(step);
          if (state.pausing) return { outcome: 'paused' };
          appendFileSync(join(dir, 'parts.txt'), `${part.id}: ${part.name}\n`);
          writeFileSync(join(dir, 'app.mjs'), state.silentLeft > 0 ? SILENT_JS : APP_JS);
          writeFileSync(join(dir, 'broken.mjs'), BROKEN_JS);
          writeFileSync(join(dir, 'greet.mjs'), GREET_JS);
          git(dir, 'add', 'parts.txt', 'BRIEF.md', 'app.mjs', 'broken.mjs', 'greet.mjs');
          git(dir, 'commit', '-q', '-m', `Build ${part.name}`);
          const commit = git(dir, 'rev-parse', '--short=7', 'HEAD');
          if (!check(cmd, dir)) {
            await post({ type: 'feed.add', chapter: job.chapter, kind: 'problem', part: part.id, commit, check: { cmd, passed: false }, text: `The check failed after ${part.name}.` });
            return { outcome: 'failed', note: `the check "${cmd}" failed after ${part.name}` };
          }
          await post({ type: 'part.state', part: part.id, state: 'built', commit, check: { cmd, passed: true } });
          await post({ type: 'feed.add', chapter: job.chapter, kind: 'commit', part: part.id, commit, check: { cmd, passed: true }, text: `${part.name} is built. One line in parts.txt.` });
        }
        if (state.pausing) return { outcome: 'paused' };
        if (!(await lastStepMay())) return { outcome: 'paused' };
        const app = job.show?.kind === 'app' ? job.show : undefined;
        if (app) {
          const why = await startCheck(app, dir, cmd);
          if (why) return { outcome: 'failed', note: why };
        }
        writeFileSync(join(dir, 'BRIEF.md'), `${job.brief || `# ${job.title}\n`}\nThe result: every part is built${app ? `, and \`${app.run}\` started and answered` : ''}.\n`);
        git(dir, 'add', 'BRIEF.md');
        git(dir, 'commit', '-q', '-m', `${job.title}: the brief, with the result`);
        if (app) await post({ type: 'build.proved', chapter: job.chapter });
        const show = ctx.options['builder-show'] === '1' || job.show?.kind === 'page' ? showPage(job) : undefined;
        return show ? { outcome: 'done', show } : { outcome: 'done' };
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
      await Promise.all([...state.sessions].map((s) => s.stop()));
    },
    async show(req) {
      state.calls.push('show');
      const dir = existingCopy(req.canvas);
      if (!dir) throw new Error('This machine has no copy of the build.');
      return req.plan.kind === 'app' ? startApp(req.plan, dir, req) : startTerminal(req.plan, dir, req);
    },
    async refresh(req) {
      state.calls.push('refresh');
      const dir = existingCopy(req.canvas);
      if (!dir) return { outcome: 'failed', note: 'this machine has no copy of the build' };
      if (gitOk(dir, 'merge-base', '--is-ancestor', req.home.commit, 'HEAD')) return { outcome: 'level' };
      let outcome = 'joined';
      if (!gitOk(dir, 'merge', '--no-edit', '-q', req.home.commit)) {
        const conflicted = git(dir, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
        if (conflicted.length === 0) {
          gitOk(dir, 'merge', '--abort');
          return { outcome: 'failed', note: 'the merge stopped with no conflict to join' };
        }
        // Both sides are kept: the lines between the markers, without the markers.
        for (const f of conflicted) {
          const text = readFileSync(join(dir, f), 'utf8');
          writeFileSync(join(dir, f), text.replace(/^(<<<<<<<|=======|>>>>>>>).*\n/gm, ''));
        }
        git(dir, 'add', '--', ...conflicted);
        git(dir, 'commit', '-q', '--no-edit');
        outcome = 'resolved';
      }
      for (const s of req.setups) if (!check(s, dir)) return { outcome: 'failed', note: `the setup "${s}" failed after the join` };
      for (const c of req.checks) if (!check(c, dir)) return { outcome: 'failed', note: `the check "${c}" failed after the join` };
      return { outcome };
    },
    async discard(req) {
      state.calls.push('discard');
      const dir = copyOf(req.canvas);
      if (existsSync(dir)) gitOk(ctx.repoDir, 'worktree', 'remove', '--force', dir);
      rmSync(dir, { recursive: true, force: true });
      gitOk(ctx.repoDir, 'worktree', 'prune');
      const branch = places()[req.canvas];
      if (req.branch && branch) {
        if (hasBranch(branch) && !gitOk(ctx.repoDir, 'branch', '-D', branch)) return { ok: false, note: `git did not delete ${branch}` };
        keepPlace(req.canvas, undefined);
      }
      return { ok: true };
    },
  };
}
