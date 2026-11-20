import { cleanup, render } from '@testing-library/react';
import type { BoardState, PictureItem } from '@keel/protocol';
import { emptyState, markings } from '@keel/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { BuildPart, PictureView } from '../src';
import { DRAWN_KINDS, Drawing, PART_KINDS, Picture, Plain, buildParts } from '../src';
import { examplesBoard } from './examples';
import { at, checkpoints, item, pictures } from './fixture';

afterEach(cleanup);

/** A picture drawn on its own, and its root element. */
function draw(it: PictureItem, state: BoardState, view: PictureView = {}): Element {
  const { container } = render(<Picture item={it} state={state} markings={markings(state)[it.id]} view={view} onAct={() => {}} />);
  return container.firstElementChild!;
}

/** Every picture there is to check: each kind's example, the stress pictures, the fixture at each checkpoint in both pipeline views, the placeholder and the plain card. */
function* everyPicture(): Generator<[string, Element]> {
  const ex = examplesBoard(true);
  for (const id of ex.items) yield [id, draw(item(ex.state, id), ex.state)];
  for (const cp of checkpoints) {
    const { state } = at(cp.screen);
    for (const it of pictures(state)) {
      const views: PictureView[] = it.picture.kind === 'pipeline' ? [{ pipeline: 'layers' }, { pipeline: 'flat' }] : [{ ...(cp.view.walk ? { walk: cp.view.walk } : {}) }];
      for (const view of views) yield [`at ${cp.screen} ${it.id}${view.pipeline ? ` ${view.pipeline}` : ''}`, draw(it, state, view)];
    }
  }
  const text = item(ex.state, 'ex-text');
  yield ['placeholder', render(<Drawing spec={text.picture} />).container.firstElementChild!];
  yield ['plain card', render(<Plain item={item(ex.state, 'ex-mini')} state={ex.state} />).container.firstElementChild!];
}

const kinds = (parts: BuildPart[]) => parts.map((p) => `${p.kind} ${p.depth}`);

/** The part an element belongs to: itself, or the nearest part around it. */
const partOf = (el: Element) => el.closest('[data-build]');

/** What a mark on it names, for a shape: its own sub, or the one inside it. */
const subOf = (el: Element) => el.getAttribute('data-sub') ?? el.querySelector('[data-sub]')?.getAttribute('data-sub');

/**
 * What shows on a frame outside every part, so it would land with the paper all at once:
 * words, and elements with nothing inside them (a bar, an image, a stroke of an SVG).
 */
function loose(root: Element): string[] {
  const out: string[] = [];
  const visit = (node: Node, held: boolean) => {
    if (node.nodeType === node.TEXT_NODE) {
      if (!held && node.textContent?.trim()) out.push(`"${node.textContent.trim()}"`);
      return;
    }
    if (node.nodeType !== node.ELEMENT_NODE) return;
    const el = node as Element;
    // Nothing in these is drawn where it stands.
    if (['defs', 'title', 'desc'].includes(el.tagName.toLowerCase())) return;
    const kind = el.getAttribute('data-build');
    const inPart = kind ? kind !== 'frame' : held;
    if (!inPart && el.children.length === 0 && !el.textContent?.trim()) out.push(`<${el.tagName.toLowerCase()} class="${el.getAttribute('class') ?? ''}">`);
    for (const c of el.childNodes) visit(c, inPart);
  };
  visit(root, false);
  return out;
}

describe('the parts of a picture', () => {
  it('start with the picture\'s root, a frame at depth 0', () => {
    for (const [name, root] of everyPicture()) {
      const parts = buildParts(root);
      expect(parts[0]?.el, name).toBe(root);
      expect(parts[0]?.kind, name).toBe('frame');
      expect(parts[0]?.depth, name).toBe(0);
    }
  });

  it('hold everything that shows: nothing on a frame is outside a part', () => {
    for (const [name, root] of everyPicture()) expect(loose(root), name).toEqual([]);
  });

  it('catch a thing a renderer adds to a frame and does not mark', () => {
    const { state } = examplesBoard();
    const root = draw(item(state, 'ex-mini'), state);
    expect(loose(root)).toEqual([]);
    const note = root.ownerDocument.createElement('p');
    note.textContent = 'A line nobody marked.';
    root.append(note);
    expect(loose(root)).toEqual(['"A line nobody marked."']);
    note.remove();
    // A bare box added to the drawing.
    root.querySelector('svg.kp-svg')!.append(root.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'rect'));
    expect(loose(root)).toEqual(['<rect class="">']);
  });

  it('make every sub a part, or put it inside one that is not a frame', () => {
    for (const [name, root] of everyPicture()) {
      for (const el of root.querySelectorAll('[data-sub]')) {
        const part = partOf(el);
        const sub = el.getAttribute('data-sub');
        expect(part, `${name}: ${sub}`).not.toBeNull();
        expect(part === el || part!.getAttribute('data-build') !== 'frame', `${name}: ${sub} is in a part`).toBe(true);
      }
    }
  });

  it('list each part once, of a kind they know, and only a frame holds parts', () => {
    for (const [name, root] of everyPicture()) {
      const parts = buildParts(root);
      expect(new Set(parts.map((p) => p.el)).size, name).toBe(parts.length);
      expect(parts.length, `${name}: every mark is listed`).toBe(root.querySelectorAll('[data-build]').length + 1);
      for (const p of parts) {
        expect(PART_KINDS, name).toContain(p.kind);
        if (p.kind !== 'frame') expect(p.el.querySelector('[data-build]'), `${name}: a ${p.kind} holds no part`).toBeNull();
      }
    }
  });

  it('give each frame one head at most, the first part on it', () => {
    for (const [name, root] of everyPicture()) {
      const parts = buildParts(root);
      parts.forEach((p, i) => {
        if (p.kind !== 'head') return;
        const frame = p.el.parentElement!.closest('[data-build="frame"]');
        expect(parts[i - 1]?.el, `${name}: a head follows its frame`).toBe(frame);
      });
    }
  });

  it('come after the frame they sit on, one deeper', () => {
    for (const [name, root] of everyPicture()) {
      const parts = buildParts(root);
      const place = new Map(parts.map((p, i) => [p.el, i]));
      for (const p of parts.slice(1)) {
        const frame = p.el.parentElement!.closest('[data-build="frame"]')!;
        expect(place.get(frame)!, name).toBeLessThan(place.get(p.el)!);
        expect(p.depth, name).toBe(parts[place.get(frame)!]!.depth + 1);
      }
    }
  });

  it('draw a drawing\'s shapes first, then its lines, then its labels, together', () => {
    const turn = { shape: 0, line: 1, label: 2 } as Record<string, number>;
    let drawings = 0;
    for (const [name, root] of everyPicture()) {
      const parts = buildParts(root);
      for (const svg of root.querySelectorAll('svg')) {
        const mine = parts.flatMap((p, i) => (p.el.closest('svg') === svg && p.kind in turn ? [{ p, i }] : []));
        if (mine.length === 0) continue;
        drawings++;
        // Together: no other part comes in the middle of a drawing.
        expect(mine.at(-1)!.i - mine[0]!.i + 1, name).toBe(mine.length);
        const turns = mine.map(({ p }) => turn[p.kind]!);
        expect(turns, name).toEqual([...turns].sort((a, b) => a - b));
      }
    }
    expect(drawings).toBeGreaterThan(40);
  });

  it('say which lines are dashed', () => {
    const { state } = examplesBoard();
    const lines = buildParts(draw(item(state, 'ex-lanes'), state)).filter((p) => p.kind === 'line');
    // The arrow into the wait, and the divider.
    expect(lines.map((l) => l.dashed)).toEqual([false, true, true]);
    for (const l of lines) expect(l.dashed).toBe(l.el.getAttribute('stroke-dasharray') !== null);
  });

  it('are none in an element with no part', () => {
    const doc = document;
    expect(buildParts(doc.createElement('div'))).toEqual([]);
    const foreign = doc.createElement('section');
    foreign.innerHTML = '<h3>A title</h3><p data-build="paragraph">Not a kind of part.</p><svg><rect width="4" height="4"/></svg>';
    expect(buildParts(foreign)).toEqual([]);
  });

  it('cover every kind the package draws', () => {
    const { state, items } = examplesBoard();
    const drawn = items.map((id) => draw(item(state, id), state).getAttribute('data-kind'));
    expect([...drawn].sort()).toEqual([...DRAWN_KINDS].sort());
  });
});

describe('the order a picture is drawn on in', () => {
  const ex = examplesBoard();
  const partsOf = (id: string) => buildParts(draw(item(ex.state, id), ex.state));

  it('of a text card: the card, its head, then each line of words', () => {
    // The body, the lean, two questions.
    expect(kinds(partsOf('ex-text'))).toEqual(['frame 0', 'head 1', 'block 1', 'block 1', 'block 1', 'block 1']);
  });

  it('of a mini: the boxes, then the arrow, though the arrow is painted first', () => {
    const parts = partsOf('ex-mini');
    expect(kinds(parts)).toEqual(['frame 0', 'head 1', 'shape 1', 'shape 1', 'shape 1', 'line 1']);
    expect(parts.slice(2, 5).map((p) => subOf(p.el))).toEqual(['box:1', 'box:2', 'box:3']);
    const svg = parts[2]!.el.closest('svg')!;
    expect(svg.querySelector('[data-build]')).toBe(parts[5]!.el);
  });

  it('of a spread: each approach a sheet of its own, built in turn', () => {
    const approach = ['frame 1', 'head 2', ...Array(5).fill('shape 2'), 'line 2', 'line 2', 'label 2', 'label 2', 'block 2'];
    expect(kinds(partsOf('ex-spread'))).toEqual([
      'frame 0',
      'head 1',
      ...approach,
      ...approach,
      // The free drawing: one image, then its risk.
      'frame 1',
      'head 2',
      'block 2',
      'block 2',
    ]);
  });

  it('of lanes: the lanes, the steps by column, the arrows by the step they leave, the divider last', () => {
    const lanes: PictureItem = {
      id: 'order',
      kind: 'picture',
      picture: {
        kind: 'lanes',
        title: 'Listed out of order',
        lanes: [{ id: 'client', name: 'Client' }, { id: 'api', name: 'API thread' }],
        steps: [
          { id: 'reply', n: 3, lane: 'client', text: 'sees "2"' },
          { id: 'post', n: 1, lane: 'client', text: 'posts' },
          { id: 'start', n: 2, lane: 'api', text: 'starts' },
        ],
        flows: [{ from: 'start', to: 'reply', label: 'back' }, { from: 'post', to: 'start', label: 'POST' }],
        divider: { before: 'reply', label: 'later' },
      },
    };
    const parts = buildParts(draw(lanes, emptyState()));
    const shapes = parts.filter((p) => p.kind === 'shape').map((p) => subOf(p.el));
    expect(shapes).toEqual(['lane:client', 'lane:api', 'step:post', 'step:start', 'step:reply']);
    const lines = parts.filter((p) => p.kind === 'line').map((p) => p.el.parentElement!.getAttribute('data-flow') ?? 'divider');
    expect(lines).toEqual(['post>start', 'start>reply', 'divider']);
    const labels = parts.filter((p) => p.kind === 'label').map((p) => p.el.textContent);
    expect(labels).toEqual(['POST', 'back', 'later']);
  });

  it('of a pipeline, in both views: the lanes, the parts by column, the arrows by the part they leave', () => {
    const model = {
      lanes: [{ id: 'x', name: 'X' }, { id: 'y', name: 'Y' }],
      parts: [
        { id: 'c', name: 'Three', lane: 'x', state: 'idea' as const, col: 3 },
        { id: 'a', name: 'One', lane: 'y', state: 'idea' as const, col: 1 },
        { id: 'b', name: 'Two', lane: 'x', state: 'idea' as const, col: 2 },
      ],
      edges: [{ from: 'b', to: 'c' }, { from: 'a', to: 'b' }],
    };
    for (const view of ['layers', 'flat'] as const) {
      const pipe: PictureItem = { id: 'pipe', kind: 'picture', picture: { kind: 'pipeline', view, model } };
      const root = draw(pipe, emptyState());
      const parts = buildParts(root);
      const shapes = parts.filter((p) => p.kind === 'shape').map((p) => subOf(p.el));
      expect(shapes, view).toEqual(['lane:x', 'lane:y', 'part:a', 'part:b', 'part:c']);
      // The arrows are painted b>c, then a>b; a>b is drawn on first.
      const painted = [...root.querySelectorAll('[data-build="line"]')];
      expect(parts.filter((p) => p.kind === 'line').map((p) => p.el), view).toEqual([painted[1], painted[0]]);
    }
  });

  it('of a mini whose boxes are listed against their columns: by column, then down', () => {
    const mini: PictureItem = {
      id: 'mini',
      kind: 'picture',
      picture: { kind: 'mini', title: 'Back and on', boxes: [{ text: 'A' }, { text: 'B' }, { text: 'C' }], flows: [{ from: 3, to: 1 }, { from: 1, to: 2 }] },
    };
    const root = draw(mini, emptyState());
    const parts = buildParts(root);
    // A and C share the first column, A above C; B stands in the second.
    expect(parts.filter((p) => p.kind === 'shape').map((p) => subOf(p.el))).toEqual(['box:1', 'box:3', 'box:2']);
    const painted = [...root.querySelectorAll('[data-build="line"]')];
    expect(parts.filter((p) => p.kind === 'line').map((p) => p.el)).toEqual([painted[1], painted[0]]);
  });
});
