import { act, screen } from '@testing-library/react';
import { vi } from 'vitest';

/**
 * Whole gestures for unit tests: a pointer with a type, an id and buttons, a keyboard that
 * tells the typed character from the key's place, the wheel, and frames. Every event carries
 * the keys held at the time, the way a browser on a Mac sends it, and is sent inside `act`.
 * Call `resetInput()` after each test, so no key or button stays down into the next one.
 *
 * Adapted from Excalidraw, packages/excalidraw/tests/helpers/ui.ts (its `Pointer` and
 * `Keyboard` classes), commit 9fbeaed. MIT, copyright 2020 Excalidraw.
 */

/** A point on the page: clientX and clientY. */
export type XY = readonly [x: number, y: number];

/** What a pointer is. Touch and pen are here so later work can use them; the board is tested with a mouse. */
export type PointerType = 'mouse' | 'pen' | 'touch';

export type Button = 'main' | 'middle' | 'right';

export interface Modifiers {
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

/** `button` is which one changed; `buttons` is the mask of those down. They count differently. */
const BUTTONS: Record<Button, { button: number; mask: number }> = {
  main: { button: 0, mask: 1 },
  right: { button: 2, mask: 2 },
  middle: { button: 1, mask: 4 },
};

/** The modifier keys held now: by `Keyboard.withModifierKeys`, or by a modifier key that is down. */
const held = { alt: false, ctrl: false, meta: false, shift: false };
let capsLock = false;

const MODIFIER_KEYS: Record<string, keyof typeof held> = { Alt: 'alt', Control: 'ctrl', Meta: 'meta', Shift: 'shift' };

function modifierInit(extra: Modifiers = {}) {
  return {
    altKey: held.alt || !!extra.alt,
    ctrlKey: held.ctrl || !!extra.ctrl,
    metaKey: held.meta || !!extra.meta,
    shiftKey: held.shift || !!extra.shift,
  };
}

/** Make `getModifierState` answer as a browser would, Caps Lock included. */
function withModifierState<E extends MouseEvent | KeyboardEvent>(e: E): E {
  const state: Record<string, boolean> = { Alt: e.altKey, Control: e.ctrlKey, Meta: e.metaKey, Shift: e.shiftKey, CapsLock: capsLock };
  Object.defineProperty(e, 'getModifierState', { value: (key: string) => state[key] ?? false });
  return e;
}

/** Dispatch inside `act`. False when a handler called `preventDefault`. */
function send(target: EventTarget, e: Event): boolean {
  let open = true;
  act(() => {
    open = target.dispatchEvent(e);
  });
  return open;
}

const board = (): Element => screen.getByTestId('board');

/**
 * One pointer: a mouse, a pen or a finger, with its own id. Two fingers are two pointers.
 * Positions are page coordinates. Events go to the board unless `on` names another element:
 * a test DOM has no layout, so nothing finds the element under a point. A primary pointer is
 * followed by the mouse events a browser sends after it. A move with a button down sends
 * `buttons` and a pressure of 0.5; without, 0 and 0.
 */
export class Pointer {
  /** The pointers with a button down, to tell which one is primary. */
  private static pressed = new Set<Pointer>();

  /** Lift every pointer without sending anything. `resetInput` calls it. */
  static resetAll(): void {
    Pointer.pressed.clear();
  }

  position: XY = [0, 0];
  private target: Element | undefined;
  private button: Button | undefined;
  private primary = true;
  /** The page cancelled the press: no mouse events follow it until the button is up. */
  private noMouse = false;

  constructor(
    readonly type: PointerType = 'mouse',
    readonly id = 1,
  ) {}

  /** Send this pointer's events to `el` from now on; with nothing, to the board again. */
  on(el?: Element): this {
    this.target = el;
    return this;
  }

  /** Move to a point, with or without a button down. */
  move(to: XY): void {
    this.position = to;
    const open = this.dispatch('pointermove');
    if (open && this.mouseFollows()) this.dispatchMouse('mousemove');
  }

  /** Press a button, after moving to `at` if given. A right press, or Ctrl with the main one, also asks for the context menu, as on a Mac. */
  down(at?: XY, button: Button = 'main'): void {
    if (at) this.move(at);
    this.button = button;
    this.primary = this.type === 'mouse' || ![...Pointer.pressed].some((p) => p.type === this.type);
    Pointer.pressed.add(this);
    this.noMouse = !this.dispatch('pointerdown');
    if (this.mouseFollows()) this.dispatchMouse('mousedown');
    if (button === 'right' || (button === 'main' && held.ctrl)) this.dispatchMouse('contextmenu');
  }

  /** Let the button go, after moving to `at` if given. */
  up(at?: XY): void {
    if (at) this.move(at);
    this.dispatch('pointerup');
    if (this.mouseFollows()) this.dispatchMouse('mouseup');
    this.lift();
  }

  /** The browser takes the pointer away mid-press (a system gesture, a lost window): no up, no click. */
  cancel(): void {
    this.dispatch('pointercancel');
    this.lift();
  }

  /** A press and a release in one place, then a `click`. A Ctrl-click makes no click, as on a Mac. */
  click(at?: XY, button: Button = 'main', detail = 1): void {
    this.down(at, button);
    this.up();
    if (button === 'main' && !held.ctrl) this.dispatchMouse('click', detail);
  }

  /** Two clicks, then a `dblclick`. */
  doubleClick(at?: XY): void {
    this.click(at, 'main', 1);
    this.click(at, 'main', 2);
    this.dispatchMouse('dblclick', 2);
  }

  /** Press at `from`, move to `to` in `steps` even moves, and let go there. */
  drag(from: XY, to: XY, { steps = 10, button = 'main' }: { steps?: number; button?: Button } = {}): void {
    this.down(from, button);
    for (let i = 1; i <= steps; i++) this.move([from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps]);
    this.up();
  }

  private lift(): void {
    this.button = undefined;
    this.noMouse = false;
    Pointer.pressed.delete(this);
  }

  /** Browsers send mouse events after a primary pointer's own, unless the press was cancelled. */
  private mouseFollows(): boolean {
    return this.primary && !this.noMouse;
  }

  private where(): Element {
    return this.target ?? board();
  }

  private dispatch(type: 'pointermove' | 'pointerdown' | 'pointerup' | 'pointercancel'): boolean {
    const down = type !== 'pointercancel' && this.button !== undefined ? BUTTONS[this.button] : undefined;
    const changes = type === 'pointerdown' || type === 'pointerup';
    const [clientX, clientY] = this.position;
    const e = new PointerEvent(type, {
      bubbles: true,
      cancelable: type !== 'pointercancel',
      composed: true,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
      pointerId: this.id,
      pointerType: this.type,
      isPrimary: this.primary,
      button: changes && down ? down.button : -1,
      buttons: down && type !== 'pointerup' ? down.mask : 0,
      pressure: down && type !== 'pointerup' ? 0.5 : 0,
      width: 1,
      height: 1,
      ...modifierInit(),
    });
    return send(this.where(), withModifierState(e));
  }

  private dispatchMouse(type: 'mousemove' | 'mousedown' | 'mouseup' | 'click' | 'dblclick' | 'contextmenu', detail = 0): boolean {
    const down = this.button !== undefined ? BUTTONS[this.button] : undefined;
    const [clientX, clientY] = this.position;
    const e = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      detail,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
      button: type === 'mousemove' ? 0 : (down?.button ?? 0),
      buttons: down && type !== 'mouseup' && type !== 'click' && type !== 'dblclick' ? down.mask : 0,
      ...modifierInit(),
    });
    return send(this.where(), withModifierState(e));
  }
}

/** What a key event can say besides the key: modifiers for this press only, a held-down repeat, and where it goes. */
export interface KeyOptions extends Modifiers {
  repeat?: boolean;
  /** Where the event goes. By default the focused element, or the body, as in a browser. */
  on?: EventTarget;
}

/** The physical key a US layout types `key` with, for when a test does not name one. */
function usCode(key: string): string {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  const named: Record<string, string> = { ' ': 'Space', '-': 'Minus', '=': 'Equal', '+': 'Equal', Alt: 'AltLeft', Control: 'ControlLeft', Meta: 'MetaLeft', Shift: 'ShiftLeft' };
  return named[key] ?? key;
}

function keyEvent(type: 'keydown' | 'keyup', key: string, code: string, opts: KeyOptions): boolean {
  const e = new KeyboardEvent(type, { bubbles: true, cancelable: true, composed: true, key, code, repeat: !!opts.repeat, ...modifierInit(opts) });
  return send(opts.on ?? document.activeElement ?? document.body, withModifierState(e));
}

/**
 * The keyboard. Each key is named twice: `key` is what it types on the owner's layout, `code`
 * is where it sits, named for a US layout. The key in the Z place on a Russian layout is
 * `press('я', 'KeyZ')`. Leave `code` out and it is the US place of `key`.
 *
 * A modifier key that is down (`keyDown('Shift')`) is held for every key, pointer and wheel
 * event until it is up. A press of Caps Lock turns it on or off, and every event reports it
 * through `getModifierState('CapsLock')`.
 */
export class Keyboard {
  /**
   * Hold these modifiers, and only these, for every event `run` sends; then put back what was
   * held before. `run` may be async: the keys stay held until it settles.
   */
  static withModifierKeys(modifiers: Modifiers, run: () => void): void;
  static withModifierKeys(modifiers: Modifiers, run: () => Promise<void>): Promise<void>;
  static withModifierKeys(modifiers: Modifiers, run: () => void | Promise<void>): void | Promise<void> {
    const before = { ...held };
    const restore = () => Object.assign(held, before);
    Object.assign(held, { alt: !!modifiers.alt, ctrl: !!modifiers.ctrl, meta: !!modifiers.meta, shift: !!modifiers.shift });
    let result: void | Promise<void>;
    try {
      result = run();
    } catch (e) {
      restore();
      throw e;
    }
    if (result instanceof Promise) return result.finally(restore);
    restore();
  }

  /** A key goes down. False when the page called `preventDefault`. */
  static keyDown(key: string, code = usCode(key), opts: KeyOptions = {}): boolean {
    const modifier = MODIFIER_KEYS[key];
    if (modifier) held[modifier] = true;
    if (key === 'CapsLock' && !opts.repeat) capsLock = !capsLock;
    return keyEvent('keydown', key, code, opts);
  }

  /** A key comes up. False when the page called `preventDefault`. */
  static keyUp(key: string, code = usCode(key), opts: KeyOptions = {}): boolean {
    const modifier = MODIFIER_KEYS[key];
    if (modifier) held[modifier] = false;
    return keyEvent('keyup', key, code, opts);
  }

  /** A key down and up. False when the page called `preventDefault` on the down. */
  static press(key: string, code = usCode(key), opts: KeyOptions = {}): boolean {
    const open = Keyboard.keyDown(key, code, opts);
    Keyboard.keyUp(key, code, opts);
    return open;
  }
}

/** One turn of the wheel or of two fingers on a trackpad. A trackpad pinch is a wheel with `ctrl`. */
export interface WheelInput extends Modifiers {
  dx?: number;
  dy?: number;
  /** What the deltas count: pixels (a trackpad, most mice), lines or pages (some mice, some systems). */
  mode?: 'pixel' | 'line' | 'page';
  /** Where the pointer is. By default the middle of `el`, or the corner of a page with no layout. */
  at?: XY;
}

const DELTA_MODE = { pixel: 0, line: 1, page: 2 } as const;

/** Send one wheel event to `el`, with the keys held as well as those given. False when the page called `preventDefault`. */
export function wheel(el: Element, { dx = 0, dy = 0, mode = 'pixel', at, ...modifiers }: WheelInput): boolean {
  const r = el.getBoundingClientRect();
  const [clientX, clientY] = at ?? [r.left + r.width / 2, r.top + r.height / 2];
  const mouse = { clientX, clientY, screenX: clientX, screenY: clientY, button: 0, buttons: 0, ...modifierInit(modifiers) };
  const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, composed: true, deltaX: dx, deltaY: dy, deltaMode: DELTA_MODE[mode], ...mouse });
  // happy-dom's WheelEvent is not a MouseEvent: give it what a browser's carries.
  for (const [k, v] of Object.entries(mouse)) if (!(k in e)) Object.defineProperty(e, k, { value: v });
  return send(el, withModifierState(e));
}

/**
 * Let one animation frame pass, and what React does after it. Works with real timers and with
 * vitest's fake ones (which then must fake `requestAnimationFrame` too: the default list does).
 */
export async function frame(): Promise<void> {
  if (vi.isFakeTimers()) {
    await act(async () => {
      vi.advanceTimersToNextFrame();
    });
    return;
  }
  await act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));
}

/** Let `n` animation frames pass. */
export async function frames(n: number): Promise<void> {
  for (let i = 0; i < n; i++) await frame();
}

/** Lift every key and pointer, and turn Caps Lock off. Call it after each test. */
export function resetInput(): void {
  Object.assign(held, { alt: false, ctrl: false, meta: false, shift: false });
  capsLock = false;
  Pointer.resetAll();
}
