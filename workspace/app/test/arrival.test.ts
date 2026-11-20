import type { Box } from '@keel/protocol';
import { audit, emptyState, parseLog, replay } from '@keel/protocol';
import { describe, expect, it } from 'vitest';
import { cutAt, loadFixture, playRange } from '../src/fixture';
import { overlaps } from '../src/geometry';
import { buildArrival } from '../src/fixtures/arrival/story';
import { playScript, WAKE_NOTE } from '../src/replay/script';
import checkpointsJson from '../src/fixtures/arrival/checkpoints.json?raw';
import log from '../src/fixtures/arrival/log.jsonl?raw';

describe('the arrival fixture', () => {
  const built = buildArrival();

  it('is what its generator builds', () => {
    expect(log).toBe(built.log);
    expect(checkpointsJson).toBe(built.checkpointsJson);
  });

  it('reads back with no problem and passes every rule', () => {
    const { events, problems } = parseLog(built.log);
    expect(problems).toEqual([]);
    expect(events).toEqual(built.events);
    expect(audit(events, emptyState()).problems).toEqual([]);
  });

  it('has one checkpoint per step of the scene, each after a real event', async () => {
    const fx = (await loadFixture('arrival'))!;
    expect(fx.checkpoints.map((c) => c.name)).toEqual(['read', 'mini', 'answer', 'spread', 'placeholder', 'redraw']);
    for (const c of fx.checkpoints) expect(fx.events.some((e) => e.id === c.after)).toBe(true);
    // The first checkpoint is played from a blank board.
    expect(playRange(fx, 1).from).toBe(0);
  });

  it('places every picture in the log, right after the call that posted or finished it, and none overlaps another', () => {
    const state = replay(built.events);
    const pictures = state.itemOrder.filter((id) => state.items[id]!.item.kind === 'picture');
    expect(pictures).toEqual(['read', 'path', 'ways', 'plan']);
    for (const id of pictures) {
      const i = built.events.findIndex((e) => e.type === 'item.place' && e.item === id);
      expect(i).toBeGreaterThan(0);
      expect(built.events[i - 1]).toMatchObject({ by: 'agent' });
    }
    const boxes = state.itemOrder.map((id) => state.items[id]!.item.box).filter((b): b is Box => !!b && b[2] > 0);
    for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) expect(overlaps(a, b)).toBe(false);
  });

  it('plays each checkpoint alone: the owner woken for, the agent answering, and the turn ended', async () => {
    const fx = (await loadFixture('arrival'))!;
    for (const c of fx.checkpoints) {
      const range = playRange(fx, c.screen);
      const script = playScript(fx.events.slice(0, range.to), range.from);
      const fed = script.flatMap((s) => s.events ?? []);
      expect(fed).toEqual(fx.events.slice(range.from, range.to));
      expect(script[script.length - 1]!.presence).toEqual({ state: 'listening' });
      // The owner's turns wake the agent; the agent's own follow-ups (5 and 6) do not.
      expect(script.some((s) => s.presence?.note === WAKE_NOTE)).toBe(c.screen <= 4);
      // Played to its end, the board is the board at the checkpoint.
      expect(replay([...fx.events.slice(0, range.from), ...fed])).toEqual(replay(cutAt(fx, c.screen).events));
    }
  });
});
