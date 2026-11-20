import type { Box, Id } from '@keel/protocol';
import { memo, useSyncExternalStore } from 'react';
import type { MarkViewProps } from '../items';
import { MarkView } from '../items';
import type { MovingStore } from './moving';

/**
 * One of the owner's marks, drawn where the board has it, or, while it is tied to what the hand
 * moves or resizes, where the hand puts it: an arrow's ends stay on what it points at, a lasso
 * stays round what it holds, a mark on a box being resized stays on it. Only a mark tied to
 * what the hand holds draws again as the hand moves; every other mark hears the hand and draws
 * nothing. It compares its props as `MarkView` does, so it draws again exactly when that would.
 */
export const FollowingMark = memo(function FollowingMark({ moving, ...props }: MarkViewProps & { moving: MovingStore }) {
  const drawn = useSyncExternalStore(moving.subscribe, () => moving.drawn(props.item.id));
  if (!drawn) return <MarkView {...props} />;
  return <MarkView {...props} shown={drawn.shown} {...(drawn.ends ? { ends: drawn.ends } : {})} {...(drawn.outline ? { outline: drawn.outline } : {})} {...(drawn.item ? { item: drawn.item } : {})} />;
});

/**
 * Where a thing is drawn now, from where the board has it (`rest`): while the hand holds it,
 * where the hand has it. For what sits beside a thing and is drawn outside it (a tag, a
 * chapter's label), so it stays beside the thing as the hand moves it. What calls this draws
 * again as the hand moves only while the hand holds this thing.
 */
export function useHeldBox(moving: MovingStore, id: Id, rest: Box): Box {
  // The frame itself is what changes as the hand moves; for a thing the hand does not hold it is always nothing.
  const held = useSyncExternalStore(moving.subscribe, () => (moving.holds(id) ? moving.get() : null));
  return held ? moving.at(id, rest) : rest;
}
