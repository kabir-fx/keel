import type { Box, InkItem, Item } from '@keel/protocol';
import { describe, expect, it } from 'vitest';
import { headPoints } from '../src/arrowhead';
import type { XY } from '../src/geometry';
import { distToPath } from '../src/geometry';
import { keep, PEN, samples } from '../src/ink/stroke';
import { ERASER_REACH, ERASER_REACH_MIN } from '../src/input/constants';
import { penWidth } from '../src/marks';
import type { Erasable } from '../src/tools/erasable';
import { erasables, reachAt, reached, segmentsApart } from '../src/tools/erasable';
import hands from './fixtures/hands.json';
import { CH, note, openBoard, placeAt, text } from './helpers';

/**
 * The eraser's hit test (`src/tools/erasable.ts`) as plain geometry: on strokes a hand drew in the
 * real Chrome at 25%, 100% and 400%, a click, a slow sweep and a fast one each reach a stroke one
 * step inside the eraser's reach and miss it one step outside. A box is reached on its border, an
 * arrow on its line, a pin on its icon, and nothing else is reached at all.
 */

/** One step either side of a limit, in board units. */
const STEP = 0.01;

/** One recorded go: the hand of `e2e/ink-hands.ts`, as the real Chrome delivered it. */
interface Go {
  name: string;
  kind: string;
  speed: string;
  camera: { x: number; y: number; z: number };
  strokes: Array<{ at: number[] }>;
}

const GOS = hands.gos as Go[];

/** A recorded go as the ink mark the pen would have posted: its strokes in board units, at the pen's width for its zoom. */
function inkOf(go: Go, id = 'ink'): InkItem {
  const { x, y, z } = go.camera;
  const strokes = go.strokes.map((s) => {
    const pts: XY[] = [];
    for (let i = 0; i + 1 < s.at.length; i += 2) pts.push([(s.at[i]! - x) / z, (s.at[i + 1]! - y) / z]);
    return pts;
  });
  const kept = keep(strokes, penWidth(PEN.size, z));
  return { id, kind: 'ink', box: kept.box, strokes: kept.strokes, targets: [], hint: 'none' };
}

/** A board with these marks of the owner's, each drawn at its own box. */
function boardWith(items: readonly Item[]) {
  const b = openBoard();
  for (const item of items) b.must('owner', { type: 'item.add', chapter: CH, item });
  const shown = new Map<string, Box>(items.flatMap((it): Array<[string, Box]> => (it.box ? [[it.id, it.box]] : [])));
  return { b, where: { state: b.state, boxes: new Map<string, Box>(), subs: new Map<string, Box>() }, shown };
}

/** The centre line of every stroke of an ink mark at its own box, as the log keeps it. */
function centreOf(ink: InkItem): XY[][] {
  return ink.strokes.map((s) => samples(s.pts).map(([px, py]): XY => [ink.box[0] + px, ink.box[1] + py]));
}

const add = (a: XY, b: XY, k = 1): XY => [a[0] + b[0] * k, a[1] + b[1] * k];
const dot = (a: XY, b: XY) => a[0] * b[0] + a[1] * b[1];

/**
 * The point of the ink furthest along `u`: nothing of the ink lies beyond the line through it
 * square to `u`, so a point `d` past it along `u` is exactly `d` from the ink, and so is every
 * point of a line through that point square to `u`.
 */
function furthest(lines: readonly XY[][], u: XY): XY {
  let best: XY = [0, 0];
  let most = -Infinity;
  for (const line of lines) {
    for (const p of line) {
      if (dot(p, u) > most) {
        most = dot(p, u);
        best = p;
      }
    }
  }
  return best;
}

/** Every piece of a slow sweep along a line, a few samples a frame: what each frame reaches. */
function slowSweep(from: XY, to: XY, spacing: number, perFrame: number, things: readonly Erasable[], z: number): string[] {
  const n = Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / spacing);
  const pts: XY[] = Array.from({ length: n + 1 }, (_, i) => [from[0] + ((to[0] - from[0]) * i) / n, from[1] + ((to[1] - from[1]) * i) / n]);
  const hit = new Set<string>(reached([pts[0]!], things, z));
  for (let i = 1; i < pts.length; i += perFrame) for (const id of reached(pts.slice(i - 1, i + perFrame), things, z)) hit.add(id);
  return [...hit];
}

const DIRECTIONS: XY[] = Array.from({ length: 8 }, (_, i) => [Math.cos((i * Math.PI) / 4), Math.sin((i * Math.PI) / 4)]);

describe('how far the eraser reaches', () => {
  it('5 screen pixels, and never less than 2.25 board units', () => {
    expect([ERASER_REACH, ERASER_REACH_MIN]).toEqual([5, 2.25]);
    expect(reachAt(0.25)).toBe(20);
    expect(reachAt(1)).toBe(5);
    expect(reachAt(2)).toBe(2.5);
    expect(reachAt(4)).toBe(2.25);
    // Where the two meet: 5 / 2.25 = 2.22, one step either side.
    expect(reachAt(2.2)).toBeCloseTo(5 / 2.2, 9);
    expect(reachAt(2.25)).toBe(2.25);
  });
});

describe('on recorded strokes, at 25%, 100% and 400%', () => {
  const zooms = [...new Set(GOS.map((g) => g.camera.z))].sort();

  it('the recorded gos cover the three zooms, slow and fast', () => {
    expect(zooms).toEqual([0.25, 1, 4]);
    expect(new Set(GOS.map((g) => g.speed))).toEqual(new Set(['slow', 'fast']));
  });

  for (const go of GOS) {
    it(`${go.name}: a click, a fast sweep and a slow one reach the ink one step inside the reach, and not one step outside`, () => {
      const z = go.camera.z;
      const ink = inkOf(go);
      const { where, shown } = boardWith([ink]);
      const things = erasables(where, shown, z);
      expect(things.map((t) => t.id)).toEqual(['ink']);
      const lines = centreOf(ink);
      // The reach past the centre line: the eraser's, and half the pen's width.
      const R = reachAt(z) + penWidth(PEN.size, z) / 2;
      for (const u of DIRECTIONS) {
        const e = furthest(lines, u);
        const across: XY = [-u[1], u[0]];
        const far = 400 / z;
        for (const [d, hits] of [
          [R - STEP, true],
          [R + STEP, false],
        ] as const) {
          const q = add(e, u, d);
          const want = hits ? ['ink'] : [];
          expect(reached([q], things, z), `a click ${d} away`).toEqual(want);
          // Two samples far apart, the line between them passing the ink at that distance.
          expect(reached([add(q, across, -far), add(q, across, far)], things, z), `a fast sweep ${d} away`).toEqual(want);
          // The same line, every 2 screen pixels, one sample and then four samples a frame.
          expect(slowSweep(add(q, across, -far), add(q, across, far), 2 / z, 1, things, z), `a slow sweep ${d} away`).toEqual(want);
          expect(slowSweep(add(q, across, -far), add(q, across, far), 2 / z, 4, things, z), `a slow sweep ${d} away, 4 a frame`).toEqual(want);
        }
      }
    });
  }

  for (const go of GOS.filter((g) => g.kind === 'line')) {
    it(`${go.name}: two samples far apart that cross the stroke between them reach it`, () => {
      const z = go.camera.z;
      const ink = inkOf(go);
      const { where, shown } = boardWith([ink]);
      const things = erasables(where, shown, z);
      const [line] = centreOf(ink);
      const mid = Math.floor(line!.length / 2);
      const [a, b] = [line![mid - 1]!, line![mid + 1]!];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n: XY = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
      const p = line![mid]!;
      const [one, two] = [add(p, n, 60 / z), add(p, n, -60 / z)];
      // Each sample alone is far from the ink.
      for (const s of [one, two]) {
        expect(distToPath(s[0], s[1], line!)).toBeGreaterThan(reachAt(z) + penWidth(PEN.size, z));
        expect(reached([s], things, z)).toEqual([]);
      }
      expect(reached([one, two], things, z)).toEqual(['ink']);
    });
  }
});

describe('what the eraser reaches on each kind of mark', () => {
  const at100 = (items: readonly Item[]) => {
    const { where, shown } = boardWith(items);
    return erasables(where, shown, 1);
  };

  it('a box on its border, which runs inside its edge, and not in its middle', () => {
    const things = at100([{ id: 'bx', kind: 'box', box: [100, 100, 200, 100] }]);
    // The border is 2.5 wide inside the edge: its line runs 1.25 in, 1.25 wide either side.
    const R = reachAt(1) + 1.25;
    expect(reached([[101.25 - R + STEP, 150]], things, 1)).toEqual(['bx']);
    expect(reached([[101.25 - R - STEP, 150]], things, 1)).toEqual([]);
    expect(reached([[101.25 + R - STEP, 150]], things, 1)).toEqual(['bx']);
    expect(reached([[101.25 + R + STEP, 150]], things, 1)).toEqual([]);
    expect(reached([[200, 150]], things, 1)).toEqual([]);
    // A sweep that stays inside reaches nothing; one across the border reaches it.
    expect(reached([[150, 130], [250, 170]], things, 1)).toEqual([]);
    expect(reached([[150, 150], [400, 150]], things, 1)).toEqual(['bx']);
  });

  it('exactly at the reach is reached: a click 6.25 from the border’s line at 100%', () => {
    const things = at100([{ id: 'bx', kind: 'box', box: [100, 100, 200, 100] }]);
    expect(reached([[95, 150]], things, 1)).toEqual(['bx']);
    expect(reached([[94.99, 150]], things, 1)).toEqual([]);
  });

  it('an arrow on its line, which is 3 screen pixels wide at any zoom', () => {
    for (const z of [0.25, 1, 4]) {
      const { where, shown } = boardWith([{ id: 'ar', kind: 'arrow', box: [0, 0, 200, 0], from: [0, 0], to: [200, 0] }]);
      const things = erasables(where, shown, z);
      const R = reachAt(z) + 1.5 / z;
      expect(reached([[100, R - STEP]], things, z), `at ${z}`).toEqual(['ar']);
      expect(reached([[100, R + STEP]], things, z), `at ${z}`).toEqual([]);
      expect(reached([[200 + R - STEP, 0]], things, z), `at ${z}`).toEqual(['ar']);
      expect(reached([[200 + R + STEP, 0]], things, z), `at ${z}`).toEqual([]);
    }
  });

  it('an arrow on the sides of its head too, where they stand clear of its line', () => {
    const { where, shown } = boardWith([{ id: 'ar', kind: 'arrow', box: [0, 0, 200, 0], from: [0, 0], to: [200, 0] }]);
    const things = erasables(where, shown, 4);
    const [side, tip] = headPoints([0, 0], [200, 0])!;
    // Three quarters of the way out along one side: further from the line than the eraser reaches at 400%.
    const p: XY = [tip[0] + 0.75 * (side[0] - tip[0]), tip[1] + 0.75 * (side[1] - tip[1])];
    expect(Math.abs(p[1])).toBeGreaterThan(reachAt(4) + 1.5 / 4 + STEP);
    expect(reached([p], things, 4)).toEqual(['ar']);
    // The box round the arrow holds its head: the quick first test must not leave it out.
    expect(things[0]!.bounds[1]).toBeLessThan(side[1]);
    // Past the end of that side, out of reach of it and of the line.
    expect(reached([[side[0] - 1, side[1] - 7]], things, 4)).toEqual([]);
  });

  it('an arrow where it is drawn now, its end joined to the thing it points at', () => {
    const b = openBoard();
    b.must('owner', note('n1', [300, -50, 100, 100]));
    b.must('owner', { type: 'item.add', chapter: CH, item: { id: 'ar', kind: 'arrow', box: [0, 0, 200, 0], from: [0, 0], to: [200, 0], toTarget: { item: 'n1' } } });
    // The note moved on: the arrow's end is drawn at its edge.
    b.must('owner', { type: 'item.update', item: 'n1', patch: { box: [300, 100, 100, 100] } });
    const things = erasables({ state: b.state, boxes: new Map(), subs: new Map() }, new Map([['ar', [0, 0, 200, 0] as Box]]), 1);
    // Its line runs from (0, 0) to the note's corner, (300, 100).
    expect(reached([[150, 50]], things, 1)).toEqual(['ar']);
    expect(reached([[200, 0]], things, 1)).toEqual([]);
  });

  it('a pin on its icon: inside it, or within reach of it', () => {
    const things = at100([
      { id: 'n1', kind: 'note', box: [300, 300, 100, 100], text: 'here' },
      { id: 'pn', kind: 'pin', box: [100, 100, 0, 0], at: [0, 0], on: { item: 'n1' } },
    ]);
    // The icon is 26 wide, drawn 13 left of the pin's point and 24 above it.
    expect(reached([[100, 90]], things, 1)).toEqual(['pn']);
    expect(reached([[87 - reachAt(1) + STEP, 90]], things, 1)).toEqual(['pn']);
    expect(reached([[87 - reachAt(1) - STEP, 90]], things, 1)).toEqual([]);
    expect(reached([[113 + reachAt(1) - STEP, 90]], things, 1)).toEqual(['pn']);
    expect(reached([[113 + reachAt(1) + STEP, 90]], things, 1)).toEqual([]);
    expect(reached([[100, 76 - reachAt(1) - STEP]], things, 1)).toEqual([]);
    expect(reached([[100, 102 + reachAt(1) + STEP]], things, 1)).toEqual([]);
    // A short sweep wholly inside the icon reaches it too.
    expect(reached([[98, 88], [102, 92]], things, 1)).toEqual(['pn']);
  });

  it('a pin whose point is off the corner of its box: the icon is drawn at the point', () => {
    const things = at100([
      { id: 'n1', kind: 'note', box: [300, 300, 100, 100], text: 'here' },
      { id: 'pn', kind: 'pin', box: [100, 100, 0, 0], at: [40, 20], on: { item: 'n1' } },
    ]);
    expect(reached([[140, 110]], things, 1)).toEqual(['pn']);
    expect(reached([[100, 90]], things, 1)).toEqual([]);
  });

  it('ink scaled with what it is anchored to: its line and its width are where they are drawn now', () => {
    const ink: InkItem = { id: 'ink', kind: 'ink', box: [0, 0, 100, 0], strokes: [{ pts: [0, 0, 100, 0], w: 4 }], targets: [], hint: 'none' };
    const { where } = boardWith([ink]);
    // Drawn twice as wide: its points twice as far apart, its width 1.41 times (`inkWidth`).
    const things = erasables(where, new Map([['ink', [50, 50, 200, 0] as Box]]), 1);
    const R = reachAt(1) + (4 * Math.SQRT2) / 2;
    expect(reached([[250 + R - STEP, 50]], things, 1)).toEqual(['ink']);
    expect(reached([[250 + R + STEP, 50]], things, 1)).toEqual([]);
    expect(reached([[150, 50 - R + STEP]], things, 1)).toEqual(['ink']);
    expect(reached([[150, 50 - R - STEP]], things, 1)).toEqual([]);
  });

  it('never a picture, a note, a file, a remark or a lasso: those go with Delete', () => {
    const b = openBoard();
    b.must('owner', note('n1', [0, 0, 200, 100]));
    b.must('agent', text('a1', { answers: ['n1'] }));
    b.must('owner', placeAt('a1', [0, 0, 200, 100]));
    b.must('owner', { type: 'item.add', chapter: CH, item: { id: 'f1', kind: 'file', box: [0, 0, 340, 60], name: 'a.txt', asset: 'assets/a.txt' } });
    b.must('owner', { type: 'item.add', chapter: CH, item: { id: 'v1', kind: 'voice', box: [0, 0, 320, 64], text: 'this one' } });
    b.must('owner', { type: 'item.add', chapter: CH, item: { id: 'l1', kind: 'lasso', box: [0, 0, 200, 100], path: [0, 0, 200, 0, 200, 100, 0, 100], targets: [{ item: 'n1' }] } });
    const shown = new Map<string, Box>(['n1', 'a1', 'f1', 'v1', 'l1'].map((id) => [id, [0, 0, 200, 100]]));
    const things = erasables({ state: b.state, boxes: new Map(), subs: new Map() }, shown, 1);
    expect(things).toEqual([]);
  });

  it('nothing that is not drawn, and nothing taken off the board', () => {
    const ink: InkItem = { id: 'ink', kind: 'ink', box: [0, 0, 100, 0], strokes: [{ pts: [0, 0, 100, 0] }], targets: [], hint: 'none' };
    const { b, where } = boardWith([ink]);
    expect(erasables(where, new Map(), 1)).toEqual([]);
    b.must('owner', { type: 'item.remove', item: 'ink' });
    expect(erasables({ ...where, state: b.state }, new Map([['ink', ink.box]]), 1)).toEqual([]);
  });

  it('a stroke the log keeps with no width is drawn at the pen’s', () => {
    const ink: InkItem = { id: 'ink', kind: 'ink', box: [0, 0, 100, 0], strokes: [{ pts: [0, 0, 100, 0] }], targets: [], hint: 'none' };
    const things = at100([ink]);
    const R = reachAt(1) + PEN.size / 2;
    expect(reached([[50, R - STEP]], things, 1)).toEqual(['ink']);
    expect(reached([[50, R + STEP]], things, 1)).toEqual([]);
  });

  it('a mark of several strokes is reached on any of them', () => {
    const ink: InkItem = { id: 'ink', kind: 'ink', box: [0, 0, 100, 100], strokes: [{ pts: [0, 0, 100, 0], w: 2 }, { pts: [0, 100, 100, 100], w: 2 }], targets: [], hint: 'none' };
    const things = at100([ink]);
    expect(reached([[50, 100 + reachAt(1)]], things, 1)).toEqual(['ink']);
    expect(reached([[50, 50]], things, 1)).toEqual([]);
  });

  it('one sweep reaches every mark it passes, in the order they are on the board', () => {
    const one: InkItem = { id: 'one', kind: 'ink', box: [0, 0, 0, 100], strokes: [{ pts: [0, 0, 0, 100], w: 2 }], targets: [], hint: 'none' };
    const two: InkItem = { id: 'two', kind: 'ink', box: [200, 0, 0, 100], strokes: [{ pts: [0, 0, 0, 100], w: 2 }], targets: [], hint: 'none' };
    const things = at100([one, two]);
    expect(reached([[-50, 50], [250, 50]], things, 1)).toEqual(['one', 'two']);
    expect(reached([[-50, 50], [100, 50]], things, 1)).toEqual(['one']);
  });
});

describe('how far apart two segments are', () => {
  it('none when they cross; else the nearest any end of one comes to the other', () => {
    expect(segmentsApart([0, 0], [10, 10], [0, 10], [10, 0])).toBe(0);
    expect(segmentsApart([0, 0], [10, 0], [0, 3], [10, 3])).toBe(3);
    expect(segmentsApart([0, 0], [10, 0], [12, 0], [20, 0])).toBe(2);
    // The nearest end is each of the four in turn.
    expect(segmentsApart([5, 4], [5, 20], [0, 0], [10, 0])).toBe(4);
    expect(segmentsApart([5, 20], [5, 4], [0, 0], [10, 0])).toBe(4);
    expect(segmentsApart([0, 0], [10, 0], [5, 4], [5, 20])).toBe(4);
    expect(segmentsApart([0, 0], [10, 0], [5, 20], [5, 4])).toBe(4);
    // Touching, and lying along each other: none.
    expect(segmentsApart([0, 0], [10, 0], [10, 0], [10, 10])).toBe(0);
    expect(segmentsApart([0, 0], [10, 0], [5, 0], [20, 0])).toBe(0);
    // A point is a segment of no length.
    expect(segmentsApart([5, 3], [5, 3], [0, 0], [10, 0])).toBe(3);
  });
});
