import type { Id, MarkItem } from '@keel/protocol';
import { isMark } from '@keel/protocol';
import type { RefObject } from 'react';
import { useCallback, useEffect, useRef } from 'react';
import type { Camera, CameraStore } from '../camera/camera';
import type { Draft } from '../drafts';
import { nextMarkId } from '../drafts';
import { markDrafts } from '../marks';
import { plainRefusal } from '../refusal';
import type { BoardSource, PostResult } from '../source';
import type { StepRecorder } from '../undo';

/** How the page writes to the log. */
export interface Log {
  /** Post one event. A refusal is said to the owner. */
  send(draft: Draft): Promise<PostResult>;
  /** Post a new mark, opening a chapter first when none is in work. */
  postMark(item: MarkItem): Promise<boolean>;
  /**
   * Post the events that put one new thing on the board, in turn: a chapter opened for it first,
   * when it opens one, and then the thing. It is one step, which takes its place in Undo's list
   * now. False when the board refused one of them: the rest are not posted, and no step is left.
   */
  postNew(id: Id, drafts: readonly Draft[]): Promise<boolean>;
  /** An id for a new mark, held until `freeId` so two marks made at once never share one. */
  newId(): Id;
  freeId(id: Id): void;
  /**
   * One gesture of the owner's is about to post on these things: the next event posted on each
   * of them (an add, a change or a take-off) is part of one step, which takes its place in
   * Undo's list now, and Undo takes them back together. The marks of one go of the pen, a drag
   * of several things, Delete with several selected. See `StepRecorder.together`.
   */
  together(ids: readonly Id[]): void;
  /** The owner's last mark here, and where the view was when they made it. */
  lastMark: RefObject<{ mark: Id; cam: Camera } | null>;
}

/**
 * Post one event for the owner, and tell Undo what became of it. This is the one place the
 * owner's steps are recorded, so no tool has to remember to.
 */
export async function postRecorded(source: BoardSource, steps: StepRecorder, draft: Draft): Promise<PostResult> {
  // The step takes its place before the event leaves: steps keep the order the owner made them
  // in, however long each answer takes.
  const landed = steps.begin(draft, source.state);
  let result: PostResult | undefined;
  try {
    result = await source.post(draft);
    return result;
  } finally {
    // Also when the post threw: a step that is never told would keep Undo waiting for it.
    landed?.(result);
  }
}

/**
 * Post the events of one new thing in turn: a chapter opened for it first, when none is in
 * work, and then the thing. Its step takes its place in Undo's list before the first event
 * leaves, as its gesture ends, and not once the chapter is answered: a step made meanwhile
 * comes after it. False when the board refused one of the events; the rest are not posted.
 */
export async function postAsOneStep(send: (draft: Draft) => Promise<PostResult>, steps: StepRecorder, id: Id, drafts: readonly Draft[]): Promise<boolean> {
  steps.together([id]);
  for (const d of drafts) {
    if ((await send(d)).ok) continue;
    steps.notComing(id);
    return false;
  }
  return true;
}

/**
 * The page's side of the log: posting, saying a refusal, and ids for new marks. `made` hears
 * every new id, so the focus view can keep what is made in it above its dim. `steps` hears what
 * is posted, so Undo can take it back.
 */
export function useLog(source: BoardSource, camera: CameraStore, say: (text: string) => void, made: (id: Id) => void, steps: StepRecorder): Log {
  const reserved = useRef(new Set<string>());
  const lastMark = useRef<{ mark: Id; cam: Camera } | null>(null);

  const send = useCallback(
    async (draft: Draft): Promise<PostResult> => {
      const r = await postRecorded(source, steps, draft);
      if (!r.ok) say(`Not saved: ${plainRefusal(r)}`);
      else if (draft.type === 'item.add' && isMark(draft.item)) lastMark.current = { mark: draft.item.id, cam: camera.goal() };
      return r;
    },
    [source, steps, say, camera],
  );

  // A mark the source says was made on this page counts as the owner's last mark too.
  useEffect(() => source.onOwnMark?.((mark) => (lastMark.current = { mark, cam: camera.goal() })), [source, camera]);

  const postNew = useCallback((id: Id, drafts: readonly Draft[]): Promise<boolean> => postAsOneStep(send, steps, id, drafts), [send, steps]);
  const postMark = useCallback((item: MarkItem): Promise<boolean> => postNew(item.id, markDrafts(source.state, item)), [source, postNew]);

  const newId = useCallback(() => {
    // From the whole board: an id one canvas does not show may be another's.
    const id = nextMarkId(source.whole ?? source.state, reserved.current);
    reserved.current.add(id);
    made(id);
    return id;
  }, [source, made]);

  const freeId = useCallback(
    (id: Id) => {
      reserved.current.delete(id);
      // A mark that was to be part of a step and was never posted is not coming any more.
      steps.notComing(id);
    },
    [steps],
  );

  return { send, postMark, postNew, newId, freeId, together: steps.together, lastMark };
}
