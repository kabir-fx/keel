import type { DraftOf, EventDraft, EventType } from './events';
import type { Actor, Id, Target } from './ids';
import { EventId } from './ids';
import type { ArrowTie, Item, ItemPatch } from './items';
import { isMark, targetsOf } from './items';
import type { ModelData, ModelOp } from './model';
import type { LanesBody, PictureSpec } from './pictures';
import { APPROACH_LETTERS, sameShow } from './pictures';
import { MAX_COL, applyModelOp, copyModel, nextCol } from './reduce';
import type { BoardState, ItemState, ModelState } from './state';
import { awaitsProof, canvasBuilds, chaptersWithPart, liveItems, ownersPictures, reopeningMarks } from './state';
import { oneLine, secretIn } from './secrets';

/**
 * The rules. The server runs `check` before it appends an event, and refuses an event that
 * breaks a rule. It does not warn. A refusal carries the rule and one sentence the sender
 * can act on.
 */

export const RULES = {
  R1: 'Only the owner decides. Only an owner event makes a part solid. What the owner decided, picked or pressed on changes only after the owner reopens it.',
  R2: 'Built means evidence. A part is built when the check the owner agreed to has passed after its commit, and the build\'s own tools say so, not the agent.',
  R3: 'Every agent picture names the marks it answers, or the items it comes from. A mark is closed only by something the owner can see.',
  R4: 'Nothing is deleted. An id is used once, and a removed item stays in the log.',
  R5: 'A fresh agent can continue from the digest alone.',
  R6: 'Each actor sends only its own kinds of event: the owner marks and decides, the agent draws and reports.',
  R7: 'Every name in an event points at something that exists on the board.',
  R8: 'A part and a chapter move one step at a time: idea, solid, building, built.',
  R9: 'No secret on the board. The log is committed with the repository.',
  shape: 'The event is well formed.',
} as const;

export type RuleId = keyof typeof RULES;

export type Verdict = { ok: true } | { ok: false; rule: RuleId; reason: string };

const OK: Verdict = { ok: true };
const no = (rule: RuleId, reason: string): Verdict => ({ ok: false, rule, reason });

const ALL: readonly Actor[] = ['owner', 'agent', 'system'];

/** Who may send what. */
export const MAY: Record<EventType, readonly Actor[]> = {
  'board.open': ['system'],
  'canvas.open': ['owner', 'system'],
  'chapter.open': ['owner', 'system'],
  'chapter.rename': ALL,
  'item.add': ALL,
  'item.update': ALL,
  'item.place': ['owner', 'system'],
  'item.remove': ALL,
  'item.restore': ALL,
  answer: ['agent'],
  'model.patch': ['agent', 'system'],
  'part.state': ALL,
  solidify: ['owner'],
  'build.start': ['owner'],
  'build.pause': ['owner'],
  'build.resume': ['owner'],
  'canvas.approve': ['owner'],
  'canvas.merged': ['system'],
  'build.proved': ['system'],
  'canvas.remove': ['owner'],
  'feed.add': ['agent', 'system'],
  'choice.pick': ['owner'],
  ask: ['owner'],
  'moment.add': ['agent', 'system'],
};

/** Would this draft be admitted to a board in this state? */
export function check(state: BoardState, d: EventDraft): Verdict {
  if (!MAY[d.type].includes(d.by)) {
    return no('R6', `${d.by} may not send "${d.type}". It is for: ${MAY[d.type].join(', ')}.`);
  }
  if (d.type === 'board.open') {
    return state.seq === 0 ? OK : no('R4', 'This board is already open. A board is opened once.');
  }
  if (state.seq === 0) return no('R7', 'The first event of a board is "board.open".');
  const secret = secretIn(d);
  if (secret) return no('R9', `This looks like it holds ${secret}. The board's log is committed with the repository: leave the secret out.`);
  // Whatever chapter an event names must be there. Opening one is the only exception.
  if (d.chapter !== undefined && d.type !== 'chapter.open' && !has(state.chapters, d.chapter)) {
    return no('R7', `There is no chapter "${d.chapter}".`);
  }

  switch (d.type) {
    case 'canvas.open':
      if (has(state.removedCanvases, d.canvas)) return no('R4', `Canvas "${d.canvas}" was deleted. An id is used once: use a new id.`);
      return has(state.canvases, d.canvas) ? no('R4', `Canvas "${d.canvas}" already exists. Use a new id.`) : OK;

    case 'chapter.open': {
      if (has(state.removedChapters, d.chapter)) return no('R4', `Chapter "${d.chapter}" was deleted. An id is used once: use a new id.`);
      if (has(state.chapters, d.chapter)) return no('R4', `Chapter "${d.chapter}" already exists. Use a new id.`);
      if (d.canvas !== undefined) return needCanvas(state, d.canvas);
      // The canvas made for a first idea takes the idea's id: it must be free.
      return state.canvasOrder.length === 0 && has(state.removedCanvases, d.chapter)
        ? no('R4', `A canvas "${d.chapter}" was deleted, and this idea would start one of that name. Use a new id.`)
        : OK;
    }

    case 'chapter.rename': {
      const c = needChapter(state, d.chapter);
      if (!c.ok) return c;
      // Once an idea is decided, its name is part of what the owner decided.
      if (d.by !== 'owner' && state.chapters[d.chapter]!.state !== 'idea') {
        return no('R1', `Chapter "${d.chapter}" is ${state.chapters[d.chapter]!.state}: the owner decided it. Only the owner renames it now.`);
      }
      return OK;
    }

    case 'item.add':
      return checkItemAdd(state, d);

    case 'item.update':
      return checkItemUpdate(state, d);

    case 'item.place': {
      const s = state.items[d.item];
      if (!s || s.removed) return no('R7', `There is no item "${d.item}" on the board.`);
      if (s.item.kind !== 'picture') return no('R7', `Item "${d.item}" is a mark. Only a picture is placed.`);
      if (s.item.box !== undefined) return no('R8', `Picture "${d.item}" is placed already. Move it with "item.update".`);
      return OK;
    }

    case 'item.remove': {
      const s = state.items[d.item];
      if (!s) return no('R7', `There is no item "${d.item}".`);
      if (s.removed) return no('R8', `Item "${d.item}" is already off the board.`);
      // The board is the owner's: they can take anything off it. The agent takes off only its own.
      if (s.by !== d.by && d.by !== 'owner') return no('R6', `Only its author, or the owner, takes an item off the board. "${d.item}" is by the ${s.by}.`);
      if (d.by !== 'owner' && ownersPictures(state).has(d.item)) {
        return no('R1', `The owner picked "${d.item}", or pressed "Build this" on it. It stays on the board as the owner saw it.`);
      }
      return OK;
    }

    case 'item.restore': {
      const s = state.items[d.item];
      if (!s) return no('R7', `There is no item "${d.item}".`);
      if (!has(state.chapters, s.chapter)) return no('R7', `Item "${d.item}" belonged to an idea the owner deleted. It stays off the board.`);
      if (!s.removed) return no('R8', `Item "${d.item}" is on the board already.`);
      if (s.by !== d.by && d.by !== 'owner') return no('R6', `Only its author, or the owner, puts an item back. "${d.item}" is by the ${s.by}.`);
      return OK;
    }

    case 'answer':
      return checkAnswers(state, d.answers);

    case 'model.patch':
      return checkModelPatch(state, d.ops);

    case 'part.state':
      return checkPartState(state, d);

    case 'solidify':
      return checkSolidify(state, d);

    case 'build.start':
      return checkBuildStart(state, d);

    case 'build.pause': {
      const c = state.chapters[d.chapter];
      if (!c) return no('R7', `There is no chapter "${d.chapter}".`);
      if (c.state !== 'building') return no('R8', `Chapter "${d.chapter}" is not building, so there is nothing to pause.`);
      return c.paused ? no('R8', 'The build is already paused.') : OK;
    }

    case 'build.resume': {
      const c = state.chapters[d.chapter];
      if (!c) return no('R7', `There is no chapter "${d.chapter}".`);
      return c.paused ? OK : no('R8', 'The build is not paused.');
    }

    case 'build.proved': {
      const c = state.chapters[d.chapter];
      if (!c) return no('R7', `There is no chapter "${d.chapter}".`);
      if (c.show?.kind !== 'app') return no('R8', 'This chapter is not tried as an app.');
      return awaitsProof(state, d.chapter) ? OK : no('R8', 'Only a building chapter with every part built waits for its app to answer.');
    }

    case 'canvas.approve': {
      const c = needCanvas(state, d.canvas);
      if (!c.ok) return c;
      const b = canvasBuilds(state, d.canvas);
      // Every idea on a canvas shares its branch: a build in work there would be merged half done.
      if (b.building.length > 0) return no('R8', `"${oneLine(b.building[0]!.title, 80)}" is still building on this canvas, and every idea on a canvas shares its branch. Approve when it is built.`);
      if (b.waiting.length > 0) return OK;
      return b.merged.length > 0 ? no('R8', `Everything built on this canvas is merged into ${oneLine(b.merged[0]!.merged!.into, 80)} already.`) : no('R8', 'Nothing on this canvas is built yet. Only a built idea is approved.');
    }

    case 'canvas.merged': {
      const c = needCanvas(state, d.canvas);
      if (!c.ok) return c;
      // A statement of what the repository holds: it stands whatever else the canvas does now.
      return canvasBuilds(state, d.canvas).waiting.length > 0 ? OK : no('R8', 'No built idea on this canvas waits to be merged.');
    }

    case 'canvas.remove':
      return needCanvas(state, d.canvas);

    case 'feed.add': {
      if (d.part !== undefined && !livePart(state.model, d.part)) return no('R7', `There is no part "${d.part}".`);
      if (d.by === 'agent') {
        // A commit and a passed check are evidence. Only the build's own tools report them.
        if (d.commit !== undefined || d.check !== undefined || d.kind === 'commit' || d.kind === 'check') {
          return no('R2', `A commit or a check in the feed comes from the build's own tools, not from the agent. Post an "update" or a "problem" with words only.`);
        }
      }
      for (const id of d.answers ?? []) {
        if (!has(state.acts, id)) {
          return no('R3', `A feed entry answers a request from the owner, such as "Build this" or a pause. "${id}" is not one. Answer a mark with a picture, or with "answer" and how you read it.`);
        }
      }
      return OK;
    }

    case 'choice.pick': {
      const s = state.items[d.item];
      if (!s || s.removed || s.item.kind !== 'picture' || s.item.picture.kind !== 'choice') {
        return no('R7', `Item "${d.item}" is not a choice on the board.`);
      }
      return s.item.picture.options.some((o) => o.id === d.option)
        ? OK
        : no('R7', `Choice "${d.item}" has no option "${d.option}".`);
    }

    case 'ask': {
      if ((d.part === undefined) === (d.lane === undefined)) return no('shape', 'Ask for the focus of one part or one lane: give "part" or "lane", not both.');
      if (d.part !== undefined && !livePart(state.model, d.part)) return no('R7', `There is no part "${d.part}".`);
      if (d.lane !== undefined && !state.model.lanes.some((l) => l.id === d.lane)) return no('R7', `There is no lane "${d.lane}".`);
      if (d.item !== undefined && !state.items[d.item]) return no('R7', `There is no item "${d.item}".`);
      return OK;
    }

    case 'moment.add': {
      for (const id of d.items) if (!state.items[id]) return no('R7', `There is no item "${id}".`);
      return OK;
    }
  }
}

/* ----------------------------------------------------------------- items */

function checkItemAdd(state: BoardState, d: DraftOf<'item.add'>): Verdict {
  const item = d.item;
  if (state.items[item.id]) return no('R4', `Item id "${item.id}" is used already. An id is used once.`);
  if (EventId.safeParse(item.id).success) {
    return no('shape', `"${item.id}" looks like an event id. Give the item another id.`);
  }
  if (d.by === 'owner' && !isMark(item)) return no('R6', 'The owner makes marks. Pictures come from the agent.');
  if (d.by !== 'owner' && isMark(item)) return no('R6', `Marks come from the owner. The ${d.by} adds pictures.`);

  for (const t of targetsOf(item)) {
    const v = needTarget(state, t);
    if (!v.ok) return v;
  }
  if (item.kind === 'arrow') {
    const v = tieHasTarget('from', item.fromTie, item.fromTarget) ?? tieHasTarget('to', item.toTie, item.toTarget);
    if (v) return v;
  }
  if (item.kind !== 'picture') {
    return item.anchor && !state.items[item.anchor.item]
      ? no('R7', `A mark is anchored to "${item.anchor.item}", which is not on the board.`)
      : OK;
  }

  if (d.by === 'agent' && item.box !== undefined) {
    return no('R6', 'The agent gives no coordinates. Leave "box" out, and say where the picture belongs with "place".');
  }
  if (d.by === 'agent' && !item.answers?.length && !item.from?.length) {
    return no('R3', 'Say what this picture is for: list the marks it answers in "answers", or the items it comes from in "from".');
  }
  const refs = checkLineage(state, item.answers, item.from);
  if (!refs.ok) return refs;
  if (item.place?.near !== undefined && !state.items[item.place.near]) {
    return no('R7', `"place.near" names "${item.place.near}", which is not on the board.`);
  }
  return checkPicture(state, item.picture);
}

function checkItemUpdate(state: BoardState, d: DraftOf<'item.update'>): Verdict {
  const s = state.items[d.item];
  if (!s) return no('R7', `There is no item "${d.item}".`);
  if (s.removed) return no('R7', `Item "${d.item}" is off the board. Put it back first.`);
  const p = d.patch;
  const keys = (Object.keys(p) as Array<keyof ItemPatch>).filter((k) => p[k] !== undefined);
  if (keys.length === 0) return no('shape', 'The patch is empty.');

  const own = s.by === d.by;
  const allowed = allowedPatchKeys(d.by, own, s.item);
  for (const k of keys) {
    if (!allowed.includes(k)) {
      return no(
        'R6',
        `The ${d.by} may not change "${k}" of item "${d.item}" (a ${s.item.kind} by the ${s.by}). Allowed here: ${allowed.join(', ') || 'nothing'}.`,
      );
    }
  }
  if (p.text !== undefined && p.text.length === 0 && (s.item.kind === 'note' || s.item.kind === 'voice')) {
    return no('shape', 'A note needs some text. Take it off the board instead.');
  }
  if (p.text !== undefined) {
    const limit = s.item.kind === 'box' || s.item.kind === 'arrow' ? 200 : s.item.kind === 'pin' ? 400 : 2000;
    if (p.text.length > limit) return no('shape', `The text of a ${s.item.kind} holds at most ${limit} characters. This one has ${p.text.length}.`);
  }
  for (const [which, end] of [['from', p.arrowFrom], ['to', p.arrowTo]] as const) {
    if (end === undefined) continue;
    const v = tieHasTarget(which, end.tie, end.target) ?? (end.target ? needTarget(state, end.target) : OK);
    if (!v.ok) return v;
  }
  if (p.anchor && p.anchor.item === d.item) return no('shape', `"anchor" names "${d.item}" itself. A mark is anchored to another thing, or to none.`);
  if (p.anchor && !state.items[p.anchor.item]) return no('R7', `A mark is anchored to "${p.anchor.item}", which is not on the board.`);
  if (s.item.kind !== 'picture') return OK;

  const redrawn = p.picture !== undefined || p.status !== undefined || p.answers !== undefined || p.from !== undefined;
  if (redrawn && d.by !== 'owner' && ownersPictures(state).has(d.item)) {
    return no('R1', `The owner picked "${d.item}", or pressed "Build this" on it. It stays as the owner saw it. Post a new picture that comes from it.`);
  }
  if (p.picture !== undefined && d.by !== 'owner') {
    const v = keepsOwnersChoice(s, p.picture);
    if (!v.ok) return v;
  }

  const answers = p.answers ?? s.item.answers;
  const from = p.from ?? s.item.from;
  if (d.by === 'agent' && !answers?.length && !from?.length) {
    return no('R3', 'A picture keeps its lineage: it needs "answers" or "from".');
  }
  const refs = checkLineage(state, p.answers, p.from);
  if (!refs.ok) return refs;
  return p.picture ? checkPicture(state, p.picture) : OK;
}

function allowedPatchKeys(by: Actor, own: boolean, item: Item): Array<keyof ItemPatch> {
  if (by === 'owner') {
    if (!own) return ['box'];
    // An arrow's ends, the thing it hangs on with them, and the place of its label are the owner's to set again.
    if (item.kind === 'arrow') return ['box', 'rot', 'text', 'arrowFrom', 'arrowTo', 'labelAt', 'anchor'];
    const hasText = item.kind === 'note' || item.kind === 'box' || item.kind === 'pin' || item.kind === 'voice';
    return hasText ? ['box', 'rot', 'text'] : ['box', 'rot'];
  }
  // The agent draws and never gives coordinates: the app places a picture, and the owner moves it.
  if (by === 'agent') return own ? ['picture', 'status', 'answers', 'from'] : [];
  // The system places pictures, and may redraw its own.
  return own ? ['box', 'picture', 'status', 'answers', 'from'] : ['box'];
}

/** A choice the owner picked keeps that option, with the same words, when the card is drawn again. */
function keepsOwnersChoice(s: ItemState, next: PictureSpec): Verdict {
  if (s.chosenBy !== 'owner' || s.item.kind !== 'picture' || s.item.picture.kind !== 'choice') return OK;
  const before = s.item.picture.options.find((o) => o.id === s.chosen);
  if (!before) return OK;
  if (next.kind !== 'choice') return no('R1', `The owner chose "${before.label}" on this card. It stays a choice.`);
  const after = next.options.find((o) => o.id === before.id);
  if (!after || after.label !== before.label) {
    return no('R1', `The owner chose "${before.label}" on this card. Keep that option, with the same words.`);
  }
  return OK;
}

/** `answers` name the owner's marks and acts. `from` names items. */
function checkLineage(state: BoardState, answers: readonly Id[] | undefined, from: readonly Id[] | undefined): Verdict {
  const a = checkAnswers(state, answers);
  if (!a.ok) return a;
  for (const id of from ?? []) {
    if (!state.items[id]) return no('R7', `"from" names "${id}", which is not on the board.`);
  }
  return OK;
}

function checkAnswers(state: BoardState, answers: readonly Id[] | undefined): Verdict {
  for (const id of answers ?? []) {
    if (has(state.acts, id)) continue;
    const s = state.items[id];
    if (s && s.by === 'owner' && isMark(s.item)) continue;
    return no('R7', `"answers" names "${id}", which is not a mark or a request from the owner.`);
  }
  return OK;
}

/** Is this key really in the map? A plain lookup would also find what every object has. */
function has(map: object, key: string): boolean {
  return Object.hasOwn(map, key);
}

function needCanvas(state: BoardState, canvas: Id): Verdict {
  if (has(state.canvases, canvas)) return OK;
  return has(state.removedCanvases, canvas) ? no('R7', `Canvas "${canvas}" was deleted.`) : no('R7', `There is no canvas "${canvas}".`);
}

function needChapter(state: BoardState, chapter: Id): Verdict {
  return has(state.chapters, chapter) ? OK : no('R7', `There is no chapter "${chapter}".`);
}

/** A tie says where on a target an arrow's end holds, so it needs the target. Undefined when it is fine. */
function tieHasTarget(which: 'from' | 'to', tie: ArrowTie | undefined, target: Target | undefined): Verdict | undefined {
  return tie !== undefined && target === undefined
    ? no('shape', `The "${which}" end of the arrow has a tie and no target. A tie says where on a target the end holds.`)
    : undefined;
}

function needTarget(state: BoardState, t: Target): Verdict {
  return state.items[t.item] ? OK : no('R7', `A mark points at "${t.item}", which is not on the board.`);
}

/* -------------------------------------------------------------- pictures */

/** A picture's names must point at things that exist, in the model or inside the picture. */
export function checkPicture(state: BoardState, p: PictureSpec): Verdict {
  const m = state.model;
  switch (p.kind) {
    case 'text':
    case 'free':
      return OK;

    case 'shelf': {
      const ids = new Set<string>();
      for (const t of p.tiles) {
        if (ids.has(t.id)) return no('shape', `Two shelf tiles share the id "${t.id}".`);
        ids.add(t.id);
        if (t.part !== undefined && !livePart(m, t.part)) return no('R7', `Shelf tile "${t.id}" names part "${t.part}", which is not in the model.`);
      }
      return OK;
    }

    case 'lanes':
      return checkLanesBody(p, 'The picture');

    case 'spread': {
      for (let i = 0; i < p.approaches.length; i++) {
        const a = p.approaches[i]!;
        if (a.kind === 'free') continue;
        const v = checkLanesBody(a, `Approach ${APPROACH_LETTERS[i]}`);
        if (!v.ok) return v;
      }
      if (p.lean !== undefined && APPROACH_LETTERS.indexOf(p.lean) >= p.approaches.length) {
        return no('shape', `"lean" is ${p.lean}, but the spread has ${p.approaches.length} approaches.`);
      }
      return OK;
    }

    case 'mini': {
      for (const f of p.flows ?? []) {
        if (f.from > p.boxes.length || f.to > p.boxes.length) {
          return no('shape', `A flow names box ${Math.max(f.from, f.to)}, but there are ${p.boxes.length} boxes.`);
        }
      }
      return OK;
    }

    case 'pipeline': {
      if (p.model) {
        const v = checkModelData(p.model);
        if (!v.ok) return v;
        if (p.walk !== undefined && !p.model.walks?.some((w) => w.id === p.walk)) {
          return no('shape', `"walk" names "${p.walk}", which is not in this picture's model.`);
        }
        return OK;
      }
      if (!Object.values(m.parts).some((x) => !x.dropped)) {
        return no('R7', 'The board has no model yet. Patch the model first, or give this picture a candidate "model".');
      }
      for (const id of p.parts ?? []) if (!livePart(m, id)) return no('R7', `There is no part "${id}" in the model.`);
      if (p.walk !== undefined && !m.walks[p.walk]) return no('R7', `There is no walk "${p.walk}" in the model.`);
      return OK;
    }

    case 'walk':
      return m.walks[p.walk] ? OK : no('R7', `There is no walk "${p.walk}" in the model. Add it with a model patch first.`);

    case 'focus': {
      if ((p.part === undefined) === (p.lane === undefined)) return no('shape', 'A focus opens one part or one lane: give "part" or "lane", not both.');
      if (p.part !== undefined && !livePart(m, p.part)) return no('R7', `There is no part "${p.part}" in the model.`);
      if (p.lane !== undefined && !m.lanes.some((l) => l.id === p.lane)) return no('R7', `There is no lane "${p.lane}" in the model.`);
      for (const c of p.crosses ?? []) {
        if (c.part !== undefined && !livePart(m, c.part)) return no('R7', `A crossing names part "${c.part}", which is not in the model.`);
      }
      if (p.options) {
        const ids = new Set<string>();
        for (const o of p.options.items) {
          if (ids.has(o.id)) return no('shape', `Two options share the id "${o.id}".`);
          ids.add(o.id);
        }
        if (p.options.lean !== undefined && !ids.has(p.options.lean)) {
          return no('shape', `"options.lean" names "${p.options.lean}", which is not one of the options.`);
        }
      }
      return OK;
    }

    case 'blueprint': {
      const seen = new Set<string>();
      for (const id of p.parts) {
        if (seen.has(id)) return no('shape', `Part "${id}" is on the build track twice.`);
        seen.add(id);
        if (!livePart(m, id)) return no('R7', `The build track names part "${id}", which is not in the model.`);
      }
      if (p.walk !== undefined && !m.walks[p.walk]) return no('R7', `There is no walk "${p.walk}" in the model.`);
      for (const pick of p.picks) {
        if (pick.from && !state.items[pick.from.item]) return no('R7', `A pick comes from "${pick.from.item}", which is not on the board.`);
      }
      return OK;
    }

    case 'choice': {
      const ids = new Set<string>();
      for (const o of p.options) {
        if (ids.has(o.id)) return no('shape', `Two options share the id "${o.id}".`);
        ids.add(o.id);
      }
      if (!ids.has(p.chosen)) return no('shape', `"chosen" names "${p.chosen}", which is not one of the options.`);
      if (p.part !== undefined && !livePart(m, p.part)) return no('R7', `There is no part "${p.part}" in the model.`);
      return OK;
    }
  }
}

function checkLanesBody(b: LanesBody, what: string): Verdict {
  const lanes = new Set<string>();
  for (const l of b.lanes) {
    if (lanes.has(l.id)) return no('shape', `${what} has two lanes with the id "${l.id}".`);
    lanes.add(l.id);
  }
  const steps = new Set<string>();
  const numbers = new Set<number>();
  const cells = new Set<string>();
  for (const s of b.steps) {
    if (steps.has(s.id)) return no('shape', `${what} has two steps with the id "${s.id}".`);
    steps.add(s.id);
    if (!lanes.has(s.lane)) return no('shape', `${what}: step "${s.id}" is in lane "${s.lane}", which is not one of its lanes.`);
    if (s.n !== undefined) {
      if (numbers.has(s.n)) return no('shape', `${what} has two steps numbered ${s.n}.`);
      numbers.add(s.n);
    }
    if (s.col !== undefined) {
      const cell = `${s.lane}/${s.col}`;
      if (cells.has(cell)) return no('shape', `${what}: two steps in lane "${s.lane}" share column ${s.col}.`);
      cells.add(cell);
    }
  }
  for (const f of b.flows ?? []) {
    for (const end of [f.from, f.to]) {
      if (!steps.has(end)) return no('shape', `${what}: a flow names "${end}", which is not a step id.`);
    }
    if (f.from === f.to) return no('shape', `${what}: a flow runs from step "${f.from}" to itself.`);
  }
  if (b.divider && !steps.has(b.divider.before)) {
    return no('shape', `${what}: the divider is before "${b.divider.before}", which is not a step id.`);
  }
  return OK;
}

/** A candidate model must hold together on its own. */
export function checkModelData(md: ModelData): Verdict {
  const lanes = new Set<string>();
  for (const l of md.lanes) {
    if (lanes.has(l.id)) return no('shape', `Two lanes share the id "${l.id}".`);
    lanes.add(l.id);
  }
  const parts = new Set<string>();
  const cells = new Set<string>();
  for (const p of md.parts) {
    if (parts.has(p.id)) return no('shape', `Two parts share the id "${p.id}".`);
    parts.add(p.id);
    if (p.lane === undefined) {
      if (p.col !== undefined) return no('shape', `Part "${p.id}" has a column but no lane.`);
      continue;
    }
    if (!lanes.has(p.lane)) return no('shape', `Part "${p.id}" is in lane "${p.lane}", which is not one of the lanes.`);
    if (p.col !== undefined) {
      const cell = `${p.lane}/${p.col}`;
      if (cells.has(cell)) return no('shape', `Two parts in lane "${p.lane}" share column ${p.col}.`);
      cells.add(cell);
    }
  }
  for (const e of md.edges ?? []) {
    if (!parts.has(e.from) || !parts.has(e.to)) return no('shape', `An edge runs "${e.from}" to "${e.to}", but there is no such part.`);
  }
  for (const w of md.walks ?? []) {
    const v = checkWalkSteps(w.id, w.steps, (id) => parts.has(id));
    if (!v.ok) return v;
  }
  return OK;
}

function checkWalkSteps(id: string, steps: ReadonlyArray<{ n: number; part: string }>, has: (part: string) => boolean): Verdict {
  let last = 0;
  for (const s of steps) {
    if (s.n <= last) return no('shape', `Walk "${id}": step numbers must rise. Step ${s.n} comes after step ${last}.`);
    last = s.n;
    if (!has(s.part)) return no('R7', `Walk "${id}": step ${s.n} is at part "${s.part}", which is not in the model.`);
  }
  return OK;
}

/* ----------------------------------------------------------------- model */

function livePart(m: ModelState, id: Id): boolean {
  const p = has(m.parts, id) ? m.parts[id] : undefined;
  return p !== undefined && !p.dropped;
}

function checkModelPatch(state: BoardState, ops: readonly ModelOp[]): Verdict {
  // Try the patch on a copy, one op at a time, so a later op may use what an earlier one added.
  const m = copyModel(state.model);
  for (const op of ops) {
    const v = checkModelOp(state, m, op);
    if (!v.ok) return v;
    applyModelOp(m, op, undefined);
  }
  return OK;
}

/** The walks the pictures on the board show. Such a walk cannot be dropped from under them. */
function walksInUse(state: BoardState): Set<Id> {
  const out = new Set<Id>();
  for (const s of liveItems(state)) {
    if (s.item.kind !== 'picture') continue;
    const p = s.item.picture;
    if (p.kind === 'walk') out.add(p.walk);
    else if ((p.kind === 'pipeline' && !p.model) || p.kind === 'blueprint') {
      if (p.walk !== undefined) out.add(p.walk);
    }
  }
  return out;
}

function checkModelOp(state: BoardState, m: ModelState, op: ModelOp): Verdict {
  switch (op.op) {
    case 'lane.set':
      return OK;

    case 'part.set': {
      const input = op.part;
      const cur = has(m.parts, input.id) ? m.parts[input.id] : undefined;
      if (input.lane !== undefined && !m.lanes.some((l) => l.id === input.lane)) {
        return no('R7', `Part "${input.id}" is in lane "${input.lane}", which is not in the model. Add the lane first.`);
      }
      if (cur?.dropped) return no('R4', `"${input.id}" was a part that was dropped. Use a new id.`);
      // A part that takes the next free column of a lane needs a free column there.
      const lands = input.lane !== undefined && input.col === undefined && input.lane !== cur?.lane ? input.lane : undefined;
      if (lands !== undefined && nextCol(m, lands) > MAX_COL) {
        return no('shape', `Lane "${lands}" is full: it holds ${MAX_COL} parts. Use another lane, or give the part a "col" that is free.`);
      }
      if (cur) {
        if (input.state !== undefined && input.state !== cur.state) {
          return no('R8', `A part changes state with a "part.state" event, not in a patch. "${input.id}" is ${cur.state}.`);
        }
        if (input.commit !== undefined && input.commit !== cur.commit) {
          return no('R2', `A part's commit is set when it is built, with a "part.state" event.`);
        }
        if (input.external !== undefined && input.external !== (cur.external ?? false)) {
          return no('R8', `Whether part "${input.id}" is outside the system is set when it is added.`);
        }
        if (input.shelf !== undefined && input.shelf !== (cur.shelf ?? false)) {
          return no('R8', `Whether the repository already had part "${input.id}" is set when it is added.`);
        }
        if (input.col !== undefined && (input.lane ?? cur.lane) === undefined) {
          return no('shape', `Part "${input.id}" has a column but no lane.`);
        }
        // What a decided part is, and where it sits, is the owner's. A part the repository
        // already had was never decided on the board, so its description may be corrected.
        const decided = cur.state === 'solid' || cur.state === 'building' || cur.state === 'built';
        const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
        const changed =
          (input.name !== undefined && input.name !== cur.name) ||
          (input.plain !== undefined && input.plain !== cur.plain) ||
          (input.lane !== undefined && input.lane !== cur.lane) ||
          // Where it lives and what is noted on it reach the builder too.
          (input.files !== undefined && !same(input.files, cur.files)) ||
          (input.note !== undefined && input.note !== cur.note);
        if (decided && changed && !cur.shelf) {
          return no('R1', `Part "${input.id}" is ${cur.state}: the owner decided it. Reopen it before you change what it is or where it sits.`);
        }
        return OK;
      }
      if (input.name === undefined) return no('shape', `A new part needs a "name". "${input.id}" is new.`);
      if (input.col !== undefined && input.lane === undefined) return no('shape', `Part "${input.id}" has a column but no lane.`);
      if (input.external) {
        if (input.state !== undefined && input.state !== 'built') {
          return no('R8', `Part "${input.id}" is outside the system. It is there already: leave "state" out.`);
        }
        return OK;
      }
      const st = input.state ?? 'idea';
      if (st === 'solid') return no('R1', `Only the owner makes a part solid. Add "${input.id}" as an idea.`);
      if (st === 'building') return no('R8', `A new part cannot start as building. Add "${input.id}" as an idea.`);
      if (st === 'built' && !(input.shelf === true && input.commit !== undefined)) {
        return no('R2', `A part is new as "built" only when the repository already had it: set "shelf": true and its "commit".`);
      }
      if (st !== 'built' && input.commit !== undefined) {
        return no('R2', `Part "${input.id}" is not built, so it has no commit yet.`);
      }
      return OK;
    }

    case 'part.drop': {
      const cur = has(m.parts, op.id) ? m.parts[op.id] : undefined;
      if (!cur || cur.dropped) return no('R7', `There is no part "${op.id}".`);
      if (cur.state === 'built') return no('R4', `Part "${op.id}" is built. Nothing built is dropped.`);
      if (cur.state === 'solid' || cur.state === 'building') {
        return no('R1', `Part "${op.id}" is ${cur.state}: the owner decided it. Only an idea can be dropped.`);
      }
      // Reopened is not undecided: the owner decided this part once, and it is theirs to let go.
      if (cur.decided) return no('R1', `The owner decided part "${op.id}" once. It is not dropped: the owner can put it off.`);
      if (cur.putOffBy === 'owner') return no('R1', `The owner put part "${op.id}" off. It is not dropped.`);
      if (chaptersWithPart(state, op.id).length > 0) return no('R1', `Part "${op.id}" is on a build track. It is not dropped.`);
      return OK;
    }

    case 'edge.set': {
      const { from, to } = op.edge;
      if (from === to) return no('shape', `An edge runs from "${from}" to itself.`);
      if (!livePart(m, from) || !livePart(m, to)) return no('R7', `An edge runs "${from}" to "${to}", but there is no such part.`);
      return OK;
    }

    case 'edge.drop':
      return m.edges.some((e) => e.from === op.from && e.to === op.to)
        ? OK
        : no('R7', `There is no edge "${op.from}" to "${op.to}".`);

    case 'walk.set':
      return checkWalkSteps(op.walk.id, op.walk.steps, (id) => livePart(m, id));

    case 'walk.drop': {
      if (!has(m.walks, op.id)) return no('R7', `There is no walk "${op.id}".`);
      return walksInUse(state).has(op.id) ? no('R7', `A picture on the board shows walk "${op.id}". It is not dropped while that picture is there.`) : OK;
    }
  }
}

/* ----------------------------------------------------------- part states */

function checkPartState(state: BoardState, d: DraftOf<'part.state'>): Verdict {
  const part = has(state.model.parts, d.part) ? state.model.parts[d.part] : undefined;
  if (!part || part.dropped) return no('R7', `There is no part "${d.part}".`);
  if (part.external) return no('R8', `Part "${d.part}" is outside the system. Nobody here builds it, so it has no state to change.`);
  const cur = part.state;
  const next = d.state;
  const onTrack = chaptersWithPart(state, d.part).length > 0;

  if (next !== 'built' && (d.commit !== undefined || d.check !== undefined)) {
    return no('shape', 'A commit and a check go with "built" only.');
  }
  if (next === cur && next !== 'built') return no('R8', `Part "${d.part}" is ${cur} already.`);

  switch (next) {
    case 'solid': {
      if (cur === 'building') {
        // Setting a part down, back to decided. The owner decided it before, so this decides nothing.
        return d.by === 'owner' ? no('R6', 'The owner pauses a build. The builder sets a part down.') : OK;
      }
      if (d.by !== 'owner') return no('R1', `Only the owner makes a part solid. "${d.part}" stays ${cur} until the owner solidifies.`);
      if (cur === 'built') return no('R8', `Part "${d.part}" is built. Reopen it to change it.`);
      return OK;
    }

    case 'building': {
      if (d.by === 'owner') return no('R6', 'The owner does not build. Press "Build this" and the agent does.');
      if (cur !== 'solid') {
        return no('R8', `Part "${d.part}" is ${cur}. Only a solid part is built: the owner solidifies first.`);
      }
      return needBuildingChapter(state, d.part, true);
    }

    case 'built': {
      if (d.by === 'owner') return no('R6', 'The owner does not build. A part is built by a commit and a passed check.');
      if (d.by === 'agent') {
        return no(
          'R2',
          `"built" is not the agent's word. The commit hook and the check hook report it, with the commit and the check that passed. Say "building", and post an update.`,
        );
      }
      if (cur !== 'building') {
        return no('R8', `Part "${d.part}" is ${cur}. A part is built from "building": say "building" first, then report the check.`);
      }
      if (d.commit === undefined) return no('R2', `"built" needs the commit that built "${d.part}".`);
      if (d.check === undefined) return no('R2', `"built" needs the check that was run for "${d.part}": its command and whether it passed.`);
      if (!d.check.passed) return no('R2', `The check for "${d.part}" did not pass, so the part is not built.`);
      const chapter = needBuildingChapter(state, d.part, false);
      if (!chapter.ok) return chapter;
      // The evidence is the check the owner agreed to, and no other command.
      const agreed = chaptersWithPart(state, d.part)
        .filter((c) => c.state === 'building' || c.state === 'built')
        .map((c) => c.check);
      if (!agreed.includes(d.check.cmd)) {
        return no('R2', `The owner agreed to the check "${agreed.find((c) => c !== undefined) ?? 'none'}". "${d.check.cmd}" is another command, so it proves nothing here.`);
      }
      return OK;
    }

    case 'idea': {
      if (cur === 'later') {
        // Bringing a part back in. What the owner put off, or once decided, only the owner brings back.
        if (d.by === 'owner') return OK;
        if (part.putOffBy === 'owner' || part.decided) return no('R1', `The owner put part "${d.part}" off. Only the owner brings it back.`);
        return OK;
      }
      // Reopening a decided part.
      if (d.by === 'owner') return OK;
      if (d.by === 'system') return no('R1', `Only the owner reopens a decided part. "${d.part}" is ${cur}.`);
      const marks = reopeningMarks(state, d.part);
      const named = (d.because ?? []).filter((id) => marks.includes(id));
      if (named.length === 0) {
        return no(
          'R1',
          `Part "${d.part}" is ${cur}: the owner decided it. To reopen it, name in "because" a mark of the owner's on that part that is still open and was made after the part was decided.`,
        );
      }
      return OK;
    }

    case 'later': {
      if (cur === 'idea') {
        // Putting off a part the owner once decided, or one on a build track, would let a
        // chapter count as built without it.
        if (d.by !== 'owner' && (part.decided || onTrack)) {
          return no('R1', `The owner decided part "${d.part}". Only the owner puts it off.`);
        }
        return OK;
      }
      if (cur === 'solid') {
        return d.by === 'owner' ? OK : no('R1', `Part "${d.part}" is solid: the owner decided it. Only the owner puts it off.`);
      }
      return no('R8', `Part "${d.part}" is ${cur}. Only an idea or a solid part can be put off.`);
    }
  }
}

/** A part is built only inside a chapter the owner has started. */
function needBuildingChapter(state: BoardState, part: Id, mustRun: boolean): Verdict {
  let found = false;
  for (const id of state.chapterOrder) {
    const c = state.chapters[id];
    if (!c || !c.track.includes(part)) continue;
    if (c.state !== 'building' && c.state !== 'built') continue;
    found = true;
    if (mustRun && c.paused) return no('R8', `The owner paused the build of "${c.title}". Wait until it is resumed.`);
  }
  return found
    ? OK
    : no('R8', `Part "${part}" is not on a build track. Nothing is built before the owner presses "Build this".`);
}

/* ------------------------------------------------------ solidify and build */

function checkSolidify(state: BoardState, d: DraftOf<'solidify'>): Verdict {
  for (const id of d.picks) {
    const s = state.items[id];
    if (!s || s.removed) return no('R7', `A pick names "${id}", which is not on the board.`);
  }
  for (const id of d.parts) {
    if (!livePart(state.model, id)) return no('R7', `There is no part "${id}" in the model.`);
  }
  if (d.lasso !== undefined) {
    const s = state.items[d.lasso];
    if (!s || s.removed || s.item.kind !== 'lasso') return no('R7', `"${d.lasso}" is not a lasso on the board.`);
  }
  return OK;
}

function checkBuildStart(state: BoardState, d: DraftOf<'build.start'>): Verdict {
  const c = state.chapters[d.chapter];
  if (!c) return no('R7', `There is no chapter "${d.chapter}".`);
  if (c.state === 'idea') return no('R8', `Chapter "${c.title}" is still an idea. Solidify it before you build.`);
  if (c.state !== 'solid') return no('R8', `Chapter "${c.title}" is ${c.state} already.`);
  const seen = new Set<string>();
  let solid = 0;
  for (const id of d.track) {
    if (seen.has(id)) return no('shape', `Part "${id}" is on the build track twice.`);
    seen.add(id);
    const p = has(state.model.parts, id) ? state.model.parts[id] : undefined;
    if (!p || p.dropped) return no('R7', `The build track names part "${id}", which is not in the model.`);
    const other = chaptersWithPart(state, id).find((x) => x.id !== c.id && x.state === 'building');
    if (other) return no('R8', `Part "${id}" is on the track of "${other.title}", which is still building. A part is built in one chapter at a time.`);
    if (p.state === 'solid') solid += 1;
    else if (p.state !== 'built') {
      return no('R8', `Part "${id}" is ${p.state}. Only solid parts are built: solidify it, or leave it off the track.`);
    }
  }
  if (solid === 0) return no('R8', 'Every part on this track is built already.');
  if (d.blueprint !== undefined) {
    const s = state.items[d.blueprint];
    if (!s || s.removed || s.item.kind !== 'picture' || s.item.picture.kind !== 'blueprint') {
      return no('R7', `"${d.blueprint}" is not a blueprint on the board.`);
    }
    // The owner agrees to the check they were shown. A press that names one check on a
    // blueprint that shows another is not that agreement.
    if (s.item.picture.check !== d.check) {
      return no('R2', `Blueprint "${d.blueprint}" shows the check "${oneLine(s.item.picture.check, 120)}". "Build this" must name that check, word for word.`);
    }
    // The same press agrees to the setup and to what the show runs: both as the blueprint shows them.
    if (s.item.picture.setup !== d.setup) {
      return no('R2', `Blueprint "${d.blueprint}" ${s.item.picture.setup === undefined ? 'shows no setup command' : `shows the setup "${oneLine(s.item.picture.setup, 120)}"`}. "Build this" must name the same, word for word.`);
    }
    if (!sameShow(s.item.picture.show, d.show)) {
      return no('R2', `"Build this" must say how the result is tried just as blueprint "${d.blueprint}" shows it.`);
    }
  }
  return OK;
}
