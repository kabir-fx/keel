import { z } from 'zod';
import { Actor, Box, EventId, Id } from './ids';
import { Item, ItemPatch } from './items';
import { Check, ModelOp, PartState } from './model';
import { ShowPlan } from './pictures';

/**
 * The board log is an append-only list of events. The state of the board is the log, reduced.
 * A draft is an event before the log owner has numbered and dated it.
 */

const common = {
  /** Who did it. The server sets this from the connection and never trusts the sender. */
  by: Actor,
  /** The chapter the event belongs to. */
  chapter: Id.optional(),
};


/** The first event of every board. */
export const BoardOpen = z.strictObject({
  ...common,
  type: z.literal('board.open'),
  name: z.string().min(1).max(80),
});

/**
 * A new canvas: a blank place for an idea, with a branch of its own once it is built. The
 * owner starts one from the Story. Its title is the title of the first idea on it, unless
 * one is given here.
 */
export const CanvasOpen = z.strictObject({
  ...common,
  type: z.literal('canvas.open'),
  canvas: Id,
  title: z.string().min(1).max(90).optional(),
});

/**
 * A new idea starts. The owner's first note on a canvas opens one. `canvas` is the canvas it
 * is on: every idea on one canvas is built on that canvas's branch. Left out, it is the
 * board's first canvas, which is made for it when the board has none.
 */
export const ChapterOpen = z.strictObject({
  ...common,
  type: z.literal('chapter.open'),
  chapter: Id,
  title: z.string().min(1).max(90),
  canvas: Id.optional(),
});

export const ChapterRename = z.strictObject({
  ...common,
  type: z.literal('chapter.rename'),
  chapter: Id,
  title: z.string().min(1).max(90),
});

/** A mark from the owner, or a picture from the agent. */
export const ItemAdd = z.strictObject({
  ...common,
  type: z.literal('item.add'),
  chapter: Id,
  item: Item,
});

/** Move an item, edit a note, resize a picture, or replace a placeholder with the finished picture. */
export const ItemUpdate = z.strictObject({
  ...common,
  type: z.literal('item.update'),
  /** The id of the item to change. */
  item: Id,
  patch: ItemPatch,
});

/**
 * The app found room for a picture. A picture is placed once. A second placement is
 * refused, so two open tabs cannot both place it. After that it is moved with `item.update`.
 */
export const ItemPlace = z.strictObject({
  ...common,
  type: z.literal('item.place'),
  item: Id,
  box: Box,
});

/** Take your own item off the board. It stays in the log: nothing is deleted. */
export const ItemRemove = z.strictObject({
  ...common,
  type: z.literal('item.remove'),
  item: Id,
});

export const ItemRestore = z.strictObject({
  ...common,
  type: z.literal('item.restore'),
  item: Id,
});

/**
 * The agent answers marks without a new picture. It must say how it read them: the board
 * shows that sentence beside the mark, so nothing is closed without something to see.
 */
export const Answer = z.strictObject({
  ...common,
  type: z.literal('answer'),
  answers: z.array(Id).min(1).max(40),
  read: z
    .string()
    .min(1)
    .max(400)
    .refine((v) => /[\p{L}\p{N}]/u.test(v), 'say how you read it, in words'),
});

/** The agent changes the model: lanes, parts, edges, walks. Never a part's state. */
export const ModelPatch = z.strictObject({
  ...common,
  type: z.literal('model.patch'),
  ops: z.array(ModelOp).min(1).max(80),
});

/**
 * A part changes state. Only the owner makes a part solid. `built` needs a commit and a
 * passed check. Reopening a decided part needs the owner, or the owner's mark as `because`.
 */
export const PartStateEvent = z.strictObject({
  ...common,
  type: z.literal('part.state'),
  part: Id,
  state: PartState,
  commit: z.string().min(1).max(80).optional(),
  check: Check.optional(),
  /** The owner's marks that caused a reopen. */
  because: z.array(Id).min(1).max(8).optional(),
});

/** The owner's gate: the picks become the decided idea, and the chapter's idea parts become solid. */
export const Solidify = z.strictObject({
  ...common,
  type: z.literal('solidify'),
  chapter: Id,
  /** The items the owner chose. */
  picks: z.array(Id).max(40),
  /**
   * The parts to make solid: exactly the ones the owner saw as ideas when they pressed.
   * The app lists them, so nothing an agent adds in the same moment is decided unseen.
   */
  parts: z.array(Id).max(60),
  /** The lasso the picks came from, if any. */
  lasso: Id.optional(),
});

/** "Build this". The track is the ordered parts to build, one commit each. */
export const BuildStart = z.strictObject({
  ...common,
  type: z.literal('build.start'),
  chapter: Id,
  track: z.array(Id).min(1).max(40),
  /** The blueprint picture the owner pressed the button on. */
  blueprint: Id.optional(),
  /**
   * The check command the blueprint showed. The owner agreed to it by pressing the button.
   * A part is built only when exactly this command has passed.
   */
  check: z.string().min(1).max(300),
  /** The setup command the blueprint showed, when it showed one. Agreed to with the same press. */
  setup: z.string().min(1).max(300).optional(),
  /** How the blueprint said the owner tries the result. The same press agrees to what it runs. */
  show: ShowPlan.optional(),
});

export const BuildPause = z.strictObject({
  ...common,
  type: z.literal('build.pause'),
  chapter: Id,
});

export const BuildResume = z.strictObject({
  ...common,
  type: z.literal('build.resume'),
  chapter: Id,
});

/**
 * The app the owner will try started in the build's copy and answered on its port once
 * (record 0013). Only the board server's side says so. A chapter that is tried as an `app`
 * is built only after this: until then it is building, with every part built.
 */
export const BuildProved = z.strictObject({
  ...common,
  type: z.literal('build.proved'),
  chapter: Id,
});

/**
 * The owner tried what was built on a canvas and approves it: the canvas's branch goes into
 * the home branch, with every built idea on it. The board server does the merge, and says
 * `canvas.merged` when the home branch has it.
 */
export const CanvasApprove = z.strictObject({
  ...common,
  type: z.literal('canvas.approve'),
  canvas: Id,
});

/**
 * The home branch has a canvas's work. Only the board server says so, after it moved the
 * branch itself or found the work already there. `commit` is the commit the home branch was
 * moved to, and `into` is the home branch's name. Every built idea on the canvas is merged.
 */
export const CanvasMerged = z.strictObject({
  ...common,
  type: z.literal('canvas.merged'),
  canvas: Id,
  commit: z.string().min(1).max(80),
  into: z.string().min(1).max(200),
});

/**
 * The owner deletes a canvas. Every idea on it leaves the board with its items, its build
 * stops, and the board server takes its branch away. The log keeps every line: nothing is
 * deleted from it.
 */
export const CanvasRemove = z.strictObject({
  ...common,
  type: z.literal('canvas.remove'),
  canvas: Id,
});

/** One entry in the build feed. */
export const FeedAdd = z.strictObject({
  ...common,
  type: z.literal('feed.add'),
  chapter: Id,
  text: z.string().min(1).max(400),
  kind: z.enum(['update', 'commit', 'check', 'problem']).optional(),
  part: Id.optional(),
  /** Only the build's own tools report a commit or a check. An agent's entry has neither. */
  commit: z.string().min(1).max(80).optional(),
  check: Check.optional(),
  /** The owner's requests this entry answers, such as "Build this" or a pause. Marks are answered on the board. */
  answers: z.array(Id).max(24).optional(),
});

/** The owner changes a choice the agent made. */
export const ChoicePick = z.strictObject({
  ...common,
  type: z.literal('choice.pick'),
  item: Id,
  option: Id,
});

/** The owner asks for something by tapping: today, the focus of one part or one lane. */
export const Ask = z.strictObject({
  ...common,
  type: z.literal('ask'),
  what: z.literal('focus'),
  /** The part that was tapped. Give this or `lane`. */
  part: Id.optional(),
  /** The lane that was tapped. */
  lane: Id.optional(),
  /** The picture that was tapped. */
  item: Id.optional(),
});

/** A saved view inside a chapter, shown as a thumbnail in the Story. */
export const MomentAdd = z.strictObject({
  ...common,
  type: z.literal('moment.add'),
  chapter: Id,
  title: z.string().min(1).max(90),
  items: z.array(Id).min(1).max(24),
});

export const EventDraft = z.discriminatedUnion('type', [
  BoardOpen,
  CanvasOpen,
  ChapterOpen,
  ChapterRename,
  ItemAdd,
  ItemUpdate,
  ItemPlace,
  ItemRemove,
  ItemRestore,
  Answer,
  ModelPatch,
  PartStateEvent,
  Solidify,
  BuildStart,
  BuildPause,
  BuildResume,
  BuildProved,
  CanvasApprove,
  CanvasMerged,
  CanvasRemove,
  FeedAdd,
  ChoicePick,
  Ask,
  MomentAdd,
]);
export type EventDraft = z.infer<typeof EventDraft>;
export type EventType = EventDraft['type'];

/**
 * What the log owner adds: a number and a time.
 * No draft may have a field named `id` or `at`: the stamp would replace it.
 */
export const Stamp = z.strictObject({
  id: EventId,
  at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, 'a time is ISO 8601 in UTC'),
});
export type Stamp = z.infer<typeof Stamp>;

export type BoardEvent = EventDraft & Stamp;

/** One event of a given type, as a draft. */
export type DraftOf<T extends EventType> = Extract<EventDraft, { type: T }>;
/** One event of a given type, stamped. */
export type EventOf<T extends EventType> = DraftOf<T> & Stamp;

/** The owner's acts that the agent must respond to. They count as open, like marks. */
export const ACT_TYPES = [
  'solidify',
  'build.start',
  'build.pause',
  'build.resume',
  'choice.pick',
  'ask',
] as const satisfies readonly EventType[];
/** An act's type. The owner's own `part.state` is an act too: deciding, reopening or putting off one part. */
export type ActType = (typeof ACT_TYPES)[number] | 'part.state';

export function isActType(t: EventType): t is (typeof ACT_TYPES)[number] {
  return (ACT_TYPES as readonly string[]).includes(t);
}

/** Is this event an act of the owner that the agent must hear? */
export function isAct(ev: { type: EventType; by: z.infer<typeof Actor> }): boolean {
  return ev.by === 'owner' && (isActType(ev.type) || ev.type === 'part.state');
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function describe(error: z.ZodError): string {
  return error.issues
    .slice(0, 6)
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

/** Check the shape of a draft. The rules are checked separately, against the board's state. */
export function parseDraft(input: unknown): ParseResult<EventDraft> {
  const r = EventDraft.safeParse(input);
  return r.success ? { ok: true, value: r.data } : { ok: false, reason: describe(r.error) };
}

/** Check the shape of a stamped event, as read from a log. */
export function parseEvent(input: unknown): ParseResult<BoardEvent> {
  if (typeof input !== 'object' || input === null) return { ok: false, reason: 'an event is an object' };
  const { id, at, ...rest } = input as Record<string, unknown>;
  const stamp = Stamp.safeParse({ id, at });
  if (!stamp.success) return { ok: false, reason: describe(stamp.error) };
  const draft = parseDraft(rest);
  if (!draft.ok) return draft;
  return { ok: true, value: { ...draft.value, ...stamp.data } };
}

/** Stamp a draft. The log owner calls this, with the next number and the time. */
export function stamp(draft: EventDraft, seq: number, at: string): BoardEvent {
  return { ...draft, id: `e${seq}`, at };
}
