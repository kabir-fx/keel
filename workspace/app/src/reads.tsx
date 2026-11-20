import type { BoardState, Box, Id } from '@keel/protocol';
import { isMark } from '@keel/protocol';
import { Star } from '@keel/pictures';
import { memo } from 'react';

/**
 * An answer the agent gave with no picture still says how it read the owner: a small agent
 * chip under the first mark it answers that is on the board, "read as: open the bridge".
 */
export interface ReadChipAt {
  /** The `answer` event. */
  id: string;
  read: string;
  mark: Id;
  /** The chip's top centre, in world units. */
  at: [number, number];
}

export function readChips(state: BoardState, boxOf: (id: Id) => Box | undefined): ReadChipAt[] {
  const out: ReadChipAt[] = [];
  for (const r of state.reads) {
    const mark = r.answers.find((a) => {
      const s = state.items[a];
      return !!s && !s.removed && s.by === 'owner' && isMark(s.item) && !!boxOf(a);
    });
    if (!mark) continue;
    const b = boxOf(mark)!;
    out.push({ id: r.id, read: r.read, mark, at: [b[0] + b[2] / 2, b[1] + b[3] + 6] });
  }
  return out;
}

/** One read chip. It draws again only when its words or its place have changed: the board keeps a chip that is the same. */
export const ReadChip = memo(function ReadChip({ chip, raised = false }: { chip: ReadChipAt; raised?: boolean }) {
  return (
    <div className={`read-chip${raised ? ' read-chip--raised' : ''}`} data-read={chip.id} data-mark={chip.mark} data-no-export style={{ left: chip.at[0], top: chip.at[1] }}>
      <Star size={12} />
      <span className="read-chip__as">read as:</span>
      <span>{chip.read}</span>
    </div>
  );
});
