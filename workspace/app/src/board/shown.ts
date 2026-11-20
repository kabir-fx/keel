import type { BoardState, Box, Id, ItemState, Markings } from '@keel/protocol';
import { liveItems, markings as markingsOf } from '@keel/protocol';
import { useCallback, useMemo, useRef } from 'react';
import { LINE_KINDS } from '../dom';
import { notMadeHere } from '../foreign';
import type { Where } from '../layout';
import { arrowEnds, lassoOutline, shownBoxOf, storedBox, withArrowsAhead } from '../layout';
import type { Edge } from '../lineage';
import { lineageEdges } from '../lineage';
import { picksOf } from '../marks';
import type { Loop } from '../outline';
import type { BoxOf } from '../place';
import { unplaced } from '../place';
import type { ReadChipAt } from '../reads';
import { readChips } from '../reads';
import type { BoardSource } from '../source';
import type { Ahead } from './ahead';

/** The two ends of an arrow as they are drawn, each joined to its target. */
export type Ends = [[number, number], [number, number]];

/** A lasso's tidy outline round where its targets are now, and how many items it still holds. */
export interface Outline {
  loops: Loop[];
  picked: number;
}

/** Where everything on the board is drawn in this render, worked out from the log and what the page knows ahead of it. */
export interface Shown {
  /** The board as it is drawn: its `state` is the log's, with each arrow that is ahead of the log as it will be. */
  where: Where;
  /** An item's own box, by the log or ahead of it. */
  stored(id: Id): Box | undefined;
  /** Where every live item is drawn now, in world units. */
  boxes: ReadonlyMap<Id, Box>;
  boxOf: BoxOf;
  /** Every item still on the board, in the log's order. */
  live: readonly ItemState[];
  /** Pictures that wait for a place. */
  waiting: readonly Id[];
  marks: Record<Id, Markings>;
  /** What came with the log from outside and is not kept yet: tagged "not made here". */
  tagged: readonly Id[];
  edges: readonly Edge[];
  /** What a lineage arrow goes round, each where it is drawn: the cards, the notes and the files. Strokes and lassos are lines, not cards. */
  cards: ReadonlyMap<Id, Box>;
  chips: readonly ReadChipAt[];
  ends: ReadonlyMap<Id, Ends>;
  outlines: ReadonlyMap<Id, Outline>;
}

/* ------------------------------------------------------------ keeping what did not change */

/** The old value when it is the same as the new one, so a memo on it holds. */
function keepSame<T>(old: T | undefined, next: T, same: (a: T, b: T) => boolean): T {
  return old !== undefined && same(old, next) ? old : next;
}

const sameNumbers = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((n, i) => n === b[i]);
const sameList = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);
/** The same things, each the very same as before. */
const sameEntries = <V>(a: ReadonlyMap<Id, V>, b: ReadonlyMap<Id, V>) => a.size === b.size && [...a].every(([id, v]) => b.has(id) && b.get(id) === v);

const sameBox = (a: Box, b: Box): boolean => sameNumbers(a, b);
const sameMarkings = (a: Markings, b: Markings): boolean => sameList(a.crossed, b.crossed) && sameList(a.circled, b.circled);
const sameEnds = (a: Ends, b: Ends): boolean => sameNumbers(a[0], b[0]) && sameNumbers(a[1], b[1]);
const sameOutline = (a: Outline, b: Outline): boolean =>
  a.picked === b.picked && a.loops.length === b.loops.length && a.loops.every((l, i) => l.length === b.loops[i]!.length && l.every((p, j) => sameNumbers(p, b.loops[i]![j]!)));
const sameChip = (a: ReadChipAt, b: ReadChipAt): boolean => a.read === b.read && a.mark === b.mark && sameNumbers(a.at, b.at);

/** Every entry of `next`, with the old one kept where it is the same. */
function keepEntries<V>(old: ReadonlyMap<Id, V>, next: Map<Id, V>, same: (a: V, b: V) => boolean): Map<Id, V> {
  for (const [id, v] of next) next.set(id, keepSame(old.get(id), v, same));
  return next;
}

/* ------------------------------------------------------------ where things are */

/**
 * Work out where things are. Each part is worked out again only when what it reads has changed,
 * and a box, a marking, an arrow's ends, a lasso's outline or a read chip whose numbers and words
 * did not change keeps its identity from the render before, so what draws it is left alone.
 */
export function useShown(state: BoardState, ahead: Ahead, subRects: ReadonlyMap<string, Box>, foreign: BoardSource['foreign']): Shown {
  const { pending, provisional, refused } = ahead;
  // What is drawn from an arrow (its box, its ends, its label, a lasso round it) is drawn from the arrow ahead of the log.
  const drawn = useMemo(() => withArrowsAhead(state, ahead.arrows), [state, ahead.arrows]);
  const where: Where = useMemo(() => ({ state: drawn, boxes: new Map([...provisional, ...pending]), subs: subRects }), [drawn, pending, provisional, subRects]);
  const stored = useCallback((id: Id) => storedBox(where, id), [where]);
  /** What the last render drew, to keep what did not change. */
  const kept = useRef<Kept>({ boxes: new Map(), marks: new Map(), ends: new Map(), outlines: new Map(), cards: new Map(), chips: new Map() });

  const boxes = useMemo(() => {
    const out = new Map<Id, Box>();
    for (const s of liveItems(drawn)) {
      const b = shownBoxOf(where, s.item.id);
      if (b) out.set(s.item.id, b);
    }
    return (kept.current.boxes = keepEntries(kept.current.boxes, out, sameBox));
  }, [drawn, where]);
  const boxOf: BoxOf = useCallback((id) => boxes.get(id), [boxes]);

  const waiting = useMemo(
    () => unplaced(state, (id) => pending.get(id) ?? provisional.get(id) ?? state.items[id]?.item.box).filter((id) => !refused.current.has(id)),
    [state, pending, provisional, refused],
  );
  const marks = useMemo(() => {
    const next = keepEntries(kept.current.marks, new Map(Object.entries(markingsOf(state))), sameMarkings);
    kept.current.marks = next;
    return Object.fromEntries(next);
  }, [state]);
  const tagged = useMemo(() => notMadeHere(state, foreign), [state, foreign]);
  const edges = useMemo(() => lineageEdges(state, boxOf), [state, boxOf]);
  const cards = useMemo(() => {
    const out = new Map<Id, Box>();
    for (const [id, b] of boxes) if (!LINE_KINDS.has(state.items[id]?.item.kind ?? '')) out.set(id, b);
    return (kept.current.cards = keepSame(kept.current.cards, out, sameEntries));
  }, [boxes, state]);
  const live = useMemo(() => liveItems(drawn), [drawn]);
  const chips = useMemo(() => {
    const out = readChips(state, boxOf).map((c) => keepSame(kept.current.chips.get(c.id), c, sameChip));
    kept.current.chips = new Map(out.map((c) => [c.id, c]));
    return out;
  }, [state, boxOf]);
  const ends = useMemo(() => {
    const out = new Map<Id, Ends>();
    for (const s of live) {
      const b = boxes.get(s.item.id);
      if (s.item.kind === 'arrow' && b) out.set(s.item.id, arrowEnds(where, s.item, b));
    }
    return (kept.current.ends = keepEntries(kept.current.ends, out, sameEnds));
  }, [live, boxes, where]);
  const outlines = useMemo(() => {
    const out = new Map<Id, Outline>();
    for (const s of live) {
      if (s.item.kind !== 'lasso') continue;
      const lasso = s.item;
      const picked = picksOf(lasso).filter((id) => state.items[id] && !state.items[id]!.removed).length;
      out.set(lasso.id, { loops: lassoOutline(where, lasso), picked });
    }
    return (kept.current.outlines = keepEntries(kept.current.outlines, out, sameOutline));
  }, [live, where, state]);

  return { where, stored, boxes, boxOf, live, waiting, marks, tagged, edges, cards, chips, ends, outlines };
}

/** What the last render drew, by item: kept where the numbers are the same. */
interface Kept {
  boxes: ReadonlyMap<Id, Box>;
  marks: ReadonlyMap<Id, Markings>;
  ends: ReadonlyMap<Id, Ends>;
  outlines: ReadonlyMap<Id, Outline>;
  cards: ReadonlyMap<Id, Box>;
  /** The read chips, by the answer each came with. */
  chips: ReadonlyMap<string, ReadChipAt>;
}
