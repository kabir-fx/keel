import type { BoardEvent } from '@keel/protocol';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, PEN_PAUSE } from '../src/App';
import { useOneUse } from '../src/board/oneUse';
import { ZOOM_STEP } from '../src/input/constants';
import { localSource } from '../src/source';
import type { Label } from '../src/tools/types';
import { note, openBoard } from './helpers';
import { Keyboard, Pointer, frame, resetInput } from './pointer';

/**
 * The keys on the board itself: Space and the window's focus, the tools that are used once,
 * keys while a press is open, the browser's zoom keys, and where the focus goes after a click on
 * the toolbar. The key table as plain logic is in `keys.test.ts`.
 */

afterEach(() => {
  cleanup();
  resetInput();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
  // A press ends whatever still waits for the click of the last lift.
  window.dispatchEvent(new Event('pointerdown'));
});

/** A board with two notes of the owner's, `m1` and `m2`. */
function open() {
  const b = openBoard();
  b.must('owner', note('m1', [0, 0, 320, 100]));
  b.must('owner', note('m2', [600, 0, 320, 100]));
  const src = localSource({ events: b.events });
  const { container } = render(<App source={src} />);
  const n = src.events.length;
  return {
    src,
    container,
    /** What was posted since the board opened. */
    posted: (): BoardEvent[] => src.events.slice(n),
  };
}

/** The camera, read back from the world's transform: screen = world * z + (x, y). */
function camera(container: HTMLElement) {
  const t = container.querySelector<HTMLElement>('.world')!.style.transform;
  const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(t)!;
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}

const app = () => document.querySelector<HTMLElement>('.app')!;
const tool = () => app().getAttribute('data-tool');
const panning = () => app().hasAttribute('data-pan');
const shape = () => screen.getByTestId('live').querySelector<HTMLElement>('.live-box, .live-line');
const label = () => screen.queryByRole<HTMLTextAreaElement>('textbox', { name: 'A few words' });
const noteField = () => screen.queryByRole<HTMLTextAreaElement>('textbox', { name: 'Your note' });
const toast = () => screen.queryByTestId('toast')?.textContent ?? null;
const toolButton = (name: string) => screen.getByRole('button', { name });

/** Let what was posted land, and what React does after it. */
const settle = () => act(async () => {});

/** Send an event to the window, as the browser would. */
function tell(target: EventTarget, e: Event): void {
  act(() => {
    target.dispatchEvent(e);
  });
}

/** The marks added since the board opened. */
const added = (events: BoardEvent[]) => events.filter((e): e is Extract<BoardEvent, { type: 'item.add' }> => e.type === 'item.add').map((e) => e.item);

/** Drag with the tool in hand, far enough to be meant: from the ground to the ground. */
function dragOnGround(): void {
  const mouse = new Pointer();
  mouse.down([700, 400]);
  mouse.move([760, 440]);
  mouse.move([900, 520]);
  mouse.up();
}

/**
 * Give the note `m1` a place on the page, 100 by 60 at (400, 300): a test page has no layout,
 * and a pin or a lasso needs a thing under it.
 */
function layOutNote(): void {
  const real = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.dataset.item === 'm1' ? new DOMRect(400, 300, 100, 60) : real.call(this);
  });
}

describe('Space, and the keys that are held', () => {
  it('Space, then the window loses focus, then a drag: no pan', async () => {
    const { container } = open();
    Keyboard.press('b');
    const before = camera(container);
    Keyboard.keyDown(' ');
    expect(panning()).toBe(true);
    // The owner goes to another window with Space still down: its up never reaches the page.
    tell(window, new Event('blur'));
    expect(panning()).toBe(false);
    dragOnGround();
    await frame();
    // The drag was the Box tool's: it drew a box, and the board did not move.
    expect(label()).not.toBeNull();
    expect(camera(container)).toEqual(before);
  });

  it('Space held pans with a drawing tool in hand, and letting go gives the tool back', async () => {
    const { container } = open();
    Keyboard.press('b');
    const before = camera(container);
    expect(Keyboard.keyDown(' ')).toBe(false);
    dragOnGround();
    await frame();
    expect(label()).toBeNull();
    expect(camera(container)).toEqual({ ...before, x: before.x + 200, y: before.y + 120 });
    Keyboard.keyUp(' ');
    expect(panning()).toBe(false);
    expect(tool()).toBe('box');
  });

  it('Space with a press open arms nothing, and arms once the press is over while it is still held', async () => {
    open();
    Keyboard.press('b');
    const mouse = new Pointer();
    mouse.down([700, 400]);
    mouse.move([800, 480]);
    await frame();
    // Space is still taken from the browser: it must not scroll the page or press a button.
    expect(Keyboard.keyDown(' ')).toBe(false);
    expect(panning()).toBe(false);
    mouse.up();
    expect(label()).not.toBeNull();
    fireEvent.keyDown(label()!, { key: 'Escape' });
    await settle();
    // The key is still down and sends its repeats: with no press open, it arms the pan.
    Keyboard.keyDown(' ', 'Space', { repeat: true });
    expect(panning()).toBe(true);
    Keyboard.keyUp(' ');
    expect(panning()).toBe(false);
  });

  it('a key let go under Cmd sends no up on a Mac: letting Cmd go lets Space go too', () => {
    open();
    Keyboard.keyDown(' ');
    expect(panning()).toBe(true);
    Keyboard.keyDown('Meta');
    Keyboard.keyUp('Meta');
    expect(panning()).toBe(false);
  });

  it('Talk stops listening when the window loses focus with T still down', async () => {
    const stopped = vi.fn();
    hearing(stopped);
    open();
    Keyboard.keyDown('t');
    expect(screen.getByTestId('talk-caption')).toBeTruthy();
    // A held key repeats: Talk starts once.
    Keyboard.keyDown('t', 'KeyT', { repeat: true });
    tell(window, new Event('blur'));
    await settle();
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('talk-caption')).toBeNull();
  });

  it('a held key is let go by its place, as it went down: T on a Russian keyboard, and T with Caps Lock on', async () => {
    const stopped = vi.fn();
    hearing(stopped);
    open();
    // The key in the T place types "е" on a Russian keyboard.
    Keyboard.keyDown('е', 'KeyT');
    expect(screen.getByTestId('talk-caption')).toBeTruthy();
    Keyboard.keyUp('е', 'KeyT');
    await settle();
    expect(stopped).toHaveBeenCalledTimes(1);
    // With Caps Lock on, the key goes down and comes up as a capital.
    Keyboard.press('CapsLock');
    Keyboard.keyDown('T', 'KeyT');
    expect(screen.getByTestId('talk-caption')).toBeTruthy();
    Keyboard.keyUp('T', 'KeyT');
    await settle();
    expect(stopped).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('talk-caption')).toBeNull();
  });
});

/** The browser's speech recognition, as a double that hears nothing: Talk can start and stop. */
function hearing(stopped: () => void = () => {}): void {
  class Recognition {
    lang = '';
    continuous = false;
    interimResults = false;
    onresult: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    start() {}
    stop() {
      stopped();
      this.onend?.();
    }
    abort() {}
  }
  (window as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition = Recognition;
}

describe('keys while a press is open', () => {
  it('a tool key during a press changes nothing: the tool stays, and so does what is being drawn', async () => {
    open();
    Keyboard.press('b');
    const mouse = new Pointer();
    mouse.down([700, 400]);
    mouse.move([800, 480]);
    await frame();
    expect(shape()).not.toBeNull();
    for (const key of ['p', 'v', 'h', 'a', 'n', 'i', 'l']) Keyboard.press(key);
    expect(tool()).toBe('box');
    expect(shape()).not.toBeNull();
    mouse.up();
    expect(label()).not.toBeNull();
  });
});

describe('the tools that are used once', () => {
  it('the Box drops back to Select once its mark is posted, and the new box is selected', async () => {
    const { container, posted } = open();
    Keyboard.press('b');
    dragOnGround();
    // The box waits for its words: the Box is still in hand.
    expect(label()).not.toBeNull();
    expect(tool()).toBe('box');
    fireEvent.input(label()!, { target: { value: 'the slow part' } });
    Keyboard.press('Enter');
    await settle();
    const [box] = added(posted());
    expect(box).toMatchObject({ kind: 'box', text: 'the slow part' });
    expect(tool()).toBe('select');
    expect(container.querySelector(`[data-item="${box!.id}"]`)!.className).toContain('item--selected');
  });

  it('the Arrow drops back too, also when Esc keeps it with no words', async () => {
    const { container, posted } = open();
    Keyboard.press('a');
    dragOnGround();
    expect(tool()).toBe('arrow');
    fireEvent.keyDown(label()!, { key: 'Escape' });
    await settle();
    const [arrow] = added(posted());
    expect(arrow).toMatchObject({ kind: 'arrow' });
    expect(tool()).toBe('select');
    expect(container.querySelector(`[data-item="${arrow!.id}"]`)!.className).toContain('item--selected');
  });

  it('the Pin drops back once its pin is posted', async () => {
    layOutNote();
    const { container, posted } = open();
    Keyboard.press('i');
    new Pointer().click([450, 330]);
    expect(label()).not.toBeNull();
    expect(tool()).toBe('pin');
    fireEvent.input(label()!, { target: { value: 'here' } });
    Keyboard.press('Enter');
    await settle();
    const [pin] = added(posted());
    expect(pin).toMatchObject({ kind: 'pin', text: 'here', on: { item: 'm1' } });
    expect(tool()).toBe('select');
    expect(container.querySelector(`[data-item="${pin!.id}"]`)!.className).toContain('item--selected');
  });

  it('the Pin drops back when its label is dropped, and nothing is posted', async () => {
    layOutNote();
    const { posted } = open();
    Keyboard.press('i');
    new Pointer().click([450, 330]);
    fireEvent.keyDown(label()!, { key: 'Escape' });
    await settle();
    expect(posted()).toHaveLength(0);
    expect(tool()).toBe('select');
  });

  it('a press that made no mark is no use: a box too small, a pin on bare ground', () => {
    open();
    Keyboard.press('b');
    const mouse = new Pointer();
    mouse.down([700, 400]);
    mouse.move([705, 406]);
    mouse.up();
    expect(label()).toBeNull();
    expect(tool()).toBe('box');
    Keyboard.press('i');
    new Pointer().click([700, 400]);
    expect(label()).toBeNull();
    expect(tool()).toBe('pin');
  });

  it('a tool the owner takes while the label is open stays in hand', async () => {
    const { posted } = open();
    Keyboard.press('b');
    dragOnGround();
    const field = label()!;
    // A click on the toolbar takes the focus from the field, which keeps the box, and then takes the Pen.
    act(() => field.blur());
    fireEvent.click(toolButton('Draw with the pen'));
    await settle();
    expect(added(posted())).toHaveLength(1);
    expect(tool()).toBe('pen');
  });

  it('a label that closes with another tool in hand leaves that tool where it is: Undo can bring a label back at any time', () => {
    const setTool = vi.fn();
    const board = { tool: () => 'pen' as const, setTool, select: vi.fn() };
    const boxLabel: Label = { kind: 'box', box: [0, 0, 100, 80], at: [8, 22] };
    const hook = renderHook(({ label }: { label: Label | null }) => useOneUse(board, label, async () => true), { initialProps: { label: boxLabel as Label | null } });
    hook.rerender({ label: null });
    expect(setTool).not.toHaveBeenCalled();
    // With the Box itself still in hand, the same closing puts it down.
    const inHand = { ...board, tool: () => 'box' as const };
    const again = renderHook(({ label }: { label: Label | null }) => useOneUse(inHand, label, async () => true), { initialProps: { label: boxLabel as Label | null } });
    again.rerender({ label: null });
    expect(setTool).toHaveBeenCalledWith('select');
  });

  it('the Pen stays in hand after a go has become a mark, and the ink is not selected', async () => {
    vi.useFakeTimers();
    const { container, posted } = open();
    Keyboard.press('p');
    dragOnGround();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PEN_PAUSE + 50);
    });
    const [ink] = added(posted());
    expect(ink).toMatchObject({ kind: 'ink' });
    expect(tool()).toBe('pen');
    expect(container.querySelector(`[data-item="${ink!.id}"]`)!.className).not.toContain('item--selected');
  });

  it('the Lasso stays in hand after a loop is posted, and the loop is not selected', async () => {
    layOutNote();
    const { container, posted } = open();
    Keyboard.press('l');
    const mouse = new Pointer();
    mouse.down([380, 280]);
    for (const at of [[520, 280], [520, 380], [380, 380], [380, 290], [384, 284]] as const) {
      for (let i = 1; i <= 4; i++) mouse.move([mouse.position[0] + ((at[0] - mouse.position[0]) * i) / 4, mouse.position[1] + ((at[1] - mouse.position[1]) * i) / 4]);
    }
    mouse.up();
    await settle();
    const [loop] = added(posted());
    expect(loop).toMatchObject({ kind: 'lasso', targets: [{ item: 'm1' }] });
    expect(tool()).toBe('lasso');
    expect(container.querySelector(`[data-item="${loop!.id}"]`)!.className).not.toContain('item--selected');
  });
});

describe('Cmd or Ctrl with plus, minus and 0', () => {
  it('on the board: the board zooms, and the key is taken from the browser', () => {
    const { container } = open();
    const z = camera(container).z;
    expect(Keyboard.press('=', 'Equal', { meta: true })).toBe(false);
    expect(camera(container).z).toBeCloseTo(z * ZOOM_STEP, 6);
    expect(Keyboard.press('+', 'Equal', { ctrl: true, shift: true })).toBe(false);
    expect(camera(container).z).toBeCloseTo(z * ZOOM_STEP * ZOOM_STEP, 6);
    expect(Keyboard.press('-', 'Minus', { meta: true })).toBe(false);
    expect(camera(container).z).toBeCloseTo(z * ZOOM_STEP, 6);
    expect(Keyboard.press('0', 'Digit0', { meta: true })).toBe(false);
    expect(camera(container).z).toBe(1);
  });

  it('over a panel, with a button of the toolbar in focus: the same', () => {
    const { container } = open();
    const z = camera(container).z;
    const button = toolButton('Draw a box');
    act(() => button.focus());
    expect(document.activeElement).toBe(button);
    expect(Keyboard.press('=', 'Equal', { meta: true })).toBe(false);
    expect(camera(container).z).toBeCloseTo(z * ZOOM_STEP, 6);
    expect(Keyboard.press('-', 'Minus', { ctrl: true })).toBe(false);
    expect(camera(container).z).toBeCloseTo(z, 6);
  });

  it('in the Story: the key is taken, so the page is never zoomed, and the board’s zoom stays as it was', () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 320, 100]));
    const { container } = render(<App source={localSource({ events: b.events })} mode="story" />);
    const z = camera(container).z;
    expect(Keyboard.press('=', 'Equal', { meta: true })).toBe(false);
    expect(Keyboard.press('+', 'Equal', { ctrl: true, shift: true })).toBe(false);
    expect(Keyboard.press('-', 'Minus', { meta: true })).toBe(false);
    expect(Keyboard.press('0', 'Digit0', { meta: true })).toBe(false);
    expect(camera(container).z).toBe(z);
    // Cmd with another digit still changes the browser's tab.
    expect(Keyboard.press('1', 'Digit1', { meta: true })).toBe(true);
  });

  it('while typing in a note: the board zooms, the key is taken, and the note stays open with its words', () => {
    const { container, posted } = open();
    Keyboard.press('n');
    new Pointer().click([900, 500]);
    const field = noteField()!;
    fireEvent.input(field, { target: { value: 'half a thought' } });
    expect(document.activeElement).toBe(field);
    const z = camera(container).z;
    expect(Keyboard.press('=', 'Equal', { meta: true })).toBe(false);
    expect(camera(container).z).toBeCloseTo(z * ZOOM_STEP, 6);
    expect(Keyboard.press('-', 'Minus', { meta: true })).toBe(false);
    expect(camera(container).z).toBeCloseTo(z, 6);
    expect(noteField()?.value).toBe('half a thought');
    expect(posted()).toHaveLength(0);
    // Without Cmd or Ctrl the same keys are letters for the note.
    expect(Keyboard.press('=', 'Equal')).toBe(true);
    expect(Keyboard.press('-', 'Minus')).toBe(true);
    expect(camera(container).z).toBeCloseTo(z, 6);
  });
});

describe('what a key leaves to the browser', () => {
  it('a key the board uses is taken; Esc, and an arrow with no walk selected, stay the browser’s as well', () => {
    open();
    expect(Keyboard.press('p')).toBe(false);
    expect(tool()).toBe('pen');
    expect(Keyboard.press('Escape')).toBe(true);
    expect(tool()).toBe('select');
    expect(Keyboard.press('ArrowRight')).toBe(true);
    expect(Keyboard.press('x')).toBe(true);
  });

  it('Page Down and Page Up move the board a page, and 2 fits what is selected', () => {
    const { container } = open();
    const before = camera(container);
    expect(Keyboard.press('PageDown')).toBe(false);
    const down = camera(container);
    expect(down.y).toBeLessThan(before.y);
    expect(down.x).toBe(before.x);
    expect(Keyboard.press('PageUp')).toBe(false);
    expect(camera(container)).toEqual(before);
    new Pointer().on(container.querySelector<HTMLElement>('[data-item="m2"]')!).click([10, 10]);
    expect(Keyboard.press('2')).toBe(false);
    // The second note alone is in view now: the first one is off to the left of where it was.
    expect(camera(container).x).toBeLessThan(before.x);
  });

  it('Esc lets the selection go', () => {
    const { container } = open();
    const el = container.querySelector<HTMLElement>('[data-item="m2"]')!;
    new Pointer().on(el).click([10, 10]);
    expect(el.className).toContain('item--selected');
    Keyboard.press('Escape');
    expect(el.className).not.toContain('item--selected');
  });

  it('Esc held down runs once: the tool the owner takes while it is held stays', () => {
    open();
    Keyboard.keyDown('Escape');
    fireEvent.click(toolButton('Draw with the pen'));
    Keyboard.keyDown('Escape', 'Escape', { repeat: true });
    expect(tool()).toBe('pen');
    Keyboard.keyUp('Escape');
    Keyboard.press('Escape');
    expect(tool()).toBe('select');
  });
});

describe('the toolbar and the focus', () => {
  it('after a click by the pointer the focus is the page’s again, so the next key is the board’s', () => {
    open();
    const button = toolButton('Draw a box');
    act(() => button.focus());
    fireEvent.click(button, { detail: 1 });
    expect(tool()).toBe('box');
    expect(document.activeElement).not.toBe(button);
    expect(document.activeElement).toBe(document.body);
  });

  it('a click made with the keyboard keeps its place among the buttons', () => {
    open();
    const button = toolButton('Draw a box');
    act(() => button.focus());
    fireEvent.click(button, { detail: 0 });
    expect(tool()).toBe('box');
    expect(document.activeElement).toBe(button);
  });

  it('Space on a button reached with the keyboard is the button’s: it is left to the browser, and arms no pan', () => {
    open();
    const button = toolButton('Draw a box');
    Keyboard.press('Tab');
    act(() => button.focus());
    expect(Keyboard.keyDown(' ')).toBe(true);
    expect(panning()).toBe(false);
    Keyboard.keyUp(' ');
    // Other keys are still the board's.
    expect(Keyboard.press('p')).toBe(false);
    expect(tool()).toBe('pen');
  });

  it('after a click by the pointer on the toolbar Space pans again, and does not press the button', () => {
    open();
    const button = toolButton('Draw a box');
    act(() => button.focus());
    fireEvent.click(button, { detail: 1 });
    expect(Keyboard.keyDown(' ')).toBe(false);
    expect(panning()).toBe(true);
    Keyboard.keyUp(' ');
    expect(panning()).toBe(false);
  });

  it('Space on the Talk button starts Talk, and the board leaves the key alone: no pan while the owner talks', async () => {
    hearing();
    open();
    const talk = document.querySelector<HTMLElement>('button[data-tool="talk"]')!;
    act(() => talk.focus());
    expect(Keyboard.keyDown(' ')).toBe(false);
    await settle();
    expect(screen.getByTestId('talk-caption')).toBeTruthy();
    expect(panning()).toBe(false);
    Keyboard.keyUp(' ');
    await settle();
    expect(screen.queryByTestId('talk-caption')).toBeNull();
  });

  it('a key that something on the page has already taken is left alone: the board does nothing with it', () => {
    open();
    // A part of the page with a key of its own: it hears the key before the board does, and takes it.
    const own = (e: KeyboardEvent) => {
      if (e.key === 'p') e.preventDefault();
    };
    document.addEventListener('keydown', own);
    try {
      Keyboard.press('p');
      expect(tool()).toBe('select');
    } finally {
      document.removeEventListener('keydown', own);
    }
    Keyboard.press('p');
    expect(tool()).toBe('pen');
  });

  it('whichever button of the toolbar had the focus, a click on any of them gives it back', () => {
    open();
    const button = toolButton('Draw an arrow');
    act(() => button.focus());
    fireEvent.click(screen.getByRole('toolbar', { name: 'Tools' }).querySelector('[data-tool="select"]')!, { detail: 1 });
    expect(document.activeElement).toBe(document.body);
    expect(toast()).toBeNull();
  });
});

describe('who put the focus on a button: Space presses it only when the keyboard did', () => {
  /** A button that keeps the focus after a click: the zoom control's, which gives nothing back. */
  const zoomIn = () => toolButton('Zoom in');

  /**
   * The pointer presses a button. In a browser the press puts the focus on it; a test page moves
   * no focus, so the test does, as the browser would: only when the button did not have it.
   */
  function pressWithPointer(button: HTMLElement): void {
    const mouse = new Pointer().on(button);
    mouse.down([10, 10]);
    if (document.activeElement !== button) act(() => button.focus());
    mouse.up();
  }

  /** Tab to a button: the key goes down, and the browser moves the focus. */
  function tabTo(button: HTMLElement): void {
    Keyboard.press('Tab');
    act(() => button.focus());
  }

  it('after a press of the pointer on a button, Space arms the pan and is taken from the browser', () => {
    open();
    pressWithPointer(zoomIn());
    expect(document.activeElement).toBe(zoomIn());
    expect(Keyboard.keyDown(' ')).toBe(false);
    expect(panning()).toBe(true);
    Keyboard.keyUp(' ');
    expect(panning()).toBe(false);
  });

  it('after Tab to a button, Space is left to the browser, and arms nothing', () => {
    open();
    tabTo(zoomIn());
    expect(Keyboard.keyDown(' ')).toBe(true);
    expect(panning()).toBe(false);
    Keyboard.keyUp(' ');
  });

  it('a button the keyboard put the focus on, then pressed with the pointer: Space is the board’s again', () => {
    open();
    tabTo(zoomIn());
    pressWithPointer(zoomIn());
    expect(document.activeElement).toBe(zoomIn());
    expect(Keyboard.keyDown(' ')).toBe(false);
    expect(panning()).toBe(true);
    Keyboard.keyUp(' ');
  });

  it('a bare Cmd down and up between the click and the Space changes nothing, also when the window gets its focus back in between', () => {
    open();
    pressWithPointer(zoomIn());
    // Cmd goes down to leave the window; when the window comes back, the button hears the focus again.
    Keyboard.keyDown('Meta');
    tell(window, new Event('blur'));
    tell(zoomIn(), new FocusEvent('focusin', { bubbles: true }));
    Keyboard.keyUp('Meta');
    expect(Keyboard.keyDown(' ')).toBe(false);
    expect(panning()).toBe(true);
    Keyboard.keyUp(' ');
  });

  it('a focus that a handler moves on a key press is the keyboard’s, even when the handler hears the key before the board', () => {
    open();
    const moveFocus = (e: KeyboardEvent) => {
      if (e.key === 'Enter') zoomIn().focus();
    };
    document.body.addEventListener('keydown', moveFocus);
    try {
      Keyboard.press('Enter');
    } finally {
      document.body.removeEventListener('keydown', moveFocus);
    }
    expect(document.activeElement).toBe(zoomIn());
    expect(Keyboard.keyDown(' ')).toBe(true);
    expect(panning()).toBe(false);
    Keyboard.keyUp(' ');
  });
});
