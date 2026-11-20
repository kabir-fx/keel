import type { BoardInfo, BoardState, Check, ChapterState, FeedEntry, Id, PartState } from '@keel/protocol';
import { alreadyThere, remarksOnPart, trackProgress } from '@keel/protocol';

/**
 * Watching a build (storyboard screen 6), as plain data: the build track, the feed, what the
 * server says about the build, what to tell the owner when they are away, and the tab's title.
 * The panel in `Watch.tsx` only draws what these say.
 */

/* ------------------------------------------------------------------ track */

export interface TrackPart {
  id: Id;
  /** Its place on the track, from 1. */
  n: number;
  name: string;
  state: PartState;
  /** The part the builder is on now. */
  now: boolean;
  commit?: string;
  /** The repository had it before the board did: it is there, not built here. */
  shelf?: boolean;
}

export interface Track {
  chapter: Id;
  parts: TrackPart[];
  built: number;
  /** The parts that count: a part put off does not. */
  total: number;
  /** "part 3 of 7", "7 of 7 built". */
  words: string;
}

/** The build track of a chapter, each part in its state, and where the build is. */
export function trackOf(state: BoardState, chapter: Id): Track | undefined {
  const c = state.chapters[chapter];
  if (!c || c.track.length === 0) return undefined;
  const p = trackProgress(state, chapter);
  const parts: TrackPart[] = [];
  c.track.forEach((id, i) => {
    const part = state.model.parts[id];
    if (!part || part.dropped) return;
    parts.push({
      id,
      n: i + 1,
      name: part.name,
      state: part.state,
      now: id === p.current,
      ...(part.commit !== undefined && part.state === 'built' && !alreadyThere(part) ? { commit: part.commit } : {}),
      ...(alreadyThere(part) ? { shelf: true } : {}),
    });
  });
  // The part in work, else the first one not built yet: where the build is, or goes next.
  const at = parts.find((x) => x.now) ?? parts.find((x) => x.state !== 'built' && x.state !== 'later');
  const words = p.total > 0 && p.built >= p.total ? `${p.built} of ${p.total} built` : at ? `part ${at.n} of ${c.track.length}` : `${p.built} of ${p.total} built`;
  return { chapter, parts, built: p.built, total: p.total, words };
}

/** The parts on a building chapter's track that are ideas again: the build waits for the owner. */
export function reopenedParts(state: BoardState, chapter: Id): Id[] {
  const c = state.chapters[chapter];
  if (!c || c.state !== 'building') return [];
  return c.track.filter((id) => {
    const p = state.model.parts[id];
    return !!p && !p.dropped && p.state === 'idea';
  });
}

/* ------------------------------------------------------------------- feed */

export interface FeedLine {
  id: string;
  /** "14:02" */
  time: string;
  text: string;
  kind: FeedEntry['kind'];
  part?: Id;
  commit?: string;
  check?: Check;
}

/** Hours and minutes, in the owner's time zone unless one is given. */
export function clock(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, ...(timeZone ? { timeZone } : {}) }).format(d);
}

/** The feed of one chapter, newest last. */
export function feedOf(state: BoardState, chapter: Id, timeZone?: string): FeedLine[] {
  const out: FeedLine[] = [];
  for (const e of state.feed) {
    if (e.chapter !== chapter) continue;
    out.push({
      id: e.id,
      time: clock(e.at, timeZone),
      text: e.text,
      kind: e.kind,
      ...(e.part !== undefined ? { part: e.part } : {}),
      ...(e.commit !== undefined ? { commit: e.commit } : {}),
      ...(e.check !== undefined ? { check: e.check } : {}),
    });
  }
  return out;
}

/** The newest problem in a chapter's feed. */
export function lastProblem(state: BoardState, chapter: Id): FeedEntry | undefined {
  for (let i = state.feed.length - 1; i >= 0; i--) {
    const e = state.feed[i]!;
    if (e.chapter === chapter && e.kind === 'problem') return e;
  }
  return undefined;
}

/* ------------------------------------------------------------ build state */

export type ServerBuild = NonNullable<BoardInfo['build']>;
export type BuildWord = ServerBuild['state'] | 'built';

export interface BuildStatus {
  state: BuildWord;
  /** What it means, in plain words. */
  words: string;
  /** For `stopped`: the feed entry that says why. */
  problem?: string;
  /** For `unagreed`: the check the owner agrees to run here by pressing Resume. */
  check?: string;
  /**
   * For `unagreed`: the remarks pinned on the parts still to build, which the builder will follow
   * as "The owner said". In a log that came from elsewhere they may be someone else's words, so
   * the owner sees them before agreeing. In the order of the track.
   */
  remarks?: Remark[];
}

/** A remark the builder will follow: the part it is pinned on, and its words on one line. */
export interface Remark {
  part: string;
  text: string;
}

/** How much of a remark the panel shows: one line, at most this many characters. */
export const REMARK_MAX = 160;

const oneLine = (t: string, max = REMARK_MAX) => {
  const line = t.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** The remarks that would reach the builder: on each part of the track that is not built yet, in track order. */
export function remarksToBuild(state: BoardState, chapter: Id): Remark[] {
  const c = state.chapters[chapter];
  const out: Remark[] = [];
  for (const id of c?.track ?? []) {
    const p = state.model.parts[id];
    if (!p || p.dropped || p.state === 'built') continue;
    for (const r of remarksOnPart(state, id)) out.push({ part: p.name, text: oneLine(r.text) });
  }
  return out;
}

/** The build goes on by itself: only then may the owner leave it. */
export const goesOn = (s: BuildStatus | undefined) => !!s && (s.state === 'running' || s.state === 'queued');

const names = (state: BoardState, ids: readonly Id[]) => ids.map((id) => `"${state.model.parts[id]?.name ?? id}"`).join(', ');

/**
 * What the build of a chapter is doing, in plain words. The server knows best: it sends what its
 * build driver does on the websocket (`init` and `build`). With no word from the server, as in a
 * fixture, the board's state says paused or waiting, and otherwise the build is taken to run.
 */
export function buildStatus(state: BoardState, chapter: Id, server?: ServerBuild): BuildStatus | undefined {
  const c = state.chapters[chapter];
  if (!c) return undefined;
  if (c.state === 'built') return { state: 'built', words: 'Built. Every part on the track has a commit and a check that passed.' };
  if (c.state !== 'building') return undefined;
  const open = reopenedParts(state, chapter);
  const said = server?.chapter === chapter ? server.state : undefined;
  const st: ServerBuild['state'] = said ?? (c.paused ? 'paused' : open.length > 0 ? 'waiting' : 'running');
  switch (st) {
    case 'running': {
      const part = server?.chapter === chapter && server.part ? server.part : undefined;
      return { state: st, words: part ? `Building ${part} now.` : 'Building now.' };
    }
    case 'queued':
      return { state: st, words: 'Waiting its turn: another idea builds first, one build at a time.' };
    case 'waiting':
      return {
        state: st,
        words:
          open.length > 0
            ? `Waiting for you: ${names(state, open)} ${open.length === 1 ? 'is an idea again' : 'are ideas again'}. Solidify ${open.length === 1 ? 'it' : 'them'} and the build carries on.`
            : 'Waiting for you to decide a reopened part again.',
      };
    case 'paused':
      return { state: st, words: 'Paused. Nothing is built while it is paused.' };
    case 'stopped': {
      const p = lastProblem(state, chapter);
      return { state: st, words: 'Stopped before it finished. Pause and resume to try again.', ...(p ? { problem: p.id } : {}) };
    }
    case 'unagreed': {
      const check = (server?.chapter === chapter ? server.check : undefined) ?? c.check;
      const remarks = remarksToBuild(state, chapter);
      const what = remarks.length > 0 ? 'the parts on the track below, and the remarks on them listed here' : 'the parts on the track below';
      return {
        state: st,
        words:
          // Two ways here: the board came from elsewhere, or its log changed outside the board after the owner agreed.
          `This build waits for your agreement. The board says this idea is building, but you have not pressed "Build this" or Resume for the board as it is now, on this machine. Resume is your agreement to build what this board says (${what}), and to run this check here after each part:`,
        ...(check ? { check } : {}),
        ...(remarks.length > 0 ? { remarks } : {}),
      };
    }
  }
}

/** The build has stopped, or is waiting, or paused, or not agreed here: anything but going. */
export const isHeld = (s: BuildStatus | undefined) => !!s && !goesOn(s) && s.state !== 'built';

/* ----------------------------------------------------------- the tab's title */

/** The tab's title while a chapter builds: the progress first, so it reads in a row of tabs. */
export function tabTitle(base: string, state: BoardState, chapter: Id | undefined): string {
  const c = chapter ? state.chapters[chapter] : undefined;
  if (!c || (c.state !== 'building' && c.state !== 'built')) return base;
  const p = trackProgress(state, c.id);
  if (c.state === 'built') return `Built · ${c.title} · ${base}`;
  const lead = c.paused ? 'Paused' : reopenedParts(state, c.id).length > 0 ? 'Waits for you' : 'Building';
  return `${lead} ${p.built}/${p.total} · ${c.title} · ${base}`;
}

/** The chapter whose build the tab follows: the one in view when it builds or is built, else the newest one building. */
export function buildingChapter(state: BoardState, inView: Id | undefined): Id | undefined {
  const v = inView ? state.chapters[inView] : undefined;
  if (v && (v.state === 'building' || v.state === 'built')) return v.id;
  for (let i = state.chapterOrder.length - 1; i >= 0; i--) {
    const c = state.chapters[state.chapterOrder[i]!];
    if (c?.state === 'building') return c.id;
  }
  return undefined;
}

/* ------------------------------------------------------- news for the owner */

export interface News {
  kind: 'problem' | 'choice' | 'reopened' | 'built';
  /**
   * One short plain line: what kind of thing happened, and to which idea. Never the feed's own
   * words: a notification shows on a locked screen, and what the build said stays on the board.
   */
  line: string;
  /** One notification per thing: a later one with the same tag replaces it. */
  tag: string;
}

/** A chapter's title, short enough for one line of a notification. */
const shortTitle = (t: string) => (t.length > 40 ? `${t.slice(0, 39)}…` : t);

/**
 * What happened between two states that needs the owner: a problem in a feed, a choice the
 * agent made, a decided part reopened while it builds, a chapter built. The log only grows, so
 * the newer state's feed and items extend the older one's.
 */
export function newsBetween(prev: BoardState, next: BoardState): News[] {
  if (next.seq <= prev.seq) return [];
  const out: News[] = [];
  const title = (id: Id) => `"${shortTitle(next.chapters[id]?.title ?? id)}"`;
  for (const e of next.feed.slice(prev.feed.length)) {
    if (e.kind === 'problem') out.push({ kind: 'problem', line: `A problem in ${title(e.chapter)}. The board says what.`, tag: `keel-${e.id}` });
  }
  for (const id of next.itemOrder) {
    if (prev.items[id]) continue;
    const s = next.items[id];
    if (!s || s.removed || s.item.kind !== 'picture' || s.item.picture.kind !== 'choice') continue;
    out.push({ kind: 'choice', line: `The agent made a choice in ${title(s.chapter)}. It is yours to change.`, tag: `keel-${id}` });
  }
  for (const cid of next.chapterOrder) {
    const c = next.chapters[cid];
    if (!c || c.state !== 'building') continue;
    for (const pid of c.track) {
      const was = prev.model.parts[pid]?.state;
      const now = next.model.parts[pid]?.state;
      if (now === 'idea' && was !== undefined && was !== 'idea' && was !== 'later') {
        out.push({ kind: 'reopened', line: `The build of ${title(cid)} waits for you.`, tag: `keel-reopen-${cid}` });
      }
    }
  }
  for (const cid of next.chapterOrder) {
    const was: ChapterState | undefined = prev.chapters[cid]?.state;
    const c = next.chapters[cid];
    if (c?.state === 'built' && was !== 'built') out.push({ kind: 'built', line: `${title(cid)} is built.`, tag: `keel-built-${cid}` });
  }
  return out;
}
