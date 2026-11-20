/**
 * A builder for the server's tests, loaded by path as `--builder` or beside a link. The test
 * drives it by hand: a run waits until the test calls `finish`, unless `auto` is set. `pause()`
 * ends the run with "paused", as a real builder does after its current step.
 *
 * Every builder the server creates is kept in `fakes`, newest last.
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
    /** When false, pause() is heard and the run goes on until finish(). */
    pauseEnds: true,
    current: undefined,
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

  return {
    name: ctx.options['builder-name'] ?? 'fake-builder',
    run(job) {
      fake.calls.push('run');
      fake.jobs.push(job);
      if (fake.throwOnRun) throw new Error(fake.throwOnRun);
      fake.active += 1;
      fake.maxActive = Math.max(fake.maxActive, fake.active);
      return new Promise((resolve) => {
        fake.current = resolve;
        if (fake.auto) fake.finish(fake.auto);
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
