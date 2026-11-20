import type { Id } from './ids';
import type { PresenceUpdate } from './wire';

/**
 * A fixture is a board log with checkpoints. A checkpoint names a moment in the log and
 * what the owner was looking at then. The app replays a fixture with no server and no
 * agent, so every screen can be built and checked against the same story.
 */

/** What is on screen at a checkpoint. None of this is in the log: it is the owner's view. */
export interface CheckpointView {
  mode: 'board' | 'story';
  /** Fit the view to these items. */
  show?: Id[];
  /** The focus picture that is open, by its item id. */
  focus?: Id;
  /** The walk being played, and the step it is on. */
  walk?: { id: Id; step: number };
  /** How pipeline pictures are drawn. */
  pipeline?: 'flat' | 'layers';
  /** What the presence pill says at this moment. */
  presence?: PresenceUpdate;
}

export interface Checkpoint {
  /** 1 to 7, in the order of the storyboard. */
  screen: number;
  /** A short slug: "main", "pictures", "model". */
  name: string;
  title: string;
  /** The id of the last event that has happened at this checkpoint. */
  after: string;
  view: CheckpointView;
}
