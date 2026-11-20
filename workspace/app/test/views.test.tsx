import type { BoardEvent } from '@keel/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, PEN_PAUSE } from '../src/App';
import { localSource } from '../src/source';
import { CH, note, openBoard, placeAt, text } from './helpers';

/**
 * The board after the review: reads with no picture, the calm lineage, moves that keep a
 * mark's id, the nudge for what arrives out of view, the walk on the arrow keys, and the
 * focus view. The pictures are a test double that draws a few `data-sub` things.
 */
vi.mock('@keel/pictures', () => ({
  Star: () => null,
  StateChip: ({ state }: { state: string }) => createElement('span', { className: 'k-state' }, state),
  Picture: ({ item, view, onAct }: { item: { id: string; picture: { kind: string } }; view?: { walk?: { id: string; step: number } }; onAct?: (a: unknown) => void }) =>
    createElement(
      'div',
      { 'data-double': item.id, 'data-walk': view?.walk ? `${view.walk.id}:${view.walk.step}` : '', style: { width: '300px', height: '200px' } },
      createElement('div', { 'data-sub': 'lane:bridge', onClick: () => onAct?.({ type: 'tap', item: item.id, sub: 'lane:bridge' }) }, 'the bridge'),
      createElement('div', { 'data-sub': 'option:cap-door' }, 'cap the door'),
    ),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const posted = (src: { events: BoardEvent[] }, from: number) => src.events.slice(from);

/** The camera, read back from the world's transform: screen = world * z + (x, y). */
function camera(container: HTMLElement) {
  const t = container.querySelector<HTMLElement>('.world')!.style.transform;
  const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(t)!;
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}
const toScreen = (container: HTMLElement, wx: number, wy: number) => {
  const c = camera(container);
  return { clientX: wx * c.z + c.x, clientY: wy * c.z + c.y };
};

/** A board with a model (a bridge lane, a walk of three steps), a note and two pictures. */
function board() {
  const b = openBoard();
  b.must('agent', {
    type: 'model.patch',
    ops: [
      { op: 'lane.set', lane: { id: 'bridge', name: 'The bridge' } },
      { op: 'part.set', part: { id: 'queue', name: 'Inbound queue', lane: 'bridge' } },
      { op: 'part.set', part: { id: 'out', name: 'Output queues', lane: 'bridge' } },
      {
        op: 'walk.set',
        walk: {
          id: 'req-42',
          name: 'Follow one request',
          steps: [
            { n: 1, part: 'queue', text: 'a ticket goes in' },
            { n: 2, part: 'out', text: 'a token comes out' },
            { n: 3, part: 'queue', text: 'the end' },
          ],
        },
      },
    ],
  });
  b.must('owner', note('m1', [0, 0, 320, 100]));
  b.must('agent', { type: 'item.add', chapter: CH, item: { id: 'pipe', kind: 'picture', picture: { kind: 'pipeline', title: 'Your pick', walk: 'req-42' }, answers: ['m1'] } });
  b.must('owner', placeAt('pipe', [400, 0, 600, 300]));
  b.must('agent', { type: 'item.add', chapter: CH, item: { id: 'walk', kind: 'picture', picture: { kind: 'walk', walk: 'req-42' }, from: ['pipe'], place: { near: 'pipe', side: 'right' } } });
  b.must('owner', placeAt('walk', [1048, 0, 300, 400]));
  return b;
}

describe('the toolbar says what each tool is, and what cannot work yet', () => {
  it('every tool has its word, and Solidify is a real button that says it waits for a lasso', () => {
    const { container } = render(<App source={localSource({ events: board().events })} />);
    const words = [...container.querySelectorAll('.toolbar .tool__word')].map((w) => w.textContent);
    expect(words).toEqual(['Select', 'Pan', 'Pen', 'Box', 'Arrow', 'Note', 'Pin', 'Lasso', 'Erase', 'Drop in', 'Talk']);
    const solidify = container.querySelector<HTMLButtonElement>('[data-tool="solidify"]')!;
    expect(solidify.tagName).toBe('BUTTON');
    expect(solidify.className).toBe('solidify');
    expect(solidify.textContent).toBe('Solidifylasso first');
    expect(solidify.querySelector('svg')).toBeNull();
    // Talk cannot listen in the test DOM: it is drawn off, and the others are not.
    expect(container.querySelector('[data-tool="talk"]')!.className).toContain('tool--off');
    expect(container.querySelector('[data-tool="pen"]')!.className).not.toContain('tool--off');
  });

  it('Solidify ready shows how many it holds', () => {
    const b = board();
    b.must('owner', { type: 'item.add', chapter: CH, item: { id: 'l1', kind: 'lasso', box: [0, 0, 1000, 300], path: [0, 0, 1000, 0, 1000, 300], targets: [{ item: 'm1' }, { item: 'pipe' }] } });
    const { container } = render(<App source={localSource({ events: b.events })} />);
    const solidify = container.querySelector<HTMLButtonElement>('[data-tool="solidify"]')!;
    expect(solidify.className).toContain('solidify--ready');
    expect(solidify.querySelector('.solidify__n')!.textContent).toBe('2');
  });
});

describe('the presence pill says why', () => {
  it('says the reason when the agent is away', () => {
    render(<App source={localSource({ events: board().events, presence: { state: 'away', note: 'the agent did not answer: it timed out after 120 s' } })} />);
    expect(screen.getByTestId('presence').textContent).toBe('The agent: away · the agent did not answer: it timed out after 120 s');
  });

  it('says a long note in the pill when no cursor says it', () => {
    const note = 'I can see many clients, a middle and a model. Keep going. I will draw when you pause.';
    render(<App source={localSource({ events: board().events, presence: { state: 'listening', note } })} />);
    expect(screen.getByTestId('presence').textContent).toContain(note);
  });
});

describe('an answer with no picture', () => {
  it('shows as a small agent chip under the first mark it answers', () => {
    const b = board();
    b.must('owner', { type: 'item.add', chapter: CH, item: { id: 'm2', kind: 'ink', box: [400, 100, 600, 60], strokes: [{ pts: [0, 0, 600, 60] }], targets: [{ item: 'pipe', sub: 'lane:bridge' }], hint: 'circle' } });
    b.must('agent', { type: 'answer', answers: ['m2'], read: 'Open the bridge' });
    const { container } = render(<App source={localSource({ events: b.events })} />);
    const chip = container.querySelector<HTMLElement>('.read-chip')!;
    expect(chip.textContent).toBe('read as:Open the bridge');
    expect(chip.dataset.mark).toBe('m2');
    expect([chip.style.left, chip.style.top]).toEqual(['700px', '166px']);
  });
});

describe('lineage, calmer', () => {
  it('draws one arrow into a picture, and the others when it is hovered or selected', () => {
    const b = board();
    b.must('owner', note('m3', [0, 600, 320, 100]));
    b.must('agent', { type: 'item.add', chapter: CH, item: { id: 'a2', kind: 'picture', picture: { kind: 'text', title: 'Two' }, from: ['pipe', 'walk'], answers: ['m3'], place: { near: 'm3', side: 'right' } } });
    b.must('owner', placeAt('a2', [400, 600, 300, 200]));
    const { container } = render(<App source={localSource({ events: b.events })} />);
    const into = () => [...container.querySelectorAll<SVGPathElement>('[data-lineage$=">a2"]')].map((p) => p.getAttribute('data-lineage'));
    expect(into()).toEqual(['m3>a2']);
    fireEvent.pointerOver(container.querySelector('[data-double="a2"]')!);
    expect(into().sort()).toEqual(['m3>a2', 'pipe>a2', 'walk>a2']);
    fireEvent.pointerLeave(screen.getByTestId('board'));
    expect(into()).toEqual(['m3>a2']);
    const pic = container.querySelector('[data-double="a2"]')!;
    fireEvent.pointerDown(pic, { clientX: 0, clientY: 0, pointerId: 1, button: 0 });
    fireEvent.pointerUp(pic, { clientX: 0, clientY: 0, pointerId: 1, button: 0 });
    expect(into()).toHaveLength(3);
  });
});

describe('a move keeps a mark’s id', () => {
  it('free ink dragged elsewhere is one item.update of its box', async () => {
    const b = board();
    b.must('owner', { type: 'item.add', chapter: CH, item: { id: 'm5', kind: 'ink', box: [0, 600, 200, 100], strokes: [{ pts: [0, 0, 200, 100], w: 4 }], targets: [], hint: 'none' } });
    const src = localSource({ events: b.events });
    const { container } = render(<App source={src} />);
    const n = src.events.length;
    const z = camera(container).z;
    const from = toScreen(container, 100, 650);
    const el = screen.getByTestId('board');
    fireEvent.pointerDown(el, { ...from, pointerId: 1, button: 0 });
    fireEvent.pointerMove(el, { clientX: from.clientX + 30, clientY: from.clientY + 20, pointerId: 1, buttons: 1 });
    fireEvent.pointerMove(el, { clientX: from.clientX + 60, clientY: from.clientY + 40, pointerId: 1, buttons: 1 });
    await act(async () => {
      fireEvent.pointerUp(el, { clientX: from.clientX + 60, clientY: from.clientY + 40, pointerId: 1, button: 0 });
    });
    const since = posted(src, n);
    expect(since.map((e) => e.type)).toEqual(['item.update']);
    const box = (since[0] as { patch: { box: number[] } }).patch.box;
    expect(since[0]).toMatchObject({ item: 'm5' });
    expect(Math.abs(box[0]! - 60 / z)).toBeLessThanOrEqual(1);
    expect(Math.abs(box[1]! - (600 + 40 / z))).toBeLessThanOrEqual(1);
    expect(box.slice(2)).toEqual([200, 100]);
    expect(src.state.items.m5!.item).toMatchObject({ kind: 'ink', strokes: [{ pts: [0, 0, 200, 100] }] });
  });
});

describe('the walk plays with the arrow keys when its picture is selected', () => {
  it('steps on and back, and every picture that shows the walk gets the step', () => {
    const { container } = render(<App source={localSource({ events: board().events })} />);
    const walk = container.querySelector('[data-double="walk"]')!;
    // Nothing selected: the keys do nothing.
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(container.querySelector<HTMLElement>('[data-double="pipe"]')!.dataset.walk).toBe('');
    fireEvent.pointerDown(walk, { clientX: 0, clientY: 0, pointerId: 1, button: 0 });
    fireEvent.pointerUp(walk, { clientX: 0, clientY: 0, pointerId: 1, button: 0 });
    const step = () => container.querySelector<HTMLElement>('[data-double="pipe"]')!.dataset.walk;
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(step()).toBe('req-42:1');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(step()).toBe('req-42:3');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(step()).toBe('req-42:3');
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(step()).toBe('req-42:2');
    expect(container.querySelector<HTMLElement>('[data-double="walk"]')!.dataset.walk).toBe('req-42:2');
  });
});

describe('the focus view', () => {
  const focusItem = (answers: string[]) => ({
    type: 'item.add',
    chapter: CH,
    item: { id: 'focus', kind: 'picture', picture: { kind: 'focus', lane: 'bridge' }, from: ['pipe'], answers },
  });

  it('a tap on a lane with no focus asks, says the agent is opening it, and opens it when it arrives', async () => {
    const src = localSource({ events: board().events });
    const { container } = render(<App source={src} />);
    const n = src.events.length;
    await act(async () => {
      fireEvent.click(container.querySelector('[data-double="pipe"] [data-sub="lane:bridge"]')!);
    });
    const ask = posted(src, n)[0]!;
    expect(ask).toMatchObject({ type: 'ask', lane: 'bridge', item: 'pipe' });
    expect(screen.getByTestId('focus-opening').textContent).toContain('The agent is opening the bridge');
    await act(async () => {
      await src.postAs('agent', focusItem([ask.id]) as never);
    });
    // The app placed it, then opened it.
    expect(src.state.items.focus!.item.box).toBeTruthy();
    expect(screen.queryByTestId('focus-opening')).toBeNull();
    const crumb = screen.getByTestId('focus-crumb');
    expect(crumb.textContent).toContain('Pipeline');
    expect(crumb.textContent).toContain('The bridge');
    expect(crumb.textContent).toContain('2 parts · Esc goes back');
    // The crumb goes back.
    fireEvent.click(screen.getByRole('button', { name: /Pipeline/ }));
    expect(screen.queryByTestId('focus-crumb')).toBeNull();
  });

  it('stops waiting, and says so, when the agent answers the ask without a focus', async () => {
    const src = localSource({ events: board().events });
    const { container } = render(<App source={src} />);
    const n = src.events.length;
    await act(async () => {
      fireEvent.click(container.querySelector('[data-double="pipe"] [data-sub="lane:bridge"]')!);
    });
    const ask = posted(src, n)[0]!;
    await act(async () => {
      await src.postAs('agent', { type: 'answer', answers: [ask.id], read: 'two queues, nothing more inside yet' } as never);
    });
    expect(screen.queryByTestId('focus-opening')).toBeNull();
    expect(screen.getByTestId('toast').textContent).toContain('The agent did not open the bridge: two queues, nothing more inside yet');
  });

  it('never opens while the owner is drawing: it waits for the pen to rest', async () => {
    vi.useFakeTimers();
    const src = localSource({ events: board().events });
    const { container } = render(<App source={src} />);
    const n = src.events.length;
    await act(async () => {
      fireEvent.click(container.querySelector('[data-double="pipe"] [data-sub="lane:bridge"]')!);
    });
    const ask = posted(src, n)[0]!;
    fireEvent.keyDown(window, { key: 'p' });
    const el = screen.getByTestId('board');
    const at = toScreen(container, 100, 900);
    fireEvent.pointerDown(el, { ...at, pointerId: 1, button: 0, buttons: 1 });
    fireEvent.pointerMove(el, { clientX: at.clientX + 40, clientY: at.clientY + 10, pointerId: 1, buttons: 1 });
    const before = container.querySelector<HTMLElement>('.world')!.style.transform;
    await act(async () => {
      await src.postAs('agent', focusItem([ask.id]) as never);
    });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByTestId('focus-crumb')).toBeNull();
    expect(container.querySelector<HTMLElement>('.world')!.style.transform).toBe(before);
    fireEvent.pointerUp(el, { clientX: at.clientX + 80, clientY: at.clientY + 20, pointerId: 1, button: 0 });
    await act(async () => {
      vi.advanceTimersByTime(PEN_PAUSE + 100);
    });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId('focus-crumb')).toBeTruthy();
  });

  it('opens at load when the checkpoint says so; a mark made in it stays above the dim', async () => {
    const b = board();
    b.must('owner', { type: 'ask', what: 'focus', lane: 'bridge', item: 'pipe' });
    b.must('agent', focusItem([b.events[b.events.length - 1]!.id]));
    b.must('owner', placeAt('focus', [400, 500, 900, 500]));
    const src = localSource({ events: b.events });
    const { container } = render(<App source={src} focus="focus" />);
    expect(container.querySelector('.app')!.getAttribute('data-focus')).toBe('focus');
    expect(container.querySelector('[data-item="focus"]')!.className).toContain('item--raised');
    expect(container.querySelector('[data-item="pipe"]')!.className).not.toContain('item--raised');
    // A note written in the focus view, beside the picture, is raised with it.
    fireEvent.keyDown(window, { key: 'n' });
    const at = toScreen(container, 1350, 600);
    fireEvent.pointerDown(screen.getByTestId('board'), { ...at, pointerId: 1, button: 0 });
    fireEvent.pointerUp(screen.getByTestId('board'), { ...at, pointerId: 1, button: 0 });
    fireEvent.change(screen.getByRole('textbox', { name: 'Your note' }), { target: { value: 'what if this fills up?' } });
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Your note' }), { key: 'Enter' });
    });
    const id = src.events[src.events.length - 1]!.type === 'item.add' ? (src.events[src.events.length - 1] as { item: { id: string } }).item.id : '';
    expect(container.querySelector(`[data-item="${id}"]`)!.className).toContain('item--raised');
  });
});

describe('what the agent draws out of view', () => {
  it('is a quiet nudge that goes there when pressed; the view never moves by itself', async () => {
    const b = board();
    b.must('owner', note('m9', [9000, 9000, 320, 100]));
    const src = localSource({ events: b.events });
    // The first view shows the note and the pipeline, not the far note.
    const { container } = render(<App source={src} show={['m1', 'pipe']} />);
    expect(screen.queryByTestId('nudge')).toBeNull();
    const before = container.querySelector<HTMLElement>('.world')!.style.transform;
    await act(async () => {
      await src.postAs('agent', text('far', { answers: ['m9'], place: { near: 'm9', side: 'right' } }) as never);
    });
    // The app placed it beside the far note, out of view.
    expect(src.state.items.far!.item.box![0]).toBeGreaterThan(9000);
    expect(container.querySelector<HTMLElement>('.world')!.style.transform).toBe(before);
    const nudge = screen.getByTestId('nudge');
    expect(nudge.textContent).toContain('New from the agent: card far');
    await act(async () => {
      fireEvent.click(nudge);
    });
    expect(container.querySelector<HTMLElement>('.world')!.style.transform).not.toBe(before);
    expect(screen.queryByTestId('nudge')).toBeNull();
  });

  it('says nothing about a picture that lands in view', async () => {
    const src = localSource({ events: board().events });
    render(<App source={src} />);
    await act(async () => {
      await src.postAs('agent', text('near', { answers: ['m1'] }) as never);
      await src.postAs('system', { type: 'item.place', item: 'near', box: [0, 120, 200, 100] } as never);
    });
    expect(screen.queryByTestId('nudge')).toBeNull();
  });
});
