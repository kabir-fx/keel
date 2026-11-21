import type { ArrowItem, BoardEvent, Box, Id, ItemPatch, LassoItem, Target } from '@keel/protocol';
import { isAnswered } from '@keel/protocol';
import { act, cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { shownBox } from '../src/anchor';
import { App } from '../src/App';
import { drawnEnds, aimOf, tieAt } from '../src/binding';
import type { TargetRect } from '../src/geometry';
import { lineHit, outlineOf } from '../src/board/measure';
import { ARROW_LET_GO, ARROWHEAD, ARROWHEAD_ANGLE, END_HANDLE_REACH, HANDLE_SIZE, MIN_ARROW, TIE_LINE } from '../src/input/constants';
import { headPath, headPoints } from '../src/arrowhead';
import { MarkView } from '../src/items';
import { Highlight } from '../src/overlay/highlight';
import { anchorBox, arrowEnds, lassoOutline, shownBoxOf, targetBoxNow, withArrowsAhead } from '../src/layout';
import { arrowHangsOn, arrowItem } from '../src/marks';
import { applied, changesNothing, holdsStill, leftBehind, letGo, lettingGo, withEndAt } from '../src/select/arrowEdit';
import { MovingStore } from '../src/select/moving';
import { localSource } from '../src/source';
import { arrowTool } from '../src/tools/arrow';
import { selectTool } from '../src/tools/select';
import type { Label, Press, Sample } from '../src/tools/types';
import { fakeBoard, moveTo, pressAt } from './fakeBoard';
import { CH, note, openBoard, text } from './helpers';
import { Keyboard, Pointer, frame, resetInput, wheel } from './pointer';

/**
 * The owner's arrows: drawn with the Arrow tool and tied to what each end lands on, taken by an
 * end and pointed somewhere else, moved whole and let go, and their words slid along the line.
 * The tool is tested alone on a board laid out by hand; the gestures of Select on the whole app,
 * where the page lays out its notes by hand too (a test page lays nothing out).
 */

afterEach(() => {
  cleanup();
  resetInput();
});

const NO_KEYS = { shift: false, alt: false, ctrl: false, meta: false };
const rect = (id: string, box: Box): TargetRect => ({ id, item: id, box });

/* ------------------------------------------------------------ the tool alone */

/** The Arrow tool on a board with these things, at a zoom. Points are in world units. */
function drawing(rects: TargetRect[], z = 1) {
  const f = fakeBoard({ tool: 'arrow' });
  f.board.measure = () => rects;
  f.board.targetBox = (t) => rects.find((r) => r.item === t.item)?.box;
  f.camera.set({ x: 0, y: 0, z });
  const tool = arrowTool();
  const sample = (w: readonly [number, number], t: number): Sample => ({ x: w[0] * z, y: w[1] * z, wx: w[0], wy: w[1], pressure: 0.5, t });
  /** Press at `from` and move to `to`, with these keys held, as the dispatcher would. */
  const start = (from: readonly [number, number], to: readonly [number, number], keys: Partial<Press['mods']> = {}): Press => {
    const down = sample(from, 0);
    const press = pressAt(down.x, down.y, { down, at: down, mods: { ...NO_KEYS, ...keys } });
    tool.down(press, f.board);
    const at = sample(to, 1);
    press.samples = [at];
    press.at = at;
    press.moved = true;
    tool.move(press, f.board);
    return press;
  };
  /** Draw from `from` to `to` and lift: the label it opens, if any. */
  const draw = (from: readonly [number, number], to: readonly [number, number], keys: Partial<Press['mods']> = {}): Label | undefined => {
    const press = start(from, to, keys);
    tool.up(press, f.board);
    return f.did.labels.at(-1);
  };
  return { ...f, tool, start, draw };
}

const NOTES = [rect('m1', [0, 0, 300, 100]), rect('m2', [600, 0, 300, 100])];
const arrowOf = (l: Label | undefined) => {
  if (l?.kind !== 'arrow') throw new Error('no arrow label');
  return l;
};

describe('the Arrow tool ties each end to what it lands on', () => {
  it('an end on a thing holds that spot; an end that stops just short of one the arrow points at holds the thing by its outline', () => {
    const { draw } = drawing(NOTES);
    // The spot of an outline tie is where the arrow's own line, carried on, meets a diagonal of the thing: here its middle.
    expect(arrowOf(draw([150, 50], [585, 50])).ties).toEqual({
      from: { target: { item: 'm1' }, tie: { at: [0.5, 0.5], mode: 'inside' } },
      to: { target: { item: 'm2' }, tie: { at: [0.5, 0.5], mode: 'outline' } },
    });
    // Slanting down into the second note from bare board.
    expect(arrowOf(draw([450, -100], [590, 40])).ties).toEqual({ to: { target: { item: 'm2' }, tie: { at: [0.125, 0.875], mode: 'outline' } } });
  });

  it('a tail begun just outside a thing is tied to it when the arrow leaves it, and not when it runs along it', () => {
    const { draw } = drawing(NOTES);
    expect(arrowOf(draw([305, 50], [450, 50])).ties).toEqual({ from: { target: { item: 'm1' }, tie: { at: [0.5, 0.5], mode: 'outline' } } });
    // Ten units under the first note, level: in reach of it, and pointing past it.
    expect(arrowOf(draw([150, 110], [450, 110])).ties).toEqual({});
  });

  it('the tail’s tie is worked out again on every move: its spot is where the arrow, as it is drawn last, leaves from', () => {
    const { start, tool, board, did, draw } = drawing(NOTES);
    // Level at first, then the head goes down: the spot behind the tail moves up the note.
    const press = start([305, 50], [450, 50]);
    const at: Sample = { x: 450, y: 80, wx: 450, wy: 80, pressure: 0.5, t: 2 };
    press.samples = [at];
    press.at = at;
    tool.move(press, board);
    tool.up(press, board);
    const tail = arrowOf(did.labels.at(-1)).ties?.from;
    expect(tail).toEqual({ target: { item: 'm1' }, tie: { at: [0.6979, 0.3021], mode: 'outline' } });
    expect(tail).toEqual(arrowOf(draw([305, 50], [450, 80])).ties?.from);
  });

  it('a tail begun between two things holds the one the arrow leaves, though the other is nearer', () => {
    const { draw } = drawing([rect('m1', [0, 0, 100, 100]), rect('m2', [110, 0, 100, 100])]);
    // Four units from the first note and six from the second, and drawn away over the first: it is the second it leaves.
    expect(arrowOf(draw([104, 50], [-50, -50])).ties).toEqual({ from: { target: { item: 'm2' }, tie: { at: [0.2795, 0.7205], mode: 'outline' } } });
    // Drawn the other way, over the second, it leaves the first.
    expect(arrowOf(draw([104, 50], [300, 150])).ties?.from).toMatchObject({ target: { item: 'm1' }, tie: { mode: 'outline' } });
  });

  it('an end in reach of a thing the arrow does not point at ties to nothing, and nothing is outlined', () => {
    const { start, hand, tool, board, did } = drawing(NOTES);
    // Level, ten units under the second note, five short of its corner.
    const press = start([400, 110], [595, 110]);
    expect(hand.highlight.get()).toBeUndefined();
    expect(hand.get().shape).toEqual({ kind: 'arrow', from: [400, 110], to: [595, 110] });
    tool.up(press, board);
    expect(arrowOf(did.labels.at(-1)).ties).toEqual({});
  });

  it('at 100%, an end 15 units outside a thing ties to it, and at 16 it does not', () => {
    const { draw } = drawing(NOTES);
    expect(arrowOf(draw([150, 50], [585, 50])).ties?.to).toBeDefined();
    expect(arrowOf(draw([150, 50], [584, 50])).ties?.to).toBeUndefined();
  });

  it('zoomed out to 50%, the reach is 20 units: 20 ties, 21 does not', () => {
    const { draw } = drawing(NOTES, 0.5);
    expect(arrowOf(draw([150, 50], [580, 50])).ties?.to).toBeDefined();
    expect(arrowOf(draw([150, 50], [579, 50])).ties?.to).toBeUndefined();
  });

  it('zoomed out to 50%, the tail ties from as far as the head does: 20 units ties, 21 does not', () => {
    const { draw } = drawing(NOTES, 0.5);
    expect(arrowOf(draw([320, 50], [450, 300])).ties?.from).toMatchObject({ target: { item: 'm1' }, tie: { mode: 'outline' } });
    expect(arrowOf(draw([321, 50], [450, 300])).ties?.from).toBeUndefined();
  });

  it('an end on a part of a picture and one on the picture itself each hold their spot on their own box', () => {
    const card: TargetRect = { id: 'p1', item: 'p1', box: [0, 0, 400, 300] };
    const part: TargetRect = { id: 'p1/part:q', item: 'p1', sub: 'part:q', parent: 'p1', box: [100, 100, 100, 50] };
    const f = drawing([card, part]);
    // Where the board says each is drawn now: the part has moved down by 10 since it was measured.
    f.board.targetBox = (t) => (t.sub ? [100, 110, 100, 50] : [0, 0, 400, 300]);
    const l = arrowOf(f.draw([150, 135], [300, 250]));
    expect(l.ties?.from).toEqual({ target: { item: 'p1', sub: 'part:q' }, tie: { at: [0.5, 0.5], mode: 'inside' } });
    expect(l.ties?.to).toEqual({ target: { item: 'p1' }, tie: { at: [0.75, 0.8333], mode: 'inside' } });
  });

  it('Cmd or Ctrl held ties both ends to nothing', () => {
    const { draw } = drawing(NOTES);
    expect(arrowOf(draw([150, 50], [700, 50], { meta: true })).ties).toEqual({});
    expect(arrowOf(draw([150, 50], [700, 50], { ctrl: true })).ties).toEqual({});
    expect(arrowOf(draw([150, 50], [700, 50])).ties).toMatchObject({ from: {}, to: {} });
  });

  it('Shift holds the arrow to steps of 15 degrees, its end on that ray', () => {
    const { draw } = drawing([]);
    const l = arrowOf(draw([0, 0], [200, 60], { shift: true }));
    const deg = (Math.atan2(l.to[1] - l.from[1], l.to[0] - l.from[0]) * 180) / Math.PI;
    expect(deg).toBeCloseTo(15, 8);
    expect(arrowOf(draw([0, 0], [200, 10], { shift: true })).to).toEqual([200, 0]);
    expect(arrowOf(draw([0, 0], [200, 10])).to).toEqual([200, 10]);
  });

  it('Shift keeps the arrow on its ray whatever its ends tie to: tied by their outlines, both ends are drawn on it', () => {
    const { start, hand, tool, board, did } = drawing(NOTES);
    // From just right of the first note, down to just left of the second: the nearest step is 15 degrees.
    const press = start([310, 20], [595, 95], { shift: true });
    const shape = hand.get().shape as { from: readonly [number, number]; to: readonly [number, number] };
    // To a hundredth of a degree: a tie keeps its spot to four places of its thing's size.
    expect((Math.atan2(shape.to[1] - shape.from[1], shape.to[0] - shape.from[0]) * 180) / Math.PI).toBeCloseTo(15, 2);
    // Both ends hold their notes, and are drawn short of them: not where the pointer went down and is.
    expect(shape.from[0]).toBeCloseTo(306.5, 9);
    expect(shape.to[0]).toBeCloseTo(593.5, 9);
    // The tail is on the ray through where the press went down.
    expect((shape.from[1] - 20) / (shape.from[0] - 310)).toBeCloseTo(Math.tan((15 * Math.PI) / 180), 2);
    tool.up(press, board);
    expect(arrowOf(did.labels.at(-1)).ties).toMatchObject({ from: { target: { item: 'm1' }, tie: { mode: 'outline' } }, to: { target: { item: 'm2' }, tie: { mode: 'outline' } } });
  });

  it(`an arrow shorter than ${MIN_ARROW} screen pixels is dropped: 19 is, 20 is kept`, () => {
    expect(MIN_ARROW).toBe(20);
    const one = drawing([]);
    expect(one.draw([0, 0], [19, 0])).toBeUndefined();
    expect(one.hand.get().shape).toBeUndefined();
    expect(arrowOf(one.draw([0, 0], [20, 0])).to).toEqual([20, 0]);
    // Counted on the screen: at 200%, 10 units is 20 pixels.
    const two = drawing([], 2);
    expect(two.draw([0, 0], [9.5, 0])).toBeUndefined();
    expect(two.draw([0, 0], [10, 0])).toBeDefined();
  });

  it('the arrow is drawn while the pointer is down as it will be once saved: tied, its head stopped short of the thing', () => {
    const { start, hand } = drawing(NOTES);
    start([150, 50], [585, 50]);
    const boxOf = (t: { item: string }) => NOTES.find((r) => r.item === t.item)?.box;
    const fromTie = tieAt([150, 50], [585, 50], NOTES, 15, boxOf);
    const toTie = tieAt([585, 50], [150, 50], NOTES, 15, boxOf);
    const [a, b] = drawnEnds(aimOf([150, 50], fromTie), aimOf([585, 50], toTie));
    expect(hand.get().shape).toEqual({ kind: 'arrow', from: a, to: b });
    expect(b).toEqual([593.5, 50]);
  });

  it('the thing the end would tie to is outlined while the pointer is down, and the outline goes when the press ends', () => {
    const { start, tool, board, hand } = drawing(NOTES);
    const press = start([150, 50], [585, 50]);
    expect(hand.highlight.get()).toEqual([600, 0, 300, 100]);
    // Off every thing: no outline.
    const off: Sample = { x: 450, y: 300, wx: 450, wy: 300, pressure: 0.5, t: 2 };
    press.samples = [off];
    press.at = off;
    tool.move(press, board);
    expect(hand.highlight.get()).toBeUndefined();
    const on: Sample = { x: 700, y: 50, wx: 700, wy: 50, pressure: 0.5, t: 3 };
    press.samples = [on];
    press.at = on;
    tool.move(press, board);
    expect(hand.highlight.get()).toEqual([600, 0, 300, 100]);
    tool.up(press, board);
    expect(hand.highlight.get()).toBeUndefined();
  });

  it('a cancel takes the outline and the arrow away, and gives back what was selected', () => {
    const { start, tool, board, hand, did } = drawing(NOTES);
    const press = start([150, 50], [585, 50]);
    expect(did.selection).toEqual([]);
    tool.cancel(press, board, 'escape');
    expect(hand.highlight.get()).toBeUndefined();
    expect(hand.get().shape).toBeUndefined();
    expect(did.selection).toEqual(['m1']);
  });

  it('Cmd pressed with the pointer still lets go of both things at once: the outline goes and the arrow is drawn free', async () => {
    const { start, hand, tool, board } = drawing(NOTES);
    // The tail just outside the first note: tied, each end is drawn 6.5 short of its note, on the line the hand drew.
    const press = start([305, 50], [585, 50]);
    expect(hand.highlight.get()).toBeDefined();
    expect(hand.get().shape).toEqual({ kind: 'arrow', from: [306.5, 50], to: [593.5, 50] });
    Keyboard.keyDown('Meta');
    expect(hand.highlight.get()).toBeUndefined();
    expect(hand.get().shape).toEqual({ kind: 'arrow', from: [305, 50], to: [585, 50] });
    Keyboard.keyUp('Meta');
    expect(hand.highlight.get()).toBeDefined();
    tool.up(press, board);
  });

  it('Shift held as the pointer lifts, with no key seen before, holds the arrow to its step', () => {
    const { start, tool, board, did, hand } = drawing([]);
    const press = start([0, 0], [200, 10]);
    press.mods = { ...NO_KEYS, shift: true };
    tool.up(press, board);
    expect(arrowOf(did.labels.at(-1)).to).toEqual([200, 0]);
    expect(hand.get().shape).toEqual({ kind: 'arrow', from: [0, 0], to: [200, 0] });
  });

  it('where a thing is drawn is read from the board once a press, however many times the end passes over it', () => {
    const { start, tool, board } = drawing(NOTES);
    let reads = 0;
    const read = board.targetBox;
    board.targetBox = (t) => {
      reads += 1;
      return read(t);
    };
    const press = start([150, 50], [585, 50]);
    for (const x of [590, 650, 700, 450, 700]) {
      const s: Sample = { x, y: 50, wx: x, wy: 50, pressure: 0.5, t: x };
      press.samples = [s];
      press.at = s;
      tool.move(press, board);
    }
    tool.up(press, board);
    expect(reads).toBe(2);
  });

  it('Cmd held as the pointer lifts, with no key seen before, ties to nothing', () => {
    const { start, tool, board, did } = drawing(NOTES);
    const press = start([150, 50], [700, 50]);
    press.mods = { ...NO_KEYS, meta: true };
    tool.up(press, board);
    expect(arrowOf(did.labels.at(-1)).ties).toEqual({});
  });

  it('an arrow hangs on the thing it points at, else on the thing it starts from; two ends in one picture hang it on the picture', () => {
    expect(arrowHangsOn({ item: 'm1' }, { item: 'm2' })).toEqual({ item: 'm2' });
    expect(arrowHangsOn({ item: 'm1' }, undefined)).toEqual({ item: 'm1' });
    expect(arrowHangsOn(undefined, { item: 'p1', sub: 'part:b' })).toEqual({ item: 'p1', sub: 'part:b' });
    expect(arrowHangsOn(undefined, undefined)).toBeUndefined();
    // Between two parts of one picture, or from the picture to a part of it: on the picture.
    expect(arrowHangsOn({ item: 'p1', sub: 'part:a' }, { item: 'p1', sub: 'part:b' })).toEqual({ item: 'p1' });
    expect(arrowHangsOn({ item: 'p1' }, { item: 'p1', sub: 'part:b' })).toEqual({ item: 'p1' });
    // Both ends on the one part: on the part.
    expect(arrowHangsOn({ item: 'p1', sub: 'part:a' }, { item: 'p1', sub: 'part:a' })).toEqual({ item: 'p1', sub: 'part:a' });
    // Parts of two pictures: on the part it points at.
    expect(arrowHangsOn({ item: 'p1', sub: 'part:a' }, { item: 'p2', sub: 'part:a' })).toEqual({ item: 'p2', sub: 'part:a' });
  });

  it('the arrow posted holds what it was tied to as it was drawn; one drawn before (a label brought back) ties to what is under it now', () => {
    const boxOf = (t: { item: string }) => NOTES.find((r) => r.item === t.item)?.box;
    const tied = arrowItem('a1', [150, 50], [700, 50], NOTES, boxOf, 'why', { to: { target: { item: 'm2' }, tie: { at: [0.5, 0.5], mode: 'outline' } } });
    expect(tied).toMatchObject({ toTarget: { item: 'm2' }, toTie: { at: [0.5, 0.5], mode: 'outline' } });
    expect(tied.fromTarget).toBeUndefined();
    expect(arrowItem('a1', [150, 50], [585, 50], NOTES, boxOf)).toMatchObject({
      fromTarget: { item: 'm1' },
      fromTie: { at: [0.5, 0.5], mode: 'inside' },
      toTarget: { item: 'm2' },
      toTie: { at: [0.5, 0.5], mode: 'outline' },
      anchor: { item: 'm2', box: [600, 0, 300, 100] },
    });
  });
});

/* ------------------------------------------------------------ the rules of a change */

/** A board with three notes, and an arrow from the middle of the first to the outline of the second. */
function tiedState() {
  const b = openBoard();
  b.must('owner', note('m1', [0, 0, 320, 100]));
  b.must('owner', note('m2', [600, 0, 200, 100]));
  b.must('owner', note('m3', [600, 300, 200, 100]));
  b.must('owner', { type: 'item.add', chapter: CH, item: TIED });
  return b;
}

const TIED: ArrowItem = {
  id: 'a1',
  kind: 'arrow',
  box: [160, 50, 440, 0],
  from: [0, 0],
  to: [440, 0],
  fromTarget: { item: 'm1' },
  fromTie: { at: [0.5, 0.5], mode: 'inside' },
  toTarget: { item: 'm2' },
  toTie: { at: [0, 0.5], mode: 'outline' },
  text: 'why',
  anchor: { item: 'm2', box: [600, 0, 200, 100] },
};

describe('an end set again, as a rule', () => {
  const where = () => ({ state: tiedState().state, boxes: new Map<Id, Box>(), subs: new Map<string, Box>() });
  /** Where a thing is drawn, as the board with the three notes has it. */
  const boxOf = (t: Target) => targetBoxNow(where(), t);
  const onM3 = { target: { item: 'm3' }, tie: { at: [0.25, 0.5] as [number, number], mode: 'inside' as const } };
  const onM1 = { target: { item: 'm1' }, tie: { at: [0.5, 0.5] as [number, number], mode: 'inside' as const } };
  const onM2 = { target: { item: 'm2' }, tie: { at: [0, 0.5] as [number, number], mode: 'outline' as const } };

  it('puts the end at the point, holding what it now holds; the arrow hangs on the thing it now points at, and its box and both ends are counted from there', () => {
    const { item, patch } = withEndAt(where(), TIED, 'to', [650, 350], onM3, boxOf);
    expect(patch).toEqual({
      arrowTo: { at: [490, 300], ...onM3 },
      box: [160, 50, 490, 300],
      arrowFrom: { at: [0, 0], ...onM1 },
      anchor: { item: 'm3', box: [600, 300, 200, 100] },
    });
    expect(item).toMatchObject({ box: [160, 50, 490, 300], from: [0, 0], to: [490, 300], toTarget: { item: 'm3' }, anchor: { item: 'm3' } });
  });

  it('an end that lets go leaves the arrow hung on the thing its other end holds; with neither end holding, on nothing', () => {
    const untied = withEndAt(where(), TIED, 'to', [600, 50], undefined, boxOf);
    expect(untied.patch).toEqual({ box: [160, 50, 440, 0], arrowFrom: { at: [0, 0], ...onM1 }, arrowTo: { at: [440, 0] }, anchor: { item: 'm1', box: [0, 0, 320, 100] } });
    const free = withEndAt(where(), untied.item, 'from', [100, 50], undefined, boxOf);
    expect(free.patch).toEqual({ box: [100, 50, 500, 0], arrowFrom: { at: [0, 0] }, arrowTo: { at: [500, 0] }, anchor: null });
    expect('anchor' in free.item).toBe(false);
    // And an arrow that hangs on nothing, tied again, hangs on what it is tied to.
    expect(withEndAt(where(), free.item, 'to', [650, 350], onM3, boxOf).patch.anchor).toEqual({ item: 'm3', box: [600, 300, 200, 100] });
    // A thing the board cannot say the place of holds nothing up: the arrow hangs on nothing.
    expect(withEndAt(where(), TIED, 'to', [650, 350], onM3, () => undefined).patch.anchor).toBeNull();
  });

  it('while it hangs on the same thing, a change sets that end alone, and the other end with it only when the box round them changes', () => {
    // The head, on the same point, holding the same note at that exact spot now.
    const inside = { target: { item: 'm2' }, tie: { at: [0, 0.5] as [number, number], mode: 'inside' as const } };
    expect(withEndAt(where(), TIED, 'to', [600, 50], inside, boxOf).patch).toEqual({ arrowTo: { at: [440, 0], ...inside } });
    // The tail, put on bare board: the arrow still hangs on the note it points at.
    expect(withEndAt(where(), TIED, 'from', [200, 50], undefined, boxOf).patch).toEqual({
      arrowFrom: { at: [0, 0] },
      box: [200, 50, 400, 0],
      arrowTo: { at: [400, 0], ...onM2 },
    });
  });

  it('an end that holds the same spot of the same thing keeps its own point; another spot of it takes the new point', () => {
    expect(withEndAt(where(), TIED, 'to', [593.5, 50], onM2, boxOf).patch).toEqual({ arrowTo: { at: [440, 0], ...onM2 } });
    const lower = { target: { item: 'm2' }, tie: { at: [0, 0.6] as [number, number], mode: 'outline' as const } };
    expect(withEndAt(where(), TIED, 'to', [593.5, 60], lower, boxOf).patch.arrowTo).toEqual({ at: [433.5, 10], ...lower });
  });

  it('on an arrow that hangs on a thing that has moved since, the end lands under the pointer', () => {
    const b = tiedState();
    b.must('owner', { type: 'item.update', item: 'm2', patch: { box: [600, 100, 200, 100] } });
    const w = { state: b.state, boxes: new Map<Id, Box>(), subs: new Map<string, Box>() };
    // The tail, put on bare board: counted from where the note it hangs on was.
    const tail = withEndAt(w, TIED, 'from', [100, 300], undefined, (t) => targetBoxNow(w, t));
    expect(tail.patch.anchor).toBeUndefined();
    const drawn = { ...w, boxes: new Map<Id, Box>([['a1', tail.item.box]]) };
    expect(arrowEnds(drawn, tail.item, shownBoxOf(drawn, 'a1')!)[0]).toEqual([100, 300]);
    // The head, put on bare board: the arrow hangs on the first note now, and is counted from there.
    const head = withEndAt(w, TIED, 'to', [400, 300], undefined, (t) => targetBoxNow(w, t));
    expect(head.patch.anchor).toEqual({ item: 'm1', box: [0, 0, 320, 100] });
    expect(arrowEnds(w, head.item, shownBox(head.item, (a) => anchorBox(w, a)))[1]).toEqual([400, 300]);
    // With a free tail, hung on another thing: the tail stays where it is drawn, which is where the note it hung on had taken it.
    const freeTail: ArrowItem = { id: 'a1', kind: 'arrow', box: TIED.box, from: TIED.from, to: TIED.to, toTarget: { item: 'm2' }, toTie: { at: [0, 0.5], mode: 'outline' }, anchor: { item: 'm2', box: [600, 0, 200, 100] } };
    const hung = withEndAt(w, freeTail, 'to', [650, 350], onM3, (t) => targetBoxNow(w, t));
    expect(hung.patch.anchor).toEqual({ item: 'm3', box: [600, 300, 200, 100] });
    expect(arrowEnds(w, hung.item, shownBox(hung.item, (a) => anchorBox(w, a)))).toEqual([
      [160, 150],
      [650, 350],
    ]);
  });

  it('on an arrow that hangs on a thing that has moved since, an end that stays tied keeps its own point where it is drawn', () => {
    const b = tiedState();
    b.must('owner', { type: 'item.update', item: 'm2', patch: { box: [600, 100, 200, 100] } });
    const w = { state: b.state, boxes: new Map<Id, Box>(), subs: new Map<string, Box>() };
    const ends = arrowEnds(w, TIED, shownBoxOf(w, 'a1')!);
    expect(ends[0]).toEqual([160, 50]);
    // Moved with the note it hangs on, it lets go of the first note. Both its points are counted from where that note was: the tail from where it was drawn, the head from the arrow's own box as it is drawn, 100 further down.
    expect(letGo(w, TIED, ends, ['from'], 0, 50, new Set(['a1', 'm2'])).patch).toEqual({ box: [160, -50, 440, 100], arrowFrom: { at: [0, 0] }, arrowTo: { at: [440, 100], ...onM2 } });
  });

  it('an end whose thing has been taken off the board holds nothing up, and nothing that stays: the arrow hangs on the thing its other end holds', () => {
    const b = tiedState();
    b.must('owner', { type: 'item.remove', item: 'm2' });
    const w = { state: b.state, boxes: new Map<Id, Box>(), subs: new Map<string, Box>() };
    // The tail put on the third note. The head still names the second, which is gone and may come back: it keeps its hold.
    const { patch } = withEndAt(w, TIED, 'from', [650, 350], onM3, (t) => targetBoxNow(w, t));
    expect(patch.anchor).toEqual({ item: 'm3', box: [600, 300, 200, 100] });
    expect(patch.arrowTo).toEqual({ at: [0, 0], ...onM2 });
    // A move leaves only the first note behind.
    expect(leftBehind(b.state, TIED, new Set(['a1']))).toEqual(['from']);
    expect(leftBehind(tiedState().state, TIED, new Set(['a1']))).toEqual(['from', 'to']);
    expect(leftBehind(tiedState().state, TIED, new Set(['a1', 'm1']))).toEqual(['to']);
    // Moved whole, it lets go of that one, and hangs on nothing.
    const ends = arrowEnds(w, TIED, shownBoxOf(w, 'a1')!);
    expect(letGo(w, TIED, ends, ['from'], 0, 100, new Set(['a1'])).patch).toEqual({ box: [160, 150, 440, 0], arrowFrom: { at: [0, 0] }, arrowTo: { at: [440, 0], ...onM2 }, anchor: null });
  });

  it('an arrow ahead of the log is put in the place of the board’s own, and nothing else is touched; with none to put in, the board is handed back as it is', () => {
    const b = tiedState();
    const slid = applied(TIED, { labelAt: 0.25 });
    const ahead = withArrowsAhead(b.state, new Map([['a1', slid]]));
    expect(ahead.items.a1!.item).toBe(slid);
    expect(ahead.items.m1).toBe(b.state.items.m1);
    expect(ahead.itemOrder).toBe(b.state.itemOrder);
    expect(b.state.items.a1!.item).toEqual(TIED);
    expect(withArrowsAhead(b.state, new Map())).toBe(b.state);
    // An arrow the board does not have is not added.
    expect(withArrowsAhead(b.state, new Map([['gone', slid]]))).toBe(b.state);
  });

  it('a lasso round an arrow whose end the hand holds is drawn round the arrow as the hand has it: where the board then draws it', () => {
    const b = tiedState();
    b.must('owner', { type: 'item.update', item: 'm2', patch: { box: [600, 100, 200, 100] } });
    b.must('owner', { type: 'item.add', chapter: CH, item: { id: 'l1', kind: 'lasso', box: [0, 0, 10, 10], path: [0, 0, 10, 0, 10, 10], targets: [{ item: 'a1' }] } });
    const w = { state: b.state, boxes: new Map<Id, Box>(), subs: new Map<string, Box>() };
    // The head put on bare board: the arrow hangs on the first note now, not on the second, which has moved since the arrow was drawn.
    const change = withEndAt(w, TIED, 'to', [400, 300], undefined, (t) => targetBoxNow(w, t));
    expect(change.patch.anchor).toEqual({ item: 'm1', box: [0, 0, 320, 100] });
    const hand = new MovingStore();
    hand.set({ moved: new Set(), dx: 0, dy: 0, stored: new Map([['a1', change.item.box]]), redraw: new Set(['a1', 'l1']), where: w, guides: [], drawnAs: new Map([['a1', change.item]]), grip: 'to' });
    const inHand = { arrow: hand.drawn('a1'), lasso: hand.drawn('l1') };
    b.must('owner', { type: 'item.update', item: 'a1', patch: change.patch });
    const landed = { ...w, state: b.state };
    expect(inHand.arrow).toEqual({ shown: shownBoxOf(landed, 'a1'), ends: arrowEnds(landed, change.item, shownBoxOf(landed, 'a1')!), item: change.item });
    expect(inHand.arrow!.ends![1]).toEqual([400, 300]);
    expect(inHand.lasso).toEqual({ shown: shownBoxOf(landed, 'l1'), outline: lassoOutline(landed, b.state.items.l1!.item as LassoItem) });
  });

  it('an arrow grabbed by itself holds still at first when either of its ends is tied; grabbed with another thing, or tied to nothing, it does not', () => {
    const b = tiedState();
    b.must('owner', { type: 'item.add', chapter: CH, item: { id: 'a3', kind: 'arrow', box: [160, 350, 440, 0], from: [0, 0], to: [440, 0], toTarget: { item: 'm3' }, toTie: { at: [0, 0.5], mode: 'outline' }, anchor: { item: 'm3', box: [600, 300, 200, 100] } } });
    b.must('owner', { type: 'item.add', chapter: CH, item: { id: 'a4', kind: 'arrow', box: [0, 600, 200, 0], from: [0, 0], to: [200, 0] } });
    const w = { state: b.state, boxes: new Map<Id, Box>(), subs: new Map<string, Box>() };
    const alone = (id: Id) => lettingGo(w, [id], new Set([id]));
    // Tied at both ends, and by its head alone.
    for (const id of ['a1', 'a3']) {
      expect(alone(id).holds(10, 0, 1), id).toBe(true);
      expect(alone(id).holds(11, 0, 1), id).toBe(false);
    }
    expect(alone('a4').holds(5, 0, 1)).toBe(false);
    expect(lettingGo(w, ['a3', 'm1'], new Set(['a3', 'm1'])).holds(5, 0, 1)).toBe(false);
  });

  it('back where the move began, nothing has let go: an arrow lets go once it has moved', () => {
    const letting = lettingGo(where(), ['a1', 'm3'], new Set(['a1', 'm3']));
    expect(letting.changes(0, 0).size).toBe(0);
    expect([...letting.changes(0, 20).keys()]).toEqual(['a1']);
  });

  it('put on a part of a picture, it hangs on the part, where the part is drawn, and both ends land where they are drawn', () => {
    const b = tiedState();
    const w = { state: b.state, boxes: new Map<Id, Box>(), subs: new Map<string, Box>([['m3/part:x', [610.44, 320.66, 50, 40]]]) };
    const onPart = { target: { item: 'm3', sub: 'part:x' as const }, tie: { at: [0.5, 0.5] as [number, number], mode: 'inside' as const } };
    const { item, patch } = withEndAt(w, TIED, 'to', [635.44, 340.66], onPart, (t) => targetBoxNow(w, t));
    // An anchor's box is kept to a tenth of a unit, as every box of a mark is.
    expect(patch.anchor).toEqual({ item: 'm3', sub: 'part:x', box: [610.4, 320.7, 50, 40] });
    const [from, to] = arrowEnds(w, item, shownBox(item, (a) => anchorBox(w, a)));
    expect(from).toEqual([160, 50]);
    expect(to[0]).toBeCloseTo(635.44, 9);
    expect(to[1]).toBeCloseTo(340.66, 9);
  });

  it('is drawn as the board will have it: the change applied by the board gives the very arrow drawn', () => {
    const b = tiedState();
    const { item, patch } = withEndAt(where(), TIED, 'to', [650, 350], onM3, boxOf);
    b.must('owner', { type: 'item.update', item: 'a1', patch });
    expect(b.state.items.a1!.item).toEqual(item);
    const free = withEndAt({ state: b.state, boxes: new Map<Id, Box>(), subs: new Map<string, Box>() }, item, 'to', [400, 400], undefined, boxOf);
    const freed = withEndAt({ state: b.state, boxes: new Map<Id, Box>(), subs: new Map<string, Box>() }, free.item, 'from', [100, 400], undefined, boxOf);
    b.must('owner', { type: 'item.update', item: 'a1', patch: free.patch });
    b.must('owner', { type: 'item.update', item: 'a1', patch: freed.patch });
    expect(b.state.items.a1!.item).toEqual(freed.item);
    expect('anchor' in freed.item).toBe(false);
    const { item: label, patch: labelAt } = { item: applied(TIED, { labelAt: 0.25 }), patch: { labelAt: 0.25 } };
    b.must('owner', { type: 'item.update', item: 'a1', patch: labelAt });
    expect((b.state.items.a1!.item as ArrowItem).labelAt).toBe(label.labelAt);
  });

  it('a change that leaves the arrow as it was changes nothing', () => {
    expect(changesNothing(TIED, withEndAt(where(), TIED, 'to', [600, 50], onM2, boxOf).patch)).toBe(true);
    expect(changesNothing(TIED, withEndAt(where(), TIED, 'to', [600, 50], { target: { item: 'm2' }, tie: { at: [0, 0.6], mode: 'outline' } }, boxOf).patch)).toBe(false);
    expect(changesNothing(TIED, withEndAt(where(), TIED, 'to', [600, 50], undefined, boxOf).patch)).toBe(false);
    // The same spot, held the same way, of another thing: a change.
    expect(changesNothing(TIED, { arrowTo: { at: [440, 0], target: { item: 'm3' }, tie: { at: [0, 0.5], mode: 'outline' } } })).toBe(false);
    expect(changesNothing(TIED, { arrowTo: { at: [440, 0], target: { item: 'm2', sub: 'part:a' }, tie: { at: [0, 0.5], mode: 'outline' } } })).toBe(false);
    // The same spot of the same thing, held another way: a change.
    expect(changesNothing(TIED, { arrowTo: { at: [440, 0], target: { item: 'm2' }, tie: { at: [0, 0.5], mode: 'inside' } } })).toBe(false);
    // The same spot of the same thing, held the same way, from another point: a change. The same in every way: none.
    expect(changesNothing(TIED, { arrowTo: { at: [439, 0], target: { item: 'm2' }, tie: { at: [0, 0.5], mode: 'outline' } } })).toBe(false);
    expect(changesNothing(TIED, { arrowTo: { at: [440, 0], target: { item: 'm2' }, tie: { at: [0, 0.5], mode: 'outline' } } })).toBe(true);
    expect(changesNothing(TIED, { labelAt: 0.5 })).toBe(true);
    expect(changesNothing(TIED, { labelAt: 0.6 })).toBe(false);
    expect(changesNothing(TIED, { box: [160, 50, 440, 1] } satisfies ItemPatch)).toBe(false);
    // Hung on another thing, or on none.
    expect(changesNothing(TIED, { anchor: null })).toBe(false);
    expect(changesNothing(TIED, {})).toBe(true);
  });

  it('an arrow moved whole lets go of what its free ends held, which go on from where they were drawn; holding nothing, it hangs on nothing', () => {
    const w = where();
    const ends = arrowEnds(w, TIED, shownBoxOf(w, 'a1')!);
    expect(ends).toEqual([
      [160, 50],
      [593.5, 50],
    ]);
    expect(letGo(w, TIED, ends, ['from', 'to'], 0, 100, new Set(['a1'])).patch).toEqual({ box: [160, 150, 433.5, 0], arrowFrom: { at: [0, 0] }, arrowTo: { at: [433.5, 0] }, anchor: null });
  });

  it('moved with the thing it hangs on, it lets go of the other end, and that thing takes it along: its own points are counted where they were', () => {
    const w = where();
    const ends = arrowEnds(w, TIED, shownBoxOf(w, 'a1')!);
    const { item, patch } = letGo(w, TIED, ends, ['from'], 0, 100, new Set(['a1', 'm2']));
    expect(patch).toEqual({ box: [160, 50, 440, 0], arrowFrom: { at: [0, 0] }, arrowTo: { at: [440, 0], ...onM2 } });
    // Drawn with the second note moved down by 100, as the move leaves it: the tail has gone down with it.
    const moved = { ...w, boxes: new Map<Id, Box>([['m2', [600, 100, 200, 100]]]) };
    expect(arrowEnds(moved, item, shownBox(item, (a) => anchorBox(moved, a)))).toEqual([
      [160, 150],
      [593.5, 150],
    ]);
  });

  it('moved with the thing it starts from, which it did not hang on, it lets go of the other end and hangs on that thing now, which takes it along', () => {
    const w = where();
    const ends = arrowEnds(w, TIED, shownBoxOf(w, 'a1')!);
    const { item, patch } = letGo(w, TIED, ends, ['to'], 0, 100, new Set(['a1', 'm1']));
    expect(patch).toEqual({ box: [160, 50, 433.5, 0], arrowFrom: { at: [0, 0], ...onM1 }, arrowTo: { at: [433.5, 0] }, anchor: { item: 'm1', box: [0, 0, 320, 100] } });
    const moved = { ...w, boxes: new Map<Id, Box>([['m1', [0, 100, 320, 100]]]) };
    expect(arrowEnds(moved, item, shownBox(item, (a) => anchorBox(moved, a)))).toEqual([
      [160, 150],
      [593.5, 150],
    ]);
  });

  it(`a lone tied arrow stays where it is until it has gone further than ${ARROW_LET_GO} screen pixels either way`, () => {
    expect(ARROW_LET_GO).toBe(10);
    expect(holdsStill(10, 0, 1)).toBe(true);
    expect(holdsStill(10.1, 0, 1)).toBe(false);
    expect(holdsStill(-6, 10, 1)).toBe(true);
    expect(holdsStill(0, -11, 1)).toBe(false);
    // On the screen: at 200%, 5 units is 10 pixels.
    expect(holdsStill(5, 0, 2)).toBe(true);
    expect(holdsStill(5.5, 0, 2)).toBe(false);
  });
});

/* ------------------------------------------------------------ on the board */

type Draft = Record<string, unknown>;

/** The board with these things on it, as the owner sees it, with its notes laid out where their boxes say. */
function open(...drafts: Array<['owner' | 'agent', Draft]>) {
  const b = openBoard();
  for (const [by, d] of drafts) b.must(by, d);
  const src = localSource({ events: b.events });
  const n = src.events.length;
  const view = render(<App source={src} />);
  return { src, ...view, posted: (): BoardEvent[] => src.events.slice(n), board: screen.getByTestId('board') };
}

const owner = (d: Draft): ['owner', Draft] => ['owner', d];
const agent = (d: Draft): ['agent', Draft] => ['agent', d];
const el = (id: Id) => document.querySelector<HTMLElement>(`[data-item="${id}"]`)!;

function camera() {
  const t = document.querySelector<HTMLElement>('.world')!.style.transform;
  const m = /translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)/.exec(t)!;
  return { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) };
}

function pageAt(wx: number, wy: number): [number, number] {
  const c = camera();
  return [wx * c.z + c.x, wy * c.z + c.y];
}

/** Let the page lay these things out where their boxes say, by the camera of the moment: a test page lays nothing out. */
function layOut(...ids: Id[]) {
  for (const id of ids) {
    el(id).getBoundingClientRect = () => {
      const [x, y, w, h] = el(id).dataset.box!.split(',').map(Number) as [number, number, number, number];
      const c = camera();
      return DOMRect.fromRect({ x: x * c.z + c.x, y: y * c.z + c.y, width: w * c.z, height: h * c.z });
    };
  }
}

const settle = () => act(async () => {});
const arrowPath = (id: Id) => el(id).querySelector('path')!.getAttribute('d');
const theArrow = (src: ReturnType<typeof localSource>, id: Id) => src.state.items[id]!.item as ArrowItem;
const patches = (events: BoardEvent[]) => events.flatMap((e) => (e.type === 'item.update' ? [e.patch] : []));
const endHandle = (which: 'from' | 'to') => document.querySelector<HTMLElement>(`.end-handle[data-end="${which}"]`)!;

/** Hold every post back, as a board across a wire does; the answer lets the oldest one land. */
function holdPosts(src: ReturnType<typeof localSource>) {
  const waiting: Array<() => void> = [];
  const post = src.post;
  src.post = (draft) => new Promise((done) => waiting.push(() => done(post(draft))));
  return () => act(async () => waiting.shift()?.());
}
const outline = () => screen.getByTestId('tie-outline');

/** The board with three notes and the tied arrow, the arrow selected, and the notes laid out. */
async function tiedOnBoard(...more: Array<['owner' | 'agent', Draft]>) {
  const opened = open(owner(note('m1', [0, 0, 320, 100])), owner(note('m2', [600, 0, 200, 100])), owner(note('m3', [600, 300, 200, 100])), owner({ type: 'item.add', chapter: CH, item: TIED }), ...more);
  layOut('m1', 'm2', 'm3');
  new Pointer().on(el('a1')).click(pageAt(300, 50));
  await settle();
  return opened;
}

/** Take an end of the selected arrow by its handle and move it through these world points, keys held as given; lift unless told not to. */
async function dragEnd(at: readonly [number, number], path: ReadonlyArray<readonly [number, number]>, keys: { meta?: boolean } = {}, lift = true) {
  const mouse = new Pointer().on(screen.getByTestId('board'));
  await Keyboard.withModifierKeys(keys, async () => {
    mouse.down(pageAt(at[0], at[1]));
    for (const p of path) {
      mouse.move(pageAt(p[0], p[1]));
      await frame();
    }
    if (lift) mouse.up();
  });
  await settle();
  return mouse;
}

describe('a new arrow on the board', () => {
  it('is posted tied to what its ends landed on, with its words', async () => {
    const { posted } = open(owner(note('m1', [0, 0, 320, 100])), owner(note('m2', [600, 0, 200, 100])));
    layOut('m1', 'm2');
    Keyboard.press('a');
    const mouse = new Pointer().on(screen.getByTestId('board'));
    mouse.down(pageAt(160, 50));
    mouse.move(pageAt(400, 50));
    mouse.move(pageAt(590, 50));
    await frame();
    // While it is drawn, the second note is outlined, and the head stops short of it.
    expect(outline().hidden).toBe(false);
    expect(document.querySelector('[data-testid="live"] path')!.getAttribute('d')).toBe('M 160 50 L 593.5 50');
    expect(document.querySelector('[data-testid="live"] .line-mark__head')!.getAttribute('d')).toBe(headPath([160, 50], [593.5, 50]));
    mouse.up();
    expect(outline().hidden).toBe(true);
    await settle();
    Keyboard.press('Enter');
    await settle();
    const added = posted().find((e) => e.type === 'item.add');
    expect(added?.type === 'item.add' && added.item).toMatchObject({
      kind: 'arrow',
      fromTarget: { item: 'm1' },
      fromTie: { at: [0.5, 0.5], mode: 'inside' },
      toTarget: { item: 'm2' },
      toTie: { at: [0.5, 0.5], mode: 'outline' },
    });
  });

  it('drawn with Cmd held, it is posted tied to nothing', async () => {
    const { posted } = open(owner(note('m1', [0, 0, 320, 100])), owner(note('m2', [600, 0, 200, 100])));
    layOut('m1', 'm2');
    Keyboard.press('a');
    const mouse = new Pointer().on(screen.getByTestId('board'));
    await Keyboard.withModifierKeys({ meta: true }, async () => {
      mouse.down(pageAt(160, 50));
      mouse.move(pageAt(650, 50));
      await frame();
      expect(outline().hidden).toBe(true);
      mouse.up();
    });
    await settle();
    Keyboard.press('Enter');
    await settle();
    const added = posted().find((e) => e.type === 'item.add');
    const item = added?.type === 'item.add' ? added.item : undefined;
    expect(item && 'fromTarget' in item).toBe(false);
    expect(item && 'toTarget' in item).toBe(false);
  });
});

describe('an end dragged by its handle', () => {
  it('the arrow selected alone has a handle on each end, in the overlay, on its ends as drawn', async () => {
    await tiedOnBoard();
    const c = camera();
    const placed = (h: HTMLElement) => h.style.transform;
    expect(endHandle('to').hidden).toBe(false);
    expect(placed(endHandle('to'))).toBe(`translate(${Math.round(593.5 * c.z + c.x - 4)}px, ${Math.round(50 * c.z + c.y - 4)}px)`);
    expect(placed(endHandle('from'))).toBe(`translate(${Math.round(160 * c.z + c.x - 4)}px, ${Math.round(50 * c.z + c.y - 4)}px)`);
    // A note selected has none.
    new Pointer().on(el('m3')).click(pageAt(700, 350));
    await settle();
    expect(document.querySelector('.end-handle')).toBeNull();
  });

  it('dragged to another thing, it ties to it and posts one change with that end; the arrow is open for the agent again', async () => {
    const { src, posted } = await tiedOnBoard(agent(text('p1', { answers: ['a1'] })));
    expect(isAnswered(src.state, 'a1')).toBe(true);
    await dragEnd([593.5, 50], [
      [620, 200],
      [650, 350],
    ]);
    // It hangs on the thing it points at now, and says so in the same change.
    expect(patches(posted())).toEqual([
      {
        arrowTo: { at: [490, 300], target: { item: 'm3' }, tie: { at: [0.25, 0.5], mode: 'inside' } },
        box: [160, 50, 490, 300],
        arrowFrom: { at: [0, 0], target: { item: 'm1' }, tie: { at: [0.5, 0.5], mode: 'inside' } },
        anchor: { item: 'm3', box: [600, 300, 200, 100] },
      },
    ]);
    expect(isAnswered(src.state, 'a1')).toBe(false);
    expect(arrowPath('a1')).toBe('M 160 50 L 650 350');
  });

  it('what is drawn while the pointer is down is what lands, and the thing it would tie to is outlined until it lifts', async () => {
    await tiedOnBoard();
    const mouse = await dragEnd([593.5, 50], [[650, 350]], {}, false);
    expect(arrowPath('a1')).toBe('M 160 50 L 650 350');
    expect(outline().hidden).toBe(false);
    // The handle goes with the end.
    const c = camera();
    expect(endHandle('to').style.transform).toBe(`translate(${Math.round(650 * c.z + c.x - 4)}px, ${Math.round(350 * c.z + c.y - 4)}px)`);
    mouse.up();
    await settle();
    expect(outline().hidden).toBe(true);
    expect(arrowPath('a1')).toBe('M 160 50 L 650 350');
  });

  it('on an arrow that hung on a thing which has moved since, an end put on bare board is drawn under the pointer while it is held, and lands there', async () => {
    // The second note went down by 100 after the arrow was drawn: the arrow is counted from where the note was.
    open(
      owner(note('m1', [0, 0, 320, 100])),
      owner(note('m2', [600, 0, 200, 100])),
      owner(note('m3', [600, 300, 200, 100])),
      owner({ type: 'item.add', chapter: CH, item: TIED }),
      owner({ type: 'item.update', item: 'm2', patch: { box: [600, 100, 200, 100] } }),
    );
    layOut('m1', 'm2', 'm3');
    const drawn = arrowPath('a1')!;
    const head = /L ([-\d.]+) ([-\d.]+)$/.exec(drawn)!.slice(1).map(Number) as [number, number];
    new Pointer().on(el('a1')).click(pageAt((160 + head[0]) / 2, (50 + head[1]) / 2));
    await settle();
    // Off the note onto bare board: the arrow hangs on the first note now, and is counted from there.
    const mouse = await dragEnd(head, [[500, 300]], {}, false);
    expect(arrowPath('a1')).toBe('M 160 50 L 500 300');
    mouse.up();
    await settle();
    expect(arrowPath('a1')).toBe('M 160 50 L 500 300');
  });

  it('Cmd held, it ties to nothing, even on a thing', async () => {
    const { posted } = await tiedOnBoard();
    await dragEnd([593.5, 50], [[650, 350]], { meta: true });
    expect(patches(posted())[0]!.arrowTo).toEqual({ at: [490, 300] });
  });

  it('Cmd held as the pointer lifts, with no key seen before, ties the end to nothing', async () => {
    const { posted } = await tiedOnBoard();
    const mouse = await dragEnd([593.5, 50], [[650, 350]], {}, false);
    Keyboard.withModifierKeys({ meta: true }, () => mouse.up());
    await settle();
    expect(patches(posted())[0]!.arrowTo).toEqual({ at: [490, 300] });
  });

  it('the board takes the pointer once the press is a drag, so the end follows it off the board', async () => {
    await tiedOnBoard();
    const b = screen.getByTestId('board') as HTMLElement & { setPointerCapture: (id: number) => void };
    const captured: number[] = [];
    b.setPointerCapture = (id: number) => captured.push(id);
    const mouse = await dragEnd([593.5, 50], [[650, 350]], {}, false);
    expect(captured).toHaveLength(1);
    mouse.up();
    await settle();
  });

  it('taken off the outline of a thing and put on that thing at the same spot, it holds it exactly there', async () => {
    const { posted } = await tiedOnBoard();
    // The head holds the second note by its outline at (0, 0.5): put it on the note's edge, at that very spot.
    await dragEnd([593.5, 50], [
      [597, 60],
      [600, 50],
    ]);
    expect(patches(posted())[0]?.arrowTo).toEqual({ at: [440, 0], target: { item: 'm2' }, tie: { at: [0, 0.5], mode: 'inside' } });
  });

  it('on a board laid out by hand: it reads where a thing is drawn once a press, takes the pointer, and tells the board a drag ended', async () => {
    const f = fakeBoard();
    const b = tiedState();
    const boxes = new Map<Id, Box>([
      ['m1', [0, 0, 320, 100]],
      ['m2', [600, 0, 200, 100]],
      ['m3', [600, 300, 200, 100]],
      ['a1', TIED.box],
    ]);
    f.board.state = () => b.state;
    f.board.boxes = () => boxes;
    f.board.where = () => ({ state: b.state, boxes, subs: new Map() });
    f.board.measure = () => [rect('m1', [0, 0, 320, 100]), rect('m2', [600, 0, 200, 100]), rect('m3', [600, 300, 200, 100])];
    const reads: Id[] = [];
    f.board.targetBox = (t) => {
      reads.push(t.item);
      return boxes.get(t.item);
    };
    f.board.select('a1');
    const tool = selectTool();
    const press = pressAt(593.5, 50);
    expect(tool.down(press, f.board)).toBe(true);
    for (const [x, y] of [[620, 200], [650, 350], [660, 350], [650, 340], [670, 360]] as const) {
      moveTo(press, x, y);
      tool.move(press, f.board);
    }
    tool.up(press, f.board);
    expect(f.did.sent).toHaveLength(1);
    // Once a thing, however often the end passes over it: the note the arrow would hang on with its head free, and the note the head lands on.
    expect(reads).toEqual(['m1', 'm3']);
    expect(f.did.dragEnds).toBe(1);
    expect(f.did.captured).toEqual([7]);
    // The arrow is drawn as it was dropped until the board has answered, and is let go by the very arrow that was set.
    expect(f.did.pendingArrows[0]).toMatchObject(['a1', { toTarget: { item: 'm3' } }]);
    expect(f.did.arrowsAhead.get('a1')).toBe(f.did.pendingArrows[0]![1]);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.did.arrowsAhead.size).toBe(0);
  });

  it('put on a part of a picture that no mark holds yet, it is drawn on the part while it is held: the page has not measured the part, and the hand has', () => {
    const f = fakeBoard();
    const b = tiedState();
    const boxes = new Map<Id, Box>([
      ['m1', [0, 0, 320, 100]],
      ['m2', [600, 0, 200, 100]],
      ['m3', [600, 300, 200, 100]],
      ['a1', TIED.box],
    ]);
    const part: TargetRect = { id: 'm3/part:x', item: 'm3', sub: 'part:x', parent: 'm3', box: [650, 320, 100, 60] };
    f.board.state = () => b.state;
    f.board.boxes = () => boxes;
    f.board.where = () => ({ state: b.state, boxes, subs: new Map() });
    f.board.measure = () => [rect('m1', [0, 0, 320, 100]), rect('m2', [600, 0, 200, 100]), rect('m3', [600, 300, 200, 100]), part];
    f.board.targetBox = (t) => (t.sub ? part.box : boxes.get(t.item));
    f.board.select('a1');
    const tool = selectTool();
    const press = pressAt(593.5, 50);
    tool.down(press, f.board);
    for (const [x, y] of [[620, 200], [700, 350]] as const) {
      moveTo(press, x, y);
      tool.move(press, f.board);
    }
    const drawn = f.board.moving.drawn('a1')!;
    // It hangs on the part now, and is counted from where the part is.
    expect(drawn.item).toMatchObject({ toTarget: { item: 'm3', sub: 'part:x' }, toTie: { at: [0.5, 0.5], mode: 'inside' }, anchor: { item: 'm3', sub: 'part:x', box: [650, 320, 100, 60] } });
    expect(drawn.shown).toEqual([160, 50, 540, 300]);
    expect(drawn.ends).toEqual([
      [160, 50],
      [700, 350],
    ]);
    tool.cancel(press, f.board, 'escape');
  });

  it('zoomed out, it ties from further off, as the reach grows', async () => {
    const { posted } = await tiedOnBoard();
    for (let i = 0; i < 8; i++) wheel(screen.getByTestId('board'), { dy: 10, ctrl: true, at: pageAt(400, 200) });
    await frame();
    expect(camera().z).toBeLessThan(0.5);
    // 18 units short of the third note's left edge: out of reach at 100%, in reach here.
    await dragEnd([593.5, 50], [
      [590, 200],
      [582, 350],
    ]);
    const to = patches(posted())[0]?.arrowTo;
    expect(to).toMatchObject({ target: { item: 'm3' }, tie: { mode: 'outline' } });
    // Its spot is on the line from the tail's spot through where the end was put, inside the note.
    const [sx, sy] = [600 + to!.tie!.at[0] * 200, 300 + to!.tie!.at[1] * 100];
    expect((sy - 50) / (sx - 160)).toBeCloseTo((350 - 50) / (582 - 160), 3);
    expect(sx).toBeGreaterThan(600);
  });

  it('with two things selected, there are no end handles', async () => {
    await tiedOnBoard();
    Keyboard.withModifierKeys({ shift: true }, () => new Pointer().on(el('m3')).click(pageAt(700, 350)));
    await settle();
    expect(document.querySelectorAll('.ring, [data-ring]').length).toBe(2);
    expect(document.querySelector('.end-handle')).toBeNull();
  });

  it('Cmd pressed with the pointer still lets go of the thing at once', async () => {
    await tiedOnBoard();
    const mouse = await dragEnd([593.5, 50], [[650, 350]], {}, false);
    expect(outline().hidden).toBe(false);
    Keyboard.keyDown('Meta');
    await frame();
    expect(outline().hidden).toBe(true);
    Keyboard.keyUp('Meta');
    await frame();
    expect(outline().hidden).toBe(false);
    mouse.up();
    await settle();
  });

  it('an arrow taken off the board in the middle of the drag is not posted', async () => {
    const { src, posted } = await tiedOnBoard();
    const mouse = await dragEnd([593.5, 50], [[650, 350]], {}, false);
    await act(async () => {
      await src.postAs('owner', { type: 'item.remove', item: 'a1' });
    });
    mouse.up();
    await settle();
    expect(posted().map((e) => e.type)).toEqual(['item.remove']);
    // Nothing was sent for it: the board has nothing to refuse.
    expect(screen.queryByTestId('toast')).toBeNull();
  });

  it('on a short arrow with both ends in reach, the head’s handle is taken', async () => {
    const short: ArrowItem = { id: 'a2', kind: 'arrow', box: [1000, 600, 12, 0], from: [0, 0], to: [12, 0] };
    const { posted } = open(owner({ type: 'item.add', chapter: CH, item: short }));
    new Pointer().on(el('a2')).click(pageAt(1006, 600));
    await settle();
    await dragEnd([1006, 600], [[1100, 650]]);
    const p = patches(posted())[0]!;
    // The head goes as far as the pointer went, from where it was; the tail stays.
    expect([p.box![0] + p.arrowTo!.at[0], p.box![1] + p.arrowTo!.at[1]]).toEqual([1012 + 94, 600 + 50]);
    expect([p.box![0], p.box![1]]).toEqual([1000, 600]);
  });

  it('the words of another arrow are not the label of the one selected', async () => {
    const other: ArrowItem = { id: 'a2', kind: 'arrow', box: [0, 600, 400, 0], from: [0, 0], to: [400, 0], text: 'other' };
    const { posted } = await tiedOnBoard(owner({ type: 'item.add', chapter: CH, item: other }));
    const label = document.querySelector<HTMLElement>('[data-item="a2"] .line-mark__text')!;
    const mouse = new Pointer().on(label);
    mouse.down(pageAt(200, 600));
    mouse.move(pageAt(150, 600));
    mouse.move(pageAt(100, 600));
    await frame();
    mouse.up();
    await settle();
    expect(patches(posted()).some((p) => p.labelAt !== undefined)).toBe(false);
  });

  it('on a page that only looks, there are no end handles', async () => {
    const b = openBoard();
    b.must('owner', note('m1', [0, 0, 320, 100]));
    b.must('owner', { type: 'item.add', chapter: CH, item: { ...TIED, fromTarget: undefined, fromTie: undefined, toTarget: undefined, toTie: undefined, anchor: undefined } });
    render(<App source={localSource({ events: b.events, role: 'agent' })} />);
    new Pointer().on(el('a1')).click(pageAt(300, 50));
    await settle();
    expect(el('a1').classList.contains('item--selected')).toBe(true);
    expect(document.querySelector('.end-handle')).toBeNull();
  });

  it('Esc puts back what was drawn, and nothing is posted', async () => {
    const { posted } = await tiedOnBoard();
    await dragEnd([593.5, 50], [[650, 350]], {}, false);
    Keyboard.press('Escape');
    await settle();
    expect(arrowPath('a1')).toBe('M 160 50 L 593.5 50');
    expect(outline().hidden).toBe(true);
    new Pointer().on(screen.getByTestId('board')).up(pageAt(650, 350));
    await settle();
    expect(posted()).toEqual([]);
  });

  it('a click on a handle, or a drag that ends where it began, changes nothing', async () => {
    const { posted } = await tiedOnBoard();
    await dragEnd([593.5, 50], []);
    await dragEnd([593.5, 50], [
      [700, 200],
      [593.5, 50],
    ]);
    expect(posted()).toEqual([]);
  });

  it('taken off its middle, the handle carries the end as far as the pointer goes, from where the end was: it does not jump to the pointer', async () => {
    const { posted } = await tiedOnBoard();
    // Pressed 5 units under the head's end, and moved 56.5 right and 295 down: the end goes to (650, 345), not to the pointer at (650, 350).
    const mouse = await dragEnd([593.5, 55], [[650, 350]], {}, false);
    expect(arrowPath('a1')).toBe('M 160 50 L 650 345');
    mouse.up();
    await settle();
    expect(patches(posted())[0]!.arrowTo).toMatchObject({ at: [490, 295], target: { item: 'm3' } });
  });

  it('pressed off its middle and brought back to where it went down, it changes nothing', async () => {
    const { posted } = await tiedOnBoard();
    await dragEnd([593.5, 55], [
      [700, 200],
      [593.5, 55],
    ]);
    expect(posted()).toEqual([]);
    expect(arrowPath('a1')).toBe('M 160 50 L 593.5 50');
  });

  it('on a slanting arrow tied by an outline, a drag back to where it went down changes nothing, and the thing stays outlined', async () => {
    const slanted: ArrowItem = { ...TIED, box: [160, 50, 440, 300], to: [440, 300], toTarget: { item: 'm3' }, toTie: { at: [0.25, 0.5], mode: 'outline' }, anchor: { item: 'm3', box: [600, 300, 200, 100] } };
    const { posted } = open(owner(note('m1', [0, 0, 320, 100])), owner(note('m2', [600, 0, 200, 100])), owner(note('m3', [600, 300, 200, 100])), owner({ type: 'item.add', chapter: CH, item: slanted }));
    layOut('m1', 'm2', 'm3');
    const drawn = arrowPath('a1')!;
    const head = /L ([-\d.]+) ([-\d.]+)$/.exec(drawn)!.slice(1).map(Number) as [number, number];
    // The head stops short of the third note, so it is not on its spot.
    expect(head[0]).toBeLessThan(600);
    new Pointer().on(el('a1')).click(pageAt((160 + head[0]) / 2, (50 + head[1]) / 2));
    await settle();
    const mouse = await dragEnd(head, [[700, 200], head], {}, false);
    expect(arrowPath('a1')).toBe(drawn);
    expect(outline().hidden).toBe(false);
    mouse.up();
    await settle();
    expect(posted()).toEqual([]);
  });

  it(`dragged until the arrow is shorter than ${MIN_ARROW} pixels on the screen, it changes nothing: 19 is too short, 20 is kept`, async () => {
    const free: ArrowItem = { id: 'a2', kind: 'arrow', box: [1000, 600, 200, 0], from: [0, 0], to: [200, 0] };
    const { posted } = open(owner({ type: 'item.add', chapter: CH, item: free }));
    new Pointer().on(el('a2')).click(pageAt(1100, 600));
    await settle();
    const z = camera().z;
    await dragEnd([1200, 600], [
      [1100, 600],
      [1000 + 19 / z, 600],
    ]);
    expect(posted()).toEqual([]);
    expect(arrowPath('a2')).toBe('M 1000 600 L 1200 600');
    // Onto the other end: an arrow with no length.
    await dragEnd([1200, 600], [
      [1100, 600],
      [1000, 600],
    ]);
    expect(posted()).toEqual([]);
    await dragEnd([1200, 600], [
      [1100, 600],
      [1000 + 20 / z, 600],
    ]);
    expect(patches(posted())).toHaveLength(1);
  });

  it('too short is counted on the screen: zoomed in, an arrow 21 pixels long is kept, though it is under 20 units', async () => {
    const free: ArrowItem = { id: 'a2', kind: 'arrow', box: [1000, 600, 200, 0], from: [0, 0], to: [200, 0] };
    const { posted } = open(owner({ type: 'item.add', chapter: CH, item: free }));
    new Pointer().on(el('a2')).click(pageAt(1100, 600));
    await settle();
    zoomBy(5);
    await frame();
    const z = camera().z;
    expect(z).toBeGreaterThan(1.5);
    await dragEnd([1200, 600], [
      [1100, 600],
      [1000 + 21 / z, 600],
    ]);
    expect(patches(posted())).toHaveLength(1);
  });

  it('after the lift it stays drawn where it was dropped until the board has answered, and then as the board has it', async () => {
    const { src } = await tiedOnBoard();
    const land = holdPosts(src);
    const mouse = await dragEnd([593.5, 50], [[650, 350]], {}, false);
    mouse.up();
    await settle();
    // The log still has the old arrow; the page draws the new one, and its handle is on the new end.
    expect(theArrow(src, 'a1')).toEqual(TIED);
    expect(arrowPath('a1')).toBe('M 160 50 L 650 350');
    const c = camera();
    expect(endHandle('to').style.transform).toBe(`translate(${Math.round(650 * c.z + c.x - 4)}px, ${Math.round(350 * c.z + c.y - 4)}px)`);
    await land();
    expect(theArrow(src, 'a1')).toMatchObject({ toTarget: { item: 'm3' } });
    expect(arrowPath('a1')).toBe('M 160 50 L 650 350');
    // Nothing is left drawn ahead of the log: Undo shows, once the board has answered it too.
    Keyboard.press('z', 'KeyZ', { meta: true });
    await settle();
    await land();
    expect(theArrow(src, 'a1')).toEqual(TIED);
    expect(arrowPath('a1')).toBe('M 160 50 L 593.5 50');
  });

  it('a second drag begun before the board has answered the first takes the arrow as it is drawn', async () => {
    const { src, posted } = await tiedOnBoard();
    const land = holdPosts(src);
    await dragEnd([593.5, 50], [[650, 350]]);
    // The tail, taken from the first note to bare board under it, while the head's change is still on its way.
    await dragEnd([160, 50], [[160, 200]]);
    await land();
    // The first has landed and the second has not: the arrow is still drawn as the second left it.
    expect(patches(posted())).toHaveLength(1);
    expect(arrowPath('a1')).toBe('M 160 200 L 650 350');
    await land();
    await settle();
    expect(patches(posted())).toHaveLength(2);
    // Both ends are where the hand left them: the second change did not put the head back.
    expect(arrowPath('a1')).toBe('M 160 200 L 650 350');
  });

  /** Take the free arrow `a2` by its line, at x 1100 and height `y`, and move it down by 100. */
  const moveFreeDown = async (y: number) => {
    const mouse = new Pointer().on(screen.getByTestId('board'));
    await Keyboard.withModifierKeys({ meta: true }, async () => {
      mouse.down(pageAt(1100, y));
      mouse.move(pageAt(1100, y + 50));
      mouse.move(pageAt(1100, y + 100));
      await frame();
      mouse.up();
    });
    await settle();
  };
  const FREE: ArrowItem = { id: 'a2', kind: 'arrow', box: [1000, 600, 200, 0], from: [0, 0], to: [200, 0] };
  const freeOnBoard = async () => {
    const opened = open(owner({ type: 'item.add', chapter: CH, item: FREE }));
    new Pointer().on(el('a2')).click(pageAt(1100, 600));
    await settle();
    return opened;
  };

  it('an end dragged before the board has answered a move of the arrow takes the arrow where it is drawn: the other end stays there', async () => {
    const { src, posted } = await freeOnBoard();
    const land = holdPosts(src);
    await moveFreeDown(600);
    expect(arrowPath('a2')).toBe('M 1000 700 L 1200 700');
    // The head, by its handle, while the move is still on its way.
    await dragEnd([1200, 700], [
      [1250, 700],
      [1300, 700],
    ]);
    expect(arrowPath('a2')).toBe('M 1000 700 L 1300 700');
    // The move lands, then the end: at each step the arrow is drawn where the hand left it.
    await land();
    expect(arrowPath('a2')).toBe('M 1000 700 L 1300 700');
    await land();
    await settle();
    expect(patches(posted())).toHaveLength(2);
    expect(theArrow(src, 'a2')).toEqual({ ...FREE, box: [1000, 700, 300, 0], to: [300, 0] });
    expect(arrowPath('a2')).toBe('M 1000 700 L 1300 700');
  });

  it('…and a move begun before the board has answered an end drag takes it the same way', async () => {
    const { src, posted } = await freeOnBoard();
    const land = holdPosts(src);
    await dragEnd([1200, 600], [
      [1250, 600],
      [1300, 600],
    ]);
    await moveFreeDown(600);
    expect(arrowPath('a2')).toBe('M 1000 700 L 1300 700');
    await land();
    expect(arrowPath('a2')).toBe('M 1000 700 L 1300 700');
    await land();
    await settle();
    expect(patches(posted())).toHaveLength(2);
    expect(theArrow(src, 'a2')).toEqual({ ...FREE, box: [1000, 700, 300, 0], to: [300, 0] });
    expect(arrowPath('a2')).toBe('M 1000 700 L 1300 700');
  });

  it('an end that ties again is aimed from the spot the other end holds, not from where that end is drawn, short of its thing', async () => {
    const { src } = await tiedOnBoard();
    // The tail, taken to just above the third note. Its spot there is on the line from the head's spot, on the edge of the second note, through the pointer.
    await dragEnd([160, 50], [
      [400, 200],
      [700, 290],
    ]);
    expect(theArrow(src, 'a1')).toMatchObject({ fromTarget: { item: 'm3' }, fromTie: { at: [0.6034, 0.3966], mode: 'outline' } });
  });

  /** Zoom the board in or out by turns of the wheel with Ctrl, as a pinch does. */
  const zoomBy = (turns: number) => {
    for (let i = 0; i < Math.abs(turns); i++) wheel(screen.getByTestId('board'), { dy: turns > 0 ? -10 : 10, ctrl: true, at: pageAt(400, 200) });
  };

  it('is taken within 11 screen pixels of its end, at any zoom…', async () => {
    expect(END_HANDLE_REACH).toBe(11);
    const { posted } = await tiedOnBoard();
    zoomBy(5);
    await frame();
    expect(camera().z).toBeGreaterThan(1.5);
    await dragEnd([593.5, 50 + 10.5 / camera().z], [[650, 350]]);
    expect(patches(posted())).toHaveLength(1);
  });

  it('…and not past them', async () => {
    const { posted } = await tiedOnBoard();
    zoomBy(5);
    await frame();
    await dragEnd([593.5, 50 + 11.5 / camera().z], [[650, 350]]);
    expect(patches(posted()).some((p) => p.arrowTo)).toBe(false);
  });

  it('a wheel in the middle, with the pointer still, keeps the end under the pointer: it is drawn there at once, and lands there', async () => {
    const { posted, board } = await tiedOnBoard();
    const mouse = await dragEnd([593.5, 50], [[650, 350]], {}, false);
    const page = pageAt(650, 350);
    // Two fingers move the board under a pointer that stands still.
    wheel(board, { dy: 100, at: page });
    await frame();
    const under = { x: (page[0] - camera().x) / camera().z, y: (page[1] - camera().y) / camera().z };
    expect(under.y).not.toBeCloseTo(350, 0);
    expect(arrowPath('a1')).toBe(`M 160 50 L ${Math.round(under.x * 10) / 10} ${Math.round(under.y * 10) / 10}`);
    mouse.up();
    await settle();
    const c = camera();
    const p = patches(posted())[0]!;
    const box = p.box!;
    const at = p.arrowTo!.at;
    expect(box[0] + at[0]).toBeCloseTo((page[0] - c.x) / c.z, 0);
    expect(box[1] + at[1]).toBeCloseTo((page[1] - c.y) / c.z, 0);
  });

  it('Undo of an end put on a thing takes the arrow off what it came to hang on, and Redo hangs it there again', async () => {
    const free: ArrowItem = { id: 'a2', kind: 'arrow', box: [1000, 600, 200, 0], from: [0, 0], to: [200, 0] };
    const { src } = open(owner(note('m3', [600, 300, 200, 100])), owner({ type: 'item.add', chapter: CH, item: free }));
    layOut('m3');
    new Pointer().on(el('a2')).click(pageAt(1100, 600));
    await settle();
    await dragEnd([1200, 600], [
      [900, 500],
      [650, 350],
    ]);
    expect(theArrow(src, 'a2')).toMatchObject({ toTarget: { item: 'm3' }, anchor: { item: 'm3', box: [600, 300, 200, 100] } });
    Keyboard.press('z', 'KeyZ', { meta: true });
    await settle();
    expect(theArrow(src, 'a2')).toEqual(free);
    Keyboard.press('z', 'KeyZ', { meta: true, shift: true });
    await settle();
    expect(theArrow(src, 'a2')).toMatchObject({ toTarget: { item: 'm3' }, anchor: { item: 'm3', box: [600, 300, 200, 100] } });
  });

  it('Undo puts the end back with its tie, and Redo sets it again', async () => {
    const { src } = await tiedOnBoard();
    await dragEnd([593.5, 50], [[650, 350]]);
    expect(theArrow(src, 'a1')).toMatchObject({ toTarget: { item: 'm3' } });
    Keyboard.press('z', 'KeyZ', { meta: true });
    await settle();
    expect(theArrow(src, 'a1')).toEqual(TIED);
    expect(arrowPath('a1')).toBe('M 160 50 L 593.5 50');
    Keyboard.press('z', 'KeyZ', { meta: true, shift: true });
    await settle();
    expect(theArrow(src, 'a1')).toMatchObject({ toTarget: { item: 'm3' }, toTie: { at: [0.25, 0.5], mode: 'inside' }, box: [160, 50, 490, 300] });
  });
});

describe('an arrow moved whole', () => {
  /** Take the arrow by its line, at x 300, and move it down by `dy` world units, with Cmd held so it snaps to nothing. */
  const moveDown = async (dy: number) => {
    const mouse = new Pointer().on(screen.getByTestId('board'));
    await Keyboard.withModifierKeys({ meta: true }, async () => {
      mouse.down(pageAt(300, 50));
      mouse.move(pageAt(300, 50 + dy / 2));
      mouse.move(pageAt(300, 50 + dy));
      await frame();
    });
    return {
      up: async () => {
        Keyboard.withModifierKeys({ meta: true }, () => mouse.up());
        await settle();
      },
    };
  };

  it('after the lift it stays drawn where it was dropped, free, until the board has answered', async () => {
    const { src } = await tiedOnBoard();
    const land = holdPosts(src);
    const held = await moveDown(100);
    expect(arrowPath('a1')).toBe('M 160 150 L 593.5 150');
    await held.up();
    expect(theArrow(src, 'a1')).toEqual(TIED);
    expect(arrowPath('a1')).toBe('M 160 150 L 593.5 150');
    await land();
    expect(theArrow(src, 'a1').toTarget).toBeUndefined();
    expect(arrowPath('a1')).toBe('M 160 150 L 593.5 150');
    // Nothing is left drawn ahead of the log: Undo shows, once the board has answered it too.
    Keyboard.press('z', 'KeyZ', { meta: true });
    await settle();
    await land();
    expect(theArrow(src, 'a1')).toEqual(TIED);
    expect(arrowPath('a1')).toBe('M 160 50 L 593.5 50');
  });

  it(`by itself, keeps its ties until it has gone ${ARROW_LET_GO} pixels: 9 is still a click, 11 lets go`, async () => {
    const { posted } = await tiedOnBoard();
    const z = camera().z;
    const nine = await moveDown(9 / z);
    expect(arrowPath('a1')).toBe('M 160 50 L 593.5 50');
    await nine.up();
    expect(posted()).toEqual([]);
    const eleven = await moveDown(11 / z);
    // Its end handles are not there while it moves.
    expect(endHandle('to').hidden).toBe(true);
    // It goes with the pointer, all the way from where it was taken, its ends off what they held.
    expect(arrowPath('a1')).toBe(`M 160 ${Math.round((50 + 11 / z) * 10) / 10} L 593.5 ${Math.round((50 + 11 / z) * 10) / 10}`);
    await eleven.up();
    const [p] = patches(posted());
    expect(p?.arrowFrom).toEqual({ at: [0, 0] });
    expect(p?.arrowTo).toEqual({ at: [433.5, 0] });
    expect(p?.box?.[1]).toBeCloseTo(50 + 11 / z, 1);
  });

  it('Undo puts its ties back', async () => {
    const { src } = await tiedOnBoard();
    const mouse = await moveDown(100);
    await mouse.up();
    expect(theArrow(src, 'a1').toTarget).toBeUndefined();
    Keyboard.press('z', 'KeyZ', { meta: true });
    await settle();
    expect(theArrow(src, 'a1')).toEqual(TIED);
  });

  it('with the things it points at, it hangs on the one it points at and moves with it: it keeps hold of both', async () => {
    const { src, posted } = await tiedOnBoard();
    Keyboard.withModifierKeys({ shift: true }, () => {
      new Pointer().on(el('m1')).click(pageAt(10, 10));
      new Pointer().on(el('m2')).click(pageAt(700, 50));
    });
    await settle();
    const mouse = new Pointer().on(screen.getByTestId('board'));
    await Keyboard.withModifierKeys({ meta: true }, async () => {
      mouse.down(pageAt(300, 50));
      mouse.move(pageAt(300, 52));
      mouse.move(pageAt(300, 55));
      await frame();
      mouse.up();
    });
    await settle();
    // The two notes move; the arrow is carried by the note it hangs on, and its ends stay tied.
    expect(patches(posted())).toEqual([{ box: [0, 5, 320, 100] }, { box: [600, 5, 200, 100] }]);
    expect(theArrow(src, 'a1')).toMatchObject({ fromTarget: { item: 'm1' }, toTarget: { item: 'm2' } });
  });

  it('with the thing it starts from, which it does not hang on, it keeps hold of that one and lets go of the other at once', async () => {
    const { src } = await tiedOnBoard();
    Keyboard.withModifierKeys({ shift: true }, () => new Pointer().on(el('m1')).click(pageAt(10, 10)));
    await settle();
    const mouse = new Pointer().on(screen.getByTestId('board'));
    await Keyboard.withModifierKeys({ meta: true }, async () => {
      mouse.down(pageAt(300, 50));
      mouse.move(pageAt(300, 52));
      mouse.move(pageAt(300, 55));
      await frame();
      mouse.up();
    });
    await settle();
    expect(theArrow(src, 'a1')).toMatchObject({ fromTarget: { item: 'm1' }, fromTie: { at: [0.5, 0.5], mode: 'inside' } });
    expect(theArrow(src, 'a1').toTarget).toBeUndefined();
    // It hangs on the note it starts from now, and has gone down with it.
    expect(theArrow(src, 'a1').anchor).toEqual({ item: 'm1', box: [0, 0, 320, 100] });
    expect(arrowPath('a1')).toBe('M 160 55 L 593.5 55');
  });

  it('with the thing it points at, on which it hangs, it does the same the other way round: it lets go of the thing it starts from, and goes with the other', async () => {
    const { src, posted } = await tiedOnBoard();
    Keyboard.withModifierKeys({ shift: true }, () => new Pointer().on(el('m2')).click(pageAt(700, 50)));
    await settle();
    const mouse = new Pointer().on(screen.getByTestId('board'));
    await Keyboard.withModifierKeys({ meta: true }, async () => {
      mouse.down(pageAt(300, 50));
      mouse.move(pageAt(300, 52));
      mouse.move(pageAt(300, 55));
      await frame();
    });
    // While the pointer is down it is drawn as it will land: off the first note, down with the second.
    expect(arrowPath('a1')).toBe('M 160 55 L 593.5 55');
    Keyboard.withModifierKeys({ meta: true }, () => mouse.up());
    await settle();
    // The note takes the arrow along, so the arrow's own points are counted where they were.
    expect(patches(posted())).toEqual([
      { box: [160, 50, 440, 0], arrowFrom: { at: [0, 0] }, arrowTo: { at: [440, 0], target: { item: 'm2' }, tie: { at: [0, 0.5], mode: 'outline' } } },
      { box: [600, 5, 200, 100] },
    ]);
    expect(theArrow(src, 'a1').fromTarget).toBeUndefined();
    expect(theArrow(src, 'a1').anchor).toEqual(TIED.anchor);
    expect(arrowPath('a1')).toBe('M 160 55 L 593.5 55');
    // One step for Undo: the note is back, and the arrow holds the first note again.
    Keyboard.press('z', 'KeyZ', { meta: true });
    await settle();
    expect(theArrow(src, 'a1')).toEqual(TIED);
    expect(src.state.items.m2!.item.box).toEqual([600, 0, 200, 100]);
  });

  it('with another thing, dragged away and back to within half a unit of where it began: nothing has moved, so nothing is posted and it lets go of nothing', async () => {
    const { src, posted } = await tiedOnBoard();
    Keyboard.withModifierKeys({ shift: true }, () => new Pointer().on(el('m3')).click(pageAt(700, 350)));
    await settle();
    const mouse = new Pointer().on(screen.getByTestId('board'));
    await Keyboard.withModifierKeys({ meta: true }, async () => {
      mouse.down(pageAt(300, 50));
      mouse.move(pageAt(300, 90));
      mouse.move(pageAt(300.3, 50.3));
      await frame();
      mouse.up();
    });
    await settle();
    expect(posted()).toEqual([]);
    expect(theArrow(src, 'a1')).toEqual(TIED);
    expect(arrowPath('a1')).toBe('M 160 50 L 593.5 50');
  });

  it('with the thing it hangs on, dragged away and back to within half a unit: the thing has not moved, so the arrow it carries lets go of nothing', async () => {
    const { src, posted } = await tiedOnBoard();
    Keyboard.withModifierKeys({ shift: true }, () => new Pointer().on(el('m2')).click(pageAt(700, 50)));
    await settle();
    const mouse = new Pointer().on(screen.getByTestId('board'));
    await Keyboard.withModifierKeys({ meta: true }, async () => {
      mouse.down(pageAt(300, 50));
      mouse.move(pageAt(300, 90));
      mouse.move(pageAt(300.3, 50.3));
      await frame();
      mouse.up();
    });
    await settle();
    expect(posted()).toEqual([]);
    expect(theArrow(src, 'a1')).toEqual(TIED);
  });

  /** Take the second note by its middle and move it 200 to the right. */
  const moveSecondNote = async () => {
    const mouse = new Pointer().on(el('m2'));
    await Keyboard.withModifierKeys({ meta: true }, async () => {
      mouse.down(pageAt(700, 20));
      mouse.move(pageAt(800, 20));
      mouse.move(pageAt(900, 20));
      await frame();
      mouse.up();
    });
    await settle();
  };

  it('once it has let go of a thing, it stays where it is when that thing moves: it hangs on nothing', async () => {
    const { src } = await tiedOnBoard();
    const held = await moveDown(100);
    await held.up();
    expect('anchor' in theArrow(src, 'a1')).toBe(false);
    expect(arrowPath('a1')).toBe('M 160 150 L 593.5 150');
    await moveSecondNote();
    expect(src.state.items.m2!.item.box).toEqual([800, 0, 200, 100]);
    expect(arrowPath('a1')).toBe('M 160 150 L 593.5 150');
  });

  it('an end taken off a thing by its handle does not go where that thing goes any more', async () => {
    const { src } = await tiedOnBoard();
    await dragEnd([593.5, 50], [[560, 200]]);
    // It hangs on the note it starts from now.
    expect(theArrow(src, 'a1').anchor).toEqual({ item: 'm1', box: [0, 0, 320, 100] });
    expect(arrowPath('a1')).toBe('M 160 50 L 560 200');
    await moveSecondNote();
    expect(arrowPath('a1')).toBe('M 160 50 L 560 200');
  });

  it('with another thing, it lets go at once, before it has gone 10 pixels', async () => {
    const { src } = await tiedOnBoard();
    Keyboard.withModifierKeys({ shift: true }, () => new Pointer().on(el('m3')).click(pageAt(700, 350)));
    await settle();
    const mouse = new Pointer().on(screen.getByTestId('board'));
    await Keyboard.withModifierKeys({ meta: true }, async () => {
      mouse.down(pageAt(300, 50));
      mouse.move(pageAt(300, 52));
      mouse.move(pageAt(300, 55));
      await frame();
      mouse.up();
    });
    await settle();
    expect(theArrow(src, 'a1').fromTarget).toBeUndefined();
    expect(theArrow(src, 'a1').toTarget).toBeUndefined();
    expect(theArrow(src, 'a1').box).toEqual([160, 55, 433.5, 0]);
  });

  it('once it has let go, it has let go: brought back to within 10 pixels of where it was taken, it does not take hold again', async () => {
    const { src, posted } = await tiedOnBoard();
    const z = camera().z;
    const near = Math.round((50 + 8 / z) * 10) / 10;
    const mouse = new Pointer().on(screen.getByTestId('board'));
    await Keyboard.withModifierKeys({ meta: true }, async () => {
      mouse.down(pageAt(300, 50));
      mouse.move(pageAt(300, 100));
      await frame();
      expect(arrowPath('a1')).toBe('M 160 100 L 593.5 100');
      // Back to 8 pixels from where the press went down.
      mouse.move(pageAt(300, 50 + 8 / z));
      await frame();
      expect(arrowPath('a1')).toBe(`M 160 ${near} L 593.5 ${near}`);
      mouse.up();
    });
    await settle();
    expect(patches(posted())).toHaveLength(1);
    expect(theArrow(src, 'a1').toTarget).toBeUndefined();
    expect(theArrow(src, 'a1').box[1]).toBeCloseTo(50 + 8 / z, 1);
  });

  it('brought back to where it was taken, it has not moved: nothing is posted, and it holds what it held', async () => {
    const { src, posted } = await tiedOnBoard();
    const mouse = new Pointer().on(screen.getByTestId('board'));
    await Keyboard.withModifierKeys({ meta: true }, async () => {
      mouse.down(pageAt(300, 50));
      mouse.move(pageAt(300, 100));
      await frame();
      mouse.move(pageAt(300, 50));
      await frame();
      expect(arrowPath('a1')).toBe('M 160 50 L 593.5 50');
      mouse.up();
    });
    await settle();
    expect(posted()).toEqual([]);
    expect(theArrow(src, 'a1')).toEqual(TIED);
  });

  it('by itself it goes where the pointer takes it, with no key held: it snaps to nothing, not even to the thing it has just let go of', async () => {
    // Its tail off the middle of the first note, so that no side of its box is in line with anything at first.
    const off: ArrowItem = { ...TIED, box: [128, 50, 472, 0], to: [472, 0], fromTie: { at: [0.4, 0.5], mode: 'inside' } };
    const { src } = open(owner(note('m1', [0, 0, 320, 100])), owner(note('m2', [600, 0, 200, 100])), owner(note('m3', [600, 300, 200, 100])), owner({ type: 'item.add', chapter: CH, item: off }));
    layOut('m1', 'm2', 'm3');
    new Pointer().on(el('a1')).click(pageAt(300, 50));
    await settle();
    expect(arrowPath('a1')).toBe('M 128 50 L 593.5 50');
    const mouse = new Pointer().on(screen.getByTestId('board'));
    mouse.down(pageAt(300, 50));
    mouse.move(pageAt(300, 100));
    mouse.move(pageAt(300, 150));
    await frame();
    // Let go, its head is 6.5 from the second note's side: within reach of a snap, were it to snap.
    expect(arrowPath('a1')).toBe('M 128 150 L 593.5 150');
    mouse.up();
    await settle();
    expect(theArrow(src, 'a1').box).toEqual([128, 150, 465.5, 0]);
  });

  it('moved with another thing, the two line up with what is round them as any things moved together do', async () => {
    const { src } = await tiedOnBoard();
    Keyboard.withModifierKeys({ shift: true }, () => new Pointer().on(el('m3')).click(pageAt(700, 350)));
    await settle();
    const mouse = new Pointer().on(screen.getByTestId('board'));
    // Up by 297: the bottom of the box round the two comes within 3 of the bottom of the other notes, and goes there.
    mouse.down(pageAt(300, 50));
    mouse.move(pageAt(300, -100));
    mouse.move(pageAt(300, -247));
    await frame();
    mouse.up();
    await settle();
    expect(src.state.items.m3!.item.box).toEqual([600, 0, 200, 100]);
    expect(theArrow(src, 'a1').box).toEqual([160, -250, 433.5, 0]);
  });
});

describe('the arrow keys and an arrow', () => {
  /** A click on bare board: what is selected changes, so a run of the keys is posted now. */
  const rest = async () => {
    new Pointer().on(screen.getByTestId('board')).click(pageAt(1200, 900));
    await settle();
  };

  it('do not move an arrow that holds a thing which stays: the key stays the browser’s, and nothing is posted', async () => {
    const { posted } = await tiedOnBoard();
    // `press` answers false when the page took the key.
    expect(Keyboard.press('ArrowDown')).toBe(true);
    expect(Keyboard.press('ArrowDown', 'ArrowDown', { shift: true })).toBe(true);
    expect(arrowPath('a1')).toBe('M 160 50 L 593.5 50');
    await rest();
    expect(posted()).toEqual([]);
  });

  it('selected with one of the notes it holds, they move the note, and the arrow holds on to both', async () => {
    const { src, posted } = await tiedOnBoard();
    Keyboard.withModifierKeys({ shift: true }, () => new Pointer().on(el('m1')).click(pageAt(10, 10)));
    await settle();
    expect(Keyboard.press('ArrowDown')).toBe(false);
    await rest();
    expect(patches(posted())).toEqual([{ box: [0, 1, 320, 100] }]);
    expect(theArrow(src, 'a1')).toEqual(TIED);
    expect(arrowPath('a1')).toBe('M 160 51 L 593.5 50');
  });

  it('selected with both the notes it holds, they move the notes, and the arrow goes with them', async () => {
    const { src, posted } = await tiedOnBoard();
    Keyboard.withModifierKeys({ shift: true }, () => {
      new Pointer().on(el('m1')).click(pageAt(10, 10));
      new Pointer().on(el('m2')).click(pageAt(700, 50));
    });
    await settle();
    expect(Keyboard.press('ArrowDown')).toBe(false);
    await rest();
    expect(patches(posted())).toEqual([{ box: [0, 1, 320, 100] }, { box: [600, 1, 200, 100] }]);
    expect(theArrow(src, 'a1')).toEqual(TIED);
    expect(arrowPath('a1')).toBe('M 160 51 L 593.5 51');
  });

  it('move an arrow that holds nothing', async () => {
    const free: ArrowItem = { id: 'a2', kind: 'arrow', box: [1000, 600, 200, 0], from: [0, 0], to: [200, 0] };
    const { posted } = open(owner({ type: 'item.add', chapter: CH, item: free }));
    new Pointer().on(el('a2')).click(pageAt(1100, 600));
    await settle();
    expect(Keyboard.press('ArrowDown')).toBe(false);
    await rest();
    expect(patches(posted())).toEqual([{ box: [1000, 601, 200, 0] }]);
  });

  it('move an arrow whose things have been taken off the board: it holds nothing that stays', async () => {
    const { posted } = open(
      owner(note('m1', [0, 0, 320, 100])),
      owner(note('m2', [600, 0, 200, 100])),
      owner({ type: 'item.add', chapter: CH, item: TIED }),
      owner({ type: 'item.remove', item: 'm1' }),
      owner({ type: 'item.remove', item: 'm2' }),
    );
    new Pointer().on(el('a1')).click(pageAt(300, 50));
    await settle();
    expect(Keyboard.press('ArrowDown')).toBe(false);
    await rest();
    expect(patches(posted())).toEqual([{ box: [160, 51, 440, 0] }]);
  });
});

describe('the label', () => {
  /** The board with one arrow from (0, 0) to (400, 200), its words at `labelAt`. */
  const labelled = (labelAt?: number) =>
    render(<MarkView item={{ id: 'a1', kind: 'arrow', box: [0, 0, 400, 200], from: [0, 0], to: [400, 200], text: 'why', ...(labelAt === undefined ? {} : { labelAt }) }} shown={[0, 0, 400, 200]} />);
  const placeOf = () => {
    const s = document.querySelector<HTMLElement>('.line-mark__text')!.style;
    return [s.left, s.top];
  };

  it('sits at its share of the line: the middle with none, a quarter and three quarters along', () => {
    labelled();
    expect(placeOf()).toEqual(['200px', '100px']);
    cleanup();
    labelled(0.25);
    expect(placeOf()).toEqual(['100px', '50px']);
    cleanup();
    labelled(0.75);
    expect(placeOf()).toEqual(['300px', '150px']);
  });

  it('the line is drawn whole under it, the same path as with no words: its chip hides it', () => {
    labelled(0.25);
    expect(document.querySelector('.line-mark path')!.getAttribute('d')).toBe('M 0 0 L 400 200');
  });

  it('dragged along the line, posts one change with where it now sits; Undo puts it back', async () => {
    const { src, posted } = await tiedOnBoard();
    const label = document.querySelector<HTMLElement>('[data-item="a1"] .line-mark__text')!;
    const mouse = new Pointer().on(label);
    mouse.down(pageAt(376.75, 50));
    mouse.move(pageAt(300, 80));
    mouse.move(pageAt(268.375, 80));
    await frame();
    // Drawn where it will land while the pointer is down.
    expect(label.style.left).toBe('268.375px');
    mouse.up();
    await settle();
    expect(patches(posted())).toEqual([{ labelAt: 0.25 }]);
    expect(theArrow(src, 'a1').labelAt).toBe(0.25);
    Keyboard.press('z', 'KeyZ', { meta: true });
    await settle();
    // Back in the middle, where it was.
    expect(theArrow(src, 'a1').labelAt).toBe(0.5);
    expect(label.style.left).toBe('376.75px');
  });

  it('taken off its middle, it slides as far as the pointer goes along the line, from where it was: it does not jump to the pointer', async () => {
    const { posted } = await tiedOnBoard();
    const label = document.querySelector<HTMLElement>('[data-item="a1"] .line-mark__text')!;
    const mouse = new Pointer().on(label);
    // Its middle is at 376.75. Taken 40 units to the right of that, and moved 30 further right.
    mouse.down(pageAt(416.75, 50));
    mouse.move(pageAt(430, 50));
    mouse.move(pageAt(446.75, 50));
    await frame();
    mouse.up();
    await settle();
    // 30 of the line's 433.5 further along, to three places. Under the pointer it would be at 0.661.
    expect(patches(posted())).toEqual([{ labelAt: 0.569 }]);
  });

  it('slid away and brought back to where it went down, it changes nothing', async () => {
    const { posted } = await tiedOnBoard();
    const label = document.querySelector<HTMLElement>('[data-item="a1"] .line-mark__text')!;
    const mouse = new Pointer().on(label);
    mouse.down(pageAt(416.75, 50));
    mouse.move(pageAt(500, 60));
    await frame();
    mouse.move(pageAt(416.75, 50));
    await frame();
    expect(label.style.left).toBe('376.75px');
    mouse.up();
    await settle();
    expect(posted()).toEqual([]);
  });

  it('after the lift it stays where it was slid to until the board has answered', async () => {
    const { src } = await tiedOnBoard();
    const land = holdPosts(src);
    const label = () => document.querySelector<HTMLElement>('[data-item="a1"] .line-mark__text')!;
    const mouse = new Pointer().on(label());
    mouse.down(pageAt(376.75, 50));
    mouse.move(pageAt(300, 80));
    mouse.move(pageAt(268.375, 80));
    await frame();
    mouse.up();
    await settle();
    expect(theArrow(src, 'a1').labelAt).toBeUndefined();
    expect(label().style.left).toBe('268.375px');
    await land();
    expect(theArrow(src, 'a1').labelAt).toBe(0.25);
    expect(label().style.left).toBe('268.375px');
  });
});

describe('what the overlay draws for an arrow, and the ring round it', () => {
  /** The declarations of the one rule with exactly this selector in the marks' styles. */
  const rule = (selector: string) => {
    const css = readFileSync(join(__dirname, '../src/styles/marks.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const found = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => m[1]!.trim() === selector);
    expect(found).toHaveLength(1);
    return found[0]![2]!;
  };

  it('the outline of a tie is as wide as the code places it for, in the board’s blue; an end handle as big as a corner handle', () => {
    expect(TIE_LINE).toBe(2);
    expect(rule('.tie-outline')).toContain(`border: ${TIE_LINE}px solid var(--agent)`);
    expect(rule('.end-handle')).toContain(`width: ${HANDLE_SIZE}px; height: ${HANDLE_SIZE}px`);
  });

  it('the label of the arrow selected takes a press; its chip is the ground, so the line does not show through it', () => {
    expect(rule('.item--arrow.item--selected .line-mark__text')).toContain('pointer-events: auto');
    expect(rule('.line-mark__text')).toContain('background: var(--ground)');
  });

  it('the outline is written again only when the thing it is round changes', () => {
    const h = new Highlight();
    let heard = 0;
    h.subscribe(() => (heard += 1));
    h.show([0, 0, 10, 10]);
    h.show([0, 0, 10, 10]);
    expect(heard).toBe(1);
    h.show([0, 0, 10, 11]);
    h.show(undefined);
    h.show(undefined);
    expect(heard).toBe(3);
  });

  it('the ring round a selected arrow goes round its head too', () => {
    const item: ArrowItem = { id: 'a1', kind: 'arrow', box: [0, 100, 300, 0], from: [0, 0], to: [300, 0] };
    const [x, y, w, h] = outlineOf(item, item.box, undefined);
    const half = ARROWHEAD * Math.sin((ARROWHEAD_ANGLE * Math.PI) / 180);
    expect([x, w]).toEqual([0, 300]);
    expect(y).toBeCloseTo(100 - half, 10);
    expect(h).toBeCloseTo(2 * half, 10);
  });

  it('a press on a side of the head lands on the arrow, squarely, as one on its line does', () => {
    const item: ArrowItem = { id: 'a1', kind: 'arrow', box: [0, 0, 400, 0], from: [0, 0], to: [400, 0] };
    const lines: Parameters<typeof lineHit>[0] = { live: [], boxes: new Map([['a1', item.box]]), ends: new Map(), outlines: new Map(), raised: undefined, frameSize: () => undefined };
    const [side, tip] = headPoints([0, 0], [400, 0])!;
    // Three quarters of the way out along one side: at 400% that is 15 pixels from the line, past its slop.
    const p = [tip[0] + 0.75 * (side[0] - tip[0]), tip[1] + 0.75 * (side[1] - tip[1])] as const;
    expect(lineHit(lines, item, 4, p[0], p[1])).toBe('square');
    expect(lineHit(lines, item, 4, 200, 0)).toBe('square');
    // As far from the line on the tail's side, where there is no head: nothing.
    expect(lineHit(lines, item, 4, 100, p[1])).toBeUndefined();
  });

  it('zoomed out, the outline is as wide on the screen as the thing, and two pixels more each side', async () => {
    open(owner(note('m1', [0, 0, 320, 100])), owner(note('m2', [600, 0, 200, 100])));
    layOut('m1', 'm2');
    for (let i = 0; i < 6; i++) wheel(screen.getByTestId('board'), { dy: 10, ctrl: true, at: pageAt(400, 200) });
    await frame();
    const c = camera();
    expect(c.z).toBeLessThan(0.8);
    Keyboard.press('a');
    const mouse = new Pointer().on(screen.getByTestId('board'));
    mouse.down(pageAt(160, 50));
    mouse.move(pageAt(400, 50));
    mouse.move(pageAt(650, 50));
    await frame();
    const left = Math.round(600 * c.z + c.x - TIE_LINE);
    const top = Math.round(0 * c.z + c.y - TIE_LINE);
    expect(outline().style.width).toBe(`${Math.round(800 * c.z + c.x + TIE_LINE) - left}px`);
    expect(outline().style.height).toBe(`${Math.round(100 * c.z + c.y + TIE_LINE) - top}px`);
    mouse.cancel();
  });

  it('the outline is placed just outside the thing on the screen, by the camera', async () => {
    open(owner(note('m1', [0, 0, 320, 100])), owner(note('m2', [600, 0, 200, 100])));
    layOut('m1', 'm2');
    Keyboard.press('a');
    const mouse = new Pointer().on(screen.getByTestId('board'));
    mouse.down(pageAt(160, 50));
    mouse.move(pageAt(400, 50));
    mouse.move(pageAt(650, 50));
    await frame();
    const c = camera();
    const left = Math.round(600 * c.z + c.x - TIE_LINE);
    const top = Math.round(0 * c.z + c.y - TIE_LINE);
    expect(outline().style.transform).toBe(`translate(${left}px, ${top}px)`);
    expect(outline().style.width).toBe(`${Math.round(800 * c.z + c.x + TIE_LINE) - left}px`);
    expect(outline().style.height).toBe(`${Math.round(100 * c.z + c.y + TIE_LINE) - top}px`);
    // The camera moves: the outline goes with the thing, with no move of the pointer.
    wheel(screen.getByTestId('board'), { dy: 40, at: pageAt(400, 300) });
    await frame();
    const c2 = camera();
    expect(outline().style.transform).toBe(`translate(${Math.round(600 * c2.z + c2.x - TIE_LINE)}px, ${Math.round(c2.y - TIE_LINE)}px)`);
    mouse.cancel();
    expect(outline().hidden).toBe(true);
  });
});

describe('the cursor on the board, for an arrow selected', () => {
  const cursor = () => screen.getByTestId('board').style.cursor;
  const hover = async (on: Element, at: readonly [number, number]) => {
    new Pointer().on(on).move(pageAt(at[0], at[1]));
    await frame();
  };

  it('a pointing hand over an end handle and while the end is dragged; an open hand over the label, closed while it slides', async () => {
    await tiedOnBoard();
    await hover(screen.getByTestId('board'), [593.5, 50]);
    expect(cursor()).toBe('pointer');
    const label = document.querySelector<HTMLElement>('[data-item="a1"] .line-mark__text')!;
    // Over the words, away from the line.
    await hover(label, [376.75, 80]);
    expect(cursor()).toBe('grab');
    const mouse = await dragEnd([593.5, 50], [[650, 350]], {}, false);
    expect(cursor()).toBe('pointer');
    mouse.up();
    await settle();
    const slide = new Pointer().on(label);
    slide.down(pageAt(376.75, 50));
    slide.move(pageAt(330, 50));
    slide.move(pageAt(300, 50));
    await frame();
    expect(cursor()).toBe('grabbing');
    slide.up();
    await settle();
  });
});
