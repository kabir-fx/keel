import { afterEach, describe, expect, it } from 'vitest';
import type { BoardEvent, BoardState, ForeignRange } from '@keel/protocol';
import { digest } from '@keel/protocol';
import { Board } from '../src/board';
import { PresenceHub } from '../src/presence';
import { QUIET_LONG, QUIET_SHORT, WAKE_PRESENCE, WAKE_TIMEOUT, WakeScheduler, inputOf, wakePresence } from '../src/wake';
import { CH, FakeClock, FakeLink, chapter, flush, ink, note, tempRepo } from './helpers';

const boards: Board[] = [];
afterEach(() => {
  for (const b of boards.splice(0)) b.close();
});

/** A board, its scheduler, and what it needs. `foreign` says which events came with the log from outside. */
function setup(opts: { foreign?: () => readonly ForeignRange[] | undefined; onHold?: (by: 'drawing' | 'owner' | undefined) => void } = {}) {
  const board = Board.open(tempRepo());
  boards.push(board);
  board.post([chapter()], 'owner');
  const clock = new FakeClock();
  const link = new FakeLink();
  const presence = new PresenceHub({ state: 'listening' });
  const scheduler = new WakeScheduler({ link, state: () => board.state, presence, clock, ...opts });
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

const box = (id: string, text?: string) => ({ type: 'item.add', chapter: CH, item: { id, kind: 'box', box: [0, 0, 160, 80], ...(text ? { text } : {}) } });
const file = (id: string) => ({ type: 'item.add', chapter: CH, item: { id, kind: 'file', box: [0, 0, 340, 60], name: 'shot.png', asset: 'assets/shot.png', mime: 'image/png' } });
const arrow = (id: string) => ({ type: 'item.add', chapter: CH, item: { id, kind: 'arrow', box: [0, 0, 100, 10], from: [0, 5], to: [100, 5] } });

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

describe('holding while the owner draws', () => {
  /** An agent's picture on the board, answering an earlier note, with nothing open after it. */
  function withPicture(t: ReturnType<typeof setup>) {
    t.board.post([note('n0', 'earlier')], 'owner');
    t.agent({ type: 'item.add', chapter: CH, item: { id: 'p1', kind: 'picture', picture: { kind: 'text', title: 'Earlier' }, answers: ['n0'] } });
    t.clock.advance(QUIET_SHORT);
    expect(t.link.wakes).toHaveLength(0);
  }
  const onPicture = { anchor: { item: 'p1', box: [0, 0, 300, 200] } };

  it('a lone box holds at once, and never wakes however long', () => {
    const held: Array<string | undefined> = [];
    const t = setup({ onHold: (by) => held.push(by) });
    t.owner(box('b1', 'one engine'));
    expect(t.scheduler.holding).toBe('drawing');
    expect(held).toEqual(['drawing']);
    t.clock.advance(60 * 60_000);
    expect(t.link.wakes).toHaveLength(0);
    expect(t.scheduler.holding).toBe('drawing');
    expect(t.clock.pending).toBe(0);
  });

  it('a lone arrow on bare board holds as well', () => {
    const t = setup();
    t.owner(arrow('a1'));
    expect(t.scheduler.holding).toBe('drawing');
    t.clock.advance(60_000);
    expect(t.link.wakes).toHaveLength(0);
  });

  it('a note during a drawing hold ends it, and wakes after 300 ms with every mark in one digest', () => {
    const held: Array<string | undefined> = [];
    const t = setup({ onHold: (by) => held.push(by) });
    t.owner(box('b1'));
    t.owner(box('b2'));
    t.owner(arrow('a1'));
    t.owner(ink('m1'));
    t.clock.advance(5000);
    expect(t.link.wakes).toHaveLength(0);
    t.owner(note('n1', 'this is the flow'));
    expect(t.scheduler.holding).toBeUndefined();
    expect(held).toEqual(['drawing', undefined]);
    t.clock.advance(QUIET_SHORT - 1);
    expect(t.link.wakes).toHaveLength(0);
    t.clock.advance(1);
    expect(t.link.wakes).toHaveLength(1);
    expect(freshIds(t.link.wakes[0]!)).toEqual(['b1', 'b2', 'a1', 'm1', 'n1']);
  });

  it('an act and an edit of a note\'s words end a drawing hold too', () => {
    const t = setup();
    t.owner(box('b1'));
    t.owner({ type: 'solidify', chapter: CH, picks: [], parts: [] });
    expect(t.scheduler.holding).toBeUndefined();
    t.clock.advance(QUIET_SHORT);
    expect(t.link.wakes).toHaveLength(1);

    const u = setup();
    u.board.post([note('n1', 'first words')], 'owner');
    u.owner(box('b1'));
    expect(u.scheduler.holding).toBe('drawing');
    u.owner({ type: 'item.update', item: 'n1', patch: { text: 'other words' } });
    expect(u.scheduler.holding).toBeUndefined();
    u.clock.advance(QUIET_SHORT);
    expect(u.link.wakes).toHaveLength(1);
    expect(freshIds(u.link.wakes[0]!)).toEqual(['b1', 'n1']);
  });

  it('Answer now ends a drawing hold with one wake at once', () => {
    const t = setup();
    t.owner(box('b1'));
    t.owner(arrow('a1'));
    t.clock.advance(30_000);
    t.scheduler.release();
    expect(t.scheduler.holding).toBeUndefined();
    expect(t.link.wakes).toHaveLength(1);
    expect(freshIds(t.link.wakes[0]!)).toEqual(['b1', 'a1']);
  });

  it('a box drawn on one of the agent\'s pictures is a remark: it wakes after 1500 ms, and holds nothing', () => {
    const t = setup();
    withPicture(t);
    t.owner({ ...box('b1', 'why this?'), item: { ...box('b1', 'why this?').item, ...onPicture } });
    expect(t.scheduler.holding).toBeUndefined();
    t.clock.advance(QUIET_LONG - 1);
    expect(t.link.wakes).toHaveLength(0);
    t.clock.advance(1);
    expect(t.link.wakes).toHaveLength(1);
    expect(freshIds(t.link.wakes[0]!)).toEqual(['b1']);
  });

  it('an arrow with one end on one of the agent\'s pictures is a remark too', () => {
    const u = setup();
    withPicture(u);
    u.owner({ ...arrow('a1'), item: { ...arrow('a1').item, toTarget: { item: 'p1' } } });
    expect(u.scheduler.holding).toBeUndefined();
    u.clock.advance(QUIET_LONG - 1);
    expect(u.link.wakes).toHaveLength(0);
    u.clock.advance(1);
    expect(u.link.wakes).toHaveLength(1);
  });

  it('an arrow between two of the owner\'s boxes is the owner\'s drawing: it holds', async () => {
    const t = setup();
    t.owner(box('b1'), box('b2'));
    t.scheduler.release();
    t.agent({ type: 'answer', answers: ['b1', 'b2'], read: 'Two steps.' });
    t.link.finish();
    await flush();
    expect(t.scheduler.holding).toBeUndefined();
    t.owner({ ...arrow('a1'), item: { ...arrow('a1').item, fromTarget: { item: 'b1' }, toTarget: { item: 'b2' } } });
    expect(t.scheduler.holding).toBe('drawing');
    t.clock.advance(60_000);
    expect(t.link.wakes).toHaveLength(1);
  });

  it('a box tied to one of the owner\'s own marks is the owner\'s drawing: it holds', () => {
    const t = setup();
    t.board.post([box('b1')], 'owner');
    t.scheduler.release();
    t.owner({ ...box('b2'), item: { ...box('b2').item, anchor: { item: 'b1', box: [0, 0, 160, 80] } } });
    expect(t.scheduler.holding).toBe('drawing');
  });

  it('ink and a pin with no hold on wake after 1500 ms', () => {
    const t = setup();
    t.owner({ type: 'item.add', chapter: CH, item: { id: 'p9', kind: 'pin', box: [0, 0, 10, 10], at: [5, 5] } });
    expect(t.scheduler.holding).toBeUndefined();
    t.clock.advance(QUIET_LONG - 1);
    expect(t.link.wakes).toHaveLength(0);
    t.clock.advance(1);
    expect(t.link.wakes).toHaveLength(1);
  });

  it('ink and a pin during a hold wake nobody', () => {
    const t = setup();
    t.owner(box('b1'));
    t.owner(ink('m1'));
    t.owner({ type: 'item.add', chapter: CH, item: { id: 'p9', kind: 'pin', box: [0, 0, 10, 10], at: [5, 5] } });
    t.clock.advance(10 * 60_000);
    expect(t.link.wakes).toHaveLength(0);
    expect(t.scheduler.holding).toBe('drawing');
  });

  it('a box on an agent\'s picture during a hold wakes nobody either', () => {
    const t = setup();
    withPicture(t);
    t.owner(box('b1'));
    t.owner({ ...box('b2'), item: { ...box('b2').item, ...onPicture } });
    t.clock.advance(10 * 60_000);
    expect(t.link.wakes).toHaveLength(0);
    expect(t.scheduler.holding).toBe('drawing');
  });

  it('an ink stroke waiting for quiet waits on through a box that starts a hold', () => {
    const t = setup();
    t.owner(ink('m1'));
    t.clock.advance(1000);
    t.owner(box('b1'));
    t.clock.advance(60_000);
    expect(t.link.wakes).toHaveLength(0);
    t.scheduler.release();
    expect(freshIds(t.link.wakes[0]!)).toEqual(['m1', 'b1']);
  });

  it('a move, a resize or a removal during a hold wakes nobody and ends nothing', () => {
    const t = setup();
    t.owner(box('b1'));
    t.owner(box('b2'));
    t.owner({ type: 'item.update', item: 'b1', patch: { box: [40, 40, 160, 80] } });
    t.owner({ type: 'item.remove', item: 'b2' });
    t.clock.advance(10 * 60_000);
    expect(t.link.wakes).toHaveLength(0);
    expect(t.scheduler.holding).toBe('drawing');
  });

  it('an edit of a box\'s label never ends a hold', () => {
    const t = setup();
    t.owner(box('b1', 'first'));
    t.owner({ type: 'item.update', item: 'b1', patch: { text: 'first, renamed' } });
    expect(t.scheduler.holding).toBe('drawing');
    t.clock.advance(10 * 60_000);
    expect(t.link.wakes).toHaveLength(0);
  });

  it('an edit of a box\'s label with no hold on is work on the drawing: it holds, and wakes nobody', async () => {
    const t = setup();
    t.owner(box('b1', 'first'));
    t.scheduler.release();
    t.agent({ type: 'answer', answers: ['b1'], read: 'One step.' });
    t.link.finish();
    await flush();
    expect(t.scheduler.holding).toBeUndefined();
    t.owner({ type: 'item.update', item: 'b1', patch: { text: 'first, renamed' } });
    expect(t.scheduler.holding).toBe('drawing');
    t.clock.advance(10 * 60_000);
    expect(t.link.wakes).toHaveLength(1);
    t.scheduler.release();
    expect(t.link.wakes).toHaveLength(2);
    expect(freshIds(t.link.wakes[1]!)).toEqual(['b1']);
  });

  it('an edit of the label of a box on one of the agent\'s pictures is a remark: it wakes after 1500 ms', async () => {
    const t = setup();
    withPicture(t);
    t.owner({ ...box('b1', 'why this?'), item: { ...box('b1', 'why this?').item, ...onPicture } });
    t.clock.advance(QUIET_LONG);
    t.agent({ type: 'answer', answers: ['b1'], read: 'Because.' });
    t.link.finish();
    await flush();
    t.owner({ type: 'item.update', item: 'b1', patch: { text: 'why not that?' } });
    expect(t.scheduler.holding).toBeUndefined();
    t.clock.advance(QUIET_LONG - 1);
    expect(t.link.wakes).toHaveLength(1);
    t.clock.advance(1);
    expect(t.link.wakes).toHaveLength(2);
  });

  it('a file dropped in during a hold is part of the drawing: it ends nothing, and wakes nobody', () => {
    const t = setup();
    t.owner(box('b1'));
    t.owner(file('f1'));
    expect(t.scheduler.holding).toBe('drawing');
    t.clock.advance(10 * 60_000);
    expect(t.link.wakes).toHaveLength(0);
    t.scheduler.release();
    expect(freshIds(t.link.wakes[0]!)).toEqual(['b1', 'f1']);

    const u = setup();
    u.scheduler.hold();
    u.owner(file('f1'));
    u.clock.advance(10 * 60_000);
    expect(u.scheduler.holding).toBe('owner');
    expect(u.link.wakes).toHaveLength(0);
  });

  it('a file dropped in with no hold on wakes after 300 ms, as before', () => {
    const t = setup();
    t.owner(file('f1'));
    t.clock.advance(QUIET_SHORT - 1);
    expect(t.link.wakes).toHaveLength(0);
    t.clock.advance(1);
    expect(t.link.wakes).toHaveLength(1);
  });

  it('an owner hold never wakes for shapes, however long, and release wakes at once', () => {
    const t = setup();
    t.scheduler.hold();
    expect(t.scheduler.holding).toBe('owner');
    t.owner(box('b1'));
    expect(t.scheduler.holding).toBe('owner');
    t.clock.advance(10 * 60_000);
    t.owner(arrow('a1'));
    t.owner(ink('m1'));
    t.owner({ type: 'item.add', chapter: CH, item: { id: 'p9', kind: 'pin', box: [0, 0, 10, 10], at: [5, 5] } });
    t.clock.advance(10 * 60_000);
    expect(t.link.wakes).toHaveLength(0);
    expect(t.scheduler.holding).toBe('owner');
    t.scheduler.release();
    expect(t.scheduler.holding).toBeUndefined();
    expect(t.link.wakes).toHaveLength(1);
    expect(freshIds(t.link.wakes[0]!)).toEqual(['b1', 'a1', 'm1', 'p9']);
  });

  it('an owner hold stops a wake that was waiting for quiet', () => {
    const t = setup();
    t.owner(ink('m1'));
    t.clock.advance(1000);
    t.scheduler.hold();
    t.clock.advance(60_000);
    expect(t.link.wakes).toHaveLength(0);
  });

  it('words end an owner hold', () => {
    const t = setup();
    t.scheduler.hold();
    t.owner(box('b1'));
    t.owner(note('n1', 'what do you think?'));
    expect(t.scheduler.holding).toBeUndefined();
    t.clock.advance(QUIET_SHORT);
    expect(t.link.wakes).toHaveLength(1);
    expect(freshIds(t.link.wakes[0]!)).toEqual(['b1', 'n1']);
  });

  it('a hold started during a wake lets that wake finish, and holds the next', async () => {
    const t = setup();
    t.owner(note('n1', 'first'));
    t.clock.advance(QUIET_SHORT);
    expect(t.link.wakes).toHaveLength(1);
    t.owner(ink('m1'));
    t.clock.advance(QUIET_LONG);
    t.owner(box('b1'));
    expect(t.scheduler.holding).toBe('drawing');
    t.agent({ type: 'answer', answers: ['n1'], read: 'Read.' });
    t.link.finish();
    await flush();
    expect(t.link.wakes).toHaveLength(1);
    expect(t.presence.get().state).toBe('listening');
    t.scheduler.release();
    expect(t.link.wakes).toHaveLength(2);
    expect(freshIds(t.link.wakes[1]!)).toEqual(['m1', 'b1']);
  });

  it('a failed wake is not retried through a hold', async () => {
    const t = setup();
    t.link.auto = { ok: false, note: 'no session' };
    t.owner(note('n1', 'anyone there?'));
    t.clock.advance(QUIET_SHORT);
    await flush();
    expect(t.link.wakes).toHaveLength(1);
    t.owner(box('b1'));
    expect(t.scheduler.holding).toBe('drawing');
    t.clock.advance(60_000);
    await flush();
    expect(t.link.wakes).toHaveLength(1);
    t.link.auto = { ok: true };
    t.scheduler.release();
    await flush();
    expect(t.link.wakes).toHaveLength(2);
  });

  it('release with nothing open wakes nobody', () => {
    const t = setup();
    t.scheduler.hold();
    t.scheduler.release();
    expect(t.scheduler.holding).toBeUndefined();
    expect(t.link.wakes).toHaveLength(0);
  });

  describe('at start', () => {
    /** A second scheduler over the same board, as after a restart. */
    function restart(t: ReturnType<typeof setup>, onHold?: (by: 'drawing' | 'owner' | undefined) => void) {
      t.scheduler.close();
      t.link.wakes.length = 0;
      return new WakeScheduler({ link: t.link, state: () => t.board.state, presence: t.presence, clock: t.clock, ...(onHold ? { onHold } : {}) });
    }

    it('with only the owner\'s own shapes open, it begins held and wakes nobody', () => {
      const t = setup();
      t.owner(box('b1'), arrow('a1'));
      const held: Array<string | undefined> = [];
      const s = restart(t, (by) => held.push(by));
      s.start();
      expect(s.holding).toBe('drawing');
      expect(held).toEqual(['drawing']);
      t.clock.advance(60_000);
      expect(t.link.wakes).toHaveLength(0);
      s.release();
      expect(t.link.wakes).toHaveLength(1);
      expect(t.link.wakes[0]!.digest.open.map((o) => o.id)).toEqual(['b1', 'a1']);
    });

    it('with a note open as well, it wakes', () => {
      const t = setup();
      t.owner(box('b1'), note('n1', 'and this'));
      const s = restart(t);
      s.start();
      expect(s.holding).toBeUndefined();
      expect(t.link.wakes).toHaveLength(1);
      expect(t.link.wakes[0]!.reason).toBe('start');
    });

    it('with a box on one of the agent\'s pictures open, it wakes', () => {
      const t = setup();
      withPicture(t);
      t.owner({ ...box('b1'), item: { ...box('b1').item, ...onPicture } });
      const s = restart(t);
      s.start();
      expect(s.holding).toBeUndefined();
      expect(t.link.wakes).toHaveLength(1);
    });

    it('a shape that came with the log from outside is passed over: with nothing of the owner\'s open, it neither holds nor wakes', () => {
      let outside: ForeignRange[] | undefined;
      const t = setup({ foreign: () => outside });
      const [x] = t.owner(box('x1'));
      const n = Number(x!.id.slice(1));
      outside = [{ from: n, to: n }];
      t.scheduler.close();
      t.link.wakes.length = 0;
      const s = new WakeScheduler({ link: t.link, state: () => t.board.state, presence: t.presence, clock: t.clock, foreign: () => outside });
      s.start();
      expect(s.holding).toBeUndefined();
      expect(t.link.wakes).toHaveLength(0);
    });
  });
});

describe('the presence pill during a wake', () => {
  it('says drawing, "reading your marks", busy reading, the moment a wake starts, and listening when it ends', async () => {
    const t = setup();
    t.owner(note('m1', 'one engine'));
    expect(t.presence.get().state).toBe('listening');
    t.clock.advance(QUIET_SHORT);
    expect(t.link.wakes).toHaveLength(1);
    expect(t.presence.get()).toMatchObject({ state: 'drawing', note: 'reading your marks', doing: 'reading' });
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

describe('where the agent’s cursor is during a wake', () => {
  it('a note wakes the agent with its cursor on that note, and the pill’s words as before', () => {
    const t = setup();
    t.owner(note('m1', 'one engine'));
    t.clock.advance(QUIET_SHORT);
    expect(t.presence.get()).toEqual({ ...WAKE_PRESENCE, cursor: { item: 'm1' }, since: expect.any(String) });
  });

  it('with several fresh marks, the cursor goes to the newest', async () => {
    const t = setup();
    t.owner(ink('m1'));
    t.clock.advance(1000);
    t.owner(ink('m2'));
    t.clock.advance(1000);
    t.owner(note('m3', 'and this'));
    t.clock.advance(QUIET_SHORT);
    expect(t.presence.get().cursor).toEqual({ item: 'm3' });

    // The next wake: m1 to m3 are still open but not fresh, and the newest fresh one is m4.
    t.owner(ink('m4'));
    t.link.finish();
    await flush();
    t.clock.advance(QUIET_LONG);
    expect(t.link.wakes).toHaveLength(2);
    expect(t.presence.get().cursor).toEqual({ item: 'm4' });
  });

  it('an act is not on the board: a wake for an act alone gives the cursor no place', () => {
    const t = setup();
    t.owner({ type: 'solidify', chapter: CH, picks: [], parts: [] });
    t.clock.advance(QUIET_SHORT);
    expect(t.link.wakes[0]!.reason).toBe('act');
    expect(t.presence.get()).toEqual({ ...WAKE_PRESENCE, since: expect.any(String) });
  });

  describe('a solidify names the lasso it was made from', () => {
    const lasso = (id: string, targets: unknown[]) => ({ type: 'item.add', chapter: CH, item: { id, kind: 'lasso', box: [0, 0, 400, 200], path: [0, 0, 400, 0, 400, 200], targets } });

    it('with its lasso on the board, the cursor goes on the lasso, though the mark in it is fresh too', () => {
      const t = setup();
      t.owner(note('m1', 'this one'));
      t.owner(lasso('l1', [{ item: 'm1' }]));
      t.owner({ type: 'solidify', chapter: CH, picks: ['m1'], parts: [], lasso: 'l1' });
      t.clock.advance(QUIET_SHORT);
      expect(t.link.wakes[0]!.reason).toBe('act');
      expect(t.presence.get()).toEqual({ ...WAKE_PRESENCE, cursor: { item: 'l1' }, since: expect.any(String) });
    });

    it('with its lasso gone, no place', () => {
      const t = setup();
      t.owner(lasso('l1', []));
      t.owner({ type: 'solidify', chapter: CH, picks: [], parts: [], lasso: 'l1' });
      t.owner({ type: 'item.remove', item: 'l1' });
      const state = t.board.state;
      expect(wakePresence(digest(state), state)).toEqual(WAKE_PRESENCE);
    });

    it('a fresh mark made after it is newer: the cursor goes to the mark', () => {
      const t = setup();
      t.owner(note('m1', 'this one'));
      t.owner(lasso('l1', [{ item: 'm1' }]));
      t.owner({ type: 'solidify', chapter: CH, picks: ['m1'], parts: [], lasso: 'l1' });
      t.owner(note('m2', 'and this'));
      t.clock.advance(QUIET_SHORT);
      expect(t.presence.get()).toEqual({ ...WAKE_PRESENCE, cursor: { item: 'm2' }, since: expect.any(String) });
    });
  });

  it('a mark and an act in one pause: the cursor goes to the mark, though the act came after it', () => {
    const t = setup();
    t.owner(note('m1', 'this one'));
    t.owner({ type: 'solidify', chapter: CH, picks: [], parts: [] });
    t.clock.advance(QUIET_SHORT);
    expect(t.link.wakes[0]!.reason).toBe('act');
    expect(t.presence.get()).toEqual({ ...WAKE_PRESENCE, cursor: { item: 'm1' }, since: expect.any(String) });
  });

  it('a mark that came with the log from outside is not where the agent reads: the cursor goes to the owner\'s, or nowhere', () => {
    let outside: ForeignRange[] | undefined;
    const t = setup({ foreign: () => outside });
    t.owner(note('m1', 'mine'));
    const [x] = t.owner(note('x1', 'from another machine'));
    const n = Number(x!.id.slice(1));
    outside = [{ from: n, to: n }];
    t.clock.advance(QUIET_SHORT);
    expect(t.link.wakes).toHaveLength(1);
    expect(t.presence.get()).toEqual({ ...WAKE_PRESENCE, cursor: { item: 'm1' }, since: expect.any(String) });

    // Fresh, open and newest, but only the one from outside: no place.
    const lone = setup();
    const [y] = lone.owner(note('x2', 'from another machine'));
    const m = Number(y!.id.slice(1));
    const state = lone.board.state;
    expect(wakePresence(digest(state, { foreign: [{ from: m, to: m }] }), state)).toEqual(WAKE_PRESENCE);
  });

  it('when the wake ends, the pill goes back to listening as before, naming no place', async () => {
    const t = setup();
    t.owner(note('m1', 'one engine'));
    t.clock.advance(QUIET_SHORT);
    t.link.finish();
    await flush();
    expect(t.presence.get()).toEqual({ state: 'listening', since: expect.any(String) });
  });
});

describe('inputOf', () => {
  const ev = (by: string, rest: Record<string, unknown>) => ({ id: 'e9', at: '2026-11-17T13:00:00Z', by, ...rest }) as unknown as BoardEvent;
  const add = (kind: string, by = 'owner') => ev(by, { type: 'item.add', chapter: CH, item: { id: 'x', kind } });
  const state = (kind: string) => ({ items: { x: { item: { id: 'x', kind } } } }) as unknown as BoardState;
  const none = state('note');

  it('sorts the owner\'s input into words, files, shapes and marks', () => {
    for (const kind of ['box', 'arrow']) expect(inputOf(add(kind), none), kind).toBe('shape');
    for (const kind of ['ink', 'pin']) expect(inputOf(add(kind), none), kind).toBe('mark');
    // A lasso is the owner holding things together: never open, it wakes nobody.
    expect(inputOf(add('lasso'), none)).toBeUndefined();
    for (const kind of ['note', 'voice']) expect(inputOf(add(kind), none), kind).toBe('words');
    expect(inputOf(add('file'), none)).toBe('file');
    for (const type of ['solidify', 'build.start', 'build.pause', 'build.resume', 'choice.pick', 'ask']) {
      expect(inputOf(ev('owner', { type }), none), type).toBe('words');
    }
    // The owner's own change to a part is input too. The builder's is not.
    expect(inputOf(ev('owner', { type: 'part.state', part: 'door', state: 'idea' }), none)).toBe('words');
    expect(inputOf(ev('agent', { type: 'part.state', part: 'door', state: 'building' }), none)).toBeUndefined();
    expect(inputOf(ev('system', { type: 'part.state', part: 'door', state: 'built' }), none)).toBeUndefined();
    // Editing a note's words is a remark. Editing the label of a box or an arrow of the owner's own is work on the drawing, as a new one is.
    const edit = ev('owner', { type: 'item.update', item: 'x', patch: { text: 'new words' } });
    expect(inputOf(edit, state('note'))).toBe('words');
    expect(inputOf(edit, state('box'))).toBe('shape');
    expect(inputOf(edit, state('arrow'))).toBe('shape');
    // A move, a resize or a removal is no input: it wakes nobody, and ends nothing.
    expect(inputOf(ev('owner', { type: 'item.update', item: 'x', patch: { box: [0, 0, 1, 1] } }), none)).toBeUndefined();
    expect(inputOf(ev('owner', { type: 'item.remove', item: 'x' }), none)).toBeUndefined();
  });

  it('a box or an arrow on one of the agent\'s pictures is a mark; on bare board or on the owner\'s own marks, a shape', () => {
    const items = (byP: string) =>
      ({
        items: {
          p: { by: byP, item: { id: 'p', kind: 'picture' } },
          b: { by: 'owner', item: { id: 'b', kind: 'box' } },
        },
      }) as unknown as BoardState;
    const theirs = items('agent');
    const shape = (item: Record<string, unknown>) => ev('owner', { type: 'item.add', chapter: CH, item: { id: 'x', ...item } });
    expect(inputOf(shape({ kind: 'box', anchor: { item: 'p', box: [0, 0, 1, 1] } }), theirs)).toBe('mark');
    expect(inputOf(shape({ kind: 'arrow', fromTarget: { item: 'p', sub: 'part:door' } }), theirs)).toBe('mark');
    expect(inputOf(shape({ kind: 'arrow', fromTarget: { item: 'b' }, toTarget: { item: 'p' } }), theirs)).toBe('mark');
    expect(inputOf(shape({ kind: 'box', anchor: { item: 'b', box: [0, 0, 1, 1] } }), theirs)).toBe('shape');
    expect(inputOf(shape({ kind: 'arrow', fromTarget: { item: 'b' }, toTarget: { item: 'b' } }), theirs)).toBe('shape');
    expect(inputOf(shape({ kind: 'arrow', toTarget: { item: 'gone' } }), theirs)).toBe('shape');
    // A change of the label of a box that is on the agent's picture is a mark too.
    const onTheirs = { items: { ...theirs.items, x: { by: 'owner', item: { id: 'x', kind: 'box', anchor: { item: 'p', box: [0, 0, 1, 1] } } } } } as unknown as BoardState;
    expect(inputOf(ev('owner', { type: 'item.update', item: 'x', patch: { text: 'new words' } }), onTheirs)).toBe('mark');
    // The owner's own picture, should there be one, is the owner's drawing.
    expect(inputOf(shape({ kind: 'box', anchor: { item: 'p', box: [0, 0, 1, 1] } }), items('owner'))).toBe('shape');
  });

  it('ignores what is not the owner\'s input', () => {
    expect(inputOf(add('picture', 'agent'), none)).toBeUndefined();
    expect(inputOf(add('note', 'system'), none)).toBeUndefined();
    expect(inputOf(ev('owner', { type: 'item.place', item: 'x', box: [0, 0, 1, 1] }), none)).toBeUndefined();
    expect(inputOf(ev('owner', { type: 'chapter.open', chapter: CH, title: 't' }), none)).toBeUndefined();
  });
});
