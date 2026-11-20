import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { CameraStore, fitBox, zoomAt } from '../src/camera/camera';
import { CURSOR_BESIDE, CURSOR_DOWN } from '../src/overlay/cursorPlace';
import { localSource } from '../src/source';
import { lanes, note, openBoard, text } from './helpers';

afterEach(cleanup);

function board() {
  const b = openBoard();
  b.must('owner', note('m1', [100, 100, 320, 120]));
  b.must('owner', note('m2', [100, 300, 320, 120]));
  b.must('owner', { type: 'item.remove', item: 'm2' });
  b.must('agent', text('a1', { answers: ['m1'] }));
  b.must('agent', lanes('a2', { from: ['a1'] }));
  return b;
}

describe('the app shell', () => {
  it('draws the chrome: board pill, view switch, presence, twelve tools, minimap and zoom', () => {
    const src = localSource({ events: board().events, presence: { state: 'drawing', note: 'drawing two pictures' } });
    render(<App source={src} />);
    expect(screen.getByTestId('board-name').textContent).toBe('uLLM · One engine, many requests');
    expect(screen.getByTestId('chapter-state').textContent).toBe('idea');
    expect(screen.getByTestId('item-count').textContent).toBe('3 items');
    expect(screen.getByTestId('open-count').textContent).toBe('0 open marks');
    expect(screen.getByTestId('presence').dataset.state).toBe('drawing');
    expect(screen.getByTestId('presence').textContent).toContain('drawing two pictures');
    const tools = screen.getByRole('toolbar', { name: 'Tools' }).querySelectorAll('button');
    expect(tools).toHaveLength(12);
    const working = [...tools].filter((t) => !t.disabled && t.getAttribute('aria-disabled') !== 'true').map((t) => t.dataset.tool);
    // Talk needs speech recognition, which the test DOM has not; Solidify needs a lasso.
    expect(working).toEqual(['select', 'pan', 'pen', 'box', 'arrow', 'note', 'pin', 'lasso', 'eraser', 'drop']);
    expect(screen.getByRole('button', { name: 'Story' })).toHaveProperty('disabled', false);
    expect(screen.getByRole('button', { name: 'Board' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('minimap')).toBeTruthy();
    expect(screen.getByTestId('zoom').textContent).toBe('100%');
  });

  it('wraps every drawn item in data-item and data-box, and draws no removed item', () => {
    const src = localSource({ events: board().events });
    const { container } = render(<App source={src} />);
    const drawn = [...container.querySelectorAll<HTMLElement>('.layer [data-item]')].map((e) => e.dataset.item);
    expect(drawn).toContain('m1');
    expect(drawn).not.toContain('m2');
    for (const el of container.querySelectorAll<HTMLElement>('.layer [data-item]')) expect(el.dataset.box).toMatch(/^-?[\d.]+(,-?[\d.]+){3}$/);
  });

  it('places pictures that have no box by posting item.place with one', () => {
    const src = localSource({ events: board().events });
    render(<App source={src} />);
    const updates = src.events.filter((e) => e.type === 'item.place');
    expect(updates.map((e) => e.type === 'item.place' && e.item)).toEqual(['a1', 'a2']);
    expect(src.state.items.a1?.item.box).toBeTruthy();
    expect(src.state.items.a2?.item.box).toBeTruthy();
    expect(updates.every((e) => e.by === 'owner')).toBe(true);
  });

  it('shows the hint on an empty board, and switches tools by key', () => {
    const b = openBoard();
    const src = localSource({ events: b.events });
    const { container } = render(<App source={src} />);
    expect(screen.getByText(/The agent is on the board with you/)).toBeTruthy();
    fireEvent.keyDown(window, { key: 'n' });
    expect(container.querySelector('.app')?.getAttribute('data-tool')).toBe('note');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(container.querySelector('.app')?.getAttribute('data-tool')).toBe('select');
  });

  it('shows the agent as away, greyed, when it is', () => {
    const src = localSource({ events: openBoard().events, presence: { state: 'away' } });
    render(<App source={src} />);
    expect(screen.getByTestId('presence').className).toContain('pill--away');
    expect(screen.queryByTestId('agent-cursor')).toBeNull();
    // The hint does not say the agent is with you when it is not.
    expect(screen.queryByText(/The agent is on the board with you/)).toBeNull();
    expect(screen.getByText(/The agent is away/)).toBeTruthy();
  });

  it('puts the agent cursor where presence says', () => {
    const src = localSource({ events: board().events, presence: { state: 'listening', cursor: { at: [640, 320] } } });
    render(<App source={src} />);
    const c = screen.getByTestId('agent-cursor');
    expect(c.dataset.at).toBe('640,320');
    act(() => src.setPresence({ state: 'drawing', cursor: { item: 'm1' } }));
    // Beside the owner's note, outside its right edge, not over its words.
    expect(screen.getByTestId('agent-cursor').dataset.at).toBe(`${100 + 320 + CURSOR_BESIDE},${100 + 120 * CURSOR_DOWN}`);
  });
});

describe('the camera', () => {
  it('zooms about the pointer: the world point under it stays put', () => {
    const cam = { x: 40, y: -20, z: 1 };
    const next = zoomAt(cam, 300, 200, 2);
    const before = [(300 - cam.x) / cam.z, (200 - cam.y) / cam.z];
    const after = [(300 - next.x) / next.z, (200 - next.y) / next.z];
    expect(after).toEqual(before);
    expect(zoomAt(cam, 0, 0, 100).z).toBe(4);
  });

  it('fits a box into the room, never past 100%', () => {
    expect(fitBox([0, 0, 100, 100], [0, 0, 1000, 1000], 1)).toEqual({ z: 1, x: 450, y: 450 });
    expect(fitBox([0, 0, 2000, 1000], [0, 0, 1000, 1000], 1).z).toBe(0.5);
  });

  it('tells movers at once and renderers once a frame', () => {
    const store = new CameraStore({ x: 0, y: 0, z: 1 });
    const moves: number[] = [];
    store.onMove((c) => moves.push(c.x));
    store.set({ x: 1, y: 0, z: 1 });
    store.set({ x: 2, y: 0, z: 1 });
    expect(moves).toEqual([0, 1, 2]);
  });
});
