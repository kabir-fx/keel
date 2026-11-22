import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { BoardState, LanesBody, PictureItem, PictureKind, SpreadPicture } from '@keel/protocol';
import { PICTURE_KINDS, Sub, admit, liveParts, markings, subKind } from '@keel/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DRAWN_KINDS, Picture, blueOf, layoutFlat, layoutLanes, layoutMini } from '../src';
import { FLAT_FULL, FLAT_SMALL } from '../src/PipeSvg';
import { PLAY_MS } from '../src/Walk';
import type { Rect } from '../src/grid';
import { overlaps } from '../src/grid';
import { pipeModel } from '../src/pipemodel';
import { DASHED_WIDTH, HEAD, LINE_WIDTH } from '../src/svg';
import { examplesBoard } from './examples';
import { at, checkpoints, item, pictures } from './fixture';

afterEach(cleanup);

/** The subs the README's table says each kind offers. */
const SUB_KINDS: Record<PictureKind, string[]> = {
  text: ['q'],
  shelf: ['tile'],
  lanes: ['step', 'lane'],
  spread: ['approach', 'step'],
  mini: ['box'],
  pipeline: ['part', 'lane'],
  walk: ['step'],
  focus: ['option'],
  blueprint: ['pick', 'part', 'assumed'],
  choice: ['option'],
  free: [],
};

/** The subs a picture must offer, worked out from its spec and the board, not from the renderer. */
function expectedSubs(it: PictureItem, state: BoardState): string[] {
  const p = it.picture;
  switch (p.kind) {
    case 'text':
      return (p.questions ?? []).map((_, i) => `q:${i + 1}`);
    case 'shelf':
      return p.tiles.map((t) => `tile:${t.id}`);
    case 'lanes':
      return [...p.steps.map((s) => `step:${s.id}`), ...p.lanes.map((l) => `lane:${l.id}`)];
    case 'spread':
      return p.approaches.flatMap((a, i) => {
        const l = 'abcd'[i]!;
        return [`approach:${l}`, ...(a.kind === 'free' ? [] : a.steps.map((s) => `step:${l}-${s.id}`))];
      });
    case 'mini':
      return p.boxes.map((_, i) => `box:${i + 1}`);
    case 'pipeline': {
      const parts = p.model ? p.model.parts : liveParts(state);
      const drawn = parts.filter((x) => x.lane !== undefined && (!p.parts || p.parts.includes(x.id)));
      const lanes = p.model ? p.model.lanes : state.model.lanes;
      const shownLanes = p.parts ? lanes.filter((l) => drawn.some((x) => x.lane === l.id)) : lanes;
      return [...drawn.map((x) => `part:${x.id}`), ...shownLanes.map((l) => `lane:${l.id}`)];
    }
    case 'walk':
      return (state.model.walks[p.walk]?.steps ?? []).map((s) => `step:${s.n}`);
    case 'focus':
      return (p.options?.items ?? []).map((o) => `option:${o.id}`);
    case 'blueprint':
      return [...p.picks.map((_, i) => `pick:${i + 1}`), ...p.parts.map((id) => `part:${id}`), ...(p.assumed ?? []).map((_, i) => `assumed:${i + 1}`)];
    case 'choice':
      return p.options.map((o) => `option:${o.id}`);
    case 'free':
      return [];
  }
}

function subsIn(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-sub]')].map((e) => e.getAttribute('data-sub')!);
}

function drawAll(state: BoardState, items: PictureItem[], view = {}) {
  const marks = markings(state);
  for (const it of items) {
    const { container, unmount } = render(<Picture item={it} state={state} markings={marks[it.id]} view={view} onAct={() => {}} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root, it.id).not.toBeNull();
    expect(root.dataset.kind, it.id).toBe(it.picture.kind);
    expect(container.querySelector('.kp-plain'), `${it.id} is drawn, not a plain card`).toBeNull();
    // Natural size, no position from outside.
    expect(root.style.position, it.id).toBe('');
    expect(root.style.left, it.id).toBe('');
    expect(root.style.top, it.id).toBe('');
    const subs = subsIn(container);
    expect(new Set(subs).size, `${it.id}: no sub twice`).toBe(subs.length);
    for (const s of subs) {
      expect(Sub.safeParse(s).success, `${it.id}: "${s}" is a sub`).toBe(true);
      expect(SUB_KINDS[it.picture.kind], `${it.id}: "${s}" is a sub its kind offers`).toContain(subKind(s));
    }
    for (const s of expectedSubs(it, state)) expect(subs, `${it.id} offers ${s}`).toContain(s);
    unmount();
  }
}

describe('every kind', () => {
  it('has a renderer', () => {
    expect([...DRAWN_KINDS].sort()).toEqual([...PICTURE_KINDS].sort());
  });

  it('draws every picture of the fixture, at every checkpoint, with the subs the README names', () => {
    expect(checkpoints).toHaveLength(7);
    let drawn = 0;
    for (const cp of checkpoints) {
      const { state } = at(cp.screen);
      const items = pictures(state);
      drawAll(state, items, { ...(cp.view.pipeline ? { pipeline: cp.view.pipeline } : {}), ...(cp.view.walk ? { walk: cp.view.walk } : {}) });
      drawn += items.length;
    }
    expect(drawn).toBeGreaterThan(50);
  });

  it('draws the contract example of every kind, with its subs', () => {
    const { state, items } = examplesBoard();
    expect(items).toHaveLength(PICTURE_KINDS.length);
    drawAll(
      state,
      items.map((id) => item(state, id)),
    );
  });

  it('draws both views of every pipeline', () => {
    for (const cp of checkpoints.slice(2)) {
      const { state } = at(cp.screen);
      const pipes = pictures(state).filter((p) => p.picture.kind === 'pipeline');
      for (const v of ['flat', 'layers'] as const) {
        for (const it of pipes) {
          const { container, unmount } = render(<Picture item={{ ...it, picture: { ...it.picture, view: v } as typeof it.picture }} state={state} />);
          expect(container.querySelector('[data-view]')?.getAttribute('data-view')).toBe(v);
          for (const s of expectedSubs(it, state)) expect(subsIn(container)).toContain(s);
          unmount();
        }
      }
    }
  });

  it('gives the same layout for the same spec', () => {
    const { state } = at(6);
    for (const it of pictures(state)) {
      const a = render(<Picture item={it} state={state} />).container.innerHTML;
      cleanup();
      const b = render(<Picture item={it} state={state} />).container.innerHTML;
      cleanup();
      // React's ids differ between two mounts; nothing else may.
      const plain = (html: string) => html.replace(/kp[«»_:a-zA-Z0-9-]*?-(ah|glow|lit)/g, 'ID-$1');
      expect(plain(b), it.id).toBe(plain(a));
    }
  });

  it('puts gaps in a quiet footnote', () => {
    const { state } = examplesBoard();
    const { container } = render(<Picture item={item(state, 'ex-lanes')} state={state} />);
    const note = container.querySelector('.kp-gaps');
    expect(note?.textContent).toContain('It cannot show 64 at once.');
    expect(note?.getAttribute('role')).toBe('note');
  });

  it('tells the board about a tap on a sub, and only the innermost one', () => {
    const { state } = at(2);
    const onAct = vi.fn();
    const { container } = render(<Picture item={item(state, 'spread')} state={state} onAct={onAct} />);
    fireEvent.click(container.querySelector('[data-sub="step:a-model-step"]')!);
    expect(onAct).toHaveBeenCalledTimes(1);
    expect(onAct).toHaveBeenCalledWith({ type: 'tap', item: 'spread', sub: 'step:a-model-step' });
    fireEvent.click(container.querySelector('[data-sub="approach:c"]')!);
    expect(onAct).toHaveBeenLastCalledWith({ type: 'tap', item: 'spread', sub: 'approach:c' });
  });
});

/* ------------------------------------------------------------------ blue */

const body = (steps: Array<[string, string, string]>, lanes = ['a', 'b']): LanesBody & { title: string; risk: string } => ({
  title: 't',
  risk: 'r',
  lanes: lanes.map((id) => ({ id, name: `Lane ${id}` })),
  steps: steps.map(([id, lane, text]) => ({ id, lane, text })),
  flows: steps.slice(1).map((s, i) => ({ from: steps[i]![0], to: s[0] })),
});

describe('the blue rule', () => {
  it('turns blue what no other approach has with the same id and the same words', () => {
    const one = body([['x', 'a', 'post it'], ['y', 'b', 'take it'], ['z', 'a', 'see it']]);
    const two = body([['x', 'a', 'Post it.'], ['y', 'b', 'take it later'], ['w', 'b', 'see it']]);
    const [b1, b2] = blueOf([one, two]);
    // Case and punctuation do not count as different words.
    expect(b1!.steps.has('x')).toBe(false);
    expect(b2!.steps.has('x')).toBe(false);
    // Same id, other words: blue in both.
    expect(b1!.steps.has('y')).toBe(true);
    expect(b2!.steps.has('y')).toBe(true);
    // Same words, other id: blue in both.
    expect(b1!.steps.has('z')).toBe(true);
    expect(b2!.steps.has('w')).toBe(true);
    // The flow x>y is in both; y>z and y>w are not.
    expect([...b1!.flows]).toEqual([1]);
    expect([...b2!.flows]).toEqual([1]);
    expect(b1!.lanes.size + b2!.lanes.size).toBe(0);
  });

  it('counts a step moved to another lane as a different step', () => {
    const one = body([['x', 'a', 'plan'], ['y', 'b', 'run']]);
    const two = body([['x', 'b', 'plan'], ['y', 'b', 'run']]);
    const [b1, b2] = blueOf([one, two]);
    expect(b1!.steps.has('x') && b2!.steps.has('x')).toBe(true);
    expect(b1!.steps.has('y') || b2!.steps.has('y')).toBe(false);
  });

  it('turns blue in the fixture spread what only one approach draws', () => {
    const { state } = at(2);
    const spread = item(state, 'spread').picture as SpreadPicture;
    const [a, b, c] = blueOf(spread.approaches);
    expect([...a!.lanes]).toEqual(['engine-own']);
    expect([...a!.steps].sort()).toEqual(['model-step', 'scheduler', 'tickets']);
    expect([...b!.lanes]).toEqual(['helper']);
    expect([...b!.steps].sort()).toEqual(['model-step', 'scheduler']);
    expect([...c!.steps].sort()).toEqual(['capped-tickets', 'model-step', 'scheduler']);
    // The shared start and end of the request never turn blue.
    for (const x of [a!, b!, c!]) {
      expect(x.steps.has('handler')).toBe(false);
      expect(x.steps.has('wakes')).toBe(false);
    }
    // C's labelled flow into the capped queue is its own.
    expect(c!.flows.has(0)).toBe(true);
  });

  it('draws blue where the rule says, and nothing blue with fewer than two drawings of lanes', () => {
    const { state } = at(2);
    const { container } = render(<Picture item={item(state, 'spread')} state={state} />);
    const blue = [...container.querySelectorAll('[data-sub][data-blue]')].map((e) => e.getAttribute('data-sub'));
    expect(blue).toContain('step:c-capped-tickets');
    expect(blue).toContain('step:b-scheduler');
    expect(blue).not.toContain('step:a-handler');
    expect(blueOf([body([['x', 'a', 'post']]), { kind: 'free', title: 'f', risk: 'r', svg: '<svg viewBox="0 0 1 1"></svg>' }])[0]!.steps.size).toBe(0);
  });
});

/* ---------------------------------------------------------------- layout */

/**
 * An arrow in a lanes picture reads as an arrow: the line into its head is at least LAST heads
 * long, and each leg of an elbow at least LEG heads, so no leg is a stub that is mostly head.
 */
const LAST = 3;
const LEG = 2;

function noOverlap(rects: Rect[], what: string) {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      expect(overlaps(rects[i]!, rects[j]!), `${what}: boxes ${i} and ${j} overlap`).toBe(false);
    }
  }
}

describe('layout', () => {
  const bodies = (): Array<[string, LanesBody]> => {
    const out: Array<[string, LanesBody]> = [];
    for (const cp of checkpoints) {
      const { state } = at(cp.screen);
      for (const it of pictures(state)) {
        const p = it.picture;
        if (p.kind === 'lanes') out.push([it.id, p]);
        if (p.kind === 'spread') p.approaches.forEach((a, i) => a.kind !== 'free' && out.push([`${it.id}/${i}`, a]));
      }
    }
    const { state, items } = examplesBoard(true);
    for (const id of items) {
      const p = item(state, id).picture;
      if (p.kind === 'lanes') out.push([id, p]);
      if (p.kind === 'spread') p.approaches.forEach((a, i) => a.kind !== 'free' && out.push([`${id}/${i}`, a]));
    }
    // Hard cases: a loop back, pinned columns, an unnumbered tail, a divider, many steps in one lane.
    out.push([
      'loops',
      {
        lanes: [{ id: 'c', name: 'Client' }, { id: 'api', name: 'API thread' }, { id: 'e', name: 'Engine thread' }],
        steps: [
          { id: 's1', n: 1, lane: 'c', text: 'posts a request' },
          { id: 's2', n: 2, lane: 'api', text: 'handler starts' },
          { id: 's3', n: 3, lane: 'e', text: 'the engine takes it, plans the step, and runs it on the GPU' },
          { id: 's4', n: 4, lane: 'e', text: 'adds the token' },
          { id: 's5', n: 5, lane: 'api', text: 'wakes' },
          { id: 's6', lane: 'c', text: 'reads it' },
          { id: 's7', n: 7, lane: 'c', text: 'second call', col: 2 },
          { id: 's8', n: 8, lane: 'api', text: 'tool runs' },
        ],
        flows: [
          { from: 's1', to: 's2', label: 'POST' },
          { from: 's2', to: 's3', label: 'put' },
          { from: 's3', to: 's4' },
          { from: 's4', to: 's3', label: 'repeat per token' },
          { from: 's4', to: 's5', wait: true },
          { from: 's5', to: 's6' },
          { from: 's6', to: 's1', label: 'next turn' },
          { from: 's7', to: 's8' },
        ],
        divider: { before: 's7', label: 'round two' },
      },
    ]);
    // A loop back two columns, drawn under the boxes.
    out.push([
      'loop back',
      {
        lanes: [{ id: 'e', name: 'Engine thread' }, { id: 'g', name: 'GPU' }],
        steps: [
          { id: 't1', n: 1, lane: 'e', text: 'plans a step' },
          { id: 't2', n: 2, lane: 'g', text: 'runs it' },
          { id: 't3', n: 3, lane: 'e', text: 'reads the logits' },
          { id: 't4', n: 4, lane: 'e', text: 'adds the token' },
        ],
        flows: [
          { from: 't1', to: 't2' },
          { from: 't2', to: 't3' },
          { from: 't3', to: 't4' },
          { from: 't4', to: 't1', label: 'repeat per token', wait: true },
        ],
      },
    ]);
    return out;
  };

  it('never puts two step boxes on each other, flat or compact', () => {
    const all = bodies();
    expect(all.length).toBeGreaterThan(5);
    for (const [name, b] of all) {
      for (const compact of [false, true]) {
        const L = layoutLanes(b, compact);
        expect(L.boxes).toHaveLength(b.steps.length);
        noOverlap(L.boxes.map((x) => x.rect), `${name}${compact ? ' compact' : ''}`);
        for (const x of L.boxes) {
          expect(x.rect.x + x.rect.w, `${name}: a box stays inside`).toBeLessThanOrEqual(L.width);
          expect(x.rect.y + x.rect.h).toBeLessThanOrEqual(L.height);
        }
        // Numbered steps run left to right.
        const numbered = L.boxes.filter((x) => x.step.n !== undefined && x.step.col === undefined).sort((p, q) => p.step.n! - q.step.n!);
        for (let i = 1; i < numbered.length; i++) expect(numbered[i]!.col).toBeGreaterThanOrEqual(numbered[i - 1]!.col);
      }
    }
  });

  it('keeps every arrow label off every box', () => {
    for (const [name, b] of bodies()) {
      const L = layoutLanes(b, true);
      for (const a of L.arrows) {
        if (!a.at) continue;
        const label = { x: a.at.x - a.at.w / 2, y: a.at.y - a.at.h / 2, w: a.at.w, h: a.at.h };
        for (const x of L.boxes) expect(overlaps(label, x.rect), `${name}: label "${a.flow.label}" on ${x.step.id}`).toBe(false);
      }
    }
  });

  it('draws every arrow long enough to read as one, and through no box', () => {
    for (const [name, b] of bodies()) {
      for (const compact of [false, true]) {
        const L = layoutLanes(b, compact);
        for (const a of L.arrows) {
          const what = `${name}${compact ? ' compact' : ''}: ${a.flow.from} > ${a.flow.to}`;
          const head = HEAD * (a.flow.wait ? DASHED_WIDTH : LINE_WIDTH);
          const segs = a.r.pts.slice(1).map((p, i) => [a.r.pts[i]!, p] as const);
          const len = segs.map(([p, q]) => Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]));
          expect(len.at(-1)!, `${what}: the line into the head`).toBeGreaterThanOrEqual(LAST * head);
          if (len.length > 1) for (const l of len) expect(l, `${what}: a leg of the elbow`).toBeGreaterThanOrEqual(LEG * head);
          for (const [p, q] of segs) {
            const seg = { x: Math.min(p[0], q[0]), y: Math.min(p[1], q[1]), w: Math.abs(q[0] - p[0]), h: Math.abs(q[1] - p[1]) };
            for (const x of L.boxes) {
              const inner = { x: x.rect.x + 1, y: x.rect.y + 1, w: x.rect.w - 2, h: x.rect.h - 2 };
              expect(overlaps({ ...seg, w: seg.w || 0.01, h: seg.h || 0.01 }, inner), `${what}: through ${x.step.id}`).toBe(false);
            }
          }
        }
      }
    }
  });

  it('never puts two parts of the model on each other', () => {
    for (const cp of checkpoints.slice(2)) {
      const { state } = at(cp.screen);
      const pm = pipeModel(state, {});
      for (const M of [FLAT_FULL, FLAT_SMALL]) noOverlap(layoutFlat(pm, M).parts.map((x) => x.rect), `checkpoint ${cp.screen}`);
    }
  });

  it('lays a mini out with no box on another', () => {
    const { state } = at(2);
    for (const it of pictures(state)) if (it.picture.kind === 'mini') noOverlap(layoutMini(it.picture).boxes.map((b) => b.rect), it.id);
  });
});

/* -------------------------------------------------------------- markings */

describe('the owner\'s pen', () => {
  it('dims a crossed approach under a cross, and keeps an outline on a circled one', () => {
    const { state } = at(2);
    const m = markings(state).spread;
    expect(m?.crossed).toContain('approach:b');
    const { container } = render(<Picture item={item(state, 'spread')} state={state} markings={m} />);
    const b = container.querySelector('[data-sub="approach:b"]')!;
    expect(b.className).toContain('kp--crossed');
    expect(b.querySelector('.kp-crossover')).not.toBeNull();
    const a = container.querySelector('[data-sub="approach:a"]')!;
    expect(a.className).toContain('kp--circled');
    expect(a.querySelector('.kp-crossover')).toBeNull();
    // A circled step inside an approach is drawn with its own outline.
    const step = container.querySelector('[data-sub="step:a-model-step"]')!;
    expect(step.querySelector('rect[stroke="#C2410C"]')).not.toBeNull();
  });

  it('crosses out an option in a focus, and undoes it when the stroke is gone', () => {
    const { state } = at(4);
    const { container, rerender } = render(<Picture item={item(state, 'focus')} state={state} markings={markings(state).focus} />);
    expect(container.querySelector('[data-sub="option:cap-queue"]')!.className).toContain('kp--crossed');
    expect(container.querySelector('[data-sub="option:cap-door"]')!.className).toContain('kp--circled');
    rerender(<Picture item={item(state, 'focus')} state={state} markings={{ crossed: [], circled: [] }} />);
    expect(container.querySelector('[data-sub="option:cap-queue"]')!.className).not.toContain('kp--crossed');
  });
});

/* -------------------------------------------------------------- pipeline */

describe('the pipeline', () => {
  it('stays live: it redraws when a part changes state', () => {
    let { state } = at(5);
    const pipe = item(state, 'pipe');
    const look = (c: HTMLElement) => c.querySelector('[data-part="request"]')?.getAttribute('data-state');
    const { container, rerender } = render(<Picture item={pipe} state={state} />);
    expect(look(container)).toBe('solid');
    const r1 = admit(state, { type: 'build.start', chapter: 'engine-loop', track: ['request'], blueprint: 'blueprint', check: 'make check' }, 'owner', '2026-11-17T14:00:00Z');
    if (!r1.ok) throw new Error(r1.reason);
    const r2 = admit(r1.state, { type: 'part.state', part: 'request', state: 'building' }, 'agent', '2026-11-17T14:00:02Z');
    if (!r2.ok) throw new Error(r2.reason);
    state = r2.state;
    // The same item, the same spec: only the board changed.
    rerender(<Picture item={pipe} state={state} />);
    expect(look(container)).toBe('building');
    // "built" is reported by the build's hooks, so the system posts it, never the agent (R2).
    const r3 = admit(state, { type: 'part.state', part: 'request', state: 'built', commit: '658b4ec', check: { cmd: 'make check', passed: true } }, 'system', '2026-11-17T14:01:00Z');
    if (!r3.ok) throw new Error(r3.reason);
    rerender(<Picture item={pipe} state={r3.state} />);
    expect(look(container)).toBe('built');
    expect(container.textContent).toContain('658b4ec');
  });

  it('numbers the walk, and lights the step the owner\'s view names', () => {
    const { state } = at(3);
    const pipe = item(state, 'pipe');
    const { container, rerender } = render(<Picture item={pipe} state={state} />);
    expect(container.querySelector('[data-lit]')).toBeNull();
    expect(container.textContent).toContain('13');
    rerender(<Picture item={pipe} state={state} view={{ walk: { id: 'req-42', step: 8 } }} />);
    expect(container.querySelector('[data-lit]')?.getAttribute('data-part')).toBe('runner');
    rerender(<Picture item={pipe} state={state} view={{ walk: { id: 'other', step: 8 } }} />);
    expect(container.querySelector('[data-lit]')).toBeNull();
  });

  it('switches between Layers and Flat, and tells the board', () => {
    const { state } = at(3);
    const onAct = vi.fn();
    const { container } = render(<Picture item={item(state, 'pipe')} state={state} onAct={onAct} />);
    const root = () => container.querySelector('[data-view]')!;
    expect(root().getAttribute('data-view')).toBe('layers');
    fireEvent.click(container.querySelector('.kp-switch__btn:nth-child(2)')!);
    expect(onAct).toHaveBeenCalledWith({ type: 'view.pipeline', view: 'flat' });
    expect(root().getAttribute('data-view')).toBe('flat');
    expect(container.querySelector('[data-sub="part:runner"]')).not.toBeNull();
  });

  it('follows the board\'s view when the spec says none', () => {
    const { state } = examplesBoard();
    const flat = { ...item(state, 'a2'), picture: { kind: 'pipeline' as const } };
    const { container, rerender } = render(<Picture item={flat} state={state} view={{ pipeline: 'flat' }} />);
    expect(container.querySelector('[data-view]')!.getAttribute('data-view')).toBe('flat');
    rerender(<Picture item={flat} state={state} view={{ pipeline: 'layers' }} />);
    expect(container.querySelector('[data-view]')!.getAttribute('data-view')).toBe('layers');
  });

  it('leaves a part with no lane off the picture, and draws an outside part plain', () => {
    const { state } = at(5);
    const { container } = render(<Picture item={item(state, 'pipe')} state={state} />);
    expect(container.querySelector('[data-sub="part:same-tokens"]')).toBeNull();
    expect(container.querySelector('[data-part="clients"]')?.getAttribute('data-state')).toBe('outside');
  });

  it('draws a candidate model it carries, and not the board\'s', () => {
    const { state } = examplesBoard();
    const cand: PictureItem = {
      id: 'cand',
      kind: 'picture',
      picture: {
        kind: 'pipeline',
        view: 'flat',
        model: { lanes: [{ id: 'x', name: 'X' }], parts: [{ id: 'p1', name: 'One', lane: 'x', state: 'idea' }, { id: 'p2', name: 'Two', lane: 'x', state: 'idea' }], edges: [{ from: 'p1', to: 'p2' }] },
      },
    };
    const { container } = render(<Picture item={cand} state={state} />);
    expect(subsIn(container).sort()).toEqual(['lane:x', 'part:p1', 'part:p2']);
    expect(container.querySelector('[data-live]')).toBeNull();
  });
});

/* ------------------------------------------------------------------ walk */

describe('the walk player', () => {
  it('moves back and next, and tells the board each step', () => {
    const { state } = at(3);
    const onAct = vi.fn();
    const w = item(state, 'walk');
    const { container, getByLabelText, rerender } = render(<Picture item={w} state={state} onAct={onAct} view={{ walk: { id: 'req-42', step: 8 } }} />);
    expect(container.querySelector('[aria-current="step"]')?.getAttribute('data-sub')).toBe('step:8');
    fireEvent.click(getByLabelText('Next step'));
    expect(onAct).toHaveBeenLastCalledWith({ type: 'walk.step', walk: 'req-42', step: 9 });
    fireEvent.click(getByLabelText('Back one step'));
    expect(onAct).toHaveBeenLastCalledWith({ type: 'walk.step', walk: 'req-42', step: 7 });
    rerender(<Picture item={w} state={state} onAct={onAct} view={{ walk: { id: 'req-42', step: 13 } }} />);
    expect((getByLabelText('Next step') as HTMLButtonElement).disabled).toBe(true);
  });

  it('plays from the start on its own, one step at a time', () => {
    vi.useFakeTimers();
    try {
      const { state } = at(3);
      const onAct = vi.fn();
      const { getByLabelText, container } = render(<Picture item={item(state, 'walk')} state={state} onAct={onAct} />);
      fireEvent.click(getByLabelText('Play'));
      expect(onAct).toHaveBeenLastCalledWith({ type: 'walk.step', walk: 'req-42', step: 1 });
      act(() => vi.advanceTimersByTime(PLAY_MS * 2 + 10));
      expect(onAct).toHaveBeenLastCalledWith({ type: 'walk.step', walk: 'req-42', step: 3 });
      expect(container.querySelector('[aria-current="step"]')?.getAttribute('data-sub')).toBe('step:3');
      fireEvent.click(getByLabelText('Pause'));
      act(() => vi.advanceTimersByTime(PLAY_MS * 3));
      expect(onAct).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ------------------------------------------------------------- blueprint */

describe('the blueprint', () => {
  const button = (c: HTMLElement) => [...c.querySelectorAll('button')].find((b) => b.textContent === 'Build this');

  it('shows "Build this" while the chapter is solid, and starts the build with its track', () => {
    const { state } = at(5);
    expect(state.chapters['engine-loop']?.state).toBe('solid');
    const onAct = vi.fn();
    const { container } = render(<Picture item={item(state, 'blueprint')} state={state} onAct={onAct} />);
    const b = button(container);
    expect(b).toBeDefined();
    fireEvent.click(b!);
    expect(onAct).toHaveBeenCalledWith({
      type: 'build.start',
      chapter: 'engine-loop',
      track: ['request', 'scheduler', 'engine-loop', 'engine-client', 'try-it', 'same-tokens', 'roadmap-sentence'],
      blueprint: 'blueprint',
      check: 'make check',
    });
  });

  it('hides it while the idea is not solid, and once it builds, and shows the track filling in', () => {
    const idea = examplesBoard();
    expect(button(render(<Picture item={item(idea.state, 'ex-blueprint')} state={idea.state} onAct={() => {}} />).container)).toBeUndefined();
    cleanup();
    const { state } = at(6);
    const { container } = render(<Picture item={item(state, 'blueprint')} state={state} onAct={() => {}} />);
    expect(button(container)).toBeUndefined();
    expect(container.textContent).toContain('2 of 7 built');
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('2');
    cleanup();
    const done = at(7).state;
    expect(render(<Picture item={item(done, 'blueprint')} state={done} />).container.textContent).toContain('7 of 7 built');
  });

  it('says where each pick came from, and shows the parts with no lane on the track', () => {
    const { state } = at(5);
    const { container } = render(<Picture item={item(state, 'blueprint')} state={state} />);
    expect(container.querySelector('[data-sub="pick:1"]')?.textContent).toContain('from your circle on A');
    expect(container.querySelector('[data-sub="pick:3"]')?.textContent).toContain('from your note on the model step');
    expect(container.querySelector('[data-sub="part:same-tokens"]')?.textContent).toContain('Same tokens');
  });
});

/* ---------------------------------------------------------------- choice */

describe('the choice', () => {
  it('shows the option in force from the board, and lets the owner change it', () => {
    const { state } = at(6);
    const onAct = vi.fn();
    const ch = item(state, 'choice');
    const { container, rerender } = render(<Picture item={ch} state={state} onAct={onAct} />);
    expect(container.querySelector('[data-chosen]')?.getAttribute('data-chosen')).toBe('together');
    expect(container.textContent).toContain('yours to change');
    fireEvent.click(container.querySelector('[data-sub="option:apart"] button')!);
    expect(onAct).toHaveBeenCalledWith({ type: 'choice.pick', item: 'choice', option: 'apart' });
    const r = admit(state, { type: 'choice.pick', item: 'choice', option: 'apart' }, 'owner', '2026-11-17T15:00:00Z');
    if (!r.ok) throw new Error(r.reason);
    rerender(<Picture item={ch} state={r.state} onAct={onAct} />);
    expect(container.querySelector('[data-chosen]')?.getAttribute('data-chosen')).toBe('apart');
    expect(container.querySelector('[data-sub="option:apart"]')?.textContent).toContain('your pick');
  });
});

/* ------------------------------------------------------------------ free */

describe('a free picture', () => {
  it('is an image from a data URL, so nothing in it runs', () => {
    const { state } = examplesBoard();
    const { container } = render(<Picture item={item(state, 'ex-free')} state={state} />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(img.getAttribute('width')).toBe('200');
    expect(img.getAttribute('height')).toBe('400');
    expect(container.querySelector('svg rect[stroke="#0F1B2D"]')).toBeNull();
    expect(container.querySelector('[data-sub]')).toBeNull();
  });
});
