import type { ActType, BoardEvent } from './events';
import type { Actor, Id, Sub, Target } from './ids';
import { seqOf, subId, subKind } from './ids';
import type { Item, MarkItem, PictureItem } from './items';
import { isMark, targetsOf } from './items';
import type { Check, Edge, Lane, Part, Walk } from './model';
import type { ShowPlan } from './pictures';

/** The state of a board: the log, reduced. Plain data, so it can be sent and compared. */
export interface BoardState {
  name: string;
  /** The number of the last event applied. The next event is `e${seq + 1}`. */
  seq: number;
  /**
   * The canvases of the board, oldest first. A canvas is a blank place for an idea, and it
   * owns a branch: every idea on it is built there. Every chapter is on one canvas.
   */
  canvases: Record<Id, Canvas>;
  canvasOrder: Id[];
  chapters: Record<Id, Chapter>;
  chapterOrder: Id[];
  /**
   * The canvases the owner deleted, and the ideas that were on them, as they were. They are
   * in none of the maps above, so nothing that walks the board meets one. An id is still
   * used once.
   */
  removedCanvases: Record<Id, RemovedCanvas>;
  removedChapters: Record<Id, RemovedChapter>;
  items: Record<Id, ItemState>;
  itemOrder: Id[];
  model: ModelState;
  /**
   * What an event answered for good: a mark the agent read (an `answer` with its sentence),
   * a request a feed entry answered, a lasso the owner's own solidify used. Keys are mark ids
   * and act ids, values are the event. A mark answered by a picture is not here: it is
   * answered for as long as that picture is on the board. See `openThings`.
   */
  answered: Record<Id, string>;
  /** When the owner last changed what a mark says, by event number. An answer from before then no longer counts. */
  edited: Record<Id, number>;
  /** The owner's acts the agent must respond to, by event id. */
  acts: Record<string, Act>;
  feed: FeedEntry[];
  moments: Moment[];
  /** What the agent said when it answered marks without a picture: how it read them. */
  reads: Read[];
}

/** An answer with no picture: the marks it closes, and how the agent read them. */
export interface Read {
  /** The `answer` event. */
  id: string;
  at: string;
  answers: Id[];
  read: string;
}

export type ChapterState = 'idea' | 'solid' | 'building' | 'built';

/** A blank place for an idea, with a branch of its own. */
export interface Canvas {
  id: Id;
  /** A title of its own. Left out, the canvas is called by its first idea: see `canvasTitle`. */
  title?: string;
  openedAt: string;
}

export interface RemovedCanvas extends Canvas {
  removedAt: string;
}

/** One idea, from its first note to built. */
export interface Chapter {
  id: Id;
  /** The canvas it is on. Its build goes onto that canvas's branch. */
  canvas: Id;
  title: string;
  state: ChapterState;
  paused: boolean;
  /** The items the owner chose when solidifying. */
  picks: Id[];
  /** The build track: parts in build order. Empty until "Build this". */
  track: Id[];
  blueprint?: Id;
  /** The check command the owner agreed to with "Build this". The only command the build's tools run on their own. */
  check?: string;
  /** The setup command the owner agreed to with "Build this", when the blueprint named one. */
  setup?: string;
  /** How the owner tries the result, as the blueprint said it when "Build this" was pressed. */
  show?: ShowPlan;
  openedAt: string;
  solidAt?: string;
  /** The number of the event that first made the chapter solid. What the owner says on a part after it reaches the builder. */
  solidSeq?: number;
  builtAt?: string;
  /**
   * The app this chapter is tried as started and answered once, for the parts as they are
   * built now. A chapter with an `app` show is built only with this. Gone when a part on
   * the track is not built, and at the next "Build this".
   */
  proved?: true;
  /**
   * The home branch has this chapter's work: the commit the home branch was moved to, and
   * its name. Only on a built chapter. A chapter that builds again loses it.
   */
  merged?: { commit: string; into: string; at: string };
}

export interface RemovedChapter extends Chapter {
  removedAt: string;
}

export interface ItemState {
  item: Item;
  by: Actor;
  chapter: Id;
  /** The event that added it. */
  event: string;
  at: string;
  /** Taken off the board by its author. It stays in the log. */
  removed: boolean;
  /** The number of the event that last drew this picture or set what it answers. A move does not count. */
  touched: number;
  /** For a choice picture: the option in force, and who set it last. */
  chosen?: Id;
  chosenBy?: Actor;
}

export interface PartRecord extends Part {
  /** The chapter that added the part. */
  chapter?: Id;
  /** Dropped while it was still an idea. Kept so the story stays whole. */
  dropped?: boolean;
  /** True once the owner has decided this part, even if it was reopened since. Such a part is the owner's: an agent cannot drop it or put it off. */
  decided?: boolean;
  /** The number of the event that last made it solid. A mark reopens it only when the mark is newer. */
  decidedSeq?: number;
  /** Who put it off, while its state is `later`. What the owner put off, only the owner brings back. */
  putOffBy?: Actor;
}

export interface ModelState {
  lanes: Lane[];
  parts: Record<Id, PartRecord>;
  partOrder: Id[];
  edges: Edge[];
  walks: Record<Id, Walk>;
  walkOrder: Id[];
}

/** An owner's act that waits for the agent. */
export interface Act {
  id: string;
  type: ActType;
  chapter?: Id;
  at: string;
  /** The event itself, so the digest can say what was asked. */
  event: BoardEvent;
}

export interface FeedEntry {
  /** The event that made the entry. */
  id: string;
  at: string;
  by: Actor;
  chapter: Id;
  kind: 'update' | 'commit' | 'check' | 'problem' | 'state';
  text: string;
  part?: Id;
  commit?: string;
  check?: Check;
  /** For a reopened part: the owner's marks that caused it. */
  because?: Id[];
}

export interface Moment {
  id: string;
  at: string;
  chapter: Id;
  title: string;
  items: Id[];
}

export function emptyState(): BoardState {
  return {
    name: '',
    seq: 0,
    canvases: {},
    canvasOrder: [],
    chapters: {},
    chapterOrder: [],
    removedCanvases: {},
    removedChapters: {},
    items: {},
    itemOrder: [],
    model: { lanes: [], parts: {}, partOrder: [], edges: [], walks: {}, walkOrder: [] },
    answered: {},
    edited: {},
    acts: {},
    feed: [],
    moments: [],
    reads: [],
  };
}

/* ------------------------------------------------------------ selectors */

/** Something the agent has not answered yet: a mark, or an owner's act. */
export type OpenThing =
  | { kind: 'mark'; id: Id; chapter: Id; at: string; seq: number; item: MarkItem }
  | { kind: 'act'; id: string; chapter?: Id; at: string; seq: number; act: Act };

/**
 * What the pictures on the board answer, and since when: mark or act id to the highest
 * event number of a picture that names it. Only a finished picture that is still on the
 * board counts. A placeholder answers nothing yet, and a picture taken off answers nothing
 * any more.
 */
export function pictureAnswers(state: BoardState): Map<Id, number> {
  const out = new Map<Id, number>();
  for (const id of state.itemOrder) {
    const s = state.items[id];
    if (!s || s.removed || s.by === 'owner' || s.item.kind !== 'picture' || s.item.status === 'drawing') continue;
    for (const a of s.item.answers ?? []) {
      if ((out.get(a) ?? 0) < s.touched) out.set(a, s.touched);
    }
  }
  return out;
}

/**
 * Is this mark or act answered? Yes when an event answered it for good, or when a finished
 * picture on the board names it and was drawn after the owner last changed the mark.
 */
export function isAnswered(state: BoardState, id: Id, byPicture: Map<Id, number> = pictureAnswers(state)): boolean {
  if (Object.hasOwn(state.answered, id)) return true;
  return (byPicture.get(id) ?? 0) > (state.edited[id] ?? 0);
}

/** Every open mark and act, oldest first, in the order they reached the log. */
export function openThings(state: BoardState): OpenThing[] {
  const byPicture = pictureAnswers(state);
  const out: OpenThing[] = [];
  for (const id of state.itemOrder) {
    const s = state.items[id];
    if (!s || s.removed || s.by !== 'owner' || !isMark(s.item)) continue;
    // A lasso is the owner holding things together, for a solidify or for the next remark.
    // It asks nothing by itself, so it is not open and it wakes nobody.
    if (s.item.kind === 'lasso') continue;
    if (isAnswered(state, id, byPicture)) continue;
    out.push({ kind: 'mark', id, chapter: s.chapter, at: s.at, seq: Math.max(seqOf(s.event), state.edited[id] ?? 0), item: s.item });
  }
  for (const act of Object.values(state.acts)) {
    if (isAnswered(state, act.id, byPicture)) continue;
    out.push({ kind: 'act', id: act.id, chapter: act.chapter, at: act.at, seq: seqOf(act.id), act });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** The number on the board pill. */
export function openCount(state: BoardState): number {
  return openThings(state).length;
}

/** Items on the board, in the order they were added, without the removed ones. */
export function liveItems(state: BoardState): ItemState[] {
  const out: ItemState[] = [];
  for (const id of state.itemOrder) {
    const s = state.items[id];
    if (s && !s.removed) out.push(s);
  }
  return out;
}

export function pictureItems(state: BoardState): Array<ItemState & { item: PictureItem }> {
  return liveItems(state).filter((s): s is ItemState & { item: PictureItem } => s.item.kind === 'picture');
}

/** The parts of the model that are still there, in order. */
export function liveParts(state: BoardState): PartRecord[] {
  const out: PartRecord[] = [];
  for (const id of state.model.partOrder) {
    const p = state.model.parts[id];
    if (p && !p.dropped) out.push(p);
  }
  return out;
}

/**
 * Is this part there because the repository already had it, and not because it was built
 * and checked on this board? A part added from the shelf is "already there" until the owner
 * reopens it. Once the board has built it, with a check that passed, it is "built" like any
 * other. Every view asks this one question, so the pictures, the track and the Story agree.
 */
export function alreadyThere(part: Pick<Part, 'state' | 'shelf' | 'check' | 'external'>): boolean {
  return !part.external && part.state === 'built' && part.shelf === true && part.check?.passed !== true;
}

export function liveWalks(state: BoardState): Walk[] {
  const out: Walk[] = [];
  for (const id of state.model.walkOrder) {
    const w = state.model.walks[id];
    if (w) out.push(w);
  }
  return out;
}

/**
 * What the owner's pen says about each item: crossed out, or circled.
 * Keys are item ids. The lists hold subs, with '' for the whole item.
 * It is derived from the ink on the board, so taking a stroke off undoes it.
 */
export interface Markings {
  crossed: string[];
  circled: string[];
}

export function markings(state: BoardState): Record<Id, Markings> {
  const out: Record<Id, Markings> = {};
  for (const s of liveItems(state)) {
    if (s.by !== 'owner' || s.item.kind !== 'ink') continue;
    const hint = s.item.hint;
    if (hint !== 'cross' && hint !== 'circle') continue;
    for (const t of s.item.targets) {
      const m = (out[t.item] ??= { crossed: [], circled: [] });
      const list = hint === 'cross' ? m.crossed : m.circled;
      const key = t.sub ?? '';
      if (!list.includes(key)) list.push(key);
    }
  }
  return out;
}

/** A question the agent asked on a card, which the owner has not answered. */
export interface OpenQuestion {
  /** The card that asks. */
  item: Id;
  /** The question's own place on the card: "q:1", "q:2" or "q:3". */
  sub: Sub;
  text: string;
  chapter: Id;
}

/**
 * The agent's questions the owner has not answered, oldest card first.
 *
 * A text card names its questions "q:1" to "q:3". A question is answered once a mark of the
 * owner's that is still on the board points at it, or at its card as a whole: one note can
 * answer all three. A lasso holds things and answers nothing. A card asks nothing while it
 * is a placeholder, or once it is off the board.
 */
export function openQuestions(state: BoardState): OpenQuestion[] {
  const live = liveItems(state);
  const pointedAt = new Set<string>();
  for (const s of live) {
    if (s.by !== 'owner' || !isMark(s.item) || s.item.kind === 'lasso') continue;
    for (const t of targetsOf(s.item)) pointedAt.add(t.sub ? `${t.item}/${t.sub}` : t.item);
  }
  const out: OpenQuestion[] = [];
  for (const s of live) {
    const it = s.item;
    if (s.by === 'owner' || it.kind !== 'picture' || it.status === 'drawing' || it.picture.kind !== 'text') continue;
    if (pointedAt.has(it.id)) continue;
    (it.picture.questions ?? []).forEach((text, i) => {
      const sub = `q:${i + 1}`;
      if (!pointedAt.has(`${it.id}/${sub}`)) out.push({ item: it.id, sub, text, chapter: s.chapter });
    });
  }
  return out;
}

/** The marks that point at a part, through any picture that shows it. */
export function marksOnPart(state: BoardState, part: Id): Id[] {
  const out: Id[] = [];
  for (const s of liveItems(state)) {
    if (s.by !== 'owner' || !isMark(s.item)) continue;
    if (targetsOf(s.item).some((t) => targetOfPart(state, t) === part)) out.push(s.item.id);
  }
  return out;
}

/**
 * The owner's marks that can reopen a decided part: they point at it, they are still open,
 * and they were made (or last changed) after the part was last decided. An old mark, or one
 * the agent already answered, reopens nothing.
 */
export function reopeningMarks(state: BoardState, part: Id): Id[] {
  const p = state.model.parts[part];
  const since = p?.decidedSeq ?? 0;
  const byPicture = pictureAnswers(state);
  return marksOnPart(state, part).filter((id) => {
    const s = state.items[id];
    if (!s || isAnswered(state, id, byPicture)) return false;
    return Math.max(seqOf(s.event), state.edited[id] ?? 0) > since;
  });
}

/**
 * The pictures an agent may no longer change or take off: what the owner picked when
 * solidifying, the blueprint the owner pressed "Build this" on, and a choice the owner made. They stay as the owner
 * saw them. A change is a new picture that comes from the old one.
 */
export function ownersPictures(state: BoardState): Set<Id> {
  const out = new Set<Id>();
  for (const id of state.chapterOrder) {
    const c = state.chapters[id];
    if (!c) continue;
    for (const pick of c.picks) out.add(pick);
    if (c.blueprint !== undefined) out.add(c.blueprint);
  }
  // A choice the owner picked is theirs too: the question stays as it was when they answered it.
  for (const id of state.itemOrder) {
    if (state.items[id]?.chosenBy === 'owner') out.add(id);
  }
  return out;
}

/** The owner's lassos that no solidify has used yet: what the owner is holding together now. */
export function heldLassos(state: BoardState): Array<{ id: Id; chapter: Id; items: Id[] }> {
  const out: Array<{ id: Id; chapter: Id; items: Id[] }> = [];
  for (const s of liveItems(state)) {
    if (s.by !== 'owner' || s.item.kind !== 'lasso' || Object.hasOwn(state.answered, s.item.id)) continue;
    out.push({ id: s.item.id, chapter: s.chapter, items: [...new Set(s.item.targets.map((t) => t.item))] });
  }
  return out;
}

/**
 * What the owner said on a part since its chapter was decided: the words of their notes,
 * pins, spoken remarks and labels that point at it. The builder reads them with the part,
 * so a change the owner asks for cannot be lost between the board and the build.
 */
export function remarksOnPart(state: BoardState, part: Id): Array<{ id: Id; text: string }> {
  const chapters = chaptersWithPart(state, part);
  const own = state.model.parts[part]?.chapter;
  const since = Math.min(...[...chapters.map((c) => c.solidSeq ?? 0), ...(own && state.chapters[own]?.solidSeq ? [state.chapters[own]!.solidSeq!] : [])], Number.MAX_SAFE_INTEGER);
  const out: Array<{ id: Id; text: string }> = [];
  for (const id of marksOnPart(state, part)) {
    const s = state.items[id];
    if (!s) continue;
    const text = 'text' in s.item && typeof s.item.text === 'string' ? s.item.text.trim() : '';
    if (!text) continue;
    if (Math.max(seqOf(s.event), state.edited[id] ?? 0) <= (since === Number.MAX_SAFE_INTEGER ? 0 : since)) continue;
    out.push({ id, text });
  }
  return out;
}

/** The chapters whose build track holds a part, oldest first. */
export function chaptersWithPart(state: BoardState, part: Id): Chapter[] {
  const out: Chapter[] = [];
  for (const id of state.chapterOrder) {
    const c = state.chapters[id];
    if (c && c.track.includes(part)) out.push(c);
  }
  return out;
}

/** The part a target stands for, if it stands for one. */
export function targetOfPart(state: BoardState, t: Target): Id | undefined {
  if (t.sub && subKind(t.sub) === 'part') return subId(t.sub);
  const s = state.items[t.item];
  if (!s || s.item.kind !== 'picture') return undefined;
  const p = s.item.picture;
  if (p.kind === 'focus') return p.part;
  if (p.kind === 'choice') return p.part;
  return undefined;
}

/** How far a chapter's build has come. A part the owner put off does not count. */
export function trackProgress(state: BoardState, chapter: Id): { built: number; total: number; current?: Id } {
  const c = state.chapters[chapter];
  if (!c) return { built: 0, total: 0 };
  let built = 0;
  let total = 0;
  let current: Id | undefined;
  for (const id of c.track) {
    const p = state.model.parts[id];
    if (!p || p.dropped || p.state === 'later') continue;
    total += 1;
    if (p.state === 'built') built += 1;
    else if (p.state === 'building' && current === undefined) current = id;
  }
  return { built, total, current };
}

/** The chapter the owner is working in: the one with the newest open thing, else the newest one not built. */
export function currentChapter(state: BoardState): Id | undefined {
  const open = openThings(state);
  for (let i = open.length - 1; i >= 0; i--) {
    const c = open[i]?.chapter;
    if (c && state.chapters[c]) return c;
  }
  for (let i = state.chapterOrder.length - 1; i >= 0; i--) {
    const id = state.chapterOrder[i];
    if (id && state.chapters[id]?.state !== 'built') return id;
  }
  return state.chapterOrder[state.chapterOrder.length - 1];
}

/* -------------------------------------------------------------- canvases */

/** The chapters on a canvas, oldest first. */
export function chaptersOn(state: BoardState, canvas: Id): Chapter[] {
  const out: Chapter[] = [];
  for (const id of state.chapterOrder) {
    const c = state.chapters[id];
    if (c && c.canvas === canvas) out.push(c);
  }
  return out;
}

/** What a canvas is called: its own title, else its first idea's, else nothing yet. */
export function canvasTitle(state: BoardState, canvas: Id): string {
  const own = Object.hasOwn(state.canvases, canvas) ? state.canvases[canvas]?.title : undefined;
  return own ?? chaptersOn(state, canvas)[0]?.title ?? '';
}

/**
 * The chapter the owner is working in on one canvas: the one with the newest open thing
 * there, else the newest one there that is not built. Undefined on a blank canvas, and on
 * one where every idea is built: the next mark there opens a new idea, on the same canvas.
 */
export function chapterInWorkOn(state: BoardState, canvas: Id): Id | undefined {
  const open = openThings(state);
  for (let i = open.length - 1; i >= 0; i--) {
    const c = open[i]?.chapter;
    if (c && state.chapters[c]?.canvas === canvas && state.chapters[c]!.state !== 'built') return c;
  }
  const here = chaptersOn(state, canvas);
  for (let i = here.length - 1; i >= 0; i--) if (here[i]!.state !== 'built') return here[i]!.id;
  return undefined;
}

/** The parts on a chapter's track that are to be built: not dropped, not put off. */
export function dueParts(state: BoardState, chapter: Chapter): Id[] {
  return chapter.track.filter((id) => {
    const p = state.model.parts[id];
    return p !== undefined && !p.dropped && p.state !== 'later';
  });
}

/**
 * True while a building chapter has every part built and its app has not answered yet: the
 * build's last step. The builder starts the app once; when it does not answer, the build
 * stops here, and going on with the build tries again.
 */
export function awaitsProof(state: BoardState, chapter: Id): boolean {
  const c = state.chapters[chapter];
  if (!c || c.state !== 'building' || c.show?.kind !== 'app' || c.proved) return false;
  const due = dueParts(state, c);
  return due.length > 0 && due.every((id) => state.model.parts[id]?.state === 'built');
}

/**
 * How a canvas's branch stands, from the board's side. `waiting`: the built ideas the home
 * branch does not have yet, which an approval would merge. `building`: the ideas still
 * building there. They share the branch, so nothing on it is approved while one builds.
 */
export function canvasBuilds(state: BoardState, canvas: Id): { waiting: Chapter[]; building: Chapter[]; merged: Chapter[] } {
  const here = chaptersOn(state, canvas);
  return {
    waiting: here.filter((c) => c.state === 'built' && !c.merged),
    building: here.filter((c) => c.state === 'building'),
    merged: here.filter((c) => c.state === 'built' && c.merged !== undefined),
  };
}

/**
 * The board as one canvas shows it: only that canvas's chapters, and only their items, feed
 * lines and moments. The model is the project's and stays whole. What waits on another
 * canvas is not in it, so a count taken from it is that canvas's own. An act that names no
 * chapter, such as a tap on a part, is asked of the whole board and stays in every canvas.
 */
export function scopeToCanvas(state: BoardState, canvas: Id): BoardState {
  const mine = (chapter: Id | undefined) => chapter !== undefined && state.chapters[chapter]?.canvas === canvas;
  const chapterOrder = state.chapterOrder.filter((id) => mine(id));
  const itemOrder = state.itemOrder.filter((id) => mine(state.items[id]?.chapter));
  return {
    ...state,
    canvases: Object.hasOwn(state.canvases, canvas) ? { [canvas]: state.canvases[canvas]! } : {},
    canvasOrder: state.canvasOrder.filter((id) => id === canvas),
    chapters: Object.fromEntries(chapterOrder.map((id) => [id, state.chapters[id]!])),
    chapterOrder,
    items: Object.fromEntries(itemOrder.map((id) => [id, state.items[id]!])),
    itemOrder,
    acts: Object.fromEntries(Object.entries(state.acts).filter(([, a]) => a.chapter === undefined || mine(a.chapter))),
    feed: state.feed.filter((f) => mine(f.chapter)),
    moments: state.moments.filter((m) => mine(m.chapter)),
  };
}
