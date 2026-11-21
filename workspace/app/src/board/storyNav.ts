import type { Id } from '@keel/protocol';
import { useEffect, useState } from 'react';
import type { Fit } from '../camera/fit';
import type { ViewMode } from '../chrome';
import type { Board } from './context';
import type { Focus } from './focusView';

/** What going from the Story to the board needs of the render it runs in. */
export interface StoryNavNeeds {
  board: Board;
  mode: ViewMode;
  fit: Fit;
  focus: Focus;
  pinView(chapter: Id | undefined): void;
}

/** The ways from the Story back to the board. */
export interface StoryNav {
  /** Show these items on the board. */
  goTo(ids: readonly Id[]): void;
}

/**
 * From the Story to the board: a press on a moment goes to its items.
 */
export function useStoryNav({ board, mode, fit, focus, pinView }: StoryNavNeeds): StoryNav {
  /** Items to go to once the board shows again, after a press in the Story. */
  const [goPending, setGoPending] = useState<readonly Id[] | null>(null);
  const { fitTo } = fit;

  /** The one chapter a set of items belongs to, if they all belong to one. */
  const chapterOf = (ids: readonly Id[]): Id | undefined => {
    const state = board.state();
    const set = new Set(ids.map((id) => state.items[id]?.chapter).filter((c): c is Id => !!c));
    return set.size === 1 ? [...set][0] : undefined;
  };

  // A press in the Story goes to items on the board, once the board shows again, so the fit
  // keeps clear of what the board then shows (the watch panel).
  useEffect(() => {
    if (mode !== 'board' || !goPending) return;
    const ids = goPending;
    setGoPending(null);
    fitTo(ids);
    pinView(chapterOf(ids));
    board.flash(ids);
  }, [mode, goPending, fitTo]);

  const goTo = (ids: readonly Id[]) => {
    focus.close();
    focus.stopOpening();
    board.setMode('board');
    setGoPending([...ids]);
  };

  return { goTo };
}
