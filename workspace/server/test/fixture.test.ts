import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BoardEvent } from '@keel/protocol';
import { parseLog, replay } from '@keel/protocol';
import { Board } from '../src/board';
import { tempRepo } from './helpers';

const FIXTURE = fileURLToPath(new URL('../../protocol/fixtures/engine-loop/log.jsonl', import.meta.url));

/** Dates as the server writes them, so two logs of the same story compare equal. */
const normal = (events: readonly BoardEvent[]) => events.map((e) => ({ ...e, at: new Date(e.at).toISOString() }));

describe.skipIf(!fs.existsSync(FIXTURE))('the engine-loop fixture', () => {
  it('replays through a fresh board, each event as its own actor, with the same ids and state', () => {
    const { events, problems } = parseLog(fs.readFileSync(FIXTURE, 'utf8'));
    expect(problems).toEqual([]);
    expect(events.length).toBeGreaterThan(0);

    let at = new Date(0);
    const repo = tempRepo('ullm');
    // The fixture's commits are in no repository: replaying it turns the commit check off.
    const board = Board.open(repo, { create: false, now: () => at, checkCommits: false });
    for (const ev of events) {
      const { id, at: when, by, ...draft } = ev;
      at = new Date(when);
      const r = board.post([draft], by);
      if (!r.ok) throw new Error(`${id} was refused under ${r.rule}: ${r.reason}`);
      expect(r.events[0]!.id).toBe(id);
    }
    const expected = replay(normal(events));
    expect(board.state).toEqual(expected);
    board.close();

    const again = Board.open(repo);
    expect(again.problems).toEqual([]);
    expect(again.state).toEqual(expected);
    again.close();
  });
});
