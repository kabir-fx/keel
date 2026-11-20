import type { Presence } from '@keel/protocol';
import { act, cleanup, render, screen } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { AgentPill } from '../src/board/presence';
import { CameraStore } from '../src/camera/camera';
import { PILL_NOTE_MAX } from '../src/chrome';
import type { FrameScheduler } from '../src/frame';
import { FrameLoop } from '../src/frame';
import { EASE } from '../src/motion/ease';
import type { Point } from '../src/motion/path';
import { arc, at as along, distance } from '../src/motion/path';
import { CURSOR_ENTER_MS, CURSOR_TRAVEL_MAX_MS, travelMs } from '../src/motion/timing';
import { CURSOR_BESIDE, CURSOR_DOWN, CURSOR_SIZE, CURSOR_TAG_FROM, cursorLook, cursorPoint, cursorSays, entryPoint, placeCursor, tagWords } from '../src/overlay/cursorPlace';
import { AgentCursor } from '../src/overlay/cursor';
import { AgentCursorStore } from '../src/overlay/cursorStore';
import { localSource } from '../src/source';
import { note, openBoard } from './helpers';
import { frame, frames, resetInput, wheel } from './pointer';
import { reduceMotion } from './reducedMotion';

const presence = (p: Omit<Presence, 'since'>): Presence => ({ since: '2026-11-19T10:00:00Z', ...p });

/** The cross product of a→b and a→c: zero when the three points are on one line. */
const cross = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

describe('where the agent’s cursor is drawn', () => {
  const size = { w: 1000, h: 800 };
  const cam = { x: 100, y: 50, z: 2 };

  it('at its world point through the camera, in board pixels', () => {
    expect(placeCursor([200, 150], cam, size)).toEqual({ x: 500, y: 350, off: false, flip: false });
  });

  it('is on the board up to each edge, and off one pixel past it', () => {
    // Screen x = wx * 2 + 100: the left edge is wx = -50, the right one wx = 450.
    expect(placeCursor([-50, 100], cam, size).off).toBe(false);
    expect(placeCursor([-50.5, 100], cam, size).off).toBe(true);
    expect(placeCursor([450, 100], cam, size).off).toBe(false);
    expect(placeCursor([450.5, 100], cam, size).off).toBe(true);
    // Screen y = wy * 2 + 50: the top edge is wy = -25, the bottom one wy = 375.
    expect(placeCursor([100, -25], cam, size).off).toBe(false);
    expect(placeCursor([100, -25.5], cam, size).off).toBe(true);
    expect(placeCursor([100, 375], cam, size).off).toBe(false);
    expect(placeCursor([100, 375.5], cam, size).off).toBe(true);
  });

  it('its tag hangs right of the point when it fits inside the board, and left of it when it does not', () => {
    const at1 = { x: 0, y: 0, z: 1 };
    // From the point, the tag starts past the arrow: 24 px, then 60 px of tag.
    expect(CURSOR_TAG_FROM).toBe(CURSOR_SIZE + 2);
    expect(placeCursor([916, 300], at1, size, 60).flip).toBe(false);
    expect(placeCursor([917, 300], at1, size, 60).flip).toBe(true);
    // A wider tag needs more room; one not measured yet goes where it always did.
    expect(placeCursor([800, 300], at1, size, 200).flip).toBe(true);
    expect(placeCursor([990, 300], at1, size).flip).toBe(false);
    // Kept inside the board at its right edge, it hangs left.
    expect(placeCursor([5000, 300], at1, size, 60)).toEqual({ x: size.w - CURSOR_SIZE, y: 300, off: true, flip: true });
  });

  it('off the board, it waits at the edge nearest its place, seen whole', () => {
    expect(placeCursor([-5000, 100], cam, size)).toEqual({ x: 0, y: 250, off: true, flip: false });
    expect(placeCursor([100, -5000], cam, size)).toEqual({ x: 300, y: 0, off: true, flip: false });
    expect(placeCursor([5000, 5000], cam, size)).toEqual({ x: size.w - CURSOR_SIZE, y: size.h - CURSOR_SIZE, off: true, flip: false });
    // On the board but too near the far edges to be seen whole: in by its own size, still on.
    expect(placeCursor([445, 370], cam, size)).toEqual({ x: size.w - CURSOR_SIZE, y: size.h - CURSOR_SIZE, off: false, flip: false });
  });

  it('beside an owner’s mark it waits just outside its right edge, in its lower half: never over its words', () => {
    const boxOf = (id: string) => (id === 'm1' || id === 'p1' ? ([10, 20, 300, 200] as const) : undefined);
    const isMark = (id: string) => id === 'm1';
    const [x, y] = cursorPoint(presence({ state: 'drawing', cursor: { item: 'm1' } }), boxOf, isMark)!;
    expect([x, y]).toEqual([10 + 300 + CURSOR_BESIDE, 20 + 200 * CURSOR_DOWN]);
    // Right of the mark, inside the 48 a picture answering it is placed away; below its middle.
    expect(x).toBeGreaterThan(10 + 300);
    expect(x + CURSOR_SIZE).toBeLessThanOrEqual(10 + 300 + 48);
    expect(y).toBeGreaterThan(20 + 100);
    expect(y).toBeLessThan(20 + 200);
  });

  it('on a picture it points near its corner, inside; at a point of the board, there; away, still where it was', () => {
    const boxOf = (id: string) => (id === 'a1' ? ([10, 20, 300, 200] as const) : undefined);
    expect(cursorPoint(presence({ state: 'drawing', cursor: { at: [5, 6] } }), boxOf)).toEqual([5, 6]);
    expect(cursorPoint(presence({ state: 'drawing', cursor: { item: 'a1' } }), boxOf)).toEqual([10 + 300 - 28, 20 + 200 - 18]);
    expect(cursorPoint(presence({ state: 'drawing', cursor: { item: 'a1' } }), boxOf, () => false)).toEqual([10 + 300 - 28, 20 + 200 - 18]);
    expect(cursorPoint(presence({ state: 'drawing', cursor: { item: 'gone' } }), boxOf)).toBeUndefined();
    expect(cursorPoint(presence({ state: 'drawing' }), boxOf)).toBeUndefined();
    expect(cursorPoint(presence({ state: 'away', cursor: { at: [5, 6] } }), boxOf)).toEqual([5, 6]);
  });

  it('works while the agent draws or something leads it, rests while it listens, waits or builds, and is away when away', () => {
    expect(cursorLook('drawing', false)).toBe('working');
    for (const s of ['listening', 'waiting', 'building'] as const) {
      expect(cursorLook(s, false), s).toBe('rest');
      expect(cursorLook(s, true), s).toBe('working');
    }
    expect(cursorLook('away', false)).toBe('away');
  });

  it('its tag says a short note, and not a long one or a chapter’s title', () => {
    expect(tagWords(presence({ state: 'drawing', note: 'reading your marks' }), [])).toBe('reading your marks');
    expect(tagWords(presence({ state: 'drawing', note: 'x'.repeat(PILL_NOTE_MAX) }), [])).toBe('x'.repeat(PILL_NOTE_MAX));
    expect(tagWords(presence({ state: 'drawing', note: 'x'.repeat(PILL_NOTE_MAX + 1) }), [])).toBeUndefined();
    expect(tagWords(presence({ state: 'drawing', note: 'The door' }), ['The door'])).toBeUndefined();
    expect(tagWords(presence({ state: 'drawing' }), [])).toBeUndefined();
  });

  it('comes in from the nearest edge of the board, level with its place, seen whole', () => {
    expect(entryPoint([100, 400], size)).toEqual([0, 400]);
    expect(entryPoint([950, 400], size)).toEqual([size.w - CURSOR_SIZE, 400]);
    expect(entryPoint([500, 30], size)).toEqual([500, 0]);
    expect(entryPoint([500, 790], size)).toEqual([500, size.h - CURSOR_SIZE]);
    // A place near a far corner comes in from that edge and is still seen whole.
    expect(entryPoint([995, 300], size)).toEqual([size.w - CURSOR_SIZE, 300]);
    // A place off the board has no edge to come in from.
    expect(entryPoint([-1, 400], size)).toBeUndefined();
    expect(entryPoint([500, 801], size)).toBeUndefined();
  });

  it('says a note too long for the pill beside it; away it says nothing, the pill says why', () => {
    const long = 'x'.repeat(PILL_NOTE_MAX + 1);
    expect(cursorSays(presence({ state: 'drawing', note: long }), [])).toBe(long);
    expect(cursorSays(presence({ state: 'drawing', note: 'x'.repeat(PILL_NOTE_MAX) }), [])).toBeUndefined();
    expect(cursorSays(presence({ state: 'away', note: long }), [])).toBeUndefined();
  });

  it('a note that is only a chapter’s title is not said beside it, however long: the pill does not say it either', () => {
    const title = 'Tell me when the engine goes over what one request may cost';
    expect(title.length).toBeGreaterThan(PILL_NOTE_MAX);
    expect(cursorSays(presence({ state: 'drawing', note: title }), ['One engine, many requests', title])).toBeUndefined();
    expect(cursorSays(presence({ state: 'drawing', note: `“${title}”` }), [title])).toBeUndefined();
    // A note that only begins as a title does is the agent's own words.
    expect(cursorSays(presence({ state: 'drawing', note: `${title}, and why` }), [title])).toBe(`${title}, and why`);
    expect(cursorSays(presence({ state: 'drawing', note: title }), ['One engine, many requests'])).toBe(title);
  });
});

/** Frames stepped by hand, with a clock that moves 16 ms a frame. */
function handFrames() {
  let next = 1;
  let time = 0;
  const waiting = new Map<number, FrameRequestCallback>();
  const scheduler: FrameScheduler = {
    requestAnimationFrame: (cb) => {
      waiting.set(next, cb);
      return next++;
    },
    cancelAnimationFrame: (id) => {
      waiting.delete(id);
    },
  };
  return {
    loop: new FrameLoop(scheduler, () => time),
    /** How many frames are asked for now: none on a board at rest. */
    asked: () => waiting.size,
    step: () => {
      time += 16;
      const run = [...waiting.values()];
      waiting.clear();
      for (const cb of run) cb(time);
    },
  };
}

/** A cursor store on hand-stepped frames, on a 1000 × 800 board, with every place it was drawn at. */
function store({ reduced = false, zoom = 1 } = {}) {
  const f = handFrames();
  const camera = new CameraStore({ x: 0, y: 0, z: zoom }, { loop: f.loop, reduced: () => reduced });
  const cursor = new AgentCursorStore(f.loop, camera, { reduced: () => reduced });
  const drawn: Point[] = [];
  const told = { n: 0 };
  cursor.subscribe(() => (told.n += 1));
  cursor.attach({
    size: () => ({ w: 1000, h: 800 }),
    draw: () => {
      const p = cursor.at();
      if (p) drawn.push(p);
    },
  });
  /** Step frames until the cursor asks for none; how many it took. */
  const settle = () => {
    let n = 0;
    while (f.asked() > 0 && n < 1000) {
      f.step();
      n += 1;
    }
    return n;
  };
  /** Put the cursor at a place, with no trip. */
  const placeAt = (p: Point) => {
    cursor.goTo(p);
    settle();
    drawn.length = 0;
  };
  return { cursor, camera, f, drawn, told, settle, placeAt };
}

describe('the cursor’s store: where the cursor is, outside React', () => {
  it('is nowhere until presence names a place, and asks for no frame', () => {
    const { cursor, f, told } = store();
    cursor.goTo(undefined);
    expect(cursor.at()).toBeUndefined();
    expect(cursor.shown()).toEqual({ placed: false, led: false });
    expect(f.asked()).toBe(0);
    expect(told.n).toBe(0);
  });

  it('the first time, it comes in from the nearest edge of the view over 600 ms, and lands exactly on its place', () => {
    const { cursor, camera, f, drawn, told, settle } = store();
    cursor.goTo([120, 300]);
    // Not on the board before the next frame: the board's first view may still move the camera.
    expect(cursor.shown().placed).toBe(false);
    camera.set({ x: 0, y: 100, z: 1 });
    f.step();
    expect(cursor.shown()).toEqual({ placed: true, led: false });
    expect(told.n).toBe(1);
    // In from the left edge of the view as it is on that frame, level with the place.
    expect(drawn[0]).toEqual([0, 300]);
    const n = settle();
    expect(n).toBe(Math.ceil(CURSOR_ENTER_MS / 16));
    expect(cursor.at()).toEqual([120, 300]);
  });

  it('the first time, to a place out of view, it is simply there, waiting at the edge', () => {
    const { cursor, f } = store();
    cursor.goTo([-500, 300]);
    f.step();
    expect(cursor.at()).toEqual([-500, 300]);
    expect(f.asked()).toBe(0);
  });

  it('with reduced motion it is simply there the first time, and jumps after, with no frame', () => {
    const { cursor, f } = store({ reduced: true });
    cursor.goTo([120, 300]);
    expect(cursor.at()).toEqual([120, 300]);
    cursor.goTo([700, 500]);
    expect(cursor.at()).toEqual([700, 500]);
    expect(f.asked()).toBe(0);
  });

  it('travels to a new place on a curve, eased in and out, in the time its distance on the screen takes, and lands exactly', () => {
    const { cursor, drawn, settle, placeAt } = store();
    placeAt([100, 100]);
    cursor.goTo([700, 500]);
    const ms = travelMs(distance([100, 100], [700, 500]));
    const n = settle();
    expect(n).toBe(Math.ceil(ms / 16));
    expect(cursor.at()).toEqual([700, 500]);
    // Every frame is on the arc, at the eased share of the time.
    const path = arc([100, 100], [700, 500]);
    drawn.forEach((p, i) => {
      const [x, y] = along(path, EASE.move(((i + 1) * 16) / ms));
      expect(p[0]).toBeCloseTo(x, 9);
      expect(p[1]).toBeCloseTo(y, 9);
    });
    // Not a straight line.
    const k = drawn.length;
    expect(Math.abs(cross(drawn[Math.floor(k / 4)]!, drawn[Math.floor(k / 2)]!, drawn[Math.floor((3 * k) / 4)]!))).toBeGreaterThan(1000);
    // Slow away, slow in: the first and last frames go less far than the middle ones.
    const steps = drawn.slice(1).map((p, i) => distance(drawn[i]!, p));
    const mid = steps[Math.floor(steps.length / 2)]!;
    expect(steps[0]).toBeLessThan(mid / 2);
    expect(steps[steps.length - 1]).toBeLessThan(mid / 2);
  });

  it('a trip takes longer zoomed in, where it goes further on the screen, and never more than 750 ms', () => {
    const near = store({ zoom: 0.5 });
    near.placeAt([0, 0]);
    near.cursor.goTo([300, 0]);
    const far = store({ zoom: 2 });
    far.placeAt([0, 0]);
    far.cursor.goTo([300, 0]);
    expect(near.settle()).toBe(Math.ceil(travelMs(150) / 16));
    expect(far.settle()).toBe(Math.ceil(travelMs(600) / 16));
    const long = store({ zoom: 4 });
    long.placeAt([0, 0]);
    long.cursor.goTo([5000, 0]);
    expect(long.settle()).toBe(Math.ceil(CURSOR_TRAVEL_MAX_MS / 16));
  });

  it('a new place before the last is reached: it sets off from where it is, with no jump', () => {
    const { cursor, f, drawn, settle, placeAt } = store();
    placeAt([100, 100]);
    cursor.goTo([700, 500]);
    for (let i = 0; i < 12; i++) f.step();
    const midway = cursor.at()!;
    drawn.length = 0;
    cursor.goTo([100, 600]);
    f.step();
    // The first frame of the new trip is a short step from where it was, not either end.
    expect(distance(midway, drawn[0]!)).toBeLessThan(20);
    settle();
    expect(cursor.at()).toEqual([100, 600]);
    const steps = drawn.slice(1).map((p, i) => distance(drawn[i]!, p));
    expect(Math.max(...steps)).toBeLessThan(40);
  });

  it('stays where it is when presence names no place, and starts no trip for the place it is at or is going to', () => {
    const { cursor, f, settle, placeAt } = store();
    placeAt([100, 100]);
    cursor.goTo(undefined);
    expect(cursor.at()).toEqual([100, 100]);
    expect(cursor.shown().placed).toBe(true);
    cursor.goTo([100, 100]);
    expect(f.asked()).toBe(0);
    cursor.goTo([500, 100]);
    f.step();
    const was = cursor.at();
    cursor.goTo([500, 100]);
    f.step();
    // Still the same trip: one more frame of it, not a new start.
    expect(cursor.at()![0]).toBeGreaterThan(was![0]);
    settle();
    expect(f.asked()).toBe(0);
  });

  it('led, it is drawn where the lead says on every frame, and the trip under way stops', () => {
    const { cursor, f, drawn, told, placeAt } = store();
    placeAt([100, 100]);
    cursor.goTo([700, 500]);
    f.step();
    let x = 200;
    told.n = 0;
    cursor.lead(() => [x, 50]);
    expect(cursor.shown()).toEqual({ placed: true, led: true });
    expect(told.n).toBe(1);
    expect(cursor.travelling()).toBe(false);
    expect(cursor.at()).toEqual([200, 50]);
    for (let i = 0; i < 5; i++) {
      x += 10;
      f.step();
      expect(drawn[drawn.length - 1]).toEqual([x, 50]);
    }
    // A place presence names while led waits for the lead to let go.
    cursor.goTo([900, 900]);
    f.step();
    expect(cursor.at()).toEqual([x, 50]);
    expect(f.asked()).toBe(1);
  });

  it('let go, it stays where it was left: it does not walk back to the place presence named before the lead', () => {
    // Presence names the place the lead left it at: no trip, no frame.
    const a = store();
    a.placeAt([100, 100]);
    a.cursor.goTo([300, 300]);
    a.cursor.lead(() => [300, 300]);
    a.f.step();
    a.cursor.lead(null);
    expect(a.cursor.shown()).toEqual({ placed: true, led: false });
    expect(a.cursor.at()).toEqual([300, 300]);
    expect(a.f.asked()).toBe(0);

    // Presence names no place: it stays.
    const b = store();
    b.placeAt([100, 100]);
    b.cursor.goTo(undefined);
    b.cursor.lead(() => [400, 400]);
    b.f.step();
    b.cursor.lead(null);
    expect(b.cursor.at()).toEqual([400, 400]);
    expect(b.f.asked()).toBe(0);

    // Presence still names the place the lead began at (the mark an arrival drew from): it stays.
    const c = store();
    c.placeAt([100, 100]);
    c.cursor.lead(() => [400, 400]);
    c.f.step();
    c.cursor.goTo([100, 100]);
    c.cursor.lead(null);
    expect(c.cursor.travelling()).toBe(false);
    expect(c.cursor.at()).toEqual([400, 400]);
    expect(c.f.asked()).toBe(0);
  });

  it('let go, it travels on from where it was left to a place presence named while it was led, or names later', () => {
    // Named while led.
    const d = store();
    d.placeAt([100, 100]);
    d.cursor.lead(() => [400, 400]);
    d.f.step();
    d.cursor.goTo([700, 200]);
    d.cursor.lead(null);
    expect(d.cursor.travelling()).toBe(true);
    d.drawn.length = 0;
    d.f.step();
    expect(distance([400, 400], d.drawn[0]!)).toBeLessThan(20);
    d.settle();
    expect(d.cursor.at()).toEqual([700, 200]);

    // Named later.
    const e = store();
    e.placeAt([100, 100]);
    e.cursor.lead(() => [400, 400]);
    e.f.step();
    e.cursor.lead(null);
    expect(e.f.asked()).toBe(0);
    e.cursor.goTo([700, 200]);
    e.settle();
    expect(e.cursor.at()).toEqual([700, 200]);

    // A second lead forgets what was named during the first.
    const f = store();
    f.placeAt([100, 100]);
    f.cursor.lead(() => [400, 400]);
    f.cursor.goTo([700, 200]);
    f.cursor.lead(null);
    f.settle();
    f.cursor.lead(() => [500, 500]);
    f.f.step();
    f.cursor.lead(null);
    expect(f.cursor.at()).toEqual([500, 500]);
    expect(f.f.asked()).toBe(0);
  });

  it('says where a cursor not on the board would come in from, on its way to a place: through the camera now, or one it is handed', () => {
    const { cursor, camera } = store();
    expect(cursor.entryFor([120, 300])).toEqual([0, 300]);
    camera.set({ x: 0, y: 100, z: 1 });
    expect(cursor.entryFor([120, 300])).toEqual([0, 300]);
    // Out of the view now: none; through the view it is handed, from that view's edge.
    expect(cursor.entryFor([-500, 300])).toBeUndefined();
    expect(cursor.entryFor([-500, 300], { x: 600, y: 0, z: 1 })).toEqual([-600, 300]);
    expect(cursor.at()).toBeUndefined();
  });

  it('a lead puts a cursor that was nowhere on the board, where the lead says', () => {
    const { cursor } = store();
    cursor.lead(() => [5, 6]);
    expect(cursor.shown()).toEqual({ placed: true, led: true });
    expect(cursor.at()).toEqual([5, 6]);
  });

  it('a board at rest asks for no frame: none after a trip lands, none after a lead lets go', () => {
    const { cursor, f, settle, placeAt } = store();
    placeAt([0, 0]);
    expect(f.asked()).toBe(0);
    cursor.goTo([400, 0]);
    expect(f.asked()).toBe(1);
    settle();
    expect(f.asked()).toBe(0);
    cursor.lead(() => [1, 1]);
    expect(f.asked()).toBe(1);
    cursor.lead(null);
    // It stays where the lead left it: presence named [400, 0] before the lead, not during it.
    expect(cursor.at()).toEqual([1, 1]);
    settle();
    expect(f.asked()).toBe(0);
  });
});

describe('the agent’s cursor on the board', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    resetInput();
    vi.useRealTimers();
  });

  function open(p: Omit<Presence, 'since'> = { state: 'drawing', cursor: { at: [400, 300] } }, chapter?: string) {
    const b = openBoard();
    if (chapter) b.must('owner', { type: 'chapter.open', chapter: 'second', title: chapter });
    b.must('owner', note('m1', [0, 0, 320, 100]));
    b.must('owner', note('m2', [900, 700, 320, 100]));
    const src = localSource({ events: b.events, presence: p });
    const commits = { n: 0 };
    const view = render(
      <Profiler id="board" onRender={() => (commits.n += 1)}>
        <App source={src} />
      </Profiler>,
    );
    return { src, commits, board: screen.getByTestId('board'), ...view };
  }

  const cursor = () => screen.getByTestId('agent-cursor');
  const at = () => {
    const m = /^translate\(([-\d.e]+)px, ([-\d.e]+)px\)$/.exec(cursor().style.transform);
    if (!m) throw new Error(`not a place: "${cursor().style.transform}"`);
    return [Number(m[1]), Number(m[2])];
  };
  const camera = (container: HTMLElement) => {
    const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(container.querySelector<HTMLElement>('.world')!.style.transform)!;
    return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
  };
  /** Frames enough for any trip of the cursor to land. */
  const landed = () => frames(Math.ceil(CURSOR_TRAVEL_MAX_MS / 16) + 2);

  it('a note too long for the pill is drawn beside the cursor, where no screen reader looks: the pill says it to one, and shows it whole in its tip', async () => {
    const long = 'reading the three notes you pinned on the engine, then drawing how they fit';
    expect(long.length).toBeGreaterThan(PILL_NOTE_MAX);
    open({ state: 'drawing', note: long, cursor: { at: [400, 300] } });
    await frames(2);
    const pill = screen.getByTestId('presence');
    expect(cursor().textContent).toContain(long);
    expect(cursor().closest('[aria-hidden="true"]')).not.toBeNull();
    // What is seen in the pill is the state alone; what is read from it is the note as well.
    expect(pill.querySelector('.pill__said')!.textContent).toBe('The agent: drawing');
    expect(pill.querySelector('.for-reader')!.textContent).toBe(long);
    expect(pill.closest('[aria-hidden="true"]')).toBeNull();
    expect(pill.getAttribute('role')).toBe('status');
    expect(pill.dataset.tip).toBe(`The agent: ${long}`);
  });

  it('a long note that is only a chapter’s title is said nowhere: the pill and its tip say the state, and the cursor has no words', async () => {
    const title = 'Tell me when the engine goes over what one request may cost';
    open({ state: 'drawing', note: title, cursor: { at: [400, 300] } }, title);
    await frames(2);
    const pill = screen.getByTestId('presence');
    expect(cursor().textContent).not.toContain(title);
    expect(pill.querySelector('.pill__said')!.textContent).toBe('The agent: drawing');
    expect(pill.querySelector('.for-reader')).toBeNull();
    expect(pill.dataset.tip).toBe('The agent: drawing');
  });

  it('with no cursor on the board the pill says the long note itself, once; and a short note is never said twice', async () => {
    const long = 'reading the three notes you pinned on the engine, then drawing how they fit';
    const { unmount } = open({ state: 'drawing', note: long });
    await frames(2);
    expect(screen.queryByTestId('agent-cursor')).toBeNull();
    expect(screen.getByTestId('presence').querySelector('.pill__said')!.textContent).toBe(`The agent: ${long}`);
    expect(screen.getByTestId('presence').querySelector('.for-reader')).toBeNull();
    unmount();
    open({ state: 'drawing', note: 'two pictures', cursor: { at: [400, 300] } });
    await frames(2);
    expect(screen.getByTestId('presence').querySelector('.pill__said')!.textContent).toBe('The agent: two pictures');
    expect(screen.getByTestId('presence').querySelector('.for-reader')).toBeNull();
  });

  it('is drawn in the overlay, in screen space: its place is the camera’s, with no scale of its own', async () => {
    const { container, board } = open();
    await frames(2);
    expect(cursor().closest('.overlay')).not.toBeNull();
    expect(cursor().closest('.world')).toBeNull();
    const c = camera(container);
    expect(at()).toEqual([400 * c.z + c.x, 300 * c.z + c.y]);
    wheel(board, { dy: -40, ctrl: true, at: [300, 200] });
    await frame();
    const z = camera(container);
    expect(z.z).not.toBe(c.z);
    expect(at()).toEqual([400 * z.z + z.x, 300 * z.z + z.y]);
    expect(cursor().style.transform).not.toContain('scale');
  });

  it('a pan moves it frame after frame, and no React commit happens', async () => {
    const { board, commits } = open();
    await frames(2);
    commits.n = 0;
    const seen = new Set<string>();
    for (let i = 0; i < 10; i++) {
      wheel(board, { dx: 15, dy: 9 });
      await frame();
      seen.add(cursor().style.transform);
    }
    expect(seen.size).toBe(10);
    expect(commits.n).toBe(0);
  });

  it('a zoom moves it frame after frame, and commits no more than the same zoom with no cursor on the board', async () => {
    /** The commits ten frames of zoom make, and the places the cursor took. */
    const zoom = async (p: Omit<Presence, 'since'>) => {
      const { board, commits } = open(p);
      await frames(2);
      commits.n = 0;
      const seen = new Set<string>();
      for (let i = 0; i < 10; i++) {
        wheel(board, { dy: -6, ctrl: true, at: [300, 200] });
        await frame();
        seen.add(screen.queryByTestId('agent-cursor')?.style.transform ?? '');
      }
      cleanup();
      return { commits: commits.n, places: seen.size };
    };
    const without = await zoom({ state: 'drawing' });
    const withCursor = await zoom({ state: 'drawing', cursor: { at: [400, 300] } });
    expect(withCursor.places).toBe(10);
    expect(withCursor.commits).toBe(without.commits);
  });

  it('keeps inside the board by the size it is drawn at', () => {
    open();
    expect(cursor().querySelector('svg')?.getAttribute('width')).toBe(String(CURSOR_SIZE));
    expect(cursor().querySelector('svg')?.getAttribute('height')).toBe(String(CURSOR_SIZE));
  });

  it('says a note too long for the pill beside it, and a short one not', () => {
    const long = 'reading the three marks you made on the queue, then drawing the two ways it could go';
    const { src } = open({ state: 'drawing', note: long, cursor: { at: [400, 300] } });
    expect(cursor().querySelector('.agent-cursor__said')?.textContent).toBe(long);
    act(() => src.setPresence({ state: 'drawing', note: 'drawing', cursor: { at: [400, 300] } }));
    expect(cursor().querySelector('.agent-cursor__said')).toBeNull();
  });

  it('led, its tag is its name and the dots only, and it says no note beside it: the pill says it, and words would hang over what it draws', () => {
    const long = 'reading the three marks you made on the queue, then drawing the two ways it could go';
    const src = localSource({ presence: { state: 'drawing', note: 'drawing a card', cursor: { at: [400, 300] } } });
    const f = handFrames();
    const cam = new CameraStore({ x: 0, y: 0, z: 1 }, { loop: f.loop });
    const store = new AgentCursorStore(f.loop, cam);
    render(<AgentCursor source={src} cursor={store} state={src.state} boxOf={() => undefined} titles={[]} camera={cam} rect={() => ({ left: 0, top: 0, width: 1000, height: 800 })} />);
    act(() => store.lead(() => [420, 310]));
    const tag = () => cursor().querySelector('.agent-cursor__tag')!;
    expect(tag().textContent).toBe('agent');
    expect(tag().querySelectorAll('.presence-sign i')).toHaveLength(3);
    act(() => src.setPresence({ state: 'drawing', note: long, cursor: { at: [400, 300] } }));
    expect(cursor().querySelector('.agent-cursor__said')).toBeNull();
    // Let go, it says what the agent does again.
    act(() => store.lead(null));
    expect(cursor().querySelector('.agent-cursor__said')?.textContent).toBe(long);
    act(() => src.setPresence({ state: 'drawing', note: 'drawing a card', cursor: { at: [400, 300] } }));
    expect(tag().querySelector('.agent-cursor__words')?.textContent).toBe('drawing a card');
  });

  it('led, its long note is said by the pill; let go, by the bubble beside it again, and the pill says the state', () => {
    const long = 'reading the three marks you made on the queue, then drawing the two ways it could go';
    expect(long.length).toBeGreaterThan(PILL_NOTE_MAX);
    const src = localSource({ presence: { state: 'drawing', note: long, cursor: { at: [400, 300] } } });
    const f = handFrames();
    const cam = new CameraStore({ x: 0, y: 0, z: 1 }, { loop: f.loop });
    const store = new AgentCursorStore(f.loop, cam);
    render(
      <>
        <AgentCursor source={src} cursor={store} state={src.state} boxOf={() => undefined} titles={[]} camera={cam} rect={() => ({ left: 0, top: 0, width: 1000, height: 800 })} />
        <AgentPill source={src} cursor={store} boxOf={() => undefined} titles={[]} />
      </>,
    );
    const pill = () => screen.getByTestId('presence').querySelector('.pill__said')!.textContent;
    const bubble = () => cursor().querySelector('.agent-cursor__said')?.textContent;
    act(() => store.lead(() => [420, 310]));
    expect(bubble()).toBeUndefined();
    expect(pill()).toBe(`The agent: ${long}`);
    act(() => store.lead(null));
    expect(bubble()).toBe(long);
    expect(pill()).toBe('The agent: drawing');
  });

  it('near the board’s right edge its tag hangs left of the point, and right again once a pan takes it away, with no React commit', () => {
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('agent-cursor__tag') ? 80 : 0;
    });
    try {
      const src = localSource({ presence: { state: 'drawing', cursor: { at: [950, 300] } } });
      const f = handFrames();
      const cam = new CameraStore({ x: 0, y: 0, z: 1 }, { loop: f.loop });
      const store = new AgentCursorStore(f.loop, cam, { reduced: () => true });
      const commits = { n: 0 };
      render(
        <Profiler id="cursor" onRender={() => (commits.n += 1)}>
          <AgentCursor source={src} cursor={store} state={src.state} boxOf={() => undefined} titles={[]} camera={cam} rect={() => ({ left: 0, top: 0, width: 1000, height: 800 })} />
        </Profiler>,
      );
      // 950 + 24 + 80 is past the board's 1000 px.
      expect(cursor().hasAttribute('data-flip')).toBe(true);
      commits.n = 0;
      act(() => cam.set({ x: -200, y: 0, z: 1 }));
      expect(cursor().hasAttribute('data-flip')).toBe(false);
      act(() => cam.set({ x: 0, y: 0, z: 1 }));
      expect(cursor().hasAttribute('data-flip')).toBe(true);
      expect(commits.n).toBe(0);
    } finally {
      width.mockRestore();
    }
  });

  it('a tag first drawn off the board, where it is put away and has no width, is measured when it comes on, and hangs where it fits', () => {
    // Put away (the cursor is off the board), the tag is not laid out.
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('agent-cursor__tag') && !this.closest('[data-off]') ? 80 : 0;
    });
    try {
      const src = localSource({ presence: { state: 'drawing', cursor: { at: [1150, 300] } } });
      const f = handFrames();
      const cam = new CameraStore({ x: 0, y: 0, z: 1 }, { loop: f.loop });
      const store = new AgentCursorStore(f.loop, cam, { reduced: () => true });
      render(<AgentCursor source={src} cursor={store} state={src.state} boxOf={() => undefined} titles={[]} camera={cam} rect={() => ({ left: 0, top: 0, width: 1000, height: 800 })} />);
      expect(cursor().hasAttribute('data-off')).toBe(true);
      // Panned so its point is at 950: on the board, with no room for 80 px of tag on its right.
      act(() => cam.set({ x: -200, y: 0, z: 1 }));
      expect(cursor().hasAttribute('data-off')).toBe(false);
      expect(cursor().hasAttribute('data-flip')).toBe(true);
    } finally {
      width.mockRestore();
    }
  });

  it('working, its tag says its name, the short note and the pill’s three dots', () => {
    open({ state: 'drawing', note: 'reading your marks', cursor: { item: 'm1' } });
    const tag = cursor().querySelector('.agent-cursor__tag')!;
    expect(tag.querySelector('.agent-cursor__name')!.textContent).toBe('agent');
    expect(tag.querySelector('.agent-cursor__words')!.textContent).toBe('reading your marks');
    expect(tag.querySelectorAll('.presence-sign i')).toHaveLength(3);
    expect(cursor().hasAttribute('data-rest')).toBe(false);
    expect(cursor().hasAttribute('data-away')).toBe(false);
  });

  it('at rest it says only its name, and dims (the style sheet holds it bright a moment first)', () => {
    const { src } = open({ state: 'drawing', note: 'reading your marks', cursor: { item: 'm1' } });
    for (const state of ['listening', 'waiting', 'building'] as const) {
      act(() => src.setPresence({ state, note: 'for your go', cursor: { item: 'm1' } }));
      expect(cursor().hasAttribute('data-rest'), state).toBe(true);
      expect(cursor().querySelector('.agent-cursor__tag')!.textContent, state).toBe('agent');
    }
    expect(cursor().style.getPropertyValue('--cursor-hold')).toBe('1200ms');
  });

  it('waits beside the owner’s note it reads, outside its right edge, not over its words', async () => {
    const { container } = open({ state: 'drawing', note: 'reading your marks', cursor: { item: 'm1' } });
    await frames(2);
    expect(cursor().dataset.at).toBe(`${320 + CURSOR_BESIDE},${100 * CURSOR_DOWN}`);
    const c = camera(container);
    expect(at()).toEqual([(320 + CURSOR_BESIDE) * c.z + c.x, 100 * CURSOR_DOWN * c.z + c.y]);
  });

  it('is faint, and not hidden, while the agent is away', () => {
    const { src } = open();
    expect(cursor().hasAttribute('data-away')).toBe(false);
    act(() => src.setPresence({ state: 'away', cursor: { at: [400, 300] } }));
    expect(cursor().hasAttribute('data-away')).toBe(true);
    expect(cursor().hasAttribute('data-rest')).toBe(false);
  });

  it('with no agent ever linked there is no cursor', () => {
    open({ state: 'away', note: 'no agent is linked' });
    expect(screen.queryByTestId('agent-cursor')).toBeNull();
  });

  it('off the board it waits at the edge, and says it is off; back in view, it is on again', async () => {
    const { board } = open();
    await frames(2);
    expect(cursor().hasAttribute('data-off')).toBe(false);
    wheel(board, { dx: -40000 });
    await frame();
    expect(cursor().hasAttribute('data-off')).toBe(true);
    expect(at()[0]).toBe(window.innerWidth - CURSOR_SIZE);
    wheel(board, { dx: 40000 });
    await frame();
    expect(cursor().hasAttribute('data-off')).toBe(false);
  });

  it('travels to a new place over the frames of the board’s loop, eased in and out, on a curve, and lands on it with no React commit', async () => {
    reduceMotion(false);
    const { src, container, commits } = open();
    await landed();
    const c = camera(container);
    const from = at();
    act(() => src.setPresence({ state: 'drawing', cursor: { at: [700, 300] } }));
    commits.n = 0;
    const to = [700 * c.z + c.x, 300 * c.z + c.y];
    const seen: number[][] = [];
    for (let i = 0; i < Math.ceil(travelMs(300 * c.z) / 16); i++) {
      await frame();
      seen.push(at());
    }
    expect(at()).toEqual(to);
    expect(commits.n).toBe(0);
    // Eased in: an even pace would have gone 16 / ms of the way in the first frame.
    const share = (seen[0]![0]! - from[0]!) / (to[0]! - from[0]!);
    expect(share).toBeGreaterThan(0);
    expect(share).toBeLessThan(16 / travelMs(300 * c.z));
    // On a curve: off the straight line between the two places on the way.
    const middle = seen[Math.floor(seen.length / 2)]!;
    expect(Math.abs(middle[1]! - from[1]!)).toBeGreaterThan(5);
  });

  it('the first time, with motion, it comes in from the nearest edge of the view', async () => {
    reduceMotion(false);
    open({ state: 'drawing', cursor: { at: [400, 300] } });
    expect(screen.queryByTestId('agent-cursor')).toBeNull();
    await frame();
    const first = at();
    const edges = [first[0], first[1], window.innerWidth - CURSOR_SIZE - first[0]!, window.innerHeight - CURSOR_SIZE - first[1]!];
    expect(Math.min(...edges.map((d) => Math.abs(d!)))).toBe(0);
    await landed();
    expect(cursor().dataset.at).toBe('400,300');
    expect(at()).not.toEqual(first);
  });

  it('is kept inside the board when the window changes size', async () => {
    const { board } = open();
    await frames(2);
    wheel(board, { dx: -40000 });
    await frame();
    expect(at()[0]).toBe(window.innerWidth - CURSOR_SIZE);
    const was = { width: window.innerWidth, height: window.innerHeight };
    try {
      act(() => {
        (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport({ width: was.width - 200, height: was.height });
        window.dispatchEvent(new Event('resize'));
      });
      expect(at()[0]).toBe(was.width - 200 - CURSOR_SIZE);
    } finally {
      (window as unknown as { happyDOM: { setViewport(v: { width: number; height: number }): void } }).happyDOM.setViewport(was);
    }
  });

  it('with reduced motion it jumps to a new place', () => {
    const { src, container } = open();
    const c = camera(container);
    act(() => src.setPresence({ state: 'drawing', cursor: { at: [700, 500] } }));
    expect(at()).toEqual([700 * c.z + c.x, 500 * c.z + c.y]);
  });

  it('a new place before the last is reached: the next trip starts from where it is', async () => {
    reduceMotion(false);
    const { src, container } = open();
    await landed();
    const c = camera(container);
    act(() => src.setPresence({ state: 'drawing', cursor: { at: [700, 500] } }));
    await frames(12);
    const midway = at();
    act(() => src.setPresence({ state: 'drawing', cursor: { at: [100, 100] } }));
    expect(at()).toEqual(midway);
    await frame();
    // On its way back, from where it was: not from either end.
    expect(at()[0]).toBeLessThan(midway[0]!);
    expect(at()[0]).toBeGreaterThan(100 * c.z + c.x);
    await landed();
    expect(at()).toEqual([100 * c.z + c.x, 100 * c.z + c.y]);
  });

  it('stays where it was when presence names no place, and goes on from there with one', () => {
    const { src } = open();
    const was = at();
    act(() => src.setPresence({ state: 'listening' }));
    expect(cursor().dataset.at).toBeUndefined();
    expect(at()).toEqual(was);
    expect(cursor().hasAttribute('data-rest')).toBe(true);
    act(() => src.setPresence({ state: 'listening', cursor: { at: [10, 10] } }));
    expect(cursor().dataset.at).toBe('10,10');
  });
});
