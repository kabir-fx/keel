import type { BoardState, Box, Id } from '@keel/protocol';
import type { RefObject } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Camera, CameraStore } from '../camera/camera';
import { sameCamera, unionBox } from '../camera/camera';
import type { Fit } from '../camera/fit';
import { reveal, shows } from '../camera/reveal';
import { GLIDE_NEW_MS } from '../input/constants';
import { EASE } from '../motion/ease';
import { motionPlays } from '../motion/plays';
import { CAMERA_REVEAL_MS, SAME_PX } from '../motion/timing';
import { SEEN_SHARE, shownShare, unseen } from '../notices';
import type { BoardSource } from '../source';
import type { Board } from './context';
import type { Focus } from './focusView';
import type { Log } from './log';

/**
 * The placeholders of `drawing` that are finished and have their finished place now, at a
 * rectangle of their own: news again. `drawing` is kept as it goes: a placeholder still drawn
 * keeps where it was last drawn; one finished in place, or gone, leaves it. A finished one still
 * on its spot here (`onSpot`) has the placeholder's rectangle, and one with no box has none yet:
 * both wait for their finished place.
 */
export function finishedInPlace(drawing: Map<Id, Box>, state: BoardState, boxOf: (id: Id) => Box | undefined, onSpot: (id: Id) => boolean, zoom: number): Id[] {
  const out: Id[] = [];
  for (const [id, was] of drawing) {
    const s = state.items[id];
    if (!s || s.removed || s.item.kind !== 'picture') {
      drawing.delete(id);
      continue;
    }
    const box = boxOf(id);
    if (s.item.status === 'drawing') {
      if (box) drawing.set(id, box);
      continue;
    }
    if (!box || onSpot(id)) continue;
    drawing.delete(id);
    if (!was.every((n, i) => Math.abs(n - box[i]!) * zoom <= SAME_PX)) out.push(id);
  }
  return out;
}

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
  /** The placeholders drawn at a spot of this page's own, not placed in the log (`Ahead.provisional`). */
  spots: ReadonlyMap<Id, Box>;
}

/**
 * What is new: a picture that arrives where the owner cannot see it is announced, never flown
 * to. The nudge goes there when pressed. Once it is in view it is not news.
 *
 * The one exception is the agent's answer to the owner's last mark, while the owner has not
 * moved the view since: the camera makes the smallest move that shows mark and answer whole
 * (`reveal`). A picture less than half shown asks for it until it is seen or on its way; one
 * more than half shown but cut by the room's edge asks once, as it arrives; one wholly in view
 * never moves the camera.
 *
 * A placeholder the agent finishes is news again once it has its finished place, as if it
 * arrived then: it is often larger than the placeholder, and may no longer be in view. On its
 * placeholder's spot, or with no box yet, it waits for that place; finished at the very
 * rectangle the placeholder had, nothing is new.
 *
 * It answers with the pictures to announce, and what a press on the nudge does.
 */
export function useNews({ board, source, camera, boxes, fit, focus, lastMark, known, spots }: NewsNeeds): { fresh: readonly Id[]; showNews(): void } {
  /** Pictures that arrived since the board opened and are not in view yet. */
  const [fresh, setFresh] = useState<readonly Id[]>([]);
  const seen = useRef(new Set<Id>());
  /** The new pictures looked at already: whether one is cut by the room's edge is asked once, as it arrives. */
  const met = useRef(new Set<Id>());
  /** What a reveal made for the owner's mark is bringing into view, and the camera it lands on. */
  const onTheWay = useRef<{ to: Camera; ids: readonly Id[] } | null>(null);
  /** The placeholders met, and where each was last drawn: empty, and not looked at, while the agent draws none. */
  const drawing = useRef(new Map<Id, Box>());
  /** The placeholders' spots as of this render, for the look that runs after it. */
  const spotsNow = useRef(spots);
  spotsNow.current = spots;
  const { roomKept } = fit;
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
      // The reveal for the owner's mark has landed, and what it went for has been shown, as well
      // as the board can show it. Or the owner stopped it short, and it is news again.
      if (sameCamera(cam, sent.to)) for (const id of sent.ids) seen.current.add(id);
      onTheWay.current = null;
    }
    // Asked on every frame of a camera move: the room as last measured. The page is read for it once after the board is drawn, not once a frame.
    const r = roomKept();
    const now = board.boxes();
    if (drawing.current.size > 0) {
      // Looked at again as if it arrived now.
      for (const id of finishedInPlace(drawing.current, source.state, (id) => now.get(id), (id) => spotsNow.current.has(id), cam.z)) {
        seen.current.delete(id);
        met.current.delete(id);
      }
    }
    const list = unseen(source.state, known.current, seen.current, (id) => now.get(id));
    /** Pictures that arrived just now more than half shown, but cut by the room's edge. */
    let cut: Id[] | undefined;
    /** Pictures first looked at in this look: they arrived in this commit. */
    const arrived = new Set<Id>();
    const still = list.filter((id) => {
      const box = now.get(id)!;
      const first = !met.current.has(id);
      if (first) {
        met.current.add(id);
        arrived.add(id);
        const it = source.state.items[id]?.item;
        if (it?.kind === 'picture' && it.status === 'drawing') drawing.current.set(id, box);
      }
      if (shownShare(box, cam, r) < SEEN_SHARE) return true;
      if (first && !shows(cam, r, box)) (cut ??= []).push(id);
      if (atRest) seen.current.add(id);
      return false;
    });
    // The owner made a mark and has not moved the view since: what the agent drew for it is
    // brought into view, with the mark. Once the owner moves the view, it is a nudge again.
    const last = lastMark.current;
    // The reveal goes for a picture once: what is on its way is not asked for again.
    const wanted = still.filter((id) => !onTheWay.current?.ids.includes(id));
    if ((wanted.length > 0 || cut) && last && sameCamera(cam, last.cam) && !board.busy() && !focusOpen() && board.mode() === 'board') {
      const asked = cut ? [...wanted, ...cut] : wanted;
      // With them comes what a glide under way was already bringing: that is not seen yet.
      const ids = [...(onTheWay.current?.ids ?? []), ...asked];
      const mark = source.state.items[last.mark];
      const together = mark && !mark.removed ? [last.mark, ...ids] : ids;
      const target = unionBox(together.map((id) => now.get(id)).filter((b): b is Box => !!b));
      const to = target ? reveal(cam, r, target) : cam;
      if (to !== cam) {
        camera.glide(to, CAMERA_REVEAL_MS, EASE.move);
        last.cam = to;
        onTheWay.current = { to, ids };
        // With motion, a picture that arrived just now is drawn on as it comes, and that says it
        // is new; one that arrived earlier out of view was not drawn on, so it blinks once, as
        // every picture does without motion.
        const blink = motionPlays() ? asked.filter((id) => !arrived.has(id)) : asked;
        if (blink.length > 0) board.flash(blink);
        setFresh((prev) => (prev.length === 0 ? prev : []));
        return;
      }
    }
    if (onTheWay.current) return;
    setFresh((prev) => (prev.length === still.length && prev.every((x, i) => x === still[i]) ? prev : still));
  }, [camera, roomKept, source, board, focusOpen, known, lastMark]);
  useEffect(() => camera.subscribe(look), [camera, look]);
  // Before the page is painted: when a picture gets its place, where the camera is going is set
  // in the same commit. The arrival, whose layout effect comes later in `App`, asks
  // `camera.goal()` whether the picture will be in view. The room was thrown away by `useFit`'s
  // layout effect earlier in this commit, so it is measured here, once, and the camera's frames
  // that follow remember it.
  useLayoutEffect(() => look(), [boxes, look]);

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
