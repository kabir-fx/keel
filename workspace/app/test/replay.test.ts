import type { Actor, BoardEvent, BoardState, Box } from '@keel/protocol';
import { admit, emptyState } from '@keel/protocol';
import { describe, expect, it } from 'vitest';
import { loadFixture, playRange } from '../src/fixture';
import { FrameLoop, ManualClock } from '../src/frame';
import { frameAt, frameTime } from '../src/replay/page';
import { Player } from '../src/replay/player';
import type { PlayStep } from '../src/replay/script';
import { CALL_BEGINS, CALL_LANDS, KIND_WRITTEN, LEAD, lengthOf, OWNER_GAP, playScript, QUIET_LONG, QUIET_SHORT, TURN_ENDS, WAKE_NOTE, WRITING } from '../src/replay/script';
import { localSource } from '../src/source';

/** A log made by hand, each event at the second it names, counted from the board's opening. */
class Log {
  private state: BoardState = emptyState();
  readonly events: BoardEvent[] = [];
  add(s: number, by: Actor, draft: Record<string, unknown>): BoardEvent {
    const r = admit(this.state, draft, by, new Date(Date.parse('2026-11-20T09:00:00Z') + s * 1000).toISOString());
    if (!r.ok) throw new Error(`refused under ${r.rule}: ${r.reason}`);
    this.state = r.state;
    this.events.push(r.event);
    return r.event;
  }
}

const CH = 'talk';
const note = (id: string, box: Box = [0, 0, 320, 60]) => ({ type: 'item.add' as const, chapter: CH, item: { id, kind: 'note' as const, box, text: `note ${id}` } });
const card = (id: string, extra: Record<string, unknown> = {}) => ({ type: 'item.add', chapter: CH, item: { id, kind: 'picture', picture: { kind: 'text', title: `card ${id}` }, ...extra } });
const place = (id: string, box = [400, 0, 300, 120]) => ({ type: 'item.place', item: id, box });

/** A board opened, a chapter, and a note. */
function opened(): Log {
  const log = new Log();
  log.add(0, 'system', { type: 'board.open', name: 'Talk' });
  log.add(3, 'owner', { type: 'chapter.open', chapter: CH, title: 'A talk' });
  log.add(5, 'owner', note('n1'));
  return log;
}

/** The events of a script, in the order they reach the board. */
const fed = (script: readonly PlayStep[]) => script.flatMap((s) => s.events ?? []).map((e) => e.id);

describe('the script of a play', () => {
  it('wakes the agent after the quiet a note asks for, follows the call as the model writes it, then lands it with its placement', () => {
    const log = opened();
    log.add(9, 'agent', card('c1', { answers: ['n1'] }));
    log.add(9.2, 'owner', place('c1'));
    const [e1, e2, e3, e4, e5] = log.events;
    const owner = LEAD + OWNER_GAP.max;
    const noted = owner + 2000;
    const wake = noted + QUIET_SHORT;
    expect(playScript(log.events)).toEqual([
      { at: LEAD, events: [e1] },
      // Three seconds in the log is more than the owner's longest gap.
      { at: owner, events: [e2] },
      { at: noted, events: [e3] },
      { at: wake, presence: { state: 'drawing', note: WAKE_NOTE, cursor: { item: 'n1' } } },
      { at: wake + CALL_BEGINS, presence: { state: 'drawing', note: 'drawing' } },
      { at: wake + CALL_BEGINS + KIND_WRITTEN, presence: { state: 'drawing', note: 'drawing a card' } },
      { at: wake + WRITING, presence: { state: 'drawing', note: 'drawing a card', cursor: { item: 'n1' } } },
      { at: wake + WRITING + CALL_LANDS, events: [e4, e5] },
      { at: wake + WRITING + CALL_LANDS + TURN_ENDS, presence: { state: 'listening' } },
    ]);
  });

  it('reports every call in the link\'s order, and names no place until the call is whole', () => {
    const log = opened();
    log.add(9, 'agent', card('c1', { answers: ['n1'] }));
    log.add(9.1, 'owner', place('c1'));
    log.add(20, 'agent', { type: 'answer', answers: ['n1'], read: 'You want a card' });
    log.add(30, 'agent', { type: 'item.update', item: 'c1', patch: { picture: { kind: 'mini', title: 'now small', boxes: [{ text: 'a' }, { text: 'b' }] } } });
    const said = playScript(log.events)
      .filter((s) => s.presence && s.presence.note !== WAKE_NOTE && s.presence.state !== 'listening')
      .map((s) => s.presence!);
    expect(said).toEqual([
      { state: 'drawing', note: 'drawing' },
      { state: 'drawing', note: 'drawing a card' },
      { state: 'drawing', note: 'drawing a card', cursor: { item: 'n1' } },
      // Another tool: what it does as it begins, and the place once it is whole.
      { state: 'drawing', note: 'answering' },
      { state: 'drawing', note: 'answering', cursor: { item: 'n1' } },
      // A redraw is a post: it names the kind of its new picture, and sits on the picture.
      { state: 'drawing', note: 'drawing' },
      { state: 'drawing', note: 'drawing a small picture' },
      { state: 'drawing', note: 'drawing a small picture', cursor: { item: 'c1' } },
    ]);
  });

  it('says what the link says of a post that carries a model or a rename, a model call alone and an answer alone', () => {
    const lanes = { type: 'model.patch', ops: [{ op: 'lane.set', lane: { id: 'core', name: 'Core' } }] };
    const log = opened();
    // One post: its model patch first, as the plugin writes it, then its picture.
    log.add(9, 'agent', lanes);
    log.add(9, 'agent', card('c1', { answers: ['n1'] }));
    log.add(9.1, 'owner', place('c1'));
    // One post: its rename first, then its picture.
    log.add(20, 'agent', { type: 'chapter.rename', chapter: CH, title: 'Renamed' });
    log.add(20, 'agent', { type: 'item.update', item: 'c1', patch: { picture: { kind: 'mini', title: 'now small', boxes: [{ text: 'a' }, { text: 'b' }] } } });
    // A model call alone, which answers nothing.
    log.add(30, 'agent', { ...lanes, ops: [{ op: 'lane.set', lane: { id: 'edge', name: 'Edge' } }] });
    // An answer in words alone.
    log.add(40, 'agent', { type: 'answer', answers: ['n1'], read: 'You want a card' });
    const said = playScript(log.events)
      .filter((s) => s.presence && s.presence.note !== WAKE_NOTE && s.presence.state !== 'listening')
      .map((s) => s.presence!);
    expect(said).toEqual([
      // As `toolPresence` reads `{"model": …, "pictures": [{"picture": {"kind": "text"}, "answers": ["n1"]}]}`.
      { state: 'drawing', note: 'drawing' },
      { state: 'drawing', note: 'drawing a card' },
      { state: 'drawing', note: 'drawing a card', cursor: { item: 'n1' } },
      { state: 'drawing', note: 'drawing' },
      { state: 'drawing', note: 'drawing a small picture' },
      { state: 'drawing', note: 'drawing a small picture', cursor: { item: 'c1' } },
      { state: 'drawing', note: 'drawing the model' },
      { state: 'drawing', note: 'drawing the model' },
      { state: 'drawing', note: 'answering' },
      { state: 'drawing', note: 'answering', cursor: { item: 'n1' } },
    ]);
  });

  it('a call takes as long from its start to its landing as the model writes, wherever it starts', () => {
    const log = opened();
    log.add(9, 'agent', card('c1', { answers: ['n1'] }));
    log.add(20, 'agent', { type: 'answer', answers: ['n1'], read: 'You want a card' });
    const script = playScript(log.events);
    const wake = script.find((s) => s.presence?.note === WAKE_NOTE)!.at;
    const landed = script.filter((s) => s.events?.some((e) => e.by === 'agent')).map((s) => s.at);
    expect(landed).toEqual([wake + WRITING + CALL_LANDS, wake + 2 * (WRITING + CALL_LANDS)]);
  });

  it('waits the long quiet after a pin, and an answer in words puts the cursor on the mark it answers', () => {
    const log = opened();
    log.add(6, 'owner', { type: 'item.add', chapter: CH, item: { id: 'p1', kind: 'pin', box: [10, 10, 0, 0], at: [0, 0], text: 'why?' } });
    log.add(12, 'agent', { type: 'answer', answers: ['p1'], read: 'You ask why' });
    const script = playScript(log.events, 3);
    const pinned = script[0]!;
    expect(script[1]).toEqual({ at: pinned.at + QUIET_LONG, presence: { state: 'drawing', note: WAKE_NOTE, cursor: { item: 'p1' } } });
    expect(script[2]!.presence).toEqual({ state: 'drawing', note: 'answering' });
    expect(script[3]!.presence).toEqual({ state: 'drawing', note: 'answering', cursor: { item: 'p1' } });
  });

  it('a placeholder and its finish are two calls of one turn, the second written after the first', () => {
    const log = opened();
    log.add(9, 'agent', card('c1', { answers: ['n1'], status: 'drawing' }));
    log.add(20, 'agent', { type: 'item.update', item: 'c1', patch: { picture: { kind: 'text', title: 'done' }, status: 'done' } });
    log.add(20.1, 'owner', place('c1'));
    const script = playScript(log.events);
    const add = script.find((s) => s.events?.[0]?.id === 'e4')!;
    const finish = script.find((s) => s.events?.[0]?.id === 'e5')!;
    expect(add.events!.map((e) => e.id)).toEqual(['e4']);
    // The finish and its placement land together: the page never sees the finished card without a box.
    expect(finish).toEqual({ at: add.at + WRITING + CALL_LANDS, events: [log.events[4], log.events[5]] });
    const between = script.slice(script.indexOf(add) + 1, script.indexOf(finish)).map((s) => s.presence);
    expect(between).toEqual([
      { state: 'drawing', note: 'drawing' },
      { state: 'drawing', note: 'drawing a card' },
      { state: 'drawing', note: 'drawing a card', cursor: { item: 'c1' } },
    ]);
    expect(script[script.length - 1]).toEqual({ at: finish.at + TURN_ENDS, presence: { state: 'listening' } });
  });

  it('events of the agent logged close together are one call', () => {
    const log = opened();
    log.add(9, 'agent', card('c1', { answers: ['n1'] }));
    log.add(9.1, 'owner', place('c1'));
    log.add(10, 'agent', card('c2', { from: ['c1'] }));
    log.add(10.1, 'owner', place('c2', [400, 200, 300, 120]));
    const script = playScript(log.events);
    const landed = script.filter((s) => s.events?.some((e) => e.by === 'agent'));
    expect(landed).toHaveLength(1);
    expect(landed[0]!.events!.map((e) => e.id)).toEqual(['e4', 'e5', 'e6', 'e7']);
  });

  it('a turn the owner did not start in this range is not woken: its call begins after the lead', () => {
    const log = opened();
    log.add(9, 'agent', card('c1', { answers: ['n1'] }));
    log.add(9.1, 'owner', place('c1'));
    const script = playScript(log.events, 3);
    expect(script.map((s) => s.at)).toEqual([LEAD, LEAD + KIND_WRITTEN, LEAD - CALL_BEGINS + WRITING, LEAD - CALL_BEGINS + WRITING + CALL_LANDS, LEAD - CALL_BEGINS + WRITING + CALL_LANDS + TURN_ENDS]);
    expect(script.some((s) => s.presence?.note === WAKE_NOTE)).toBe(false);
    expect(script[3]!.events).toEqual([log.events[3], log.events[4]]);
  });

  it('plays the system at its own spacing, with no presence of the agent', () => {
    const log = opened();
    log.add(5.1, 'system', { type: 'moment.add', chapter: CH, title: 'A note', items: ['n1'] });
    log.add(60, 'system', { type: 'moment.add', chapter: CH, title: 'Still a note', items: ['n1'] });
    const script = playScript(log.events, 3);
    // The note woke nobody here: no agent came, so no wake is shown.
    expect(script).toEqual([
      { at: LEAD, events: [log.events[3]] },
      { at: LEAD + 1500, events: [log.events[4]] },
    ]);
  });

  it('plays the golden fixture whole: every event once, in order, in time, with each turn of the agent ended', async () => {
    const fx = (await loadFixture('engine-loop'))!;
    const script = playScript(fx.events);
    expect(fed(script)).toEqual(fx.events.map((e) => e.id));
    for (let i = 1; i < script.length; i++) expect(script[i]!.at).toBeGreaterThanOrEqual(script[i - 1]!.at);
    // Every wake reads the owner's marks, and the turn it starts ends listening.
    const said = script.filter((s) => s.presence).map((s) => s.presence!);
    expect(said.filter((p) => p.note === WAKE_NOTE).length).toBeGreaterThan(3);
    expect(said[said.length - 1]).toEqual({ state: 'listening' });
    // The link names no place while a call is written: only the wake and a whole call carry a cursor.
    for (const [i, s] of script.entries()) {
      if (!s.presence?.cursor || s.presence.note === WAKE_NOTE) continue;
      expect(script[i + 1]?.events?.some((e) => e.by === 'agent')).toBe(true);
    }
    // The same log always gives the same script.
    expect(playScript(fx.events)).toEqual(script);
  });

  it('plays one checkpoint of the golden fixture: just the events after the one before', async () => {
    const fx = (await loadFixture('engine-loop'))!;
    const range = playRange(fx, 2);
    const script = playScript(fx.events.slice(0, range.to), range.from);
    expect(fed(script)).toEqual(fx.events.slice(range.from, range.to).map((e) => e.id));
    expect(fed(script)[0]).toBe('e12');
    expect(lengthOf(script)).toBe(script[script.length - 1]!.at);
  });
});

describe('the range of a play', () => {
  it('runs from the checkpoint before to the one asked for, from the start for the first, and the whole log with none', async () => {
    const fx = (await loadFixture('engine-loop'))!;
    const index = (id: string) => fx.events.findIndex((e) => e.id === id);
    const [one, two] = fx.checkpoints;
    expect(playRange(fx, 1)).toEqual({ from: 0, to: index(one!.after) + 1, checkpoint: one });
    expect(playRange(fx, 2)).toEqual({ from: index(one!.after) + 1, to: index(two!.after) + 1, before: one, checkpoint: two });
    expect(playRange(fx, undefined)).toEqual({ from: 0, to: fx.events.length });
    expect(playRange(fx, 99)).toEqual({ from: 0, to: fx.events.length });
  });
});

describe('a board in memory fed a recorded log', () => {
  it('takes the events as recorded, several at once with one notification', () => {
    const log = opened();
    log.add(9, 'agent', card('c1', { answers: ['n1'] }));
    log.add(9.1, 'owner', place('c1'));
    const src = localSource({ events: log.events.slice(0, 3) });
    let heard = 0;
    src.subscribe(() => heard++);
    src.feed(log.events.slice(3));
    expect(heard).toBe(1);
    expect(src.events.slice(3)).toEqual(log.events.slice(3));
    expect(src.state.items.c1).toMatchObject({ by: 'agent', event: 'e4', at: log.events[3]!.at, item: { box: [400, 0, 300, 120] } });
    expect(src.state.seq).toBe(5);
  });

  it('numbers what the page posts during a play after the last recorded event', async () => {
    const log = opened();
    log.add(9, 'agent', card('c1', { answers: ['n1'] }));
    log.add(9.1, 'owner', place('c1'));
    const src = localSource({ events: log.events.slice(0, 3) });
    src.expectRecorded(5);
    const r = await src.post(note('n2', [0, 200, 320, 60]));
    expect(r.ok && r.event.id).toBe('e6');
    src.feed(log.events.slice(3));
    expect(src.events.map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e6', 'e4', 'e5']);
    expect(src.state.items.c1?.item.kind === 'picture' && src.state.items.c1.item.box).toEqual([400, 0, 300, 120]);
    const after = await src.post(note('n3', [0, 400, 320, 60]));
    expect(after.ok && after.event.id).toBe('e9');
  });
});

describe('the player', () => {
  /** A play of the first log above, on a manual clock, moved one frame of 1/60 s at a time. */
  function play() {
    const log = opened();
    log.add(9, 'agent', card('c1', { answers: ['n1'] }));
    log.add(9.1, 'owner', place('c1'));
    const src = localSource({ events: [] });
    const clock = new ManualClock();
    const loop = new FrameLoop(clock, clock.now);
    const player = new Player(src, playScript(log.events));
    player.start(loop);
    let frame = 0;
    const to = (ms: number) => {
      while (frame < frameAt(ms)) clock.advanceTo(frameTime(++frame));
    };
    return { src, clock, player, to };
  }

  it('hands each moment to the board on the first frame at or after its time, and nothing before', () => {
    const { src, player, to } = play();
    to(LEAD - 1);
    expect(src.events).toEqual([]);
    expect(player.takeChanged()).toBe(false);
    to(LEAD);
    expect(src.events.map((e) => e.id)).toEqual(['e1']);
    expect(player.takeChanged()).toBe(true);
    expect(player.takeChanged()).toBe(false);
    const wake = LEAD + OWNER_GAP.max + 2000 + QUIET_SHORT;
    to(wake);
    expect(src.presence).toMatchObject({ state: 'drawing', note: WAKE_NOTE, cursor: { item: 'n1' } });
    to(wake + WRITING + CALL_LANDS);
    expect(src.state.items.c1?.item.kind === 'picture' && src.state.items.c1.item.box).toEqual([400, 0, 300, 120]);
    expect(player.done).toBe(false);
  });

  it('ends with the script and asks for no more frames', () => {
    const { src, clock, player, to } = play();
    to(lengthOf(player.script));
    expect(player.done).toBe(true);
    expect(src.presence.state).toBe('listening');
    expect(player.ms).toBeCloseTo(frameTime(frameAt(lengthOf(player.script))), 6);
    expect(clock.asked).toBe(false);
  });

  it('frames are counted, not added up: frame 15 is 250 ms and frame 60 is 1000 ms', () => {
    expect(frameAt(250)).toBe(15);
    expect(frameTime(15)).toBe(250);
    expect(frameTime(60)).toBe(1000);
    expect(frameAt(1000 / 60 - 0.01)).toBe(0);
  });
});
