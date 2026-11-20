import type { MarkItem } from '@keel/protocol';
import { useCallback, useEffect, useRef } from 'react';
import type { Label } from '../tools/types';
import type { Board } from './context';
import type { Log } from './log';

/**
 * The tools that are used once: Box, Arrow and Pin give the hand back to Select after one
 * mark. The Pen and the Lasso stay in hand, and the Note tool drops back by itself.
 *
 * - A use is over when the mark's label closes: the mark is on its way to the board with its
 *   words, or it was dropped. A press that drew nothing worth a label (a box too small, a pin
 *   on bare ground) is no use, and the tool stays.
 * - The new mark is selected once it is on the board.
 *
 * Which tools drop back is the owner's choice: Box, Arrow and Pin do, Pen and Lasso stay. That a shape
 * tool is used once is Excalidraw's rule (its App.tsx, commit 9fbeaed).
 *
 * `label` is the mark that waits for its words, and `postMark` is the log's: what comes back
 * is the `postMark` the board hands to its parts.
 */
export function useOneUse(board: Pick<Board, 'tool' | 'setTool' | 'select'>, label: Label | null, postMark: Log['postMark']): Log['postMark'] {
  const before = useRef<Label | null>(null);
  useEffect(() => {
    const closed = before.current;
    before.current = label;
    // The owner may have taken another tool in hand while the label was open: that one stays.
    if (closed && !label && board.tool() === closed.kind) board.setTool('select');
  }, [label, board]);

  return useCallback(
    async (item: MarkItem) => {
      const ok = await postMark(item);
      if (ok && (item.kind === 'box' || item.kind === 'arrow' || item.kind === 'pin')) board.select(item.id);
      return ok;
    },
    [postMark, board],
  );
}
