import type { Box } from '@keel/protocol';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { wholeBoxAround } from '../src/geometry';
import { InkMark, inkWidth, PEN } from '../src/ink/ink';
import { MarkView } from '../src/items';
import { arrowEnds, clampInto, pointOn, shownBoxOf } from '../src/layout';
import { CH, note, openBoard, placeAt, text } from './helpers';

afterEach(cleanup);

const none = new Map<string, Box>();

/**
 * Everything inside a mark is counted from the top-left corner of its box: ink strokes, a
 * lasso's path, an arrow's ends, a pin's point. So a move is one change of the box.
 */
describe('inside a mark', () => {
  it('a point inside is the box corner plus the point, scaled with the mark', () => {
    expect(pointOn([10, 20], [100, 100, 50, 40], [100, 100, 50, 40])).toEqual([110, 120]);
    expect(pointOn([10, 20], [100, 100, 50, 40], [300, 0, 100, 80])).toEqual([320, 40]);
    // A level line has no height: that axis keeps its scale.
    expect(pointOn([10, 0], [0, 0, 50, 0], [0, 10, 100, 0])).toEqual([20, 10]);
  });

  it('a moved ink mark is drawn at its new box with the same strokes', () => {
    const b = openBoard();
    b.must('owner', { type: 'item.add', chapter: CH, item: { id: 'm1', kind: 'ink', box: [100, 100, 50, 40], strokes: [{ pts: [0, 0, 50, 40] }], targets: [], hint: 'none' } });
    b.must('owner', { type: 'item.update', item: 'm1', patch: { box: [400, 300, 50, 40] } });
    expect(b.state.items.m1!.item.id).toBe('m1');
    expect(shownBoxOf({ state: b.state, boxes: none, subs: none }, 'm1')).toEqual([400, 300, 50, 40]);
    const it = b.state.items.m1!.item;
    if (it.kind !== 'ink') throw new Error('not ink');
    expect(it.strokes[0]!.pts).toEqual([0, 0, 50, 40]);
  });

  it('draws ink at the box where it is shown, its points scaled, not its line', () => {
    const { container } = render(<InkMark strokes={[{ pts: [0, 0, 100, 0, 100, 10], w: 4 }]} box={[0, 0, 100, 10]} shown={[200, 50, 400, 10]} />);
    const svg = container.querySelector('svg')!;
    const pad = inkWidth(Math.max(4, PEN.size), 4, 1) * 2;
    expect(svg.getAttribute('preserveAspectRatio')).toBeNull();
    // The SVG takes the whole board units round the padded box, and its paths are counted from the mark's corner.
    const [left, top, width, height] = wholeBoxAround([200 - pad, 50 - pad, 400 + 2 * pad, 10 + 2 * pad]);
    expect(svg.style.left).toBe(`${left}px`);
    expect(svg.style.width).toBe(`${width}px`);
    expect(svg.getAttribute('viewBox')).toBe(`${left - 200} ${top - 50} ${width} ${height}`);
    // The line widens a little with the mark, never into a band.
    expect(inkWidth(4, 15, 0.4)).toBeLessThanOrEqual(6);
    expect(inkWidth(4, 1, 1)).toBe(4);
  });
});

describe('an arrow end that has a target is drawn to where that target is now', () => {
  const board = () => {
    const b = openBoard();
    b.must('owner', note('n1', [0, 0, 200, 80]));
    b.must('agent', text('a1', { answers: ['n1'] }));
    b.must('owner', placeAt('a1', [400, 0, 300, 200]));
    // From the note's right edge to a question of the card, anchored to the question.
    b.must('owner', {
      type: 'item.add',
      chapter: CH,
      item: {
        id: 'm2',
        kind: 'arrow',
        box: [200, 40, 220, 60],
        from: [0, 0],
        to: [220, 60],
        fromTarget: { item: 'n1' },
        toTarget: { item: 'a1', sub: 'q:1' },
        anchor: { item: 'a1', sub: 'q:1', box: [410, 90, 280, 20] },
      },
    });
    return b;
  };

  it('stays as drawn while nothing has moved', () => {
    const b = board();
    const subs = new Map<string, Box>([['a1/q:1', [410, 90, 280, 20]]]);
    const w = { state: b.state, boxes: none, subs };
    const it = b.state.items.m2!.item;
    if (it.kind !== 'arrow') throw new Error('not an arrow');
    expect(arrowEnds(w, it, shownBoxOf(w, 'm2')!)).toEqual([
      [200, 40],
      [420, 100],
    ]);
  });

  it('follows the note when the note moves, and the question when the card moves', () => {
    const b = board();
    b.must('owner', { type: 'item.update', item: 'n1', patch: { box: [0, 400, 200, 80] } });
    // The card moved 100 right; the question moved with it.
    const subs = new Map<string, Box>([['a1/q:1', [510, 90, 280, 20]]]);
    b.must('owner', placeAt('a1', [500, 0, 300, 200]));
    const w = { state: b.state, boxes: none, subs };
    const it = b.state.items.m2!.item;
    if (it.kind !== 'arrow') throw new Error('not an arrow');
    const [from, to] = arrowEnds(w, it, shownBoxOf(w, 'm2')!);
    // The tail is on the note where it is now, at its nearest point.
    expect(from).toEqual(clampInto([300, 40], [0, 400, 200, 80]));
    expect(from).toEqual([200, 400]);
    // The head is still on the question.
    expect(to).toEqual([520, 100]);
  });

  it('is drawn between its two ends, with its label between them', () => {
    const b = board();
    const it = b.state.items.m2!.item;
    if (it.kind !== 'arrow') throw new Error('not an arrow');
    const { container } = render(<MarkView item={{ ...it, text: 'why?' }} shown={it.box} ends={[[200, 400], [520, 100]]} />);
    expect(container.querySelector('.line-mark > path')!.getAttribute('d')).toBe('M 200 400 L 520 100');
    const label = container.querySelector<HTMLElement>('.line-mark__text')!;
    expect([label.style.left, label.style.top]).toEqual(['360px', '250px']);
  });

  /** Where a line mark's SVG sits, the rectangle its `viewBox` shows, and the box the mark says it covers. */
  const lineSvg = (container: HTMLElement) => {
    const svg = container.querySelector<SVGSVGElement>('svg.line-mark')!;
    const px = (name: 'left' | 'top' | 'width' | 'height') => Number(svg.style[name].replace('px', ''));
    return { place: [px('left'), px('top'), px('width'), px('height')], viewBox: svg.getAttribute('viewBox'), covers: svg.parentElement!.getAttribute('data-box') };
  };

  it('an arrow whose ends are off the whole unit: its SVG is on whole units round the line and 12 units of room, its line and the box it covers are as drawn', () => {
    const b = board();
    const it = b.state.items.m2!.item;
    if (it.kind !== 'arrow') throw new Error('not an arrow');
    const { container } = render(<MarkView item={it} shown={it.box} ends={[[200.3, 400.7], [520.6, 100.2]]} />);
    const { place, viewBox, covers } = lineSvg(container);
    expect(place).toEqual([188, 88, 345, 325]);
    // The SVG's box and its viewBox are one rectangle, so a number in the path is a place on the board.
    expect(viewBox).toBe(place.join(' '));
    expect(container.querySelector('.line-mark > path')!.getAttribute('d')).toBe('M 200.3 400.7 L 520.6 100.2');
    expect(covers).toBe('200.3,100.2,320.3,300.5');
  });

  it('a lasso’s outline round things off the whole unit: its SVG is on whole units round the outline and 6 units of room', () => {
    const item = { id: 'l1', kind: 'lasso' as const, box: [10.4, 20.6, 100.3, 50.1] as Box, path: [0, 0, 100.3, 0, 100.3, 50.1, 0, 50.1], targets: [] };
    const outline = [
      [
        [10.4, 20.6],
        [110.7, 20.6],
        [110.7, 70.7],
        [10.4, 70.7],
      ],
    ] as [number, number][][];
    const { container } = render(<MarkView item={item} shown={item.box} outline={outline} picked={2} />);
    const { place, viewBox, covers } = lineSvg(container);
    expect(place).toEqual([4, 14, 113, 63]);
    expect(viewBox).toBe(place.join(' '));
    expect(covers).toBe('10.4,20.6,100.3,50.1');
  });

  it('a pin is drawn at its point inside its box', () => {
    const { container } = render(<MarkView item={{ id: 'p1', kind: 'pin', box: [100, 200, 0, 0], at: [0, 0] }} shown={[300, 250, 0, 0]} />);
    const el = container.querySelector<HTMLElement>('[data-item="p1"]')!;
    expect([el.style.left, el.style.top]).toEqual(['300px', '250px']);
  });
});
