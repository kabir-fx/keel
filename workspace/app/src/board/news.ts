import type { Box, Id } from '@keel/protocol';
import type { RefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Camera, CameraStore } from '../camera/camera';
import type { Fit } from '../camera/fit';
import { GLIDE_NEW_MS } from '../input/constants';
import { SEEN_SHARE, shownShare, unseen } from '../notices';
import type { BoardSource } from '../source';
import type { Board } from './context';
import type { Focus } from './focusView';
import type { Log } from './log';

const sameCamera = (a: Camera, b: Camera) => a.x === b.x && a.y === b.y && a.z === b.z;

/** What looking for news needs of the render it runs in. */
export interface NewsNeeds {
  board: Pick<Board, 'boxes' | 'busy' | 'mode' | 'flash'>;
  source: BoardSource;
  camera: CameraStore;
  boxes: ReadonlyMap<Id, Box>;
  fit: Fit;
  focus: Focus;
  lastMark: Log['lastMark'];
  /** The pictures on the board when it first opened: only later ones are news. Null until the first view is fitted. */
  known: RefObject<Set<Id> | null>;
}

/**
 * What is new: a picture that arrives where the owner cannot see it is announced, never flown
 * to. The nudge goes there when pressed. Once it is in view it is not news.
 *
 * It answers with the pictures to announce, and what a press on the nudge does.
 */
export function useNews({ board, source, camera, boxes, fit, focus, lastMark, known }: NewsNeeds): { fresh: readonly Id[]; showNews(): void } {
  /** Pictures that arrived since the board opened and are not in view yet. */
  const [fresh, setFresh] = useState<readonly Id[]>([]);
  const seen = useRef(new Set<Id>());
  /** What a fit made for the owner's mark is bringing into view, and the camera it lands on. */
  const onTheWay = useRef<{ to: Camera; ids: readonly Id[] } | null>(null);
  const { roomKept, fitToRef } = fit;
  const focusOpen = focus.isOpen;

  const look = useCallback(() => {
    if (!known.current) return;
    // Judged by where the camera is going: what a glide is bringing into view is not news. It
    // is seen only once the camera rests with it in view: the owner may stop the glide short
    // of it, and then it is news again.
    const cam = camera.goal();
    const atRest = !camera.gliding();
    const sent = onTheWay.current;
    if (sent && atRest) {
      // The fit for the owner's mark has landed, and what it went for has been shown, as well
      // as the board can show it. Or the owner stopped it short, and it is news again.
      if (sameCamera(cam, sent.to)) for (const id of sent.ids) seen.current.add(id);
      onTheWay.current = null;
    }
    // Asked on every frame of a camera move: the room as last measured. The page is read for it once after the board is drawn, not once a frame.
    const r = roomKept();
    const now = board.boxes();
    const list = unseen(source.state, known.current, seen.current, (id) => now.get(id));
    const still = list.filter((id) => {
      if (shownShare(now.get(id)!, cam, r) < SEEN_SHARE) return true;
      if (atRest) seen.current.add(id);
      return false;
    });
    // The owner made a mark and has not moved the view since: what the agent drew for it is
    // brought into view, with the mark. Once the owner moves the view, it is a nudge again.
    const last = lastMark.current;
    // The fit goes for a picture once: what is on its way is not asked for again.
    const wanted = still.filter((id) => !onTheWay.current?.ids.includes(id));
    if (wanted.length > 0 && last && sameCamera(cam, last.cam) && !board.busy() && !focusOpen() && board.mode() === 'board') {
      const mark = source.state.items[last.mark];
      // With them comes what a glide under way was already bringing: that is not seen yet.
      const ids = list.filter((id) => !seen.current.has(id));
      fitToRef.current(mark && !mark.removed ? [last.mark, ...ids] : ids, [], GLIDE_NEW_MS);
      last.cam = camera.goal();
      onTheWay.current = { to: last.cam, ids };
      board.flash(wanted);
      setFresh((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    if (onTheWay.current) return;
    setFresh((prev) => (prev.length === still.length && prev.every((x, i) => x === still[i]) ? prev : still));
  }, [camera, roomKept, source, board, focusOpen, fitToRef, known, lastMark]);
  useEffect(() => camera.subscribe(look), [camera, look]);
  useEffect(() => look(), [boxes, look]);

  const showNews = () => {
    const ids = [...fresh];
    if (ids.length === 0) return;
    // A picture that is not part of the open focus view is on the board: leave the view for it.
    // The fit then waits for the render that closes the view, where the build is back as it
    // was, so what it shows is clear of the build.
    if (focus.isOpen() && ids.some((id) => !focus.raised?.has(id))) {
      focus.leave();
      fit.fitAfterRender(ids, [], GLIDE_NEW_MS);
    } else fit.fitTo(ids, [], GLIDE_NEW_MS);
    board.flash(ids);
  };

  return { fresh, showNews };
}
