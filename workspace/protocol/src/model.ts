import { z } from 'zod';
import { Id } from './ids';

/**
 * The model is the data behind every pipeline picture: lanes, parts, edges, walks.
 * One model per board. The pictures are views of it, which is how one picture carries
 * the idea, the decision, the progress and the status.
 */

/** How committed a part is. Drawn as: dashed, solid outline, blue, filled, grey. */
export const PartState = z.enum(['idea', 'solid', 'building', 'built', 'later']);
export type PartState = z.infer<typeof PartState>;

/** The evidence that a part works: the command that was run, and whether it passed. */
export const Check = z.strictObject({
  cmd: z.string().min(1).max(300),
  passed: z.boolean(),
});
export type Check = z.infer<typeof Check>;

/**
 * A row of the model. A lane is a person, a thread or a process, or the channel between
 * two of them (a queue). It is never a module: two parts of one server share the server's
 * lane. In the Layers view a lane is a floor.
 */
export const Lane = z.strictObject({
  id: Id,
  name: z.string().min(1).max(32),
  /** A few plain words under the name: "the asyncio event loop". */
  note: z.string().max(48).optional(),
});
export type Lane = z.infer<typeof Lane>;

/** One component in the model. */
export const Part = z.strictObject({
  id: Id,
  /** What the owner calls it: "The door", or the code name "EngineClient". */
  name: z.string().min(1).max(32),
  /** What it does, in plain words: "the door: 64 at most". */
  plain: z.string().max(48).optional(),
  /**
   * The lane it sits in. A part with no lane is work that has no place in the pipeline,
   * such as a check or a line in the docs: it shows on the build track only.
   */
  lane: Id.optional(),
  /** The column in its lane, counted from 1. A grid slot, not a pixel. Two parts with the same column line up across lanes. */
  col: z.number().int().min(1).max(16).optional(),
  state: PartState,
  /** The commit that built it. Needed for `built`. */
  commit: z.string().min(1).max(80).optional(),
  check: Check.optional(),
  /** True when the repository had this part before the board did. */
  shelf: z.boolean().optional(),
  /** True for something outside the system: a client, another service. It is there, and nobody here builds it. */
  external: z.boolean().optional(),
  /** Where it lives in the repository. */
  files: z.array(z.string().min(1).max(200)).max(12).optional(),
  note: z.string().max(200).optional(),
});
export type Part = z.infer<typeof Part>;

/** What the agent sends to add or change a part. Only `id` is always needed. */
export const PartInput = z.strictObject({
  id: Id,
  name: z.string().min(1).max(32).optional(),
  plain: z.string().max(48).optional(),
  lane: Id.optional(),
  /** Leave it out and a new part takes the next free column of its lane. */
  col: z.number().int().min(1).max(16).optional(),
  /** Only when the part is new: `idea` (the default), `later`, or `built` with `commit` and `shelf`. Leave it out for an `external` part. */
  state: PartState.optional(),
  commit: z.string().min(1).max(80).optional(),
  shelf: z.boolean().optional(),
  /** Only when the part is new: true for something outside the system. It needs no state and no commit. */
  external: z.boolean().optional(),
  files: z.array(z.string().min(1).max(200)).max(12).optional(),
  note: z.string().max(200).optional(),
});
export type PartInput = z.infer<typeof PartInput>;

/** An arrow between two parts. `wait` draws dashed: the sender sleeps until the answer comes. */
export const Edge = z.strictObject({
  from: Id,
  to: Id,
  label: z.string().max(40).optional(),
  kind: z.enum(['flow', 'wait']).optional(),
});
export type Edge = z.infer<typeof Edge>;

export const WalkStep = z.strictObject({
  n: z.number().int().min(1).max(40),
  part: Id,
  text: z.string().min(1).max(90),
});
export type WalkStep = z.infer<typeof WalkStep>;

/** One request followed through the model, as numbered steps. */
export const Walk = z.strictObject({
  id: Id,
  name: z.string().min(1).max(60),
  steps: z.array(WalkStep).min(1).max(24),
});
export type Walk = z.infer<typeof Walk>;

/**
 * A small model in one value: a candidate inside a picture, before it is the board's model.
 * At most 12 parts and 16 edges. More than that does not read. Draw the edges the walk
 * travels first.
 */
export const ModelData = z.strictObject({
  lanes: z.array(Lane).min(1).max(6),
  parts: z.array(Part).min(1).max(12),
  edges: z.array(Edge).max(16).optional(),
  walks: z.array(Walk).max(3).optional(),
});
export type ModelData = z.infer<typeof ModelData>;

/**
 * One change to the board's model. Part states do not change here: a `part.state` event
 * does that, so the rules about who may decide and what counts as built live in one place.
 */
export const ModelOp = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('lane.set'), lane: Lane, at: z.number().int().min(0).max(12).optional() }),
  z.strictObject({ op: z.literal('part.set'), part: PartInput }),
  z.strictObject({ op: z.literal('part.drop'), id: Id }),
  z.strictObject({ op: z.literal('edge.set'), edge: Edge }),
  z.strictObject({ op: z.literal('edge.drop'), from: Id, to: Id }),
  z.strictObject({ op: z.literal('walk.set'), walk: Walk }),
  z.strictObject({ op: z.literal('walk.drop'), id: Id }),
]);
export type ModelOp = z.infer<typeof ModelOp>;
