import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { STILL_MS, Stillness } from '../src/board/stillness';
import { holdText } from '../src/chrome';
import { localSource } from '../src/source';
import { note, openBoard } from './helpers';

/** Hold and Answer now on the agent's pill: what the owner sees and presses, and what a viewer sees. */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function board() {
  const b = openBoard();
  b.must('owner', note('m1', [100, 100, 320, 120]));
  b.must('owner', note('m2', [100, 300, 320, 120]));
  b.must('owner', note('m3', [500, 100, 320, 120]));
  return b;
}

function owner() {
  const src = localSource({ events: board().events });
  const pressed: boolean[] = [];
  src.hold = (on) => pressed.push(on);
  return { src, pressed };
}

const pill = () => screen.getByTestId('presence');

describe('the hold on the agent pill', () => {
  it('the owner sees Hold while the agent listens, and a press asks to hold', () => {
    const { src, pressed } = owner();
    render(<App source={src} />);
    expect(pill().textContent).toContain('The agent: listening');
    expect(screen.queryByTestId('presence-answer')).toBeNull();
    fireEvent.click(screen.getByTestId('presence-hold'));
    expect(pressed).toEqual([true]);
  });

  it('while the owner draws it says so, with the marks that wait, and Answer now asks for the answer', () => {
    const { src, pressed } = owner();
    render(<App source={src} />);
    act(() => src.setHolding('drawing'));
    expect(pill().dataset.hold).toBe('drawing');
    expect(pill().textContent).toContain('The agent: holding while you draw · 3 marks wait');
    expect(screen.queryByTestId('presence-hold')).toBeNull();
    fireEvent.click(screen.getByTestId('presence-answer'));
    expect(pressed).toEqual([false]);

    act(() => src.setHolding('owner'));
    expect(pill().textContent).toContain('The agent: holding · 3 marks wait');
    act(() => src.setHolding(undefined));
    expect(pill().dataset.hold).toBeUndefined();
    expect(screen.getByTestId('presence-hold')).toBeTruthy();
  });

  it('a viewer sees the hold and no buttons', () => {
    const src = localSource({ events: board().events, role: 'agent' });
    src.hold = () => {
      throw new Error('a viewer pressed');
    };
    render(<App source={src} />);
    expect(screen.queryByTestId('presence-hold')).toBeNull();
    act(() => src.setHolding('owner'));
    expect(pill().textContent).toContain('holding · 3 marks wait');
    expect(screen.queryByTestId('presence-answer')).toBeNull();
  });

  it('no buttons where no agent wakes, nor while the agent works', () => {
    render(<App source={localSource({ events: board().events })} />);
    expect(screen.queryByTestId('presence-hold')).toBeNull();
    cleanup();

    const { src } = owner();
    src.setPresence({ state: 'drawing', note: 'reading your marks' });
    render(<App source={src} />);
    expect(screen.queryByTestId('presence-hold')).toBeNull();
  });

  it('a press on a pill button with the pen in hand draws nothing', () => {
    const { src, pressed } = owner();
    const { container } = render(<App source={src} />);
    fireEvent.keyDown(window, { key: 'p' });
    const before = src.events.length;
    const button = screen.getByTestId('presence-hold');
    fireEvent.pointerDown(button, { clientX: 1300, clientY: 40, pointerId: 1, button: 0 });
    expect(container.querySelector('.app')!.hasAttribute('data-pressing')).toBe(false);
    fireEvent.pointerMove(button, { clientX: 1320, clientY: 60, pointerId: 1 });
    fireEvent.pointerUp(button, { clientX: 1320, clientY: 60, pointerId: 1 });
    fireEvent.click(button);
    expect(src.events.slice(before).filter((e) => e.type === 'item.add')).toEqual([]);
    expect(pressed).toEqual([true]);
  });

  it('counts the marks that wait in plain words', () => {
    expect(holdText('drawing', 0)).toBe('holding while you draw');
    expect(holdText('owner', 1)).toBe('holding · 1 mark waits');
    expect(holdText('owner', 12)).toBe('holding · 12 marks wait');
  });
});

const ASK = 'Press Answer now for the agent\'s read of your drawing, or write a note.';
const hint = () => screen.queryByTestId('hint')?.textContent ?? null;
const asks = () => screen.queryByTestId('presence-answer')?.hasAttribute('data-ask') ?? false;
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe('the stillness clock', () => {
  it('turns still after 10 s with no movement, and any movement starts the 10 s again', () => {
    vi.useFakeTimers();
    const still = new Stillness();
    const said: boolean[] = [];
    still.subscribe(() => said.push(still.isStill()));
    const stop = still.listen(window);
    vi.advanceTimersByTime(STILL_MS - 1);
    expect(still.isStill()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(still.isStill()).toBe(true);
    for (const move of [() => fireEvent.pointerMove(window), () => fireEvent.pointerDown(window), () => fireEvent.keyDown(window, { key: 'a' }), () => fireEvent.wheel(window)]) {
      move();
      expect(still.isStill()).toBe(false);
      vi.advanceTimersByTime(STILL_MS - 1);
      expect(still.isStill()).toBe(false);
      vi.advanceTimersByTime(1);
      expect(still.isStill()).toBe(true);
    }
    // Moves while the owner is not still say nothing: they only write the time.
    fireEvent.pointerMove(window);
    vi.advanceTimersByTime(5000);
    fireEvent.pointerMove(window);
    vi.advanceTimersByTime(STILL_MS - 1);
    expect(still.isStill()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(said).toEqual([true, false, true, false, true, false, true, false, true, false, true]);
    stop();
    fireEvent.pointerMove(window);
    expect(still.isStill()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('pointing the owner at Answer now', () => {
  it('after 10 s still during a hold with marks waiting, the hint line says so and the button stands out; a movement takes both away', () => {
    vi.useFakeTimers();
    const { src } = owner();
    render(<App source={src} />);
    act(() => src.setHolding('drawing'));
    wait(STILL_MS - 1);
    expect(hint()).not.toBe(ASK);
    expect(asks()).toBe(false);
    wait(1);
    expect(hint()).toBe(ASK);
    expect(asks()).toBe(true);

    act(() => void fireEvent.pointerMove(window, { clientX: 40, clientY: 40 }));
    expect(hint()).not.toBe(ASK);
    expect(asks()).toBe(false);
    wait(STILL_MS - 1);
    expect(asks()).toBe(false);
    wait(1);
    expect(hint()).toBe(ASK);
    expect(asks()).toBe(true);

    // An owner hold points there too. When the hold ends, so does the pointer.
    act(() => src.setHolding('owner'));
    expect(hint()).toBe(ASK);
    act(() => src.setHolding(undefined));
    expect(hint()).not.toBe(ASK);
    expect(screen.queryByTestId('presence-answer')).toBeNull();
  });

  it('never with no hold on, and never with no mark waiting', () => {
    vi.useFakeTimers();
    const { src } = owner();
    render(<App source={src} />);
    wait(STILL_MS * 3);
    expect(hint()).not.toBe(ASK);
    cleanup();

    const empty = localSource({ events: openBoard().events });
    empty.hold = () => {};
    render(<App source={empty} />);
    act(() => empty.setHolding('drawing'));
    wait(STILL_MS * 3);
    expect(hint()).not.toBe(ASK);
    expect(asks()).toBe(false);
  });

  it('never on a viewer\'s page', () => {
    vi.useFakeTimers();
    const src = localSource({ events: board().events, role: 'agent' });
    src.hold = () => {};
    render(<App source={src} />);
    act(() => src.setHolding('drawing'));
    wait(STILL_MS * 3);
    expect(hint()).toBeNull();
    expect(screen.queryByTestId('presence-answer')).toBeNull();
    expect(pill().textContent).toContain('holding while you draw · 3 marks wait');
  });
});
