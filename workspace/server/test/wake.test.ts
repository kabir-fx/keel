import { afterEach, describe, expect, it } from 'vitest';
import type { BoardEvent } from '@keel/protocol';
import { Board } from '../src/board';
import { PresenceHub } from '../src/presence';
import { QUIET_LONG, QUIET_SHORT, WAKE_TIMEOUT, WakeScheduler, quietAfter } from '../src/wake';
import { CH, FakeClock, FakeLink, chapter, flush, ink, note, tempRepo } from './helpers';

const boards: Board[] = [];
afterEach(() => {
  for (const b of boards.splice(0)) b.close();
});

function setup() {
  const board = Board.open(tempRepo());
  boards.push(board);
  board.post([chapter()], 'owner');
  const clock = new FakeClock();
  const link = new FakeLink();
  const presence = new PresenceHub({ state: 'listening' });
  const scheduler = new WakeScheduler({ link, state: () => board.state, presence, clock });
  board.subscribe((events) => scheduler.notify(events));
  const owner = (...drafts: unknown[]) => {
    const r = board.post(drafts, 'owner');
    if (!r.ok) throw new Error(`${r.rule}: ${r.reason}`);
    return r.events;
  };
  const agent = (...drafts: unknown[]) => {
    const r = board.post(drafts, 'agent');
    if (!r.ok) throw new Error(`${r.rule}: ${r.reason}`);
    return r.events;
  };
  return { board, clock, link, presence, scheduler, owner, agent };
}

const freshIds = (w: { digest: { open: Array<{ id: string; fresh: boolean }> } }) =>
  w.digest.open.filter((o) => o.fresh).map((o) => o.id);

describe('the pause rule', () => {
  it('waits 1500 ms after a stroke and 300 ms after a note', () => {
    const t = setup();
    t.owner(ink('m1'));
    t.clock.advance(QUIET_LONG - 1);
    expect(t.link.wakes).toHaveLength(0);
    t.clock.advance(1);
    expect(t.link.wakes).toHaveLength(1);

    const u = setup();
    u.owner(note('m1', 'one engine'));
    u.clock.advance(QUIET_SHORT - 1);
    expect(u.link.wakes).toHaveLength(0);
    u.clock.advance(1);
    expect(u.link.wakes).toHaveLength(1);
    expect(u.link.wakes[0]!.reason).toBe('marks');
    expect(u.link.wakes[0]!.text).toMatch(/m1 note "one engine"/);
  });

  it('makes one wake per pause, and joins the marks of that pause', () => {
    const t = setup();
    t.owner(ink('m1'));
    t.clock.advance(1000);
    t.owner(ink('m2'));
    t.clock.advance(1000);
    t.owner(note('m3', 'and this'));
    t.clock.advance(QUIET_SHORT - 1);
    expect(t.link.wakes).toHaveLength(0);
    t.clock.advance(1);
    expect(t.link.wakes).toHaveLength(1);
    expect(freshIds(t.link.wakes[0]!)).toEqual(['m1', 'm2', 'm3']);
    t.clock.advance(60_000);
    expect(t.link.wakes).toHaveLength(1);
  });

  it('never wakes twice at once, and wakes once more for marks made during a wake', async () => {
    const t = setup();
    t.owner(note('m1', 'first'));
    t.clock.advance(QUIET_SHORT);
    expect(t.link.wakes).toHaveLength(1);
    const seqAtFirst = t.link.wakes[0]!.digest.seq;

    // The agent is busy. The owner keeps going.
    t.owner(note('m2', 'second'));
    t.clock.advance(QUIET_SHORT);
    t.owner(ink('m3'));
    t.clock.advance(QUIET_LONG);
    t.owner(note('m4', 'fourth'));
    t.clock.advance(QUIET_SHORT);
    expect(t.link.wakes).toHaveLength(1);

    t.agent({ type: 'answer', answers: ['m1'], read: 'Read during the wake.' });
    t.link.finish();
    await flush();
    expect(t.link.wakes).toHaveLength(2);
    expect(t.link.maxActive).toBe(1);
    const second = t.link.wakes[1]!;
    expect(second.digest.open.map((o) => o.id)).toEqual(['m2', 'm3', 'm4']);
    expect(freshIds(second)).toEqual(['m2', 'm3', 'm4']);
    expect(t.scheduler.seenSeq).toBe(seqAtFirst);

    t.link.finish();
    await flush();
    t.clock.advance(60_000);
    await flush();
    expect(t.link.wakes).toHaveLength(2);
  });

  it('waits for the quiet time when the owner is still drawing as a wake ends', async () => {
    const t = setup();
    t.owner(note('m1', 'first'));
    t.clock.advance(QUIET_SHORT);
    t.owner(ink('m2'));
    t.clock.advance(500);
    t.link.finish();
    await flush();
    expect(t.link.wakes).toHaveLength(1);
    t.clock.advance(QUIET_LONG - 500);
    expect(t.link.wakes).toHaveLength(2);
  });

  it('stays quiet when nothing is open', async () => {
    const t = setup();
    t.owner(note('m1', 'quick question'));
    t.agent({ type: 'answer', answers: ['m1'], read: 'Answered before the pause ended.' });
    t.clock.advance(60_000);
    expect(t.link.wakes).toHaveLength(0);

    // Moves, placements and the agent's own events never start a wake.
    t.owner({ type: 'item.update', item: 'm1', patch: { box: [5, 5, 300, 120] } });
    t.owner(chapter('second-idea'));
    expect(t.clock.pending).toBe(0);
    expect(t.link.wakes).toHaveLength(0);

    // Editing a note's words is a new remark: the contract opens the mark again, so the agent wakes.
    t.owner({ type: 'item.update', item: 'm1', patch: { text: 'quick question, edited' } });
    t.clock.advance(QUIET_SHORT);
    expect(t.link.wakes).toHaveLength(1);
    expect(freshIds(t.link.wakes[0]!)).toEqual(['m1']);
  });

  it('wakes for an act, and says so', () => {
    const t = setup();
    t.owner({ type: 'solidify', chapter: CH, picks: [], parts: [] });
    t.clock.advance(QUIET_SHORT);
    expect(t.link.wakes).toHaveLength(1);
    expect(t.link.wakes[0]!.reason).toBe('act');
    expect(t.link.wakes[0]!.digest.open[0]).toMatchObject({ kind: 'solidify', fresh: true });
  });

  it('wakes at start when marks waited for an agent, and not when none did', () => {
    const t = setup();
    t.board.post([note('m1', 'left while no agent ran')], 'owner');
    t.clock.advance(60_000);
    t.link.wakes.length = 0;
    const s = new WakeScheduler({ link: t.link, state: () => t.board.state, presence: t.presence, clock: t.clock });
    s.start();
    expect(t.link.wakes).toHaveLength(1);
    expect(t.link.wakes[0]!.reason).toBe('start');

    const u = setup();
    u.scheduler.start();
    expect(u.link.wakes).toHaveLength(0);
  });

  it('marks the pill away when a wake fails, retries after 2, 8 and 30 s, then waits for the owner', async () => {
    const t = setup();
    t.link.auto = { ok: false, note: 'no session' };
    t.owner(note('m1', 'anyone there?'));
    t.clock.advance(QUIET_SHORT);
    await flush();
    expect(t.link.wakes).toHaveLength(1);
    expect(t.presence.get()).toMatchObject({ state: 'away', note: 'the agent did not answer: no session' });

    for (const [wait, count] of [[2000, 2], [8000, 3], [30_000, 4]] as const) {
      t.clock.advance(wait - 1);
      await flush();
      expect(t.link.wakes).toHaveLength(count - 1);
      t.clock.advance(1);
      await flush();
      expect(t.link.wakes).toHaveLength(count);
    }
    t.clock.advance(10 * 60_000);
    await flush();
    expect(t.link.wakes).toHaveLength(4);
    expect(t.link.maxActive).toBe(1);

    // The owner's next mark tries again, and a good wake brings the pill back.
    t.link.auto = { ok: true };
    t.owner(note('m2', 'hello?'));
    t.clock.advance(QUIET_SHORT);
    await flush();
    expect(t.link.wakes).toHaveLength(5);
    expect(freshIds(t.link.wakes[4]!)).toEqual(['m1', 'm2']);
    expect(t.presence.get().state).toBe('listening');
  });

  it('counts a wake that never returns as failed after ten minutes, so later wakes still happen', async () => {
    const t = setup();
    t.owner(note('m1', 'anyone there?'));
    t.clock.advance(QUIET_SHORT);
    await flush();
    expect(t.link.wakes).toHaveLength(1);
    expect(t.scheduler.busy).toBe(true);
    t.clock.advance(WAKE_TIMEOUT - 1);
    await flush();
    expect(t.scheduler.busy).toBe(true);
    t.clock.advance(1);
    await flush();
    expect(t.scheduler.busy).toBe(false);
    expect(t.presence.get()).toMatchObject({ state: 'away', note: 'the agent did not answer: no answer after 10 minutes' });
    // The retry goes out, and carries the same open mark.
    t.clock.advance(2000);
    await flush();
    expect(t.link.wakes).toHaveLength(2);
    expect(t.link.wakes[1]!.digest.open.map((o) => o.id)).toEqual(['m1']);
  });

  it('says whether the chapter has a picture from the agent yet: firstOfChapter', async () => {
    const t = setup();
    t.owner(note('m1', 'a first idea'));
    t.clock.advance(QUIET_SHORT);
    expect(t.link.wakes[0]!.firstOfChapter).toBe(true);
    t.agent({ type: 'item.add', chapter: CH, item: { id: 'p1', kind: 'picture', picture: { kind: 'text', title: 'How I read it' }, answers: ['m1'] } });
    t.link.finish();
    await flush();

    t.owner(note('m2', 'more on it'));
    t.clock.advance(QUIET_SHORT);
    expect(t.link.wakes[1]!.firstOfChapter).toBe(false);
    // A picture the agent took off the board still counts: it has looked at this idea.
    t.agent({ type: 'item.remove', item: 'p1' });
    t.link.finish();
    await flush();
    t.owner(note('m3', 'still here'));
    t.clock.advance(QUIET_SHORT);
    expect(t.link.wakes[2]!.firstOfChapter).toBe(false);
    t.link.finish();
    await flush();

    // A new idea has no picture yet.
    t.owner(chapter('second-idea'), { type: 'item.add', chapter: 'second-idea', item: { id: 'm4', kind: 'note', box: [0, 0, 200, 80], text: 'the next idea' } });
    t.clock.advance(QUIET_SHORT);
    expect(t.link.wakes[3]!.digest.chapter?.id).toBe('second-idea');
    expect(t.link.wakes[3]!.firstOfChapter).toBe(true);
  });

  it('counts a thrown wake as a failed one', async () => {
    const t = setup();
    t.link.wake = async () => {
      throw new Error('the process died');
    };
    t.owner(note('m1', 'x'));
    t.clock.advance(QUIET_SHORT);
    await flush();
    expect(t.presence.get().note).toMatch(/the process died/);
    expect(t.clock.pending).toBe(1);
  });
});

describe('the presence pill during a wake', () => {
  it('says drawing, "reading your marks", the moment a wake starts, and listening when it ends', async () => {
    const t = setup();
    t.owner(note('m1', 'one engine'));
    expect(t.presence.get().state).toBe('listening');
    t.clock.advance(QUIET_SHORT);
    expect(t.link.wakes).toHaveLength(1);
    expect(t.presence.get()).toMatchObject({ state: 'drawing', note: 'reading your marks' });
    t.link.finish();
    await flush();
    expect(t.presence.get()).toEqual({ state: 'listening', since: expect.any(String) });
  });

  it('goes back to building after a wake during a build', async () => {
    const t = setup();
    t.presence.set({ state: 'building', note: 'the door' });
    t.owner(note('m1', 'while you build'));
    t.clock.advance(QUIET_SHORT);
    expect(t.presence.get()).toMatchObject({ state: 'drawing', note: 'reading your marks' });
    t.link.finish();
    await flush();
    expect(t.presence.get().state).toBe('building');
  });

  it('keeps what the agent said during its turn', async () => {
    const t = setup();
    t.owner(note('m1', 'x'));
    t.clock.advance(QUIET_SHORT);
    t.presence.set({ state: 'waiting', note: 'for your go' });
    t.link.finish();
    await flush();
    expect(t.presence.get()).toMatchObject({ state: 'waiting', note: 'for your go' });
  });

  it('hands the pill to the build when a wake ends, and not to a build that ended during it', async () => {
    const t = setup();
    let building: { state: 'building'; note: string } | undefined = { state: 'building', note: 'The door (part 1 of 3)' };
    const s = new WakeScheduler({ link: t.link, state: () => t.board.state, presence: t.presence, clock: t.clock, resting: () => building });
    t.board.subscribe((events) => s.notify(events));
    t.scheduler.close();

    t.presence.set(building);
    t.owner(note('m1', 'while you build'));
    t.clock.advance(QUIET_SHORT);
    expect(t.presence.get()).toMatchObject({ state: 'drawing', note: 'reading your marks' });
    // The agent says it listens at the end of its turn. The build still runs, so the pill shows the build.
    t.presence.set({ state: 'listening' });
    t.link.finish();
    await flush();
    expect(t.presence.get()).toMatchObject({ state: 'building', note: 'The door (part 1 of 3)' });

    // The build ends during the next wake: the pill goes back to listening, not to building.
    t.owner(note('m2', 'and this'));
    t.clock.advance(QUIET_SHORT);
    building = undefined;
    t.link.finish();
    await flush();
    expect(t.presence.get().state).toBe('listening');
  });

  it('shows the reason a wake failed, as one plain line', async () => {
    const t = setup();
    t.link.auto = { ok: false, note: 'claude exited\u001b[2J with code 1\nsee the log' };
    t.owner(note('m1', 'x'));
    t.clock.advance(QUIET_SHORT);
    await flush();
    expect(t.presence.get()).toMatchObject({ state: 'away', note: 'the agent did not answer: claude exited[2J with code 1 see the log' });
  });
});

describe('quietAfter', () => {
  const ev = (by: string, rest: Record<string, unknown>) => ({ id: 'e9', at: '2026-11-17T13:00:00Z', by, ...rest }) as unknown as BoardEvent;
  const add = (kind: string, by = 'owner') => ev(by, { type: 'item.add', chapter: CH, item: { id: 'x', kind } });

  it('waits long after strokes and short after closed input', () => {
    for (const kind of ['ink', 'box', 'arrow', 'pin']) expect(quietAfter(add(kind)), kind).toBe(QUIET_LONG);
    // A lasso is the owner holding things together: never open, it wakes nobody.
    expect(quietAfter(add('lasso'))).toBeUndefined();
    for (const kind of ['note', 'voice', 'file']) expect(quietAfter(add(kind)), kind).toBe(QUIET_SHORT);
    for (const type of ['solidify', 'build.start', 'build.pause', 'build.resume', 'choice.pick', 'ask']) {
      expect(quietAfter(ev('owner', { type })), type).toBe(QUIET_SHORT);
    }
    // The owner's own change to a part is input too. The builder's is not.
    expect(quietAfter(ev('owner', { type: 'part.state', part: 'door', state: 'idea' }))).toBe(QUIET_SHORT);
    expect(quietAfter(ev('agent', { type: 'part.state', part: 'door', state: 'building' }))).toBeUndefined();
    expect(quietAfter(ev('system', { type: 'part.state', part: 'door', state: 'built' }))).toBeUndefined();
  });

  it('ignores what is not the owner\'s input', () => {
    expect(quietAfter(add('picture', 'agent'))).toBeUndefined();
    expect(quietAfter(add('note', 'system'))).toBeUndefined();
    expect(quietAfter(ev('owner', { type: 'item.update', item: 'x', patch: { box: [0, 0, 1, 1] } }))).toBeUndefined();
    expect(quietAfter(ev('owner', { type: 'item.remove', item: 'x' }))).toBeUndefined();
    expect(quietAfter(ev('owner', { type: 'chapter.open', chapter: CH, title: 't' }))).toBeUndefined();
  });
});
