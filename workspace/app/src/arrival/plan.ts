import type { Box } from '@keel/protocol';
import type { PartKind } from '@keel/pictures';
import type { Easing } from '../motion/ease';
import { bezier, EASE } from '../motion/ease';
import type { Path, Point } from '../motion/path';
import { arc, at, distance, lengthOf, polyline } from '../motion/path';
import {
  APPROACH_MAX_MS,
  ARRIVAL_SMALL_MS,
  ARRIVAL_WIDE_MS,
  BLOCK_GAP_MS,
  BLOCK_IN_MS,
  BLOCK_RISE_PX,
  BOX_FROM_SCALE,
  BOX_GAP_MS,
  BOX_IN_MS,
  CURSOR_ENTER_MS,
  CURSOR_NEAR_PX,
  CURSOR_NUDGE_MS,
  CHIP_REST_MS,
  CORNER_TIE_SHARE,
  FILL_AFTER_SHARE,
  LABEL_IN_MS,
  LABEL_RISE_PX,
  LINE_FADE_FROM_SCALE,
  MOVING_MIN,
  MOVING_SHARE_MAX,
  PARTS_SMALL,
  PARTS_WIDE,
  REDRAW_RATE,
  REST_PX,
  SAME_PX,
  SHEET_FROM_SCALE,
  SHEET_GAP_MS,
  SHEET_SET_MS,
  lineMs,
  pullMs,
  travelMs,
} from '../motion/timing';

/**
 * How one picture arrives on the board: the plan of the film, worked out before it plays.
 * Pure: it reads its input and nothing else, so the same picture, measured the same, always
 * gives the same film. No randomness, no clock, no page.
 *
 * The film is one gesture of the agent's hand, and the picture filling in behind it:
 *
 * 1. The approach. The cursor goes from where it is to the start of the picture's arrow, on a
 *    short curve, never slowly: the picture is in the log already. One not on the board yet
 *    comes in from the edge of the view.
 * 2. The arrow. The cursor moves along the arrow's route and the line follows its tip, both on
 *    `EASE.draw`; the head shows once the line is whole.
 * 3. The pull. From where the arrow ends, the cursor drags the picture out to its size, as a
 *    rectangle is dragged out: the picture grows from that point, and the cursor's tip rides the
 *    corner a hand would drag (`farCorner`: the farthest from that point, never the top left),
 *    on the same easing (`EASE.pull`) over the same time. With no arrow, the cursor goes to the
 *    picture's top left corner and pulls from there, by its bottom right.
 * 4. The fill. Once the picture is mostly out, what is on it comes in by itself, in the order it
 *    is drawn on: a cascade, a sheet set down and filled before the next. The cursor waits. A
 *    picture with no paper of its own fills from the start of the pull, so something is pulled.
 * 5. The rest. The cursor is just outside that corner from the end of the pull, and is let go
 *    when the last part is in.
 *
 * Times are in ms from the arrival's start; places are in board units.
 */

/** A cubic Bézier easing, as CSS's `cubic-bezier()` takes it. The plan keeps easings as numbers, so it is plain data. */
export type Curve = readonly [x1: number, y1: number, x2: number, y2: number];

/** One part of the picture as the plan needs it, in the order it is drawn on (`buildParts`). */
export interface PlanPart {
  kind: PartKind;
  /** How many frames it sits inside: 0 for the picture's root. */
  depth: number;
  /** A dashed line: brought in by a fade, not drawn on by its dash. */
  dashed: boolean;
  /** For a line drawn on: its length in its own units, what its dash is counted in. */
  length?: number;
}

/** What one arrival is planned from: the picture as it is measured on the page before anything moves. */
export interface PlanInput {
  /** The picture's root on the board, at the size it is drawn. */
  card: Box;
  /**
   * False when the root has no paper of its own (a spread: sheets on the bare board). Nothing of
   * it would show as it is pulled out, so what is on it starts to come in with the pull.
   */
  paper?: boolean | undefined;
  /** The route of its arrow from what it answers, start to end; none when it has no arrow. */
  route?: readonly Point[] | undefined;
  /** Where the cursor is now; none when it is not on the board yet. */
  cursor?: Point | undefined;
  /** Where a cursor not on the board comes in from; none when it simply appears where it starts. */
  entry?: Point | undefined;
  /** The parts, in the order they are drawn on. The first is the picture's root. */
  parts: readonly PlanPart[];
  /** The zoom the picture will be seen at: durations follow lengths on the screen. */
  zoom: number;
  /** How much faster than usual it plays: 1, or more when the board has fallen behind the log. */
  rate?: number;
}

/** How a part is posed as it comes in. Each ends on the part as it is at rest. */
export type Pose =
  /** A line drawn on by its dash, its head held back until it is whole. */
  | { kind: 'draw'; length: number }
  /** The picture pulled out from `origin` (in its own pixels, from its top left), from nothing to its size, its paper fading in at first. */
  | { kind: 'pull'; origin: Point }
  /** Words, coming in as they rise by `by` pixels. */
  | { kind: 'rise'; by: number }
  /** A box or a sheet, growing from `from` of its size about its middle as it shows. */
  | { kind: 'grow'; from: number }
  /** A dashed line: it shows as it grows from `from` of its size, its head held back until it is whole. */
  | { kind: 'fade'; from: number }
  /** A finished placeholder's root, from the rectangle it had: moved by `move` and scaled by `scale` about its top left, to none. */
  | { kind: 'reshape'; move: Point; scale: Point }
  /** A chip of words, written in from the left. */
  | { kind: 'write' };

/** One part coming in: which (an index into the parts, or the picture's arrow), when, how long, how. */
export interface Beat {
  part: number | 'arrow';
  start: number;
  ms: number;
  ease: Curve;
  pose: Pose;
}

/** One move of the cursor: along `path`, from `start`, over `ms`, as far at each moment as `ease` says. */
export interface Leg {
  path: Path;
  start: number;
  ms: number;
  ease: Curve;
}

/** The film of one picture arriving. */
export interface Arrival {
  beats: Beat[];
  /** The cursor's moves, one after another, each from where the one before ended. */
  legs: Leg[];
  /** Where the cursor rests: just outside the corner it pulled, or the bottom right one. */
  rest: Point;
  /** When it is over: every part in. */
  total: number;
}

/* ------------------------------------------------------------------ easings as numbers */

/** The four numbers of a board easing, read from its CSS: the one place the curve is said. */
export function curveOf(e: Easing): Curve {
  const n = /cubic-bezier\(([^)]*)\)/.exec(e.css)?.[1]?.split(',').map(Number);
  if (!n || n.length !== 4 || n.some((x) => !Number.isFinite(x))) throw new Error(`Not a cubic Bézier: ${e.css}`);
  return [n[0]!, n[1]!, n[2]!, n[3]!];
}

export const MOVE = curveOf(EASE.move);
export const DRAW = curveOf(EASE.draw);
export const ENTER = curveOf(EASE.enter);
export const PULL = curveOf(EASE.pull);

const solved = new Map<string, (t: number) => number>();

/** The easing function of a curve. */
export function easeOf(c: Curve): (t: number) => number {
  const key = c.join(',');
  let f = solved.get(key);
  if (!f) solved.set(key, (f = bezier(c[0], c[1], c[2], c[3])));
  return f;
}

/** The CSS string of a curve. */
export const cssOf = (c: Curve): string => `cubic-bezier(${c.join(', ')})`;

/** How far a beat or a leg has gone at time `t`, eased: exactly 0 at or before its start, exactly 1 at or past its end. */
export function progress(b: { start: number; ms: number; ease: Curve }, t: number): number {
  if (t <= b.start) return 0;
  if (t >= b.start + b.ms) return 1;
  return easeOf(b.ease)((t - b.start) / b.ms);
}

/* ------------------------------------------------------------------ the cursor */

/** The point share `f` of the way along a path; past its end (an easing that goes past and back), on along its last stretch. */
function reach(path: Path, f: number): Point {
  if (f <= 1) return at(path, f);
  const pts = path.points;
  const [a, b] = [pts[pts.length - 2] ?? pts[0]!, pts[pts.length - 1]!];
  const d = distance(a, b);
  const k = d > 0 ? ((f - 1) * lengthOf(path)) / d : 0;
  return [b[0] + (b[0] - a[0]) * k, b[1] + (b[1] - a[1]) * k];
}

/** Where the cursor is at time `t`: exactly the first point at or before 0, exactly at rest from the end of its last leg. */
export function cursorAt(arrival: Arrival, t: number): Point {
  const { legs, rest } = arrival;
  const last = legs[legs.length - 1];
  if (!last || t >= last.start + last.ms) return rest;
  let leg = legs[0]!;
  for (const l of legs) {
    if (l.start > t) break;
    leg = l;
  }
  return reach(leg.path, progress(leg, t));
}

/* ------------------------------------------------------------------ the plan */

/** How long a film may take from the cursor's first move to its last part in, for a picture of this many parts, at the usual rate: a card about 1.2 s, the widest about 2.4 s. */
export function budgetFor(parts: number): number {
  const share = Math.min(1, Math.max(0, (parts - PARTS_SMALL) / (PARTS_WIDE - PARTS_SMALL)));
  return ARRIVAL_SMALL_MS + (ARRIVAL_WIDE_MS - ARRIVAL_SMALL_MS) * share;
}

/** How many parts may move at once: a third of them, and never fewer than the card and two lines of words. */
export function movingMax(parts: number): number {
  return Math.max(MOVING_MIN, Math.ceil(parts * MOVING_SHARE_MAX));
}

/** How each kind of part (but a line) comes in: after how long a gap from the part before it, over how long, and how. */
const FILL: Record<Exclude<PartKind, 'line'>, { gap: number; ms: number; pose: Pose; ease: Curve }> = {
  frame: { gap: SHEET_GAP_MS, ms: SHEET_SET_MS, pose: { kind: 'grow', from: SHEET_FROM_SCALE }, ease: ENTER },
  head: { gap: BLOCK_GAP_MS, ms: BLOCK_IN_MS, pose: { kind: 'rise', by: BLOCK_RISE_PX }, ease: ENTER },
  block: { gap: BLOCK_GAP_MS, ms: BLOCK_IN_MS, pose: { kind: 'rise', by: BLOCK_RISE_PX }, ease: ENTER },
  shape: { gap: BOX_GAP_MS, ms: BOX_IN_MS, pose: { kind: 'grow', from: BOX_FROM_SCALE }, ease: ENTER },
  label: { gap: BOX_GAP_MS, ms: LABEL_IN_MS, pose: { kind: 'rise', by: LABEL_RISE_PX }, ease: ENTER },
};

/** A film being planned: the cursor's legs one after another, and the beats. */
class Film {
  readonly legs: Leg[] = [];
  readonly beats: Beat[] = [];
  /** When the cursor's last leg ends. */
  t = 0;
  /** When each part that has started ends, for `free`. */
  readonly ends: number[] = [];

  constructor(
    readonly zoom: number,
    readonly rate: number,
  ) {}

  /** A length in board units, on the screen. */
  px = (d: number): number => d * this.zoom;

  /** The cursor's next leg. */
  move(path: Path, ms: number, ease: Curve): void {
    this.legs.push({ path, start: this.t, ms, ease });
    this.t += ms;
  }

  /**
   * The cursor goes to `goal` from where it is: a nudge when it is all but there, else by the way's
   * length, never long; in from the edge when it is not on the board; nowhere when it is nowhere.
   */
  approach(cursor: Point | undefined, entry: Point | undefined, goal: Point): void {
    const from = cursor ?? entry;
    const gap = from ? this.px(distance(from, goal)) : 0;
    if (!from || gap === 0) return;
    const ms = !cursor ? CURSOR_ENTER_MS : gap < CURSOR_NEAR_PX ? CURSOR_NUDGE_MS : Math.min(APPROACH_MAX_MS, travelMs(gap));
    this.move(arc(from, goal), ms / this.rate, MOVE);
  }

  /**
   * What is on the picture comes in by itself, in the order it is drawn on, from `from`, `fast`
   * times faster than usual: a gap apart by kind, never more than a third of the parts moving at
   * once. The first part, the root, is not one of them.
   */
  fill(parts: readonly PlanPart[], from: number, fast: number): void {
    const most = movingMax(parts.length);
    /** The first time from `at` at which fewer than `most` parts move. */
    const free = (at: number): number => {
      const later = this.ends.filter((e) => e > at).sort((x, y) => x - y);
      return later.length < most ? at : later[later.length - most]!;
    };
    let prev = -Infinity;
    parts.forEach((p, i) => {
      if (i === 0) return;
      const line = p.kind === 'line';
      const how = line ? undefined : FILL[p.kind as Exclude<PartKind, 'line'>];
      const start = free(Math.max(from, prev + (how ? how.gap : BOX_GAP_MS) / fast));
      if (how) this.beats.push({ part: i, start, ms: how.ms / fast, ease: how.ease, pose: how.pose });
      else {
        const pose: Pose = p.dashed || p.length === undefined ? { kind: 'fade', from: LINE_FADE_FROM_SCALE } : { kind: 'draw', length: p.length };
        this.beats.push({ part: i, start, ms: lineMs(this.px(p.length ?? 0)) / fast, ease: pose.kind === 'draw' ? DRAW : ENTER, pose });
      }
      this.ends.push(start + this.beats[this.beats.length - 1]!.ms);
      prev = start;
    });
  }

  /** The film, at rest at `rest` once the cursor's last leg and the last part are done. */
  done(rest: Point): Arrival {
    const total = Math.max(this.t, ...this.ends, ...this.beats.map((b) => b.start + b.ms));
    return { beats: this.beats, legs: this.legs, rest, total };
  }
}

/** One composition of a film at a pace, with when its fill starts and when it should be over. */
interface Composed {
  arrival: Arrival;
  from: number;
  budget: number;
}

/**
 * The film `compose` makes, planned again with the fill faster when it runs past its budget, by
 * as much as it ran over: a picture with much on it fills quicker, not longer.
 */
function withinBudget(compose: (pace: number) => Composed): Arrival {
  let pace = 1;
  let planned = compose(pace);
  for (let i = 0; i < 4 && planned.arrival.total > planned.budget + 1; i++) {
    const { arrival, from, budget } = planned;
    pace *= (arrival.total - from) / Math.max(1, budget - from);
    planned = compose(pace);
  }
  return planned.arrival;
}

/** The budget of a film from the cursor's first move; a long way to the picture still leaves it half of it to be built in. */
function budgetAfter(parts: number, rate: number, started: number): number {
  const budget = budgetFor(parts) / rate;
  return Math.max(budget, started + budget / 2);
}

/** Just outside the bottom right corner of a box: where the cursor rests, on nothing the box shows. */
export function restBy(box: Box, zoom: number): Point {
  return [box[0] + box[2] + REST_PX / zoom, box[1] + box[3] + REST_PX / zoom];
}

/**
 * The corner of a box a hand pulling it out from `origin` drags, and where the cursor rests by
 * it: the bottom right, unless the bottom left or the top right is farther from the origin by
 * more than `CORNER_TIE_SHARE`; then the farther of those two, and the bottom left on a tie.
 * Never the top left, where the pointer's body and its tag, which hang down and right of its
 * tip, would lie over the picture. The rest is `REST_PX` outside the corner on both axes, away
 * from the box.
 */
export function farCorner(box: Box, origin: Point, zoom: number): { corner: Point; rest: Point } {
  const [x, y, w, h] = box;
  const out = REST_PX / zoom;
  const reach = (c: [Point, Point]) => distance(c[0], origin);
  const home: [Point, Point] = [[x + w, y + h], [x + w + out, y + h + out]];
  // In the order a tie is given: bottom left, then top right.
  const others: Array<[Point, Point]> = [
    [[x, y + h], [x - out, y + h + out]],
    [[x + w, y], [x + w + out, y - out]],
  ];
  let other = others[0]!;
  for (const c of others) if (reach(c) > reach(other) + 1e-6) other = c;
  const best = reach(other) > reach(home) * (1 + CORNER_TIE_SHARE) + 1e-6 ? other : home;
  return { corner: best[0], rest: best[1] };
}

/**
 * Plan one picture's arrival: the approach, the arrow, the pull, the fill, the rest. Throws for a
 * picture with no parts: the player lets such a picture simply be there.
 */
export function planArrival(input: PlanInput): Arrival {
  const { card, route, parts, zoom } = input;
  if (parts.length === 0) throw new Error('A picture with no parts has nothing to draw on.');
  const rate = Math.max(1, input.rate ?? 1);
  const arrow = route && route.length > 1 ? route : undefined;
  /** Where the pull starts: the arrow's end, or the picture's top left corner. */
  const origin: Point = arrow ? arrow[arrow.length - 1]! : [card[0], card[1]];
  const { rest } = farCorner(card, origin, zoom);
  return withinBudget((pace) => {
    const film = new Film(zoom, rate);
    film.approach(input.cursor, input.entry, arrow ? arrow[0]! : origin);
    // The arrow, under the cursor's tip.
    if (arrow) {
      const path = polyline(arrow as [Point, ...Point[]]);
      const ms = lineMs(film.px(lengthOf(path))) / rate;
      film.beats.push({ part: 'arrow', start: film.t, ms, ease: DRAW, pose: { kind: 'draw', length: lengthOf(path) } });
      film.move(path, ms, DRAW);
    }
    const penUp = film.t;
    // The pull: the picture and the cursor's tip on its corner, on one easing over one time.
    const pull = pullMs(film.px(distance(origin, rest))) / rate;
    film.beats.push({ part: 0, start: penUp, ms: pull, ease: PULL, pose: { kind: 'pull', origin: [origin[0] - card[0], origin[1] - card[1]] } });
    film.move(polyline([origin, rest]), pull, PULL);
    film.ends.push(penUp + pull);
    // The fill, behind the stroke; with no paper to pull, from the start of the pull.
    const from = penUp + (input.paper === false ? 0 : pull * FILL_AFTER_SHARE);
    film.fill(parts, from, rate * pace);
    return { arrival: film.done(rest), from, budget: budgetAfter(parts.length, rate, penUp) };
  });
}

/** What a finished placeholder is planned from: the picture as it is now, and where the placeholder was drawn. */
export interface FinishInput extends Omit<PlanInput, 'route'> {
  /** The placeholder as it was drawn, in board units. */
  from: Box;
}

/**
 * Plan a placeholder finished: the cursor goes to the placeholder's bottom right corner, and
 * pulls the picture from the rectangle the placeholder had to the one it has now, the tip on the
 * corner all the way. The root goes from one rectangle to the other by a move and a scale about
 * its top left, both on the pull's easing, so its corner runs on the straight line between the
 * two corners, and so does the cursor. Then the fill, once the picture is mostly out; for a
 * picture with no paper of its own, from the start of the pull, as at an arrival, so something
 * is pulled. When the rectangle did not change, no pull.
 */
export function planFinish(input: FinishInput): Arrival {
  const { from: was, card, parts, zoom } = input;
  if (parts.length === 0) throw new Error('A picture with no parts has nothing to draw on.');
  const rate = Math.max(1, input.rate ?? 1);
  const [restWas, rest] = [restBy(was, zoom), restBy(card, zoom)];
  const changed = was.some((n, i) => Math.abs(n - card[i]!) * zoom > SAME_PX);
  return withinBudget((pace) => {
    const film = new Film(zoom, rate);
    film.approach(input.cursor, input.entry, changed ? restWas : rest);
    let from = film.t;
    if (changed) {
      const pull = pullMs(film.px(distance(restWas, rest))) / rate;
      const pose: Pose = { kind: 'reshape', move: [was[0] - card[0], was[1] - card[1]], scale: [was[2] / card[2], was[3] / card[3]] };
      film.beats.push({ part: 0, start: film.t, ms: pull, ease: PULL, pose });
      film.ends.push(film.t + pull);
      from = film.t + (input.paper === false ? 0 : pull * FILL_AFTER_SHARE);
      film.move(polyline([restWas, rest]), pull, PULL);
    }
    film.fill(parts, from, rate * pace);
    return { arrival: film.done(rest), from, budget: budgetAfter(parts.length, rate, 0) };
  });
}

/**
 * Plan a picture redrawn on the board: no arrow and no pull, the paper stays. The cursor goes to
 * just outside its bottom right corner, and what is on it comes in again, `REDRAW_RATE` times as
 * fast as at its arrival, from when the cursor is there, or a nudge's time at most.
 */
export function planRedraw(input: Omit<PlanInput, 'route' | 'paper'>): Arrival {
  const { card, parts, zoom } = input;
  if (parts.length === 0) throw new Error('A picture with no parts has nothing to draw on.');
  const rate = Math.max(1, input.rate ?? 1);
  const rest = restBy(card, zoom);
  return withinBudget((pace) => {
    const film = new Film(zoom, rate);
    film.approach(input.cursor, input.entry, rest);
    // What was on it is gone the moment the agent's update lands: the fill does not wait for a
    // cursor that has far to come, past a nudge's time.
    const from = Math.min(film.t, CURSOR_NUDGE_MS / rate);
    film.fill(parts, from, rate * pace * REDRAW_RATE);
    return { arrival: film.done(rest), from, budget: budgetAfter(parts.length, rate * REDRAW_RATE, 0) };
  });
}

/** What a read chip is planned from: where it is drawn, and where the cursor is. */
export interface ChipInput {
  /** The chip, in board units. */
  chip: Box;
  cursor?: Point | undefined;
  entry?: Point | undefined;
  zoom: number;
  rate?: number;
}

/**
 * Plan an answer in words: the cursor goes to the chip's left end, and the chip is written in
 * from the left under its tip, as a line is drawn: one beat on `EASE.draw` over the time a line
 * as wide takes, and the cursor along the chip on the same easing over the same time. The tip
 * runs along the chip's lower edge, so neither the pointer nor its tag is over what it wrote.
 * It rests just past the chip's right end.
 */
export function planChip(input: ChipInput): Arrival {
  const { chip, zoom } = input;
  const rate = Math.max(1, input.rate ?? 1);
  const film = new Film(zoom, rate);
  const y = chip[1] + chip[3];
  const [start, end]: [Point, Point] = [
    [chip[0], y],
    [chip[0] + chip[2], y],
  ];
  film.approach(input.cursor, input.entry, start);
  const ms = lineMs(film.px(chip[2])) / rate;
  film.beats.push({ part: 0, start: film.t, ms, ease: DRAW, pose: { kind: 'write' } });
  film.move(polyline([start, end]), ms, DRAW);
  const rest: Point = [end[0] + REST_PX / zoom, y];
  film.move(polyline([end, rest]), CHIP_REST_MS / rate, MOVE);
  return film.done(rest);
}
