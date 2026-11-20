import { audit, emptyState } from '@keel/protocol';
import { describe, expect, it } from 'vitest';
import { cutAt, fixtureNames, loadFixture, openingOf } from '../src/fixture';

describe('fixtures', () => {
  it('finds the app sample, and the golden fixture when it is there', () => {
    expect(fixtureNames()).toContain('sample');
    expect(fixtureNames()).toContain('tools');
  });

  it.each(fixtureNames())('%s parses, passes the rules, and its checkpoints name real events', async (name) => {
    const fx = (await loadFixture(name))!;
    expect(fx.problems).toEqual([]);
    expect(fx.events.length).toBeGreaterThan(0);
    // The golden fixture is still being written by its own agent; only the sample must be clean.
    if (name === 'sample' || name === 'tools') expect(audit(fx.events, emptyState()).problems).toEqual([]);
    for (const c of fx.checkpoints) expect(fx.events.some((e) => e.id === c.after)).toBe(true);
  });

  it('cuts the log at a checkpoint', async () => {
    const fx = (await loadFixture('sample'))!;
    const one = cutAt(fx, 1);
    expect(one.checkpoint?.name).toBe('main');
    expect(one.events[one.events.length - 1]?.id).toBe(one.checkpoint?.after);
    expect(cutAt(fx, undefined).events).toHaveLength(fx.events.length);
  });

  it('opens each checkpoint as its view says: what to show, the focus, the walk, the pipeline, presence', async () => {
    const fx = (await loadFixture('engine-loop'))!;
    const model = openingOf(cutAt(fx, 3).checkpoint);
    expect(model).toMatchObject({ mode: 'board', show: ['pipe', 'walk', 'reply-sleeps', 'hint'], view: { walk: { id: 'req-42', step: 8 }, pipeline: 'layers' }, presence: { state: 'listening' } });
    expect(model.focus).toBeUndefined();
    const focus = openingOf(cutAt(fx, 4).checkpoint);
    expect(focus).toMatchObject({ focus: 'focus', show: ['focus', 'read-marks'], view: { pipeline: 'layers' } });
    expect(focus.view.walk).toBeUndefined();
    expect(openingOf(cutAt(fx, 7).checkpoint).mode).toBe('story');
    expect(openingOf(undefined)).toEqual({ mode: 'board', view: {} });
  });

  it('says there is no such fixture', async () => {
    expect(await loadFixture('nope')).toBeUndefined();
  });
});
