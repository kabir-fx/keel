import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BoardEvent, BoardState, Checkpoint, FocusPicture, PictureSpec } from '../src';
import { PresenceUpdate, audit, emptyState, markings, openCount, parseLog, replay, trackProgress } from '../src';
import { buildFixture } from '../fixtures/engine-loop/build';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'engine-loop');
const read = (name: string) => readFileSync(join(dir, name), 'utf8');

const { events, problems } = (() => {
  const r = parseLog(read('log.jsonl'));
  return { events: r.events, problems: r.problems };
})();
const checkpoints = JSON.parse(read('checkpoints.json')) as Checkpoint[];

/** The board as it stood at a checkpoint. */
function at(screen: number): { state: BoardState; cp: Checkpoint } {
  const cp = checkpoints.find((c) => c.screen === screen);
  if (!cp) throw new Error(`no checkpoint for screen ${screen}`);
  const end = events.findIndex((e) => e.id === cp.after);
  expect(end, `event ${cp.after} is in the log`).toBeGreaterThanOrEqual(0);
  return { state: replay(events.slice(0, end + 1)), cp };
}

function picture<K extends PictureSpec['kind']>(state: BoardState, id: string, kind: K): Extract<PictureSpec, { kind: K }> {
  const item = state.items[id]?.item;
  if (item?.kind !== 'picture' || item.picture.kind !== kind) throw new Error(`"${id}" is not a ${kind} picture`);
  return item.picture as Extract<PictureSpec, { kind: K }>;
}

describe('the engine-loop fixture: the log', () => {
  it('parses with no problem', () => {
    expect(problems).toEqual([]);
    expect(events.length).toBeGreaterThan(0);
  });

  it('is legal: audit finds nothing', () => {
    const r = audit(events, emptyState());
    expect(r.problems).toEqual([]);
    expect(r.state.seq).toBe(events.length);
  });

  it('is what story.ts builds, byte for byte', () => {
    const built = buildFixture();
    expect(built.log).toBe(read('log.jsonl'));
    expect(built.checkpointsJson).toBe(read('checkpoints.json'));
    for (const [path, bytes] of Object.entries(built.assets)) {
      expect(readFileSync(join(dir, path)).equals(bytes), path).toBe(true);
    }
  });

  it('starts at 13:00 on 2026-11-17 and never goes back in time', () => {
    expect(events[0]?.at).toBe('2026-11-17T13:00:00Z');
    for (let i = 1; i < events.length; i++) expect((events[i] as BoardEvent).at >= (events[i - 1] as BoardEvent).at).toBe(true);
  });

  it('has a real file for every file item and every snapshot', () => {
    const named: string[] = [];
    for (const s of Object.values(replay(events).items)) {
      if (s.item.kind === 'file') {
        named.push(s.item.asset);
        const size = readFileSync(join(dir, s.item.asset)).length;
        expect(s.item.size, s.item.id).toBe(size);
      }
      if (s.item.kind === 'ink' && s.item.snapshot) named.push(s.item.snapshot);
    }
    expect(named.length).toBeGreaterThanOrEqual(2);
    for (const p of named) expect(existsSync(join(dir, p)), p).toBe(true);
    const png = readFileSync(join(dir, 'assets/sketch.png'));
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
  });

  it('gives no agent picture a box: the app places it', () => {
    for (const ev of events) {
      if (ev.type === 'item.add' && ev.item.kind === 'picture') expect(ev.item.box, ev.item.id).toBeUndefined();
    }
  });
});

describe('the engine-loop fixture: the checkpoints', () => {
  it('has seven, in storyboard order, each after a real event', () => {
    expect(checkpoints.map((c) => c.screen)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(checkpoints.map((c) => c.name)).toEqual(['main', 'pictures', 'model', 'focus', 'solidify', 'watch', 'story']);
    const ids = checkpoints.map((c) => c.after);
    expect(new Set(ids).size).toBe(7);
    for (const id of ids) expect(events.some((e) => e.id === id), id).toBe(true);
    const order = ids.map((id) => events.findIndex((e) => e.id === id));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('names items and parts that exist, and presence the wire accepts', () => {
    for (const cp of checkpoints) {
      const { state } = at(cp.screen);
      for (const id of cp.view.show ?? []) expect(state.items[id], `${cp.name}: ${id}`).toBeDefined();
      if (cp.view.focus) expect(state.items[cp.view.focus]?.item, cp.name).toMatchObject({ kind: 'picture', picture: { kind: 'focus' } });
      if (cp.view.walk) expect(state.model.walks[cp.view.walk.id], cp.name).toBeDefined();
      if (cp.view.presence) expect(PresenceUpdate.safeParse(cp.view.presence).success, cp.name).toBe(true);
    }
  });

  it('screen 1: a note, a file, a sketch and its five handwritten labels, an idea', () => {
    const { state, cp } = at(1);
    // The pill says 3 open marks (note, file, sketch). The log also holds the sketch's 5 labels as notes: 8.
    expect(openCount(state)).toBe(8);
    expect(Object.keys(state.items).sort()).toEqual(
      ['drop-roadmap', 'label-clients', 'label-engine', 'label-model', 'label-text-back', 'label-waits', 'n-first', 'sketch'],
    );
    expect(state.chapters['engine-loop']?.state).toBe('idea');
    expect(cp.view.mode).toBe('board');
    expect(cp.view.presence?.state).toBe('listening');
  });

  it('screen 2: A circled, B crossed out, one open mark', () => {
    const { state } = at(2);
    expect(openCount(state)).toBe(1);
    const m = markings(state)['spread'];
    expect(m?.circled).toContain('approach:a');
    expect(m?.crossed).toContain('approach:b');
    expect(m?.circled).not.toContain('approach:b');
    expect(m?.crossed).not.toContain('approach:a');
    expect(picture(state, 'spread', 'spread').approaches).toHaveLength(3);
    expect(picture(state, 'spread', 'spread').caption).toContain('Blue marks what differs');
    expect(state.chapters['engine-loop']?.state).toBe('idea');
    expect(state.chapters['engine-loop']?.title).toBe('The engine loop');
  });

  it('screen 3: a walk of 13 steps, the model drawn, one open mark', () => {
    const { state, cp } = at(3);
    expect(openCount(state)).toBe(1);
    expect(state.model.walks['req-42']?.steps).toHaveLength(13);
    expect(state.model.lanes.map((l) => l.id)).toEqual(['clients', 'api', 'bridge', 'engine']);
    expect(state.model.parts['clients']).toMatchObject({ external: true, lane: 'clients' });
    for (const id of ['same-tokens', 'roadmap-sentence']) expect(state.model.parts[id]?.lane, id).toBeUndefined();
    expect(picture(state, 'pipe', 'pipeline').parts).toBeUndefined();
    expect(picture(state, 'pipe', 'pipeline').walk).toBe('req-42');
    expect(picture(state, 'walk', 'walk').walk).toBe('req-42');
    expect(cp.view.walk).toEqual({ id: 'req-42', step: 8 });
  });

  it('screen 4: the focus is the lane bridge, with its two ways to stop a flood, and no open marks', () => {
    const { state, cp } = at(4);
    expect(openCount(state)).toBe(0);
    const focus: FocusPicture = picture(state, 'focus', 'focus');
    expect(focus.lane).toBe('bridge');
    expect(focus.part).toBeUndefined();
    expect(state.model.lanes.some((l) => l.id === focus.lane)).toBe(true);
    expect(cp.view.focus).toBe('focus');
    expect(focus.lane).toBe('bridge');
    const asked = Object.values(state.acts).find((a) => a.type === 'ask');
    expect(asked?.event).toMatchObject({ type: 'ask', lane: 'bridge' });
    expect(focus.options?.items.map((o) => o.id)).toEqual(['cap-queue', 'cap-door']);
    expect(focus.options?.lean).toBe('cap-door');
    const m = markings(state)['focus'];
    expect(m?.crossed).toEqual(['option:cap-queue']);
    expect(m?.circled).toEqual(['option:cap-door']);
  });

  it('screen 5: the chapter is solid, with a blueprint of 7 parts, and nothing is open', () => {
    const { state } = at(5);
    expect(openCount(state)).toBe(0);
    expect(state.chapters['engine-loop']?.state).toBe('solid');
    const bp = picture(state, 'blueprint', 'blueprint');
    expect(bp.parts).toHaveLength(7);
    for (const id of bp.parts) expect(state.model.parts[id]?.state, id).toBe('solid');
    expect(state.model.parts['handler']?.state).toBe('later');
    expect(state.chapters['engine-loop']?.track).toEqual([]);
  });

  it('screen 6: 2 parts built, 1 building, a choice on the board, nothing blocked', () => {
    const { state } = at(6);
    expect(openCount(state)).toBe(0);
    const c = state.chapters['engine-loop'];
    expect(c?.state).toBe('building');
    expect(c?.paused).toBe(false);
    expect(c?.track).toHaveLength(7);
    expect(trackProgress(state, 'engine-loop')).toEqual({ built: 2, total: 7, current: 'engine-loop' });
    expect(state.model.parts['request']).toMatchObject({ state: 'built', commit: '658b4ec' });
    expect(state.model.parts['scheduler']).toMatchObject({ state: 'built', commit: 'eb39c5b' });
    expect(state.model.parts['engine-loop']?.state).toBe('building');
    const choice = picture(state, 'choice', 'choice');
    expect(state.items['choice']?.chosen).toBe(choice.chosen);
    // The evidence comes from the build's own tools, with the check the owner agreed to.
    const commits = state.feed.filter((f) => f.kind === 'commit');
    expect(commits.map((f) => [f.commit, f.by])).toEqual([['658b4ec', 'system'], ['eb39c5b', 'system']]);
    expect(c?.check).toBe('make check');
    for (const id of ['request', 'scheduler']) expect(state.model.parts[id]?.check).toEqual({ cmd: 'make check', passed: true });
    expect(state.feed.filter((f) => f.by === 'agent').every((f) => f.commit === undefined && f.check === undefined)).toBe(true);
    // The picture the owner picked is as they saw it. The build has a picture of its own.
    expect(picture(state, 'pipe', 'pipeline').title).toBe('Your pick, in full');
    expect(picture(state, 'pipe-build', 'pipeline').title).toBe('The blueprint, being built');
  });

  it('screen 7: the first chapter is built, a second chapter is an idea, one open mark', () => {
    const { state, cp } = at(7);
    expect(state.chapterOrder).toEqual(['engine-loop', 'api-server']);
    expect(state.chapters['api-server']?.state).toBe('idea');
    expect(state.chapters['engine-loop']?.state).toBe('built');
    expect(trackProgress(state, 'engine-loop')).toMatchObject({ built: 7, total: 7 });
    expect(state.chapters['engine-loop']?.track).toEqual(
      expect.arrayContaining(['same-tokens', 'roadmap-sentence']),
    );
    const commits = state.feed.filter((f) => f.kind === 'commit');
    expect(commits).toHaveLength(7);
    expect(commits.every((f) => f.by === 'system' && /^[0-9a-f]{7}$/.test(f.commit ?? ''))).toBe(true);
    for (const id of state.chapters['engine-loop']!.track) {
      expect(state.model.parts[id], id).toMatchObject({ state: 'built', check: { cmd: 'make check', passed: true }, decided: true });
    }
    expect(openCount(state)).toBe(1);
    expect(cp.view.mode).toBe('story');
    expect(state.moments).toHaveLength(6);
    expect(state.model.parts['handler']?.state).toBe('idea');
    expect(state.model.parts['batches']?.state).toBe('later');
  });

  it('puts the open-mark count of each screen on the board pill', () => {
    expect(checkpoints.map((c) => openCount(at(c.screen).state))).toEqual([8, 1, 1, 0, 0, 0, 1]);
  });
});
