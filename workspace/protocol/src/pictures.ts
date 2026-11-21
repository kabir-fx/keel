import { z } from 'zod';
import { Id, Target } from './ids';
import { ModelData, PartState } from './model';

/**
 * The picture grammar. The agent writes a small spec and the renderer does the layout,
 * the sizes and the colours. A spec holds no pixel, no colour and no size. It names lanes,
 * columns and order.
 *
 * Every object is strict: an unknown key is an error, and a text over its limit is an
 * error, so a wrong spec is refused with a message the agent can act on, and is never
 * half-drawn. The limits were tested with fresh agents (spike S3): they are what the
 * renderer can lay out.
 */

const line = (max: number) => z.string().min(1).max(max);
const text = (max: number) => z.string().max(max);

/**
 * What the picture cannot say. When the grammar cannot show something you need, draw the
 * closest picture and write what is missing here, in short sentences.
 */
const gaps = z.array(line(200)).max(6).optional();

/** A tone for a small box. `blue` is what the agent proposes. `teal` is the live request. */
export const Tone = z.enum(['plain', 'blue', 'teal', 'grey', 'dark']);
export type Tone = z.infer<typeof Tone>;

/* ---------------------------------------------------------------- text */

/**
 * An agent card: a header and a few plain sentences.
 * Use it to say how you read the owner ("How I read your sketch"), to give your lean,
 * and to ask at most three questions.
 */
export const TextPicture = z.strictObject({
  kind: z.literal('text'),
  title: line(90),
  body: text(900).optional(),
  /** Short lines, drawn as a list. */
  points: z.array(line(200)).max(6).optional(),
  /** What you would choose, in one or two sentences. The owner decides. */
  lean: text(320).optional(),
  /** Questions for the owner. Each becomes a tap target "q:1", "q:2", "q:3". */
  questions: z.array(line(200)).max(3).optional(),
});
export type TextPicture = z.infer<typeof TextPicture>;

/* --------------------------------------------------------------- shelf */

/** One thing the repository already has that bears on the idea. */
export const ShelfTile = z.strictObject({
  id: Id,
  name: line(32),
  plain: text(60).optional(),
  /** Where it is: a path, a pull request, a commit. */
  ref: text(80).optional(),
  state: PartState.optional(),
  /** The model part this tile stands for, when there is one. */
  part: Id.optional(),
});
export type ShelfTile = z.infer<typeof ShelfTile>;

/** "Already on the shelf": tiles for what exists. Tap target per tile: "tile:<id>". */
export const ShelfPicture = z.strictObject({
  kind: z.literal('shelf'),
  title: line(90).optional(),
  tiles: z.array(ShelfTile).min(1).max(8),
});
export type ShelfPicture = z.infer<typeof ShelfPicture>;

/* --------------------------------------------------------------- lanes */

/**
 * A row. A lane is a person, a thread or a process, or the channel between two of them
 * (a queue). Never a module: two parts of one server share the server's lane. The caller
 * goes on top.
 */
export const LanesLane = z.strictObject({
  id: Id,
  name: line(32),
  /** A few plain words under the name. */
  note: text(48).optional(),
});
export type LanesLane = z.infer<typeof LanesLane>;

/** A box inside a lane. Tap target: "step:<id>". */
export const LanesStep = z.strictObject({
  id: Id,
  lane: Id,
  /** One short line of plain words: "Handler awaits its output queue (sleeps)". */
  text: line(60),
  /** Number the steps when order matters. Then time runs left to right. */
  n: z.number().int().min(1).max(40).optional(),
  /** Pins the step to a column, counted from 1. Leave it out: the renderer places steps by number and by flow. */
  col: z.number().int().min(1).max(16).optional(),
});
export type LanesStep = z.infer<typeof LanesStep>;

/**
 * An arrow from one step to another, by step id. `wait` draws dashed: the actor at `from`
 * sleeps until `to`. A flow to an earlier step draws a loop back.
 */
export const LanesFlow = z.strictObject({
  from: Id,
  to: Id,
  label: text(64).optional(),
  wait: z.boolean().optional(),
});
export type LanesFlow = z.infer<typeof LanesFlow>;

const lanesBody = {
  lanes: z.array(LanesLane).min(1).max(6),
  steps: z.array(LanesStep).min(1).max(16),
  flows: z.array(LanesFlow).max(24).optional(),
  /** A dashed vertical line just before a step: a second round trip, or a later phase. */
  divider: z.strictObject({ before: Id, label: text(32).optional() }).optional(),
  /** One or two sentences under the picture. */
  caption: text(280).optional(),
  gaps,
};

/** The drawing itself: what a lanes picture and a lanes approach share. */
export const LanesBody = z.strictObject(lanesBody);
export type LanesBody = z.infer<typeof LanesBody>;

/** Who does what, in what order: lanes, numbered steps and labelled arrows. The owner's own drawing style. */
export const LanesPicture = z.strictObject({
  kind: z.literal('lanes'),
  title: line(70),
  ...lanesBody,
  /** One sentence: what could go wrong. */
  risk: text(200).optional(),
});
export type LanesPicture = z.infer<typeof LanesPicture>;

/* ---------------------------------------------------------------- free */

/**
 * The elements a free drawing may hold. Shapes, text, gradients and clips: nothing that runs,
 * loads or links, and nothing that draws other shapes many times over. So no `use` and no
 * `symbol`, and no `marker`, `pattern` or `mask`: one that refers to another, a few levels
 * deep, makes a small drawing ask the browser for millions of shapes, and the tab stops.
 */
const SVG_ELEMENTS = new Set([
  'svg', 'g', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'text', 'tspan',
  'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath',
  'title', 'desc',
]);

/** The most elements one free drawing holds. A screen needs far fewer. */
const SVG_MAX_ELEMENTS = 600;
/** The longest side a free drawing's view may have, in its own units. */
const SVG_MAX_SIDE = 10_000;
/** How many times longer one side of the view may be than the other. */
const SVG_MAX_RATIO = 5;

const TAG = /<\s*(\/?)\s*([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const ATTR = /([^\s=/"'<>]+)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;

/**
 * What is wrong with a free drawing, or undefined when it is fine.
 *
 * The renderer shows the drawing as an image and never puts it into the page as markup, so
 * nothing in it can run or load. This check is the second fence, not the first. It reads the
 * tags and their attributes, not the text between them, so a label such as "Metadata:" or
 * "online = true" is fine.
 */
export function svgProblem(value: string): string | undefined {
  const s = value.trim();
  if (/<[!?]/.test(s)) return 'svg may not hold comments, CDATA, a doctype or processing instructions';
  const tags = [...s.matchAll(TAG)];
  // No `use` and no `symbol`: one small drawing could ask the browser for millions of shapes.
  // Elements are counted, not tags: `<rect/>` is one element, and so is `<g>` with its `</g>`.
  if (tags.filter((t) => t[1] !== '/').length > SVG_MAX_ELEMENTS) return `svg may hold at most ${SVG_MAX_ELEMENTS} elements`;
  const first = tags[0];
  const last = tags[tags.length - 1];
  if (!first || first.index !== 0 || first[1] === '/' || first[2]!.toLowerCase() !== 'svg') return 'svg must be one <svg> element';
  if (!last || last[1] !== '/' || last[2]!.toLowerCase() !== 'svg' || last.index! + last[0].length !== s.length) {
    return 'svg must be one <svg> element, closed at the end';
  }
  let roots = 0;
  let viewBox = false;
  /** How deep inside a `clipPath` the tag is. */
  let clip = 0;
  for (const tag of tags) {
    const name = tag[2]!.toLowerCase();
    if (!SVG_ELEMENTS.has(name)) return `svg may not hold <${tag[2]}>`;
    if (tag[1] === '/') {
      if (name === 'clippath' && clip > 0) clip -= 1;
      continue;
    }
    if (name === 'svg') roots += 1;
    const inClip = clip > 0;
    if (name === 'clippath' && !/\/\s*$/.test(tag[3]!)) clip += 1;
    for (const attr of tag[3]!.matchAll(ATTR)) {
      const key = attr[1]!.toLowerCase();
      const raw = attr[2] ?? '';
      const val = raw.replace(/^["']|["']$/g, '');
      if (key.startsWith('on')) return 'svg may not hold event handlers';
      // An arrowhead is a small polygon. A marker is drawn again at every point of a line.
      if (key.startsWith('marker') || /(^|[;\s])marker(-start|-mid|-end)?\s*:/i.test(val)) return 'svg may not use markers: draw an arrowhead as a small polygon';
      if (key === 'mask' || /(^|[;\s])mask(-image)?\s*:/i.test(val)) return 'svg may not use a mask';
      // A clip that is itself clipped, level after level, multiplies the work the same way.
      if (inClip && (key === 'clip-path' || /url\s*\(/i.test(val))) return 'svg may not refer to anything from inside a <clipPath>';
      if (key === 'href' || key.endsWith(':href') || key === 'src') {
        if (!val.startsWith('#')) return 'svg may only link to something inside the same drawing';
      }
      if (/&(?!(amp|lt|gt|quot|apos);)/.test(val)) return 'svg attributes may not hold character references';
      if (/javascript:|data:|@import|expression\s*\(|image-set|\\/i.test(val)) return 'svg may not hold javascript:, data:, @import or escapes';
      if (/url\(\s*(?!["']?#)/i.test(val)) return 'svg may only use url() for something inside the same drawing';
      if (name === 'svg' && roots === 1 && key === 'viewbox') {
        viewBox = true;
        // The board draws it at a fixed width. A view a thousand times taller than wide would be a picture miles long.
        const n = val.trim().split(/[\s,]+/).map(Number);
        const [w, h] = [n[2] ?? NaN, n[3] ?? NaN];
        if (n.length !== 4 || n.some((v) => !Number.isFinite(v)) || w <= 0 || h <= 0 || w > SVG_MAX_SIDE || h > SVG_MAX_SIDE) {
          return `svg viewBox must be four numbers, with a width and a height from just above 0 to ${SVG_MAX_SIDE}`;
        }
        if (w / h > SVG_MAX_RATIO || h / w > SVG_MAX_RATIO) return `svg viewBox may be at most ${SVG_MAX_RATIO} times wider than tall, or taller than wide`;
      }
    }
  }
  if (roots !== 1) return 'svg must be one <svg> element, with no <svg> inside it';
  if (!viewBox) return 'svg needs a viewBox on its <svg> element';
  return undefined;
}

/** One `<svg>` element with a `viewBox`, checked by `svgProblem`. */
export const Svg = z
  .string()
  .max(16_000)
  .superRefine((v, ctx) => {
    const problem = svgProblem(v);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });

/**
 * The way out, for what no other kind can show, such as the layout of a screen. Use it
 * rarely: the owner cannot mark what is inside it, and it has no part states.
 * Draw flat: white boxes with a 1.5 px #0F1B2D outline, light fills #F4F6F9, text in
 * #0F1B2D and #46536A, and #1D4ED8 only for what differs.
 */
export const FreePicture = z.strictObject({
  kind: z.literal('free'),
  title: line(70),
  svg: Svg,
  caption: text(280).optional(),
  gaps,
});
export type FreePicture = z.infer<typeof FreePicture>;

/* -------------------------------------------------------------- spread */

/** One way to do it, as lanes. `kind` may be left out. */
export const LanesApproach = z.strictObject({
  kind: z.literal('lanes').optional(),
  /** The idea in under 8 words. */
  title: line(70),
  ...lanesBody,
  /** The one thing most likely to go wrong. Every approach names one. */
  risk: line(200),
});
export type LanesApproach = z.infer<typeof LanesApproach>;

/** One way to do it, as a drawn screen. */
export const FreeApproach = z.strictObject({
  kind: z.literal('free'),
  title: line(70),
  svg: Svg,
  caption: text(280).optional(),
  risk: line(200),
  gaps,
});
export type FreeApproach = z.infer<typeof FreeApproach>;

export const Approach = z.union([LanesApproach, FreeApproach]);
export type Approach = z.infer<typeof Approach>;

export const APPROACH_LETTERS = ['A', 'B', 'C', 'D'] as const;
export type ApproachLetter = (typeof APPROACH_LETTERS)[number];

/**
 * Two to four approaches to one request, side by side. They are lettered A, B, C, D in
 * order. Tap target per approach: "approach:a". A step inside one: "step:a-<step id>".
 *
 * Blue is drawn by the renderer: a lane, step or flow that no other approach has, with the
 * same id and the same words, turns blue. So say a shared thing the same way in every
 * approach: the same id, the same lane, the very same words. Give a changed thing a new id.
 * Draw only what the approaches disagree on, plus the few shared steps that show where
 * they differ. Three to six steps each is usually enough.
 */
export const SpreadPicture = z.strictObject({
  kind: z.literal('spread'),
  title: line(70),
  /** The one concrete request every approach follows: "a client posts what is 2 + 2". */
  request: line(120),
  approaches: z.array(Approach).min(2).max(4),
  /** The letter you would pick. The owner decides. */
  lean: z.enum(APPROACH_LETTERS).optional(),
  /** One or two sentences under the spread. */
  caption: text(280).optional(),
  gaps,
});
export type SpreadPicture = z.infer<typeof SpreadPicture>;

/** "approach:a" for the first approach, and so on. */
export function approachSub(index: number): string {
  return `approach:${(APPROACH_LETTERS[index] ?? 'A').toLowerCase()}`;
}

/** The position of an approach from the id part of its sub: "a" is 0. */
export function approachIndex(letter: string): number {
  return APPROACH_LETTERS.indexOf(letter.toUpperCase() as ApproachLetter);
}

/* ---------------------------------------------------------------- mini */

/** A small reply picture: two to five boxes and the arrows between them. Tap target per box: "box:<n>". */
export const MiniPicture = z.strictObject({
  kind: z.literal('mini'),
  /** The answer, in a few words: "Yes. One thread means one line". */
  title: line(90),
  boxes: z
    .array(z.strictObject({ text: line(40), tone: Tone.optional(), sub: text(48).optional() }))
    .min(2)
    .max(5),
  /** Arrows between boxes, by position counted from 1. Leave it out and each box flows to the next. */
  flows: z
    .array(
      z.strictObject({
        from: z.number().int().min(1).max(5),
        to: z.number().int().min(1).max(5),
        label: text(30).optional(),
        wait: z.boolean().optional(),
      }),
    )
    .max(8)
    .optional(),
  caption: text(280).optional(),
});
export type MiniPicture = z.infer<typeof MiniPicture>;

/* ------------------------------------------------------------ pipeline */

/**
 * The model, drawn: the parts of the system, their state, and a request through them.
 * With no `model`, it shows the board's own model and stays live: when a part changes
 * state, this picture changes with it. With a `model`, it shows that candidate.
 * Tap targets: "part:<id>" and "lane:<id>".
 */
export const PipelinePicture = z.strictObject({
  kind: z.literal('pipeline'),
  title: line(70).optional(),
  caption: text(280).optional(),
  /** `flat` is lanes seen from the front. `layers` is the same lanes as stacked floors. The owner can switch. */
  view: z.enum(['flat', 'layers']).optional(),
  /** A candidate model, when this is not the board's model. */
  model: ModelData.optional(),
  /** Show only these parts of the board's model. Leave it out to show them all. */
  parts: z.array(Id).min(1).max(40).optional(),
  /** A walk to number on the picture. */
  walk: Id.optional(),
  gaps,
});
export type PipelinePicture = z.infer<typeof PipelinePicture>;

/* ---------------------------------------------------------------- walk */

/** A step player for one walk of the board's model. Tap target per step: "step:<n>". */
export const WalkPicture = z.strictObject({
  kind: z.literal('walk'),
  title: line(70).optional(),
  walk: Id,
});
export type WalkPicture = z.infer<typeof WalkPicture>;

/* --------------------------------------------------------------- focus */

/** Something that crosses the part's edge. */
export const Crossing = z.strictObject({
  dir: z.enum(['in', 'out']),
  what: line(60),
  /** The part on the other side. */
  part: Id.optional(),
  note: text(90).optional(),
});
export type Crossing = z.infer<typeof Crossing>;

/** One thing inside the part, for the cutaway. */
export const Inside = z.strictObject({
  name: line(40),
  plain: text(90).optional(),
  /** A few sample contents: "req-42", "req-43". */
  holds: z.array(line(24)).max(6).optional(),
  tone: Tone.optional(),
});
export type Inside = z.infer<typeof Inside>;

/** Another way the part could work. Tap target: "option:<id>". */
export const FocusOption = z.strictObject({
  id: Id,
  name: line(48),
  body: text(240).optional(),
  risk: text(160).optional(),
});
export type FocusOption = z.infer<typeof FocusOption>;

/**
 * One part of the board's model, or one lane, opened up. Draw it when the owner taps it,
 * not before. Where it sits is drawn from the model, so the spec does not repeat it.
 */
export const FocusPicture = z.strictObject({
  kind: z.literal('focus'),
  /** The part that is opened. Give this or `lane`, not both. */
  part: Id.optional(),
  /** A whole lane opened as one thing, such as a bridge of two queues. */
  lane: Id.optional(),
  title: line(70).optional(),
  /** What the part is for, in one or two plain sentences. */
  summary: text(320).optional(),
  crosses: z.array(Crossing).max(8).optional(),
  /** The cutaway: what is inside. */
  inside: z.array(Inside).max(6).optional(),
  /** The one thing this part promises. */
  promise: text(240).optional(),
  /** What that promise costs. */
  cost: text(240).optional(),
  /** A decision already made inside this part, and why. */
  made: z.strictObject({ title: line(90), body: text(320).optional() }).optional(),
  /** Ways it could go, for the owner to circle or cross out. */
  options: z
    .strictObject({ title: line(90), items: z.array(FocusOption).min(2).max(4), lean: Id.optional() })
    .optional(),
  /** What you would choose, in one or two sentences. */
  lean: text(320).optional(),
  /** For a built part: the lines worth reading yourself. */
  code: z
    .array(z.strictObject({ path: line(200), lines: text(30).optional(), note: text(160).optional() }))
    .max(6)
    .optional(),
  gaps,
});
export type FocusPicture = z.infer<typeof FocusPicture>;

/* ----------------------------------------------------------- blueprint */

/** Something the owner chose, and the item it came from. Tap target: "pick:<n>". */
export const BlueprintPick = z.strictObject({
  text: line(160),
  from: Target.optional(),
});
export type BlueprintPick = z.infer<typeof BlueprintPick>;

/**
 * How the owner tries a finished build, before they approve it. The blueprint names it, and
 * by pressing "Build this" the owner sees it. Nothing here runs by itself: an `app` or a
 * `terminal` starts on the owner's own press, in the build's copy, boxed in.
 */
export const ShowPlan = z.discriminatedUnion('kind', [
  /** A page that stands alone. It is opened as files, and nothing is run. */
  z.strictObject({ kind: z.literal('page') }),
  /**
   * An app a command serves on this machine, such as "npm start". The board runs `run` with
   * `PORT` set to a free port, waits until the app answers there, and shows it. `port` is
   * for a command that cannot be told its port: the one it always listens on.
   */
  z.strictObject({ kind: z.literal('app'), run: line(300), port: z.number().int().min(1024).max(65535).optional() }),
  /** A tool used in a terminal. The board opens one in the build's copy, with `run` typed in. */
  z.strictObject({ kind: z.literal('terminal'), run: line(300) }),
]);
export type ShowPlan = z.infer<typeof ShowPlan>;

/** The command a show runs, when it runs one. */
export function showRun(show: ShowPlan | undefined): string | undefined {
  return show && show.kind !== 'page' ? show.run : undefined;
}

/** Are two show plans the same, word for word? */
export function sameShow(a: ShowPlan | undefined, b: ShowPlan | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'page' || b.kind === 'page') return true;
  return a.run === b.run && (a.kind === 'app' ? a.port : undefined) === (b.kind === 'app' ? b.port : undefined);
}

/**
 * The read-back of a solidified idea, as one picture. Post it after the owner solidifies,
 * then wait: the owner presses "Build this" on it. `parts` is the build track, in order,
 * one commit each.
 */
export const BlueprintPicture = z.strictObject({
  kind: z.literal('blueprint'),
  title: line(70),
  /** The idea in one or two plain sentences. */
  summary: text(320).optional(),
  picks: z.array(BlueprintPick).min(1).max(10),
  /** What is left out on purpose, and why. */
  leftOut: z.array(z.strictObject({ text: line(160), why: text(160).optional() })).max(8).optional(),
  /**
   * What you assumed and the owner did not say. Each one is a decision the owner has not
   * made: list every one here, so they see it before they press "Build this". A question
   * the owner asked is never a pick, and an answer you gave yourself belongs here.
   * Tap target per line: "assumed:<n>", so the owner can cross one out.
   */
  assumed: z.array(line(200)).max(8).optional(),
  /** How the owner will know it works: things they can run or see. */
  proof: z.array(line(200)).min(1).max(6),
  /** The build track: the parts to build, in order. */
  parts: z.array(Id).min(1).max(40),
  /**
   * The one command that proves a part works, such as "make check". The blueprint shows it,
   * and by pressing "Build this" the owner agrees that the builder runs it. A part is built
   * only when this command has passed after its commit.
   */
  check: line(300),
  /**
   * The one command that makes a fresh copy of the repository ready to run, such as "npm ci".
   * Leave it out when nothing has to be fetched. It runs once before the build, with the
   * network, and the owner agrees to it with "Build this".
   */
  setup: line(300).optional(),
  /**
   * How the owner tries the result. Name one on every blueprint: the parts must include what
   * makes it work. Left out, the board shows a page that stands alone when the build made
   * one, else a terminal with the check.
   */
  show: ShowPlan.optional(),
  walk: Id.optional(),
  gaps,
});
export type BlueprintPicture = z.infer<typeof BlueprintPicture>;

/* -------------------------------------------------------------- choice */

/**
 * A decision the agent made alone while building. It never blocks: `chosen` is already in
 * force, and the owner can change it. Tap target per option: "option:<id>".
 */
export const ChoicePicture = z.strictObject({
  kind: z.literal('choice'),
  title: line(90),
  body: text(320).optional(),
  options: z
    .array(z.strictObject({ id: Id, label: line(48), note: text(160).optional() }))
    .min(2)
    .max(3),
  /** The option in force now. */
  chosen: Id,
  /** The part the choice belongs to. */
  part: Id.optional(),
});
export type ChoicePicture = z.infer<typeof ChoicePicture>;

/* --------------------------------------------------------------- union */

export const PictureSpec = z.discriminatedUnion('kind', [
  TextPicture,
  ShelfPicture,
  LanesPicture,
  SpreadPicture,
  MiniPicture,
  PipelinePicture,
  WalkPicture,
  FocusPicture,
  BlueprintPicture,
  ChoicePicture,
  FreePicture,
]);
export type PictureSpec = z.infer<typeof PictureSpec>;

export type PictureKind = PictureSpec['kind'];

export const PICTURE_KINDS = [
  'text',
  'shelf',
  'lanes',
  'spread',
  'mini',
  'pipeline',
  'walk',
  'focus',
  'blueprint',
  'choice',
  'free',
] as const satisfies readonly PictureKind[];

/** A short name for a picture, for the digest and for lineage labels. */
export function pictureTitle(p: PictureSpec): string {
  switch (p.kind) {
    case 'shelf':
      return p.title ?? 'Already on the shelf';
    case 'pipeline':
      return p.title ?? 'The pipeline';
    case 'walk':
      return p.title ?? `Walk ${p.walk}`;
    case 'focus':
      return p.title ?? `Focus on ${p.part ?? p.lane ?? 'a part'}`;
    default:
      return p.title;
  }
}
