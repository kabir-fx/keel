import type { Box, Target } from '@keel/protocol';
import { emptyState } from '@keel/protocol';
import { describe, expect, it } from 'vitest';
import type { TargetRect, XY } from '../src/geometry';
import { pairs } from '../src/geometry';
import {
  arrowItem,
  boxItem,
  cleanAssetName,
  fileItem,
  focusFor,
  followers,
  inkItem,
  lassoItem,
  markDrafts,
  movable,
  openAsk,
  openLasso,
  penWidth,
  pinItem,
  snapshotArea,
  solidifyDraft,
  voiceItem,
} from '../src/marks';
import { GO_MAX_STROKES } from '../src/input/constants';
import recorded from './fixtures/strokes.json';
import { CH, note, openBoard, placeAt, text } from './helpers';

/** A test double of the board as the DOM measures it: a note, and a card with three questions. */
const rects: TargetRect[] = [
  { id: 'n1', item: 'n1', box: [40, 60, 300, 120] },
  { id: 'a1', item: 'a1', box: [360, 100, 400, 200] },
  { id: 'a1/q:1', item: 'a1', sub: 'q:1', parent: 'a1', box: [376, 190, 368, 24] },
  { id: 'a1/q:2', item: 'a1', sub: 'q:2', parent: 'a1', box: [376, 216, 368, 24] },
  { id: 'a1/q:3', item: 'a1', sub: 'q:3', parent: 'a1', box: [376, 242, 368, 24] },
];
/** Where each target is drawn now: the same boxes, as the layout would say. */
const boxOf = (t: Target): Box | undefined => rects.find((r) => r.item === t.item && r.sub === t.sub)?.box;
const S = recorded as Record<string, number[][]>;
const strokes = (name: string): XY[][] => S[name]!.map((f) => pairs(f));

/** Each stroke as a press of its own, kept in one piece: how the pen hands over a go of strokes that never filled up. */
const presses = (strokes: readonly (readonly XY[])[]): XY[][][] => strokes.map((s) => [[...s]]);

describe('each tool makes its mark', () => {
  it('the pen: one ink item with its hint, targets, anchor, and strokes as flat pairs', () => {
    const ink = inkItem('m9', presses(strokes('circleRound')), rects, boxOf, 4.5);
    expect(ink.kind).toBe('ink');
    expect(ink.hint).toBe('circle');
    expect(ink.targets).toEqual([{ item: 'a1', sub: 'q:2' }]);
    expect(ink.anchor).toEqual({ item: 'a1', sub: 'q:2', box: [376, 216, 368, 24] });
    expect(ink.strokes).toHaveLength(1);
    expect(ink.strokes[0]!.w).toBe(4.5);
    expect(ink.strokes[0]!.pts.length % 2).toBe(0);
    expect(ink.snapshot).toBeUndefined();
  });

  it('the pen: a dot is a stroke of two points', () => {
    const ink = inkItem('m9', presses([[[10, 10]]]), [], boxOf);
    expect(ink.box).toEqual([10, 10, 0, 0]);
    expect(ink.strokes[0]!.pts).toEqual([0, 0, 0.1, 0]);
    expect(ink.anchor).toBeUndefined();
  });

  it('the pen: a mark holds no more strokes than the log takes in one, however many it is handed, and a long press keeps its pieces', () => {
    const many = Array.from({ length: GO_MAX_STROKES + 1 }, (_, i): XY[] => [
      [i * 10, 0],
      [i * 10 + 5, 0],
    ]);
    expect(inkItem('m9', presses(many), [], boxOf).strokes).toHaveLength(GO_MAX_STROKES);
    const long: XY[][] = [many[0]!, many[1]!, many[2]!];
    expect(inkItem('m9', [long, ...presses(many.slice(3))], [], boxOf).strokes).toHaveLength(GO_MAX_STROKES);
    expect(inkItem('m9', [long], [], boxOf).strokes).toHaveLength(3);
  });

  it('the pen: every point is counted from the top-left corner of the mark’s box', () => {
    const raw = strokes('crossQuick');
    const ink = inkItem('m9', presses(raw), rects, boxOf);
    const all = ink.strokes.flatMap((s) => pairs(s.pts));
    expect(Math.min(...all.map((p) => p[0]))).toBeCloseTo(0, 0);
    expect(Math.min(...all.map((p) => p[1]))).toBeCloseTo(0, 0);
    expect(Math.max(...all.map((p) => p[0]))).toBeCloseTo(ink.box[2], 0);
    expect(Math.max(...all.map((p) => p[1]))).toBeCloseTo(ink.box[3], 0);
    // The box plus a point is where the hand was.
    const [x, y] = pairs(ink.strokes[0]!.pts)[0]!;
    expect(ink.box[0] + x).toBeCloseTo(raw[0]![0]![0], 0);
    expect(ink.box[1] + y).toBeCloseTo(raw[0]![0]![1], 0);
  });

  it('the pen keeps its width on screen at any zoom', () => {
    expect(penWidth(4.5, 1)).toBe(4.5);
    expect(penWidth(4.5, 0.5)).toBe(9);
    expect(penWidth(4.5, 0.1)).toBe(24);
  });

  it('a snapshot shows the ink and what it points at', () => {
    expect(snapshotArea([100, 100, 50, 10], [[80, 60, 200, 40]])).toEqual([56, 36, 248, 98]);
    expect(snapshotArea([0, 0, 10, 10], [[5000, 5000, 10, 10]])).toEqual([-24, -24, 58, 58]);
  });

  it('a box: anchored to what it is drawn round, with its label', () => {
    const b = boxItem('m9', [20, 40, 340, 160], rects, boxOf, '  the door  ');
    expect(b).toEqual({ id: 'm9', kind: 'box', box: [20, 40, 340, 160], text: 'the door', anchor: { item: 'n1', box: [40, 60, 300, 120] } });
    expect(boxItem('m9', [2000, 2000, 50, 50], rects, boxOf, '')).toEqual({ id: 'm9', kind: 'box', box: [2000, 2000, 50, 50] });
  });

  it('an arrow: each end takes the thing under it, and it hangs on the thing it points at', () => {
    const a = arrowItem('m9', [100, 100], [400, 228], rects, boxOf, 'why?');
    expect(a.fromTarget).toEqual({ item: 'n1' });
    expect(a.toTarget).toEqual({ item: 'a1', sub: 'q:2' });
    expect(a.anchor).toEqual({ item: 'a1', sub: 'q:2', box: [376, 216, 368, 24] });
    expect(a.box).toEqual([100, 100, 300, 128]);
    // Its ends are counted from the corner of its box.
    expect(a.from).toEqual([0, 0]);
    expect(a.to).toEqual([300, 128]);
    expect(a.text).toBe('why?');
    expect(arrowItem('m9', [400, 228], [100, 100], rects, boxOf)).toMatchObject({ box: [100, 100, 300, 128], from: [300, 128], to: [0, 0] });
  });

  it('an arrow between two questions of one card hangs on the card', () => {
    const a = arrowItem('m9', [400, 202], [400, 254], rects, boxOf);
    expect(a.anchor?.item).toBe('a1');
    expect(a.anchor?.sub).toBeUndefined();
  });

  it('an arrow on bare ground has no targets and no anchor', () => {
    const a = arrowItem('m9', [2000, 2000], [2100, 2000], rects, boxOf);
    expect(a).toEqual({ id: 'm9', kind: 'arrow', box: [2000, 2000, 100, 0], from: [0, 0], to: [100, 0] });
  });

  it('a pin: the thing under the click, the point, and a few words', () => {
    const p = pinItem('m9', [500, 250], rects, boxOf, 'this one');
    expect(p).toEqual({ id: 'm9', kind: 'pin', box: [500, 250, 0, 0], at: [0, 0], on: { item: 'a1', sub: 'q:3' }, text: 'this one', anchor: { item: 'a1', sub: 'q:3', box: [376, 242, 368, 24] } });
    expect(pinItem('m9', [2000, 2000], rects, boxOf)).toBeUndefined();
  });

  it('a lasso: the items mostly inside, the path as drawn, and no anchor', () => {
    const loop: XY[] = Array.from({ length: 60 }, (_, i) => [400 + 420 * Math.cos((i / 59) * 2 * Math.PI), 180 + 200 * Math.sin((i / 59) * 2 * Math.PI)]);
    const l = lassoItem('m9', loop, rects)!;
    expect(l.targets).toEqual([{ item: 'n1' }, { item: 'a1' }]);
    expect(l.anchor).toBeUndefined();
    expect(l.path.length % 2).toBe(0);
    // The path is counted from the corner of the box round it.
    const pts = pairs(l.path);
    expect(Math.min(...pts.map((p) => p[0]))).toBe(0);
    expect(Math.min(...pts.map((p) => p[1]))).toBe(0);
    expect(Math.abs(l.box[0] + 20)).toBeLessThan(1);
    expect(lassoItem('m9', [[0, 0], [5, 0], [5, 5], [0, 5]], rects)).toBeUndefined();
  });

  it('a file: a tile at the drop point, anchored to what it was dropped on', () => {
    const f = fileItem('m9', [380, 120], { name: 'notes.md', size: 812, type: 'text/markdown' }, 'assets/notes.md', rects, boxOf);
    expect(f).toEqual({ id: 'm9', kind: 'file', box: [380, 120, 340, 60], name: 'notes.md', asset: 'assets/notes.md', size: 812, mime: 'text/markdown', anchor: { item: 'a1', box: [360, 100, 400, 200] } });
  });

  it('a spoken remark: its words, and what the pointer was over', () => {
    const v = voiceItem('m9', [400, 228], ' so the handler sleeps here? ', { item: 'a1', sub: 'q:2' }, boxOf);
    expect(v).toEqual({ id: 'm9', kind: 'voice', box: [416, 236, 320, 64], text: 'so the handler sleeps here?', on: { item: 'a1', sub: 'q:2' }, anchor: { item: 'a1', sub: 'q:2', box: [376, 216, 368, 24] } });
  });

  it('cleans a file name as the server does', () => {
    expect(cleanAssetName('My Notes (final).md')).toBe('My-Notes-final.md');
    expect(cleanAssetName('../../etc/passwd')).toBe('passwd');
    expect(cleanAssetName('...')).toBe('file');
  });
});

describe('posting a mark', () => {
  it('opens a chapter first when none is in work, titled from the mark', () => {
    const b = openBoard();
    const s = emptyState();
    expect(markDrafts(s, { id: 'm1', kind: 'voice', box: [0, 0, 10, 10], text: 'one engine for many requests at once' }).map((d) => d.type)).toEqual(['chapter.open', 'item.add']);
    expect(markDrafts(s, { id: 'm1', kind: 'box', box: [0, 0, 10, 10] })[0]).toMatchObject({ type: 'chapter.open', title: 'A new idea' });
    expect(markDrafts(s, { id: 'm1', kind: 'file', box: [0, 0, 10, 10], name: 'AGENT_ROADMAP.md', asset: 'assets/a.md' })[0]).toMatchObject({ title: 'AGENT ROADMAP' });
    expect(markDrafts(b.state, { id: 'm1', kind: 'box', box: [0, 0, 10, 10] })).toEqual([{ type: 'item.add', chapter: CH, item: { id: 'm1', kind: 'box', box: [0, 0, 10, 10] } }]);
  });

  it('every mark a tool makes is admitted by the rules', () => {
    const b = openBoard();
    b.must('owner', note('n1', [40, 60, 300, 120]));
    b.must('agent', text('a1', { answers: ['n1'], picture: { kind: 'text', title: 'card', questions: ['one?', 'two?', 'three?'] } }));
    b.must('owner', placeAt('a1', [360, 100, 400, 200]));
    const loop: XY[] = Array.from({ length: 60 }, (_, i) => [400 + 420 * Math.cos((i / 59) * 2 * Math.PI), 180 + 200 * Math.sin((i / 59) * 2 * Math.PI)]);
    const made = [
      inkItem('m1', presses(strokes('circleRound')), rects, boxOf, 4.5),
      inkItem('m2', presses(strokes('sketch')), rects, boxOf),
      boxItem('m3', [20, 40, 340, 160], rects, boxOf, 'x'),
      arrowItem('m4', [100, 100], [400, 228], rects, boxOf, 'why?'),
      pinItem('m5', [500, 250], rects, boxOf, 'this')!,
      lassoItem('m6', loop, rects)!,
      fileItem('m7', [380, 120], { name: 'n.md', size: 3, type: '' }, 'assets/n.md', rects, boxOf),
      voiceItem('m8', [400, 228], 'hello', { item: 'a1', sub: 'q:2' }, boxOf),
    ];
    for (const item of made) for (const d of markDrafts(b.state, item)) b.must('owner', d);
    expect(Object.keys(b.state.items)).toHaveLength(10);
  });
});

describe('the board, read for the tools', () => {
  const lassoed = () => {
    const b = openBoard();
    b.must('owner', note('n1', [0, 0, 100, 50]));
    b.must('agent', text('a1', { answers: ['n1'] }));
    b.must('owner', placeAt('a1', [200, 0, 300, 200]));
    b.must('owner', { type: 'item.add', chapter: CH, item: { id: 'l1', kind: 'lasso', box: [0, 0, 500, 200], path: [0, 0, 500, 0, 500, 200], targets: [{ item: 'n1' }, { item: 'a1', sub: 'q:1' }] } });
    return b;
  };

  it('Solidify acts on the newest lasso not solidified yet, with its items as picks', () => {
    const b = lassoed();
    const l = openLasso(b.state)!;
    expect(l.id).toBe('l1');
    const d = solidifyDraft(b.state, l);
    expect(d).toEqual({ type: 'solidify', chapter: CH, picks: ['n1', 'a1'], parts: [], lasso: 'l1' });
    b.must('owner', d);
    expect(openLasso(b.state)).toBeUndefined();
  });

  it('a lasso whose items have all left the board cannot be solidified', () => {
    const b = lassoed();
    b.must('owner', { type: 'item.remove', item: 'n1' });
    expect(openLasso(b.state)?.id).toBe('l1');
    expect(solidifyDraft(b.state, openLasso(b.state)!)).toMatchObject({ picks: ['a1'] });
  });

  it('the owner moves their own marks and any picture, but not a lasso', () => {
    const b = lassoed();
    expect(movable(b.state, 'n1')).toBe(true);
    expect(movable(b.state, 'a1')).toBe(true);
    expect(movable(b.state, 'l1')).toBe(false);
  });

  it('marks anchored to a picture, and marks anchored to those, follow it', () => {
    const b = lassoed();
    b.must('owner', note('n2', [0, 0, 10, 10], { anchor: { item: 'a1', box: [200, 0, 300, 200] } }));
    b.must('owner', note('n3', [0, 0, 10, 10], { anchor: { item: 'n2', box: [0, 0, 10, 10] } }));
    expect(followers(b.state, 'a1')).toEqual(['n2', 'n3']);
  });

  it('a tap on a part goes to its focus if the agent drew one, and asks once otherwise', () => {
    const b = openBoard();
    b.must('agent', { type: 'model.patch', ops: [{ op: 'lane.set', lane: { id: 'bridge', name: 'Bridge' } }, { op: 'part.set', part: { id: 'queue', name: 'The queue', lane: 'bridge' } }] });
    b.must('owner', note('n1', [0, 0, 100, 50]));
    expect(focusFor(b.state, { part: 'queue' })).toBeUndefined();
    b.must('owner', { type: 'ask', what: 'focus', part: 'queue' });
    expect(openAsk(b.state, { part: 'queue' })).toBeTruthy();
    expect(openAsk(b.state, { lane: 'bridge' })).toBeUndefined();
    b.must('agent', { type: 'item.add', chapter: CH, item: { id: 'f1', kind: 'picture', picture: { kind: 'focus', part: 'queue', title: 'The queue' }, answers: [b.events[b.events.length - 1]!.id] } });
    expect(focusFor(b.state, { part: 'queue' })).toBe('f1');
    expect(openAsk(b.state, { part: 'queue' })).toBeUndefined();
  });
});
