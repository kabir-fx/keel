import type { BoardState, Box, Id } from '@keel/protocol';
import type { Connection } from '../source';

/**
 * Cues: what just happened on the board that deserves motion, read from two moments of it.
 * Pure: the board before, the board now and what was already looked at give the cues, and
 * nothing else is read.
 *
 * - `placed`: a picture of the agent's has its place on the board for the first time; a
 *   placeholder the agent is still drawing too.
 * - `settling`: a placeholder was finished, and is not at its finished place yet: it is held out
 *   of sight for the moment, so it is never seen whole before it is pulled to its finished size.
 * - `finished`: a placeholder that was finished has its finished place. `from` is where the
 *   placeholder was drawn.
 * - `redrawn`: the agent drew a picture that is on the board again, finished before and after.
 * - `read`: an answer in words, whose chip is on the board for the first time.
 */
export type Cue =
  | { kind: 'placed'; id: Id }
  | { kind: 'settling'; id: Id }
  | { kind: 'finished'; id: Id; from: Box }
  | { kind: 'redrawn'; id: Id }
  | { kind: 'read'; id: string };

/** The board at one commit, as the cues read it. */
export interface Moment {
  state: BoardState;
  /** Where each item is drawn now. */
  boxes: ReadonlyMap<Id, Box>;
  /** The placeholders drawn at a spot of this page's own, not placed in the log. */
  spots: ReadonlyMap<Id, Box>;
  /** The read chips on the board, by their answer's id. */
  chips: ReadonlySet<string>;
  connection: Connection;
}

/** What the cues remember from one moment to the next. */
export interface Looked {
  /** Every item and chip already looked at: none is placed or read twice. */
  seen: Set<string>;
  /** Each placeholder on the board, and where it was last drawn. */
  placeholders: Map<Id, Box>;
  /** True once a moment with the first view fitted was read: what was there then is not news. */
  opened: boolean;
}

export const looking = (): Looked => ({ seen: new Set(), placeholders: new Map(), opened: false });

/**
 * The cues between `before` and `now`, in the order they should play. `known` is the set of
 * pictures that were on the board when it first opened (null until the first view is fitted);
 * `looked` is what was looked at before, and what is looked at now is added to it.
 *
 * No cue:
 * - before the board's first view is fitted, nor for what was there before the first moment
 *   read after it;
 * - for anything in the moment the page (re)connects: what came with the server's `init` after
 *   a lost connection came all at once, and was not drawn in front of the owner;
 * - for a picture that was on the board when it opened, but for a placeholder of it finished;
 * - for anything that had a place before: a move, a resize, or a picture brought back;
 * - for what is not the agent's, or not a picture, but for a read.
 *
 * It looks only at what has a place and was not looked at yet, at the placeholders, and at the
 * pictures whose item changed, so a moment in which nothing of the agent's changed costs one
 * look-up per item.
 */
export function readCues(before: Moment | null, now: Moment, known: ReadonlySet<Id> | null, looked: Looked): Cue[] {
  if (!known) return [];
  const { seen, placeholders } = looked;
  /** Everything on the board at `m` counts as looked at: it is not news. */
  const lookAt = (m: Moment) => {
    looked.opened = true;
    for (const id of m.state.itemOrder) seen.add(id);
    for (const id of m.boxes.keys()) seen.add(id);
    for (const id of m.chips) seen.add(id);
    for (const [id, box] of m.boxes) {
      const item = m.state.items[id]?.item;
      if (item?.kind === 'picture' && item.status === 'drawing') placeholders.set(id, box);
    }
  };
  if (!before || before.connection !== 'open') {
    lookAt(now);
    return [];
  }
  // The first moment read with the first view fitted: what was on the board before it was there
  // when the board opened. What came with this moment is news.
  if (!looked.opened) lookAt(before);
  const cues: Cue[] = [];

  // A placeholder finished: held while it waits for its finished place, then pulled to it.
  for (const [id, from] of placeholders) {
    const s = now.state.items[id];
    if (!s || s.removed || s.item.kind !== 'picture') {
      placeholders.delete(id);
      continue;
    }
    const box = now.boxes.get(id);
    if (s.item.status === 'drawing') {
      if (box) placeholders.set(id, box);
      continue;
    }
    if (!box || now.spots.has(id)) {
      if (box) cues.push({ kind: 'settling', id });
      continue;
    }
    placeholders.delete(id);
    cues.push({ kind: 'finished', id, from });
  }

  // The agent drew a picture on the board again.
  if (before.state !== now.state) {
    for (const [id, box] of now.boxes) {
      const [was, is] = [before.state.items[id], now.state.items[id]];
      if (!was || !is || was === is || is.by !== 'agent' || is.removed || was.removed) continue;
      if (was.item.kind !== 'picture' || is.item.kind !== 'picture' || was.item.picture === is.item.picture) continue;
      if (was.item.status === 'drawing' || is.item.status === 'drawing' || !before.boxes.get(id) || !box) continue;
      cues.push({ kind: 'redrawn', id });
    }
  }

  // A picture with its place for the first time.
  for (const [id, box] of now.boxes) {
    if (seen.has(id)) continue;
    seen.add(id);
    const s = now.state.items[id];
    if (!s || s.removed || s.by !== 'agent' || s.item.kind !== 'picture') continue;
    if (s.item.status === 'drawing') placeholders.set(id, box);
    if (!known.has(id)) cues.push({ kind: 'placed', id });
  }

  // An answer in words, its chip on the board for the first time.
  for (const id of now.chips) {
    if (seen.has(id)) continue;
    seen.add(id);
    cues.push({ kind: 'read', id });
  }
  return cues;
}
