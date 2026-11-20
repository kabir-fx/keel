import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import type { Crumb } from '../src/focus';
import { FocusCrumb } from '../src/focus';
import { TOOLTIP_DELAY, TOOLTIP_WARM } from '../src/input/constants';
import { keyWords } from '../src/input/keytable';
import type { MarkViewProps } from '../src/items';
import { MarkView } from '../src/items';
import { localSource } from '../src/source';
import type { TipClock } from '../src/tips';
import { crosses, placeTip, TipTimer } from '../src/tips';
import { CH, note, openBoard } from './helpers';
import { Keyboard, resetInput } from './pointer';

/** A clock a test moves by hand. */
function handClock() {
  let now = 0;
  const waits: Array<{ at: number; fn: () => void; done: boolean }> = [];
  const clock: TipClock = {
    now: () => now,
    after: (ms, fn) => {
      const w = { at: now + ms, fn, done: false };
      waits.push(w);
      return () => {
        w.done = true;
      };
    },
  };
  const pass = (ms: number) => {
    now += ms;
    for (const w of waits) {
      if (!w.done && w.at <= now) {
        w.done = true;
        w.fn();
      }
    }
  };
  return { clock, pass };
}

/** A timer over named controls, with what it shows now. `gone` names the controls that have left the page. */
function rig() {
  const { clock, pass } = handClock();
  const seen: Array<string | null> = [];
  const gone = new Set<string>();
  const timer = new TipTimer<string>((t) => seen.push(t), clock, (t) => !gone.has(t));
  return { timer, pass, showing: () => timer.showing(), seen, gone };
}

describe('the tooltip’s numbers', () => {
  it('are Excalidraw’s: half a second before the first, and a warm window of 300 ms', () => {
    expect([TOOLTIP_DELAY, TOOLTIP_WARM]).toEqual([500, 300]);
  });
});

describe('when a tip shows', () => {
  it('the first shows once the pointer has rested on a control for the delay, and not a moment before', () => {
    const { timer, pass, showing } = rig();
    timer.over('pen');
    pass(TOOLTIP_DELAY - 1);
    expect(showing()).toBeNull();
    pass(1);
    expect(showing()).toBe('pen');
  });

  it('leaving before the delay shows nothing, and the next control waits the whole delay again', () => {
    const { timer, pass, showing, seen } = rig();
    timer.over('pen');
    pass(TOOLTIP_DELAY - 1);
    timer.over('box');
    pass(TOOLTIP_DELAY - 1);
    expect(showing()).toBeNull();
    pass(1);
    expect(showing()).toBe('box');
    expect(seen).toEqual(['box']);
  });

  it('leaving for no control before the delay shows nothing, however long the pointer then rests on bare page', () => {
    const { timer, pass, showing, seen } = rig();
    timer.over('pen');
    pass(TOOLTIP_DELAY - 1);
    timer.over(null);
    pass(TOOLTIP_DELAY * 4);
    expect(showing()).toBeNull();
    expect(seen).toEqual([]);
    // Back on it, the wait begins again from nothing.
    timer.over('pen');
    pass(TOOLTIP_DELAY - 1);
    expect(showing()).toBeNull();
    pass(1);
    expect(showing()).toBe('pen');
  });

  it('a control that has left the page when its wait is over shows no tip, and the next control waits its own whole delay', () => {
    const { timer, pass, showing, seen, gone } = rig();
    timer.over('pen');
    pass(TOOLTIP_DELAY - 1);
    gone.add('pen');
    pass(1);
    expect(showing()).toBeNull();
    expect(seen).toEqual([]);
    // Nothing closed, so nothing is warm: the next one waits.
    timer.over('box');
    pass(TOOLTIP_DELAY - 1);
    expect(showing()).toBeNull();
    pass(1);
    expect(showing()).toBe('box');
  });

  it('moving inside the control (onto its icon, its word) does not start the wait again', () => {
    const { timer, pass, showing } = rig();
    timer.over('pen');
    pass(TOOLTIP_DELAY - 100);
    timer.over('pen');
    pass(100);
    expect(showing()).toBe('pen');
    timer.over('pen');
    expect(showing()).toBe('pen');
  });

  it('moving from one control to the next shows the next at once', () => {
    const { timer, pass, showing } = rig();
    timer.over('pen');
    pass(TOOLTIP_DELAY);
    timer.over('box');
    expect(showing()).toBe('box');
  });

  it('for the warm window after a tip closes the next shows at once, and one moment after it waits again', () => {
    const at = (gap: number) => {
      const { timer, pass, showing } = rig();
      timer.over('pen');
      pass(TOOLTIP_DELAY);
      timer.over(null);
      pass(gap);
      timer.over('box');
      return showing();
    };
    expect(at(TOOLTIP_WARM)).toBe('box');
    expect(at(TOOLTIP_WARM + 1)).toBeNull();
  });

  it('a press puts the tip away, and it stays away while the pointer stays on that control', () => {
    const { timer, pass, showing } = rig();
    timer.over('pen');
    pass(TOOLTIP_DELAY);
    timer.putAwayNow();
    expect(showing()).toBeNull();
    timer.over('pen');
    pass(TOOLTIP_DELAY * 4);
    expect(showing()).toBeNull();
    // Left and come back to: it shows again.
    timer.over(null);
    timer.over('pen');
    pass(TOOLTIP_DELAY);
    expect(showing()).toBe('pen');
  });

  it('a press before the tip shows puts that one away too', () => {
    const { timer, pass, showing } = rig();
    timer.over('pen');
    pass(TOOLTIP_DELAY - 1);
    timer.putAwayNow();
    pass(TOOLTIP_DELAY);
    expect(showing()).toBeNull();
    timer.over('pen');
    pass(TOOLTIP_DELAY);
    expect(showing()).toBeNull();
  });
});

describe('where a tip goes', () => {
  const view = { width: 1000, height: 800 };
  const tip = { width: 100, height: 20 };

  it('above a control in the lower half of the window, centred on it', () => {
    expect(placeTip({ left: 450, top: 720, width: 50, height: 56 }, tip, view)).toEqual({ left: 425, top: 720 - 5 - 20 });
  });

  it('below a control in the upper half', () => {
    expect(placeTip({ left: 450, top: 20, width: 50, height: 40 }, tip, view)).toEqual({ left: 425, top: 65 });
  });

  it('on the other side when there is no room, and never past an edge of the window', () => {
    // Low in the window, with no room above: below it.
    expect(placeTip({ left: 0, top: 404, width: 20, height: 10 }, { width: 100, height: 400 }, view).top).toBe(419);
    // Room above to the edge's own margin, and not a pixel less: above it.
    expect(placeTip({ left: 0, top: 410, width: 20, height: 10 }, { width: 100, height: 400 }, view).top).toBe(5);
    // High, with no room below: above it.
    expect(placeTip({ left: 0, top: 390, width: 20, height: 10 }, { width: 100, height: 400 }, view).top).toBe(390 - 5 - 400);
    expect(placeTip({ left: 0, top: 700, width: 20, height: 40 }, tip, view).left).toBe(5);
    expect(placeTip({ left: 980, top: 700, width: 20, height: 40 }, tip, view).left).toBe(1000 - 5 - 100);
  });
});

describe('do two boxes on the page cross', () => {
  const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height });

  it('when some of one lies inside the other, along both ways', () => {
    expect(crosses(box(0, 0, 100, 20), box(50, 10, 100, 20))).toBe(true);
    expect(crosses(box(50, 10, 100, 20), box(0, 0, 100, 20))).toBe(true);
    expect(crosses(box(0, 0, 100, 20), box(20, 5, 10, 5))).toBe(true);
    // Side by side at one height, and one over the other in one column: neither crosses.
    expect(crosses(box(0, 0, 100, 20), box(150, 0, 100, 20))).toBe(false);
    expect(crosses(box(0, 0, 100, 20), box(0, 50, 100, 20))).toBe(false);
  });

  it('boxes that only touch do not cross, and a box with no size crosses nothing', () => {
    // Edge to edge, each way round: side by side, and one on top of the other.
    expect(crosses(box(0, 0, 100, 20), box(100, 0, 100, 20))).toBe(false);
    expect(crosses(box(100, 0, 100, 20), box(0, 0, 100, 20))).toBe(false);
    expect(crosses(box(0, 0, 100, 20), box(0, 20, 100, 20))).toBe(false);
    expect(crosses(box(0, 20, 100, 20), box(0, 0, 100, 20))).toBe(false);
    expect(crosses(box(99, 19, 100, 20), box(0, 0, 100, 20))).toBe(true);
    expect(crosses(box(0, 0, 0, 0), box(0, 0, 0, 0))).toBe(false);
    // Not laid out, or one line with no height: inside the other box, and still nothing of it is there to cross.
    expect(crosses(box(10, 10, 0, 0), box(0, 0, 100, 20))).toBe(false);
    expect(crosses(box(0, 0, 100, 20), box(10, 10, 50, 0))).toBe(false);
  });
});

describe('the board’s tooltips', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    resetInput();
    vi.useRealTimers();
  });

  function open() {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 320, 100]));
    const src = localSource({ events: b.events });
    return { src, ...render(<App source={src} />) };
  }

  const tool = (name: string) => screen.getByRole('button', { name });
  const tip = () => screen.queryByRole('tooltip')?.textContent ?? null;
  const rest = (ms: number) => act(() => vi.advanceTimersByTime(ms));

  it('name the tool and its key, after the delay, in place of the browser’s own', () => {
    open();
    const pen = tool('Draw with the pen');
    expect(pen.hasAttribute('title')).toBe(false);
    fireEvent.pointerOver(pen, { pointerType: 'mouse' });
    rest(TOOLTIP_DELAY - 1);
    expect(tip()).toBeNull();
    rest(1);
    expect(tip()).toBe('Draw with the pen (P)');
    // The next one along shows at once.
    fireEvent.pointerOver(tool('Draw a box'), { pointerType: 'mouse' });
    expect(tip()).toBe('Draw a box (B)');
  });

  it('a control whose tip says nothing shows no tip: never an empty box', () => {
    open();
    const pen = tool('Draw with the pen');
    pen.dataset.tip = '';
    fireEvent.pointerOver(pen, { pointerType: 'mouse' });
    rest(TOOLTIP_DELAY);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a tip that lands on the hint line says so, so the line waits; a tip clear of the line does not', () => {
    // A test page lays nothing out: where things are is said here. The pen is in the toolbar, under the hint line.
    const places: Array<[string, number[]]> = [
      ['.hint', [400, 786, 400, 18]],
      ['[data-tool="pen"]', [500, 820, 50, 56]],
      ['[data-testid="presence"]', [1200, 20, 200, 40]],
      ['.tooltip', [0, 0, 120, 24]],
    ];
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const [left, top, width, height] = places.find(([selector]) => this.matches(selector))?.[1] ?? [0, 0, 0, 0];
      return { left: left!, top: top!, width: width!, height: height!, right: left! + width!, bottom: top! + height!, x: left!, y: top!, toJSON: () => ({}) };
    });
    open();
    Keyboard.press('p');
    expect(screen.getByTestId('hint')).toBeTruthy();
    fireEvent.pointerOver(tool('Draw with the pen'), { pointerType: 'mouse' });
    rest(TOOLTIP_DELAY);
    // Above the pen, across the line.
    expect(screen.getByRole('tooltip').style.top).toBe(`${820 - 5 - 24}px`);
    expect(screen.getByRole('tooltip').hasAttribute('data-on-hint')).toBe(true);
    // Under the agent's pill, at the top of the window: clear of it.
    fireEvent.pointerOver(screen.getByTestId('presence'), { pointerType: 'mouse' });
    expect(screen.getByRole('tooltip').style.top).toBe(`${20 + 40 + 5}px`);
    expect(screen.getByRole('tooltip').hasAttribute('data-on-hint')).toBe(false);
    vi.restoreAllMocks();
  });

  it('a tip whose foot alone reaches the hint line lands on it too: it is counted at the height it is drawn', () => {
    // The tip is 24 high, above the pen at 820: from 791 to 815. The line runs from 805 to 823, so the tip's top is clear of it.
    const places: Array<[string, number[]]> = [
      ['.hint', [400, 805, 400, 18]],
      ['[data-tool="pen"]', [500, 820, 50, 56]],
      ['.tooltip', [0, 0, 120, 24]],
    ];
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const [left, top, width, height] = places.find(([selector]) => this.matches(selector))?.[1] ?? [0, 0, 0, 0];
      return { left: left!, top: top!, width: width!, height: height!, right: left! + width!, bottom: top! + height!, x: left!, y: top!, toJSON: () => ({}) };
    });
    open();
    Keyboard.press('p');
    fireEvent.pointerOver(tool('Draw with the pen'), { pointerType: 'mouse' });
    rest(TOOLTIP_DELAY);
    expect(screen.getByRole('tooltip').style.top).toBe('791px');
    expect(screen.getByRole('tooltip').hasAttribute('data-on-hint')).toBe(true);
    vi.restoreAllMocks();
  });

  it('reads all it needs from the page before it writes its place: a tip costs the page one layout, not two', () => {
    /** Where the tip was, by its own styles, each time the hint line was read from the page with a tip up. */
    const placedAtRead: string[] = [];
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const up = document.querySelector<HTMLElement>('.tooltip');
      if (up && this.matches('.hint')) placedAtRead.push(up.style.left);
      const [left, top, width, height] = this.matches('[data-tool="pen"]') ? [500, 820, 50, 56] : this.matches('.tooltip') ? [0, 0, 120, 24] : [0, 0, 0, 0];
      return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) };
    });
    open();
    Keyboard.press('p');
    fireEvent.pointerOver(tool('Draw with the pen'), { pointerType: 'mouse' });
    rest(TOOLTIP_DELAY);
    expect(screen.getByRole('tooltip').style.left).toBe('465px');
    // The line was read while the tip had no place yet: a read after the write would have made the page lay itself out again.
    expect(placedAtRead[0]).toBe('');
    vi.restoreAllMocks();
  });

  it('the tips off the toolbar: a file’s Open keeps its name for a screen reader, the crumb names the key the table gives, a chapter’s head in the Story has one', async () => {
    const file = { id: 'f1', kind: 'file', box: [0, 0, 240, 80], name: 'depth.csv', asset: 'assets/depth.csv' } as unknown as MarkViewProps['item'];
    const one = render(<MarkView item={file} shown={[0, 0, 240, 80]} onOpen={() => {}} />);
    expect(screen.getByRole('button', { name: 'Open depth.csv' })).toBeTruthy();
    one.unmount();

    const crumb = render(<FocusCrumb crumb={{ back: 'Board', name: 'The queue' } as unknown as Crumb} onBack={() => {}} />);
    expect(keyWords('escape')).toBe('Esc');
    expect(screen.getByRole('button', { name: /Board/ }).dataset.tip).toBe('Back to the board (Esc)');
    crumb.unmount();

    const { container } = open();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Story' }));
    });
    const heads = [...container.querySelectorAll<HTMLElement>('.chapter__head')];
    expect(heads.length).toBeGreaterThan(0);
    for (const head of heads) expect(head.dataset.tip).toBe('Go to it on the board');
    expect(container.querySelectorAll('[title]')).toHaveLength(0);
  });

  it('every control that had a title has a tip, and still its accessible name', () => {
    const { container } = open();
    // Nothing on the page is left to the browser's own tooltip.
    expect([...container.querySelectorAll('[title]')].map((e) => e.outerHTML)).toEqual([]);
    expect(screen.getByTestId('presence').dataset.tip).toBe('The agent: listening');
    const zoom = screen.getByRole('group', { name: 'Zoom' });
    expect([...zoom.querySelectorAll<HTMLElement>('[data-tip]')].map((b) => b.dataset.tip)).toEqual(['Zoom out (-)', 'Back to 100% (0)', 'Zoom in (+)', 'Fit the board (1)']);
    for (const b of screen.getByRole('toolbar', { name: 'Tools' }).querySelectorAll('button')) {
      expect(b.dataset.tip, b.outerHTML).toBeTruthy();
      expect(b.getAttribute('aria-label') ?? b.textContent, b.outerHTML).toBeTruthy();
    }
  });

  it('a press anywhere puts the tip away, and so does Esc', () => {
    open();
    fireEvent.pointerOver(tool('Draw with the pen'), { pointerType: 'mouse' });
    rest(TOOLTIP_DELAY);
    expect(tip()).not.toBeNull();
    fireEvent.pointerDown(screen.getByTestId('board'), { pointerId: 1, button: 0 });
    expect(tip()).toBeNull();
    fireEvent.pointerUp(screen.getByTestId('board'), { pointerId: 1, button: 0 });
    fireEvent.pointerOver(tool('Draw a box'), { pointerType: 'mouse' });
    expect(tip()).toBe('Draw a box (B)');
    Keyboard.press('Escape');
    expect(tip()).toBeNull();
  });

  it('the window losing the focus puts the tip away, and so does the pointer leaving the window', () => {
    open();
    fireEvent.pointerOver(tool('Draw with the pen'), { pointerType: 'mouse' });
    rest(TOOLTIP_DELAY);
    expect(tip()).not.toBeNull();
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(tip()).toBeNull();
    fireEvent.pointerOver(tool('Draw a box'), { pointerType: 'mouse' });
    rest(TOOLTIP_DELAY);
    expect(tip()).toBe('Draw a box (B)');
    fireEvent.pointerOut(tool('Draw a box'), { pointerType: 'mouse', relatedTarget: null });
    expect(tip()).toBeNull();
  });

  it('a move inside the control, onto its icon or its word, keeps its tip', () => {
    open();
    const pen = tool('Draw with the pen');
    fireEvent.pointerOver(pen, { pointerType: 'mouse' });
    rest(TOOLTIP_DELAY);
    fireEvent.pointerOut(pen, { pointerType: 'mouse', relatedTarget: pen.querySelector('.tool__word') });
    fireEvent.pointerOver(pen.querySelector('.tool__word')!, { pointerType: 'mouse' });
    expect(tip()).toBe('Draw with the pen (P)');
  });

  it('never takes the focus: the control keeps it, and keys still reach it', () => {
    open();
    const pen = tool('Draw with the pen');
    pen.focus();
    fireEvent.pointerOver(pen, { pointerType: 'mouse' });
    rest(TOOLTIP_DELAY);
    const shown = screen.getByRole('tooltip');
    expect(shown.hasAttribute('tabindex')).toBe(false);
    expect(shown.querySelector('[tabindex], button, a, input')).toBeNull();
    expect(document.activeElement).toBe(pen);
  });

  it('a finger shows no tip', () => {
    open();
    fireEvent.pointerOver(tool('Draw with the pen'), { pointerType: 'touch' });
    rest(TOOLTIP_DELAY * 2);
    expect(tip()).toBeNull();
  });

  it('goes when its control leaves the page, and its words follow the control’s', async () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 320, 100]));
    b.must('owner', note('m2', [400, 0, 320, 100]));
    b.must('owner', { type: 'item.add', chapter: CH, item: { id: 'l1', kind: 'lasso', box: [0, 0, 800, 200], path: [0, 0, 800, 0, 800, 200], targets: [{ item: 'm1' }] } });
    const src = localSource({ events: b.events });
    render(<App source={src} />);
    const solidify = screen.getByRole('button', { name: /Solidify/ });
    fireEvent.pointerOver(solidify, { pointerType: 'mouse' });
    rest(TOOLTIP_DELAY);
    expect(tip()).toBe('Solidify the 1 item in your lasso (Shift+S)');
    await act(async () => {
      const r = await src.post({ type: 'item.add', chapter: CH, item: { id: 'l2', kind: 'lasso', box: [0, 0, 800, 200], path: [0, 0, 800, 0, 800, 200], targets: [{ item: 'm1' }, { item: 'm2' }] } });
      expect(r.ok).toBe(true);
    });
    expect(tip()).toBe('Solidify the 2 items in your lasso (Shift+S)');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Story' }));
    });
    expect(screen.queryByRole('toolbar', { name: 'Tools' })).toBeNull();
    expect(tip()).toBeNull();
  });

  it('a control that leaves the page while its tip still waits shows none when the wait is over', async () => {
    open();
    fireEvent.pointerOver(tool('Draw with the pen'), { pointerType: 'mouse' });
    rest(TOOLTIP_DELAY - 100);
    // The Story has no toolbar: the button is gone, and no pointer event says so.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Story' }));
    });
    expect(screen.queryByRole('toolbar', { name: 'Tools' })).toBeNull();
    rest(TOOLTIP_DELAY);
    expect(tip()).toBeNull();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });
});
