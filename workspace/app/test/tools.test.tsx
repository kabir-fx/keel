import type { BoardEvent } from '@keel/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, NOTE_WHERE, PEN_PAUSE } from '../src/App';
import { localSource } from '../src/source';
import { NO_SPEECH } from '../src/speech';
import { CH, note, openBoard, placeAt, text } from './helpers';

/**
 * The owner's tools in the app, in a test DOM. The pictures are a test double: each draws a few
 * `data-sub` things and buttons that send the acts of the seam (`types.ts`), so the app's side
 * of every act is tested without any renderer.
 */
vi.mock('@keel/pictures', () => ({
  Star: () => null,
  StateChip: ({ state }: { state: string }) => createElement('span', { className: 'k-state' }, state),
  Picture: ({ item, view, onAct }: { item: { id: string }; view?: { walk?: { id: string; step: number }; pipeline?: string }; onAct?: (a: unknown) => void }) =>
    createElement(
      'div',
      { 'data-double': item.id, 'data-walk': view?.walk ? `${view.walk.id}:${view.walk.step}` : '', 'data-pipeline': view?.pipeline ?? '' },
      createElement('div', { 'data-sub': 'part:queue', onClick: () => onAct?.({ type: 'tap', item: item.id, sub: 'part:queue' }) }, 'the queue'),
      createElement('div', { 'data-sub': 'lane:bridge', onClick: () => onAct?.({ type: 'tap', item: item.id, sub: 'lane:bridge' }) }, 'the bridge'),
      createElement('div', { 'data-sub': 'q:1', onClick: () => onAct?.({ type: 'tap', item: item.id, sub: 'q:1' }) }, 'a question'),
      createElement('div', { 'data-sub': 'step:5' }, 'step 5'),
      createElement('button', { type: 'button', onClick: () => onAct?.({ type: 'walk.step', walk: 'w1', step: 5 }) }, `next step ${item.id}`),
      createElement('button', { type: 'button', onClick: () => onAct?.({ type: 'view.pipeline', view: 'flat' }) }, `flat ${item.id}`),
      createElement('button', { type: 'button', onClick: () => onAct?.({ type: 'choice.pick', item: item.id, option: 'b' }) }, `pick ${item.id}`),
      createElement('button', { type: 'button', onClick: () => onAct?.({ type: 'build.start', chapter: 'engine-loop', track: ['queue'], blueprint: item.id, check: 'make check' }) }, `build ${item.id}`),
      createElement('button', { type: 'button', onClick: () => onAct?.({ type: 'ask', what: 'focus', item: item.id, part: 'queue' }) }, `ask ${item.id}`),
    ),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
});

/** A board with the model the taps name, a note of the owner's and a card of the agent's. */
function board() {
  const b = openBoard();
  b.must('agent', { type: 'model.patch', ops: [{ op: 'lane.set', lane: { id: 'bridge', name: 'Bridge' } }, { op: 'part.set', part: { id: 'queue', name: 'The queue', lane: 'bridge' } }] });
  b.must('owner', note('m1', [0, 0, 320, 100]));
  b.must('agent', text('a1', { answers: ['m1'] }));
  b.must('owner', placeAt('a1', [400, 0, 380, 200]));
  return b;
}

const posted = (src: { events: BoardEvent[] }, from: number) => src.events.slice(from);
const tool = () => document.querySelector('.app')!.getAttribute('data-tool');

describe('the toolbar', () => {
  it('names each tool with its key, and the keys pick the tools', () => {
    render(<App source={localSource({ events: board().events })} />);
    const titles = [...screen.getByRole('toolbar', { name: 'Tools' }).querySelectorAll('button')].map((b) => b.dataset.tip);
    expect(titles.slice(0, 10)).toEqual([
      'Select (S)',
      'Pan (H)',
      'Draw with the pen (P)',
      'Draw a box (B)',
      'Draw an arrow (A)',
      'Write a note (N)',
      'Pin a place inside an item (I)',
      'Lasso several items (L)',
      'Erase your ink, boxes, arrows and pins (E)',
      'Drop in a file, a picture or a link (D)',
    ]);
    expect(titles[11]).toContain('(Shift+S)');
    for (const [k, t] of [['p', 'pen'], ['b', 'box'], ['a', 'arrow'], ['i', 'pin'], ['l', 'lasso'], ['e', 'eraser'], ['h', 'pan'], ['s', 'select'], ['n', 'note']] as const) {
      fireEvent.keyDown(window, { key: k });
      expect(tool()).toBe(t);
    }
  });

  it('while the Note tool waits for its click, a letter is not a tool key: the board says where to click', () => {
    render(<App source={localSource({ events: board().events })} />);
    fireEvent.keyDown(window, { key: 'n' });
    for (const k of ['h', 'e', 'l', 'p']) fireEvent.keyDown(window, { key: k });
    expect(tool()).toBe('note');
    expect(screen.getByTestId('toast').textContent).toBe(NOTE_WHERE);
    // Esc still puts the Note tool down, and then the keys pick tools again.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(tool()).toBe('select');
    fireEvent.keyDown(window, { key: 'p' });
    expect(tool()).toBe('pen');
  });

  it('a click with the Note tool on a panel opens no note, and says where to click', () => {
    render(<App source={localSource({ events: board().events })} />);
    fireEvent.keyDown(window, { key: 'n' });
    fireEvent.pointerDown(screen.getByTestId('presence'), { clientX: 1, clientY: 1, pointerId: 1, button: 0 });
    expect(screen.queryByRole('textbox', { name: 'Your note' })).toBeNull();
    expect(screen.getByTestId('toast').textContent).toBe(NOTE_WHERE);
  });

  it('Talk says so where the browser has no speech recognition', () => {
    render(<App source={localSource({ events: board().events })} />);
    const talk = screen.getByRole('button', { name: 'Talk to the agent' });
    expect(talk.getAttribute('aria-disabled')).toBe('true');
    expect(talk.dataset.tip).toContain(NO_SPEECH);
    fireEvent.click(talk);
    expect(screen.getByTestId('toast').textContent).toContain(NO_SPEECH);
  });
});

describe('Talk', () => {
  /** A stand-in for the browser's speech recognition: what it hears is set by the test. */
  class FakeRecognition {
    static said = '';
    static last: FakeRecognition | undefined;
    lang = '';
    continuous = false;
    interimResults = false;
    onresult: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    started = false;
    start() {
      this.started = true;
      FakeRecognition.last = this;
    }
    stop() {
      const r = Object.assign([{ transcript: FakeRecognition.said }], { isFinal: true });
      this.onresult?.({ resultIndex: 0, results: [r] });
      this.onend?.();
    }
    abort() {
      this.onend?.();
    }
  }

  beforeEach(() => {
    (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = FakeRecognition;
  });

  it('holding T listens, and letting go posts the words as a spoken remark', async () => {
    const src = localSource({ events: board().events });
    render(<App source={src} />);
    const n = src.events.length;
    FakeRecognition.said = 'so the handler just sleeps here?';
    fireEvent.keyDown(window, { key: 't' });
    expect(FakeRecognition.last?.started).toBe(true);
    expect(screen.getByTestId('talk-caption')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Talk to the agent' }).getAttribute('aria-pressed')).toBe('true');
    // Its tip says "hold" once: the button and the key are both held.
    expect(screen.getByRole('button', { name: 'Talk to the agent' }).dataset.tip).toBe('Talk to the agent: hold to speak (T)');
    await act(async () => {
      fireEvent.keyUp(window, { key: 't' });
    });
    const adds = posted(src, n).filter((e) => e.type === 'item.add');
    expect(adds).toHaveLength(1);
    expect(adds[0]).toMatchObject({ by: 'owner', item: { kind: 'voice', text: 'so the handler just sleeps here?' } });
    expect(screen.queryByTestId('talk-caption')).toBeNull();
  });

  it('a remark said while a walk plays is on the step in view', async () => {
    const src = localSource({ events: board().events });
    render(<App source={src} view={{ walk: { id: 'w1', step: 5 } }} />);
    const n = src.events.length;
    FakeRecognition.said = 'why does it wait here';
    fireEvent.keyDown(window, { key: 't' });
    await act(async () => {
      fireEvent.keyUp(window, { key: 't' });
    });
    expect(posted(src, n)[0]).toMatchObject({ item: { kind: 'voice', on: { item: 'a1', sub: 'step:5' } } });
  });

  it('nothing heard is no remark, and it says so', async () => {
    const src = localSource({ events: board().events });
    render(<App source={src} />);
    const n = src.events.length;
    FakeRecognition.said = '';
    fireEvent.keyDown(window, { key: 't' });
    await act(async () => {
      fireEvent.keyUp(window, { key: 't' });
    });
    expect(posted(src, n)).toHaveLength(0);
    expect(screen.getByTestId('toast').textContent).toContain('Nothing was heard');
  });
});

describe('the pen', () => {
  const at = (x: number, y: number) => ({ clientX: x, clientY: y, pointerId: 1, button: 0, buttons: 1 });
  const stroke = (el: Element, pts: Array<[number, number]>) => {
    fireEvent.pointerDown(el, at(...pts[0]!));
    for (const p of pts.slice(1)) fireEvent.pointerMove(el, at(...p));
    fireEvent.pointerUp(el, at(...pts[pts.length - 1]!));
  };
  const line = (x0: number, y0: number, x1: number, y1: number): Array<[number, number]> =>
    Array.from({ length: 12 }, (_, i) => [x0 + ((x1 - x0) * i) / 11, y0 + ((y1 - y0) * i) / 11]);

  it('makes the strokes of one go one ink mark, once the pen has been up for the pause', async () => {
    vi.useFakeTimers();
    const src = localSource({ events: board().events });
    render(<App source={src} />);
    const n = src.events.length;
    fireEvent.keyDown(window, { key: 'p' });
    const b = screen.getByTestId('board');
    stroke(b, line(1000, 600, 1200, 800));
    await act(async () => {
      vi.advanceTimersByTime(PEN_PAUSE - 200);
    });
    stroke(b, line(1200, 600, 1000, 800));
    // Both strokes show at once, before the mark is made.
    expect(screen.getByTestId('live').querySelectorAll('svg.ink')).toHaveLength(2);
    await act(async () => {
      vi.advanceTimersByTime(PEN_PAUSE - 100);
    });
    expect(posted(src, n)).toHaveLength(0);
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    const adds = posted(src, n).filter((e) => e.type === 'item.add');
    expect(adds).toHaveLength(1);
    const ink = (adds[0] as { item: { kind: string; strokes: unknown[]; hint: string; targets: unknown[] } }).item;
    expect(ink.kind).toBe('ink');
    expect(ink.strokes).toHaveLength(2);
    expect(ink.hint).toBe('cross');
  });

  it('two goes apart are two marks, and Cmd+Z takes the last one off', async () => {
    vi.useFakeTimers();
    const src = localSource({ events: board().events });
    render(<App source={src} />);
    const n = src.events.length;
    fireEvent.keyDown(window, { key: 'p' });
    const b = screen.getByTestId('board');
    stroke(b, line(1000, 600, 1200, 610));
    await act(async () => {
      vi.advanceTimersByTime(PEN_PAUSE + 50);
    });
    stroke(b, line(1000, 700, 1200, 710));
    await act(async () => {
      vi.advanceTimersByTime(PEN_PAUSE + 50);
    });
    const inks = posted(src, n).filter((e) => e.type === 'item.add').map((e) => (e as { item: { id: string } }).item.id);
    expect(inks).toHaveLength(2);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'z', metaKey: true });
    });
    expect(src.events[src.events.length - 1]).toMatchObject({ type: 'item.remove', item: inks[1] });
  });
});

describe('select, delete, solidify', () => {
  it('a click selects a mark, and Delete takes the owner’s own mark off', async () => {
    const src = localSource({ events: board().events });
    const { container } = render(<App source={src} />);
    const noteEl = container.querySelector('[data-item="m1"] .note')!;
    fireEvent.pointerDown(noteEl, { clientX: 10, clientY: 10, pointerId: 1, button: 0 });
    fireEvent.pointerUp(noteEl, { clientX: 10, clientY: 10, pointerId: 1, button: 0 });
    expect(container.querySelector('[data-item="m1"]')!.className).toContain('item--selected');
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Delete' });
    });
    expect(src.events[src.events.length - 1]).toMatchObject({ type: 'item.remove', item: 'm1', by: 'owner' });
    expect(container.querySelector('[data-item="m1"]')).toBeNull();
  });

  it('a click on a picture selects it; Delete takes it off the board, and Undo puts it back', async () => {
    const src = localSource({ events: board().events });
    const { container } = render(<App source={src} />);
    const pic = container.querySelector('[data-double="a1"]')!;
    fireEvent.pointerDown(pic, { clientX: 10, clientY: 10, pointerId: 1, button: 0 });
    fireEvent.pointerUp(pic, { clientX: 10, clientY: 10, pointerId: 1, button: 0 });
    expect(container.querySelector('[data-item="a1"]')!.className).toContain('item--selected');
    const n = src.events.length;
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Delete' });
    });
    expect(src.events.slice(n)).toMatchObject([{ type: 'item.remove', item: 'a1', by: 'owner' }]);
    expect(container.querySelector('[data-item="a1"]')).toBeNull();
    expect(screen.getByTestId('toast').textContent).toContain('Taken off the board. Undo');
    await act(async () => {
      fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    });
    expect(src.events.slice(n).map((e) => e.type)).toEqual(['item.remove', 'item.restore']);
    expect(container.querySelector('[data-item="a1"]')).toBeTruthy();
    // The Delete was the only step made on this page. Undo again takes nothing off: the note
    // from before this page opened is not a step of it.
    await act(async () => {
      fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    });
    expect(src.events.slice(n).map((e) => e.type)).toEqual(['item.remove', 'item.restore']);
    expect(screen.getByTestId('toast').textContent).toBe('There is nothing to undo.');
  });

  it('Solidify is ready when a lasso is open, posts its items as picks, then is not', async () => {
    const b = board();
    b.must('owner', { type: 'item.add', chapter: CH, item: { id: 'l1', kind: 'lasso', box: [0, 0, 800, 200], path: [0, 0, 800, 0, 800, 200], targets: [{ item: 'm1' }, { item: 'a1', sub: 'q:1' }] } });
    const src = localSource({ events: b.events });
    const { container } = render(<App source={src} />);
    const button = container.querySelector<HTMLButtonElement>('[data-tool="solidify"]')!;
    expect(button.disabled).toBe(false);
    expect(button.dataset.tip).toBe('Solidify the 2 items in your lasso (Shift+S)');
    expect(container.querySelector('.lasso-pill')?.textContent).toBe('2 picked');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(src.events[src.events.length - 1]).toMatchObject({ type: 'solidify', chapter: CH, picks: ['m1', 'a1'], lasso: 'l1', by: 'owner' });
    expect(button.disabled).toBe(true);
  });

  it('Solidify waits for a lasso', () => {
    const src = localSource({ events: board().events });
    const { container } = render(<App source={src} />);
    expect(container.querySelector<HTMLButtonElement>('[data-tool="solidify"]')!.disabled).toBe(true);
  });
});

describe('what the owner does on a picture', () => {
  it('a tap on a part with no focus on the board asks for one, once, and says the agent is opening it', async () => {
    const src = localSource({ events: board().events });
    render(<App source={src} />);
    const n = src.events.length;
    const queue = document.querySelector('[data-double="a1"] [data-sub="part:queue"]')!;
    await act(async () => {
      fireEvent.click(queue);
    });
    expect(posted(src, n)).toEqual([expect.objectContaining({ type: 'ask', what: 'focus', part: 'queue', item: 'a1', by: 'owner' })]);
    expect(screen.getByTestId('focus-opening').textContent).toContain('The agent is opening The queue');
    await act(async () => {
      fireEvent.click(queue);
    });
    expect(posted(src, n)).toHaveLength(1);
    expect(screen.getByTestId('focus-opening')).toBeTruthy();
  });

  it('a tap on a lane asks with the lane; a tap on a question asks nothing', async () => {
    const src = localSource({ events: board().events });
    render(<App source={src} />);
    const n = src.events.length;
    await act(async () => {
      fireEvent.click(document.querySelector('[data-double="a1"] [data-sub="q:1"]')!);
      fireEvent.click(document.querySelector('[data-double="a1"] [data-sub="lane:bridge"]')!);
    });
    expect(posted(src, n)).toEqual([expect.objectContaining({ type: 'ask', lane: 'bridge', item: 'a1' })]);
  });

  it('a tap on a part whose focus is on the board opens the focus view, posts nothing, and Esc goes back', async () => {
    const b = board();
    b.must('agent', { type: 'item.add', chapter: CH, item: { id: 'f1', kind: 'picture', picture: { kind: 'focus', part: 'queue', title: 'The queue' }, from: ['a1'] } });
    b.must('owner', placeAt('f1', [3000, 3000, 400, 300]));
    const src = localSource({ events: b.events });
    const { container } = render(<App source={src} />);
    const n = src.events.length;
    const world = container.querySelector<HTMLElement>('.world')!;
    const before = world.style.transform;
    await act(async () => {
      fireEvent.click(container.querySelector('[data-double="a1"] [data-sub="part:queue"]')!);
    });
    expect(posted(src, n)).toHaveLength(0);
    expect(world.style.transform).not.toBe(before);
    expect(screen.getByTestId('focus-crumb').textContent).toContain('The queue');
    expect(container.querySelector('.app')!.getAttribute('data-focus')).toBe('f1');
    expect(container.querySelector('[data-item="f1"]')!.className).toContain('item--raised');
    expect(container.querySelector('[data-item="m1"]')!.className).not.toContain('item--raised');
    expect(container.querySelector('[data-focus-dim]')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('focus-crumb')).toBeNull();
    expect(container.querySelector('[data-focus-dim]')).toBeNull();
    expect(world.style.transform).toBe(before);
  });

  it('a tap with a drawing tool in hand is not a tap', async () => {
    const src = localSource({ events: board().events });
    render(<App source={src} />);
    const n = src.events.length;
    fireEvent.keyDown(window, { key: 'p' });
    await act(async () => {
      fireEvent.click(document.querySelector('[data-double="a1"] [data-sub="part:queue"]')!);
    });
    expect(posted(src, n)).toHaveLength(0);
  });

  it('a step of a walk and the pipeline view are kept in the view and handed back', async () => {
    // The view goes back to the pictures that read it: here, a pipeline that shows the walk.
    const b = board();
    b.must('agent', { type: 'model.patch', ops: [{ op: 'walk.set', walk: { id: 'w1', name: 'One request', steps: [{ n: 5, part: 'queue', text: 'wait' }] } }] });
    b.must('agent', { type: 'item.add', chapter: CH, item: { id: 'p1', kind: 'picture', picture: { kind: 'pipeline', walk: 'w1' }, answers: ['m1'] } });
    b.must('owner', placeAt('p1', [1000, 0, 700, 400]));
    const src = localSource({ events: b.events });
    const { container } = render(<App source={src} />);
    const n = src.events.length;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'next step a1' }));
      fireEvent.click(screen.getByRole('button', { name: 'flat a1' }));
    });
    const pic = container.querySelector<HTMLElement>('[data-double="p1"]')!;
    expect(pic.dataset.walk).toBe('w1:5');
    expect(pic.dataset.pipeline).toBe('flat');
    expect(posted(src, n)).toHaveLength(0);
  });

  it('a choice picked and "Build this" are posted as they are', async () => {
    const src = localSource({ events: board().events });
    const post = vi.spyOn(src, 'post');
    render(<App source={src} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'pick a1' }));
      fireEvent.click(screen.getByRole('button', { name: 'build a1' }));
      fireEvent.click(screen.getByRole('button', { name: 'ask a1' }));
    });
    const drafts = post.mock.calls.map((c) => c[0]);
    expect(drafts).toContainEqual({ type: 'choice.pick', item: 'a1', option: 'b' });
    expect(drafts).toContainEqual({ type: 'build.start', chapter: 'engine-loop', track: ['queue'], blueprint: 'a1', check: 'make check' });
    expect(drafts).toContainEqual({ type: 'ask', what: 'focus', part: 'queue', item: 'a1' });
  });
});

describe('the agent cursor', () => {
  it('goes to the item presence names, and follows it when it moves', () => {
    const src = localSource({ events: board().events, presence: { state: 'drawing', cursor: { item: 'a1' } } });
    render(<App source={src} />);
    expect(screen.getByTestId('agent-cursor').dataset.at).toBe(`${400 + 380 - 28},${200 - 18}`);
    act(() => {
      void src.post(placeAt('a1', [1000, 500, 380, 200]) as never);
    });
    expect(screen.getByTestId('agent-cursor').dataset.at).toBe(`${1000 + 380 - 28},${500 + 200 - 18}`);
  });
});

describe('a dropped-in file, opened', () => {
  it('shows text as plain text, so nothing in it runs in the board’s origin; pictures and PDFs as they are', async () => {
    const { viewable } = await import('../src/App');
    expect(viewable(new Blob(['<script>x</script>'], { type: 'text/html' }), 'a.html').type).toBe('text/plain;charset=utf-8');
    expect(viewable(new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'a.svg').type).toBe('text/plain;charset=utf-8');
    expect(viewable(new Blob(['a,b'], { type: 'text/csv' }), 'q.csv').type).toBe('text/plain;charset=utf-8');
    expect(viewable(new Blob(['# x'], { type: '' }), 'notes.md').type).toBe('text/plain;charset=utf-8');
    expect(viewable(new Blob(['x'], { type: 'image/png' }), 'a.png').type).toBe('image/png');
    expect(viewable(new Blob(['x'], { type: 'application/pdf' }), 'a.pdf').type).toBe('application/pdf');
    expect(viewable(new Blob(['x'], { type: 'application/zip' }), 'a.zip').type).toBe('application/octet-stream');
  });
});
