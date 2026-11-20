import type { BoardState, Box, Id } from '@keel/protocol';
import { useEffect, useRef } from 'react';
import type { ViewMode } from '../chrome';
import { chapterInWork } from '../drafts';
import { tell } from '../notify';
import type { Connection } from '../source';
import { buildingChapter, newsBetween, tabTitle } from '../watch';

/**
 * The chapter whose build the watch panel shows: the one in view, while it builds and once it
 * is built. A built chapter's panel stays out of the way of a newer idea: with another chapter
 * in work, it is left out, so it never covers that chapter's items.
 */
export function watchedChapter(state: BoardState, mode: ViewMode, inView: Id | undefined): Id | undefined {
  const viewState = inView ? state.chapters[inView]?.state : undefined;
  const inWork = chapterInWork(state);
  const doneAndBehind = viewState === 'built' && inWork !== undefined && inWork !== inView;
  return mode === 'board' && (viewState === 'building' || (viewState === 'built' && !doneAndBehind)) ? inView : undefined;
}

/** The picture that shows a part on the board: the newest picture of the whole model that has a place. */
export function partPicture(state: BoardState, boxes: ReadonlyMap<Id, Box>, part: Id): Id | undefined {
  for (let i = state.itemOrder.length - 1; i >= 0; i--) {
    const s = state.items[state.itemOrder[i]!];
    if (!s || s.removed || s.item.kind !== 'picture' || !boxes.get(s.item.id)) continue;
    const k = s.item.picture.kind;
    if ((k === 'pipeline' && !s.item.picture.model) || (k === 'blueprint' && s.item.picture.parts.includes(part))) return s.item.id;
  }
  return undefined;
}

/**
 * Watching a build from outside the board: the tab's title says how far the build is, so it
 * reads from a row of tabs, and what needs the owner while the tab is hidden is told to them.
 */
export function useWatching(state: BoardState, inView: Id | undefined, connection: Connection): void {
  const baseTitle = useRef(typeof document === 'undefined' ? '' : document.title);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.title = tabTitle(baseTitle.current, state, buildingChapter(state, inView));
  }, [state, inView]);
  useEffect(
    () => () => {
      if (typeof document !== 'undefined') document.title = baseTitle.current;
    },
    [],
  );

  // What needs the owner while the tab is hidden: a problem, a choice, a reopened part, a
  // chapter built. Only what happened since the board was open here is news.
  const told = useRef(state);
  useEffect(() => {
    const prev = told.current;
    told.current = state;
    if (prev.seq === 0 || connection !== 'open') return;
    tell(newsBetween(prev, state));
  }, [state, connection]);
}
