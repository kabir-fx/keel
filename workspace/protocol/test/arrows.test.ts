import { describe, expect, it } from 'vitest';
import type { ArrowItem } from '../src';
import { Item, isAnswered, parseLog, replay, withArrowEnd } from '../src';
import { CH, note, openBoard, picture } from './helpers';

/** A board with two notes and one card of the agent's, for arrows to hold on to. */
function board() {
  const b = openBoard();
  b.must('owner', note('m1', 'the first thing'));
  b.must('owner', note('m2', 'the second thing', { box: [600, 100, 300, 120] }));
  b.must('agent', picture('a1', { kind: 'text', title: 'A card' }, { answers: ['m1'] }));
  return b;
}

const arrow = (id: string, extra: Record<string, unknown> = {}) => ({
  type: 'item.add',
  chapter: CH,
  item: { id, kind: 'arrow', box: [400, 150, 200, 10], from: [0, 5], to: [200, 5], ...extra },
});

const update = (item: string, patch: Record<string, unknown>) => ({ type: 'item.update', item, patch });

const arrowOf = (b: ReturnType<typeof board>, id: string) => b.state.items[id]!.item as ArrowItem;

describe('an arrow end that holds on to its target', () => {
  it('keeps a tie on each end: the spot inside the target and how the end is drawn to it', () => {
    const b = board();
    b.must(
      'owner',
      arrow('m3', {
        fromTarget: { item: 'm1' },
        toTarget: { item: 'm2' },
        fromTie: { at: [1, 0.5], mode: 'outline' },
        toTie: { at: [0.25, 0.75], mode: 'inside' },
        labelAt: 0.3,
      }),
    );
    expect(arrowOf(b, 'm3')).toMatchObject({
      fromTie: { at: [1, 0.5], mode: 'outline' },
      toTie: { at: [0.25, 0.75], mode: 'inside' },
      labelAt: 0.3,
    });
  });

  it('survives the log: an arrow with ties reads back as it was written', () => {
    const b = board();
    b.must('owner', arrow('m3', { fromTarget: { item: 'm1' }, fromTie: { at: [0.5, 1], mode: 'outline' } }));
    const { events, problems } = parseLog(b.events.map((e) => JSON.stringify(e)).join('\n'));
    expect(problems).toEqual([]);
    expect(replay(events).items.m3!.item).toEqual(arrowOf(b, 'm3'));
  });

  it('takes an arrow from before ties existed as it is', () => {
    const b = board();
    b.must('owner', arrow('m3', { fromTarget: { item: 'm1' }, toTarget: { item: 'm2' } }));
    const it = arrowOf(b, 'm3');
    expect(it.fromTie).toBeUndefined();
    expect(it.toTie).toBeUndefined();
    expect(it.labelAt).toBeUndefined();
  });

  it('refuses a spot outside the target, an unknown mode, and a tie with no target', () => {
    const b = board();
    const from = { fromTarget: { item: 'm1' } };
    expect(b.refused('owner', arrow('m3', { ...from, fromTie: { at: [1.01, 0.5], mode: 'outline' } })).rule).toBe('shape');
    expect(b.refused('owner', arrow('m3', { ...from, fromTie: { at: [-0.01, 0.5], mode: 'outline' } })).rule).toBe('shape');
    expect(b.refused('owner', arrow('m3', { ...from, fromTie: { at: [0.5, 0.5], mode: 'orbit' } })).rule).toBe('shape');
    expect(b.refused('owner', arrow('m3', { ...from, labelAt: 1.5 })).rule).toBe('shape');
    const lone = b.refused('owner', arrow('m3', { toTie: { at: [0.5, 0.5], mode: 'inside' } }));
    expect(lone.rule).toBe('shape');
    expect(lone.reason).toContain('"to" end');
    // The edges of the target are inside it.
    b.must('owner', arrow('m3', { ...from, fromTie: { at: [0, 1], mode: 'outline' } }));
  });
});

describe('setting an arrow end again', () => {
  const tied = () => {
    const b = board();
    b.must('owner', arrow('m3', { fromTarget: { item: 'm1' }, toTarget: { item: 'm2' }, fromTie: { at: [1, 0.5], mode: 'outline' }, toTie: { at: [0, 0.5], mode: 'outline' } }));
    return b;
  };

  it('replaces the end whole, and leaves the other end as it was', () => {
    const b = tied();
    b.must('owner', update('m3', { box: [400, 150, 300, 200], arrowTo: { at: [300, 200], target: { item: 'a1' }, tie: { at: [0.5, 0], mode: 'inside' } } }));
    expect(arrowOf(b, 'm3')).toMatchObject({
      box: [400, 150, 300, 200],
      from: [0, 5],
      fromTarget: { item: 'm1' },
      fromTie: { at: [1, 0.5], mode: 'outline' },
      to: [300, 200],
      toTarget: { item: 'a1' },
      toTie: { at: [0.5, 0], mode: 'inside' },
    });
  });

  it('lets go of the target when the new end names none', () => {
    const b = tied();
    b.must('owner', update('m3', { arrowFrom: { at: [10, 5] } }));
    const it = arrowOf(b, 'm3');
    expect(it.from).toEqual([10, 5]);
    expect('fromTarget' in it).toBe(false);
    expect('fromTie' in it).toBe(false);
    expect(it.toTarget).toEqual({ item: 'm2' });
    // What is left is still an arrow the schema takes: nothing is left behind as `undefined`.
    expect(Item.safeParse(JSON.parse(JSON.stringify(it))).success).toBe(true);
  });

  it('moves the label along the line', () => {
    const b = tied();
    b.must('owner', update('m3', { labelAt: 0.8 }));
    expect(arrowOf(b, 'm3').labelAt).toBe(0.8);
  });

  it('refuses a new end that names a thing not on the board, or a tie with no target', () => {
    const b = tied();
    expect(b.refused('owner', update('m3', { arrowTo: { at: [0, 0], target: { item: 'nowhere' } } })).rule).toBe('R7');
    expect(b.refused('owner', update('m3', { arrowTo: { at: [0, 0], tie: { at: [0.5, 0.5], mode: 'inside' } } })).rule).toBe('shape');
    expect(arrowOf(b, 'm3').toTarget).toEqual({ item: 'm2' });
  });

  it('is for the arrow of the one who drew it: not for another kind of mark, and not for the agent', () => {
    const b = tied();
    expect(b.refused('owner', update('m1', { arrowTo: { at: [0, 0] } })).rule).toBe('R6');
    expect(b.refused('owner', update('m1', { labelAt: 0.5 })).rule).toBe('R6');
    expect(b.refused('agent', update('m3', { arrowTo: { at: [0, 0] } })).rule).toBe('R6');
    expect(b.refused('agent', update('m3', { labelAt: 0.5 })).rule).toBe('R6');
  });

  it('hangs the arrow on another thing, or on nothing, with `anchor`', () => {
    const b = board();
    b.must('owner', arrow('m3', { toTarget: { item: 'm2' }, toTie: { at: [0, 0.5], mode: 'outline' }, anchor: { item: 'm2', box: [600, 100, 300, 120] } }));
    // The head is put on the card: the arrow hangs on the card now.
    b.must('owner', update('m3', { arrowTo: { at: [200, 5], target: { item: 'a1' } }, anchor: { item: 'a1', box: [0, 0, 400, 300] } }));
    expect(arrowOf(b, 'm3').anchor).toEqual({ item: 'a1', box: [0, 0, 400, 300] });
    // It lets go of everything: it hangs on nothing, and nothing is left behind as `null`.
    b.must('owner', update('m3', { arrowTo: { at: [200, 5] }, anchor: null }));
    const it = arrowOf(b, 'm3');
    expect('anchor' in it).toBe(false);
    expect(Item.safeParse(JSON.parse(JSON.stringify(it))).success).toBe(true);
    // And it survives the log.
    const { events, problems } = parseLog(b.events.map((e) => JSON.stringify(e)).join('\n'));
    expect(problems).toEqual([]);
    expect(replay(events).items.m3!.item).toEqual(it);
  });

  it('refuses an anchor that names a thing not on the board, and one on any mark but the owner’s own arrow', () => {
    const b = tied();
    expect(b.refused('owner', update('m3', { anchor: { item: 'nowhere', box: [0, 0, 10, 10] } })).rule).toBe('R7');
    // An arrow does not hang on itself.
    expect(b.refused('owner', update('m3', { anchor: { item: 'm3', box: [0, 0, 10, 10] } })).rule).toBe('shape');
    expect(b.refused('owner', update('m1', { anchor: null })).rule).toBe('R6');
    expect(b.refused('owner', update('m1', { anchor: { item: 'm2', box: [0, 0, 10, 10] } })).rule).toBe('R6');
    expect(b.refused('agent', update('m3', { anchor: null })).rule).toBe('R6');
    expect('anchor' in arrowOf(b, 'm3')).toBe(false);
  });

  it('a change of the anchor alone is not a new remark', () => {
    const b = tied();
    b.must('agent', picture('a2', { kind: 'text', title: 'How I read the arrow' }, { answers: ['m3'] }));
    b.must('owner', update('m3', { anchor: { item: 'm2', box: [600, 100, 300, 120] } }));
    expect(isAnswered(b.state, 'm3')).toBe(true);
  });

  it('pointing the arrow at another thing is a new remark: what answered it no longer does', () => {
    const b = tied();
    b.must('agent', picture('a2', { kind: 'text', title: 'How I read the arrow' }, { answers: ['m3'] }));
    expect(isAnswered(b.state, 'm3')).toBe(true);
    // The same things, held at another spot: the answer stands.
    b.must('owner', update('m3', { arrowTo: { at: [200, 9], target: { item: 'm2' }, tie: { at: [0, 0.9], mode: 'outline' } } }));
    b.must('owner', update('m3', { labelAt: 0.2 }));
    expect(isAnswered(b.state, 'm3')).toBe(true);
    // Another thing: the arrow says something new.
    b.must('owner', update('m3', { arrowTo: { at: [200, 9], target: { item: 'a1' } } }));
    expect(isAnswered(b.state, 'm3')).toBe(false);
  });
});

describe('withArrowEnd', () => {
  const base: ArrowItem = { id: 'm3', kind: 'arrow', box: [0, 0, 10, 10], from: [0, 0], to: [10, 10], fromTarget: { item: 'm1' }, fromTie: { at: [0.5, 0.5], mode: 'inside' } };

  it('does not change the arrow it is given', () => {
    const copy = structuredClone(base);
    withArrowEnd(base, 'from', { at: [1, 1] });
    expect(base).toEqual(copy);
  });

  it('sets the `to` end and keeps the `from` end', () => {
    expect(withArrowEnd(base, 'to', { at: [9, 9], target: { item: 'm2', sub: 'part:queue' } })).toEqual({
      ...base,
      to: [9, 9],
      toTarget: { item: 'm2', sub: 'part:queue' },
    });
  });
});
