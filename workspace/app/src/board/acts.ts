import type { Id } from '@keel/protocol';
import { subId, subKind } from '@keel/protocol';
import type { PictureAct, PictureView } from '@keel/pictures';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useCallback } from 'react';
import { TAP_AFTER_DRAG_MS } from '../input/constants';
import { askToNotify } from '../notify';
import type { Board } from './context';
import type { Log } from './log';

/**
 * What the owner does on a picture: a tap on a part or a lane opens its focus view, a walk
 * steps, the pipeline changes its view, a choice is picked, a build is started. A picture
 * reports each as an act; this is the board's side of every one.
 *
 * `lastDragEnd` is when the last drag on the board ended: a tap that comes right after it is
 * the end of that drag, not a tap. `tryIdea` opens an idea's try room.
 */
export function usePictureActs(
  board: Board,
  send: Log['send'],
  setView: Dispatch<SetStateAction<PictureView>>,
  lastDragEnd: RefObject<number>,
  tryIdea: (chapter: Id) => void,
): (act: PictureAct) => void {
  return useCallback(
    (act: PictureAct) => {
      switch (act.type) {
        case 'tap': {
          // A tap means "open this" only with Select in hand, and not at the end of a drag.
          if (board.tool() !== 'select' || Date.now() - lastDragEnd.current < TAP_AFTER_DRAG_MS || !act.sub) return;
          const k = subKind(act.sub);
          if (k === 'part') board.openFocus({ item: act.item, part: subId(act.sub) });
          else if (k === 'lane') board.openFocus({ item: act.item, lane: subId(act.sub) });
          return;
        }
        case 'ask':
          board.openFocus(act);
          return;
        case 'walk.step':
          setView((v) => ({ ...v, walk: { id: act.walk, step: act.step } }));
          return;
        case 'view.pipeline':
          setView((v) => ({ ...v, pipeline: act.view }));
          return;
        case 'choice.pick':
          void send(act);
          return;
        case 'try':
          tryIdea(act.chapter);
          return;
        case 'build.start': {
          // "Build this" agrees to the blueprint's check: with no check shown, there is nothing to agree to.
          if (!act.check) {
            board.say('This blueprint shows no check, so it cannot be built yet. Ask the agent for the check it will run.');
            return;
          }
          // The owner is about to leave the build to the agent: ask, once, whether the board may tell them.
          askToNotify();
          void send({ ...act, check: act.check });
          return;
        }
      }
    },
    [send, board, setView, lastDragEnd, tryIdea],
  );
}
