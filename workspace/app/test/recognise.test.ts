import type { Box, InkHint } from '@keel/protocol';
import { describe, expect, it } from 'vitest';
import type { Pt, TargetRect, XY } from '../src/geometry';
import { readInk, underTargets } from '../src/geometry';
import { isClosedLoop, isCross, isFlat, isStraight, lie, readHint, resample } from '../src/ink/recognise';
import { drawing, oneStroke } from '../src/ink/stroke';
import {
  CROSS_MAX_BEND,
  CROSS_MIDDLE,
  CROSS_MIN_DEG,
  CROSS_MIN_LENGTH,
  LINE_MAX_BACK,
  LINE_MAX_BEND,
  LINE_MAX_BOW,
  LINE_MIN_LENGTH,
  LOOP_MAX_GAP,
  LOOP_MIN_ASPECT,
  LOOP_MIN_DIAGONAL,
  LOOP_MIN_ROUND,
  LOOP_MIN_TURN,
  READ_POINTS,
  TIP_SHARE,
  TURN_SPAN,
  UNDER_ACROSS,
  UNDER_GAP,
  UNDER_INTO,
  UNDER_INTO_SHARE,
} from '../src/input/constants';
import { inkItem, splitGo } from '../src/marks';
import hands from './fixtures/hands.json';

/**
 * Reading ink: what a stroke is, however fast and at whatever zoom it was drawn, and that one
 * go of the pen is cut into marks from the very points each mark is then read from.
 *
 * The strokes of `fixtures/hands.json` were played into the real Chrome by a model of a hand
 * (see `e2e/ink-hands.ts`, which made them): a mouse and a trackpad, fast and slow, at three
 * zooms. The rest are drawn here by formula, where a rule needs a stroke one step either side
 * of a limit.
 */

type Px = readonly [x: number, y: number];

/** The three zooms every rule is held at. */
const ZOOMS = [0.25, 1, 4] as const;

/** Points given in screen pixels, as board units at a zoom. */
const at = (px: readonly Px[], zoom: number): XY[] => px.map(([x, y]) => [x / zoom, y / zoom] as const);

const line = (a: Px, b: Px, n = 24): Px[] => Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n] as const);

/** The outline of a box, drawn round once from its corner and back to it. */
const boxLoop = (w: number, h: number): Px[] => [[100, 100], [100 + w, 100], [100 + w, 100 + h], [100, 100 + h], [100, 100]];

const distance = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/* ------------------------------------------------------------------ recorded hands */

interface Go {
  name: string;
  kind: 'circle' | 'cross' | 'line' | 'scribble';
  device: 'mouse' | 'trackpad';
  speed: 'fast' | 'slow';
  camera: { x: number; y: number; z: number };
  strokes: Array<{ ms: number; events: number[]; at: number[] }>;
}
const GOS = hands.gos as Go[];

/** What each kind of go is read as. A line is an underline when it is level; whether something sits above it is the board's to say. */
const READS: Record<Go['kind'], InkHint> = { circle: 'circle', cross: 'cross', line: 'underline', scribble: 'none' };

/** A recorded stroke's samples in board units, by the camera it was drawn under. */
function samplesOf(go: Go, flat: readonly number[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([(flat[i]! - go.camera.x) / go.camera.z, (flat[i + 1]! - go.camera.y) / go.camera.z, 0.5]);
  return out;
}

/** The strokes of a recorded go as the pen keeps them: thinned as the samples arrive, and closed if they are a loop. */
function keptBy(go: Go): Pt[][] {
  return go.strokes.map((s) => {
    const [first, ...rest] = samplesOf(go, s.at);
    const stroke = drawing(first!, go.camera.z);
    stroke.add(rest);
    stroke.lift();
    return [...stroke.pts];
  });
}

describe('recorded hands are read as what they drew', () => {
  it('the recording holds every kind, from both devices, at both speeds, at all three zooms', () => {
    const seen = new Set(GOS.map((g) => `${g.kind} ${g.device} ${g.speed} ${g.camera.z}`));
    expect(seen.size).toBe(4 * 2 * 2 * 3);
    expect(GOS).toHaveLength(48);
    expect([...new Set(GOS.map((g) => g.camera.z))]).toEqual([...ZOOMS]);
    // A fast stroke is a few dozen samples far apart; a slow one is hundreds, close together.
    for (const g of GOS) for (const s of g.strokes) expect(s.at.length / 2, g.name).toBeGreaterThan(g.speed === 'slow' ? 60 : 8);
  });

  it.each(GOS.map((g) => [g.name, g] as const))('%s', (_name, go) => {
    expect(readHint(keptBy(go), go.camera.z)).toBe(READS[go.kind]);
  });

  it('the samples as they came read the same as the points the pen kept of them', () => {
    for (const go of GOS) {
      const raw = go.strokes.map((s) => samplesOf(go, s.at));
      expect(readHint(raw, go.camera.z), go.name).toBe(READS[go.kind]);
    }
  });

  it('a cross is two strokes, and each of the other kinds is one', () => {
    for (const go of GOS) expect(go.strokes, go.name).toHaveLength(go.kind === 'cross' ? 2 : 1);
  });
});

/* ------------------------------------------------------------------ the speed of the hand */

describe('a stroke is read from points spaced evenly along it', () => {
  it('64 of them, the first and the last where the stroke begins and ends, the same distance apart along the path', () => {
    const path = at([[0, 0], [30, 0], [30, 40], [90, 40], [90, 0]], 1);
    const pts = resample(path);
    expect(pts).toHaveLength(READ_POINTS);
    expect(pts[0]).toEqual([0, 0]);
    expect(pts.at(-1)).toEqual([90, 0]);
    // 170 long, in 63 equal steps: each is a straight piece, but for the few that turn a corner.
    const steps = pts.slice(1).map((p, i) => distance(p, pts[i]!));
    const step = 170 / (READ_POINTS - 1);
    expect(steps.filter((s) => Math.abs(s - step) < 1e-9).length).toBeGreaterThanOrEqual(READ_POINTS - 1 - 3);
    expect(Math.max(...steps)).toBeLessThanOrEqual(step + 1e-9);
  });

  it('where the hand crowded its samples makes no difference', () => {
    const ring = (i: number, n: number): Px => [400 + 90 * Math.cos((i / n) * 2 * Math.PI), 300 + 60 * Math.sin((i / n) * 2 * Math.PI)];
    const even = Array.from({ length: 41 }, (_, i) => ring(i, 40));
    // The same ring: 600 samples in its first quarter, and 9 in all the rest.
    const crowded = [...Array.from({ length: 600 }, (_, i) => ring(i, 2400)), ...Array.from({ length: 10 }, (_, i) => ring(10 + (i * 30) / 9, 40))];
    const [a, b] = [resample(at(even, 1)), resample(at(crowded, 1))];
    // Each read point of one lies within a few pixels of its fellow on the other.
    expect(Math.max(...a.map((p, i) => distance(p, b[i]!)))).toBeLessThan(8);
    expect(readHint([at(even, 1)])).toBe('circle');
    expect(readHint([at(crowded, 1)])).toBe('circle');
  });

  it('a slow loop, a sample every pixel, is a loop; so is a fast one of seven samples', () => {
    const slow = Array.from({ length: 315 }, (_, i): Px => [300 + Math.round(50 * Math.cos(i / 50)), 300 + Math.round(50 * Math.sin(i / 50))]);
    const fast = Array.from({ length: 7 }, (_, i): Px => [300 + 50 * Math.cos((i / 6) * 2 * Math.PI), 300 + 50 * Math.sin((i / 6) * 2 * Math.PI)]);
    expect(isClosedLoop(at(slow, 1))).toBe(true);
    expect(isClosedLoop(at(fast, 1))).toBe(true);
  });

  it('a wobbling hand still draws a straight line: its path is long, but it never strays', () => {
    // A level line 200 px long, a pixel up and a pixel down at every sample: twice as long as its chord.
    const wobbly = Array.from({ length: 201 }, (_, i): Px => [100 + i, 300 + (i % 2 === 0 ? 1 : -1)]);
    expect(isStraight(at(wobbly, 1))).toBe(true);
    expect(readHint([at(wobbly, 1)])).toBe('underline');
  });

  it('no stroke reads as nothing, and a stroke that goes nowhere is one point', () => {
    expect(resample([])).toEqual([]);
    expect(resample([[5, 5], [5, 5], [5, 5]])).toEqual([[5, 5]]);
    expect(readHint([[[5, 5], [5, 5], [5, 5]]])).toBe('none');
    expect(readHint([])).toBe('none');
  });
});

/* ------------------------------------------------------------------ sizes are judged on screen */

describe('how big a stroke is, is judged in screen pixels', () => {
  it.each(ZOOMS)('at zoom %s a loop 25 px from corner to corner is a loop, and one of 23 px is too small', (zoom) => {
    expect(LOOP_MIN_DIAGONAL).toBe(24);
    expect(isClosedLoop(at(boxLoop(20, 15), zoom), zoom)).toBe(true);
    expect(isClosedLoop(at(boxLoop(18.4, 13.8), zoom), zoom)).toBe(false);
  });

  it.each(ZOOMS)('at zoom %s a level line of 21 px can underline, and one of 19 px is too short', (zoom) => {
    expect(LINE_MIN_LENGTH).toBe(20);
    expect(readHint([at(line([100, 100], [121, 100]), zoom)], zoom)).toBe('underline');
    expect(readHint([at(line([100, 100], [119, 100]), zoom)], zoom)).toBe('none');
  });

  it.each(ZOOMS)('at zoom %s two strokes of 17 px make a cross, and two of 15 px are too short', (zoom) => {
    expect(CROSS_MIN_LENGTH).toBe(16);
    /** An X whose strokes are each `len` long, at right angles. */
    const cross = (len: number): XY[][] => {
      const h = len / 2 / Math.SQRT2;
      return [at(line([200 - h, 200 - h], [200 + h, 200 + h]), zoom), at(line([200 + h, 200 - h], [200 - h, 200 + h]), zoom)];
    };
    expect(readHint(cross(17), zoom)).toBe('cross');
    expect(readHint(cross(15), zoom)).toBe('none');
  });

  it('the same ink reads by the zoom it was drawn at: a small ring drawn far in is a circle, and far out it is too small to be one', () => {
    // 8 board units across: 32 px on screen at 400%, 2 px at 25%.
    const ring = Array.from({ length: 41 }, (_, i): XY => [50 + 4 * Math.cos((i / 40) * 2 * Math.PI), 50 + 4 * Math.sin((i / 40) * 2 * Math.PI)]);
    expect(readHint([ring], 4)).toBe('circle');
    expect(readHint([ring], 1)).toBe('none');
    expect(readHint([ring], 0.25)).toBe('none');
  });
});

describe('what an underline is under is judged on screen', () => {
  /** A word 200 px wide whose bottom edge is at y 300 on screen, and as tall as given, in board units at a zoom. */
  const word = (zoom: number, tall = 40): TargetRect[] => [{ id: 'w', item: 'w', box: [100 / zoom, (300 - tall) / zoom, 200 / zoom, tall / zoom] }];
  /** A level line under it, `below` px under its bottom edge on screen (less than 0 runs up into it), `wide` px across from its left. */
  const under = (zoom: number, below: number, wide = 200): XY[] => at(line([100, 300 + below], [100 + wide, 300 + below]), zoom);

  it.each(ZOOMS)('at zoom %s a line 27 px below a word is under it, and one 29 px below is not', (zoom) => {
    expect(UNDER_GAP).toBe(28);
    expect(underTargets(under(zoom, 27), word(zoom), zoom)).toEqual(['w']);
    expect(underTargets(under(zoom, 29), word(zoom), zoom)).toEqual([]);
  });

  it.each(ZOOMS)('at zoom %s a line may run 13 px up into a tall word, and not 15 px', (zoom) => {
    expect(UNDER_INTO).toBe(14);
    expect(underTargets(under(zoom, -13), word(zoom), zoom)).toEqual(['w']);
    expect(underTargets(under(zoom, -15), word(zoom), zoom)).toEqual([]);
  });

  it('into a short word, a line may run a step less than half its height, and not a step more', () => {
    expect(UNDER_INTO_SHARE).toBe(0.5);
    expect(underTargets(under(1, -9), word(1, 20))).toEqual(['w']);
    expect(underTargets(under(1, -11), word(1, 20))).toEqual([]);
  });

  it('the line and the word share a step more than half the shorter one, or it is not under it', () => {
    expect(UNDER_ACROSS).toBe(0.5);
    // A line 100 px long from x 200 to 300 shares 100 px with the word; moved right, less.
    const shifted = (by: number) => at(line([200 + by, 310], [300 + by, 310]), 1);
    expect(underTargets(shifted(49), word(1))).toEqual(['w']);
    expect(underTargets(shifted(51), word(1))).toEqual([]);
  });

  it('a stroke drawn far out reads a line as under a word as it looked on screen: at 25%, 28 board units are 7 px', () => {
    // 20 board units below the word: 5 px on screen at 25%, 80 px at 400%.
    const target: TargetRect[] = [{ id: 'w', item: 'w', box: [0, 0, 400, 40] }];
    const stroke = line([0, 60], [400, 60]);
    expect(readInk([stroke], target, 0.25)).toMatchObject({ hint: 'underline', targets: ['w'] });
    expect(readInk([stroke], target, 4)).toMatchObject({ hint: 'none' });
  });
});

/* ------------------------------------------------------------------ straightness */

/** A tent: up from one end of a level chord `len` long and down to the other, its path `bend` times the chord. Too far off its chord to keep to it. */
const tent = (bend: number, len = 200): Px[] => {
  const h = len * Math.sqrt((bend / 2) ** 2 - 0.25);
  return Array.from({ length: 101 }, (_, i) => [100 + (len * i) / 100, 300 - h * (1 - Math.abs(i - 50) / 50)] as const);
};

/** A level wave `len` long, `waves` times up and down by `amp`: a path far longer than its chord. */
const wave = (amp: number, waves = 10, len = 200, n = 2000): Px[] =>
  Array.from({ length: n + 1 }, (_, i) => [100 + (len * i) / n, 300 + amp * Math.sin((2 * Math.PI * waves * i) / n)] as const);

describe('a straight stroke is smooth, or it keeps to its chord with its tips left out', () => {
  it.each(ZOOMS)('at zoom %s a stroke whose path is a step under 1.25 times its chord is straight, and a step over is not', (zoom) => {
    expect(LINE_MAX_BEND).toBe(1.25);
    const [under, over] = [lie(tent(1.24))!, lie(tent(1.26))!];
    // The tents are too far off their chords to keep to them: only how smooth they are decides.
    expect([under.bend, over.bend].map((b) => b < LINE_MAX_BEND)).toEqual([true, false]);
    expect(Math.min(under.bow, over.bow)).toBeGreaterThan(LINE_MAX_BOW);
    expect(isStraight(at(tent(1.24), zoom), zoom)).toBe(true);
    expect(isStraight(at(tent(1.26), zoom), zoom)).toBe(false);
  });

  it('a stroke of a cross may bend more: a step under 1.35 times its chord crosses, a step over does not', () => {
    expect(CROSS_MAX_BEND).toBe(1.35);
    const upright = at(line([200, 180], [200, 420]), 1);
    // Read from its 64 points, a tent drawn 1.355 times its chord measures 1.349, and one drawn 1.36 measures 1.354.
    const [under, over] = [lie(tent(1.355))!.bend, lie(tent(1.36))!.bend];
    expect(under).toBeGreaterThan(CROSS_MAX_BEND - 0.005);
    expect([under, over].map((b) => b < CROSS_MAX_BEND)).toEqual([true, false]);
    expect(isStraight(at(tent(1.3), 1))).toBe(false);
    expect(isCross(at(tent(1.355), 1), upright)).toBe(true);
    expect(isCross(at(tent(1.36), 1), upright)).toBe(false);
  });

  it.each(ZOOMS)('at zoom %s a wobbling stroke that strays a step less than 15% from its chord is straight, and a step more is not', (zoom) => {
    expect(LINE_MAX_BOW).toBe(0.15);
    const [near, far] = [lie(wave(16))!, lie(wave(18))!];
    expect(near.bow).toBeCloseTo(0.143, 3);
    expect(far.bow).toBeCloseTo(0.16, 3);
    // Both wobble far too much to be smooth.
    expect(Math.min(near.bend, far.bend)).toBeGreaterThan(3);
    expect(isStraight(at(wave(16), zoom), zoom)).toBe(true);
    expect(isStraight(at(wave(18), zoom), zoom)).toBe(false);
  });

  it('between its tips, a stroke may come back along its chord a step less than 5% of it, and a step more is a scratch', () => {
    expect(LINE_MAX_BACK).toBe(0.05);
    /** A wobbling line 400 long that goes back `x` in its middle, and on again. */
    const zag = (x: number): XY[] => {
      const half = wave(4, 20, 200, 1000);
      return at([...half, ...line([300, 300], [300 - x, 300], 40).slice(1), ...half.map(([px, py]) => [px + 200 - x, py] as const).slice(1)], 1);
    };
    const [less, more] = [lie(zag(12))!, lie(zag(24))!];
    expect(less.back).toBeCloseTo(0.043, 3);
    expect(more.back).toBeCloseTo(0.062, 3);
    expect(Math.min(less.bend, more.bend)).toBeGreaterThan(LINE_MAX_BEND);
    expect(isStraight(zag(12))).toBe(true);
    expect(isStraight(zag(24))).toBe(false);
  });

  it('each tip is 9 of the 63 steps between read points, 15% of the path taken to a whole read point: a flick back that ends in it leaves a line, and one a read point longer does not', () => {
    expect(Math.round(TIP_SHARE * (READ_POINTS - 1))).toBe(9);
    /** A line wobbling 5 px either side 30 times, and a flick back along it as the hand lifts, `steps` read points long. */
    const flicked = (steps: number) => {
      const body = wave(5, 30);
      const len = body.slice(1).reduce((sum, p, i) => sum + distance(p, body[i]!), 0);
      const [x, y] = body.at(-1)!;
      return at([...body, ...line([x, y], [x - (steps * len) / (READ_POINTS - 1 - steps), y], 40).slice(1)], 1);
    };
    expect(lie(flicked(8.9))!.back).toBe(0);
    expect(readHint([flicked(8.9)])).toBe('underline');
    // A read point longer, the flick reaches past the tip: the line comes back along its chord further than a line may.
    expect(lie(flicked(9.9))!.back).toBeGreaterThan(LINE_MAX_BACK);
    expect(readHint([flicked(9.9)])).toBe('none');
  });

  it('a hook as the hand lifts or lands is forgiven, and a longer one is a bend', () => {
    const base = 200;
    /** A level line, then a hook straight up at its end, `share` of the line long. */
    const hooked = (share: number) => at([...line([100, 300], [100 + base, 300], 100), ...line([100 + base, 300], [100 + base, 300 - share * base], 20).slice(1)], 1);
    // A short hook sits at the end of the chord, so it is never far from it.
    expect(isStraight(hooked(0.09))).toBe(true);
    expect(readHint([hooked(0.09)])).toBe('underline');
    // A long one pulls the corner far off the chord: the stroke is a bent one.
    expect(isStraight(hooked(0.4))).toBe(false);
    // The same as the hand lands.
    const landed = at([...line([108, 292], [100, 300], 10), ...line([100, 300], [300, 300], 100).slice(1)], 1);
    expect(isStraight(landed)).toBe(true);
    expect(readHint([landed])).toBe('underline');
  });

  it('a stroke that turns back on itself is not straight, however near its chord it stays', () => {
    // A scratch along a row: there, back, and there again, 4 px apart. Level, thin, and no underline.
    const scratch = at([...line([100, 300], [300, 298], 60), ...line([300, 298], [110, 302], 60).slice(1), ...line([110, 302], [310, 304], 60).slice(1)], 1);
    expect(isStraight(scratch)).toBe(false);
    expect(readHint([scratch])).toBe('none');
  });

  it('a straight stroke underlines only when it runs across', () => {
    const steep = at(line([100, 100], [160, 260]), 1);
    expect(isStraight(steep)).toBe(true);
    expect(isFlat(steep)).toBe(false);
    expect(readHint([steep])).toBe('none');
  });

  it('a stroke that goes nowhere has no lie, and is not straight', () => {
    expect(lie([[5, 5], [5, 5]])).toBeUndefined();
    expect(isStraight([[5, 5], [5, 5]])).toBe(false);
  });
});

/* ------------------------------------------------------------------ each check, either side */

/** A path through corners, a sample every 2 px or so along each side. */
const through = (...corners: Px[]): Px[] => corners.slice(1).flatMap((c, i) => line(corners[i]!, c, Math.max(2, Math.round(distance(corners[i]!, c) / 2))).slice(i === 0 ? 0 : 1));

/**
 * An alpha: from where it will cross itself, down and right at `deg` below level, round a loop,
 * back across its start, and on out along the mirror image of the way in, bending on round the
 * loop's way by `bend` degrees. Closing it undoes its turn, so only how far it turns on the way
 * decides whether it is a loop.
 */
function alpha(deg: number, bend: number): Px[] {
  const th = (deg * Math.PI) / 180;
  const [a, tail] = [20, 15];
  // The loop is a circle that meets the way in and the way out along their lines, a units from where they cross.
  const [r, cx] = [a * Math.tan(th), a / Math.cos(th)];
  const at0 = Math.atan2(-a * Math.sin(th), a * Math.cos(th) - cx);
  const turn = Math.PI + 2 * th;
  const out: Px[] = [];
  const put = (x: number, y: number) => out.push([300 + x, 300 - y]);
  for (let i = 0; i <= 30; i++) put(((a * i) / 30) * Math.cos(th), -((a * i) / 30) * Math.sin(th));
  for (let i = 1; i <= 200; i++) put(cx + r * Math.cos(at0 + (turn * i) / 200), r * Math.sin(at0 + (turn * i) / 200));
  let [x, y] = out.at(-1)!;
  let heading = Math.atan2(Math.sin(th), -Math.cos(th));
  for (let i = 1; i <= 40; i++) {
    heading -= (bend * Math.PI) / 180 / 40;
    [x, y] = [x + ((a + tail) / 40) * Math.cos(heading), y + ((a + tail) / 40) * Math.sin(heading)];
    out.push([x, y]);
  }
  return out;
}

describe('each check of a loop and of a cross has a stroke on either side of its limit that only it decides', () => {
  it('a loop is not too thin: out along a row and back 3 px under it is a loop 56 px long, and not 64 px long', () => {
    expect(LOOP_MIN_ASPECT).toBe(0.05);
    // 3 px over 56 is 0.054; over 64 it is 0.047.
    const thin = (long: number) => at(through([100, 100], [100 + long, 100], [100 + long, 103], [100, 103]), 1);
    expect(readHint([thin(56)])).toBe('circle');
    expect(readHint([thin(64)])).toBe('none');
  });

  it('a loop goes round: a flat loop three quarters done is one, and a few degrees short of that it is not', () => {
    expect(LOOP_MIN_ROUND).toBe(1.5);
    /** From the left tip of a loop 200 by 20, along the bottom, round the right tip, and back along the top by `deg` degrees in all. */
    const flat = (deg: number) => at(dense((t) => [300 + 100 * Math.cos(Math.PI - (t * deg * Math.PI) / 180), 300 + 10 * Math.sin(Math.PI - (t * deg * Math.PI) / 180)], 300), 1);
    // Its path is 1.51 times its diagonal at 270 degrees, and 1.47 times at 265.
    expect(readHint([flat(270)])).toBe('circle');
    expect(readHint([flat(265)])).toBe('none');
  });

  it('a loop comes back: a ring that stops 40 degrees short is one, and 44 degrees short it is not', () => {
    expect(LOOP_MAX_GAP).toBe(0.25);
    // The gap is 0.24 of its diagonal at 320 degrees, and 0.26 at 316.
    expect(readHint([at(sweep(320, 40, 40), 1)])).toBe('circle');
    expect(readHint([at(sweep(316, 40, 40), 1)])).toBe('none');
  });

  it('a loop turns most of the way round, counted to its last point: an alpha that turns 0.806 of a turn is one, and 0.795 is not', () => {
    expect([LOOP_MIN_TURN, TURN_SPAN]).toEqual([0.8, 3]);
    // Its out tail bends 45 degrees on; the last read point of it holds the last hundredth of a turn.
    expect(readHint([at(alpha(34, 45), 1)])).toBe('circle');
    expect(readHint([at(alpha(32, 45), 1)])).toBe('none');
  });

  /** An X whose second stroke crosses the first `along` of the way from its start, at its own middle. */
  const meetingAt = (along: number): XY[][] => {
    const m = 100 + 100 * along;
    return [at(line([100, 100], [200, 200]), 1), at(line([m - 30, m + 30], [m + 30, m - 30]), 1)];
  };

  it('two strokes cross near their middles: 0.17 of the way along one is near enough, and 0.13 is a T', () => {
    expect(CROSS_MIDDLE).toBe(0.15);
    expect(readHint(meetingAt(0.17))).toBe('cross');
    expect(readHint(meetingAt(0.13))).toBe('none');
  });

  it('two strokes cross at an angle: 5 degrees apart is an X, and 3 degrees is two lines on top of each other', () => {
    expect(CROSS_MIN_DEG).toBe(4);
    const apart = (deg: number): XY[][] => {
      const r = (deg * Math.PI) / 180;
      return [at(line([100, 100], [300, 100]), 1), at(line([200 - 100 * Math.cos(r), 100 - 100 * Math.sin(r)], [200 + 100 * Math.cos(r), 100 + 100 * Math.sin(r)]), 1)];
    };
    expect(readHint(apart(5))).toBe('cross');
    expect(readHint(apart(3))).toBe('none');
  });

  it('both strokes of a cross are straight enough: a line and then a tick across it are no cross', () => {
    const level = at(line([100, 100], [200, 100]), 1);
    expect(readHint([level, at(line([130, 110], [170, 70]), 1)])).toBe('cross');
    expect(readHint([level, at(through([130, 110], [145, 135], [170, 70]), 1)])).toBe('none');
    // The other way round as well.
    expect(readHint([at(through([130, 110], [145, 135], [170, 70]), 1), level])).toBe('none');
  });

  it('only two strokes are a cross: an X with a third stroke, and an asterisk, are not', () => {
    const x = [at(line([100, 100], [160, 160]), 1), at(line([160, 100], [100, 160]), 1)];
    expect(readHint(x)).toBe('cross');
    expect(readHint([...x, at(line([100, 200], [160, 200]), 1)])).toBe('none');
    expect(readHint([...x, at(line([90, 130], [170, 130]), 1)])).toBe('none');
  });

  it('the bend is measured on the read points: a slow arc bowing 0.28 of its length, drawn with a pixel of tremor, is still an underline', () => {
    // A sample every half pixel, each a pixel up or down: the samples' own path is far longer than the arc.
    const arc = Array.from({ length: 401 }, (_, i): XY => {
      const t = i / 400;
      return [100 + 200 * t, 300 + 4 * 0.28 * 200 * t * (1 - t) + (i % 2 === 0 ? -1 : 1)];
    });
    expect(lie(arc)!.bend).toBeLessThan(LINE_MAX_BEND);
    expect(readHint([arc])).toBe('underline');
  });
});

describe('an underline is under the nearest thing above it', () => {
  it('a line under two rows that are both within reach underlines the nearer', () => {
    const rows: TargetRect[] = [
      { id: 'r1', item: 'r1', box: [100, 110, 200, 12] },
      { id: 'r2', item: 'r2', box: [100, 126, 200, 12] },
    ];
    // 23 px under the first row's bottom edge, 7 under the second's.
    expect(underTargets(at(line([100, 145], [300, 145]), 1), rows)).toEqual(['r2']);
    expect(underTargets(at(line([100, 145], [300, 145]), 1), [rows[0]!])).toEqual(['r1']);
  });
});

/* ------------------------------------------------------------------ what a mark means */

type P2 = readonly [number, number];

/** `len` samples, about one a pixel, along a curve given from 0 to 1. */
const dense = (f: (t: number) => P2, len: number): P2[] => {
  const n = Math.max(2, Math.round(len));
  return Array.from({ length: n + 1 }, (_, i) => f(i / n));
};

/** A level line 120 long, and then `then` from its end. */
const lineThen = (then: (t: number) => P2): P2[] => [...dense((t) => [100 + 120 * t, 200], 120), ...dense(then, 30).slice(1)];

/** A cross whose first stroke bows by `bow` of its length, and whose strokes each end with `flick` of their length back. */
function cross(bow: number, flick = 0): P2[][] {
  const s1 = dense((t) => [100 + 80 * t + 4 * bow * 113 * t * (1 - t) * 0.707, 100 + 80 * t - 4 * bow * 113 * t * (1 - t) * 0.707], 120);
  const s2 = dense((t) => [180 - 80 * t, 100 + 80 * t], 120);
  if (flick === 0) return [s1, s2];
  return [
    [...dense((t) => [100 + 80 * t, 100 + 80 * t], 120), ...dense((t) => [180 - flick * 80 * t, 180 - 0.3 * flick * 80 * t], 20).slice(1)],
    [...s2, ...dense((t) => [100 + flick * 80 * t, 180 - 0.3 * flick * 80 * t], 20).slice(1)],
  ];
}

/** Part of a ring, swept from the top by `deg` degrees: past 360 it overlaps itself. */
const sweep = (deg: number, rx: number, ry: number): P2[] => {
  const s = (deg * Math.PI) / 180;
  return dense((t) => [300 + rx * Math.cos(-Math.PI / 2 + t * s), 300 + ry * Math.sin(-Math.PI / 2 + t * s)], rx * 6);
};

/**
 * Named strokes, each with what it reads as now and what it read as by the rules the ink had
 * before (path over chord, on the points as the hand spaced them). A change to a number shows
 * here what it moved. Where the two differ it is on purpose, and the name says why.
 */
const NAMED: Array<[name: string, strokes: P2[][], now: InkHint, was: InkHint]> = [
  ...[0.05, 0.1, 0.14, 0.16, 0.2, 0.25, 0.3].map((b): [string, P2[][], InkHint, InkHint] => [`an arc bowing ${b} of its length`, [dense((t) => [100 + 120 * t, 200 + 4 * b * 120 * t * (1 - t)], 200)], 'underline', 'underline']),
  ['an arc bowing 0.35 of its length', [dense((t) => [100 + 120 * t, 200 + 4 * 0.35 * 120 * t * (1 - t)], 200)], 'none', 'none'],
  ...[0.05, 0.1, 0.15, 0.2, 0.3].map((h): [string, P2[][], InkHint, InkHint] => [`a hook at right angles at the lift, ${h} of the line`, [lineThen((t) => [220, 200 + h * 120 * t])], 'underline', 'underline']),
  ['a hook at right angles at the lift, 0.4 of the line', [lineThen((t) => [220, 200 + 0.4 * 120 * t])], 'none', 'none'],
  ...[0.05, 0.1].map((h): [string, P2[][], InkHint, InkHint] => [`a hook back at the lift, ${h} of the line`, [lineThen((t) => [220 - 0.7 * h * 120 * t, 200 + 0.7 * h * 120 * t])], 'underline', 'underline']),
  // A hook back as the hand lifts or lands is a tip, left out: the line was unmade by it, and is not now.
  ...[0.15, 0.2].map((h): [string, P2[][], InkHint, InkHint] => [`a hook back at the lift, ${h} of the line (a tip, left out now)`, [lineThen((t) => [220 - 0.7 * h * 120 * t, 200 + 0.7 * h * 120 * t])], 'underline', 'none']),
  ...[0.15, 0.2].map((h): [string, P2[][], InkHint, InkHint] => [
    `a hook back as the hand lands, ${h} of the line (a tip, left out now)`,
    [[...dense((t) => [100 + 0.7 * h * 120 * (1 - t), 200 - 0.7 * h * 120 * (1 - t)], 30), ...dense((t) => [100 + 120 * t, 200], 120).slice(1)]],
    'underline',
    'none',
  ]),
  ['a hook back at the lift, 0.25 of the line', [lineThen((t) => [220 - 0.7 * 0.25 * 120 * t, 200 + 0.7 * 0.25 * 120 * t])], 'none', 'none'],
  ...[1, 2, 3, 5, 8].flatMap((a) =>
    [3, 6, 12].map((k): [string, P2[][], InkHint, InkHint] => {
      // A wavy line that keeps to its chord reads as a line now: the old rule failed a wobbling hand.
      const was = ['3 12', '5 6', '5 12', '8 6', '8 12'].includes(`${a} ${k}`) ? 'none' : 'underline';
      return [`a line 150 long wavering ${a} either side, ${k} times${was === 'none' ? ' (keeps to its chord, a line now)' : ''}`, [dense((t) => [100 + 150 * t, 200 + a * Math.sin(t * k * 2 * Math.PI)], 300)], 'underline', was];
    }),
  ),
  ...[10, 15, 20, 25].map((a): [string, P2[][], InkHint, InkHint] => [`a zigzag ${a} either side, 4 times over 100`, [dense((t) => [100 + 100 * t, 200 + a * Math.sin(t * 4 * 2 * Math.PI)], 300)], 'none', 'none']),
  // Letters written along a line keep to its chord as a wavy line does: they read as one.
  ...[
    [8, 14],
    [6, 20],
  ].map(([humps, tall]): [string, P2[][], InkHint, InkHint] => [
    `a cursive "mmm" along a line, ${humps} humps ${tall} px tall over 150 (keeps to its chord, a line now)`,
    [dense((t) => [100 + 150 * t, 200 - tall! * Math.abs(Math.sin(t * humps! * Math.PI))], 600)],
    'underline',
    'none',
  ]),
  ['one wave 150 long, 20 either side of its line', [dense((t) => [100 + 150 * t, 200 + 20 * Math.sin(t * 2 * Math.PI)], 300)], 'underline', 'underline'],
  ['one wave 150 long, 30 either side of its line (keeps to its chord, a line now)', [dense((t) => [100 + 150 * t, 200 + 30 * Math.sin(t * 2 * Math.PI)], 300)], 'underline', 'none'],
  ['one wave 150 long, 40 either side of its line', [dense((t) => [100 + 150 * t, 200 + 40 * Math.sin(t * 2 * Math.PI)], 300)], 'none', 'none'],
  ...[250, 280, 300].map((d): [string, P2[][], InkHint, InkHint] => [`a ring swept ${d} degrees`, [sweep(d, 40, 40)], 'none', 'none']),
  // A ring the hand did not quite close reads as one now: the old rule counted no turning on samples closer than 2 units.
  ['a ring swept 320 degrees (a ring, now)', [sweep(320, 40, 40)], 'circle', 'none'],
  ['a ring swept 340 degrees (a ring, now)', [sweep(340, 40, 40)], 'circle', 'none'],
  ['a small ring swept 340 degrees (a ring, now)', [sweep(340, 15, 12)], 'circle', 'none'],
  ...[360, 400, 450].map((d): [string, P2[][], InkHint, InkHint] => [`a ring swept ${d} degrees`, [sweep(d, 40, 40)], 'circle', 'circle']),
  ['a long flat ring round a row, swept 300 degrees', [sweep(300, 200, 25)], 'circle', 'circle'],
  ['a long flat ring round a row, swept 320 degrees', [sweep(320, 200, 25)], 'none', 'none'],
  // Two turns round a thing, ending inside: a ring drawn twice over. It picks what it rings.
  ...[0.1, 0.2, 0.3, 0.5].map((shrink): [string, P2[][], InkHint, InkHint] => [
    `a spiral of two turns, shrinking ${shrink} (a ring drawn twice, now)`,
    [dense((t) => [300 + 40 * (1 - shrink * t) * Math.cos(t * 2.1 * Math.PI), 300 + 40 * (1 - shrink * t) * Math.sin(t * 2.1 * Math.PI)], 300)],
    'circle',
    'none',
  ]),
  // A ring that runs on into a tail as the hand lifts: the hand did not close it, and it is a ring.
  ...[30, 80].map((tail): [string, P2[][], InkHint, InkHint] => [
    `a ring with a tail ${tail} px out (a ring, now)`,
    [[...dense((t) => [300 + 40 * Math.cos(t * 2 * Math.PI), 300 + 30 * Math.sin(t * 2 * Math.PI)], 220), ...dense((t) => [340 + tail * t * Math.SQRT1_2, 300 + tail * t * Math.SQRT1_2], tail).slice(1)]],
    'circle',
    'none',
  ]),
  // A ring drawn fast is a few samples far apart: read from points spaced along it, it is a ring.
  ...[5, 6].map((n): [string, P2[][], InkHint, InkHint] => [`a fast ring of ${n} samples (a ring, now)`, [Array.from({ length: n + 1 }, (_, i): P2 => [300 + 40 * Math.cos((i / n) * 2 * Math.PI), 300 + 30 * Math.sin((i / n) * 2 * Math.PI)])], 'circle', 'none']),
  ...[7, 10].map((n): [string, P2[][], InkHint, InkHint] => [`a fast ring of ${n} samples`, [Array.from({ length: n + 1 }, (_, i): P2 => [300 + 40 * Math.cos((i / n) * 2 * Math.PI), 300 + 30 * Math.sin((i / n) * 2 * Math.PI)])], 'circle', 'circle']),
  ...[0, 0.1, 0.2, 0.25, 0.3, 0.35].map((b): [string, P2[][], InkHint, InkHint] => [`a cross, one stroke bowing ${b}`, cross(b), 'cross', 'cross']),
  ...[0.05, 0.1, 0.16, 0.2].map((f): [string, P2[][], InkHint, InkHint] => [`a cross whose strokes each flick back ${f} at the lift`, cross(0, f), 'cross', 'cross']),
  ...[18, 20].map((len): [string, P2[][], InkHint, InkHint] => [`a level line ${len} long`, [dense((t) => [100 + len * t, 100], len)], 'none', 'none']),
  ...[21, 25].map((len): [string, P2[][], InkHint, InkHint] => [`a level line ${len} long`, [dense((t) => [100 + len * t, 100], len)], 'underline', 'underline']),
  ...[18, 19.5].map((deg): [string, P2[][], InkHint, InkHint] => [`a line ${deg} degrees off level`, [dense((t) => [100 + 100 * Math.cos((deg * Math.PI) / 180) * t, 100 + 100 * Math.sin((deg * Math.PI) / 180) * t], 100)], 'underline', 'underline']),
  ['a line 20.5 degrees off level', [dense((t) => [100 + 100 * Math.cos((20.5 * Math.PI) / 180) * t, 100 + 100 * Math.sin((20.5 * Math.PI) / 180) * t], 100)], 'none', 'none'],
];

describe('a mark means what it meant: named strokes, drawn at 100% and kept as the pen keeps them', () => {
  /** The strokes as the pen keeps them, at 100%. */
  const kept = (strokes: P2[][]) =>
    strokes.map((s) => {
      const [first, ...rest] = s.map(([x, y]): Pt => [x, y, 0.5]);
      const stroke = drawing(first!, 1);
      stroke.add(rest);
      return [...stroke.pts];
    });

  it.each(NAMED)('%s', (_name, strokes, now) => {
    expect(readHint(kept(strokes))).toBe(now);
  });

  it('each change from what the old rules read is named for what was asked: a tip left out, a wobbling hand, a ring the hand did not close', () => {
    const changed = NAMED.filter(([, , now, was]) => now !== was).map(([name]) => name);
    expect(changed.every((name) => /\((a tip, left out now|keeps to its chord, a line now|a ring, now|a ring drawn twice, now)\)$/.test(name))).toBe(true);
    expect(changed).toHaveLength(23);
  });

  it('letters written along a line just under a card underline the card', () => {
    const card: TargetRect[] = [{ id: 'c', item: 'c', box: [100, 150, 150, 40] }];
    for (const [humps, tall] of [
      [8, 14],
      [6, 20],
    ] as const) {
      const word = kept([dense((t) => [100 + 150 * t, 210 - tall * Math.abs(Math.sin(t * humps * Math.PI))], 600)]);
      expect(readInk(word, card), `${humps} humps`).toMatchObject({ hint: 'underline', targets: ['c'] });
    }
  });
});

/* ------------------------------------------------------------------ the split and the marks */

/** A spread with one approach, and a step inside it, as the page measures them. */
const rects: TargetRect[] = [
  { id: 'sp', item: 'sp', box: [800, 100, 600, 300] },
  { id: 'sp/approach:a', item: 'sp', sub: 'approach:a', parent: 'sp', box: [816, 140, 280, 240] },
  { id: 'sp/step:a-take', item: 'sp', sub: 'step:a-take', parent: 'sp/approach:a', box: [832, 180, 120, 40] },
];
const boxOf = () => undefined;

/** Each stroke as a press of its own, kept in one piece: how the pen hands over a go of strokes that never filled up. */
const presses = (strokes: readonly (readonly XY[])[]): XY[][][] => strokes.map((s) => [[...s]]);

/**
 * A ring round a box, drawn slowly: a sample about every pixel, as a careful hand makes them.
 * It is wide enough to clear the box's corners, so it touches nothing inside what it rings.
 */
function slowRing([x, y, w, h]: Box): XY[] {
  const [rx, ry] = [(w / 2) * 1.5, (h / 2) * 1.6];
  const n = Math.ceil(2 * Math.PI * Math.max(rx, ry));
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = -Math.PI / 2 + (i / n) * 2 * Math.PI;
    return [Math.round(x + w / 2 + rx * Math.cos(t)), Math.round(y + h / 2 + ry * Math.sin(t))] as const;
  });
}

describe('the split of a go and the reading of its marks agree', () => {
  // The go that showed the fault: a ring drawn slowly round a step, then a
  // line elsewhere in the same approach. Cut from one set of points and read from another, the
  // ring was no circle when the go was cut, so the line joined it, and the pick was lost.
  const ring = slowRing([832, 180, 120, 40]);
  const stroke: XY[] = line([860, 330], [1040, 334]);

  it('a ring drawn slowly reads the same alone as in the mark it becomes', () => {
    const alone = readInk([ring], rects);
    const mark = inkItem('m1', presses([ring]), rects, boxOf);
    expect(alone.hint).toBe('circle');
    expect(mark.hint).toBe(alone.hint);
    expect(mark.targets).toEqual([{ item: 'sp', sub: 'step:a-take' }]);
  });

  it('the ring is a finished pick, so the line after it is a mark of its own', () => {
    const groups = splitGo(presses([ring, stroke]), rects);
    expect(groups.map((g) => g.length)).toEqual([1, 1]);
    const marks = groups.map((g, i) => inkItem(`m${i + 1}`, g, rects, boxOf));
    expect(marks.map((m) => m.hint)).toEqual(['circle', 'none']);
    expect(marks[0]!.targets).toEqual([{ item: 'sp', sub: 'step:a-take' }]);
    expect(marks[1]!.targets).toEqual([{ item: 'sp', sub: 'approach:a' }]);
    // What the split read of each group is what its mark says.
    for (const [i, g] of groups.entries()) expect(readInk(g.map(oneStroke), rects).hint).toBe(marks[i]!.hint);
  });

  it('a mark is posted with the very points it was read from: nothing is thinned again on the way', () => {
    const mark = inkItem('m1', presses([ring]), rects, boxOf);
    expect(mark.strokes[0]!.pts).toHaveLength(ring.length * 2);
    expect(mark.strokes[0]!.pts.slice(0, 2)).toEqual([ring[0]![0] - mark.box[0], ring[0]![1] - mark.box[1]]);
  });

  it('the split and the marks judge size at the same zoom', () => {
    // The same board an eighth the size, and the go drawn on it at 400%: half the size on screen.
    // The ring is 23.9 board units from corner to corner (too small for a loop, were that the
    // measure) and 96 px on screen. A steep stroke follows it, elsewhere in the approach.
    const eighth = (pts: readonly XY[]): XY[] => pts.map(([x, y]) => [x / 8, y / 8] as const);
    const tiny = rects.map((r): TargetRect => ({ ...r, box: [r.box[0] / 8, r.box[1] / 8, r.box[2] / 8, r.box[3] / 8] }));
    const go = presses([eighth(ring), eighth(line([1000, 240], [1024, 352]))]);
    const groups = splitGo(go, tiny, 4);
    expect(groups.map((g) => g.length)).toEqual([1, 1]);
    const marks = groups.map((g, i) => inkItem(`m${i + 1}`, g, tiny, boxOf, undefined, 4));
    expect(marks.map((m) => [m.hint, m.targets])).toEqual([
      ['circle', [{ item: 'sp', sub: 'step:a-take' }]],
      ['none', [{ item: 'sp', sub: 'approach:a' }]],
    ]);
    // Judged in board units, the ring is no loop, and the two strokes are one sketch.
    expect(splitGo(go, tiny).map((g) => g.length)).toEqual([2]);
    // The other way round, the ring comes second: read alone at the same zoom, it is a pick of the step, and so a mark of its own.
    expect(splitGo([go[1]!, go[0]!], tiny, 4).map((g) => g.length)).toEqual([1, 1]);
    expect(splitGo([go[1]!, go[0]!], tiny).map((g) => g.length)).toEqual([2]);
  });
});
