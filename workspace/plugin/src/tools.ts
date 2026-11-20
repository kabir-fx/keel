import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { BoardState, DigestReply, ModelOp as ModelOpT } from '@keel/protocol';
import {
  Answer,
  ChapterRename,
  Edge,
  FeedAdd,
  Id,
  Lane,
  ModelOp,
  PICTURE_KINDS,
  PartInput,
  PartStateEvent,
  PictureItem,
  PictureSpec,
  Place,
  Walk,
  describeTarget,
  liveParts,
  liveWalks,
  targetsOf,
} from '@keel/protocol';
import { BoardClient, BoardError, RefusedError, refusalText } from './client';
import { explainError } from './explain';
import { toolPresence } from './presence';

/**
 * The board tools: how the agent draws on the board. Every limit comes from the contract's
 * own schemas. A picture spec is checked here against the contract, so a wrong one comes
 * back with the place and the limit in plain words; the board server then checks the rules.
 * A refusal comes back as the tool's error text, word for word.
 *
 * The grammar of a picture is taught by `skills/board/grammar.md`, not by this schema: the
 * strict JSON schema of every picture kind is four times the size of that file and says
 * less. So `picture` is open here and checked in the handler.
 */

/* ---------------------------------------------------------------- inputs */

const answers = (what: string) => PictureItem.shape.answers.describe(what);

/** A picture spec, checked against the contract in the handler. Its keys are in the grammar. */
const PictureArg = z
  .looseObject({ kind: z.enum(PICTURE_KINDS) })
  .describe('A picture spec in the board grammar: "kind" and the keys of that kind, as grammar.md lists them.');

export const PostPicture = z.strictObject({
  picture: PictureArg,
  answers: answers('The ids of the open marks and acts this picture answers. Each one stops being open.'),
  from: PictureItem.shape.from.describe('The items this picture grew out of. The board draws an arrow from each.'),
  // Open here: a placement hint that is not an item is dropped, not refused, and the board places the picture itself.
  near: z.string().max(120).optional().describe('An item id to put this picture next to. Left out: beside what it answers.'),
  side: Place.shape.side.describe('Which side of "near".'),
  status: PictureItem.shape.status.describe('"drawing" posts a placeholder the owner sees at once. Finish it later by its id.'),
  name: Id.optional().describe('An id you choose for a new picture, such as "spread-2", so later entries can name it in "from" or finish it. Left out, the board picks one.'),
  id: Id.optional().describe('Only to finish or redraw a picture already on the board: its id. The new spec replaces it.'),
});
export type PostPicture = z.infer<typeof PostPicture>;

// `ModelOp.options[0]` is `lane.set`: the type check fails here if the contract moves it.
const LaneAt = Lane.extend({
  at: ModelOp.options[0].shape.at.describe('Where the lane goes, counted from 0 at the top. Left out: below the others.'),
});

/** A change to the board's model, in the shape the grammar teaches. */
export const ModelBody = z.strictObject({
  lanes: z.array(LaneAt).optional().describe('Lanes to add or change: a person, a thread, a process, or a queue between two. Never a module.'),
  parts: z.array(PartInput).optional().describe('Parts to add or change. A new part needs a name.'),
  edges: z.array(Edge).optional(),
  walks: z.array(Walk).optional().describe('One request followed through the parts, as numbered steps.'),
  drop: z
    .strictObject({
      parts: z.array(Id).optional(),
      edges: z.array(z.strictObject({ from: Id, to: Id })).optional(),
      walks: z.array(Id).optional(),
    })
    .optional()
    .describe('What to take out. Only an idea part can be dropped.'),
});
export type ModelBody = z.infer<typeof ModelBody>;

/** A model patch answers nothing: a mark closes when the owner can see the answer, on a picture or in words. */
export const ModelInput = ModelBody;
export type ModelInput = z.infer<typeof ModelInput>;

export const PostInput = z.strictObject({
  pictures: z.array(PostPicture).min(1).max(8),
  model: ModelBody.optional().describe(
    "A change to the board's model, made before the pictures in the same call, so they can name its parts and walks. All of it lands, or none.",
  ),
  chapter: Id.optional().describe('Left out: the chapter of the first mark it answers, else the current chapter.'),
  rename: ChapterRename.shape.title
    .optional()
    .describe("A name for the chapter in two to five words, posted first. On your first answer to a new idea only: once the owner decides it, its name is theirs."),
});
export type PostInput = z.infer<typeof PostInput>;

export const ReadInput = z.strictObject({
  items: z.array(Id).min(1).max(8).optional().describe('Items to open in full: a picture\'s whole spec, or a mark, and the marks on it.'),
  model: z.boolean().optional().describe("True: the board's whole model, with every edge and every walk step."),
});
export type ReadInput = z.infer<typeof ReadInput>;

export const AnswerInput = z.strictObject({
  answers: Answer.shape.answers.describe('The ids of the open marks and acts this answers.'),
  read: Answer.shape.read.describe('How you read them, and your answer, in plain words. The owner reads it. Required: it is what closes them.'),
});

export const PartStateInput = z.strictObject({
  part: PartStateEvent.shape.part,
  state: PartStateEvent.shape.state,
  commit: PartStateEvent.shape.commit.describe('For "built": the commit that built it.'),
  check: PartStateEvent.shape.check.describe('For "built": the command that was run, and whether it passed.'),
  because: PartStateEvent.shape.because.describe("To reopen a decided part: the owner's open mark on that part, made after it was decided. Reopen before you answer that mark."),
});

export const UpdateInput = z.strictObject({
  text: FeedAdd.shape.text.describe('One or two plain sentences for the build feed.'),
  part: FeedAdd.shape.part,
  kind: z.enum(['update', 'problem']).optional().describe('"problem" when something needs the owner. A commit or a check comes from the build\'s own tools.'),
  answers: FeedAdd.shape.answers.describe('Only the owner\'s requests (acts) this entry answers, such as "Build this" or a pause. Never a mark: answer a mark on the board.'),
});

/* ----------------------------------------------------------- translation */

/** One `model.patch`: drops first, then lanes, parts, edges and walks, so a drop never undoes a set. */
export function modelOps(input: ModelBody): ModelOpT[] {
  const ops: ModelOpT[] = [];
  for (const id of input.drop?.walks ?? []) ops.push({ op: 'walk.drop', id });
  for (const e of input.drop?.edges ?? []) ops.push({ op: 'edge.drop', from: e.from, to: e.to });
  for (const id of input.drop?.parts ?? []) ops.push({ op: 'part.drop', id });
  for (const { at, ...lane } of input.lanes ?? []) ops.push(at === undefined ? { op: 'lane.set', lane } : { op: 'lane.set', lane, at });
  for (const part of input.parts ?? []) ops.push({ op: 'part.set', part });
  for (const edge of input.edges ?? []) ops.push({ op: 'edge.set', edge });
  for (const walk of input.walks ?? []) ops.push({ op: 'walk.set', walk });
  return ops;
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A short id for a new picture. The "a-" keeps it apart from marks and from event ids. */
export function newPictureId(): string {
  let s = '';
  for (const b of crypto.randomBytes(6)) s += ALPHABET[b % ALPHABET.length];
  return `a-${s}`;
}

/** Drop the keys whose value is undefined, so the draft carries only what was given. */
function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** The chapter for new pictures: the one given, else that of the first open thing answered, else the current one. */
function chapterFor(d: DigestReply, given: string | undefined, answered: readonly string[]): string {
  if (given) return given;
  for (const id of answered) {
    const c = d.digest.open.find((o) => o.id === id)?.chapter;
    if (c) return c;
  }
  const c = d.digest.chapter?.id;
  if (!c) throw new BoardError('There is no chapter on the board yet. The owner opens one with a first note.');
  return c;
}

/** "picture 2 of 3 (spread)": how a refusal names the entry it is about. */
function pictureLabel(input: PostInput, i: number): string {
  return `picture ${i + 1} of ${input.pictures.length} (${input.pictures[i]?.picture.kind ?? '?'})`;
}

/**
 * Check every picture spec against the contract before anything is sent, so a wrong one is
 * named with its place and its limit. Returns the error text, or undefined when all are fine.
 */
export function checkSpecs(input: PostInput): string | undefined {
  for (let i = 0; i < input.pictures.length; i++) {
    const spec = input.pictures[i]!.picture;
    const r = PictureSpec.safeParse(spec);
    if (!r.success) {
      return [
        `Refused ${pictureLabel(input, i)}. Nothing was posted.`,
        `Reason: ${explainError(r.error, spec, 'the picture')}`,
        `The keys and limits of "${spec.kind}" are in its keys line in the grammar. Fix that and call the tool again.`,
      ].join('\n');
    }
  }
  return undefined;
}

export interface BuiltPost {
  drafts: unknown[];
  /** What each draft is, for a refusal: "the model", "picture 2 of 3 (spread)". */
  labels: string[];
  /** The id of each picture, in the order given. */
  ids: string[];
  replaced: boolean[];
  /** What the tool changed on the way, said back to the agent. */
  notes: string[];
}

/**
 * The ids a post may use, checked against the board before anything is sent: `id` finishes a
 * picture that exists, `name` gives a new one an id that is free. Returns the error, if any.
 */
export function checkIds(input: PostInput, state: BoardState): string | undefined {
  const named = new Set<string>();
  for (let i = 0; i < input.pictures.length; i++) {
    const p = input.pictures[i]!;
    const what = pictureLabel(input, i);
    if (p.id !== undefined && p.name !== undefined) return `Refused ${what}. Give "id" to finish a picture that is on the board, or "name" for a new one, not both.`;
    if (p.id !== undefined && !state.items[p.id] && !named.has(p.id)) {
      return `Refused ${what}. Nothing was posted.\nReason: there is no picture "${p.id}" to finish. To give a new picture an id of your choosing, use "name".`;
    }
    if (p.name !== undefined) {
      if (state.items[p.name] || named.has(p.name)) return `Refused ${what}. Nothing was posted.\nReason: the id "${p.name}" is taken on this board. Pick another name, such as "${p.name}-2".`;
      named.add(p.name);
    }
  }
  return undefined;
}

/** A `near` that is not an item on the board is dropped: the board then places the picture beside what it answers. */
export function nearOf(near: string | undefined, state: BoardState | undefined, named: ReadonlySet<string>): string | undefined {
  if (near === undefined || !Id.safeParse(near).success) return undefined;
  if (state && !state.items[near] && !named.has(near)) return undefined;
  return near;
}

/** The drafts for one `board_post`: the model patch first, if any, then one per picture. */
export function postDrafts(input: PostInput, chapter: () => string, state?: BoardState): BuiltPost {
  const out: BuiltPost = { drafts: [], labels: [], ids: [], replaced: [], notes: [] };
  if (input.rename !== undefined) {
    out.drafts.push({ type: 'chapter.rename', chapter: chapter(), title: input.rename });
    out.labels.push("the chapter's name");
  }
  if (input.model) {
    const ops = modelOps(input.model);
    if (ops.length > 0) {
      out.drafts.push({ type: 'model.patch', chapter: chapter(), ops });
      out.labels.push('the model');
    }
  }
  const named = new Set<string>();
  input.pictures.forEach((p, i) => {
    out.labels.push(pictureLabel(input, i));
    if (p.id !== undefined) {
      // A redraw never opens again what the picture answered: new answers join the old ones.
      const before = state?.items[p.id]?.item;
      const old = before?.kind === 'picture' ? (before.answers ?? []) : [];
      const answers = p.answers === undefined ? undefined : [...new Set([...old, ...p.answers])];
      out.drafts.push({
        type: 'item.update',
        item: p.id,
        patch: defined({ picture: p.picture, status: p.status ?? 'done', answers, from: p.from }),
      });
      out.ids.push(p.id);
      out.replaced.push(true);
      return;
    }
    const id = p.name ?? newPictureId();
    const near = nearOf(p.near, state, named);
    if (p.near !== undefined && near === undefined) {
      out.notes.push(`"near": "${p.near}" of picture ${i + 1} is not an item on the board, so the board placed it beside what it answers.`);
    }
    named.add(id);
    const place = near !== undefined || p.side !== undefined ? defined({ near, side: p.side }) : undefined;
    out.drafts.push({
      type: 'item.add',
      chapter: chapter(),
      item: defined({ id, kind: 'picture', picture: p.picture, answers: p.answers, from: p.from, place, status: p.status }),
    });
    out.ids.push(id);
    out.replaced.push(false);
  });
  return out;
}

/* --------------------------------------------------------------- reading */

/** A mark without its geometry: what it says and what it points at. */
function markView(state: BoardState, id: string): Record<string, unknown> | undefined {
  const s = state.items[id];
  if (!s || s.item.kind === 'picture') return undefined;
  const it = s.item;
  const out: Record<string, unknown> = { id, kind: it.kind };
  if ('text' in it && it.text !== undefined) out.text = it.text;
  if (it.kind === 'ink') out.hint = it.hint;
  if (it.kind === 'file') out.file = `${it.name} (.keel/board/${it.asset})`;
  if (it.kind === 'ink' && it.snapshot) out.snapshot = `.keel/board/${it.snapshot}`;
  const targets = targetsOf(it).map((t) => describeTarget(state, t).label);
  if (targets.length) out.on = targets;
  if (state.answered[id] === undefined) out.open = true;
  return out;
}

/** One item in full, as the agent reads it with `board_read`. */
export function itemView(state: BoardState, id: string): string {
  const s = state.items[id];
  if (!s) return `${id}: there is no such item.`;
  if (s.item.kind !== 'picture') return JSON.stringify(markView(state, id));
  const it = s.item;
  const head = defined({ id, by: s.by, answers: it.answers, from: it.from, status: it.status, removed: s.removed || undefined });
  const marks: string[] = [];
  for (const other of Object.values(state.items)) {
    if (other.by !== 'owner' || other.removed || other.item.kind === 'picture') continue;
    const on = targetsOf(other.item).filter((t) => t.item === id);
    if (on.length === 0) continue;
    const m = markView(state, other.item.id);
    marks.push(`  ${other.item.id} ${other.item.kind}${m?.hint && m.hint !== 'none' ? ` ${String(m.hint)}` : ''}${m?.text ? ` "${String(m.text)}"` : ''} on ${on.map((t) => t.sub ?? 'the whole picture').join(', ')}${m?.open ? ' (open)' : ''}`);
  }
  return [`${JSON.stringify(head)}`, JSON.stringify(it.picture), ...(marks.length ? ['marks on it:', ...marks] : [])].join('\n');
}

/** The whole model, every edge and walk step: what the digest leaves out. */
export function modelView(state: BoardState): string {
  const m = state.model;
  if (liveParts(state).length === 0) return 'The model is empty.';
  const parts = liveParts(state).map(({ chapter: _c, dropped: _d, ...p }) => p);
  return JSON.stringify({ lanes: m.lanes, parts, edges: m.edges, walks: liveWalks(state) });
}

/* ----------------------------------------------------------------- tools */

const INSTRUCTIONS =
  "The owner's board. Answer every open mark and act with board_post or board_answer, and put its id in \"answers\". The board_read digest says what is open.";

const ok = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] });
const fail = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true });

export function createBoardMcp(client: BoardClient = new BoardClient()): McpServer {
  const server = new McpServer({ name: 'board', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

  /** Report presence, run the call, and turn a refusal into words the agent can act on. */
  const run = async (tool: string, args: unknown, fn: () => Promise<string>, what?: (index: number) => string): Promise<CallToolResult> => {
    await client.presence(toolPresence(tool, args));
    try {
      return ok(await fn());
    } catch (e) {
      if (e instanceof RefusedError) return fail(refusalText(e.refusal, what));
      if (e instanceof BoardError) return fail(e.message);
      throw e;
    }
  };

  /** The current chapter, read from the digest only when a draft needs one. */
  const chapterOf = async (given?: string, answered: readonly string[] = []) => chapterFor(await client.digest(), given, answered);

  server.registerTool(
    'board_read',
    {
      description: [
        'The board now. With no input: the digest, as a wake holds it. A wake already holds it: call this only to look again.',
        '"items": open pictures or marks in full, such as a spread you drew before, with the marks on it.',
        '"model": the whole model, with every edge and walk step.',
      ].join(' '),
      inputSchema: ReadInput,
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      run('board_read', args, async () => {
        if (!args.items && !args.model) return (await client.digest()).text;
        const state = await client.state();
        const out: string[] = [];
        for (const id of args.items ?? []) out.push(itemView(state, id));
        if (args.model) out.push(`MODEL ${modelView(state)}`);
        return out.join('\n\n');
      }),
  );

  server.registerTool(
    'board_post',
    {
      description: [
        "Put pictures on the board. Each picture is a spec in the board's grammar (grammar.md): the board lays it out.",
        'Each one names the open marks it answers in "answers", or the items it grows out of in "from".',
        'A slow picture: post a placeholder with status "drawing" first, then post again with its id and the finished spec.',
        '"model" patches the board\'s model first, in the same call, so a pipeline, walk or focus can name its parts.',
        'All of it lands, or none of it. Returns the picture ids, in order.',
      ].join(' '),
      inputSchema: PostInput,
    },
    async (args) => {
      let labels: string[] = [];
      return run(
        'board_post',
        args,
        async () => {
          const bad = checkSpecs(args);
          if (bad) throw new BoardError(bad);
          // The board's items, only when a post names one: to finish, to name, or to place near.
          const needsState = args.pictures.some((p) => p.id !== undefined || p.name !== undefined || p.near !== undefined);
          const state = needsState ? await client.state() : undefined;
          const ids = state ? checkIds(args, state) : undefined;
          if (ids) throw new BoardError(ids);
          const answered = args.pictures.flatMap((p) => (p.id === undefined ? (p.answers ?? []) : []));
          const needsChapter = args.model !== undefined || args.rename !== undefined || args.pictures.some((p) => p.id === undefined);
          const chapter = needsChapter ? await chapterOf(args.chapter, answered) : '';
          const built = postDrafts(args, () => chapter, state);
          labels = built.labels;
          await client.post(built.drafts);
          const list = built.ids.map((id, i) => (built.replaced[i] ? `${id} (replaced)` : id));
          return [`Posted: ${list.join(', ')}${built.labels[0] === 'the model' ? ' (after the model patch)' : ''}`, ...built.notes].join('\n');
        },
        (i) => labels[i] ?? `entry ${i + 1}`,
      );
    },
  );

  server.registerTool(
    'board_answer',
    {
      description: 'Answer open marks with words only: "read" says how you read them, and the owner sees it. Prefer a small picture or a text card with "answers". Use this only when a picture would add nothing.',
      inputSchema: AnswerInput,
    },
    async (args) =>
      run('board_answer', args, async () => {
        const [ev] = await client.post([{ type: 'answer', answers: args.answers, read: args.read }]);
        return `Answered ${args.answers.join(', ')}${ev ? ` (${ev.id})` : ''}.`;
      }),
  );

  server.registerTool(
    'board_model',
    {
      description: [
        "Change the board's model, the data behind every pipeline picture: lanes, parts, edges, walks. One call is one patch.",
        'Drops go first, then lanes, parts, edges and walks, so a later one may use an earlier one.',
        "A part's state does not change here: use board_part. A patch answers no mark: to patch the model and post its pictures in one call, give board_post a \"model\", and put \"answers\" on the finished picture.",
      ].join(' '),
      inputSchema: ModelInput,
    },
    async (args) =>
      run('board_model', args, async () => {
        const ops = modelOps(args);
        if (ops.length === 0) throw new BoardError('The patch is empty. Give lanes, parts, edges, walks or drop.');
        const chapter = await chapterOf();
        const [ev] = await client.post([{ type: 'model.patch', chapter, ops }]);
        return `Patched the model: ${ops.length} change${ops.length === 1 ? '' : 's'}${ev ? ` (${ev.id})` : ''}.`;
      }),
  );

  server.registerTool(
    'board_part',
    {
      description:
        'Move one part to a new state. Only the owner makes a part solid. "building" and "built" are the builder\'s and the board\'s check\'s, not yours. To reopen a decided part, name in "because" the owner\'s open mark on it, made after it was decided; reopen before you post the picture that answers that mark. A part answers no mark.',
      inputSchema: PartStateInput,
    },
    async (args) =>
      run('board_part', args, async () => {
        const [ev] = await client.post([defined({ type: 'part.state', ...args })]);
        return `Part ${args.part} is ${args.state}${ev ? ` (${ev.id})` : ''}.`;
      }),
  );

  server.registerTool(
    'board_update',
    {
      description: 'Add one entry to the build feed, in plain words: an update or a problem. "answers" may name the owner\'s requests (acts) only; a mark is answered on the board.',
      inputSchema: UpdateInput,
    },
    async (args) =>
      run('board_update', args, async () => {
        const chapter = await chapterOf();
        const [ev] = await client.post([defined({ type: 'feed.add', chapter, ...args })]);
        return `Added to the feed${ev ? ` (${ev.id})` : ''}.`;
      }),
  );

  return server;
}
