import type { Box, Id } from '@keel/protocol';
import { useEffect, useState } from 'react';
import type { CameraStore } from '../camera/camera';
import { fitBox } from '../camera/camera';
import type { Fit } from '../camera/fit';
import type { ViewMode } from '../chrome';
import { nextIdeaDrafts, nextIdeaSpot } from '../story';
import type { Board } from './context';
import type { Focus } from './focusView';
import { NOTE_WIDTH, noteHeight } from './notes';

/** What going from the Story to the board needs of the render it runs in. */
export interface StoryNavNeeds {
  board: Board;
  camera: CameraStore;
  mode: ViewMode;
  boxes: ReadonlyMap<Id, Box>;
  fit: Fit;
  focus: Focus;
  pinView(chapter: Id | undefined): void;
}

/** The ways from the Story back to the board. */
export interface StoryNav {
  /** Show these items on the board. */
  goTo(ids: readonly Id[]): void;
  /** Start the next idea with this note. False when the board refused it. */
  startNextIdea(text: string): Promise<boolean>;
}

/**
 * From the Story to the board: a press on a chapter or a moment goes to its items, and the
 * next idea starts a new chapter with the owner's note in it.
 */
export function useStoryNav({ board, camera, mode, boxes, fit, focus, pinView }: StoryNavNeeds): StoryNav {
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

  /**
   * The next idea: a new chapter and the owner's note in it, in a clear place beyond everything
   * on the board. The board shows again, at the note, with room below it for the agent's pictures.
   */
  const startNextIdea = async (text: string): Promise<boolean> => {
    const id = board.newId();
    const box = nextIdeaSpot(boxes.values(), [NOTE_WIDTH, noteHeight(text)]);
    const drafts = nextIdeaDrafts(board.state(), { id, text, box });
    try {
      // The new chapter and its note are one step, from now.
      if (!(await board.postNew(id, drafts))) return false;
    } finally {
      board.freeId(id);
    }
    focus.close();
    focus.stopOpening();
    board.select(undefined);
    board.setMode('board');
    camera.glide(fitBox([box[0] - 60, box[1] - 60, 1180, box[3] + 520], fit.room(), 1));
    pinView(drafts[0]?.type === 'chapter.open' ? drafts[0].chapter : undefined);
    return true;
  };

  return { goTo, startNextIdea };
}
