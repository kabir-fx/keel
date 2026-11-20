import type { Box, InkItem } from '@keel/protocol';
import { createHash } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { loadFixture } from '../src/fixture';
import type { Pt } from '../src/geometry';
import { wholeBoxAround } from '../src/geometry';
import { InkMark } from '../src/ink/ink';
import { getStroke } from 'perfect-freehand';
import { carriedOn, drawing, inkPath, keep, oneStroke, outlineToPath, PEN, samples } from '../src/ink/stroke';
import { INK_MIN_GAP, LOOP_CLOSE, LOOP_MIN_TRAVEL, STROKE_JOIN_POINTS, STROKE_MAX_POINTS } from '../src/input/constants';
import pinned from './fixtures/ink-paths.json';
import recorded from './fixtures/strokes.json';

/**
 * How ink is drawn. The first part holds saved ink still: `fixtures/ink-paths.json` has the path
 * of every stroke in the fixture logs and in the recorded strokes, taken from the ink code as it
 * stood before the pen was given its new feel. Ink that is in a log must draw exactly as it did, so that
 * file is never made again from newer code.
 */

/** One view of a pinned mark: where its drawing sits, and its paths (whole, or only their digest). */
interface View {
  style: string;
  viewBox: string;
  fills: string[];
  sha: string;
  paths?: string[];
}
type Scale = 'drawn' | 'stretched' | 'small' | 'large';
type Pinned = { item: string; strokes: number } & Record<Scale, View>;

/** How far the mark's anchor scaled it in each pinned view. Every view but `drawn` is also moved by 40, -30. */
const SCALES: Record<Scale, [sx: number, sy: number]> = { drawn: [1, 1], stretched: [2.4, 0.6], small: [0.5, 0.5], large: [3, 3] };

const sha = (paths: readonly string[]) => createHash('sha256').update(paths.join('\n')).digest('hex');

/** What an ink mark's markup says, read the way the pinned file was written. */
function view(markup: string): Required<View> {
  const found = [...markup.matchAll(/<path d="([^"]*)" fill="([^"]*)"/g)];
  const paths = found.map((m) => m[1] ?? '');
  return {
    style: /style="([^"]*)"/.exec(markup)?.[1] ?? '',
    viewBox: /viewBox="([^"]*)"/.exec(markup)?.[1] ?? '',
    fills: [...new Set(found.map((m) => m[2] ?? ''))],
    sha: sha(paths),
    paths,
  };
}

/** Where a view's SVG sits on the board and how much of its own space it shows, and where that puts the corner its paths are counted from. */
function placed({ style, viewBox }: Pick<View, 'style' | 'viewBox'>): { box: Box; size: number[]; corner: [number, number] } {
  const px = (name: string) => Number(new RegExp(`${name}:(-?[\\d.]+)px`).exec(style)?.[1]);
  const [vx = NaN, vy = NaN, vw = NaN, vh = NaN] = viewBox.split(' ').map(Number);
  const box: Box = [px('left'), px('top'), px('width'), px('height')];
  return { box, size: [vw, vh], corner: [box[0] - vx, box[1] - vy] };
}

/** A saved mark as the board draws it, moved and scaled as its anchor would. */
function drawn(item: InkItem, scale: Scale): Required<View> {
  const [sx, sy] = SCALES[scale];
  const shown: InkItem['box'] = scale === 'drawn' ? item.box : [item.box[0] + 40, item.box[1] - 30, item.box[2] * sx, item.box[3] * sy];
  return view(renderToStaticMarkup(createElement(InkMark, { strokes: item.strokes, box: item.box, shown })));
}

describe('ink that is already in a log draws exactly as it did before', () => {
  const logs = pinned.logs as Record<string, Pinned[]>;

  it.each(Object.keys(logs))('%s: every ink mark, where it was made and after its anchor moved and scaled it', async (name) => {
    const fx = await loadFixture(name);
    const marks = (fx?.events ?? []).flatMap((e) => (e.type === 'item.add' && e.item.kind === 'ink' ? [e.item] : []));
    expect(marks.map((m) => m.id)).toEqual(logs[name]!.map((p) => p.item));
    for (const [i, was] of logs[name]!.entries()) {
      const mark = marks[i]!;
      expect(mark.strokes, mark.id).toHaveLength(was.strokes);
      for (const scale of Object.keys(SCALES) as Scale[]) {
        const now = drawn(mark, scale);
        const then = was[scale];
        const where = `${name} ${mark.id} ${scale}`;
        if (then.paths) expect(now.paths, where).toEqual(then.paths);
        expect(now.sha, where).toBe(then.sha);
        expect(now.fills, where).toEqual(then.fills);
        // The SVG's box is now the smallest on whole units round the pinned one, and the paths are
        // counted from the same corner: every point is drawn where it was, to a thousandth.
        const [before, after] = [placed(then), placed(now)];
        expect(after.box, where).toEqual(wholeBoxAround(before.box));
        expect(after.size, where).toEqual(after.box.slice(2));
        expect(Math.abs(after.corner[0] - before.corner[0]), where).toBeLessThan(0.001);
        expect(Math.abs(after.corner[1] - before.corner[1]), where).toBeLessThan(0.001);
      }
    }
  });

  it('the golden fixture and the sample hold ink, so the pin is not empty', () => {
    expect(logs['engine-loop']!.reduce((n, m) => n + m.strokes, 0)).toBe(29);
    expect(logs.sample!.reduce((n, m) => n + m.strokes, 0)).toBe(10);
    expect(logs.bench!.reduce((n, m) => n + m.strokes, 0)).toBe(66);
  });

  it.each(Object.entries(pinned.recorded as Record<string, string[]>))('the recorded strokes of %s, drawn as saved strokes', (name, paths) => {
    const strokes = (recorded as Record<string, number[][]>)[name]!.map((pts) => ({ pts }));
    expect(drawn({ id: name, kind: 'ink', box: [0, 0, 0, 0], strokes, targets: [], hint: 'none' }, 'drawn').paths).toEqual(paths);
  });
});

/* ------------------------------------------------------------------ the pure parts */

/** The three zooms every rule of the pen is held at. */
const ZOOMS = [0.25, 1, 4] as const;

type Px = readonly [x: number, y: number];

/** A stroke through points given in screen pixels, at a zoom, with the camera's corner on the board's. */
function strokeAt(px: readonly Px[], zoom: number) {
  const at = ([x, y]: Px): Pt => [x / zoom, y / zoom, 0.5];
  const stroke = drawing(at(px[0]!), zoom);
  for (const p of px.slice(1)) stroke.add([at(p)]);
  return stroke;
}

/** How far apart two neighbours of a stroke are on screen, at their furthest. */
const widestGap = (pts: readonly Pt[], zoom: number) => Math.max(...pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i]![0], p[1] - pts[i]![1]) * zoom));

/** Every number of a path, in order. */
const numbers = (d: string) => (d.match(/-?\d+\.\d+/g) ?? []).map(Number);

describe('a stroke is thinned as its samples arrive, by distance on screen', () => {
  it.each(ZOOMS)('at zoom %s a sample at the gap from the last one kept stays, and one a step nearer gives way to the next', (zoom) => {
    const at = INK_MIN_GAP;
    expect(strokeAt([[0, 0], [at, 0], [2 * at, 0]], zoom).pts).toHaveLength(3);
    const near = INK_MIN_GAP - 0.1;
    const thinned = strokeAt([[0, 0], [near, 0], [2 * near, 0]], zoom).pts;
    expect(thinned).toHaveLength(2);
    expect(thinned[1]![0] * zoom).toBeCloseTo(2 * near, 0);
  });

  it('the newest sample is always the end of the stroke, however near the one before it', () => {
    const stroke = drawing([10, 10, 0.5], 1);
    stroke.add([[10.4, 10, 0.5]]);
    expect(stroke.pts).toEqual([[10, 10, 0.5], [10.4, 10, 0.5]]);
    stroke.add([[10.9, 10, 0.5]]);
    expect(stroke.pts).toEqual([[10, 10, 0.5], [10.9, 10, 0.5]]);
    stroke.add([[14, 10, 0.5], [14.2, 10.2, 0.5]]);
    expect(stroke.pts).toEqual([[10, 10, 0.5], [14, 10, 0.5], [14.2, 10.2, 0.5]]);
  });

  it('a stroke is one list from its first sample to its last: it is added to in place', () => {
    const stroke = drawing([0, 0, 0.5], 1);
    const list = stroke.pts;
    for (let i = 1; i <= 500; i++) stroke.add([[i * 3, Math.sin(i / 9) * 40, 0.5]]);
    expect(stroke.pts).toBe(list);
    expect(list).toHaveLength(501);
  });

  it('points are kept on tenths of a board unit, and the pressure slot is kept with them', () => {
    const stroke = drawing([1.234, 0.04, 0.5], 1);
    stroke.add([[7.777, 3.14159, 0.8]]);
    expect(stroke.pts).toEqual([[1.2, 0, 0.5], [7.8, 3.1, 0.8]]);
  });

  it('a stroke drawn at 400% keeps a point at least every 2 screen pixels: its curves stay curves', () => {
    // A hand moving slowly round a small ring: a sample every screen pixel, 314 px in all.
    const ring: Px[] = Array.from({ length: 315 }, (_, i) => [300 + 50 * Math.cos(i / 50), 300 + 50 * Math.sin(i / 50)]);
    const { pts } = strokeAt(ring, 4);
    expect(pts.length).toBeGreaterThanOrEqual(314 / 2);
    // Neighbours are 2 px apart at most, give or take the tenth of a board unit each is rounded to.
    expect(widestGap(pts, 4)).toBeLessThanOrEqual(2 + 0.1 * Math.SQRT2 * 4);
    // Counted in board units, as the gap was, the same ring kept a point only every 6 px.
    expect(pts.length).toBeGreaterThan(2 * (314 / 6));
  });

  it.each(ZOOMS)('at zoom %s the same hand keeps the same number of points: the gap is on screen, not on the board', (zoom) => {
    const wave: Px[] = Array.from({ length: 400 }, (_, i) => [100 + i, 200 + 30 * Math.sin(i / 25)]);
    expect(strokeAt(wave, zoom).pts.length).toBe(strokeAt(wave, 1).pts.length);
  });

  /** A stroke with `n` points, one every 2 px along a line. */
  function filled(n: number) {
    const stroke = drawing([0, 0, 0.5], 1);
    for (let i = 1; i < n; i++) stroke.add([[i * 2, 0, 0.5]]);
    return stroke;
  }
  const END = (STROKE_MAX_POINTS - 1) * 2;

  it('a stroke a point short of full takes one more, and a full one takes none: it gives back every sample it had no room for', () => {
    const short = filled(STROKE_MAX_POINTS - 1);
    expect(short.add([[END, 0, 0.5]])).toEqual([]);
    expect(short.pts).toHaveLength(STROKE_MAX_POINTS);

    const full = filled(STROKE_MAX_POINTS);
    const before = full.pts.map((p) => [...p]);
    const more: Pt[] = [[END + 2, 0, 0.5], [END + 4, 0, 0.5], [END + 6, 0, 0.5]];
    expect(full.add(more)).toEqual(more);
    // No point it had is let go, and none is moved.
    expect(full.pts).toEqual(before);
  });

  it('a full stroke whose end is only where the pointer is for now lets the newest sample take its place, as any stroke does', () => {
    const full = filled(STROKE_MAX_POINTS - 1);
    // Half a pixel on: the end is loose, and the stroke is full with it.
    expect(full.add([[END - 1.5, 0, 0.5]])).toEqual([]);
    expect(full.pts).toHaveLength(STROKE_MAX_POINTS);
    expect(full.add([[END, 0, 0.5]])).toEqual([]);
    expect(full.pts.at(-1)).toEqual([END, 0, 0.5]);
    expect(full.add([[END + 2, 0, 0.5]])).toEqual([[END + 2, 0, 0.5]]);
  });

  /** Where a stroke is drawn from its points: its path, and how wide the line is between x 100 and 300 on its first lap. */
  function look(pts: readonly Pt[]): { d: string; width: number } {
    const { strokes } = keep([pts], PEN.size);
    const kept = strokes[0]!;
    const outline = getStroke(samples(kept.pts), { ...PEN, simulatePressure: true, last: true });
    const ys = outline.filter(([x = 0, y = 0]) => x > 100 && x < 300 && y < 10).map(([, y = 0]) => y);
    return { d: inkPath(kept.pts, kept.w), width: Math.max(...ys) - Math.min(...ys) };
  }

  it('the line keeps its width when the stroke fills up: the path of what is drawn is the same string before and after', () => {
    // A long back-and-forth, a sample every 1.6 px, so each is kept: about 4,800 px of ink.
    const at = (i: number): Pt => {
      const lap = Math.floor((i * 1.6) / 1000);
      const x = (i * 1.6) % 1000;
      return [lap % 2 === 0 ? x : 1000 - x, lap * 20, 0.5];
    };
    const stroke = drawing(at(0), 1);
    let i = 1;
    for (; stroke.pts.length < STROKE_MAX_POINTS; i++) stroke.add([at(i)]);
    const before = look(stroke.pts);
    expect(stroke.add([at(i), at(i + 1)])).toHaveLength(2);
    expect(look(stroke.pts)).toEqual(before);
    // Thinned to make room, as it was, the same line was a third narrower: 5.2 board units to 3.5.
    expect(before.width).toBeGreaterThan(5);
  });

  it('however long the hand goes on, each stroke holds no more points than the log takes, and together they keep every sample', () => {
    // Laps to and fro a sample every 2 px, so each one is kept.
    const at = (i: number): Pt => {
      const lap = Math.floor(i / 500);
      return [lap % 2 === 0 ? (i % 500) * 2 : 1000 - (i % 500) * 2, lap * 3 + (i % 500) / 100, 0.5];
    };
    const round = (p: Pt): Pt => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10, 0.5];
    const all = Array.from({ length: 20001 }, (_, i) => at(i));
    const strokes = [drawing(all[0]!, 1)];
    for (const p of all.slice(1)) {
      let left = strokes.at(-1)!.add([p]);
      // A full stroke ends, and the next carries on from its last point.
      while (left.length > 0) {
        const next = drawing(strokes.at(-1)!.pts.at(-1)!, 1);
        strokes.push(next);
        left = next.add(left);
      }
    }
    expect(strokes).toHaveLength(Math.ceil(20001 / (STROKE_MAX_POINTS - 1)));
    for (const s of strokes) {
      expect(s.pts.length).toBeLessThanOrEqual(STROKE_MAX_POINTS);
      expect(keep([s.pts]).strokes[0]!.pts.length).toBeLessThanOrEqual(6000);
    }
    // Each stroke begins where the one before it ended; leave out those joins, and what is left is every sample, in order.
    const joined = strokes.flatMap((s, k) => (k === 0 ? s.pts : s.pts.slice(1)));
    expect(joined).toEqual(all.map(round));
  });
});

describe('one press, kept in pieces', () => {
  it('a stroke that carries on begins with the full one’s last points as they are, even where they lie nearer than the gap once rounded', () => {
    // At 400% the gap is 0.375 board units. Samples 0.38 apart are each kept; rounded to tenths, some lie 0.3 apart.
    const full = drawing([0.04, 0, 0.5], 4);
    for (let i = 1; i <= STROKE_MAX_POINTS; i++) full.add([[0.04 + 0.38 * i, 0, 0.5]]);
    expect(full.pts).toHaveLength(STROKE_MAX_POINTS);
    const tail = full.pts.slice(-1 - STROKE_JOIN_POINTS);
    expect(carriedOn(full.pts, 4).pts).toEqual(tail);
    // Thinned again on the way in, as samples are, some of them would be let go, and the join would not lie under the ink it repeats.
    const again = drawing(tail[0]!, 4);
    again.add(tail.slice(1));
    expect(again.pts.length).toBeLessThan(tail.length);
  });

  it('a stroke that carries on judges its next sample from the end of the full one: a sample nearer than the gap is only where the pointer is for now', () => {
    // At 25% the gap is 6 board units. A level line with a point every 8 fills a stroke.
    const full = drawing([0, 0, 0.5], 0.25);
    for (let i = 1; i < STROKE_MAX_POINTS; i++) full.add([[8 * i, 0, 0.5]]);
    expect(full.pts).toHaveLength(STROKE_MAX_POINTS);
    const end = full.pts.at(-1)![0];
    const next = carriedOn(full.pts, 0.25);
    // 4 units on, and then 5: each is nearer than the gap to the last point kept, so the second takes the first's place.
    next.add([[end + 4, 0, 0.5]]);
    next.add([[end + 5, 0, 0.5]]);
    expect(next.pts).toHaveLength(STROKE_JOIN_POINTS + 2);
    expect(next.pts.at(-1)).toEqual([end + 5, 0, 0.5]);
    // 7 units on it is kept, and the sample after it is judged from there.
    next.add([[end + 7, 0, 0.5]]);
    next.add([[end + 9, 0, 0.5]]);
    expect(next.pts.slice(-2)).toEqual([
      [end + 7, 0, 0.5],
      [end + 9, 0, 0.5],
    ]);
    expect(next.pts).toHaveLength(STROKE_JOIN_POINTS + 3);
  });

  it('a long press is read as one stroke from its pieces: every sample once, in order', () => {
    // Laps to and fro, a sample every 2 px, so each one is kept: enough to fill two strokes and start a third.
    const at = (i: number): Pt => {
      const lap = Math.floor(i / 500);
      return [lap % 2 === 0 ? (i % 500) * 2 : 1000 - (i % 500) * 2, lap * 3 + (i % 500) / 100, 0.5];
    };
    const round = (p: Pt): Pt => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10, 0.5];
    const all = Array.from({ length: 2 * STROKE_MAX_POINTS + 100 }, (_, i) => at(i));
    const pieces = [drawing(all[0]!, 1)];
    for (const p of all.slice(1)) {
      let left = pieces.at(-1)!.add([p]);
      while (left.length > 0) {
        const next = carriedOn(pieces.at(-1)!.pts, 1);
        pieces.push(next);
        left = next.add(left);
      }
    }
    expect(pieces).toHaveLength(3);
    // Each piece after the first begins under the last points of the one before.
    for (const [k, piece] of pieces.slice(1).entries()) expect(piece.pts.slice(0, STROKE_JOIN_POINTS + 1)).toEqual(pieces[k]!.pts.slice(-1 - STROKE_JOIN_POINTS));
    expect(oneStroke(pieces.map((piece) => piece.pts))).toEqual(all.map(round));
    expect(oneStroke([pieces[0]!.pts])).toEqual(pieces[0]!.pts);
  });
});

describe('a loop whose ends nearly meet is closed when the pen lifts', () => {
  /** Three sides of a square 40 px wide, and back down the fourth to `gap` px short of the start. */
  const almost = (gap: number): Px[] => [[100, 100], [140, 100], [140, 140], [100, 140], [100, 100 + gap]];

  it.each(ZOOMS)('at zoom %s: 8 px apart it closes, 9 px apart it does not', (zoom) => {
    const near = strokeAt(almost(LOOP_CLOSE), zoom);
    expect(near.lift()).toBe(true);
    expect(near.pts).toHaveLength(5);
    expect(near.pts.at(-1)!.slice(0, 2)).toEqual(near.pts[0]!.slice(0, 2));

    const far = strokeAt(almost(LOOP_CLOSE + 1), zoom);
    const before = far.pts.map((p) => [...p]);
    expect(far.lift()).toBe(false);
    expect(far.pts).toEqual(before);
  });

  it.each(ZOOMS)('at zoom %s: a short tick does not close, though its ends are as near', (zoom) => {
    // Out, down and back, with 8 px between the ends. One travels 36 px and is a loop; the other is half a pixel shorter a side, and is a tick.
    expect(14 + 8 + 14).toBe(LOOP_MIN_TRAVEL);
    expect(strokeAt([[100, 100], [114, 100], [114, 108], [100, 108]], zoom).lift()).toBe(true);
    expect(strokeAt([[100, 100], [113.5, 100], [113.5, 108], [100, 108]], zoom).lift()).toBe(false);
  });

  it('a stroke of two points is a line, not a loop, and a stroke that is closed already is left alone', () => {
    expect(strokeAt([[100, 100], [106, 100]], 1).lift()).toBe(false);
    expect(strokeAt([...almost(8).slice(0, 4), [100, 100]], 1).lift()).toBe(false);
  });

  it('a stroke that carries on from a full one is not closed on its own first point: the hand began elsewhere, and the end stays where it lifted', () => {
    // A level line that fills a stroke. The piece that carries on goes out, down and back, to 8 px under its own first point.
    const full = drawing([0, 100, 0.5], 1);
    for (let i = 1; i < STROKE_MAX_POINTS; i++) full.add([[2 * i, 100, 0.5]]);
    expect(full.pts).toHaveLength(STROKE_MAX_POINTS);
    const next = carriedOn(full.pts, 1);
    const [x0, y0] = next.pts[0]!;
    const far = next.pts.at(-1)![0] + 22;
    next.add([[far, y0, 0.5], [far, y0 + 30, 0.5], [x0, y0 + 30, 0.5], [x0, y0 + LOOP_CLOSE, 0.5]]);
    const drawn = next.pts.map((p): Pt => [p[0], p[1], p[2]]);
    expect(next.lift()).toBe(false);
    expect(next.pts).toEqual(drawn);
    // The same points as a stroke the hand began there: that one is a loop, and closes.
    const own = drawing(drawn[0]!, 1);
    own.add(drawn.slice(1));
    expect(own.pts).toEqual(drawn);
    expect(own.lift()).toBe(true);
  });
});

describe('ink as the log keeps it', () => {
  it('counts every point from the top-left corner of the box round them all, on tenths', () => {
    const { box, strokes } = keep([[[12.34, 20.06], [10.02, 25.54]], [[14, 19.96]]], 4.5);
    expect(box).toEqual([10, 20, 4, 5.6]);
    // The second stroke is one point: it gets another beside it, so it stays a stroke.
    expect(strokes).toEqual([
      { pts: [2.3, 0.1, 0, 5.5], w: 4.5 },
      { pts: [4, 0, 4.1, 0], w: 4.5 },
    ]);
  });

  it('never writes a minus zero, and leaves the width out when there is none', () => {
    const { strokes } = keep([[[5, 5], [5.04, 4.96], [9, 9]]]);
    expect(strokes).toEqual([{ pts: [0, 0, 0, 0, 4, 4] }]);
    expect(strokes[0]!.pts.some((n) => Object.is(n, -0))).toBe(false);
  });

  it('a stroke alone and the same stroke in a mark with others differ only by where the box begins', () => {
    const a: Pt[] = [[30.3, 40.1, 0.5], [45.7, 52.9, 0.5], [61.2, 41.4, 0.5]];
    const b: Pt[] = [[12.5, 8.8, 0.5], [70, 90, 0.5]];
    const alone = keep([a]);
    const both = keep([b, a]);
    const [dx, dy] = [alone.box[0] - both.box[0], alone.box[1] - both.box[1]];
    expect(both.strokes[1]!.pts.map((n, i) => Math.round((n - (i % 2 === 0 ? dx : dy)) * 10) / 10)).toEqual(alone.strokes[0]!.pts);
  });
});

describe('the one way ink is drawn', () => {
  const line = Array.from({ length: 21 }, (_, i) => [i * 5, 0]).flat();
  /** How far a path reaches up and down: twice the line's widest half-width. */
  const spread = (d: string) => {
    const ys = numbers(d).filter((_, i) => i % 2 === 1);
    return Math.max(...ys) - Math.min(...ys);
  };

  it('closes the end: the line reaches its last point, it does not lag behind the hand', () => {
    const xs = numbers(inkPath(line)).filter((_, i) => i % 2 === 0);
    expect(Math.max(...xs)).toBeGreaterThan(100);
    expect(Math.min(...xs)).toBeLessThan(0);
  });

  it('draws a stroke with no width of its own at the pen’s, and a wider stroke wider', () => {
    expect(inkPath(line)).toBe(inkPath(line, PEN.size));
    expect(spread(inkPath(line, 9))).toBeGreaterThan(1.5 * spread(inkPath(line, 4.5)));
  });

  it('scales the points and not the drawing: a stroke stretched sideways keeps an even line', () => {
    const stretched = line.map((n, i) => (i % 2 === 0 ? n * 2 : n));
    expect(inkPath(line, 4.5, 2, 1)).toBe(inkPath(stretched, 4.5 * Math.sqrt(2)));
  });

  it('another look can be tried on the same points, and keel’s stays as it is', () => {
    const plain = inkPath(line);
    const sine = inkPath(line, PEN.size, 1, 1, { ...PEN, easing: (t) => Math.sin((t * Math.PI) / 2) });
    expect(sine).not.toBe(plain);
    expect(spread(sine)).toBeGreaterThan(spread(plain));
    expect(inkPath(line)).toBe(plain);
  });

  it('an outline of fewer than four points is no path', () => {
    expect(outlineToPath([])).toBe('');
    expect(outlineToPath([[0, 0], [1, 1], [2, 2]])).toBe('');
    expect(outlineToPath([[0, 0], [10, 0], [10, 10], [0, 10]])).toBe('M0.00,0.00 Q10.00,0.00 10.00,5.00 T5.00,10.00 Z');
  });
});
