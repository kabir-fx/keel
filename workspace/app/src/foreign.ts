import type { BoardState, ForeignRange, Id } from '@keel/protocol';
import { isForeign, liveItems, seqOf } from '@keel/protocol';

/**
 * What came with the log from outside: a clone, a pull, a checkout, or a change written into
 * the file outside the board. The log says who made each item, and the log can say anything, so
 * until the owner keeps them the board tags what those events made as "not made here".
 */

/**
 * The items on the board that were not made on this machine: the newest of the event that added
 * one and the owner's last edit of its words is in a run that came from outside. An item the
 * owner rewrites here is theirs again.
 */
export function notMadeHere(state: BoardState, ranges: readonly ForeignRange[] | undefined): Id[] {
  if (!ranges || ranges.length === 0) return [];
  const out: Id[] = [];
  for (const s of liveItems(state)) {
    const n = Math.max(seqOf(s.event), state.edited[s.item.id] ?? 0);
    if (isForeign(ranges, n)) out.push(s.item.id);
  }
  return out;
}

/** What the banner says about them. */
export function foreignWords(n: number): string {
  const items = n === 1 ? '1 item on this board was' : `${n} items on this board were`;
  return `${items} not made on this machine. ${n === 1 ? 'It' : 'They'} came with the log: a clone, a pull, or a change to the file outside the board. The agent leaves ${n === 1 ? 'it' : 'them'} alone until you keep ${n === 1 ? 'it' : 'them'}.`;
}
