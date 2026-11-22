import type { Id, ItemPatch } from '@keel/protocol';
import { answersTo, reduce } from '@keel/protocol';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { targetAt } from '../dom';
import type { PostResult } from '../source';
import type { BoardCtx } from '../tools/types';

/**
 * Post the owner's change to one of their marks. When the board takes it as a change of words
 * (it opens the mark again), the agent's pictures that answer the old words (`answersTo`) are
 * taken off after it, as the owner's own removes. The change and the removes are one step: one
 * Undo brings back the old words and the pictures. A remove the board refuses leaves the change
 * as it is. See docs/adr/0020.
 */
export async function changeWords(board: Pick<BoardCtx, 'state' | 'send' | 'together' | 'notComing'>, id: Id, patch: ItemPatch): Promise<PostResult> {
  const before = board.state();
  const off = patch.text === undefined ? [] : answersTo(before, id);
  board.together([id, ...off]);
  const r = await board.send({ type: 'item.update', item: id, patch });
  const reopened = r.ok && reduce(before, r.event).edited[id] !== before.edited[id];
  for (const picture of off) {
    if (reopened) void board.send({ type: 'item.remove', item: picture });
    else board.notComing(picture);
  }
  return r;
}

/** A field that opens the words of a mark on the board for a change: the answer says whether it took this one. */
interface OpensWords {
  isOpen(): boolean;
  edit(id: Id): boolean;
}

/**
 * The board's double click: with Select, on the owner's page, with no field open, it opens the
 * words of the mark under the pointer, a note's or a box's, for a change.
 */
export const wordsOnDoubleClick =
  (board: Pick<BoardCtx, 'tool' | 'isOwner' | 'hitAt' | 'toWorld'>, notes: OpensWords, labels: OpensWords) =>
  (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (board.tool() !== 'select' || !board.isOwner || notes.isOpen() || labels.isOpen()) return;
    // A box is hit on its line by the board, as a press of Select's is: the page does not find it.
    const id = board.hitAt(targetAt(e.clientX, e.clientY)?.el ?? null, ...board.toWorld(e.clientX, e.clientY));
    if (id && !notes.edit(id)) labels.edit(id);
  };
