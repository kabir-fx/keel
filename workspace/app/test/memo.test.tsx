import type { Actor, BoardEvent, BoardState, Box, PictureItem } from '@keel/protocol';
import { emptyState, liveItems, markings as markingsOf, reduce } from '@keel/protocol';
import type { PictureView } from '@keel/pictures';
import { DRAWN_KINDS, Picture, SOURCE_CHAIN } from '@keel/pictures';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAhead } from '../src/board/ahead';
import { useShown } from '../src/board/shown';
import { PictureFrame } from '../src/items';
import { stateReads } from '../src/pictureReads';

/**
 * The memo on a picture must never hide a change. This test draws every kind of picture twice,
 * side by side: once as the board does (where things are by `useShown`, each picture in its
 * memoised `PictureFrame`), and once fresh, straight through `Picture`, on every render. Then it
 * takes the board through every change the reducer can make to what a picture might read, and
 * every way the owner can look at one, and after each step the two must be the same HTML.
 *
 * A renderer that starts to read something `stateReads` or `viewReads` does not list goes stale
 * on the memoised side and fails here, once a step below changes what it reads: so a new read
 * comes with a step that changes it, and a row in `SHOWS`.
 */

afterEach(cleanup);

const CH = 'one';
const CH2 = 'two';
const BOX: Box = [0, 0, 400, 300];
const SVG = '<svg viewBox="0 0 200 100"><rect x="0" y="0" width="10" height="10"/></svg>';

type Draft = Record<string, unknown>;

/** A log in memory, straight through the reducer: any change it can make, also one the rules would refuse. */
function log() {
  let state = emptyState();
  let seq = 0;
  const post = (by: Actor, draft: Draft) => {
    seq += 1;
    state = reduce(state, { ...draft, by, id: `e${seq}`, at: new Date(1.7e12 + seq * 1000).toISOString() } as unknown as BoardEvent);
  };
  return {
    get state() {
      return state;
    },
    post,
  };
}

const pic = (id: string, picture: Draft, chapter = CH): Draft => ({ type: 'item.add', chapter, item: { id, kind: 'picture', box: BOX, picture } });
const note = (id: string, on: Draft): Draft => ({ type: 'item.add', chapter: CH, item: { id, kind: 'note', box: [0, 0, 100, 50], text: id, on } });
const ink = (id: string, hint: 'circle' | 'cross', target: Draft): Draft => ({
  type: 'item.add',
  chapter: CH,
  item: { id, kind: 'ink', box: [0, 0, 10, 10], strokes: [{ pts: [0, 0, 10, 10] }], targets: [target], hint },
});
const patch = (...ops: Draft[]): Draft => ({ type: 'model.patch', ops });
const lanesBody = (title: string): Draft => ({
  title,
  lanes: [{ id: 'api', name: 'API' }, { id: 'eng', name: 'Engine' }],
  steps: [{ id: 's1', lane: 'api', text: 'one' }, { id: 's2', lane: 'eng', text: 'two' }],
  flows: [{ from: 's1', to: 's2' }],
});

/** A board with every kind of picture on it, the owner's marks on some, and a model for them to read. */
function setup() {
  const b = log();
  b.post('system', { type: 'board.open', name: 'b' });
  b.post('owner', { type: 'chapter.open', chapter: CH, title: 'First idea' });
  b.post('owner', { type: 'chapter.open', chapter: CH2, title: 'Second idea' });
  b.post('agent', {
    ...patch(
      { op: 'lane.set', lane: { id: 'api', name: 'API' } },
      { op: 'lane.set', lane: { id: 'bridge', name: 'Bridge' } },
      { op: 'lane.set', lane: { id: 'engine', name: 'Engine' } },
      { op: 'part.set', part: { id: 'door', name: 'The door', lane: 'api' } },
      { op: 'part.set', part: { id: 'queue', name: 'The queue', lane: 'bridge' } },
      { op: 'part.set', part: { id: 'loop', name: 'The loop', lane: 'engine' } },
      { op: 'part.set', part: { id: 'sched', name: 'Scheduler', lane: 'engine' } },
      { op: 'part.set', part: { id: 'cache', name: 'Cache' } },
      { op: 'edge.set', edge: { from: 'door', to: 'queue' } },
      { op: 'edge.set', edge: { from: 'queue', to: 'loop' } },
      { op: 'walk.set', walk: { id: 'w1', name: 'One request', steps: [{ n: 1, part: 'door', text: 'in' }, { n: 2, part: 'queue', text: 'wait' }, { n: 3, part: 'loop', text: 'run' }] } },
      { op: 'walk.set', walk: { id: 'w2', name: 'Other', steps: [{ n: 1, part: 'sched', text: 'pick' }] } },
    ),
    chapter: CH,
  });
  b.post('agent', pic('t1', { kind: 'text', title: 'Card one', questions: ['Why?'] }));
  b.post('agent', pic('t2', { kind: 'text', title: 'Card two' }));
  b.post('agent', pic('sh1', { kind: 'shelf', tiles: [{ id: 'a', name: 'Door', part: 'door' }, { id: 'b', name: 'Old', state: 'built' }, { id: 'c', name: 'Queue', part: 'queue' }] }));
  b.post('agent', pic('ch1', { kind: 'choice', title: 'Cap it', options: [{ id: 'a', label: 'Cap' }, { id: 'b', label: 'Leave' }], chosen: 'a', part: 'queue' }));
  b.post('agent', pic('wk1', { kind: 'walk', walk: 'w1' }));
  b.post('agent', pic('wk2', { kind: 'walk', walk: 'w9' }));
  b.post('agent', pic('wk3', { kind: 'walk', walk: 'w2' }));
  b.post('agent', pic('pl1', { kind: 'pipeline', walk: 'w1' }));
  b.post('agent', pic('pl2', { kind: 'pipeline', parts: ['door', 'queue'], view: 'flat' }));
  b.post('agent', pic('pl3', { kind: 'pipeline', model: { lanes: [{ id: 'x', name: 'X' }], parts: [{ id: 'px', name: 'PX', lane: 'x', state: 'idea' }] } }));
  b.post('agent', pic('fo1', { kind: 'focus', part: 'queue', summary: 's', crosses: [{ dir: 'in', what: 'req', part: 'door' }, { dir: 'out', what: 'tok', part: 'loop' }, { dir: 'out', what: 'x', part: 'cache' }] }));
  b.post('agent', pic('fo2', { kind: 'focus', lane: 'engine' }));
  b.post('agent', pic('ln1', { kind: 'lanes', ...lanesBody('Lanes') }));
  b.post('agent', pic('sp1', { kind: 'spread', title: 'Spread', request: 'r', approaches: [{ ...lanesBody('A one'), risk: 'r' }, { ...lanesBody('B two'), risk: 'r' }] }));
  b.post('agent', pic('mi1', { kind: 'mini', title: 'Mini', boxes: [{ text: 'a' }, { text: 'b' }] }));
  b.post('agent', pic('fr1', { kind: 'free', title: 'Free', svg: SVG }));
  // A kind this board does not draw yet: the plain card.
  b.post('agent', pic('new1', { kind: 'hologram', title: 'Not drawn yet', caption: 'A kind from a later board' }));
  // The owner's marks: a chain as deep as a pick's words look (a cross on a circle on a note on a card), and marks on parts, lanes and options.
  b.post('owner', note('n1', { item: 't1' }));
  b.post('owner', ink('k1', 'circle', { item: 'n1' }));
  b.post('owner', ink('k2', 'cross', { item: 'k1' }));
  b.post('owner', note('n2', { item: 'pl1', sub: 'part:queue' }));
  b.post('owner', note('n3', { item: 'pl1', sub: 'lane:engine' }));
  b.post('owner', ink('k3', 'circle', { item: 'sp1', sub: 'approach:a' }));
  b.post('owner', note('n4', { item: 'ch1', sub: 'option:b' }));
  b.post(
    'agent',
    pic('bp1', {
      kind: 'blueprint',
      title: 'The plan',
      proof: ['it runs'],
      check: 'make check',
      parts: ['queue', 'loop', 'cache'],
      picks: [
        { text: 'p1', from: { item: 'k2' } },
        { text: 'p2', from: { item: 'n2' } },
        { text: 'p3', from: { item: 'n3' } },
        { text: 'p4', from: { item: 't2' } },
        { text: 'p5', from: { item: 'k3' } },
        { text: 'p6' },
        { text: 'p7', from: { item: 'pl1', sub: 'part:loop' } },
        { text: 'p8', from: { item: 'n4' } },
      ],
    }),
  );
  b.post('agent', pic('bp2', { kind: 'blueprint', title: 'Other plan', proof: ['x'], check: 'c', parts: ['sched'], picks: [{ text: 'q1', from: { item: 'gone' } }] }, CH2));
  return b;
}

/** One step: events that land in one render, or a change of how the owner looks. */
type Step = { label: string } & ({ by: Actor; drafts: Draft[] } | { view: PictureView });

const ev = (label: string, by: Actor, ...drafts: Draft[]): Step => ({ label, by, drafts });
const look = (label: string, view: PictureView): Step => ({ label, view });
const partState = (part: string, state: string, more: Draft = {}): Draft => ({ type: 'part.state', part, state, ...more });
const passed = (commit: string): Draft => ({ commit, check: { cmd: 'make check', passed: true } });

/** Every change the reducer can make to what a picture might read, and every way to look at one. */
const STEPS: Step[] = [
  ev('a note elsewhere', 'owner', { type: 'item.add', chapter: CH, item: { id: 'n9', kind: 'note', box: [0, 0, 1, 1], text: 'x' } }),

  // How the owner looks, each part of the view in turn and back to an empty view after each: a
  // step of a walk (one a picture draws, one it does not, one that is not there), how pipelines
  // are drawn, the picture shown large.
  look('walk one played, step 2', { walk: { id: 'w1', step: 2 } }),
  look('walk one played, step 3', { walk: { id: 'w1', step: 3 } }),
  look('the other walk played', { walk: { id: 'w2', step: 1 } }),
  look('a walk that is not in the model played', { walk: { id: 'w9', step: 1 } }),
  look('no walk played', {}),
  look('pipelines drawn flat', { pipeline: 'flat' }),
  look('pipelines drawn in layers', { pipeline: 'layers' }),
  look('pipelines drawn as each one says', {}),
  look('the queue shown large', { focus: 'fo1' }),
  look('the engine lane shown large', { focus: 'fo2' }),
  look('a picture that is no focus shown large', { focus: 'pl1' }),
  look('nothing shown large', {}),
  // Every part at once, then one part changing while the others stay.
  look('a walk played, pipelines flat and the queue large, all at once', { walk: { id: 'w1', step: 1 }, pipeline: 'flat', focus: 'fo1' }),
  look('the step moves on, the rest stays', { walk: { id: 'w1', step: 2 }, pipeline: 'flat', focus: 'fo1' }),
  look('the other walk is played, the rest stays', { walk: { id: 'w2', step: 1 }, pipeline: 'flat', focus: 'fo1' }),
  look('pipelines go to layers, the rest stays', { walk: { id: 'w2', step: 1 }, pipeline: 'layers', focus: 'fo1' }),
  look('the engine lane is the one shown large, the rest stays', { walk: { id: 'w2', step: 1 }, pipeline: 'layers', focus: 'fo2' }),
  look('zoomed out, and nothing else said', { zoom: 0.4 }),
  look('back to the board', {}),

  // A part's state.
  ev('queue solid', 'owner', partState('queue', 'solid')),
  ev('queue building', 'agent', partState('queue', 'building')),
  ev('queue built', 'agent', partState('queue', 'built', { commit: 'abc', check: { cmd: 'make', passed: true } })),
  ev('queue idea', 'owner', partState('queue', 'idea')),
  ev('sched later', 'owner', partState('sched', 'later')),
  ev('cache solid (no lane)', 'owner', partState('cache', 'solid')),

  // The model: parts, lanes, edges, walks.
  ev('door renamed', 'agent', patch({ op: 'part.set', part: { id: 'door', name: 'Front door' } })),
  ev('queue renamed', 'agent', patch({ op: 'part.set', part: { id: 'queue', name: 'Line' } })),
  ev('loop plain', 'agent', patch({ op: 'part.set', part: { id: 'loop', plain: 'spins' } })),
  ev('cache renamed', 'agent', patch({ op: 'part.set', part: { id: 'cache', name: 'Store' } })),
  ev('sched moves lane', 'agent', patch({ op: 'part.set', part: { id: 'sched', lane: 'bridge' } })),
  ev('cache gets a lane', 'agent', patch({ op: 'part.set', part: { id: 'cache', lane: 'api' } })),
  ev('bridge renamed', 'agent', patch({ op: 'lane.set', lane: { id: 'bridge', name: 'The bridge' } })),
  ev('engine renamed', 'agent', patch({ op: 'lane.set', lane: { id: 'engine', name: 'Motor', note: 'spins' } })),
  ev('engine moved to the top', 'agent', patch({ op: 'lane.set', lane: { id: 'engine', name: 'Motor', note: 'spins' }, at: 0 })),
  ev('new lane', 'agent', patch({ op: 'lane.set', lane: { id: 'disk', name: 'Disk' } })),
  ev('new part', 'agent', patch({ op: 'part.set', part: { id: 'log', name: 'Log', lane: 'disk' } })),
  ev('new edge', 'agent', patch({ op: 'edge.set', edge: { from: 'loop', to: 'log' } })),
  ev('edge label', 'agent', patch({ op: 'edge.set', edge: { from: 'door', to: 'queue', label: 'push', kind: 'wait' } })),
  ev('edge dropped', 'agent', patch({ op: 'edge.drop', from: 'queue', to: 'loop' })),
  look('walk one played again, step 2', { walk: { id: 'w1', step: 2 } }),
  ev('walk changed', 'agent', patch({ op: 'walk.set', walk: { id: 'w1', name: 'A request', steps: [{ n: 1, part: 'door', text: 'enter' }, { n: 2, part: 'loop', text: 'run' }] } })),
  ev('walk dropped', 'agent', patch({ op: 'walk.drop', id: 'w1' })),
  ev('walk back', 'agent', patch({ op: 'walk.set', walk: { id: 'w1', name: 'Back', steps: [{ n: 1, part: 'queue', text: 'q' }] } })),
  ev('walk dropped and put back, in one render', 'agent', patch({ op: 'walk.drop', id: 'w1' }), patch({ op: 'walk.set', walk: { id: 'w1', name: 'Back again', steps: [{ n: 2, part: 'queue', text: 'q' }] } })),
  look('nothing played', {}),
  ev('missing walk appears', 'agent', patch({ op: 'walk.set', walk: { id: 'w9', name: 'Nine', steps: [{ n: 1, part: 'door', text: 'd' }] } })),
  ev('other walk changed', 'agent', patch({ op: 'walk.set', walk: { id: 'w2', name: 'Other!', steps: [{ n: 1, part: 'door', text: 'pick' }] } })),
  ev('part dropped', 'agent', patch({ op: 'part.drop', id: 'log' })),
  ev('door dropped', 'agent', patch({ op: 'part.drop', id: 'door' })),

  // The chapters, and a build.
  ev('chapter renamed', 'owner', { type: 'chapter.rename', chapter: CH, title: 'Renamed' }),
  ev('other chapter renamed', 'owner', { type: 'chapter.rename', chapter: CH2, title: 'Renamed 2' }),
  ev('solidify', 'owner', { type: 'solidify', chapter: CH, picks: ['k2'], parts: ['queue', 'loop'] }),
  ev('solidify other', 'owner', { type: 'solidify', chapter: CH2, picks: [], parts: ['sched'] }),
  ev('build start', 'owner', { type: 'build.start', chapter: CH, track: ['queue', 'loop', 'cache'], check: 'make check', blueprint: 'bp1' }),
  ev('build pause', 'owner', { type: 'build.pause', chapter: CH }),
  ev('build resume', 'owner', { type: 'build.resume', chapter: CH }),
  ev('queue building again', 'agent', partState('queue', 'building')),
  ev('queue built again', 'agent', partState('queue', 'built', passed('c1'))),
  ev('loop built', 'agent', partState('loop', 'built', passed('c2'))),
  ev('cache built: chapter built', 'agent', partState('cache', 'built', passed('c3'))),
  ev('loop reopened: chapter building', 'owner', partState('loop', 'idea')),

  // An item's own state, and the items a pick's words read.
  ev('choice picked', 'owner', { type: 'choice.pick', item: 'ch1', option: 'b' }),
  ev('choice picked back by the agent', 'agent', { type: 'choice.pick', item: 'ch1', option: 'a' }),
  ev('card one retitled (the end of the chain)', 'agent', { type: 'item.update', item: 't1', patch: { picture: { kind: 'text', title: 'Card one, again' } } }),
  ev('card two retitled', 'agent', { type: 'item.update', item: 't2', patch: { picture: { kind: 'text', title: 'Card two, again' } } }),
  ev('choice option relabelled', 'agent', {
    type: 'item.update',
    item: 'ch1',
    patch: { picture: { kind: 'choice', title: 'Cap it', options: [{ id: 'a', label: 'Cap' }, { id: 'b', label: 'Let it be' }], chosen: 'a', part: 'queue' } },
  }),
  ev('note n1 says something else', 'owner', { type: 'item.update', item: 'n1', patch: { text: 'changed' } }),
  ev('note n1 removed', 'owner', { type: 'item.remove', item: 'n1' }),
  ev('note n1 restored', 'owner', { type: 'item.restore', item: 'n1' }),
  ev('circle k1 removed', 'owner', { type: 'item.remove', item: 'k1' }),
  ev('card one removed', 'agent', { type: 'item.remove', item: 't1' }),
  ev('card one restored', 'agent', { type: 'item.restore', item: 't1' }),
  ev('pick source appears', 'owner', { type: 'item.add', chapter: CH2, item: { id: 'gone', kind: 'note', box: [0, 0, 1, 1], text: 'here' } }),

  // A picture still being drawn shows the placeholder, whatever the model does.
  ev('pipeline one drawing', 'agent', { type: 'item.update', item: 'pl1', patch: { status: 'drawing' } }),
  ev('queue renamed while pipeline one draws', 'agent', patch({ op: 'part.set', part: { id: 'queue', name: 'Q' } })),
  look('pipelines drawn flat while pipeline one draws', { pipeline: 'flat' }),
  ev('pipeline one done', 'agent', { type: 'item.update', item: 'pl1', patch: { status: 'done' } }),
  look('pipelines drawn as each one says, again', {}),

  // What the owner's pen says about a picture.
  ev('a cross on the queue in pipeline one', 'owner', ink('k4', 'cross', { item: 'pl1', sub: 'part:queue' })),
  ev('the cross moves to the loop, in one render', 'owner', { type: 'item.remove', item: 'k4' }, ink('k5', 'cross', { item: 'pl1', sub: 'part:loop' })),
  ev('a circle round card two', 'owner', ink('k6', 'circle', { item: 't2' })),
  ev('the cross comes off', 'owner', { type: 'item.remove', item: 'k5' }),
];

/**
 * What each kind reads, as its renderer reads it, and a step that changes it: at that step the
 * fresh picture must draw something new, or this test could not see a memo that hides it.
 */
const SHOWS: Array<[read: string, step: string, picture: string]> = [
  ['a shelf reads each tile’s part', 'queue solid', 'sh1'],
  ['a choice reads its own state on the board', 'choice picked', 'ch1'],
  ['a choice reads its part', 'queue renamed', 'ch1'],
  ['a walk reads its walk', 'walk changed', 'wk1'],
  ['a walk reads its walk, also one that is not there yet', 'missing walk appears', 'wk2'],
  ['a walk reads the step being played', 'walk one played, step 2', 'wk1'],
  ['a walk reads that the step moved on', 'walk one played, step 3', 'wk1'],
  ['a walk reads that another walk is played instead', 'the other walk played', 'wk1'],
  ['a walk reads the step of its own walk, whichever that is', 'the other walk played', 'wk3'],
  ['a walk reads that its walk is not the one played any more', 'a walk that is not in the model played', 'wk3'],
  ['a walk reads its step when the rest of the view stays', 'the step moves on, the rest stays', 'wk1'],
  ['a pipeline reads the lanes', 'bridge renamed', 'pl1'],
  ['a pipeline reads the parts', 'queue solid', 'pl1'],
  ['a pipeline of some parts reads them', 'queue solid', 'pl2'],
  ['a pipeline reads the edges', 'edge label', 'pl1'],
  ['a pipeline reads the walks', 'walk changed', 'pl1'],
  ['a pipeline reads the step being played', 'walk one played, step 3', 'pl1'],
  ['a pipeline reads that another walk is played instead', 'the other walk played', 'pl1'],
  ['a pipeline reads its step when the rest of the view stays', 'the step moves on, the rest stays', 'pl1'],
  ['a pipeline reads how pipelines are drawn', 'pipelines drawn flat', 'pl1'],
  ['a pipeline with its own model reads how pipelines are drawn', 'pipelines drawn flat', 'pl3'],
  ['a pipeline that says its own way follows the owner’s all the same', 'pipelines drawn in layers', 'pl2'],
  ['a pipeline reads that the view no longer says how', 'pipelines drawn as each one says', 'pl2'],
  ['a pipeline reads how pipelines are drawn when the rest of the view stays', 'pipelines go to layers, the rest stays', 'pl1'],
  ['a focus on a part reads the part', 'queue renamed', 'fo1'],
  ['a focus on a part reads the parts that cross it', 'door renamed', 'fo1'],
  ['a focus reads the lanes', 'bridge renamed', 'fo1'],
  ['a focus on a lane reads the lane', 'engine renamed', 'fo2'],
  ['a focus on a lane reads the parts in it', 'sched moves lane', 'fo2'],
  ['a focus reads whether it is shown large', 'the queue shown large', 'fo1'],
  ['a focus reads that another one is shown large instead', 'the engine lane shown large', 'fo1'],
  ['a focus reads that it is the one shown large now', 'the engine lane shown large', 'fo2'],
  ['a focus reads that it is not the one shown large any more', 'a picture that is no focus shown large', 'fo2'],
  ['a focus reads whether it is shown large when the rest of the view stays', 'the engine lane is the one shown large, the rest stays', 'fo2'],
  ['a blueprint reads its chapter', 'solidify', 'bp1'],
  ['a blueprint reads its own chapter and no other', 'solidify other', 'bp2'],
  ['a blueprint reads the model', 'bridge renamed', 'bp1'],
  ['a blueprint reads the parts on its track, also one off the picture', 'cache solid (no lane)', 'bp1'],
  ['a blueprint reads a pick’s source, as deep as its words look', 'card one retitled (the end of the chain)', 'bp1'],
  ['a blueprint reads a pick’s source, also one that is not there yet', 'pick source appears', 'bp2'],
  ['a picture reads what the owner’s pen says about it', 'the cross moves to the loop, in one render', 'pl1'],
];

function pictures(state: BoardState): PictureItem[] {
  return liveItems(state)
    .map((s) => s.item)
    .filter((it): it is PictureItem => it.kind === 'picture');
}

const NO_SUBS: ReadonlyMap<string, Box> = new Map();
const onAct = () => undefined;

/** The pictures as the board draws them: where things are by `useShown`, each in its memoised frame. */
function Memoed({ state, view }: { state: BoardState; view: PictureView }) {
  const { boxes, marks } = useShown(state, useAhead(), NO_SUBS, undefined);
  return (
    <>
      {pictures(state).map((it) => (
        <PictureFrame key={it.id} item={it} shown={boxes.get(it.id) ?? BOX} state={state} markings={marks[it.id]} view={view} onAct={onAct} />
      ))}
    </>
  );
}

/** The same pictures with no memo: each one drawn again on every render, from the whole state. */
function Fresh({ state, view }: { state: BoardState; view: PictureView }) {
  const marks = markingsOf(state);
  return (
    <>
      {pictures(state).map((it) => (
        <div key={it.id} data-fresh={it.id}>
          <Picture item={it} state={state} markings={marks[it.id]} view={view} onAct={onAct} />
        </div>
      ))}
    </>
  );
}

/** A picture's HTML, with the ids React hands out taken off: they differ from one tree to the other. */
const htmlOf = (root: HTMLElement, selector: string) => (root.querySelector(selector)?.innerHTML ?? '(not drawn)').replace(/kp_r_[0-9a-z]+_/g, 'kp');

/** Where two strings first differ, with a little of each from there. */
function firstDifference(a: string, b: string): string {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 30);
  return `memoised "${a.slice(from, i + 50)}" but fresh "${b.slice(from, i + 50)}"`;
}

describe('a memoised picture draws what a fresh one draws', () => {
  it('for every kind, after every change to the board and to how the owner looks at it', () => {
    const b = setup();
    let view: PictureView = {};
    const memo = render(<Memoed state={b.state} view={view} />);
    const fresh = render(<Fresh state={b.state} view={view} />);
    const freshHtml = () => new Map(pictures(b.state).map((it) => [it.id, htmlOf(fresh.container, `[data-fresh="${it.id}"]`)]));

    const stale: string[] = [];
    const check = (label: string) => {
      for (const it of pictures(b.state)) {
        const m = htmlOf(memo.container, `[data-item="${it.id}"]`);
        const f = htmlOf(fresh.container, `[data-fresh="${it.id}"]`);
        if (m !== f) stale.push(`${label}: ${it.id} (${it.picture.kind}) is ${firstDifference(m, f)}`);
      }
    };

    check('at the start');
    /** The steps at which the fresh picture drew something new, by picture. */
    const changedAt = new Map<string, Set<string>>();
    for (const step of STEPS) {
      const before = freshHtml();
      if ('view' in step) view = step.view;
      else for (const draft of step.drafts) b.post(step.by, draft);
      act(() => {
        memo.rerender(<Memoed state={b.state} view={view} />);
        fresh.rerender(<Fresh state={b.state} view={view} />);
      });
      for (const [id, html] of freshHtml()) {
        if (before.has(id) && before.get(id) !== html) changedAt.set(id, (changedAt.get(id) ?? new Set()).add(step.label));
      }
      check(step.label);
    }

    expect(stale).toEqual([]);

    // The test is only as good as its board: every kind is on it, with the plain card and the
    // placeholder, and every read has a step that shows it.
    const kinds = new Set(pictures(b.state).map((it) => it.picture.kind as string));
    expect([...kinds].sort()).toEqual([...DRAWN_KINDS, 'hologram'].sort());
    expect(fresh.container.querySelector('[data-fresh="new1"] .kp-plain')).not.toBeNull();
    expect(changedAt.get('pl1')).toContain('pipeline one drawing');
    const unseen = SHOWS.filter(([, step, id]) => !changedAt.get(id)?.has(step)).map(([read, step, id]) => `${read}: "${step}" did not change ${id}`);
    expect(unseen).toEqual([]);
  });
});

describe('a memoised picture follows its own props', () => {
  it('where it is drawn, whether it is selected or raised, and whom it tells what the owner did', () => {
    const state = setup().state;
    const item = state.items.ch1!.item as PictureItem;
    const view: PictureView = {};
    const first = vi.fn();
    let props = { shown: BOX, selected: false, raised: false, onAct: first as () => void };
    const frame = () => <PictureFrame item={item} state={state} markings={undefined} view={view} {...props} />;
    const { container, rerender } = render(frame());
    /** Draw again with one prop changed, and every other prop the very same. */
    const change = (one: Partial<typeof props>) => {
      props = { ...props, ...one };
      rerender(frame());
      return container.querySelector<HTMLElement>('[data-item="ch1"]')!;
    };

    expect(change({}).className).toBe('item item--picture');
    expect(change({ shown: [40, 0, 400, 300] }).style.left).toBe('40px');
    expect(change({ selected: true }).className).toBe('item item--picture item--selected');
    expect(change({ raised: true }).className).toBe('item item--picture item--selected item--raised');

    const second = vi.fn();
    change({ onAct: second });
    fireEvent.click(screen.getByText('Use this instead'));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith({ type: 'choice.pick', item: 'ch1', option: 'b' });
  });
});

describe('the items a blueprint follows for a pick’s source', () => {
  /** A card, and marks one on the other up from it, `deep` items in all; the blueprint's one pick comes from the last. */
  function chain(deep: number) {
    const b = log();
    b.post('owner', { type: 'chapter.open', chapter: CH, title: 'First idea' });
    b.post('agent', pic('end', { kind: 'text', title: 'The card at the end' }));
    let on = 'end';
    for (let i = 1; i < deep; i++) {
      b.post('owner', i === deep - 1 ? ink(`x${i}`, 'cross', { item: on }) : note(`x${i}`, { item: on }));
      on = `x${i}`;
    }
    b.post('agent', pic('bp', { kind: 'blueprint', title: 'The plan', proof: [], check: 'c', parts: [], picks: [{ text: 'p1', from: { item: on } }] }));
    const item = b.state.items.bp!.item as PictureItem;
    return { state: b.state, item, words: render(<Picture item={item} state={b.state} />).container.querySelector('.kp-pick__from')?.textContent };
  }

  it('are as many as the words look through: a cross on a note on a note on a card names the card, and reads it', () => {
    const { state, item, words } = chain(SOURCE_CHAIN);
    expect(words).toBe('from your cross on The card at the end');
    expect(stateReads(state, item)).toContain(state.items.end);
  });

  it('and no more: one mark deeper, the words no longer reach the card', () => {
    expect(chain(SOURCE_CHAIN + 1).words).toBe('from your cross');
  });
});
