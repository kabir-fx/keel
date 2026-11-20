import type { BoardState, Box, Id } from '@keel/protocol';
import { currentChapter } from '@keel/protocol';
import type { RefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Camera, CameraStore } from '../camera/camera';
import { chapterInView } from '../inview';
import type { BoardSource } from '../source';

/** The chapter the owner looks at: the pill and the watch panel follow it. */
export interface InView {
  /** The chapter whose items fill most of the screen, as last measured. */
  inView: Id | undefined;
  /** The chapter in view: measured from the camera once the board is fitted, else the one in work. */
  chapter: Id | undefined;
  /** The same, for a callback that must read it later. */
  chapterRef: RefObject<Id | undefined>;
  /** The board just went to this chapter: it is in view until the owner moves the camera. */
  pin(chapter: Id | undefined): void;
  /** Measure again which chapter is in view. Stable while the camera, the source and the window are. */
  look(): void;
}

/**
 * Which chapter is in view. This half keeps the answer; `useFollowChapter` measures it as the
 * camera moves. They are two hooks because the answer is needed early in a render (the watch
 * panel and the room a fit keeps clear depend on it), and the measuring must start after the
 * board's other listeners on the camera.
 *
 * `fitted` is true once the first view is fitted: nothing is measured before.
 */
export function useChapterInView(
  camera: CameraStore,
  source: BoardSource,
  state: BoardState,
  viewport: { w: number; h: number },
  boxes: () => ReadonlyMap<Id, Box>,
  fitted: RefObject<boolean>,
): InView {
  const [inView, setInView] = useState<Id>();
  /** The chapter the board just went to, and the camera that shows it: in view until the owner moves. */
  const pinned = useRef<{ chapter: Id; cam: Camera } | null>(null);
  const pin = useCallback(
    (chapter: Id | undefined) => {
      if (!chapter) return;
      // Where the camera is going, not where it is: a fit glides, and the pin is for its end.
      pinned.current = { chapter, cam: camera.goal() };
      setInView(chapter);
    },
    [camera],
  );
  const chapter = inView && state.chapters[inView] ? inView : currentChapter(state);
  const chapterRef = useRef<Id | undefined>(undefined);
  chapterRef.current = chapter;

  // The chapter in view: whose items fill most of the screen, under the pills and above the
  // toolbar. Looked at once the first view is fitted, and on every move after.
  const look = useCallback(() => {
    if (!fitted.current) return;
    // While the camera glides, the view that counts is the one it is going to.
    const cam = camera.goal();
    // The board just went to a chapter: that chapter is in view until the owner moves.
    const p = pinned.current;
    if (p && p.cam.x === cam.x && p.cam.y === cam.y && p.cam.z === cam.z && source.state.chapters[p.chapter]) {
      setInView((prev) => (prev === p.chapter ? prev : p.chapter));
      return;
    }
    pinned.current = null;
    const next = chapterInView(source.state, (id) => boxes().get(id), cam, [0, 80, viewport.w, Math.max(100, viewport.h - 180)]);
    setInView((prev) => (prev === next ? prev : next));
  }, [camera, source, viewport, boxes, fitted]);

  return { inView, chapter, chapterRef, pin, look };
}

/** Measure the chapter in view on every move of the camera, and whenever the boxes change. */
export function useFollowChapter(camera: CameraStore, boxes: ReadonlyMap<Id, Box>, look: () => void): void {
  useEffect(() => camera.subscribe(look), [camera, look]);
  useEffect(() => look(), [boxes, look]);
}
