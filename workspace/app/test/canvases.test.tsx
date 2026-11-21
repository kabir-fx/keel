import type { BoardEvent, HomeInfo } from '@keel/protocol';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { scopeToCanvas } from '@keel/protocol';
import { CanvasSource, canvasToShow, newCanvasId } from '../src/canvasSource';
import { markDrafts } from '../src/marks';
import { elsewhere } from '../src/canvases';
import { localSource } from '../src/source';
import { canvasCard, curly, deleteWords, homeLine, saidParts } from '../src/tryit';
import { Board, note } from './helpers';
import { Keyboard, Pointer, frame, resetInput } from './pointer';

/**
 * Canvases (record 0014, plan 4a): the Board view shows one canvas; a canvas owns a branch,
 * so Approve and Delete are the canvas's; the Story lists canvases; the owner hears of what
 * happens on a canvas out of view. The pictures are a test double.
 */
vi.mock('@keel/pictures', () => ({
  Star: () => null,
  StateChip: ({ state, children }: { state: string; children?: unknown }) => createElement('span', { className: `k-state k-state--${state}` }, (children as string) ?? state),
  Picture: ({ item }: { item: { id: string } }) => createElement('div', { 'data-double': item.id, style: { width: '300px', height: '200px' } }, item.id),
}));

afterEach(() => {
  cleanup();
  resetInput();
  localStorage.clear();
  window.dispatchEvent(new Event('pointerdown'));
});

const HOME: HomeInfo = { branch: 'main', commit: 'abc1234', upstream: 'origin/main', sync: 'level' };

/** Build one idea on its canvas: decided, built part by part by the system. */
function buildIdea(b: Board, chapter: string, part: string, note_: string) {
  b.must('agent', { type: 'model.patch', chapter, ops: [{ op: 'lane.set', lane: { id: 'api', name: 'API' } }, { op: 'part.set', part: { id: part, name: `The ${part}`, lane: 'api' } }] });
  b.must('owner', { type: 'solidify', chapter, picks: [note_], parts: [part] });
  b.must('owner', { type: 'build.start', chapter, track: [part], check: 'make check' });
  b.must('system', { type: 'part.state', part, state: 'building' });
  b.must('system', { type: 'part.state', part, state: 'built', commit: 'abc1234', check: { cmd: 'make check', passed: true } });
}

/** Two canvases: "One engine" (canvas c1, built) and a newer one, "Units" (canvas k2), with a note. */
function twoCanvases(opts: { built?: boolean } = {}) {
  const b = new Board();
  b.must('system', { type: 'board.open', name: 'demo' });
  b.must('owner', { type: 'chapter.open', chapter: 'c1', title: 'One engine' });
  b.must('owner', note('m1', [0, 0, 320, 100], {}, 'c1'));
  b.must('owner', note('m3', [400, 0, 320, 100], {}, 'c1'));
  if (opts.built) buildIdea(b, 'c1', 'door', 'm1');
  b.must('owner', { type: 'canvas.open', canvas: 'k2' });
  b.must('owner', { type: 'chapter.open', chapter: 'u1', title: 'Units', canvas: 'k2' });
  b.must('owner', note('m2', [0, 0, 320, 100], {}, 'u1'));
  return b;
}

const posted = (events: BoardEvent[], from: number) => events.slice(from);

describe('the Board view is one canvas', () => {
  it('opens on the newest canvas, and nothing of another canvas is laid out, labelled or counted there', () => {
    const { container } = render(<App source={localSource({ events: twoCanvases().events })} />);
    expect(screen.getByTestId('board-name').textContent).toBe('demo · Units');
    expect([...container.querySelectorAll<HTMLElement>('[data-item]')].map((e) => e.dataset.item)).toEqual(['m2']);
    expect([...container.querySelectorAll<HTMLElement>('[data-chapter-label]')].map((e) => e.dataset.chapterLabel)).toEqual(['u1']);
    expect(screen.getByTestId('item-count').dataset.n).toBe('1');
    expect(screen.getByTestId('open-count').dataset.n).toBe('1');
  });

  it('a canvas opened from the Story comes into view, and its camera comes back as the owner left it', async () => {
    const { container } = render(<App source={localSource({ events: twoCanvases().events })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Story' }));
    const card = screen.getByTestId('story').querySelector<HTMLElement>('[data-canvas="c1"]')!;
    fireEvent.click(within(card).getByRole('button', { name: 'Open' }));
    expect(screen.queryByTestId('story')).toBeNull();
    expect(screen.getByTestId('board-name').textContent).toBe('demo · One engine');
    expect([...container.querySelectorAll<HTMLElement>('[data-item]')].map((e) => e.dataset.item).sort()).toEqual(['m1', 'm3']);
  });

  it('is kept across a reload, and falls back to the newest canvas when the kept one is gone', () => {
    const b = twoCanvases();
    localStorage.setItem('keel.view.demo', JSON.stringify({ camera: { x: 10, y: 20, z: 1 }, mode: 'board', canvas: 'c1' }));
    const first = render(<App source={localSource({ events: b.events })} remember />);
    expect(screen.getByTestId('board-name').textContent).toBe('demo · One engine');
    expect(first.container.querySelector<HTMLElement>('.world')!.style.transform).toBe('translate(10px, 20px) scale(1)');
    first.unmount();
    localStorage.setItem('keel.view.demo', JSON.stringify({ camera: { x: 10, y: 20, z: 1 }, mode: 'board', canvas: 'gone' }));
    render(<App source={localSource({ events: b.events })} remember />);
    expect(screen.getByTestId('board-name').textContent).toBe('demo · Units');
  });

  it('a blank canvas is named "Untitled canvas" and invites a first note', async () => {
    const src = localSource({ events: twoCanvases().events });
    render(<App source={src} mode="story" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('new-canvas-press'));
    });
    expect(screen.getByTestId('canvas-name').textContent).toBe(' · Untitled canvas');
    expect(screen.getByTestId('hint').textContent).toContain('Write it, draw it, drop something in, or say it.');
  });
});

describe('what the page posts goes to the canvas in view', () => {
  it('a new idea is opened on it, and an id another canvas holds is given a free one that the rest of the gesture follows', async () => {
    const b = twoCanvases();
    const raw = localSource({ events: b.events });
    let canvas: string | undefined = 'k2';
    const src = new CanvasSource(raw, () => canvas);
    // Units is in work on k2: a note there joins it, with no new idea.
    expect(src.onCanvas({ type: 'item.add', chapter: 'u1', item: { id: 'm9', kind: 'note', box: [0, 0, 1, 1], text: 'x' } })).toMatchObject({ chapter: 'u1' });
    // "c1" is another canvas's idea: a new idea of that id here is given a free one.
    const open = src.onCanvas({ type: 'chapter.open', chapter: 'c1', title: 'One engine' });
    expect(open).toEqual({ type: 'chapter.open', chapter: 'one-engine', title: 'One engine', canvas: 'k2' });
    expect(src.onCanvas({ type: 'item.add', chapter: 'c1', item: { id: 'm9', kind: 'note', box: [0, 0, 1, 1], text: 'x' } })).toMatchObject({ chapter: 'one-engine' });
    // On c1 itself, c1 is its own.
    canvas = 'c1';
    expect(src.onCanvas({ type: 'item.add', chapter: 'c1', item: { id: 'm9', kind: 'note', box: [0, 0, 1, 1], text: 'x' } })).toMatchObject({ chapter: 'c1' });
    const r = await new CanvasSource(raw, () => 'k2').post({ type: 'chapter.open', chapter: 'next', title: 'Next' });
    expect(r.ok && r.event).toMatchObject({ type: 'chapter.open', canvas: 'k2' });
  });

  it('the state is the canvas’s, and an ask about the model stays open on every canvas', async () => {
    const raw = localSource({ events: twoCanvases({ built: true }).events });
    expect((await raw.post({ type: 'ask', what: 'focus', part: 'door' } as never)).ok).toBe(true);
    const src = new CanvasSource(raw, () => 'c1');
    expect(src.state.chapterOrder).toEqual(['c1']);
    expect(src.state.itemOrder).toEqual(['m1', 'm3']);
    expect(Object.values(src.state.acts).map((a) => a.type)).toContain('ask');
    expect(src.state).toBe(src.state);
    expect(src.whole.chapterOrder).toEqual(['c1', 'u1']);
  });

  it('a mark goes to the idea in work on the canvas, also while a built idea there has an open mark (finding 10)', () => {
    const b = twoCanvases({ built: true });
    // The next idea on the built canvas: its note, answered by the agent's model picture.
    b.must('owner', { type: 'chapter.open', chapter: 'c2', title: 'Also say goodbye', canvas: 'c1' });
    b.must('owner', note('m4', [0, 400, 320, 100], {}, 'c2'));
    b.must('agent', { type: 'item.add', chapter: 'c2', item: { id: 'p2', kind: 'picture', answers: ['m4'], picture: { kind: 'text', title: 'Goodbye' } } } as never);
    // m3, on the built idea, is still open: it is the newest open thing on the canvas.
    const onCanvas = scopeToCanvas(b.state, 'c1');
    const lasso = { id: 'l1', kind: 'lasso' as const, box: [0, 380, 340, 140] as [number, number, number, number], path: [0, 380, 340, 380, 340, 520], targets: [{ item: 'm4' }] };
    expect(markDrafts(onCanvas, lasso)).toEqual([{ type: 'item.add', chapter: 'c2', item: lasso }]);
    // Everything there built: the next mark opens a new idea, as before.
    expect(markDrafts(scopeToCanvas(twoCanvases({ built: true }).state, 'c1'), lasso).map((d) => d.type)).toEqual(['chapter.open', 'item.add']);
  });

  it('a new canvas id is never one used before, and the canvas to show falls back to the newest', () => {
    const b = twoCanvases();
    b.must('owner', { type: 'canvas.open', canvas: 'canvas-3' });
    b.must('owner', { type: 'canvas.remove', canvas: 'canvas-3' });
    expect(newCanvasId(b.state)).toBe('canvas-4');
    expect(canvasToShow(b.state, 'canvas-3')).toBe('k2');
    expect(canvasToShow(b.state, 'c1')).toBe('c1');
  });
});

describe('the Story lists canvases', () => {
  it('newest first, each with its ideas in words, its branch, and Open, Try it, Delete', () => {
    const b = twoCanvases({ built: true });
    const src = localSource({ events: b.events });
    src.setWorks({ c1: { branch: 'board/one-engine', ahead: 3 } }, {}, HOME);
    render(<App source={src} mode="story" />);
    const cards = [...screen.getByTestId('chapters').querySelectorAll<HTMLElement>('article[data-canvas]')];
    expect(cards.map((c) => c.dataset.canvas)).toEqual(['k2', 'c1']);
    const one = cards[1]!;
    expect(within(one).getByTestId('idea-state').textContent).toBe('built: try it');
    expect(within(one).getByTestId('idea-branch').textContent).toBe('board/one-engine · 3 commits main does not have');
    expect(within(one).getByRole('button', { name: 'Try “One engine”' })).toBeTruthy();
    expect(within(one).getByTestId('approve-press').textContent).toBe('Approve: merge into main');
    expect(within(cards[0]!).queryByTestId('approve-press')).toBeNull();
    expect(screen.getByTestId('new-canvas').textContent).toContain('Each canvas gets a branch of its own, started from main. Ideas on one canvas are built together, on its branch.');
  });

  it('while the builder finishes on the canvas, Try it and Approve are held, and one line says why', () => {
    const src = localSource({ events: twoCanvases({ built: true }).events });
    src.setWorks({ c1: { branch: 'board/one-engine', busy: 'building' } }, {}, HOME);
    render(<App source={src} mode="story" />);
    const card = screen.getByTestId('story').querySelector<HTMLElement>('[data-canvas="c1"]')!;
    const tryIt = within(card).getByTestId('idea-try') as HTMLButtonElement;
    expect(tryIt.disabled).toBe(true);
    expect(tryIt.dataset.tip).toBe('The builder is finishing: its last commit is not in yet.');
    expect((within(card).getByTestId('approve-press') as HTMLButtonElement).disabled).toBe(true);
    expect(within(card).getByTestId('approve-busy').textContent).toBe('The builder is finishing: its last commit is not in yet.');
    expect(card.textContent!.split('The builder is finishing')).toHaveLength(2);
  });

  it('an app that runs is said on the card, and one press opens it', () => {
    const src = localSource({ events: twoCanvases({ built: true }).events });
    src.setWorks({ c1: { branch: 'board/one-engine' } }, { c1: { kind: 'app', run: 'npm start', state: 'on', url: 'http://127.0.0.1:5173/' } }, HOME);
    render(<App source={src} mode="story" />);
    const card = screen.getByTestId('story').querySelector<HTMLElement>('[data-canvas="c1"]')!;
    expect(within(card).getByTestId('idea-state').textContent).toBe('built: its app is running');
    const open = within(card).getByTestId('idea-try');
    expect(open.textContent).toBe('Open the running app');
    fireEvent.click(open);
    expect(screen.getByTestId('try-room').dataset.chapter).toBe('c1');
  });

  it('Try it opens that idea’s try room, from the Story', () => {
    const src = localSource({ events: twoCanvases({ built: true }).events });
    render(<App source={src} mode="story" />);
    fireEvent.click(screen.getByRole('button', { name: 'Try “One engine”' }));
    expect(screen.getByTestId('try-room').dataset.chapter).toBe('c1');
  });

  it('two built ideas on one canvas: Approve names both, asks first, then posts canvas.approve once', async () => {
    const b = twoCanvases({ built: true });
    b.must('owner', { type: 'chapter.open', chapter: 'c2', title: 'Two engines', canvas: 'c1' });
    b.must('owner', note('m4', [0, 400, 320, 100], {}, 'c2'));
    buildIdea(b, 'c2', 'loop', 'm4');
    const src = localSource({ events: b.events });
    src.setWorks({ c1: { branch: 'board/one-engine', ahead: 5 } }, {}, HOME);
    render(<App source={src} mode="story" />);
    const card = screen.getByTestId('story').querySelector<HTMLElement>('[data-canvas="c1"]')!;
    expect(card.querySelector('.chapter__when')!.textContent).toContain('2 ideas, one branch');
    const press = within(card).getByTestId('approve-press');
    expect(press.textContent).toBe('Approve “One engine” and “Two engines”: merge into main…');
    const n = src.events.length;
    fireEvent.click(press);
    const ask = screen.getByTestId('confirm-approve');
    expect(ask.querySelector('h2')!.textContent).toBe('Approve “One engine” and “Two engines”?');
    expect(ask.textContent).toContain('They are built on one branch, board/one-engine, so they go into main together.');
    expect(document.activeElement!.textContent).toBe('Not yet');
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-approve-press'));
    });
    expect(posted(src.events, n).map((e) => [e.type, (e as { canvas?: string }).canvas])).toEqual([['canvas.approve', 'c1']]);
    expect(screen.queryByTestId('confirm-approve')).toBeNull();
  });

  it('while one idea on the canvas builds, Approve is off and says why', () => {
    const b = twoCanvases({ built: true });
    b.must('owner', { type: 'chapter.open', chapter: 'c2', title: 'Two engines', canvas: 'c1' });
    b.must('owner', note('m4', [0, 400, 320, 100], {}, 'c2'));
    b.must('agent', { type: 'model.patch', chapter: 'c2', ops: [{ op: 'part.set', part: { id: 'loop', name: 'The loop', lane: 'api' } }] });
    b.must('owner', { type: 'solidify', chapter: 'c2', picks: ['m4'], parts: ['loop'] });
    b.must('owner', { type: 'build.start', chapter: 'c2', track: ['loop'], check: 'make check' });
    render(<App source={localSource({ events: b.events })} mode="story" />);
    const card = screen.getByTestId('story').querySelector<HTMLElement>('[data-canvas="c1"]')!;
    expect((within(card).getByTestId('approve-press') as HTMLButtonElement).disabled).toBe(true);
    expect(within(card).getByTestId('approve-why').textContent).toBe('“Two engines” is still building on this canvas, and every idea on a canvas shares its branch. Approve when it is built.');
  });
});

describe('deleting a canvas', () => {
  it('asks first, says exactly what goes, and Keep it changes nothing', () => {
    const b = twoCanvases({ built: true });
    const src = localSource({ events: b.events });
    src.setWorks({ c1: { branch: 'board/one-engine', ahead: 7 } }, {}, HOME);
    render(<App source={src} mode="story" />);
    const n = src.events.length;
    fireEvent.click(screen.getByRole('button', { name: 'Delete “One engine”…' }));
    const ask = screen.getByTestId('confirm-delete');
    expect(ask.querySelector('h2')!.textContent).toBe('Delete “One engine”?');
    expect([...ask.querySelectorAll('li')].map((l) => l.textContent)).toEqual([
      'The idea “One engine” leaves the board, with its notes and pictures.',
      'Its branch board/one-engine is deleted, with 7 commits that main does not have.',
    ]);
    // Keep it has the focus: a stray Enter keeps the canvas.
    expect(document.activeElement!.textContent).toBe('Keep it');
    fireEvent.keyDown(ask, { key: 'Escape' });
    expect(screen.queryByTestId('confirm-delete')).toBeNull();
    expect(src.events.length).toBe(n);
  });

  it('a building idea is paused first, then the canvas goes; the view goes to the newest canvas left', async () => {
    const b = twoCanvases();
    b.must('agent', { type: 'model.patch', chapter: 'u1', ops: [{ op: 'lane.set', lane: { id: 'api', name: 'API' } }, { op: 'part.set', part: { id: 'unit', name: 'Units', lane: 'api' } }] });
    b.must('owner', { type: 'solidify', chapter: 'u1', picks: ['m2'], parts: ['unit'] });
    b.must('owner', { type: 'build.start', chapter: 'u1', track: ['unit'], check: 'make check' });
    const src = localSource({ events: b.events });
    const { container } = render(<App source={src} />);
    expect(screen.getByTestId('board-name').textContent).toBe('demo · Units');
    fireEvent.click(screen.getByRole('button', { name: 'Story' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete “Units”…' }));
    expect(screen.getByTestId('confirm-delete').textContent).toContain('The build of “Units” stops.');
    const n = src.events.length;
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-delete-press'));
    });
    expect(posted(src.events, n).map((e) => e.type)).toEqual(['build.pause', 'canvas.remove']);
    expect(screen.getByTestId('story').querySelectorAll('article[data-canvas]')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Board' }));
    expect(screen.getByTestId('board-name').textContent).toBe('demo · One engine');
    expect([...container.querySelectorAll<HTMLElement>('[data-item]')].map((e) => e.dataset.item).sort()).toEqual(['m1', 'm3']);
  });

  it('with no canvas left, the board is one empty canvas, ready for a first note', async () => {
    const b = new Board();
    b.must('system', { type: 'board.open', name: 'demo' });
    b.must('owner', { type: 'chapter.open', chapter: 'c1', title: 'One engine' });
    b.must('owner', note('m1', [0, 0, 320, 100], {}, 'c1'));
    const src = localSource({ events: b.events });
    const { container } = render(<App source={src} mode="story" />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete “One engine”…' }));
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-delete-press'));
    });
    expect(screen.getByTestId('no-ideas').textContent).toContain('No canvas on this board yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Board' }));
    expect(container.querySelectorAll('[data-item]')).toHaveLength(0);
    expect(screen.getByTestId('item-count').dataset.n).toBe('0');
    expect(screen.getByTestId('minimap')).toBeTruthy();
    expect(screen.getByTestId('hint').textContent).toContain('Write it, draw it');
    // A first note on the empty board opens a new idea, on a canvas made for it.
    await act(async () => {
      await src.post({ type: 'chapter.open', chapter: 'again', title: 'Again' });
    });
    expect(src.state.chapters.again!.canvas).toBe('again');
  });

  it('says that an app that runs there is stopped', () => {
    const src = localSource({ events: twoCanvases({ built: true }).events });
    src.setWorks({ c1: { branch: 'board/one-engine', ahead: 1 } }, { c1: { kind: 'app', run: 'npm start', state: 'on', url: 'http://127.0.0.1:5173/' } }, HOME);
    render(<App source={src} mode="story" />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete “One engine”…' }));
    expect([...screen.getByTestId('confirm-delete').querySelectorAll('li')].map((l) => l.textContent)).toEqual([
      'The app of “One engine” is running: it is stopped.',
      'The idea “One engine” leaves the board, with its notes and pictures.',
      'Its branch board/one-engine is deleted, with 1 commit that main does not have.',
    ]);
  });

  it('a blank canvas says so, and the words for one with merged and unmerged ideas say what stays', () => {
    const b = twoCanvases({ built: true });
    b.must('owner', { type: 'canvas.open', canvas: 'blank' });
    expect(deleteWords(b.state, 'blank', undefined, HOME)).toEqual(['It is blank: nothing else goes.']);
    b.must('owner', { type: 'canvas.approve', canvas: 'c1' });
    b.must('system', { type: 'canvas.merged', canvas: 'c1', commit: 'abc1234', into: 'main' });
    expect(deleteWords(b.state, 'c1', undefined, HOME)).toEqual([
      'The idea “One engine” leaves the board, with its notes and pictures.',
      '“One engine” is in main already: that code stays there.',
    ]);
  });
});

describe('what happens on a canvas out of view', () => {
  it('the agent draws there: a quiet notice says where, and one press goes there', async () => {
    const src = localSource({ events: twoCanvases().events });
    render(<App source={src} />);
    expect(screen.queryByTestId('elsewhere')).toBeNull();
    await act(async () => {
      await src.postAs('agent', { type: 'item.add', chapter: 'c1', item: { id: 'p1', kind: 'picture', answers: ['m1'], picture: { kind: 'text', title: 'Two ways' } } } as never);
    });
    const notice = screen.getByTestId('elsewhere');
    expect(notice.textContent).toContain('The agent drew a picture on “One engine”.');
    // No news of it on the canvas in view.
    expect(screen.queryByTestId('nudge')).toBeNull();
    fireEvent.click(screen.getByTestId('elsewhere-go'));
    expect(screen.getByTestId('board-name').textContent).toBe('demo · One engine');
    expect(screen.queryByTestId('elsewhere')).toBeNull();
  });

  it('a problem there comes first, then an idea built there', () => {
    const b = twoCanvases({ built: true });
    const seen = { seq: 0, at: '2000-01-01T00:00:00Z' };
    expect(elsewhere(b.state, 'k2', () => seen).map((e) => [e.canvas, e.what])).toEqual([['c1', 'built']]);
    b.must('system', { type: 'feed.add', chapter: 'c1', kind: 'problem', text: 'The check failed.' });
    expect(elsewhere(b.state, 'k2', () => seen)[0]!.line).toBe('The build on “One engine” needs you.');
    expect(elsewhere(b.state, 'c1', () => seen)).toEqual([]);
  });
});

describe('a canvas where everything is built', () => {
  it('none while a build there waits to be tried and approved', () => {
    const src = localSource({ events: twoCanvases({ built: true }).events });
    render(<App source={src} />);
    fireEvent.click(screen.getByRole('button', { name: 'Story' }));
    fireEvent.click(within(screen.getByTestId('story').querySelector<HTMLElement>('[data-canvas="c1"]')!).getByRole('button', { name: 'Open' }));
    expect(screen.getByTestId('watch-try')).toBeTruthy();
    expect(screen.queryByTestId('canvas-done')).toBeNull();
  });

  it('once merged, says a new note goes onto its branch, and offers a new canvas', async () => {
    const b = twoCanvases({ built: true });
    b.must('owner', { type: 'canvas.approve', canvas: 'c1' });
    b.must('system', { type: 'canvas.merged', canvas: 'c1', commit: 'abc1234', into: 'main' });
    const src = localSource({ events: b.events });
    src.setWorks({ c1: { branch: 'board/one-engine' } }, {}, HOME);
    render(<App source={src} />);
    expect(screen.queryByTestId('canvas-done')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Story' }));
    fireEvent.click(within(screen.getByTestId('story').querySelector<HTMLElement>('[data-canvas="c1"]')!).getByRole('button', { name: 'Open' }));
    expect(screen.getByTestId('canvas-done').textContent).toContain('starts another idea on its branch');
    const n = src.events.length;
    await act(async () => {
      fireEvent.click(screen.getByTestId('canvas-done-new'));
    });
    expect(posted(src.events, n).map((e) => e.type)).toEqual(['canvas.open']);
    expect(screen.getByTestId('canvas-name').textContent).toBe(' · Untitled canvas');
  });
});

describe('the home branch line, word for word (plan 5.1)', () => {
  it('says each state', () => {
    const at = (h: Partial<HomeInfo>) => homeLine({ ...HOME, ...h })!;
    expect(at({ commit: undefined }).words).toBe('main · no commit yet');
    expect(at({ sync: 'local', upstream: undefined }).words).toBe('main · abc1234 · follows no remote');
    expect(at({ sync: 'unreachable' })).toMatchObject({ words: 'origin did not answer. Building from main as it is here, at abc1234.', tone: 'soft' });
    expect(at({ sync: 'level' })).toMatchObject({ words: 'main · abc1234 · level with origin', tone: 'quiet' });
    expect(at({ sync: 'local', upstream: undefined }).tone).toBe('quiet');
    expect(at({ sync: 'behind', behind: 1 }).tone).toBe('needs');
    // The server's note says it whole: the count, and what is in the way.
    expect(at({ sync: 'behind', behind: 3, note: 'origin has 3 new commits. Your changes in a.ts are in the way: commit or stash them.' }).words).toBe(
      'origin has 3 new commits. Your changes in a.ts are in the way: commit or stash them.',
    );
    expect(at({ sync: 'behind', behind: 3 }).words).toBe('origin has 3 commits that main does not. main was not brought level.');
    expect(at({ sync: 'ahead', ahead: 2 })).toMatchObject({ words: 'main · abc1234 · 2 commits to push to origin', push: true, tone: 'quiet' });
    // Whenever it is not level, the owner can look again: after a refused push, origin may have moved.
    for (const sync of ['ahead', 'behind', 'diverged', 'unreachable'] as const) expect(at({ sync }).lookAgain).toBe(true);
    expect(at({ sync: 'diverged' })).toMatchObject({ words: 'main and origin/main have both moved, so the board did not pull. Run git pull in the board’s folder, then look again.', tone: 'needs' });
    // The server's note is shown as given.
    expect(at({ sync: 'diverged', note: "main and origin/main have both moved, so the board did not pull. Run git pull in the board's folder, then look again." }).words).toBe("main and origin/main have both moved, so the board did not pull. Run git pull in the board's folder, then look again.");
    expect(at({ folderOn: 'feat/x' }).folder).toBe('Your folder is on feat/x. Builds start from main.');
    expect(homeLine(undefined)).toBeUndefined();
  });

  it('sits on top of the Story, and Push sends it and says what came back', async () => {
    const src = localSource({ events: twoCanvases().events });
    src.setWorks({}, {}, { ...HOME, sync: 'ahead', ahead: 2 });
    src.answer = () => ({ ok: true, note: 'Pushed main to origin.' });
    render(<App source={src} mode="story" />);
    expect(screen.getByTestId('home-words').textContent).toBe('main · abc1234 · 2 commits to push to origin');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Push main to origin' }));
    });
    expect(src.asked).toEqual([{ route: 'push' }]);
    expect(screen.getByTestId('home-said').textContent).toBe('Pushed main to origin.');
  });

  it('a refused push: the server’s sentence in one line, what git said folded under it, and Look again', async () => {
    const src = localSource({ events: twoCanvases().events });
    src.setWorks({}, {}, { ...HOME, sync: 'ahead', ahead: 2 });
    const git = '! [rejected] main -> main (fetch first)';
    src.answer = (route) => (route === 'push' ? { ok: false, reason: `origin has commits that main here does not have, so it did not take the push. ${git}` } : { ok: true });
    render(<App source={src} mode="story" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Push main to origin' }));
    });
    const said = screen.getByTestId('home-said');
    expect(said.firstElementChild!.textContent).toBe('origin has commits that main here does not have, so it did not take the push.');
    expect(screen.getByTestId('home-said-more').querySelector('pre')!.textContent).toBe(git);
    expect((screen.getByTestId('home-said-more') as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByTestId('home-look').textContent).toBe('Look at origin again');
    expect(saidParts('One sentence only.')).toEqual({ head: 'One sentence only.' });
  });

  it('diverged: Approve says the merge goes into main here, and that main and origin have both moved', () => {
    const src = localSource({ events: twoCanvases({ built: true }).events });
    src.setWorks({ c1: { branch: 'board/one-engine', ahead: 1 } }, {}, { ...HOME, sync: 'diverged' });
    render(<App source={src} mode="story" />);
    const card = screen.getByTestId('story').querySelector<HTMLElement>('[data-canvas="c1"]')!;
    expect(within(card).getByTestId('approve-what').textContent).toBe(
      'Approve merges board/one-engine into main on this machine. main and origin/main have both moved, so the merge stays on this machine until they are joined.',
    );
  });

  it('a canvas card says its state as data too', () => {
    const b = twoCanvases({ built: true });
    expect(canvasCard(b.state, 'k2', undefined, HOME).ideas.map((i) => i.words)).toEqual(['idea']);
    expect(canvasCard(b.state, 'c1', { branch: 'board/x', busy: 'merging' }, HOME)).toMatchObject({ busy: 'Merging board/x into main.' });
  });
});


describe('Undo keeps to the canvas in view', () => {
  const settle = () => act(async () => {});
  const undo = async () => {
    Keyboard.press('z', 'KeyZ', { meta: true });
    await settle();
  };
  /** Drag the note on the canvas in view a little: one step of the owner's there. */
  async function moveNote(id: string) {
    const el = document.querySelector<HTMLElement>(`[data-item="${id}"]`)!;
    const mouse = new Pointer().on(el);
    mouse.down([10, 10]);
    mouse.move([40, 30]);
    mouse.move([70, 50]);
    await frame();
    mouse.up();
    await settle();
  }
  const openCanvas = (canvas: string) => {
    fireEvent.click(screen.getByRole('button', { name: 'Story' }));
    fireEvent.click(within(screen.getByTestId('story').querySelector<HTMLElement>(`[data-canvas="${canvas}"]`)!).getByRole('button', { name: 'Open' }));
  };

  it('a step done on one canvas is not taken back from another, and is still there when the owner comes back', async () => {
    const src = localSource({ events: twoCanvases().events });
    render(<App source={src} />);
    const n = src.events.length;
    await moveNote('m2');
    expect(posted(src.events, n).map((e) => e.type)).toEqual(['item.update']);
    openCanvas('c1');
    await undo();
    expect(posted(src.events, n)).toHaveLength(1);
    expect(screen.getByTestId('toast').textContent).toBe('There is nothing to undo.');
    openCanvas('k2');
    await undo();
    expect(posted(src.events, n).map((e) => [e.type, 'item' in e ? e.item : undefined])).toEqual([
      ['item.update', 'm2'],
      ['item.update', 'm2'],
    ]);
  });

  it('a step on a canvas that was deleted is never posted, and nothing throws', async () => {
    const src = localSource({ events: twoCanvases().events });
    render(<App source={src} />);
    await moveNote('m2');
    openCanvas('c1');
    fireEvent.click(screen.getByRole('button', { name: 'Story' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete “Units”…' }));
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-delete-press'));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Board' }));
    const n = src.events.length;
    await undo();
    expect(posted(src.events, n)).toEqual([]);
    expect(screen.getByTestId('toast').textContent).toBe('There is nothing to undo.');
  });
});

describe('the home branch, on the Board view', () => {
  it('says once, quietly, when it needs the owner, with the way to the Story’s home line; Dismiss puts it away', () => {
    const note_ = 'origin has 3 new commits. Your changes in a.ts are in the way: commit or stash them.';
    const src = localSource({ events: twoCanvases().events });
    src.setWorks({}, {}, { ...HOME, sync: 'behind', behind: 3, note: note_ });
    render(<App source={src} />);
    expect(screen.getByTestId('home-notice').textContent).toContain(note_);
    fireEvent.click(screen.getByTestId('home-notice-show'));
    expect(screen.getByTestId('home-words').textContent).toBe(note_);
    fireEvent.click(screen.getByRole('button', { name: 'Board' }));
    expect(screen.queryByTestId('home-notice')).toBeNull();
  });

  it('diverged and unreachable too; nothing when level, ahead or local', () => {
    const src = localSource({ events: twoCanvases().events });
    src.setWorks({}, {}, { ...HOME, sync: 'diverged', note: "main and origin/main have both moved, so the board did not pull. Run git pull in the board's folder, then look again." });
    render(<App source={src} />);
    expect(screen.getByTestId('home-notice').textContent).toContain('main and origin/main have both moved, so the board did not pull.');
    fireEvent.click(screen.getByTestId('home-notice-dismiss'));
    expect(screen.queryByTestId('home-notice')).toBeNull();
    cleanup();
    for (const sync of ['level', 'ahead', 'local'] as const) {
      const quiet = localSource({ events: twoCanvases().events });
      quiet.setWorks({}, {}, { ...HOME, sync });
      render(<App source={quiet} />);
      expect(screen.queryByTestId('home-notice')).toBeNull();
      cleanup();
    }
    const away = localSource({ events: twoCanvases().events });
    away.setWorks({}, {}, { ...HOME, sync: 'unreachable' });
    render(<App source={away} />);
    expect(screen.getByTestId('home-notice').textContent).toContain('origin did not answer. Building from main as it is here, at abc1234.');
  });
});

describe('the board pill names the board and the canvas', () => {
  it('in two parts that are cut apart, with the whole name in its tip', () => {
    render(<App source={localSource({ events: twoCanvases().events })} />);
    const pill = screen.getByTestId('board-name');
    expect(pill.querySelector('.pill__board')!.textContent).toBe('demo');
    expect(pill.querySelector('.pill__where')!.textContent).toBe(' · Units');
    expect(pill.dataset.tip).toBe('demo · Units');
    expect(pill.textContent).toBe('demo · Units');
  });
});

describe('a title with straight quotes', () => {
  it('is shown with opening and closing ones, wherever the board names the canvas', () => {
    expect(curly('Ship "v2" of the test')).toBe('Ship “v2” of the test');
    expect(curly('"Quoted" first, then ("in" brackets)')).toBe('“Quoted” first, then (“in” brackets)');
    const b = new Board();
    b.must('system', { type: 'board.open', name: 'demo' });
    b.must('owner', { type: 'chapter.open', chapter: 'v2', title: 'Ship "v2" of the test' });
    b.must('owner', note('m1', [0, 0, 320, 100], {}, 'v2'));
    render(<App source={localSource({ events: b.events })} mode="story" />);
    expect(screen.getByTestId('story').querySelector('article[data-canvas="v2"] h3')!.textContent).toBe('Ship “v2” of the test');
  });
});
