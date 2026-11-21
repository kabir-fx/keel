import type { BoardState, CanvasWork, Chapter, FeedEntry, HomeInfo, Id, ShowInfo } from '@keel/protocol';
import { awaitsProof, canvasBuilds, canvasTitle, chaptersOn, trackProgress } from '@keel/protocol';
import type { ServerBuild } from './watch';

/**
 * Trying a built idea and approving its canvas, as plain data: what the home branch line says,
 * what each canvas's card says and offers, what the try room shows, what a delete takes away.
 * The panels only draw what these say. Records 0013 and 0014: the branch, Approve and Delete
 * are the canvas's; a show is one idea's.
 */

/* ------------------------------------------------------------- the home branch */

/** The home branch by its real name, or "the main branch" where no repository says it. */
export const homeName = (home: HomeInfo | undefined): string => home?.branch ?? 'the main branch';

/** The remote the home branch follows: "origin" of "origin/main". */
export const remoteOf = (home: HomeInfo): string => home.upstream?.split('/')[0] || 'origin';

const commits = (n: number) => `${n} ${n === 1 ? 'commit' : 'commits'}`;

export interface HomeLine {
  /** The line itself: the branch, its commit, how it stands with its remote. */
  words: string;
  /** A second line, when the owner's folder is on another branch. */
  folder?: string;
  /**
   * How it reads: `quiet` when all is well, `soft` when the remote did not answer (the board
   * goes on as it is), `needs` when the owner must do something.
   */
  tone: 'quiet' | 'soft' | 'needs';
  /** Offer Push: there are commits here the remote does not have. */
  push: boolean;
  /** Offer to look at the remote again. */
  lookAgain: boolean;
}

/** What the home branch line on top of the Story says (plan 5.1). Undefined where the folder is no repository. */
export function homeLine(home: HomeInfo | undefined): HomeLine | undefined {
  if (!home) return undefined;
  const b = home.branch;
  const remote = remoteOf(home);
  const folder = home.folderOn && home.folderOn !== b ? { folder: `Your folder is on ${home.folderOn}. Builds start from ${b}.` } : {};
  const line = (words: string, more: Partial<HomeLine> = {}): HomeLine => ({ words, tone: 'quiet', push: false, lookAgain: false, ...folder, ...more });
  if (!home.commit) return line(`${b} · no commit yet`);
  const at = `${b} · ${home.commit}`;
  switch (home.sync) {
    case 'local':
      return line(`${at} · follows no remote`);
    case 'level':
      return line(`${at} · level with ${remote}`, { lookAgain: true });
    case 'ahead':
      return line(`${at} · ${commits(home.ahead ?? 1)} to push to ${remote}`, { push: true, lookAgain: true });
    case 'behind':
      return line(home.note ?? `${remote} has ${home.behind !== undefined ? commits(home.behind) : 'commits'} that ${b} does not. ${b} was not brought level.`, { tone: 'needs', lookAgain: true });
    case 'diverged':
      return line(home.note ?? `${b} and ${home.upstream ?? remote} have both moved, so the board did not pull. Run git pull in the board’s folder, then look again.`, { tone: 'needs', lookAgain: true });
    case 'unreachable':
      return line(`${remote} did not answer. Building from ${b} as it is here, at ${home.commit}.`, { tone: 'soft', lookAgain: true });
  }
}

/**
 * A sentence from the server that may run on with what git printed: its first sentence, to
 * show, and the rest, to keep folded. The text itself is not changed.
 */
export function saidParts(text: string): { head: string; more?: string } {
  const m = /^(.+?[.!?])(?:\s+|$)([\s\S]*)$/.exec(text.trim());
  const more = m?.[2]?.trim();
  return m && more ? { head: m[1]!, more } : { head: text.trim() };
}

/* ------------------------------------------------------------- what is going on */

/**
 * What the server does with a canvas's branch now, in words (`CanvasWork.busy`). `building`
 * is said this way only once no idea on the canvas is building: until then, the idea's own
 * line says how far it is (`heldWhy`).
 */
export function busyWords(busy: NonNullable<CanvasWork['busy']>, home: HomeInfo | undefined, branch: string | undefined): string {
  const h = homeName(home);
  const it = branch ?? 'the build';
  switch (busy) {
    case 'building':
      return 'The builder is finishing: its last commit is not in yet.';
    case 'joining':
      return `${h} has moved since this build began. Joining its new commits into ${it} and running the check again.`;
    case 'merging':
      return `Merging ${it} into ${h}.`;
    case 'deleting':
      return 'Deleting this canvas and its branch.';
  }
}

/**
 * Why nothing can be tried or approved on a canvas now, when the server is busy with its
 * branch. While an idea there builds, it says that idea, since they share the branch.
 */
export function heldWhy(state: BoardState, canvas: Id, work: CanvasWork | undefined, home: HomeInfo | undefined): string | undefined {
  if (!work?.busy) return undefined;
  const other = work.busy === 'building' ? canvasBuilds(state, canvas).building[0] : undefined;
  if (!other) return busyWords(work.busy, home, work.branch);
  return awaitsProof(state, other.id)
    ? `The builder is starting ${quoted([other.title])} once, to see that it answers. Every idea on a canvas shares its branch, so this waits until it is done.`
    : `${quoted([other.title])} is building on this canvas, and every idea on a canvas shares its branch. This waits until it is built.`;
}

/**
 * Straight double quotes in a title, made into opening and closing ones. The board's heading
 * font draws a straight quote like a closing one, so `Ship "v2"` would read `Ship ”v2”`.
 */
export function curly(text: string): string {
  return text.replace(/"/g, (_q, at: number) => (at === 0 || /[\s([{\u2014\u2013-]/.test(text[at - 1]!) ? '“' : '”'));
}

/** A canvas's name as the owner reads it. */
export const canvasName = (state: BoardState, canvas: Id): string => curly(canvasTitle(state, canvas) || 'Untitled canvas');

/** Titles in quotes, joined as a sentence says them: “A”, “B” and “C”. */
export function quoted(titles: readonly string[]): string {
  const q = titles.map((t) => `“${curly(t)}”`);
  return q.length <= 1 ? (q[0] ?? '') : `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}`;
}

/**
 * The words the contract's reducer writes in each waiting idea's feed when the owner presses
 * Approve (`canvas.approve` in protocol/src/reduce.ts). What the server says after them is how it went.
 */
export const APPROVED_LINE = 'Approved by the owner.';

/**
 * How the owner's last Approve of a canvas went, when it did not end in a merge: the newest
 * line in the feed of an idea there, after it, that is not a state line. `waiting` when nothing
 * has come yet. Undefined when nothing waits to be merged, or it was never approved.
 */
export function approveOutcome(state: BoardState, canvas: Id): { line: FeedEntry } | { waiting: true } | undefined {
  const waiting = new Set(canvasBuilds(state, canvas).waiting.map((c) => c.id));
  if (waiting.size === 0) return undefined;
  const here = new Set(chaptersOn(state, canvas).map((c) => c.id));
  let at = -1;
  state.feed.forEach((e, i) => {
    if (waiting.has(e.chapter) && e.kind === 'state' && e.text === APPROVED_LINE) at = i;
  });
  if (at < 0) return undefined;
  for (let i = state.feed.length - 1; i > at; i--) {
    const e = state.feed[i]!;
    if (here.has(e.chapter) && e.kind !== 'state') return { line: e };
  }
  return { waiting: true };
}

/** Whether a canvas can be approved now, and what the press says. */
export interface ApproveCan {
  /** The ideas an approval merges. */
  waiting: Chapter[];
  /** Why it cannot be pressed now, when it cannot. */
  why?: string;
  /** The words on the button: they name every idea that goes, when more than one does. */
  label: string;
}

export function approveCan(state: BoardState, canvas: Id, work: CanvasWork | undefined, home: HomeInfo | undefined): ApproveCan | undefined {
  const b = canvasBuilds(state, canvas);
  if (b.waiting.length === 0) return undefined;
  const h = homeName(home);
  const label = b.waiting.length === 1 ? `Approve: merge into ${h}` : `Approve ${quoted(b.waiting.map((c) => c.title))}: merge into ${h}`;
  const why =
    b.building.length > 0
      ? `${quoted([b.building[0]!.title])} is still building on this canvas, and every idea on a canvas shares its branch. Approve when it is built.`
      : work?.busy
        ? busyWords(work.busy, home, work.branch)
        : undefined;
  return { waiting: b.waiting, label, ...(why ? { why } : {}) };
}

/** The builder's caveat: the newest problem it said about an idea once every part was built. */
export function caveatOf(state: BoardState, chapter: Id): FeedEntry | undefined {
  const c = state.chapters[chapter];
  if (!c?.builtAt) return undefined;
  for (let i = state.feed.length - 1; i >= 0; i--) {
    const e = state.feed[i]!;
    if (e.chapter === chapter && e.kind === 'problem' && e.at >= c.builtAt) return e;
  }
  return undefined;
}

/** "How you will know it works": the proof on the blueprint the owner agreed to. */
export function proofOf(state: BoardState, chapter: Id): string[] {
  const id = state.chapters[chapter]?.blueprint;
  const s = id ? state.items[id] : undefined;
  return s?.item.kind === 'picture' && s.item.picture.kind === 'blueprint' ? s.item.picture.proof : [];
}

/* ------------------------------------------------------------- one canvas, in the Story */

/** What runs of a show now, when something does: an app started or starting, a terminal open. */
export function runningOf(show: ShowInfo | undefined): 'app' | 'terminal' | undefined {
  if (show?.kind === 'app' && (show.state === 'on' || show.state === 'starting')) return 'app';
  if (show?.kind === 'terminal' && show.state === 'on') return 'terminal';
  return undefined;
}

/** The words on the press that opens an idea's try room: it says when its show runs already. */
export function tryLabel(show: ShowInfo | undefined): string {
  const r = runningOf(show);
  return r === 'app' ? 'Open the running app' : r === 'terminal' ? 'Open its terminal' : 'Try it';
}

/** One idea on a canvas's card: its state in words, and whether it can be tried. */
export interface IdeaLine {
  id: Id;
  title: string;
  /** "idea", "decided: waits for Build this", "building part 3 of 6", "built: try it", "merged into main". */
  words: string;
  look: 'idea' | 'solid' | 'building' | 'paused' | 'built' | 'merged';
  tryIt: boolean;
  /** What of its show runs now. */
  running?: 'app' | 'terminal';
}

/** What one idea on a canvas is now, in words. */
export function ideaLine(state: BoardState, c: Chapter, server?: ServerBuild, show?: ShowInfo): IdeaLine {
  const line = (words: string, look: IdeaLine['look'], tryIt = false): IdeaLine => ({ id: c.id, title: curly(c.title), words, look, tryIt });
  switch (c.state) {
    case 'idea':
      return line('idea', 'idea');
    case 'solid':
      return line('decided: waits for Build this', 'solid');
    case 'building': {
      const p = trackProgress(state, c.id);
      const said = server?.chapter === c.id ? server.state : undefined;
      if (c.paused || said === 'paused') return line(`paused at ${p.built} of ${p.total}`, 'paused');
      if (said === 'unagreed') return line('building here waits for your agreement', 'paused');
      if (awaitsProof(state, c.id)) return said === 'stopped' ? line('every part built, and the app did not answer', 'paused') : line('every part built: starting the app once', 'building');
      if (said === 'stopped') return line(`stopped at ${p.built} of ${p.total}`, 'paused');
      return line(`building part ${Math.min(p.built + 1, p.total)} of ${p.total}`, 'building');
    }
    case 'built': {
      if (c.merged) return line(`merged into ${c.merged.into}`, 'merged');
      const running = runningOf(show);
      if (!running) return line('built: try it', 'built', true);
      return { ...line(running === 'app' ? 'built: its app is running' : 'built: its terminal is open', 'built', true), running };
    }
  }
}

export interface CanvasCard {
  id: Id;
  name: string;
  ideas: IdeaLine[];
  /** The branch, with how far it is ahead of the home branch. */
  branch?: string;
  /** What the server does with it now. */
  busy?: string;
  approve?: ApproveCan;
  /** Where its merged work went, when everything built on it is merged. */
  merged?: string;
}

/** What one canvas's card in the Story says and offers. */
export function canvasCard(state: BoardState, canvas: Id, work: CanvasWork | undefined, home: HomeInfo | undefined, server?: ServerBuild, shows?: ReadonlyMap<string, ShowInfo>): CanvasCard {
  const ideas = chaptersOn(state, canvas).map((c) => ideaLine(state, c, server, shows?.get(c.id)));
  const ahead = work?.ahead;
  const branch = work?.branch ? `${work.branch}${ahead !== undefined && ahead > 0 ? ` · ${commits(ahead)} ${homeName(home)} does not have` : ''}` : undefined;
  const b = canvasBuilds(state, canvas);
  const last = b.merged[b.merged.length - 1]?.merged;
  const approve = approveCan(state, canvas, work, home);
  return {
    id: canvas,
    name: canvasName(state, canvas),
    ideas,
    ...(branch ? { branch } : {}),
    ...(work?.busy && !(work.busy === 'building' && b.building.length > 0) ? { busy: busyWords(work.busy, home, work.branch) } : {}),
    ...(approve ? { approve } : {}),
    ...(last && b.waiting.length === 0 ? { merged: `in ${last.into} at ${last.commit.slice(0, 7)}` } : {}),
  };
}

/* ------------------------------------------------------------- deleting a canvas */

/** What the confirmation says goes with a canvas, line by line (plan 5.6, by canvas). */
export function deleteWords(state: BoardState, canvas: Id, work: CanvasWork | undefined, home: HomeInfo | undefined, shows?: ReadonlyMap<string, ShowInfo>): string[] {
  const here = chaptersOn(state, canvas);
  const out: string[] = [];
  const running = here.filter((c) => c.state === 'building' && !c.paused);
  if (running.length > 0) out.push(`The build of ${quoted(running.map((c) => c.title))} stops.`);
  for (const c of here) {
    const r = runningOf(shows?.get(c.id));
    if (r === 'app') out.push(`The app of ${quoted([c.title])} is running: it is stopped.`);
    else if (r === 'terminal') out.push(`The terminal of ${quoted([c.title])} is open: it is closed.`);
  }
  if (here.length === 0) {
    out.push('It is blank: nothing else goes.');
    return out;
  }
  out.push(here.length === 1 ? `The idea ${quoted([here[0]!.title])} leaves the board, with its notes and pictures.` : `${here.length} ideas leave the board, with their notes and pictures: ${quoted(here.map((c) => c.title))}.`);
  const merged = here.filter((c) => c.merged);
  if (merged.length > 0) out.push(`${quoted(merged.map((c) => c.title))} ${merged.length === 1 ? 'is' : 'are'} in ${merged[0]!.merged!.into} already: that code stays there.`);
  const h = homeName(home);
  if (work?.branch) {
    const n = work.ahead;
    out.push(
      n === undefined
        ? `Its branch ${work.branch} is deleted, with every commit on it that ${h} does not have.`
        : n === 0
          ? `Its branch ${work.branch} is deleted. ${h} has everything on it.`
          : `Its branch ${work.branch} is deleted, with ${commits(n)} that ${h} does not have.`,
    );
  } else if (here.some((c) => (c.state === 'building' || c.state === 'built') && !c.merged)) {
    out.push('This machine has no branch for it, so nothing else goes.');
  }
  return out;
}

/* ------------------------------------------------------------- the try room */

/** What there is to try of a built idea on this machine. */
export type Tryable =
  | ShowInfo
  /** `no-copy`: this machine has no branch for it. `nothing`: there is a branch, and nothing here can run it. `merged`: it is in the home branch, its copy is gone. */
  | { kind: 'none'; why: 'no-copy' | 'nothing' | 'merged' };

export function tryableOf(c: Chapter, show: ShowInfo | undefined, work: CanvasWork | undefined): Tryable {
  if (c.merged) return { kind: 'none', why: 'merged' };
  if (show) return show;
  return { kind: 'none', why: work?.branch ? 'nothing' : 'no-copy' };
}

/** What the try room says about the show, in one or two sentences (plan 5.3). */
export function showWords(t: Tryable, home: HomeInfo | undefined): string {
  switch (t.kind) {
    case 'page':
      return 'The page this build made, served from an address of its own. Nothing runs.';
    case 'app':
      switch (t.state) {
        case 'off':
          return 'Not running. Start runs this command in the build’s own copy, boxed in, and shows the app here once it answers.';
        case 'starting':
          return 'Starting. The app shows here once it answers on its port. The board waits up to a minute.';
        case 'on':
          return t.url ? `Running at ${t.url}` : 'Running.';
        case 'failed':
          return 'It did not start.';
      }
      break;
    case 'terminal':
      switch (t.state) {
        case 'off':
          return 'Start opens a terminal in the build’s own copy, boxed in, and types this command for you. You go on from there.';
        case 'on':
          return 'A terminal in the build’s own copy. What you type runs there, not in your folder.';
        case 'ended':
          // With no code, it was stopped, or it never started: the server says the same for both.
          return t.code === null || t.code === undefined ? 'The terminal is closed.' : `The terminal ended with code ${t.code}.`;
      }
      break;
    case 'none':
      switch (t.why) {
        case 'no-copy':
          return 'This machine has no copy of this build, so there is nothing to run here. It was built on another machine, or its branch is gone.';
        case 'nothing':
          return 'The builder on this machine cannot run what it built, and the build made no page. There is nothing to try here.';
        case 'merged':
          return `This idea is in ${homeName(home)} now. Its copy is gone.`;
      }
  }
  return '';
}

/** The press beside a show that runs a command, by its state: what it does, in its own words. Undefined for a page or nothing. */
export function showPress(t: Tryable): 'Start' | 'Stop' | 'Start again' | undefined {
  if (t.kind === 'app') return t.state === 'off' ? 'Start' : t.state === 'failed' ? 'Start again' : 'Stop';
  if (t.kind === 'terminal') return t.state === 'off' ? 'Start' : t.state === 'ended' ? 'Start again' : 'Stop';
  return undefined;
}

/** True while a show's stream has something to say: what it printed so far, or prints now. */
export function streams(t: Tryable): boolean {
  return (t.kind === 'app' && t.state !== 'off') || (t.kind === 'terminal' && t.state === 'on');
}

/** The last lines of what a command printed, without the terminal's colour codes. */
export function lastLines(text: string, n = 12): string[] {
  const plain = stripAnsi(text).replace(/\r\n?/g, '\n');
  const lines = plain.split('\n');
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  return lines.slice(-n);
}

/** A terminal's control sequences, taken out: what is left reads as plain text. */
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
export const stripAnsi = (text: string): string => text.replace(ANSI, '');

/** A message from a show's stream, or undefined when it is not one. */
export function readShowMessage(data: unknown): { t: 'out'; data: string } | { t: 'end'; code: number | null } | undefined {
  let msg: unknown;
  try {
    msg = JSON.parse(String(data));
  } catch {
    return undefined;
  }
  if (!msg || typeof msg !== 'object') return undefined;
  const m = msg as { t?: unknown; data?: unknown; code?: unknown };
  if (m.t === 'out' && typeof m.data === 'string') return { t: 'out', data: m.data };
  if (m.t === 'end') return { t: 'end', code: typeof m.code === 'number' ? m.code : null };
  return undefined;
}
