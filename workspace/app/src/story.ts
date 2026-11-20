import type { BoardState, Box, ChapterState, Id, NoteItem } from '@keel/protocol';
import { alreadyThere, liveParts, pictureTitle } from '@keel/protocol';
import type { Draft } from './drafts';
import { chapterId, titleFromText } from './drafts';

/**
 * The Story (storyboard screen 7), as plain data: every idea as a chapter with its moments,
 * the project's progress, and where the next idea starts on the board.
 */

export interface StoryMoment {
  id: string;
  /** Its place in the chapter, from 1. */
  n: number;
  title: string;
  /** The items it shows that are still on the board. */
  items: Id[];
}

export interface StoryChapter {
  id: Id;
  title: string;
  state: ChapterState;
  paused: boolean;
  openedAt: string;
  solidAt?: string;
  builtAt?: string;
  /** Parts built here of the parts on its track built here. Zero of zero before "Build this". */
  built: number;
  total: number;
  /** Parts on its track the repository already had: they count apart, as nothing was built. */
  already: number;
  moments: StoryMoment[];
  /** When it has no moment: its main items, shown in their place. */
  main: Id[];
}

const live = (state: BoardState, id: Id) => {
  const s = state.items[id];
  return !!s && !s.removed;
};

/** What stands for a chapter with no moment: its blueprint, else its newest pictures, with its first note. */
export function mainItems(state: BoardState, chapter: Id, max = 3): Id[] {
  const own = state.itemOrder.filter((id) => live(state, id) && state.items[id]!.chapter === chapter);
  const pictures = own.filter((id) => state.items[id]!.item.kind === 'picture');
  const blueprint = pictures.find((id) => {
    const it = state.items[id]!.item;
    return it.kind === 'picture' && it.picture.kind === 'blueprint';
  });
  const note = own.find((id) => state.items[id]!.item.kind === 'note' && state.items[id]!.by === 'owner');
  const out: Id[] = [];
  if (note) out.push(note);
  if (blueprint) out.push(blueprint);
  for (let i = pictures.length - 1; i >= 0 && out.length < max; i--) if (!out.includes(pictures[i]!)) out.push(pictures[i]!);
  if (out.length === 0) out.push(...own.slice(0, max));
  return out.slice(0, max);
}

/** Every chapter, newest first, with its moments in the order they were saved. */
export function storyOf(state: BoardState): StoryChapter[] {
  const out: StoryChapter[] = [];
  for (let i = state.chapterOrder.length - 1; i >= 0; i--) {
    const c = state.chapters[state.chapterOrder[i]!];
    if (!c) continue;
    const p = chapterProgress(state, c.id);
    const moments: StoryMoment[] = [];
    for (const m of state.moments) {
      if (m.chapter !== c.id) continue;
      const items = m.items.filter((id) => live(state, id));
      if (items.length === 0) continue;
      moments.push({ id: m.id, n: moments.length + 1, title: m.title, items });
    }
    out.push({
      id: c.id,
      title: c.title,
      state: c.state,
      paused: c.paused,
      openedAt: c.openedAt,
      ...(c.solidAt ? { solidAt: c.solidAt } : {}),
      ...(c.builtAt ? { builtAt: c.builtAt } : {}),
      built: p.built,
      total: p.total,
      already: p.already,
      moments,
      main: moments.length === 0 ? mainItems(state, c.id) : [],
    });
  }
  return out;
}

/** The words under a thumbnail of one item: a picture's title, a note's first words. */
export function itemWords(state: BoardState, id: Id): string {
  const it = state.items[id]?.item;
  if (!it) return id;
  if (it.kind === 'picture') return pictureTitle(it.picture);
  if (it.kind === 'note' || it.kind === 'voice') return it.text.length > 48 ? `${it.text.slice(0, 47)}…` : it.text;
  if (it.kind === 'file') return it.name;
  return `your ${it.kind}`;
}

export interface Progress {
  built: number;
  total: number;
}

/**
 * A chapter's track, counted apart: parts built here (a commit and a check that passed on this
 * board) of the parts to build here, and parts the repository already had. A part put off
 * does not count.
 */
export function chapterProgress(state: BoardState, chapter: Id): Progress & { already: number } {
  const c = state.chapters[chapter];
  let built = 0;
  let total = 0;
  let already = 0;
  for (const id of c?.track ?? []) {
    const p = state.model.parts[id];
    if (!p || p.dropped || p.state === 'later') continue;
    if (alreadyThere(p)) {
      already += 1;
      continue;
    }
    total += 1;
    if (p.state === 'built') built += 1;
  }
  return { built, total, already };
}

/**
 * How far the whole project is: parts built here of all the parts to build, the parts that
 * were already there before the board, and chapters built of all chapters. A part outside
 * the system is nobody's to build, so it does not count.
 */
export function projectProgress(state: BoardState): { parts: Progress; already: number; chapters: Progress } {
  const parts = liveParts(state).filter((p) => !p.external);
  const ours = parts.filter((p) => !alreadyThere(p));
  const chapters = state.chapterOrder.map((id) => state.chapters[id]).filter((c) => !!c);
  return {
    parts: { built: ours.filter((p) => p.state === 'built').length, total: ours.length },
    already: parts.length - ours.length,
    chapters: { built: chapters.filter((c) => c!.state === 'built').length, total: chapters.length },
  };
}

/* ------------------------------------------------------------ the next idea */

/** How far beyond everything on the board the next idea starts, in world units. */
export const NEXT_GAP = 240;

/**
 * Where the next idea's note goes: to the right of everything on the board, level with the top
 * of it, so it starts on bare ground and the agent's pictures for it have room below.
 */
export function nextIdeaSpot(boxes: Iterable<Box>, size: readonly [number, number]): Box {
  let right = -Infinity;
  let top = Infinity;
  for (const [x, y, w] of boxes) {
    right = Math.max(right, x + w);
    top = Math.min(top, y);
  }
  if (!Number.isFinite(right)) return [0, 0, size[0], size[1]];
  return [Math.round(right + NEXT_GAP), Math.round(top), size[0], size[1]];
}

/** The next idea: a new chapter, titled from the note, and the owner's note in it. */
export function nextIdeaDrafts(state: BoardState, note: { id: Id; text: string; box: Box }): Draft[] {
  const title = titleFromText(note.text);
  const chapter = chapterId(title, state);
  const item: NoteItem = { id: note.id, kind: 'note', box: note.box.map((n) => Math.round(n)) as unknown as Box, text: note.text };
  return [
    { type: 'chapter.open', chapter, title },
    { type: 'item.add', chapter, item },
  ];
}

/** "14:02" today, "16 Nov 14:02" on another day. */
export function when(iso: string, now: Date = new Date(), timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const opts = timeZone ? { timeZone } : {};
  const day = (x: Date) => new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: 'short', day: 'numeric', ...opts }).format(x);
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, ...opts }).format(d);
  if (day(d) === day(now)) return `today ${time}`;
  return `${new Intl.DateTimeFormat('en-GB', { month: 'short', day: 'numeric', ...opts }).format(d)} ${time}`;
}
