import { useEffect } from 'react';
import type { FrameScheduler } from '../frame';
import { oncePerFrame } from '../frame';
import type { BoardCtx, Device, EndReason, Mods, Point, Press, Sample, Tool } from '../tools/types';
import { onMac } from './match';
import type { Following } from './press';
import { follow, holdsBack, onControl, startsPress } from './press';

/**
 * The pointer on the board: every press goes through here, from the event the browser sends to
 * the tool that draws or moves. This is the part that touches the page; the rules it follows
 * are plain logic in `press.ts`.
 *
 * When a press is ended is Excalidraw's rule, read in its App.tsx at commit 9fbeaed and written
 * again for the board: a press that never got its up is ended by the next press, by the window
 * getting focus back and by a cancel, and moves are handled once a frame and flushed before the
 * up. What such an ending does is the board's own rule. Excalidraw replays the up, so a stroke
 * that was cut short is kept; the board cancels, and only a real lift commits, because here a
 * saved half stroke would go to the log and wake the agent. The board also keeps every sample
 * of a frame where Excalidraw keeps the last, and adds the press held back on a control.
 */

/** The few fields of a pointer event a sample is made from: the event itself, or one of its coalesced events. */
interface Reported {
  clientX: number;
  clientY: number;
  pressure: number;
  timeStamp: number;
}

/**
 * A pointer event as the dispatcher reads it: React's on the board, or the browser's own when
 * the window hears a pointer lift outside the board.
 */
export interface PointerInput extends Reported {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly button: number;
  readonly target: EventTarget | null;
  readonly currentTarget: EventTarget | null;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  preventDefault(): void;
  /** Every sample the browser collected since its last move event. */
  getCoalescedEvents?(): readonly Reported[];
  /** React's event carries the browser's own, which is the one that has the coalesced samples. */
  readonly nativeEvent?: { getCoalescedEvents?(): readonly Reported[] };
}

/** The board's pointer handlers, and what else the board asks about the pointer. */
export interface Pointers {
  down(e: PointerInput): void;
  move(e: PointerInput): void;
  up(e: PointerInput): void;
  cancel(e: PointerInput): void;
  /** The board lost its capture of a pointer. After a lift the browser says so too: by then the press is over, and this does nothing. */
  lost(e: PointerInput): void;
  /**
   * End the open press some other way than a lift: the window lost focus or got it back, the
   * page was hidden, or the owner pressed Esc. The tool puts back what it changed and posts
   * nothing. With no press open it does nothing.
   */
  end(why: Exclude<EndReason, 'up'>): void;
  /** The tool that has the open press, if a press is open and its tool has been told. */
  tool(): Tool | undefined;
  /** True while a press is open: the pointer went down on the board and has not ended. */
  open(): boolean;
  /**
   * Hand the tool every move that still waits for its frame, now. Whatever is about to move the
   * camera (the wheel) calls this first, so the moves land in the order they happened.
   */
  flush(): void;
  /** Where the pointer last was over the board, in page pixels. */
  last(): { x: number; y: number } | null;
}

/** Keep a pointer's events coming to the board, also outside it. A browser without capture still works. */
export function capture(el: Element | null, pointer: number): void {
  try {
    el?.setPointerCapture?.(pointer);
  } catch {
    // The pointer is gone already: nothing to capture.
  }
}

const deviceOf = (type: string): Device => (type === 'pen' ? 'pen' : type === 'touch' ? 'touch' : 'mouse');

const modsOf = (e: PointerInput): Mods => ({ shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey });

/**
 * Swallow the click the browser sends with the lift that is happening now: the press was a drag
 * for the tool, not a click for what is under the pointer. The click comes in the same turn as
 * the lift, so the wait ends with that turn, and at the next press at the latest: a click that
 * is the owner's own is never swallowed.
 */
function swallowClick(): void {
  const off = () => {
    clearTimeout(timer);
    window.removeEventListener('click', swallow, true);
    window.removeEventListener('pointerdown', off, true);
  };
  const swallow = (e: Event) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    off();
  };
  const timer = setTimeout(off, 0);
  window.addEventListener('click', swallow, true);
  window.addEventListener('pointerdown', off, true);
}

/** One press the dispatcher follows: the press, the tool it goes to, and its samples on their way to the tool. */
interface Followed {
  readonly press: Press;
  readonly tool: Tool;
  readonly flow: Following;
  /** True when the press began held back on a control: if it becomes a drag, the click after its lift is not the control's. */
  readonly wasHeld: boolean;
  /** Where the pointer was at its last event, in page pixels, and the keys held then. The press gets them with its next samples. */
  client: Point;
  mods: Mods;
}

/**
 * The pointer on the board: it makes each press, finds the tool the press is for, and hands
 * the tool the press as it goes down, moves and ends. `pick` says which tool a press goes to;
 * no tool means the press is not for the board's tools.
 *
 * - Presses are kept by pointer id, and one is open at a time. An event from any other pointer
 *   is not part of it.
 * - Moves are collected as they come and handed to the tool at most once a frame, all of them.
 * - A press ends in one way, `end`. Only a lift reaches the tool's `up`; every other ending is
 *   its `cancel`.
 * - With a drawing tool in hand, a press on a control inside an item is held back: a click is
 *   the control's, a drag is the tool's from the first point.
 *
 * `frames` is what asks the browser for a frame; a test hands in its own.
 */
export function createPointers(board: BoardCtx, pick: (press: Press) => Tool | undefined, frames: FrameScheduler = window): Pointers {
  const presses = new Map<number, Followed>();
  let last: { x: number; y: number } | null = null;

  /** A sample of the pointer as it is reported, with its world point by the camera of this moment. */
  const sampleOf = (e: Reported): Sample => {
    const [x, y] = board.toBoard(e.clientX, e.clientY);
    const cam = board.camera.get();
    return { x, y, wx: (x - cam.x) / cam.z, wy: (y - cam.y) / cam.z, pressure: e.pressure, t: e.timeStamp };
  };

  /** Hand a tool every sample of its press that waits, in one call. */
  const give = (f: Followed) => {
    const samples = f.flow.take();
    const at = samples.at(-1);
    if (!at) return;
    f.press.samples = samples;
    f.press.at = at;
    f.press.client = f.client;
    f.press.mods = f.mods;
    f.press.moved = f.flow.moved();
    f.tool.move(f.press, board);
  };

  const handOver = oncePerFrame(() => {
    for (const f of [...presses.values()]) give(f);
  }, frames);

  /** Follow a press from now on, and tell the page one is open. */
  const keep = (f: Followed) => {
    presses.set(f.press.pointer, f);
    board.showPressing(true);
  };

  /** Let a press go, and tell the page whether one is still open. */
  const letGo = (f: Followed) => {
    presses.delete(f.press.pointer);
    board.showPressing(presses.size > 0);
  };

  /**
   * The one way a press ends: `end(press, why)`, and for `up` the lift itself. Only `up`, the
   * owner lifting the pointer, reaches the tool's `up`, so only it can post to the log. Every
   * other ending is the tool's `cancel`. A press that is still held back was never the tool's:
   * it just goes, and a lift leaves the click to the control.
   */
  const end = (f: Followed, ...[why, lift]: [why: 'up', lift: PointerInput] | [why: Exclude<EndReason, 'up'>]): void => {
    if (presses.get(f.press.pointer) !== f) return;
    const told = f.flow.stage() === 'open';
    // The moves that wait go to the tool first, so it ends the press from where the pointer got to.
    if (told) handOver.flush();
    letGo(f);
    if (!told) return;
    if (why !== 'up') {
      f.tool.cancel(f.press, board, why);
      return;
    }
    f.press.at = sampleOf(lift);
    f.press.client = [lift.clientX, lift.clientY];
    f.press.mods = modsOf(lift);
    f.press.samples = [];
    if (f.wasHeld) swallowClick();
    f.tool.up(f.press, board);
  };

  return {
    down(e) {
      last = { x: e.clientX, y: e.clientY };
      // A press that is still open never got its up: it ends before the new one begins.
      for (const f of [...presses.values()]) end(f, 'superseded');
      if (!startsPress(e.button, e.ctrlKey, onMac())) return;
      // Leaving the note or the label saves it; this press does nothing else.
      if (board.editing()) return;
      const down = sampleOf(e);
      const client: [number, number] = [e.clientX, e.clientY];
      const press: Press = {
        pointer: e.pointerId,
        device: deviceOf(e.pointerType),
        button: e.button,
        target: e.target instanceof Element ? e.target : null,
        down,
        downClient: client,
        at: down,
        client,
        mods: modsOf(e),
        moved: false,
        samples: [],
      };
      const tool = pick(press);
      if (!tool) return;
      // The middle button pans: without this the browser starts its own autoscroll.
      if (e.button === 1) e.preventDefault();
      const held = holdsBack({ tool: board.tool(), isOwner: board.isOwner, button: press.button, spaceHeld: board.spaceHeld(), onControl: onControl(press.target) });
      // A held-back press is not the tool's yet: the tool is told when the press becomes a drag.
      if (!held && !tool.down(press, board)) return;
      keep({ press, tool, flow: follow(down, held), wasHeld: held, client, mods: press.mods });
    },
    move(e) {
      last = { x: e.clientX, y: e.clientY };
      const f = presses.get(e.pointerId);
      if (!f) return;
      // Every sample the browser collected since the last event, not only the last one.
      const coalesced = (e.nativeEvent ?? e).getCoalescedEvents?.() ?? [];
      const reported: readonly Reported[] = coalesced.length > 0 ? coalesced : [e];
      const now = reported.at(-1) ?? e;
      f.client = [now.clientX, now.clientY];
      f.mods = modsOf(e);
      const was = f.flow.stage();
      if (f.flow.add(reported.map(sampleOf)) === 'held') return;
      // The held-back press went far enough to be a drag: the tool gets it now as it went down,
      // and every sample since with its first frame.
      if (was === 'held' && !f.tool.down(f.press, board)) {
        letGo(f);
        return;
      }
      handOver();
    },
    up(e) {
      last = { x: e.clientX, y: e.clientY };
      const f = presses.get(e.pointerId);
      if (f) end(f, 'up', e);
    },
    cancel(e) {
      last = { x: e.clientX, y: e.clientY };
      const f = presses.get(e.pointerId);
      if (f) end(f, 'cancel');
    },
    lost(e) {
      // The event rises from whatever lost a capture: only the board's own loss ends the press.
      if (e.target !== e.currentTarget) return;
      const f = presses.get(e.pointerId);
      if (f) end(f, 'lost');
    },
    end(why) {
      for (const f of [...presses.values()]) {
        end(f, why);
        // After Esc the pointer is still down. The board keeps it, so its lift lands on the board
        // and is no click for what is under it: the owner took the press back.
        if (why === 'escape') board.capture(f.press.pointer);
      }
    },
    tool: () => [...presses.values()].find((f) => f.flow.stage() === 'open')?.tool,
    open: () => presses.size > 0,
    flush: () => handOver.flush(),
    last: () => last,
  };
}

/**
 * The ways a press ends that the board's own handlers do not hear, listened for on the window:
 * it loses focus or gets it back, the page is hidden, the owner presses Esc, or the pointer
 * lifts outside the board. The board leaving the page ends an open press too.
 *
 * Esc during a press is used up here, in the capture phase, so it does not also reach the
 * board's keys: it takes the press back and does nothing else. With no press open it is not
 * touched.
 */
export function usePressEndings(pointers: Pointers): void {
  useEffect(() => {
    const away = () => pointers.end('blur');
    const hidden = () => {
      if (document.visibilityState === 'hidden') pointers.end('blur');
    };
    /** True from the Esc that ended a press until that key comes up: while it is held, its repeats are used up too. */
    let escHeld = false;
    const keyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (pointers.open()) {
        escHeld = true;
        pointers.end('escape');
      } else if (!(escHeld && e.repeat)) {
        escHeld = false;
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const keyUp = (e: KeyboardEvent) => {
      if (e.key === 'Escape') escHeld = false;
    };
    window.addEventListener('blur', away);
    window.addEventListener('focus', away);
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('keydown', keyDown, true);
    window.addEventListener('keyup', keyUp, true);
    // The board's own handlers come first. These hear only a pointer that ended outside the board.
    window.addEventListener('pointerup', pointers.up);
    window.addEventListener('pointercancel', pointers.cancel);
    return () => {
      window.removeEventListener('blur', away);
      window.removeEventListener('focus', away);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('keyup', keyUp, true);
      window.removeEventListener('pointerup', pointers.up);
      window.removeEventListener('pointercancel', pointers.cancel);
      away();
    };
  }, [pointers]);
}
