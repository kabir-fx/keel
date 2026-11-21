/**
 * A builder for the server's tests, loaded by path as `--builder` or beside a link. The test
 * drives it by hand: a run waits until the test calls `finish`, unless `auto` is set. `pause()`
 * ends the run with "paused", as a real builder does after its current step.
 *
 * Every builder the server creates is kept in `fakes`, newest last.
 *
 * It also shows, refreshes and discards, as a builder with a copy of its own does: each is
 * scripted by the test. With the option `builder-extras=none` it has none of the three, as a
 * builder that keeps no copy.
 */
export const fakes = [];

export function createBuilder(ctx) {
  const fake = {
    ctx,
    /** 'run', 'pause' and 'close', in the order the server called them. */
    calls: [],
    jobs: [],
    active: 0,
    maxActive: 0,
    /** When set, run() throws this message at once. */
    throwOnRun: undefined,
    /** When set, every run resolves at once with it. */
    auto: undefined,
    /** Runs to play, the first for the next run: each is called with the job and the fake, and resolves with the run's result. */
    plays: [],
    /** When false, pause() is heard and the run goes on until finish(). */
    pauseEnds: true,
    current: undefined,
    /** Every show asked for, with the session the fake gave: `req`, `written`, `sizes`, `stopped`, `answer(url)`, `refuse(msg)`, `print(text)`, `exit(code)`. */
    shows: [],
    /** When true, every session says it runs with no box, as on a machine that has none. */
    unboxed: false,
    /** When set, show() calls it with the request and returns what it gives. */
    showWith: undefined,
    /** Every refresh asked for. */
    refreshes: [],
    /** What refresh() resolves with. A function is called with the request. */
    refreshWith: { outcome: 'joined' },
    /** Every discard asked for. */
    discards: [],
    /** When set, discard() calls it with the request first. */
    discardWith: undefined,
    /** End the run that is going. */
    finish(result = { outcome: 'done' }) {
      const end = fake.current;
      if (!end) throw new Error('no run is going');
      fake.current = undefined;
      fake.active -= 1;
      end(result);
    },
    /** Post drafts as the build's tools would: as the system, or as the agent. */
    async post(drafts, as = 'system') {
      const token = as === 'system' ? ctx.systemToken : ctx.agentToken;
      const res = await fetch(`${ctx.serverUrl}/api/events`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ drafts: Array.isArray(drafts) ? drafts : [drafts] }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(`${body.rule ?? res.status}: ${body.reason ?? body.error}`);
      return body.events;
    },
  };
  fakes.push(fake);

  const extras = ctx.options['builder-extras'] === 'none' ? {} : {
    async show(req) {
      if (fake.showWith) return fake.showWith(req);
      let answer, refuse;
      const ready = req.plan.kind === 'app' ? new Promise((resolve, reject) => ((answer = resolve), (refuse = reject))) : undefined;
      ready?.catch(() => {});
      const s = {
        req,
        written: [],
        sizes: [],
        stopped: false,
        exited: false,
        answer: (url) => answer?.(url),
        refuse: (msg) => refuse?.(new Error(msg)),
        print: (text) => req.onOutput(text),
        exit(code) {
          if (s.exited) return;
          s.exited = true;
          req.onExit(code);
        },
      };
      fake.shows.push(s);
      return {
        ...(ready ? { ready } : {}),
        ...(fake.unboxed ? { boxed: false } : {}),
        write: (data) => s.written.push(data),
        resize: (cols, rows) => s.sizes.push([cols, rows]),
        async stop() {
          s.stopped = true;
          s.exit(null);
        },
      };
    },
    async refresh(req) {
      fake.refreshes.push(req);
      return typeof fake.refreshWith === 'function' ? fake.refreshWith(req) : fake.refreshWith;
    },
    async discard(req) {
      fake.discards.push(req);
      if (fake.discardWith) await fake.discardWith(req);
      return { ok: true };
    },
  };

  return {
    ...extras,
    name: ctx.options['builder-name'] ?? 'fake-builder',
    run(job) {
      fake.calls.push('run');
      fake.jobs.push(job);
      if (fake.throwOnRun) throw new Error(fake.throwOnRun);
      fake.active += 1;
      fake.maxActive = Math.max(fake.maxActive, fake.active);
      const play = fake.plays.shift();
      return new Promise((resolve) => {
        fake.current = resolve;
        if (play) play(job, fake).then((result) => fake.finish(result));
        else if (fake.auto) fake.finish(fake.auto);
      });
    },
    async pause() {
      fake.calls.push('pause');
      if (fake.pauseEnds && fake.current) fake.finish({ outcome: 'paused' });
    },
    async close() {
      fake.calls.push('close');
    },
  };
}
