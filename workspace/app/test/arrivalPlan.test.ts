import { describe, expect, it } from 'vitest';
import type { Arrival, Beat, PlanInput, PlanPart } from '../src/arrival/plan';
import type { Box } from '@keel/protocol';
import { budgetFor, cursorAt, DRAW, easeOf, farCorner, movingMax, planArrival, planChip, planFinish, planRedraw, progress, PULL, restBy } from '../src/arrival/plan';
import type { Point } from '../src/motion/path';
import { distance, lengthOf } from '../src/motion/path';
import { APPROACH_MAX_MS, CURSOR_ENTER_MS, CURSOR_NUDGE_MS, FILL_AFTER_SHARE, REDRAW_RATE } from '../src/motion/timing';

/**
 * The plan of an arrival: pure, from a picture measured on the page. The pictures here are
 * written by hand, in board units, as `read.ts` would measure them.
 */

const part = (kind: PlanPart['kind'], depth = 1, extra: Partial<PlanPart> = {}): PlanPart => ({ kind, depth, dashed: false, ...extra });
const line = (length: number, depth = 1, dashed = false): PlanPart => part('line', depth, { dashed, length });

/** A text card answering a note to its left, as scene 1's: the card, its head, a paragraph and two questions. */
function card(extra: Partial<PlanInput> = {}): PlanInput {
  return {
    card: [400, 0, 380, 152],
    route: [
      [326, 60],
      [394, 60],
    ],
    cursor: [338, 70],
    parts: [part('frame', 0), part('head'), part('block'), part('block'), part('block')],
    zoom: 1,
    ...extra,
  };
}

/** A mini: the card, its head, four boxes, the three arrows between them, one dashed, and a label. */
function mini(): PlanInput {
  return {
    card: [400, 400, 540, 100],
    route: [
      [326, 450],
      [394, 450],
    ],
    cursor: [338, 456],
    parts: [part('frame', 0), part('head'), part('shape'), part('shape'), part('shape'), part('shape'), line(40), line(40), line(40, 1, true), part('label')],
    zoom: 1,
  };
}

/** A spread of three sheets, each with a head, two boxes, a line and a block. */
function spread(): PlanInput {
  const sheet = (): PlanPart[] => [part('frame'), part('head', 2), part('shape', 2), part('shape', 2), line(60, 2), part('block', 2)];
  return {
    card: [400, 600, 1050, 480],
    route: [
      [600, 520],
      [600, 594],
    ],
    cursor: [610, 510],
    parts: [part('frame', 0), part('head'), ...sheet(), ...sheet(), ...sheet()],
    zoom: 1,
  };
}

const ends = (b: { start: number; ms: number }) => b.start + b.ms;
const partBeats = (a: Arrival) => a.beats.filter((b): b is Beat & { part: number } => typeof b.part === 'number');
const pullOf = (a: Arrival) => a.beats.find((b) => b.part === 0)!;

/** The most beats moving at any start of one. */
function mostMoving(a: Arrival): number {
  return Math.max(...a.beats.map((b) => a.beats.filter((o) => o.start <= b.start && ends(o) > b.start).length));
}

/** The fastest a leg moves the cursor, in board units per ms: its length over its time, by its easing's steepest slope. */
function fastest(leg: Arrival['legs'][number]): number {
  const e = easeOf(leg.ease);
  let most = 0;
  for (let i = 0; i < 400; i++) most = Math.max(most, Math.abs(e((i + 1) / 400) - e(i / 400)) * 400);
  return (most * lengthOf(leg.path)) / Math.max(leg.ms, 1e-9);
}

describe('the plan of an arrival', () => {
  for (const [name, input] of [['a card', card()], ['a mini', mini()], ['a spread', spread()]] as const) {
    describe(`of ${name}`, () => {
      const a = planArrival(input);
      const pull = pullOf(a);
      const [cx, cy, cw, ch] = input.card;

      it('brings every part in once, the picture first, then the rest in the order it is drawn on', () => {
        const parts = partBeats(a);
        expect(parts.map((b) => b.part)).toEqual(input.parts.map((_, i) => i));
        for (let i = 1; i < parts.length; i++) expect(parts[i]!.start).toBeGreaterThanOrEqual(parts[i - 1]!.start);
      });

      it('fits its budget, from the cursor\'s first move to the last part in', () => {
        expect(a.total).toBeLessThanOrEqual(budgetFor(input.parts.length) + 1);
      });

      it('never moves more than a third of the parts at once', () => {
        expect(mostMoving(a)).toBeLessThanOrEqual(movingMax(input.parts.length));
      });

      it('is the same film every time it is planned from the same picture', () => {
        expect(planArrival(structuredClone(input))).toEqual(a);
      });

      it('has every progress exactly 0 at or before its start and exactly 1 at or past its end', () => {
        for (const x of [...a.beats, ...a.legs]) {
          expect(progress(x, x.start - 5)).toBe(0);
          expect(progress(x, x.start)).toBe(0);
          expect(progress(x, ends(x))).toBe(1);
          expect(progress(x, ends(x) + 5)).toBe(1);
        }
      });

      it('moves the cursor on one path that never jumps: a few legs, each from where and when the one before ended', () => {
        expect(a.legs.length).toBeLessThanOrEqual(3);
        for (let i = 1; i < a.legs.length; i++) {
          const [prev, leg] = [a.legs[i - 1]!, a.legs[i]!];
          expect(leg.start).toBeCloseTo(ends(prev), 9);
          expect(distance(prev.path.points[prev.path.points.length - 1]!, leg.path.points[0]!)).toBeLessThan(1e-9);
        }
        const legAt = (t: number) => [...a.legs].reverse().find((l) => l.start <= t) ?? a.legs[0]!;
        for (let t = -2; t < a.total + 2; t += 1) {
          const step = distance(cursorAt(a, t), cursorAt(a, t + 1));
          expect(step, `at ${t} ms`).toBeLessThanOrEqual(Math.max(fastest(legAt(t)), fastest(legAt(t + 1))) * 1.02 + 1e-6);
        }
      });

      it('draws the arrow under the cursor\'s tip', () => {
        const arrow = a.beats.find((b) => b.part === 'arrow')!;
        const leg = a.legs.find((l) => l.start === arrow.start)!;
        expect([leg.ms, leg.ease]).toEqual([arrow.ms, arrow.ease]);
        expect(leg.path.points).toEqual(input.route);
      });

      it('pulls the picture out from where the arrow ends once it is whole, with the cursor\'s tip on its far corner all the way', () => {
        const arrow = a.beats.find((b) => b.part === 'arrow')!;
        expect(pull.start).toBe(ends(arrow));
        expect(pull.ease).toEqual(PULL);
        const route = input.route!;
        const o = route[route.length - 1]!;
        expect(pull.pose).toEqual({ kind: 'pull', origin: [o[0] - cx, o[1] - cy] });
        const leg = a.legs.find((l) => l.start === pull.start)!;
        expect([leg.ms, leg.ease]).toEqual([pull.ms, pull.ease]);
        // The corner as the picture grows about `o`, and the cursor: never further apart than the gap at rest, scaled alike.
        const gap = distance([cx + cw, cy + ch], a.rest);
        for (let t = pull.start; t <= ends(pull); t += 5) {
          const s = easeOf(PULL)(Math.min(1, (t - pull.start) / pull.ms));
          const corner: Point = [o[0] + s * (cx + cw - o[0]), o[1] + s * (cy + ch - o[1])];
          expect(distance(cursorAt(a, t), corner), `at ${t} ms`).toBeCloseTo(s * gap, 6);
        }
      });

      it('fills nothing in before the picture is mostly out, and nothing waits on the cursor after it', () => {
        for (const b of partBeats(a)) if (b.part > 0) expect(b.start).toBeGreaterThanOrEqual(pull.start + pull.ms * FILL_AFTER_SHARE - 1e-9);
        expect(ends(a.legs[a.legs.length - 1]!)).toBe(ends(pull));
      });

      it('rests just outside the picture\'s bottom right corner, on nothing it shows, from the end of the pull', () => {
        expect(cursorAt(a, -10)).toEqual(input.cursor);
        expect(cursorAt(a, 0)).toEqual(input.cursor);
        expect(cursorAt(a, ends(pull))).toEqual(a.rest);
        expect(cursorAt(a, a.total)).toEqual(a.rest);
        expect(a.rest[0]).toBeGreaterThan(cx + cw);
        expect(a.rest[1]).toBeGreaterThan(cy + ch);
      });

      it('draws each solid line on by its dash, and fades a dashed one in', () => {
        for (const b of partBeats(a)) {
          const p = input.parts[b.part]!;
          if (p.kind !== 'line') continue;
          expect(b.pose).toEqual(p.dashed ? { kind: 'fade', from: expect.any(Number) } : { kind: 'draw', length: p.length });
        }
      });
    });
  }

  it('brings scene 1 to rest in under a second: something moves at once, and the arrow is a short stroke', () => {
    const a = planArrival(card());
    expect(a.legs[0]!.ms).toBe(CURSOR_NUDGE_MS);
    expect(a.total).toBeLessThan(1000);
    const arrow = a.beats.find((b) => b.part === 'arrow')!;
    expect(arrow.ms).toBeLessThan(220);
  });

  it('builds a spread a sheet at a time, inside about 2.4 s', () => {
    const input = spread();
    const a = planArrival(input);
    expect(a.total).toBeLessThanOrEqual(2400);
    const parts = partBeats(a);
    const sheets = parts.filter((b) => b.part > 0 && input.parts[b.part]!.kind === 'frame');
    expect(sheets).toHaveLength(3);
    // Every part of a sheet starts before the next sheet is set down.
    for (let k = 0; k + 1 < sheets.length; k++) {
      const within = parts.filter((b) => b.part > sheets[k]!.part && b.part < sheets[k + 1]!.part);
      for (const b of within) expect(b.start).toBeLessThan(sheets[k + 1]!.start);
    }
  });

  it('with no arrow, the cursor goes to the picture\'s top left corner and pulls it out from there', () => {
    const a = planArrival(card({ route: undefined, cursor: [200, 300] }));
    expect(a.beats.some((b) => b.part === 'arrow')).toBe(false);
    expect(a.legs[0]!.path.points[a.legs[0]!.path.points.length - 1]).toEqual([400, 0]);
    expect(pullOf(a).pose).toEqual({ kind: 'pull', origin: [0, 0] });
    expect(pullOf(a).start).toBe(ends(a.legs[0]!));
  });

  it('a far approach is quick, however far: the picture is there already', () => {
    const a = planArrival(card({ cursor: [-2000, 900] }));
    expect(a.legs[0]!.ms).toBe(APPROACH_MAX_MS);
  });

  it('a cursor not on the board comes in from the edge, over the time an entrance takes, and still leaves the picture half its budget', () => {
    const a = planArrival(card({ cursor: undefined, entry: [0, 60] }));
    expect(cursorAt(a, 0)).toEqual([0, 60]);
    expect(a.legs[0]!.ms).toBe(CURSOR_ENTER_MS);
    const penUp = ends(a.legs[1]!);
    expect(a.total).toBeLessThanOrEqual(Math.max(budgetFor(5), penUp + budgetFor(5) / 2) + 1);
  });

  it('a cursor nowhere at all is simply at the arrow\'s start', () => {
    const a = planArrival(card({ cursor: undefined }));
    expect(cursorAt(a, 0)).toEqual([326, 60]);
  });

  it('plays faster at a higher rate', () => {
    const slow = planArrival(card());
    const fast = planArrival(card({ rate: 2 }));
    expect(fast.total).toBeCloseTo(slow.total / 2, 0);
  });

  it('runs a picture with much on it faster, not longer', () => {
    const many: PlanInput = { ...card(), parts: [part('frame', 0), ...Array.from({ length: 60 }, () => part('block'))] };
    const a = planArrival(many);
    expect(a.total).toBeLessThanOrEqual(budgetFor(61) + 1);
    expect(mostMoving(a)).toBeLessThanOrEqual(movingMax(61));
  });

  it('throws for a picture with nothing to draw on', () => {
    expect(() => planArrival({ ...card(), parts: [] })).toThrow();
  });
});

/** What every film keeps, whatever its shape: once, in order; exact 0 and 1; one path with no jump, no faster than its easings. */
function keepsTheRules(a: Arrival, parts: number) {
  const ps = partBeats(a);
  for (let i = 1; i < ps.length; i++) expect(ps[i]!.start).toBeGreaterThanOrEqual(ps[i - 1]!.start);
  expect(new Set(ps.map((b) => b.part)).size).toBe(ps.length);
  for (const x of [...a.beats, ...a.legs]) {
    expect(progress(x, x.start)).toBe(0);
    expect(progress(x, ends(x))).toBe(1);
  }
  for (let i = 1; i < a.legs.length; i++) {
    expect(a.legs[i]!.start).toBeCloseTo(ends(a.legs[i - 1]!), 9);
    expect(distance(a.legs[i - 1]!.path.points[a.legs[i - 1]!.path.points.length - 1]!, a.legs[i]!.path.points[0]!)).toBeLessThan(1e-9);
  }
  const legAt = (t: number) => [...a.legs].reverse().find((l) => l.start <= t) ?? a.legs[0]!;
  for (let t = -2; t < a.total + 2; t += 1) {
    if (a.legs.length === 0) break;
    expect(distance(cursorAt(a, t), cursorAt(a, t + 1)), `at ${t} ms`).toBeLessThanOrEqual(Math.max(fastest(legAt(t)), fastest(legAt(t + 1))) * 1.02 + 1e-6);
  }
  expect(mostMoving(a)).toBeLessThanOrEqual(movingMax(parts));
  expect(cursorAt(a, a.total)).toEqual(a.rest);
}

describe('the plan of a placeholder finished', () => {
  const parts = card().parts;
  const from: Box = [400, 0, 360, 120];
  const to: Box = [400, 0, 380, 152];
  const input = { card: to, from, cursor: [748, 112] as Point, parts, zoom: 1 };

  it('pulls the picture from the rectangle it had to the one it has, the tip on the corner on a straight line', () => {
    const a = planFinish(input);
    keepsTheRules(a, parts.length);
    const pull = a.beats.find((b) => b.part === 0)!;
    expect(pull.pose).toEqual({ kind: 'reshape', move: [0, 0], scale: [360 / 380, 120 / 152] });
    expect(pull.ease).toEqual(PULL);
    const leg = a.legs.find((l) => l.start === pull.start)!;
    expect([leg.ms, leg.ease]).toEqual([pull.ms, pull.ease]);
    // The cursor first goes to the placeholder's corner, and pulls from there.
    expect(cursorAt(a, pull.start)).toEqual(restBy(from, 1));
    for (let t = pull.start; t <= ends(pull); t += 5) {
      const e = easeOf(PULL)(Math.min(1, (t - pull.start) / pull.ms));
      // The root's corner, moved and scaled about its top left: `to`'s corner, on the eased share.
      const { scale } = pull.pose as { scale: Point };
      const corner: Point = [to[0] + ((1 - e) * scale[0] + e) * to[2], to[1] + ((1 - e) * scale[1] + e) * to[3]];
      expect(distance(cursorAt(a, t), corner), `at ${t} ms`).toBeCloseTo(Math.SQRT2 * 8, 6);
    }
    for (const b of partBeats(a)) if (b.part > 0) expect(b.start).toBeGreaterThanOrEqual(pull.start + pull.ms * FILL_AFTER_SHARE - 1e-9);
    expect(a.total).toBeLessThanOrEqual(budgetFor(parts.length) + 1);
  });

  it('a picture with no paper of its own fills from the start of the pull, so something is pulled; one with paper waits until it is mostly out', () => {
    for (const paper of [false, true]) {
      const a = planFinish({ ...input, paper });
      keepsTheRules(a, parts.length);
      const pull = a.beats.find((b) => b.part === 0)!;
      const first = Math.min(...partBeats(a).filter((b) => b.part > 0).map((b) => b.start));
      expect(first, paper ? 'with paper' : 'with no paper').toBeCloseTo(paper ? pull.start + pull.ms * FILL_AFTER_SHARE : pull.start, 6);
    }
  });

  it('a placeholder that moved too: the root is moved back to where it was, and goes on the straight line from there', () => {
    const a = planFinish({ ...input, from: [100, 300, 360, 120] });
    const pull = a.beats.find((b) => b.part === 0)!;
    expect(pull.pose).toEqual({ kind: 'reshape', move: [-300, 300], scale: [360 / 380, 120 / 152] });
    const leg = a.legs.find((l) => l.start === pull.start)!;
    expect(leg.path.points).toEqual([restBy([100, 300, 360, 120], 1), restBy(to, 1)]);
  });

  it('when the rectangle did not change by more than a pixel: no pull, the cursor at the corner, only the fill', () => {
    const a = planFinish({ ...input, from: [400.4, 0, 380.5, 152] });
    keepsTheRules(a, parts.length);
    expect(a.beats.some((b) => b.part === 0)).toBe(false);
    expect(a.legs.every((l) => l.ease !== PULL)).toBe(true);
    expect(a.rest).toEqual(restBy(to, 1));
  });
});

describe('the plan of a redraw', () => {
  const input = { card: [400, 0, 380, 152] as Box, cursor: [752, 134] as Point, parts: card().parts, zoom: 1 };

  it('leaves the paper as it is: the cursor nudges out to the corner, and what is on it comes in again, faster', () => {
    const a = planRedraw(input);
    keepsTheRules(a, input.parts.length);
    expect(a.beats.some((b) => b.part === 0 || b.part === 'arrow')).toBe(false);
    expect(partBeats(a).map((b) => b.part)).toEqual([1, 2, 3, 4]);
    expect(a.legs).toHaveLength(1);
    expect(a.legs[0]!.ms).toBe(CURSOR_NUDGE_MS);
    expect(partBeats(a)[0]!.start).toBe(ends(a.legs[0]!));
    const arrived = planArrival(card());
    const fillOf = (x: Arrival) => ends(partBeats(x)[partBeats(x).length - 1]!) - partBeats(x).find((b) => b.part === 1)!.start;
    expect(fillOf(a)).toBeCloseTo(fillOf(arrived) / REDRAW_RATE, 6);
    expect(a.total).toBeLessThan(600);
  });
});

describe('the plan of a read chip', () => {
  const chip: Box = [100, 200, 300, 28];
  const input = { chip, cursor: [80, 228] as Point, zoom: 1 };

  it('writes the chip in from the left under the tip, on its lower edge, and rests just past its right end', () => {
    const a = planChip(input);
    keepsTheRules(a, 1);
    const write = a.beats[0]!;
    expect(a.beats).toHaveLength(1);
    expect(write).toMatchObject({ part: 0, pose: { kind: 'write' }, ease: DRAW });
    const leg = a.legs.find((l) => l.start === write.start)!;
    expect([leg.ms, leg.ease]).toEqual([write.ms, write.ease]);
    expect(leg.path.points).toEqual([
      [100, 228],
      [400, 228],
    ]);
    // The tip is where the chip is written to, all the way.
    for (let t = write.start; t <= ends(write); t += 5) expect(cursorAt(a, t)[0]).toBeCloseTo(100 + 300 * progress(write, t), 6);
    expect(a.rest[0]).toBeGreaterThan(400);
    expect(a.rest[1]).toBe(228);
    expect(a.total).toBeLessThan(700);
  });
});

describe('the corner the cursor pulls by', () => {
  const box: Box = [400, 0, 380, 152];
  const [l, t, r, b] = [400, 0, 780, 152];
  /** For an arrow ending at `o`, which corner, by its two sides. */
  const cases: Array<[string, Point, Point]> = [
    ['from the left', [l, 76], [r, b]],
    ['from above', [590, t], [r, b]],
    ['from the right', [r, 76], [l, b]],
    ['from below', [590, b], [r, t]],
    ['at the top left', [l, t], [r, b]],
    ['at the top right', [r, t], [l, b]],
    // The top right is farther, by less than a fifth: the bottom right.
    ['at the bottom left', [l, b], [r, b]],
    // The bottom left is farther than the bottom right by a hair: the bottom right.
    ['a little off the middle of the top edge', [600, t], [r, b]],
    ['near the top right corner', [770, t], [l, b]],
    ['on the right edge, low', [r, 120], [l, b]],
    ['at the bottom right', [r, b], [l, b]],
  ];
  for (const [name, o, corner] of cases) {
    it(`an arrow ending ${name} has the cursor ride the corner a hand drags, never the top left, and rest just outside it`, () => {
      expect(farCorner(box, o, 1).corner).toEqual(corner);
      const a = planArrival({ ...card(), card: box, route: [[o[0] - 30, o[1] - 30], o] });
      keepsTheRules(a, card().parts.length);
      const away = (v: number, edge: number) => Math.sign(v - edge);
      expect([away(a.rest[0], corner[0]), away(a.rest[1], corner[1])]).toEqual([corner[0] === r ? 1 : -1, corner[1] === b ? 1 : -1]);
      const pull = pullOf(a);
      const gap = distance(corner, a.rest);
      for (let ms = pull.start; ms <= ends(pull); ms += 5) {
        const s = easeOf(PULL)(Math.min(1, (ms - pull.start) / pull.ms));
        const at: Point = [o[0] + s * (corner[0] - o[0]), o[1] + s * (corner[1] - o[1])];
        expect(distance(cursorAt(a, ms), at), `at ${ms} ms`).toBeCloseTo(s * gap, 6);
      }
    });
  }

  it('with no arrow, the bottom right, as from the top left', () => {
    expect(planArrival({ ...card(), route: undefined }).rest).toEqual(restBy([400, 0, 380, 152], 1));
  });
});
