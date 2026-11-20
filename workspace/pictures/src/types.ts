import type { BoardState, Id, Markings, PictureItem } from '@keel/protocol';

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
}

/**
 * What a picture tells the board when the owner acts on it.
 *
 * - `tap`: a plain tap on something inside. The app decides what it means for the tool in hand.
 * - `ask`, `choice.pick`, `build.start`: drafts of the contract, without `by`. The app posts them.
 * - `walk.step`, `view.pipeline`: the owner changed how they look. The app keeps it in its
 *   own view state and hands it back through `view`. Nothing is posted.
 */
export type PictureAct =
  | { type: 'tap'; item: Id; sub?: string }
  | { type: 'ask'; what: 'focus'; item: Id; part?: Id; lane?: Id }
  | { type: 'choice.pick'; item: Id; option: Id }
  | { type: 'build.start'; chapter: Id; track: Id[]; blueprint: Id; check: string }
  | { type: 'walk.step'; walk: Id; step: number }
  | { type: 'view.pipeline'; view: 'flat' | 'layers' };

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
