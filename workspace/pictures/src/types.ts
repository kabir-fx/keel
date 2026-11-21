import type { BoardState, Id, Markings, PictureItem, ShowPlan } from '@keel/protocol';

/**
 * The seam between the app and the pictures. The app gives a renderer the item, the board's
 * state and how the owner is looking at it. The renderer draws, and tells the app what the
 * owner did on it. A renderer never posts an event and never knows where it sits.
 */

/**
 * How the owner is looking at the board right now. None of it is in the log.
 * A renderer reads what applies to its kind and ignores the rest.
 */
export interface PictureView {
  /** How pipeline pictures are drawn, when the picture's own spec does not say. */
  pipeline?: 'flat' | 'layers';
  /** The walk being played, and the step it is on. Every picture that shows that walk lights the same step. */
  walk?: { id: Id; step: number };
  /** The board's zoom, for renderers that simplify when small. */
  zoom?: number;
  /** The focus picture the app shows large, by its item id. That picture may drop its own title: the app's crumb says it. */
  focus?: Id;
  /**
   * Where a build on the canvas in view goes, as this machine sees it: the blueprint says it
   * above "Build this". Left out where no server speaks.
   */
  build?: BuildPlace;
}

/**
 * What a picture tells the board when the owner acts on it.
 *
 * - `tap`: a plain tap on something inside. The app decides what it means for the tool in hand.
 * - `ask`, `choice.pick`, `build.start`: drafts of the contract, without `by`. The app posts them.
 * - `try`: the owner wants to try another idea's build. The app opens its try room.
 * - `walk.step`, `view.pipeline`: the owner changed how they look. The app keeps it in its
 *   own view state and hands it back through `view`. Nothing is posted.
 */
export type PictureAct =
  | { type: 'tap'; item: Id; sub?: string }
  | { type: 'ask'; what: 'focus'; item: Id; part?: Id; lane?: Id }
  | { type: 'choice.pick'; item: Id; option: Id }
  | { type: 'build.start'; chapter: Id; track: Id[]; blueprint: Id; check: string; setup?: string; show?: ShowPlan }
  | { type: 'try'; chapter: Id }
  | { type: 'walk.step'; walk: Id; step: number }
  | { type: 'view.pipeline'; view: 'flat' | 'layers' };

/** Where a build on the canvas in view goes (record 0014). */
export interface BuildPlace {
  /** The home branch, where a canvas's first build starts. Left out where the folder is no repository. */
  home?: { branch: string; commit?: string };
  /** The canvas's own branch, once it has one: every build on the canvas goes onto it. */
  branch?: string;
  /**
   * Ideas on other canvases that are built and not merged: a build here will not have them.
   * `running`: its show runs now. `held`: why it cannot be tried now, in a sentence.
   */
  waiting: Array<{ chapter: Id; title: string; running?: true; held?: string }>;
}

export interface PictureProps {
  item: PictureItem;
  /** The whole board: the model, the chapters, each item's state. A renderer reads it and never changes it. */
  state: BoardState;
  /** What the owner's pen says about this item: what is crossed out, what is circled. */
  markings?: Markings;
  view?: PictureView;
  onAct?: (act: PictureAct) => void;
}

export const NO_MARKINGS: Markings = { crossed: [], circled: [] };
