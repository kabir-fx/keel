import type { BoardEvent } from '@keel/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { localSource } from '../src/source';
import { Board, note, placeAt, text } from './helpers';

/**
 * The journey reviewer's second pass, in the app: what came from outside, a page that posts no
 * move of its own, two chapters and a fit, and a picture that lands out of sight. The pictures
 * are a test double of a fixed size.
 */
vi.mock('@keel/pictures', () => ({
  Star: () => null,
  StateChip: ({ state, children }: { state: string; children?: unknown }) => createElement('span', { className: `k-state k-state--${state}` }, (children as string) ?? state),
  Picture: ({ item }: { item: { id: string } }) => createElement('div', { 'data-double': item.id, style: { width: '300px', height: '200px' } }, item.id),
}));

afterEach(cleanup);

const posted = (src: { events: BoardEvent[] }, from: number) => src.events.slice(from);
const transform = (c: HTMLElement) => c.querySelector<HTMLElement>('.world')!.style.transform;

function board() {
  const b = new Board();
  b.must('system', { type: 'board.open', name: 'demo' });
  b.must('owner', { type: 'chapter.open', chapter: 'c1', title: 'One engine' });
  b.must('owner', note('n1', [0, 0, 320, 100], {}, 'c1'));
  b.must('agent', text('a1', { answers: ['n1'] }, 'c1'));
  b.must('owner', placeAt('a1', [400, 0, 300, 200]));
  return b;
}

describe('what came with the log from outside', () => {
  it('tags each item not made here, says how many in a banner, and Show them and Keep them work', async () => {
    const b = board();
    b.must('owner', note('n2', [0, 3000, 320, 100], {}, 'c1'));
    const src = localSource({ events: b.events });
    src.setForeign([{ from: 3, to: 4 }]);
    const { container } = render(<App source={src} show={['n1']} />);
    expect([...container.querySelectorAll<HTMLElement>('[data-foreign]')].map((t) => [t.dataset.foreign, t.textContent])).toEqual([
      ['n1', 'not made here'],
      ['a1', 'not made here'],
    ]);
    const banner = screen.getByTestId('foreign');
    expect(banner.dataset.n).toBe('2');
    expect(banner.textContent).toContain('2 items on this board were not made on this machine.');
    const before = transform(container);
    fireEvent.click(screen.getByRole('button', { name: 'Show them' }));
    expect(transform(container)).not.toBe(before);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Keep them' }));
    });
    expect(src.foreign).toBeUndefined();
    expect(screen.queryByTestId('foreign')).toBeNull();
    expect(container.querySelectorAll('[data-foreign]')).toHaveLength(0);
  });

  it('no banner on a board in memory, nor in the Story, nor when nothing tagged is on the board', () => {
    const src = localSource({ events: board().events });
    const { unmount } = render(<App source={src} />);
    expect(screen.queryByTestId('foreign')).toBeNull();
    unmount();
    const s2 = localSource({ events: board().events });
    s2.setForeign([{ from: 3, to: 4 }]);
    render(<App source={s2} mode="story" />);
    expect(screen.queryByTestId('foreign')).toBeNull();
    cleanup();
    const s3 = localSource({ events: board().events });
    // A run that made nothing still on the board: only the chapter's opening.
    s3.setForeign([{ from: 2, to: 2 }]);
    render(<App source={s3} />);
    expect(screen.queryByTestId('foreign')).toBeNull();
  });

  it('the owner can still select a tagged item and take it off first', async () => {
    const src = localSource({ events: board().events });
    src.setForeign([{ from: 3, to: 4 }]);
    const { container } = render(<App source={src} />);
    const pic = container.querySelector('[data-double="a1"]')!;
    fireEvent.pointerDown(pic, { clientX: 10, clientY: 10, pointerId: 1, button: 0 });
    fireEvent.pointerUp(pic, { clientX: 10, clientY: 10, pointerId: 1, button: 0 });
    const n = src.events.length;
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Delete' });
    });
    expect(posted(src, n)).toMatchObject([{ type: 'item.remove', item: 'a1', by: 'owner' }]);
    expect(screen.getByTestId('foreign').dataset.n).toBe('1');
  });
});

describe('the page posts no move of its own', () => {
  it('a placeholder gets a spot here only, and is placed once when it is finished', async () => {
    const src = localSource({ events: board().events });
    render(<App source={src} />);
    const n = src.events.length;
    await act(async () => {
      await src.postAs('agent', { type: 'item.add', chapter: 'c1', item: { id: 'p1', kind: 'picture', picture: { kind: 'text', title: 'Drawing two ways' }, answers: ['n1'], status: 'drawing' } } as never);
    });
    // Drawn where it will go, and nothing posted for it.
    expect(document.querySelector('[data-item="p1"]')).toBeTruthy();
    expect(posted(src, n).filter((e) => e.by === 'owner')).toEqual([]);
    await act(async () => {
      await src.postAs('agent', { type: 'item.update', item: 'p1', patch: { picture: { kind: 'text', title: 'Two ways' }, status: 'done' } } as never);
    });
    const mine = posted(src, n).filter((e) => e.by === 'owner');
    expect(mine.map((e) => e.type)).toEqual(['item.place']);
    // Redrawn later, at another size: still nothing posted by the page.
    await act(async () => {
      await src.postAs('agent', { type: 'item.update', item: 'p1', patch: { picture: { kind: 'text', title: 'Two ways, longer now', body: 'x'.repeat(400) } } } as never);
    });
    expect(posted(src, n).filter((e) => e.by === 'owner').map((e) => e.type)).toEqual(['item.place']);
    expect(posted(src, n).some((e) => e.type === 'item.update' && e.by === 'owner')).toBe(false);
  });
});

/** A built chapter, and a newer idea far to the right. */
function twoChapters() {
  const b = board();
  b.must('agent', { type: 'model.patch', chapter: 'c1', ops: [{ op: 'lane.set', lane: { id: 'api', name: 'API' } }, { op: 'part.set', part: { id: 'door', name: 'The door', lane: 'api' } }] });
  b.must('owner', { type: 'solidify', chapter: 'c1', picks: ['n1'], parts: ['door'] });
  b.must('owner', { type: 'build.start', chapter: 'c1', track: ['door'], check: 'make check' });
  b.must('agent', { type: 'part.state', part: 'door', state: 'building' });
  b.must('system', { type: 'part.state', part: 'door', state: 'built', commit: 'abc1234', check: { cmd: 'make check', passed: true } });
  b.must('owner', { type: 'chapter.open', chapter: 'c2', title: 'The next idea' });
  b.must('owner', note('n9', [5000, 0, 320, 100], {}, 'c2'));
  return b;
}

describe('a fit with two chapters', () => {
  it('a fit of the whole board keeps the chapter the owner works in, and the done build panel stays out of its way', () => {
    render(<App source={localSource({ events: twoChapters().events })} show={['n9']} />);
    expect(screen.getByTestId('board-name').textContent).toBe('demo · The next idea');
    fireEvent.keyDown(window, { key: '1' });
    expect(screen.getByTestId('board-name').textContent).toBe('demo · The next idea');
    expect(screen.queryByTestId('watch')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Fit the board' }));
    expect(screen.getByTestId('board-name').textContent).toBe('demo · The next idea');
  });

  it('a built chapter shows its panel while no other chapter is in work, and not once a newer one is', () => {
    const b = twoChapters();
    const before = b.events.slice(0, b.events.length - 2);
    const one = render(<App source={localSource({ events: before })} show={['n1', 'a1']} />);
    expect(screen.getByTestId('watch').dataset.state).toBe('built');
    one.unmount();
    render(<App source={localSource({ events: b.events })} show={['n1', 'a1']} />);
    expect(screen.getByTestId('board-name').textContent).toBe('demo · One engine');
    expect(screen.queryByTestId('watch')).toBeNull();
  });
});

describe('a new picture out of sight', () => {
  async function writeNote(container: HTMLElement, words: string) {
    fireEvent.keyDown(window, { key: 'n' });
    const board = screen.getByTestId('board');
    fireEvent.pointerDown(board, { clientX: 300, clientY: 300, pointerId: 1, button: 0 });
    fireEvent.pointerUp(board, { clientX: 300, clientY: 300, pointerId: 1, button: 0 });
    fireEvent.change(screen.getByRole('textbox', { name: 'Your note' }), { target: { value: words } });
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Your note' }), { key: 'Enter' });
    });
    void container;
  }

  it('comes into view, with the owner’s mark, when the owner has not moved since the mark', async () => {
    const b = board();
    b.must('owner', note('nfar', [0, 6000, 320, 100], {}, 'c1'));
    const src = localSource({ events: b.events });
    const { container } = render(<App source={src} show={['n1']} />);
    await writeNote(container, 'and streams back?');
    const mark = src.events[src.events.length - 1] as unknown as { item: { id: string } };
    const before = transform(container);
    await act(async () => {
      // The page places it by a note far below, out of view.
      await src.postAs('agent', text('far', { answers: [mark.item.id], place: { near: 'nfar', side: 'below' } }, 'c1') as never);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(transform(container)).not.toBe(before);
    expect(screen.queryByTestId('nudge')).toBeNull();
  });

  it('stays a nudge when the owner has moved the view since the mark', async () => {
    const b = board();
    b.must('owner', note('nfar', [0, 6000, 320, 100], {}, 'c1'));
    const src = localSource({ events: b.events });
    const { container } = render(<App source={src} show={['n1']} />);
    await writeNote(container, 'and streams back?');
    const mark = src.events[src.events.length - 1] as unknown as { item: { id: string } };
    fireEvent.keyDown(window, { key: '+' });
    const before = transform(container);
    await act(async () => {
      await src.postAs('agent', text('far', { answers: [mark.item.id], place: { near: 'nfar', side: 'below' } }, 'c1') as never);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(transform(container)).toBe(before);
    expect(screen.getByTestId('nudge')).toBeTruthy();
  });
});
