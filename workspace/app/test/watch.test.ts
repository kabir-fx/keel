import type { BoardEvent, BoardState } from '@keel/protocol';
import { replay } from '@keel/protocol';
import { describe, expect, it } from 'vitest';
import { cutAt, loadFixture } from '../src/fixture';
import { buildStatus, buildingChapter, clock, feedOf, lastProblem, newsBetween, REMARK_MAX, remarksToBuild, reopenedParts, tabTitle, trackOf } from '../src/watch';
import { Board, note } from './helpers';

/** The golden fixture, up to a checkpoint, or up to an event id. */
async function at(n: number): Promise<{ events: BoardEvent[]; state: BoardState }> {
  const fx = (await loadFixture('engine-loop'))!;
  const { events } = cutAt(fx, n);
  return { events, state: replay(events) };
}
const upTo = (events: readonly BoardEvent[], id: string) => replay(events.slice(0, events.findIndex((e) => e.id === id) + 1));

const CH = 'engine-loop';

/** A board with one chapter building a track of three parts, as a server would hold it. */
function building() {
  const b = new Board();
  b.must('system', { type: 'board.open', name: 'demo' });
  b.must('owner', { type: 'chapter.open', chapter: 'c1', title: 'One engine' });
  b.must('agent', {
    type: 'model.patch',
    chapter: 'c1',
    ops: [
      { op: 'lane.set', lane: { id: 'api', name: 'API' } },
      { op: 'part.set', part: { id: 'door', name: 'The door', lane: 'api' } },
      { op: 'part.set', part: { id: 'queue', name: 'The queue', lane: 'api' } },
      { op: 'part.set', part: { id: 'loop', name: 'The loop', lane: 'api' } },
    ],
  });
  b.must('owner', { type: 'solidify', chapter: 'c1', picks: [], parts: ['door', 'queue', 'loop'] });
  b.must('owner', { type: 'build.start', chapter: 'c1', track: ['door', 'queue', 'loop'], check: 'make check' });
  return b;
}

describe('the build track', () => {
  it('lists the parts in order, each in its state, and says where the build is: part 3 of 7', async () => {
    const { state } = await at(6);
    const t = trackOf(state, CH)!;
    expect(t.parts.map((p) => [p.n, p.name, p.state])).toEqual([
      [1, 'Request', 'built'],
      [2, 'Scheduler', 'built'],
      [3, 'Engine loop', 'building'],
      [4, 'EngineClient', 'solid'],
      [5, 'Try it: 50 fake clients', 'solid'],
      [6, 'Same tokens as mlx-lm', 'solid'],
      [7, 'The roadmap sentence', 'solid'],
    ]);
    expect(t.parts.filter((p) => p.now).map((p) => p.id)).toEqual(['engine-loop']);
    expect(t.parts[0]!.commit).toBe('658b4ec');
    expect([t.built, t.total, t.words]).toEqual([2, 7, 'part 3 of 7']);
  });

  it('between two parts, says the next one; once all are built, says so', async () => {
    const { events } = await at(7);
    // After Request is built and before Scheduler starts.
    expect(trackOf(upTo(events, 'e58'), CH)!.words).toBe('part 2 of 7');
    expect(trackOf(upTo(events, 'e83'), CH)!.words).toBe('7 of 7 built');
    // No track before "Build this".
    expect(trackOf(upTo(events, 'e53'), CH)).toBeUndefined();
  });

  it('a part put off does not count', () => {
    const b = building();
    b.must('system', { type: 'part.state', part: 'door', state: 'building' });
    const t = trackOf(b.state, 'c1')!;
    expect(t.words).toBe('part 1 of 3');
    expect(t.parts.map((p) => p.state)).toEqual(['building', 'solid', 'solid']);
  });
});

describe('the feed', () => {
  it('is the chapter’s entries, newest last, with the time, the words, the commit and the check', async () => {
    const { state } = await at(6);
    const lines = feedOf(state, CH, 'UTC');
    expect(lines[0]).toMatchObject({ kind: 'state', text: 'Build started: 7 parts.', time: '13:20' });
    expect(lines[lines.length - 1]).toMatchObject({ kind: 'update', time: '14:02' });
    expect(lines[lines.length - 1]!.text).toMatch(/^Engine loop: the five things one turn does/);
    const commit = lines.find((l) => l.kind === 'commit' && l.part === 'request')!;
    expect(commit).toMatchObject({ commit: '658b4ec', check: { cmd: 'make check', passed: true }, time: '13:41' });
    // Newest last: the times never go back.
    const times = state.feed.filter((e) => e.chapter === CH).map((e) => e.at);
    expect(times).toEqual([...times].sort());
    expect(lines.map((l) => l.id)).toEqual(state.feed.filter((e) => e.chapter === CH).map((e) => e.id));
  });

  it('leaves out other chapters', async () => {
    const { state } = await at(7);
    const mine = feedOf(state, CH).map((l) => l.id);
    const other = feedOf(state, 'api-server').map((l) => l.id);
    expect(mine.filter((id) => other.includes(id))).toEqual([]);
    expect(mine.length + other.length).toBe(state.feed.length);
    for (const id of other) expect(state.feed.find((e) => e.id === id)!.chapter).toBe('api-server');
  });

  it('a problem is found as the last one', () => {
    const b = building();
    b.must('system', { type: 'feed.add', chapter: 'c1', kind: 'problem', text: 'The check failed.' });
    b.must('system', { type: 'feed.add', chapter: 'c1', kind: 'problem', text: 'The builder stopped.' });
    expect(lastProblem(b.state, 'c1')?.text).toBe('The builder stopped.');
    expect(feedOf(b.state, 'c1').filter((l) => l.kind === 'problem')).toHaveLength(2);
  });

  it('a time is hours and minutes', () => {
    expect(clock('2026-11-17T14:02:09Z', 'UTC')).toBe('14:02');
    expect(clock('not a time')).toBe('');
  });
});

describe('what the build is doing, in plain words', () => {
  it('with no word from the server: running, paused, or waiting for a reopened part', () => {
    const b = building();
    expect(buildStatus(b.state, 'c1')).toMatchObject({ state: 'running', words: 'Building now.' });
    b.must('owner', { type: 'build.pause', chapter: 'c1' });
    expect(buildStatus(b.state, 'c1')).toMatchObject({ state: 'paused', words: 'Paused. Nothing is built while it is paused.' });
    b.must('owner', { type: 'build.resume', chapter: 'c1' });
    b.must('owner', { type: 'part.state', part: 'queue', state: 'idea' });
    expect(reopenedParts(b.state, 'c1')).toEqual(['queue']);
    expect(buildStatus(b.state, 'c1')).toMatchObject({ state: 'waiting' });
    expect(buildStatus(b.state, 'c1')!.words).toBe('Waiting for you: "The queue" is an idea again. Solidify it and the build carries on.');
  });

  it('the server’s word wins: queued, and stopped points at the feed’s last problem', () => {
    const b = building();
    const said = { chapter: 'c1', title: 'One engine', built: 0, total: 3 };
    expect(buildStatus(b.state, 'c1', { ...said, state: 'queued' })!.words).toBe('Waiting its turn: another idea builds first, one build at a time.');
    expect(buildStatus(b.state, 'c1', { ...said, state: 'running', part: 'The door' })!.words).toBe('Building The door now.');
    const p = b.must('system', { type: 'feed.add', chapter: 'c1', kind: 'problem', text: 'The builder failed.' });
    const stopped = buildStatus(b.state, 'c1', { ...said, state: 'stopped' })!;
    expect(stopped).toMatchObject({ state: 'stopped', problem: p.id });
    // The panel offers one press that tries again: the words do not send the owner to Pause and Resume.
    expect(stopped.words).toBe('Stopped before it finished.');
    // The server speaks of another chapter's build: this one is read from the board.
    expect(buildStatus(b.state, 'c1', { ...said, chapter: 'other', state: 'stopped' })!.state).toBe('running');
  });

  it('an app with every part built: the builder starts it once, and when it did not answer, says so', () => {
    const b = new Board();
    b.must('system', { type: 'board.open', name: 'demo' });
    b.must('owner', { type: 'chapter.open', chapter: 'c1', title: 'One engine' });
    b.must('agent', { type: 'model.patch', chapter: 'c1', ops: [{ op: 'lane.set', lane: { id: 'api', name: 'API' } }, { op: 'part.set', part: { id: 'door', name: 'The door', lane: 'api' } }] });
    b.must('owner', { type: 'solidify', chapter: 'c1', picks: [], parts: ['door'] });
    b.must('owner', { type: 'build.start', chapter: 'c1', track: ['door'], check: 'make check', show: { kind: 'app', run: 'npm start' } });
    b.must('system', { type: 'part.state', part: 'door', state: 'building' });
    b.must('system', { type: 'part.state', part: 'door', state: 'built', commit: 'abc1234', check: { cmd: 'make check', passed: true } });
    const said = { chapter: 'c1', title: 'One engine', built: 1, total: 1 };
    expect(buildStatus(b.state, 'c1', { ...said, state: 'running' })!.words).toBe('Every part is built. The builder is starting the app once, as you will try it, to see that it answers.');
    expect(buildStatus(b.state, 'c1')!.words).toBe('Every part is built. The builder is starting the app once, as you will try it, to see that it answers.');
    const p = b.must('system', { type: 'feed.add', chapter: 'c1', kind: 'problem', text: 'The app does not start.' });
    expect(buildStatus(b.state, 'c1', { ...said, state: 'stopped' })).toEqual({ state: 'stopped', words: 'Stopped. Every part is built, and the app did not answer when the builder started it.', problem: p.id });
    b.must('system', { type: 'build.proved', chapter: 'c1' });
    expect(buildStatus(b.state, 'c1')!.state).toBe('built');
  });

  it('a built chapter says so; a chapter that is not building says nothing', async () => {
    const { state } = await at(7);
    expect(buildStatus(state, CH)).toMatchObject({ state: 'built' });
    expect(buildStatus(state, 'api-server')).toBeUndefined();
  });
});

describe('the tab’s title', () => {
  it('leads with the progress while it builds, and says paused, waiting and built', () => {
    const b = building();
    expect(tabTitle('Keel board', b.state, 'c1')).toBe('Building 0/3 · One engine · Keel board');
    b.must('owner', { type: 'build.pause', chapter: 'c1' });
    expect(tabTitle('Keel board', b.state, 'c1')).toBe('Paused 0/3 · One engine · Keel board');
    expect(tabTitle('Keel board', b.state, undefined)).toBe('Keel board');
  });

  it('follows the chapter in view when it builds, else the newest one building', async () => {
    const { state } = await at(7);
    expect(buildingChapter(state, 'api-server')).toBeUndefined();
    expect(buildingChapter(state, CH)).toBe(CH);
    expect(tabTitle('Keel', state, buildingChapter(state, CH))).toBe('Built · The engine loop · Keel');
    const six = (await at(6)).state;
    expect(buildingChapter(six, undefined)).toBe(CH);
  });
});

describe('what needs the owner while the tab is hidden', () => {
  it('a choice the agent made, and the chapter built', async () => {
    const { events } = await at(7);
    const news = newsBetween(upTo(events, 'e67'), upTo(events, 'e69'));
    expect(news.map((n) => [n.kind, n.line])).toEqual([['choice', 'The agent made a choice in "The engine loop". It is yours to change.']]);
    const built = newsBetween(upTo(events, 'e80'), upTo(events, 'e83'));
    expect(built.map((n) => [n.kind, n.line])).toEqual([['built', '"The engine loop" is built.']]);
  });

  it('a problem in the feed, and a decided part reopened while it builds; nothing twice', () => {
    const b = building();
    const before = b.state;
    b.must('system', { type: 'feed.add', chapter: 'c1', kind: 'problem', text: 'The check failed after The door.' });
    b.must('system', { type: 'feed.add', chapter: 'c1', text: 'An update.' });
    b.must('owner', { type: 'part.state', part: 'loop', state: 'idea' });
    const news = newsBetween(before, b.state);
    expect(news.map((n) => n.kind)).toEqual(['problem', 'reopened']);
    // One short plain line each: never the feed's own words, which stay on the board.
    expect(news.map((n) => n.line)).toEqual(['A problem in "One engine". The board says what.', 'The build of "One engine" waits for you.']);
    for (const n of news) expect(n.line).not.toContain('The check failed');
    expect(newsBetween(b.state, b.state)).toEqual([]);
  });
});

describe('an informed agreement: what Resume agrees to on a build not agreed here', () => {
  /** The building board, with the model drawn: the owner pins remarks on its parts. */
  function withPipe() {
    const b = building();
    const start = b.events[b.events.length - 1]!.id;
    b.must('agent', { type: 'item.add', chapter: 'c1', item: { id: 'pipe', kind: 'picture', picture: { kind: 'pipeline', title: 'The model' }, answers: [start] } });
    return b;
  }
  const said = { chapter: 'c1', title: 'One engine', state: 'unagreed' as const, built: 0, total: 3, check: 'make check' };
  const on = (part: string) => ({ on: { item: 'pipe', sub: `part:${part}` } });

  it('lists the remarks on the parts still to build, in the order of the track, each on one line and clipped', () => {
    const b = withPipe();
    const long = `cap it at 64\n\nand ${'x'.repeat(300)}`;
    b.must('owner', note('r-loop', [0, 600, 300, 80], { text: 'one wake-up per turn', ...on('loop') }, 'c1'));
    b.must('owner', note('r-queue', [0, 700, 300, 80], { text: long, ...on('queue') }, 'c1'));
    b.must('owner', note('r-door', [0, 800, 300, 80], { text: 'tell them when to come back', ...on('door') }, 'c1'));
    // The door is built already: what was said on it no longer reaches the builder.
    b.must('system', { type: 'part.state', part: 'door', state: 'building' });
    b.must('system', { type: 'part.state', part: 'door', state: 'built', commit: 'abc1234', check: { cmd: 'make check', passed: true } });
    const s = buildStatus(b.state, 'c1', said)!;
    expect(s.state).toBe('unagreed');
    expect(s.remarks!.map((r) => r.part)).toEqual(['The queue', 'The loop']);
    expect(s.remarks![1]).toEqual({ part: 'The loop', text: 'one wake-up per turn' });
    const q = s.remarks![0]!.text;
    expect(q.length).toBe(REMARK_MAX);
    expect(q.startsWith('cap it at 64 and xxx')).toBe(true);
    expect(q.endsWith('…')).toBe(true);
    expect(q).not.toContain('\n');
    expect(s.words).toContain('you have not pressed "Build this" or Resume for the board as it is now, on this machine');
    expect(s.words).toContain('Resume is your agreement to build what this board says (the parts on the track below, and the remarks on them listed here), and to run this check here after each part:');
    expect(remarksToBuild(b.state, 'c1')).toEqual(s.remarks);
  });

  it('says nothing more when there are no remarks', () => {
    const b = withPipe();
    const s = buildStatus(b.state, 'c1', said)!;
    expect(s.remarks).toBeUndefined();
    expect(s.words).toContain('Resume is your agreement to build what this board says (the parts on the track below), and to run this check here after each part:');
    expect(s.check).toBe('make check');
  });
});
