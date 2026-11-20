import type { Box } from '@keel/protocol';
import { InkItem } from '@keel/protocol';
import { act, cleanup, render } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Camera } from '../src/camera/camera';
import type { FrameScheduler } from '../src/frame';
import type { TargetRect } from '../src/geometry';
import { pairs, readInk } from '../src/geometry';
import { InkMark } from '../src/ink/ink';
import { CLICK_SLOP, GO_MAX_STROKES, LOOP_CLOSE, PEN_PAUSE, STROKE_JOIN_POINTS, STROKE_MAX_POINTS } from '../src/input/constants';
import type { PointerInput } from '../src/input/pointers';
import { createPointers } from '../src/input/pointers';
import { Live } from '../src/live';
import { penWidth } from '../src/marks';
import { createTools, toolFor } from '../src/tools';
import { fakeBoard } from './fakeBoard';
import hands from './fixtures/hands.json';

/**
 * The Pen, from the pointer to the mark: the real dispatcher and the real pen on a fake board,
 * with the live layer drawn in a test DOM and frames stepped by hand. A press is made of page
 * pixels, and the camera turns them into board units, so every test can be run at any zoom.
 */

/** Every time a stroke's path is worked out, by how many numbers the stroke had: the costly part of drawing ink, counted. */
const worked = vi.hoisted(() => [] as number[]);

vi.mock('../src/ink/stroke', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/ink/stroke')>();
  const inkPath: typeof real.inkPath = (pts, ...rest) => {
    worked.push(pts.length);
    return real.inkPath(pts, ...rest);
  };
  return { ...real, inkPath };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  worked.length = 0;
});

type Px = readonly [x: number, y: number];

/** Frames stepped by hand. */
function byHand() {
  let next = 1;
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
  const step = () => {
    const run = [...waiting.values()];
    waiting.clear();
    for (const cb of run) cb(0);
  };
  return { scheduler, step };
}

/** A pointer event as the dispatcher reads it, at a page point. `coalesced` are the samples the browser collected for a move. */
function event([x, y]: Px, coalesced: readonly Px[] = []): PointerInput {
  return {
    pointerId: 7,
    pointerType: 'mouse',
    button: 0,
    clientX: x,
    clientY: y,
    pressure: 0.5,
    timeStamp: 1,
    target: null,
    currentTarget: null,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    preventDefault: () => {},
    getCoalescedEvents: () => coalesced.map(([cx, cy]) => ({ clientX: cx, clientY: cy, pressure: 0.5, timeStamp: 1 })),
  };
}

/** What one drawing of ink says: where it sits on the board, and its path. */
interface Drawn {
  place: string;
  viewBox: string | null;
  d: string | null;
}

const drawnIn = (svg: Element, path = svg.querySelector('path')): Drawn => ({ place: svg.getAttribute('style') ?? '', viewBox: svg.getAttribute('viewBox'), d: path?.getAttribute('d') ?? null });

/** The Pen in hand on a fake board, with the camera where the test puts it and the live layer on the page. */
function withPen(cam: Camera = { x: 0, y: 0, z: 1 }) {
  vi.useFakeTimers();
  const frames = byHand();
  const fake = fakeBoard({ tool: 'pen' });
  fake.camera.set(cam);
  const tools = createTools();
  const pointers = createPointers(fake.board, (press) => toolFor(tools, press, fake.board), frames.scheduler);
  const commits = { n: 0 };
  const layer = render(
    <Profiler id="live" onRender={() => (commits.n += 1)}>
      <Live store={fake.hand} />
    </Profiler>,
  );
  const doing = (what: () => void) => act(what);
  return {
    ...fake,
    pen: tools.pen,
    /** How many times React has drawn the live layer, or a part of it. */
    commits,
    down: (at: Px) => doing(() => pointers.down(event(at))),
    /** The pointer moves, and a frame passes: the pen has every sample, and the live layer has drawn. */
    move: (to: Px, coalesced: readonly Px[] = []) =>
      doing(() => {
        pointers.move(event(to, coalesced));
        frames.step();
      }),
    /** The pointer moves and no frame passes: the samples wait. */
    moveOnly: (to: Px) => doing(() => pointers.move(event(to))),
    frame: () => doing(() => frames.step()),
    up: (at: Px) => doing(() => pointers.up(event(at))),
    cancel: () => doing(() => pointers.cancel(event([0, 0]))),
    /** Draw one whole stroke through page points, a frame after each, and lift at the last. */
    stroke(points: readonly Px[]) {
      const [first, ...rest] = points;
      if (!first) throw new Error('a stroke has a first point');
      this.down(first);
      for (const p of rest) this.move(p);
      this.up(points.at(-1) ?? first);
    },
    /** Draw one whole stroke through page points with every sample in one frame, as a long press reaches the pen, and lift at the last. */
    press(points: readonly Px[]) {
      const [first, ...rest] = points;
      if (!first) throw new Error('a press has a first point');
      this.down(first);
      this.move(rest.at(-1) ?? first, rest);
      this.up(rest.at(-1) ?? first);
    },
    /** Every stroke the live layer shows now. */
    live: (): Drawn[] => [...layer.container.querySelectorAll('svg.ink')].map((svg) => drawnIn(svg)),
    /** The elements of the live strokes, to see that one is left alone. */
    liveNodes: () => [...layer.container.querySelectorAll('svg.ink')],
    /** Let the pen rest, so the go becomes marks. They come back as the board was handed them. */
    async rest(): Promise<InkItem[]> {
      await act(() => vi.advanceTimersByTimeAsync(PEN_PAUSE));
      return fake.did.marks.filter((m): m is InkItem => m.kind === 'ink');
    },
  };
}

/** A saved mark as the board draws it: one drawing for each of its strokes. */
function saved(item: InkItem): Drawn[] {
  const { container } = render(<InkMark strokes={item.strokes} box={item.box} shown={item.box} />);
  const svg = container.querySelector('svg');
  if (!svg) throw new Error('a mark is drawn in an svg');
  return [...svg.querySelectorAll('path')].map((path) => drawnIn(svg, path));
}

/** Every point of a drawing's outline, in board units: the numbers of its path, moved to where its SVG puts them. */
function outline(drawn: Drawn): Array<[number, number]> {
  const [vx = 0, vy = 0] = (drawn.viewBox ?? '').split(' ').map(Number);
  const left = Number(/left: ?(-?[\d.]+)px/.exec(drawn.place)?.[1]);
  const top = Number(/top: ?(-?[\d.]+)px/.exec(drawn.place)?.[1]);
  const numbers = (drawn.d?.match(/-?\d+\.\d+/g) ?? []).map(Number);
  return pairs(numbers).map(([x, y]) => [x + left - vx, y + top - vy]);
}

/** A number from a seed, the same on every run, between -0.5 and 0.5: the wobble of a hand. */
function wobble(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296 - 0.5;
  };
}

/**
 * A stroke as a hand draws it, in page pixels: slow where it starts and ends, fast in between,
 * never quite where it was aimed. Half pixels, as a display with two device pixels a pixel reports.
 */
function handStroke(seed: number, n = 90): Px[] {
  const w = wobble(seed);
  return Array.from({ length: n }, (_, i) => {
    // Ease in and out: the samples crowd at both ends.
    const t = (1 - Math.cos((i / (n - 1)) * Math.PI)) / 2;
    const x = 180 + 420 * t + 14 * Math.sin(t * 9) + 1.5 * w();
    const y = 240 + 120 * Math.sin(t * 5.2) + 60 * t + 1.5 * w();
    return [Math.round(x * 2) / 2, Math.round(y * 2) / 2] as const;
  });
}

const line = (a: Px, b: Px, n = 12): Px[] => Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n] as const);

/** The three zooms every rule of the pen is held at: far out, as drawn, and far in. The camera is off the whole pixel on purpose. */
const ZOOMS: Array<[name: string, cam: Camera]> = [
  ['25%', { x: 133.5, y: -48.25, z: 0.25 }],
  ['100%', { x: -212.5, y: 87, z: 1 }],
  ['400%', { x: -1301.75, y: -640.5, z: 4 }],
];

/** A page point in board units, by a camera. */
const world = ([x, y]: Px, cam: Camera): [number, number] => [(x - cam.x) / cam.z, (y - cam.y) / cam.z];

/* ------------------------------------------------------------------ live and saved are one drawing */

describe('the line under the pointer is the line that stays', () => {
  it.each(ZOOMS)('at %s the live stroke and the saved mark are one drawing: the same path, in the same place', async (_name, cam) => {
    for (const seed of [1, 2, 3]) {
      const board = withPen(cam);
      const points = handStroke(seed);
      board.down(points[0]!);
      for (const p of points.slice(1)) board.move(p);
      // The pen is still down: this is the line under the pointer.
      const [under] = board.live();
      board.up(points.at(-1)!);
      // The pen is up, and the go waits for its pause.
      const [lifted] = board.live();
      const [mark] = await board.rest();
      const [kept] = saved(mark!);
      expect(under!.d).toBeTruthy();
      expect(under!.d, `seed ${seed}, pen down`).toBe(kept!.d);
      expect(lifted, `seed ${seed}, pen up`).toEqual(kept);
      expect(under, `seed ${seed}, pen down`).toEqual(kept);
      expect(board.live()).toEqual([]);
      cleanup();
    }
  });

  it('the pen’s width on screen is the same at any zoom, and the saved stroke keeps it', async () => {
    for (const [name, cam] of ZOOMS) {
      const board = withPen(cam);
      board.stroke(handStroke(4, 30));
      const [mark] = await board.rest();
      expect(mark!.strokes[0]!.w, name).toBe(penWidth(4.5, cam.z));
      expect(mark!.strokes[0]!.w! * cam.z, name).toBeCloseTo(4.5, 0);
      cleanup();
    }
  });

  /** One recorded go: the hand of `e2e/ink-hands.ts`, as the real Chrome delivered it. */
  interface Go {
    name: string;
    kind: string;
    camera: Camera;
    strokes: Array<{ events: number[]; at: number[] }>;
  }

  /** Play a recorded stroke as it came: each pointer event with the samples it carried, a frame after each. */
  function play(board: ReturnType<typeof withPen>, stroke: Go['strokes'][number]): { under: Drawn[] } {
    const [first, ...rest] = pairs(stroke.at);
    board.down(first!);
    let i = 0;
    for (const n of stroke.events) {
      const group = rest.slice(i, i + n);
      i += n;
      board.move(group.at(-1)!, group);
    }
    const under = board.live();
    board.up(rest.at(-1) ?? first!);
    return { under };
  }

  it('recorded hands, one stroke a go: what is on screen after the lift is what is saved, at every zoom, fast and slow', async () => {
    const gos = (hands.gos as Go[]).filter((g) => g.strokes.length === 1);
    expect(gos.length).toBe(36);
    for (const go of gos) {
      const board = withPen(go.camera);
      const { under } = play(board, go.strokes[0]!);
      const lifted = board.live();
      const [mark] = await board.rest();
      const kept = saved(mark!);
      expect(lifted, go.name).toEqual(kept);
      // Only a loop changes as the pen lifts: its end is put on its start. Anything else is the same before and after.
      if (go.kind !== 'circle') expect(under, go.name).toEqual(kept);
      cleanup();
    }
  });

  it('recorded crosses, two strokes in one mark: each stroke stays where it was drawn, to a hundredth of a board unit', async () => {
    const gos = (hands.gos as Go[]).filter((g) => g.strokes.length === 2);
    expect(gos.length).toBe(12);
    for (const go of gos) {
      const board = withPen(go.camera);
      for (const s of go.strokes) play(board, s);
      const lifted = board.live();
      const marks = await board.rest();
      expect(marks, go.name).toHaveLength(1);
      const kept = saved(marks[0]!);
      expect(kept).toHaveLength(2);
      for (const [i, was] of lifted.entries()) {
        const [before, after] = [outline(was), outline(kept[i]!)];
        expect(after.length, go.name).toBe(before.length);
        // The mark's box begins elsewhere than the stroke's own, by a whole number of tenths: the numbers move, the line does not.
        const off = Math.max(...before.map((p, k) => Math.max(Math.abs(p[0] - after[k]![0]), Math.abs(p[1] - after[k]![1]))));
        expect(off, go.name).toBeLessThan(0.011);
      }
      cleanup();
    }
  });
});

/* ------------------------------------------------------------------ a go is made at one zoom */

describe('a go is made at one zoom: no stroke changes once it is drawn', () => {
  it('zooming between two strokes of one go: the first is saved as it was on screen, at its own width', async () => {
    const board = withPen({ x: 0, y: 0, z: 1 });
    board.stroke(line([100, 100], [300, 140], 40));
    const [first] = board.live();
    // The owner zooms in before the pause, and draws a second stroke.
    act(() => board.camera.set({ x: 0, y: 0, z: 2 }));
    board.down([700, 500]);
    // The first stroke has become its mark: it is no longer in the live layer, so it cannot be drawn there at the new width.
    expect(board.live()).toEqual([]);
    for (const p of line([700, 500], [900, 560], 40).slice(1)) board.move(p);
    board.up([900, 560]);
    const marks = await board.rest();
    expect(marks.map((m) => m.strokes.map((s) => s.w))).toEqual([[penWidth(4.5, 1)], [penWidth(4.5, 2)]]);
    expect(saved(marks[0]!)).toEqual([first]);
  });

  it('zooming between two strokes of one go: each is cut into marks and read at its own zoom', async () => {
    const rects: TargetRect[] = [
      { id: 'sp', item: 'sp', box: [800, 100, 600, 300] },
      { id: 'sp/a', item: 'sp', sub: 'approach:a', parent: 'sp', box: [100, 100, 20, 10] },
    ];
    // A ring 28 by 20 round a small thing: a circle at 100%, and 14 px across at 50%, too small to be one.
    const ring: Px[] = Array.from({ length: 200 }, (_, i) => {
      const t = (i / 199) * 2 * Math.PI;
      return [110 + 14 * Math.cos(t), 105 + 10 * Math.sin(t)] as const;
    });
    const solo = withPen({ x: 0, y: 0, z: 1 });
    solo.board.measure = () => rects;
    solo.stroke(ring);
    const alone = await solo.rest();
    expect(alone.map((m) => [m.hint, m.targets])).toEqual([['circle', [{ item: 'sp', sub: 'approach:a' }]]]);
    cleanup();

    const board = withPen({ x: 0, y: 0, z: 1 });
    board.board.measure = () => rects;
    board.stroke(ring);
    act(() => board.camera.set({ x: 0, y: 0, z: 0.5 }));
    board.stroke(line([600, 300], [700, 320], 20));
    const marks = await board.rest();
    expect(marks).toHaveLength(2);
    expect(marks[0]).toEqual({ ...alone[0], id: marks[0]!.id });
  });

  it('a stroke begun at a new zoom and cut short leaves the strokes before it as they were, on screen and when saved', async () => {
    const pending: InkItem[] = [];
    const board = withPen({ x: 0, y: 0, z: 1 });
    board.board.showPending = (items) => pending.push(...items);
    board.stroke(line([100, 100], [300, 140], 40));
    const [first] = board.live();
    act(() => board.camera.set({ x: 0, y: 0, z: 2 }));
    board.down([700, 500]);
    board.move([760, 520]);
    board.cancel();
    // The first stroke went from the live layer to the board as its mark, drawn as it was drawn.
    expect(board.live()).toEqual([]);
    expect(pending.flatMap(saved)).toEqual([first]);
    const marks = await board.rest();
    expect(marks.map((m) => m.strokes.map((s) => s.w))).toEqual([[penWidth(4.5, 1)]]);
    expect(saved(marks[0]!)).toEqual([first]);
  });

  it('two strokes at the same zoom are still one go: a cross is still a cross', async () => {
    const board = withPen({ x: -100, y: 40, z: 2 });
    const pending: InkItem[] = [];
    board.board.showPending = (items) => pending.push(...items);
    board.stroke(line([300, 300], [400, 400]));
    board.stroke(line([400, 300], [300, 400]));
    expect(pending).toEqual([]);
    const marks = await board.rest();
    expect(marks.map((m) => [m.hint, m.strokes.length])).toEqual([['cross', 2]]);
  });

  it('the pause does not end a go under the pen: taking back a stroke while the next is drawn waits for its lift', async () => {
    const board = withPen();
    board.stroke(line([100, 100], [300, 120], 20));
    board.stroke(line([100, 200], [300, 220], 20));
    board.down([100, 300]);
    board.move([200, 310]);
    act(() => {
      expect(board.pen.dropStroke(board.board)).toBe(true);
    });
    // Well past the pause, with the pen still down: nothing is made yet.
    await act(() => vi.advanceTimersByTimeAsync(3 * PEN_PAUSE));
    expect(board.did.marks).toEqual([]);
    expect(board.live()).toHaveLength(2);
    board.move([300, 320]);
    board.up([300, 320]);
    const marks = await board.rest();
    expect(marks).toHaveLength(1);
    expect(marks[0]!.strokes).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ a stroke that fills up */

describe('a stroke that fills up carries on in a new one, and nothing on screen changes', () => {
  /** Laps to and fro, 400 px long and 6 apart, a sample every 2 px: each one is kept. */
  const lap = (i: number): Px => {
    const n = Math.floor(i / 200);
    const x = (i % 200) * 2;
    return [100 + (n % 2 === 0 ? x : 400 - x), 100 + n * 6];
  };

  it('the stroke drawn so far stays as it is, every sample is saved, and each stroke is within what the log takes', async () => {
    const board = withPen();
    const total = STROKE_MAX_POINTS + 700;
    board.down(lap(0));
    // The browser hands over 500 samples a frame, so a long stroke is drawn in a few frames.
    let at = 1;
    let filled: Drawn | undefined;
    while (at < total) {
      const batch = Array.from({ length: Math.min(500, total - at) }, (_, k) => lap(at + k));
      at += batch.length;
      board.move(batch.at(-1)!, batch);
      const now = board.live();
      if (now.length === 2 && !filled) filled = now[0];
      // From the frame the first stroke filled up, it is never drawn again.
      if (filled) expect(now[0]).toEqual(filled);
    }
    board.up(lap(total - 1));
    const marks = await board.rest();
    const strokes = marks.flatMap((m) => m.strokes);
    expect(strokes).toHaveLength(2);
    // The second begins under the first's last points, so it comes out at the join as wide as the line it carries on.
    expect(strokes.map((s) => s.pts.length)).toEqual([STROKE_MAX_POINTS * 2, (total - STROKE_MAX_POINTS + 1 + STROKE_JOIN_POINTS) * 2]);
    expect(strokes[1]!.pts.slice(0, 2 * (STROKE_JOIN_POINTS + 1))).toEqual(strokes[0]!.pts.slice(-2 * (STROKE_JOIN_POINTS + 1)));
    for (const m of marks) expect(InkItem.safeParse(m).success).toBe(true);
    // Both strokes are one mark, counted from its box: the numbers move, the line does not.
    const [was, kept] = [outline(filled!), outline(saved(marks[0]!)[0]!)];
    expect(kept).toHaveLength(was.length);
    expect(Math.max(...was.map((p, k) => Math.max(Math.abs(p[0] - kept[k]![0]), Math.abs(p[1] - kept[k]![1]))))).toBeLessThan(0.011);
  });

  it('a go that reaches its most strokes as a stroke fills up is made into marks there, and the stroke carries on', async () => {
    const board = withPen();
    for (let i = 0; i < GO_MAX_STROKES - 1; i++) board.stroke(line([100 + (i % 10) * 30, 600 + Math.floor(i / 10) * 30], [120 + (i % 10) * 30, 600 + Math.floor(i / 10) * 30], 2));
    expect(board.did.marks).toEqual([]);
    board.down(lap(0));
    const batch = Array.from({ length: STROKE_MAX_POINTS + 50 }, (_, k) => lap(k + 1));
    board.move(batch.at(-1)!, batch);
    await act(() => vi.advanceTimersByTimeAsync(0));
    // The go's 120 strokes are its marks, the full one among them, while the pen is still down.
    expect(board.did.marks.flatMap((m) => (m.kind === 'ink' ? m.strokes : []))).toHaveLength(GO_MAX_STROKES);
    expect(board.live()).toHaveLength(1);
    board.up(batch.at(-1)!);
    const marks = await board.rest();
    expect(marks.flatMap((m) => m.strokes)).toHaveLength(GO_MAX_STROKES + 1);
    for (const m of marks) expect(InkItem.safeParse(m).success).toBe(true);
  });

  it('a press that fills a stroke and is then cut short takes all it drew with it', async () => {
    const board = withPen();
    board.stroke(line([100, 600], [300, 620], 20));
    const [first] = board.live();
    board.down(lap(0));
    const batch = Array.from({ length: STROKE_MAX_POINTS + 50 }, (_, k) => lap(k + 1));
    board.move(batch.at(-1)!, batch);
    expect(board.live()).toHaveLength(3);
    board.cancel();
    expect(board.live()).toEqual([first]);
    const marks = await board.rest();
    expect(marks.flatMap((m) => m.strokes)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ a loop closes */

describe('a loop closes as the pen lifts', () => {
  /** Round three sides of a square 60 px wide and back up the fourth, to `gap` px short of the start. */
  const almost = (gap: number): Px[] => [...line([300, 200], [360, 200]), ...line([360, 200], [360, 260]).slice(1), ...line([360, 260], [300, 260]).slice(1), ...line([300, 260], [300, 200 + gap]).slice(1)];

  it.each(ZOOMS)('at %s: ends 8 px apart close, and the saved mark is the closed stroke that is on screen', async (_name, cam) => {
    const board = withPen(cam);
    const points = almost(LOOP_CLOSE);
    board.down(points[0]!);
    for (const p of points.slice(1)) board.move(p);
    const [under] = board.live();
    board.up(points.at(-1)!);
    const [lifted] = board.live();
    const [mark] = await board.rest();
    const pts = mark!.strokes[0]!.pts;
    expect(pts.slice(-2)).toEqual(pts.slice(0, 2));
    expect(lifted).toEqual(saved(mark!)[0]);
    // The lift is when it closes: the end moves onto the start, and the drawing follows.
    expect(lifted!.d).not.toBe(under!.d);
  });

  it.each(ZOOMS)('at %s: ends 9 px apart stay apart, and nothing changes as the pen lifts', async (_name, cam) => {
    const board = withPen(cam);
    const points = almost(LOOP_CLOSE + 1);
    board.down(points[0]!);
    for (const p of points.slice(1)) board.move(p);
    const [under] = board.live();
    board.up(points.at(-1)!);
    expect(board.live()[0]).toEqual(under);
    const [mark] = await board.rest();
    const pts = mark!.strokes[0]!.pts;
    expect(pts.slice(-2)).not.toEqual(pts.slice(0, 2));
    expect(Math.hypot(pts.at(-2)! - pts[0]!, pts.at(-1)! - pts[1]!) * cam.z).toBeCloseTo(9, 0);
    expect(saved(mark!)[0]).toEqual(under);
  });

  it('a short tick does not close, though its ends are as near', async () => {
    const board = withPen();
    // Out 13 px, down 6, and back: 32 px in all, its ends 6 px apart.
    board.stroke([[300, 200], [313, 200], [313, 206], [300, 206]]);
    const [mark] = await board.rest();
    expect(mark!.strokes[0]!.pts).toEqual([0, 0, 13, 0, 13, 6, 0, 6]);
  });
});

/* ------------------------------------------------------------------ a click makes no mark */

describe('a lone click with the Pen makes no mark', () => {
  it.each(ZOOMS)('at %s: a click posts nothing and leaves nothing in the live layer', async (_name, cam) => {
    const board = withPen(cam);
    board.down([400, 300]);
    board.frame();
    expect(board.live()).toEqual([]);
    board.up([400, 300]);
    expect(board.live()).toEqual([]);
    expect(board.hand.get().strokes).toEqual([]);
    expect(board.pen.open()).toBe(false);
    expect(await board.rest()).toEqual([]);
    expect(board.did.said).toEqual([]);
  });

  it.each(ZOOMS)('at %s: a press that moves 4 px is still a click, and one that moves 5 px draws', async (_name, cam) => {
    expect(CLICK_SLOP).toBe(4);
    const click = withPen(cam);
    click.down([400, 300]);
    click.move([404, 300]);
    // Nothing shows while it is still a click: no dot flashes under the pointer.
    expect(click.live()).toEqual([]);
    click.up([404, 300]);
    expect(click.live()).toEqual([]);
    expect(await click.rest()).toEqual([]);
    cleanup();

    const drag = withPen(cam);
    drag.down([400, 300]);
    drag.move([405, 300]);
    expect(drag.live()).toHaveLength(1);
    drag.up([405, 300]);
    const marks = await drag.rest();
    expect(marks).toHaveLength(1);
    // The stroke is drawn from where the press went down.
    const [x, y] = world([400, 300], cam);
    expect(marks[0]!.box[0]).toBeCloseTo(x, 1);
    expect(marks[0]!.box[1]).toBeCloseTo(y, 1);
    expect(marks[0]!.box[2] * cam.z).toBeCloseTo(5, 0);
  });

  it('the samples of a press that is still a click are not lost: once it is a drag, the stroke has them from the first', async () => {
    const board = withPen();
    board.down([400, 300]);
    board.move([402, 300]);
    board.move([404, 300]);
    expect(board.live()).toEqual([]);
    board.move([420, 300]);
    expect(board.hand.get().strokes[0]!.map((p) => p[0])).toEqual([400, 402, 404, 420]);
    board.up([420, 300]);
    expect((await board.rest())[0]!.strokes[0]!.pts).toEqual([0, 0, 2, 0, 4, 0, 20, 0]);
  });

  it('a click in the middle of a go adds nothing to it, and the go still becomes its mark after the pause', async () => {
    const board = withPen();
    board.stroke(line([300, 200], [400, 210]));
    const [first] = board.liveNodes();
    board.down([500, 400]);
    board.up([500, 400]);
    expect(board.liveNodes()).toEqual([first]);
    expect(board.pen.waiting()).toBe(true);
    const marks = await board.rest();
    expect(marks).toHaveLength(1);
    expect(marks[0]!.strokes).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ once a frame, no copies */

describe('a long stroke never lags: one list, told once a frame', () => {
  it('a stroke is one list from the press to the lift, and the layer’s state is not made again as it grows', () => {
    const board = withPen();
    board.down([100, 100]);
    board.move([110, 100]);
    const state = board.hand.get();
    const list = state.strokes[0];
    for (let i = 2; i <= 200; i++) board.move([100 + i * 10, 100 + 40 * Math.sin(i / 5)]);
    expect(board.hand.get()).toBe(state);
    expect(board.hand.get().strokes[0]).toBe(list);
    expect(list).toHaveLength(201);
    board.up([2100, 100 + 40 * Math.sin(40)]);
    expect(board.hand.get().strokes[0]).toBe(list);
  });

  it('the live layer draws once a frame, however many samples the frame brought', () => {
    const board = withPen();
    board.down([100, 100]);
    board.frame();
    expect(worked).toEqual([]);
    const before = board.commits.n;
    // Four pointer events before the frame, the last with three samples of its own.
    board.moveOnly([108, 100]);
    board.moveOnly([116, 102]);
    board.moveOnly([124, 104]);
    board.move([156, 110], [[132, 106], [140, 108], [156, 110]]);
    expect(worked).toHaveLength(1);
    expect(board.commits.n - before).toBe(1);
    expect(board.hand.get().strokes[0]).toHaveLength(7);
    for (let i = 1; i <= 30; i++) board.move([156 + i * 8, 110]);
    expect(worked).toHaveLength(31);
    expect(board.commits.n - before).toBe(31);
    // A frame with no new sample draws nothing.
    board.frame();
    board.frame();
    expect(worked).toHaveLength(31);
    expect(board.commits.n - before).toBe(31);
  });

  it('a finished stroke of the go is not drawn again while the next is drawn', () => {
    const board = withPen();
    board.stroke(line([100, 100], [300, 120], 20));
    const [first] = board.liveNodes();
    const was = drawnIn(first!);
    worked.length = 0;
    board.down([100, 200]);
    for (let i = 1; i <= 25; i++) board.move([100 + i * 8, 200 + i]);
    // 25 frames, 25 paths worked out, each for the stroke being drawn: it has grown by a point a frame.
    expect(worked).toEqual(Array.from({ length: 25 }, (_, i) => (i + 2) * 2));
    expect(board.liveNodes()[0]).toBe(first);
    expect(drawnIn(first!)).toEqual(was);
    board.up([300, 225]);
    expect(worked).toHaveLength(25);
    expect(board.liveNodes()).toHaveLength(2);
  });

  it('the samples that wait for their frame are in the stroke when the pen lifts', async () => {
    const board = withPen();
    board.down([100, 100]);
    board.move([150, 100]);
    board.moveOnly([200, 110]);
    board.moveOnly([250, 100]);
    // No frame has passed since the last two moves.
    expect(board.hand.get().strokes[0]).toHaveLength(2);
    board.up([250, 100]);
    const [lifted] = board.live();
    const [mark] = await board.rest();
    expect(mark!.strokes[0]!.pts).toEqual([0, 0, 50, 0, 100, 10, 150, 0]);
    expect(lifted).toEqual(saved(mark!)[0]);
  });

  it('a stroke that is cut short goes, with the samples that waited, and the stroke before it is left as it was drawn', async () => {
    const board = withPen();
    board.stroke(line([100, 100], [300, 120], 20));
    const [first] = board.liveNodes();
    const was = drawnIn(first!);
    board.down([100, 200]);
    board.move([150, 200]);
    board.moveOnly([200, 210]);
    worked.length = 0;
    board.cancel();
    expect(board.liveNodes()).toEqual([first]);
    expect(drawnIn(first!)).toEqual(was);
    // The stroke that went took its waiting samples with it: one path at most was worked out for it, and it is gone.
    expect(worked.length).toBeLessThanOrEqual(1);
    const marks = await board.rest();
    expect(marks).toHaveLength(1);
    expect(marks[0]!.strokes).toHaveLength(1);
  });

  it('taking back the last stroke of a go leaves the strokes before it as they were drawn', async () => {
    const board = withPen();
    board.stroke(line([100, 100], [300, 120], 20));
    board.stroke(line([100, 200], [300, 220], 20));
    const [first] = board.liveNodes();
    worked.length = 0;
    act(() => {
      expect(board.pen.dropStroke(board.board)).toBe(true);
    });
    expect(board.liveNodes()).toEqual([first]);
    expect(worked).toEqual([]);
    const marks = await board.rest();
    expect(marks).toHaveLength(1);
    expect(marks[0]!.strokes).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ kept by distance on screen */

describe('ink drawn zoomed in keeps its curves', () => {
  it('a slow ring drawn at 400% is saved with a point at least every 2 screen pixels', async () => {
    const cam: Camera = { x: -1301.75, y: -640.5, z: 4 };
    const board = withPen(cam);
    // A sample every screen pixel round a ring 100 px across: 314 px in all.
    const ring = Array.from({ length: 315 }, (_, i): Px => [600 + 50 * Math.cos(i / 50), 400 + 50 * Math.sin(i / 50)]);
    board.stroke(ring);
    const [mark] = await board.rest();
    const pts = pairs(mark!.strokes[0]!.pts);
    expect(pts.length).toBeGreaterThanOrEqual(314 / 2);
    const widest = Math.max(...pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i]![0], p[1] - pts[i]![1]) * cam.z));
    // 2 px, give or take the tenth of a board unit each point is rounded to.
    expect(widest).toBeLessThanOrEqual(2 + 0.1 * Math.SQRT2 * cam.z);
  });

  it('the same hand keeps as many points at any zoom', async () => {
    const counts: number[] = [];
    for (const [, cam] of ZOOMS) {
      const board = withPen(cam);
      board.stroke(handStroke(7, 200));
      counts.push((await board.rest())[0]!.strokes[0]!.pts.length);
      cleanup();
    }
    expect(counts[0]).toBe(counts[1]);
    expect(counts[2]).toBe(counts[1]);
  });
});

/* ------------------------------------------------------------------ the split and the marks */

describe('a go is cut into marks from the points each mark is read from', () => {
  /** A spread with one approach, and a step inside it, as the page measures them. */
  const rects: TargetRect[] = [
    { id: 'sp', item: 'sp', box: [800, 100, 600, 300] },
    { id: 'sp/approach:a', item: 'sp', sub: 'approach:a', parent: 'sp', box: [816, 140, 280, 240] },
    { id: 'sp/step:a-take', item: 'sp', sub: 'step:a-take', parent: 'sp/approach:a', box: [832, 180, 120, 40] },
  ];
  /** A ring round the step, a sample about every pixel, wide enough to clear its corners. */
  const slowRing = (scale: number): Px[] =>
    Array.from({ length: 566 }, (_, i) => {
      const t = -Math.PI / 2 + (i / 565) * 2 * Math.PI;
      return [(892 + 90 * Math.cos(t)) * scale, (200 + 32 * Math.sin(t)) * scale] as const;
    });

  it('a ring drawn slowly round a step, then a line elsewhere in its approach: a pick, and a mark of its own', async () => {
    const board = withPen();
    board.board.measure = () => rects;
    board.stroke(slowRing(1));
    board.stroke(line([1000, 300], [1010, 360]));
    const marks = await board.rest();
    expect(marks.map((m) => [m.hint, m.targets])).toEqual([
      ['circle', [{ item: 'sp', sub: 'step:a-take' }]],
      ['none', [{ item: 'sp', sub: 'approach:a' }]],
    ]);
  });

  it('a go that became two marks is one step for Undo: the pen says so before the first mark is posted', async () => {
    const board = withPen();
    board.board.measure = () => rects;
    /** What the board was told, in the order it was told. */
    const told: string[] = [];
    const { together, postMark } = board.board;
    board.board.together = (ids) => {
      told.push(`together ${ids.length}`);
      together(ids);
    };
    board.board.postMark = (item) => {
      told.push('post');
      return postMark(item);
    };
    board.stroke(slowRing(1));
    board.stroke(line([1000, 300], [1010, 360]));
    const marks = await board.rest();
    expect(marks).toHaveLength(2);
    expect(told).toEqual(['together 2', 'post', 'post']);
    expect(board.did.groups).toEqual([marks.map((m) => m.id)]);
  });

  it('the pen reads at the zoom it drew at: the same ring drawn at 400%, a quarter the size on the board, is still a pick', async () => {
    const cam: Camera = { x: 0, y: 0, z: 4 };
    const board = withPen(cam);
    // The board is the same board, and the ring is drawn round a step an eighth the size: 23.9 board units from corner to corner, 96 px on screen.
    board.board.measure = () => rects.map((r) => ({ ...r, box: [r.box[0] / 8, r.box[1] / 8, r.box[2] / 8, r.box[3] / 8] }));
    board.stroke(slowRing(0.5));
    const marks = await board.rest();
    expect(marks.map((m) => [m.hint, m.targets])).toEqual([['circle', [{ item: 'sp', sub: 'step:a-take' }]]]);
  });
});

/* ------------------------------------------------------------------ ink on whole board units */

describe('every drawing of ink sits on whole board units, so the pixels it lands on are the same live and saved', () => {
  /** Where each point of a drawing's path lands, by its numbers counted from the mark's corner. */
  const landed = (drawn: Drawn, corner: readonly [number, number]) => pairs((drawn.d?.match(/-?\d+\.\d+/g) ?? []).map(Number)).map(([x, y]) => [x + corner[0], y + corner[1]]);
  /** Where a drawing's SVG sits on the board: its left, top, width and height. */
  const placeOf = (drawn: Drawn) => ['left', 'top', 'width', 'height'].map((name) => Number(new RegExp(`${name}: ?(-?[\\d.]+)px`).exec(drawn.place)?.[1]));
  const whole = (drawn: Drawn) => placeOf(drawn).every((n) => Number.isInteger(n));
  const farthest = (a: number[][], b: number[][]) => Math.max(...a.map((p, k) => Math.max(Math.abs(p[0]! - b[k]![0]!), Math.abs(p[1]! - b[k]![1]!))));

  it('a mark at a fractional place: its SVG is on whole units, and each point of its path lands where it did', () => {
    const item: InkItem = { id: 'm1', kind: 'ink', box: [100.3, 50.7, 40.2, 30.1], strokes: [{ pts: [0, 0, 20.1, 30.1, 40.2, 10.3], w: 4.5 }], targets: [], hint: 'none' };
    const elsewhere: Box = [140.35, -20.65, 80.4, 15.05];
    for (const shown of [item.box, elsewhere]) {
      const { container } = render(<InkMark strokes={item.strokes} box={item.box} shown={shown} />);
      const svg = container.querySelector('svg')!;
      const drawn = drawnIn(svg);
      expect(whole(drawn), drawn.place).toBe(true);
      // The viewBox is written short: no 0.30000000000000004.
      expect(drawn.viewBox).toMatch(/^-?\d+(\.\d{1,4})? -?\d+(\.\d{1,4})? \d+ \d+$/);
      const out = outline(drawn);
      expect(out.length).toBeGreaterThan(10);
      expect(farthest(out, landed(drawn, [shown[0], shown[1]]))).toBeLessThan(0.001);
      cleanup();
    }
  });

  it('an arrow being drawn sits on whole units too', () => {
    const board = withPen();
    act(() => board.hand.set({ shape: { kind: 'arrow', from: [10.3, 20.7], to: [100.2, 50.1] } }));
    const svg = document.querySelector('svg.live-line');
    if (!svg) throw new Error('a shape is drawn in an svg');
    const drawn = drawnIn(svg);
    expect(whole(drawn)).toBe(true);
    // Its points are in board units, where the viewBox begins: the SVG's box and the viewBox are one rectangle.
    expect(drawn.viewBox).toBe(placeOf(drawn).join(' '));
    // The box the same line has once it is saved: whole units round its points and 12 units of room.
    expect(placeOf(drawn)).toEqual([-2, 8, 115, 55]);
  });

  it.each(ZOOMS)('at %s, two strokes in one go, the second begun a fraction of a unit off the first: each SVG, live and saved, is on whole units and the line stays put', async (_name, cam) => {
    const board = withPen(cam);
    board.stroke(line([300, 300], [420, 310], 30));
    board.stroke(line([300.3, 340.7], [420.3, 330.7], 30));
    const lifted = board.live();
    const marks = await board.rest();
    expect(marks).toHaveLength(1);
    const kept = saved(marks[0]!);
    expect([...lifted, ...kept].every(whole)).toBe(true);
    for (const [i, was] of lifted.entries()) expect(farthest(outline(was), outline(kept[i]!))).toBeLessThan(0.011);
  });
});

/* ------------------------------------------------------------------ one press, however many pieces */

describe('one press is one stroke to the owner, however many pieces it is kept in', () => {
  /** A card, and a note beside it. */
  const rects: TargetRect[] = [
    { id: 'a1', item: 'a1', box: [190, 100, 260, 80] },
    { id: 'n2', item: 'n2', box: [520, 120, 200, 24] },
  ];
  /** To and fro over the card 25 times, 240 px wide and a sample every 2 px: 3,000 samples, so the press fills a stroke as its last pass ends. */
  const hatch: Px[] = Array.from({ length: STROKE_MAX_POINTS }, (_, i) => {
    const n = Math.floor(i / 120);
    const x = (i % 120) * 2;
    return [200 + (n % 2 === 0 ? x : 240 - x), 120 + 10 * (n % 5)];
  });
  /** On from the last pass, level, under the note: alone, it would underline the note. */
  const tail: Px[] = Array.from({ length: 150 }, (_, k) => [440 + 2 * k, 160]);
  /** How the whole press reads, from every point the hand drew, as if no stroke ever filled up. */
  const whole = (points: readonly Px[], on: readonly TargetRect[]) => readInk([points.map(([x, y]) => [x, y] as const)], on);
  /** A level line `n` samples long, 2 px apart, under a row as long: it fills a stroke and goes on. */
  const longLine = (n: number): Px[] => Array.from({ length: n }, (_, i) => [100 + 2 * i, 100]);
  const row: TargetRect[] = [{ id: 'row', item: 'row', box: [90, 60, 2 * STROKE_MAX_POINTS + 400, 30] }];

  it('hatching over a card past a full stroke, its tail running on under a note: one mark, on the card alone, in both pieces', async () => {
    const board = withPen();
    board.board.measure = () => rects;
    board.press([...hatch, ...tail]);
    expect(board.live()).toHaveLength(2);
    const marks = await board.rest();
    expect(marks.map((m) => [m.targets, m.strokes.length])).toEqual([[[{ item: 'a1' }], 2]]);
    // Alone, the tail's piece is an underline of the note: read as pieces, the press was two marks.
    const [x0, y0] = marks[0]!.box;
    const tailPiece = pairs(marks[0]!.strokes[1]!.pts).map(([x, y]) => [x + x0, y + y0] as const);
    expect(readInk([tailPiece], rects)).toMatchObject({ hint: 'underline', targets: ['n2'] });
  });

  it('a stroke on the card, then the long press: one mark, the press read as the whole of it and not as its last piece', async () => {
    const board = withPen();
    board.board.measure = () => rects;
    board.stroke(line([220, 110], [300, 170], 20));
    board.press([...hatch, ...tail]);
    const marks = await board.rest();
    expect(marks.map((m) => [m.targets, m.strokes.length])).toEqual([[[{ item: 'a1' }], 3]]);
  });

  it('a press is read as the whole press reads, as if no stroke had filled up: hatching, and an underline longer than a stroke holds', async () => {
    const hatched = withPen();
    hatched.board.measure = () => rects;
    hatched.press([...hatch, ...tail]);
    const [mark] = await hatched.rest();
    const reading = whole([...hatch, ...tail], rects);
    expect([mark!.hint, mark!.targets.map((t) => t.item)]).toEqual([reading.hint, reading.targets]);
    cleanup();

    const underlined = withPen();
    underlined.board.measure = () => row;
    const points = longLine(STROKE_MAX_POINTS + 200);
    underlined.press(points);
    const marks = await underlined.rest();
    expect(whole(points, row)).toMatchObject({ hint: 'underline', targets: ['row'] });
    // Two strokes are a cross or nothing: read as its pieces, the line was nothing.
    expect(marks.map((m) => [m.hint, m.targets, m.strokes.length])).toEqual([['underline', [{ item: 'row' }], 2]]);
  });

  it('Undo inside the go takes the whole press that filled a stroke, not only its last piece', () => {
    const board = withPen();
    board.press([...hatch, ...tail]);
    expect(board.live()).toHaveLength(2);
    act(() => void board.pen.dropStroke(board.board));
    expect(board.live()).toEqual([]);
    expect(board.pen.waiting()).toBe(false);
  });

  it('Undo inside the go after a stroke and a long press: the press goes, whole, and the stroke before it stays as it was drawn', async () => {
    const board = withPen();
    board.stroke(line([100, 400], [300, 420], 20));
    const [first] = board.live();
    board.press([...hatch, ...tail]);
    expect(board.live()).toHaveLength(3);
    act(() => void board.pen.dropStroke(board.board));
    expect(board.live()).toEqual([first]);
    const marks = await board.rest();
    expect(marks.flatMap((m) => m.strokes)).toHaveLength(1);
    expect(saved(marks[0]!)).toEqual([first]);
  });

  it('a press that fills up twice is still one: three pieces, read as one line, and taken back whole', async () => {
    const points = longLine(2 * STROKE_MAX_POINTS + 100);
    const board = withPen();
    board.board.measure = () => [{ ...row[0]!, box: [90, 60, 4 * STROKE_MAX_POINTS + 400, 30] }];
    board.press(points);
    expect(board.live()).toHaveLength(3);
    const marks = await board.rest();
    expect(marks.map((m) => [m.hint, m.strokes.length])).toEqual([['underline', 3]]);
    cleanup();

    const undone = withPen();
    undone.stroke(line([100, 400], [300, 420], 20));
    undone.press(points);
    expect(undone.live()).toHaveLength(4);
    act(() => void undone.pen.dropStroke(undone.board));
    expect(undone.live()).toHaveLength(1);
  });

  it('two strokes that cross on one card are still a cross: two presses are never joined', async () => {
    const board = withPen();
    board.board.measure = () => rects;
    board.stroke(line([230, 110], [410, 170], 40));
    board.stroke(line([410, 110], [230, 170], 40));
    const marks = await board.rest();
    expect(marks.map((m) => [m.hint, m.targets, m.strokes.length])).toEqual([['cross', [{ item: 'a1' }], 2]]);
  });

  it('taking back a stroke while a long press is down, with no stroke finished before it, takes nothing', () => {
    const board = withPen();
    board.down(hatch[0]!);
    const rest = [...hatch.slice(1), ...tail];
    board.move(rest.at(-1)!, rest);
    const down = board.live();
    expect(down).toHaveLength(2);
    act(() => {
      expect(board.pen.dropStroke(board.board)).toBe(false);
    });
    expect(board.live()).toEqual(down);
  });

  it('a long press with nothing finished before it: the go is open from the press, and nothing waits until the lift, so nothing makes its full pieces into a mark of their own', async () => {
    const board = withPen();
    board.down(hatch[0]!);
    expect([board.pen.open(), board.pen.waiting()]).toEqual([true, false]);
    const rest = [...hatch.slice(1), ...tail];
    board.move(rest.at(-1)!, rest);
    expect(board.live()).toHaveLength(2);
    // The board asks `waiting` before it makes a go into marks early (a change of tool): a press that is down is not cut there.
    expect([board.pen.open(), board.pen.waiting()]).toEqual([true, false]);
    board.up(rest.at(-1)!);
    expect([board.pen.open(), board.pen.waiting()]).toEqual([true, true]);
    const marks = await board.rest();
    expect(marks.map((m) => m.strokes.length)).toEqual([2]);
    expect([board.pen.open(), board.pen.waiting()]).toEqual([false, false]);
  });

  it('taking back a stroke while a long press is down takes the last finished press and leaves the press that is down; a cancel then takes that press, all of it, and nothing else', async () => {
    const board = withPen();
    board.stroke(line([100, 400], [300, 420], 20));
    const [first] = board.live();
    board.stroke(line([100, 450], [300, 470], 20));
    board.down(hatch[0]!);
    const rest = [...hatch.slice(1), ...tail];
    board.move(rest.at(-1)!, rest);
    const down = board.live().slice(2);
    expect(down).toHaveLength(2);
    act(() => {
      expect(board.pen.dropStroke(board.board)).toBe(true);
    });
    expect(board.live()).toEqual([first, ...down]);
    board.cancel();
    expect(board.live()).toEqual([first]);
    const marks = await board.rest();
    expect(marks.flatMap((m) => m.strokes)).toHaveLength(1);
    expect(saved(marks[0]!)).toEqual([first]);
  });

  it('a go that reaches its most strokes with the pen down is made into marks there; a cancel after that takes only what was drawn since', async () => {
    const board = withPen();
    for (let i = 0; i < GO_MAX_STROKES - 1; i++) board.stroke(line([100 + (i % 10) * 30, 600 + Math.floor(i / 10) * 30], [120 + (i % 10) * 30, 600 + Math.floor(i / 10) * 30], 2));
    board.down(hatch[0]!);
    // The press fills one stroke, which makes the go's most, and then a second after the go is made.
    const rest = longLine(2 * STROKE_MAX_POINTS + 100).map(([x, y]): Px => [x, y + 900]);
    board.move(rest.at(-1)!, rest);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(board.did.marks.flatMap((m) => (m.kind === 'ink' ? m.strokes : []))).toHaveLength(GO_MAX_STROKES);
    expect(board.live()).toHaveLength(2);
    board.cancel();
    expect(board.live()).toEqual([]);
    expect(board.pen.open()).toBe(false);
    await board.rest();
    expect(board.did.marks.flatMap((m) => (m.kind === 'ink' ? m.strokes : []))).toHaveLength(GO_MAX_STROKES);
  });
});

/* ------------------------------------------------------------------ the go, its pause and its marks */

describe('the go becomes its marks at the right moment, at the zoom it was drawn at', () => {
  const rects: TargetRect[] = [
    { id: 'sp', item: 'sp', box: [800, 100, 600, 300] },
    { id: 'sp/approach:a', item: 'sp', sub: 'approach:a', parent: 'sp', box: [816, 140, 280, 240] },
    { id: 'sp/step:a-take', item: 'sp', sub: 'step:a-take', parent: 'sp/approach:a', box: [832, 180, 120, 40] },
  ];
  const ring = (scale: number): Px[] =>
    Array.from({ length: 566 }, (_, i) => {
      const t = -Math.PI / 2 + (i / 565) * 2 * Math.PI;
      return [(892 + 90 * Math.cos(t)) * scale, (200 + 32 * Math.sin(t)) * scale] as const;
    });

  it('at 400% a ring round a small step and then a line elsewhere in its approach are cut into two marks there: a pick, and a mark of its own', async () => {
    const board = withPen({ x: 0, y: 0, z: 4 });
    // The board an eighth the size: the ring is 24 board units across, 96 px on screen.
    board.board.measure = () => rects.map((r) => ({ ...r, box: [r.box[0] / 8, r.box[1] / 8, r.box[2] / 8, r.box[3] / 8] }));
    board.stroke(ring(0.5));
    board.stroke(line([500, 120], [512, 176]));
    const marks = await board.rest();
    expect(marks.map((m) => [m.hint, m.targets])).toEqual([
      ['circle', [{ item: 'sp', sub: 'step:a-take' }]],
      ['none', [{ item: 'sp', sub: 'approach:a' }]],
    ]);
  });

  /** Short strokes in rows, each its own press. */
  const short = (i: number): Px[] => line([100 + (i % 10) * 30, 600 + Math.floor(i / 10) * 30], [120 + (i % 10) * 30, 600 + Math.floor(i / 10) * 30], 2);

  it('the stroke that fills the go makes it into its marks at the lift, and the stroke after it begins a go of its own', async () => {
    const board = withPen();
    for (let i = 0; i < GO_MAX_STROKES - 1; i++) board.stroke(short(i));
    expect(board.did.marks).toEqual([]);
    board.stroke(short(GO_MAX_STROKES - 1));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(board.did.marks.flatMap((m) => (m.kind === 'ink' ? m.strokes : []))).toHaveLength(GO_MAX_STROKES);
    board.stroke(line([100, 1000], [300, 1000], 4));
    const marks = await board.rest();
    expect(marks.flatMap((m) => m.strokes)).toHaveLength(GO_MAX_STROKES + 1);
  });

  it('at 400% the piece that carries on keeps a point every 2 screen px, as the first does', async () => {
    const cam: Camera = { x: 0, y: 0, z: 4 };
    const board = withPen(cam);
    // To and fro, a sample every 2 px on screen, each lap 2 px under the last: each one is kept.
    const laps = Array.from({ length: STROKE_MAX_POINTS + 300 }, (_, k): Px => {
      const n = Math.floor(k / 400);
      const x = (k % 400) * 2;
      return [100 + (n % 2 === 0 ? x : 798 - x), 100 + n * 2];
    });
    board.press(laps);
    const strokes = (await board.rest()).flatMap((m) => m.strokes);
    expect(strokes).toHaveLength(2);
    const pts = pairs(strokes[1]!.pts);
    // Every sample after the join is kept: the joined points, and the 300 the first piece had no room for.
    expect(pts).toHaveLength(STROKE_JOIN_POINTS + 1 + 300);
    const widest = Math.max(...pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i]![0], p[1] - pts[i]![1]) * cam.z));
    expect(widest).toBeLessThanOrEqual(2 + 0.1 * Math.SQRT2 * cam.z);
  });

  it('Undo inside the go starts the pause again: the go becomes its mark a full pause after the Undo, not after the last lift', async () => {
    const board = withPen();
    board.stroke(line([100, 100], [300, 120], 20));
    board.stroke(line([100, 200], [300, 220], 20));
    await act(() => vi.advanceTimersByTimeAsync(PEN_PAUSE - 100));
    act(() => void board.pen.dropStroke(board.board));
    await act(() => vi.advanceTimersByTimeAsync(PEN_PAUSE - 1));
    expect(board.did.marks).toEqual([]);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(board.did.marks.flatMap((m) => (m.kind === 'ink' ? m.strokes : []))).toHaveLength(1);
  });

  describe('ink that waits to be posted is taken off the page once it is posted', () => {
    /** A go of two marks (a pick, and a stroke of its own), with what the board was told. */
    function twoMarks(post: (item: InkItem) => Promise<boolean>) {
      const board = withPen();
      board.board.measure = () => rects;
      const told = { shown: [] as string[], hidden: [] as string[] };
      board.board.showPending = (items) => told.shown.push(...items.map((m) => m.id));
      board.board.hidePending = (id) => told.hidden.push(id);
      board.board.postMark = (item) => post(item as InkItem);
      board.stroke(ring(1));
      board.stroke(line([1000, 300], [1010, 360]));
      return { board, told };
    }

    it('a post that lands', async () => {
      const { board, told } = twoMarks(async () => true);
      await act(() => board.pen.finish(board.board));
      expect(told.shown).toHaveLength(2);
      expect(told.hidden).toEqual(told.shown);
    });

    it('a post the board refuses', async () => {
      const { board, told } = twoMarks(async () => false);
      await act(() => board.pen.finish(board.board));
      expect(told.shown).toHaveLength(2);
      expect(told.hidden).toEqual(told.shown);
    });

    it('a post that throws', async () => {
      const board = withPen();
      const told = { shown: [] as string[], hidden: [] as string[] };
      board.board.showPending = (items) => told.shown.push(...items.map((m) => m.id));
      board.board.hidePending = (id) => told.hidden.push(id);
      board.board.postMark = () => Promise.reject(new Error('the line went down'));
      board.stroke(line([100, 100], [300, 120], 20));
      await act(() => expect(board.pen.finish(board.board)).rejects.toThrow('the line went down'));
      expect(told.shown).toHaveLength(1);
      expect(told.hidden).toEqual(told.shown);
    });

    it('a post that throws in a go of two marks ends the go: the second is not posted, its id is given back, and neither stays drawn as if it were coming', async () => {
      const posted: string[] = [];
      const { board, told } = twoMarks(async (item) => {
        posted.push(item.id);
        throw new Error('the line went down');
      });
      const freed: string[] = [];
      const free = board.board.freeId;
      board.board.freeId = (id) => {
        freed.push(id);
        free(id);
      };
      await act(() => expect(board.pen.finish(board.board)).rejects.toThrow('the line went down'));
      expect(told.shown).toHaveLength(2);
      expect(posted).toEqual([told.shown[0]]);
      expect(told.hidden).toEqual(told.shown);
      expect(freed).toEqual(told.shown);
    });
  });
});
