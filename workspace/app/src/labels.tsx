import type { BoardState, Box, Chapter, Id } from '@keel/protocol';
import { StateChip } from '@keel/pictures';
import { memo } from 'react';
import { chapterStarts } from './inview';
import { useHeldBox } from './select/following';
import type { MovingStore } from './select/moving';

/**
 * A quiet label at each chapter's first item: its title and its state, so the board reads as
 * the story of its ideas. It sits just above the item, in world units, and points at nothing.
 * It stays above the item while the owner's hand moves it (`moving`).
 */
export const ChapterLabels = memo(function ChapterLabels({ state, boxOf, moving }: { state: BoardState; boxOf: (id: Id) => Box | undefined; moving: MovingStore }) {
  return (
    <>
      {chapterStarts(state, boxOf).map(({ chapter, item, box }) => (
        <ChapterLabel key={chapter} id={chapter} chapter={state.chapters[chapter]!} item={item} rest={box} moving={moving} />
      ))}
    </>
  );
});

/** One chapter's label, above its first item where that is drawn now. */
function ChapterLabel({ id, chapter, item, rest, moving }: { id: Id; chapter: Chapter; item: Id; rest: Box; moving: MovingStore }) {
  const box = useHeldBox(moving, item, rest);
  return (
    <div className="chapter-label" data-chapter-label={id} style={{ left: box[0], top: box[1] - 10 }} aria-hidden="true">
      <span className="chapter-label__title">{chapter.title}</span>
      <StateChip state={chapter.state}>{chapter.state === 'building' ? (chapter.paused ? 'paused' : 'building') : undefined}</StateChip>
    </div>
  );
}
