import type { BoardState, Id, PictureItem, Target } from '@keel/protocol';
import { targetsOf } from '@keel/protocol';
import type { PictureView } from '@keel/pictures';
import { SOURCE_CHAIN } from '@keel/pictures';

/**
 * What a picture reads of the board's state beyond its own item, by its kind, as the renderers
 * in `@keel/pictures` read it: the state's own entries (a part, a lane, a walk, a chapter, an
 * item's state), in a list. The reducer never changes an entry in place, so two lists that hold
 * the same entries, one by one, mean the picture draws the same from either state. The board
 * uses it to leave a picture alone when an event touched nothing it shows.
 *
 * A renderer that starts to read more of the state must be listed here, or it will not redraw
 * when that changes. Reading too much here only costs a render; reading too little shows a
 * stale picture. `test/memo.test.tsx` draws every kind both ways and fails on a stale one.
 */
export function stateReads(state: BoardState, item: PictureItem): readonly unknown[] {
  if (item.status === 'drawing') return [];
  const p = item.picture;
  switch (p.kind) {
    case 'shelf':
      return p.tiles.map((t) => (t.part ? state.model.parts[t.part] : undefined));
    case 'choice':
      return [state.items[item.id], p.part ? state.model.parts[p.part] : undefined];
    case 'walk':
      return [state.model.walks[p.walk]];
    case 'pipeline':
      return p.model ? [] : modelReads(state);
    case 'focus':
      return modelReads(state);
    case 'blueprint': {
      const own = state.items[item.id];
      const chapter = own?.chapter ? state.chapters[own.chapter] : undefined;
      return [...modelReads(state), own, chapter, ...p.picks.flatMap((pick) => (pick.from ? chainReads(state, pick.from) : []))];
    }
    default:
      return [];
  }
}

/**
 * What a picture reads of how the owner looks at the board (its `view`), by its kind: the step
 * being played of the walk it shows, how pipelines are drawn, whether it is the picture shown
 * large. So a step of a walk is news only to the pictures that show that walk.
 *
 * As with `stateReads`: a renderer that starts to read more of the view must be listed here.
 */
export function viewReads(view: PictureView, item: PictureItem): readonly unknown[] {
  if (item.status === 'drawing') return [];
  const p = item.picture;
  switch (p.kind) {
    case 'walk':
      return [stepPlayed(view, p.walk)];
    case 'pipeline':
      return [view.pipeline, stepPlayed(view, p.walk)];
    case 'focus':
      return [view.focus === item.id];
    default:
      return [];
  }
}

/** True when two lists from `stateReads` or `viewReads` hold the same entries, one by one. */
export function sameReads(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The step being played of this walk, when it is the walk the owner plays. */
function stepPlayed(view: PictureView, walk: Id | undefined): number | undefined {
  return walk !== undefined && view.walk?.id === walk ? view.walk.step : undefined;
}

/** The board's model, entry by entry, in its own order: what a picture of the live model draws. */
function modelReads(state: BoardState): unknown[] {
  const m = state.model;
  return [
    ...m.lanes,
    ...m.partOrder.map((id) => m.parts[id]),
    ...m.edges,
    ...m.walkOrder.map((id) => m.walks[id]),
  ];
}

/**
 * The items the words for a pick's source read: the item, then what each mark in turn is on.
 * It follows as many as those words do and no fewer: `SOURCE_CHAIN` is theirs.
 */
function chainReads(state: BoardState, from: Target): unknown[] {
  const out: unknown[] = [];
  let at: Id | undefined = from.item;
  for (let i = 0; i < SOURCE_CHAIN && at; i++) {
    const s: BoardState['items'][Id] | undefined = state.items[at];
    out.push(s);
    at = s && s.item.kind !== 'picture' ? targetsOf(s.item)[0]?.item : undefined;
  }
  return out;
}
