import type { Box } from '@keel/protocol';
import { admit, replay } from '@keel/protocol';
import { describe, expect, it } from 'vitest';
import { cutAt, loadFixture } from '../src/fixture';
import { NEXT_GAP, chapterProgress, itemWords, mainItems, nextIdeaDrafts, nextIdeaSpot, projectProgress, storyOf, when } from '../src/story';
import { trackOf } from '../src/watch';
import { CH, note, openBoard } from './helpers';

async function seven() {
  const fx = (await loadFixture('engine-loop'))!;
  return replay(cutAt(fx, 7).events);
}

describe('the Story', () => {
  it('lists every chapter newest first, each with its state, its times and its progress', async () => {
    const state = await seven();
    const story = storyOf(state);
    expect(story.map((c) => [c.id, c.title, c.state])).toEqual([
      ['api-server', 'API server', 'idea'],
      ['engine-loop', 'The engine loop', 'built'],
    ]);
    const built = story[1]!;
    expect([built.built, built.total]).toEqual([7, 7]);
    expect(built.openedAt).toBe('2026-11-17T13:00:03Z');
    expect(built.builtAt).toBe('2026-11-17T14:43:00Z');
    expect(built.solidAt).toBe('2026-11-17T13:12:13Z');
    expect([story[0]!.built, story[0]!.total]).toEqual([0, 0]);
  });

  it('gives each chapter its moments, numbered, with the items still on the board', async () => {
    const state = await seven();
    const built = storyOf(state)[1]!;
    expect(built.moments.map((m) => `${m.n} · ${m.title}`)).toEqual([
      '1 · Your note and sketch',
      '2 · Three ways, your marks',
      '3 · The model, one request',
      '4 · The bridge, opened',
      '5 · The blueprint',
      '6 · Built, part by part',
    ]);
    expect(built.moments[4]!.items).toEqual(['blueprint']);
    expect(built.main).toEqual([]);
  });

  it('a chapter with no moment shows its first note and its newest pictures', async () => {
    const state = await seven();
    const idea = storyOf(state)[0]!;
    expect(idea.moments).toEqual([]);
    expect(idea.main).toEqual(['note-api', 'drawing']);
    expect(itemWords(state, 'note-api')).toBe('Now put HTTP in front of it. curl should just w…');
    expect(itemWords(state, 'drawing')).toBe('Drawing two ways to stream the reply');
    // A blueprint stands for its chapter when there is one.
    expect(mainItems(state, 'engine-loop')).toContain('blueprint');
  });

  it('counts the project apart: parts built here, parts that were already there, chapters built', async () => {
    const state = await seven();
    const p = projectProgress(state);
    // Clients are outside the system: nobody's to build, not counted. Tokenizer, Runner and the
    // stand-in were on the shelf before the board: they count apart, as nothing was built here.
    expect(p.parts).toEqual({ built: 7, total: 12 });
    expect(p.already).toBe(3);
    expect(p.chapters).toEqual({ built: 1, total: 2 });
  });

  it('a chapter whose track holds a part that was already there counts it apart', () => {
    const b = openBoard();
    b.must('agent', {
      type: 'model.patch',
      chapter: CH,
      ops: [
        { op: 'lane.set', lane: { id: 'api', name: 'API' } },
        { op: 'part.set', part: { id: 'old', name: 'Old part', lane: 'api', state: 'built', commit: 'abc1234', shelf: true } },
        { op: 'part.set', part: { id: 'new', name: 'New part', lane: 'api' } },
      ],
    });
    b.must('owner', { type: 'solidify', chapter: CH, picks: [], parts: ['new'] });
    b.must('owner', { type: 'build.start', chapter: CH, track: ['old', 'new'], check: 'make check' });
    expect(chapterProgress(b.state, CH)).toEqual({ built: 0, total: 1, already: 1 });
    expect(storyOf(b.state)[0]).toMatchObject({ built: 0, total: 1, already: 1 });

    // The owner reopens the old part: it is work to do here now, like any other part.
    b.must('owner', { type: 'part.state', part: 'old', state: 'idea' });
    expect(chapterProgress(b.state, CH)).toEqual({ built: 0, total: 2, already: 0 });
    expect(trackOf(b.state, CH)!.parts.find((x) => x.id === 'old')).not.toHaveProperty('shelf');
    // The board builds it, with the agreed check: it is built here, and counts as built.
    b.must('owner', { type: 'solidify', chapter: CH, picks: [], parts: ['old'] });
    b.must('agent', { type: 'part.state', part: 'old', state: 'building' });
    b.must('system', { type: 'part.state', part: 'old', state: 'built', commit: 'def5678', check: { cmd: 'make check', passed: true } });
    expect(chapterProgress(b.state, CH)).toEqual({ built: 1, total: 2, already: 0 });
    expect(trackOf(b.state, CH)!.parts.find((x) => x.id === 'old')).toMatchObject({ state: 'built', commit: 'def5678' });
    expect(trackOf(b.state, CH)!.parts.find((x) => x.id === 'old')).not.toHaveProperty('shelf');
    expect(projectProgress(b.state)).toMatchObject({ parts: { built: 1, total: 2 }, already: 0 });
  });
});

describe('the next idea', () => {
  it('starts to the right of everything on the board, level with its top', () => {
    const boxes: Box[] = [
      [0, 100, 300, 200],
      [-500, -40, 200, 100],
      [900, 600, 400, 300],
    ];
    const spot = nextIdeaSpot(boxes, [320, 88]);
    expect(spot).toEqual([1300 + NEXT_GAP, -40, 320, 88]);
    for (const b of boxes) {
      const clear = spot[0] >= b[0] + b[2] || b[0] >= spot[0] + spot[2] || spot[1] >= b[1] + b[3] || b[1] >= spot[1] + spot[3];
      expect(clear).toBe(true);
    }
    expect(nextIdeaSpot([], [320, 88])).toEqual([0, 0, 320, 88]);
  });

  it('opens a new chapter titled from the note, and puts the note in it; the board admits both', () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 320, 100]));
    const drafts = nextIdeaDrafts(b.state, { id: 'm2', text: 'Now put HTTP in front of it. curl should just work.', box: [560.4, 0, 320, 88] });
    expect(drafts).toEqual([
      { type: 'chapter.open', chapter: 'now-put-http-in-front-of', title: 'Now put HTTP in front of' },
      { type: 'item.add', chapter: 'now-put-http-in-front-of', item: { id: 'm2', kind: 'note', box: [560, 0, 320, 88], text: 'Now put HTTP in front of it. curl should just work.' } },
    ]);
    let state = b.state;
    for (const d of drafts) {
      const r = admit(state, d, 'owner', '2026-11-17T14:00:00Z');
      expect(r.ok).toBe(true);
      if (r.ok) state = r.state;
    }
    expect(state.chapterOrder).toEqual([CH, 'now-put-http-in-front-of']);
    expect(state.items.m2!.chapter).toBe('now-put-http-in-front-of');
  });

  it('never reuses a chapter id', () => {
    const b = openBoard();
    b.must('owner', { type: 'chapter.open', chapter: 'batches', title: 'Batches' });
    const drafts = nextIdeaDrafts(b.state, { id: 'm9', text: 'Batches', box: [0, 0, 320, 58] });
    expect(drafts[0]).toMatchObject({ chapter: 'batches-2' });
  });
});

describe('when', () => {
  it('says today, or the day', () => {
    const now = new Date('2026-11-17T20:00:00Z');
    expect(when('2026-11-17T14:43:00Z', now, 'UTC')).toBe('today 14:43');
    expect(when('2026-11-15T09:05:00Z', now, 'UTC')).toBe('15 Nov 09:05');
  });
});
