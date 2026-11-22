import { z } from 'zod';
import { Anchor, AssetPath, Box, Coord, Id, Point, Sub, Target } from './ids';
import { PictureSpec } from './pictures';

/**
 * An item is anything placed on the board. The owner makes marks. The agent makes pictures.
 * The app, not the agent, works out what a mark points at.
 */

/**
 * One pen stroke: flat x,y pairs in board units, counted from the top-left corner of the
 * item's `box`. Everything inside a mark is counted that way (strokes, a lasso's path, an
 * arrow's ends, a pin's point), so moving a mark is a change of its `box` and nothing else.
 */
export const Stroke = z.strictObject({
  pts: z
    .array(Coord)
    .min(4)
    .max(6000)
    .refine((p) => p.length % 2 === 0, 'a stroke is x,y pairs'),
  /** The stroke's width in board units. */
  w: z.number().min(0.5).max(24).optional(),
});
export type Stroke = z.infer<typeof Stroke>;

/** How the app read a stroke: a closed loop is a circle, two crossed strokes are a cross. */
export const InkHint = z.enum(['circle', 'cross', 'underline', 'none']);
export type InkHint = z.infer<typeof InkHint>;

const base = {
  id: Id,
  /** Where the mark was drawn, in board units. */
  box: Box,
  rot: z.number().min(-45).max(45).optional(),
  /** The thing the mark was drawn against, so the mark follows it. The app sets it. */
  anchor: Anchor.optional(),
};

/** A handwritten note. `on` is the item it is stuck to, if any. */
export const NoteItem = z.strictObject({
  ...base,
  kind: z.literal('note'),
  text: z.string().min(1).max(2000),
  on: Target.optional(),
  /** True for a label in the owner's hand with no paper behind it, such as a name inside a sketch. */
  plain: z.boolean().optional(),
});
export type NoteItem = z.infer<typeof NoteItem>;

/** Pen strokes drawn in one go. With no targets it is a free sketch, and the snapshot is how the agent sees it. */
export const InkItem = z.strictObject({
  ...base,
  kind: z.literal('ink'),
  strokes: z.array(Stroke).min(1).max(120),
  targets: z.array(Target).max(24),
  hint: InkHint,
  /** A PNG of the region, so the agent can look when the targets do not say enough. */
  snapshot: AssetPath.optional(),
});
export type InkItem = z.infer<typeof InkItem>;

/** A drawn rectangle, with an optional label. */
export const BoxItem = z.strictObject({
  ...base,
  kind: z.literal('box'),
  text: z.string().max(200).optional(),
});
export type BoxItem = z.infer<typeof BoxItem>;

/** A share of a length: 0 is its start, 1 its end. */
export const Share = z.number().min(0).max(1);

/**
 * How one end of an arrow holds on to its target: a spot inside the target, and how the end
 * is drawn to it. The spot is kept as shares of the target's box, so it stays the same spot
 * when the target moves or changes size.
 *
 * - `inside`: the end is drawn at the spot itself.
 * - `outline`: the end is aimed at the spot and stops at the target's outline, with a small gap.
 */
export const ArrowTie = z.strictObject({
  /** `[0, 0]` is the target's top-left corner, `[1, 1]` its bottom-right corner. */
  at: z.tuple([Share, Share]),
  mode: z.enum(['inside', 'outline']),
});
export type ArrowTie = z.infer<typeof ArrowTie>;

/**
 * A drawn arrow. `from` and `to` are counted from the top-left corner of `box`. The app
 * fills in the items at each end, and draws an end that has a target to where that target
 * is now, so an arrow stays joined when a picture moves.
 *
 * An end with a target may also carry a tie, which says where on the target it holds. An end
 * with a target and no tie (every arrow from before ties existed) is drawn as it always was.
 */
export const ArrowItem = z.strictObject({
  ...base,
  kind: z.literal('arrow'),
  from: Point,
  to: Point,
  fromTarget: Target.optional(),
  toTarget: Target.optional(),
  fromTie: ArrowTie.optional(),
  toTie: ArrowTie.optional(),
  text: z.string().max(200).optional(),
  /** Where the label sits along the line, from `from` to `to`. In the middle when left out. */
  labelAt: Share.optional(),
});
export type ArrowItem = z.infer<typeof ArrowItem>;

/**
 * One end of an arrow as the owner set it again. It replaces that end whole: its point, its
 * target and its tie. With no target, the end holds on to nothing.
 */
export const ArrowEnd = z.strictObject({
  /** Counted from the top-left corner of the arrow's `box`: the new box, when the same patch moves it. */
  at: Point,
  target: Target.optional(),
  tie: ArrowTie.optional(),
});
export type ArrowEnd = z.infer<typeof ArrowEnd>;

/** A pin dropped on a point of an item, with an optional remark. `at` is counted from the top-left corner of `box`. */
export const PinItem = z.strictObject({
  ...base,
  kind: z.literal('pin'),
  at: Point,
  on: Target.optional(),
  text: z.string().max(400).optional(),
});
export type PinItem = z.infer<typeof PinItem>;

/** A loop drawn round several items: a selection the owner can solidify. `path` is counted from the top-left corner of `box`. */
export const LassoItem = z.strictObject({
  ...base,
  kind: z.literal('lasso'),
  path: z
    .array(Coord)
    .min(6)
    .max(4000)
    .refine((p) => p.length % 2 === 0, 'a lasso path is x,y pairs'),
  targets: z.array(Target).max(40),
});
export type LassoItem = z.infer<typeof LassoItem>;

/** A file the owner dropped in. The copy lives under `assets/`. */
export const FileItem = z.strictObject({
  ...base,
  kind: z.literal('file'),
  name: z.string().min(1).max(200),
  asset: AssetPath,
  mime: z.string().max(100).optional(),
  size: z.number().int().min(0).optional(),
});
export type FileItem = z.infer<typeof FileItem>;

/** A remark the owner said out loud, as text, with what was in view. */
export const VoiceItem = z.strictObject({
  ...base,
  kind: z.literal('voice'),
  text: z.string().min(1).max(2000),
  on: Target.optional(),
});
export type VoiceItem = z.infer<typeof VoiceItem>;

/** Where to put a picture, relative to another item or one thing inside it. The app turns this into a box. */
export const Place = z.strictObject({
  near: Id.optional(),
  /** One thing inside `near`, such as "approach:a", to sit beside that and not the whole item. */
  sub: Sub.optional(),
  side: z.enum(['right', 'below', 'left', 'above']).optional(),
});
export type Place = z.infer<typeof Place>;

/**
 * Something the agent drew. It has no box until the app has measured it and found room,
 * because only the renderer knows how large a picture is.
 */
export const PictureItem = z.strictObject({
  id: Id,
  kind: z.literal('picture'),
  picture: PictureSpec,
  box: Box.optional(),
  place: Place.optional(),
  /** The marks and requests this picture answers. Each one stops being open. */
  answers: z.array(Id).max(40).optional(),
  /** The items this picture grew out of. The board draws an arrow from each. */
  from: z.array(Id).max(12).optional(),
  /** `drawing` is a placeholder the owner sees at once. Replace it with the finished picture. */
  status: z.enum(['drawing', 'done']).optional(),
});
export type PictureItem = z.infer<typeof PictureItem>;

export const MarkItem = z.discriminatedUnion('kind', [
  NoteItem,
  InkItem,
  BoxItem,
  ArrowItem,
  PinItem,
  LassoItem,
  FileItem,
  VoiceItem,
]);
export type MarkItem = z.infer<typeof MarkItem>;

export const Item = z.discriminatedUnion('kind', [
  NoteItem,
  InkItem,
  BoxItem,
  ArrowItem,
  PinItem,
  LassoItem,
  FileItem,
  VoiceItem,
  PictureItem,
]);
export type Item = z.infer<typeof Item>;

export type ItemKind = Item['kind'];
export type MarkKind = MarkItem['kind'];

export const MARK_KINDS = [
  'note',
  'ink',
  'box',
  'arrow',
  'pin',
  'lasso',
  'file',
  'voice',
] as const satisfies readonly MarkKind[];

export function isMark(item: Item): item is MarkItem {
  return item.kind !== 'picture';
}

/** What an `item.update` may change. Which fields apply depends on the item and on who asks. */
export const ItemPatch = z.strictObject({
  box: Box.optional(),
  rot: z.number().min(-45).max(45).optional(),
  /** For a note, a box label, an arrow label, a pin or a spoken remark. */
  text: z.string().max(2000).optional(),
  /** For a picture: the whole new spec. */
  picture: PictureSpec.optional(),
  status: z.enum(['drawing', 'done']).optional(),
  answers: z.array(Id).max(40).optional(),
  from: z.array(Id).max(12).optional(),
  /** For an arrow: one of its ends, set again by its author. */
  arrowFrom: ArrowEnd.optional(),
  arrowTo: ArrowEnd.optional(),
  /** For an arrow: where its label sits along the line. */
  labelAt: Share.optional(),
  /** For an arrow: the thing it hangs on, set again with its ends by its author. `null` when it hangs on nothing now. */
  anchor: Anchor.nullable().optional(),
});
export type ItemPatch = z.infer<typeof ItemPatch>;

/** An arrow hung on a thing, or on nothing (`null`). */
export function withAnchor(arrow: ArrowItem, anchor: Anchor | null): ArrowItem {
  const next: ArrowItem = { ...arrow };
  if (anchor) next.anchor = anchor;
  else delete next.anchor;
  return next;
}

/** An arrow with one end set again. A target or a tie the new end does not name is dropped. */
export function withArrowEnd(arrow: ArrowItem, which: 'from' | 'to', end: ArrowEnd): ArrowItem {
  const { fromTarget, toTarget, fromTie, toTie, ...rest } = arrow;
  const from: ArrowEnd = which === 'from' ? end : { at: arrow.from, target: fromTarget, tie: fromTie };
  const to: ArrowEnd = which === 'to' ? end : { at: arrow.to, target: toTarget, tie: toTie };
  return {
    ...rest,
    from: from.at,
    to: to.at,
    ...(from.target ? { fromTarget: from.target } : {}),
    ...(from.tie ? { fromTie: from.tie } : {}),
    ...(to.target ? { toTarget: to.target } : {}),
    ...(to.tie ? { toTie: to.tie } : {}),
  };
}

/** Every target a mark carries, whatever its kind. */
export function targetsOf(item: Item): Target[] {
  switch (item.kind) {
    case 'ink':
    case 'lasso':
      return item.targets;
    case 'note':
    case 'pin':
    case 'voice':
      return item.on ? [item.on] : [];
    case 'arrow':
      return [item.fromTarget, item.toTarget].filter((t): t is Target => t !== undefined);
    default:
      return [];
  }
}
