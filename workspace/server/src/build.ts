import type { BoardEvent, BoardState, Builder, BuildJob, BuildResult, BuildShow, Id, Presence, PresenceUpdate } from '@keel/protocol';
import { renderBrief, trackProgress } from '@keel/protocol';
import { plain } from './text';

/**
 * The build's life on one board. The server hears every event the board admits and drives
 * the builder from them: "Build this" starts a run, Pause pauses it, Resume carries on, and a
 * decided part that goes back to an idea holds the build until the owner decides it again.
 *
 * One run at a time. A second chapter's build waits its turn. A builder that stops while
 * parts are still not built, and nobody paused it, is reported in the feed: never a silent stop.
 *
 * A build runs only with the owner's consent on this machine: a press of "Build this" or
 * Resume that the server admitted live, kept in the board's private file. A log read from
 * disk grants nothing, since a repository can ship a log that says anything. The consent's
 * check must be the chapter's check, word for word, and its track must hold every part the
 * run would build. With no consent, nothing runs, and the build is `unagreed`.
 */

/** What the build of one chapter is doing, for `keel-board status`. */
export type BuildState =
  /** The builder works on it now. */
  | 'running'
  /** It waits for another chapter's run to end. */
  | 'queued'
  /** A part on its track was reopened. It waits until the owner decides that part again. */
  | 'waiting'
  /** The owner paused it. */
  | 'paused'
  /** Its last run ended and the build is not done. The owner pauses and resumes to try again. */
  | 'stopped'
  /**
   * The log says it is building, but the owner has not agreed to it on this machine, for the
   * log as it is. Nothing runs. It is said first, whatever else holds: paused or waiting.
   */
  | 'unagreed';

export interface BuildInfo {
  chapter: Id;
  title: string;
  state: BuildState;
  built: number;
  total: number;
  /** The name of the part in work, while it runs. */
  part?: string;
  /** The check the build runs, or would run once the owner agrees. */
  check?: string;
}

/** What the owner agreed to: the check the build runs, and the parts it may build. */
export interface BuildConsent {
  check: string;
  track: readonly Id[];
}

export interface BuildRunnerOptions {
  /** Undefined when no builder is linked: "Build this" is still admitted, and the feed says how to link one. */
  builder: Builder | undefined;
  /**
   * The owner's consent for a chapter, with exactly this check and a track that holds these
   * parts. Left out: no consent, so nothing ever runs.
   */
  consent?: (chapter: Id, check: string | undefined, track: readonly Id[]) => BuildConsent | undefined;
  /** The board's state now. */
  state: () => BoardState;
  /** Post drafts as the system. */
  post: (drafts: unknown[]) => void;
  presence: { get(): Presence; set(update: PresenceUpdate): unknown };
  /** True while the agent is in a wake: the pill is the wake's then. */
  inWake: () => boolean;
  /** What the pill says when nothing builds and the agent is not in a wake. */
  rest: () => PresenceUpdate;
  /**
   * A run ended `done`, the chapter is built, and the builder gave something to show. What it
   * gave is passed on as it came, its folder and page as text: the server checks it and serves it.
   */
  show?: (chapter: Id, show: BuildShow) => void;
  log?: (message: string) => void;
  /** How long close waits for the builder's pause, then for its close. */
  closeTimeoutMs?: number;
}

/** What the feed says when "Build this" is pressed and no builder is linked. */
export const NO_BUILDER =
  'No builder is linked, so nothing is being built. Start the board with "keel-board open --builder <module>", or with a --link module that also exports createBuilder.';

const FEED_MAX = 400;
const NOTE_MAX = 120;
const CLOSE_TIMEOUT = 10_000;

interface Run {
  chapter: Id;
  job: BuildJob;
  /** Someone asked this run to stop: the owner, a reopened part, or the server closing. */
  asked: boolean;
}

export class BuildRunner {
  private readonly opts: BuildRunnerOptions;
  private readonly log: (message: string) => void;
  private readonly queue: Array<{ chapter: Id; resume: boolean }> = [];
  /** Chapters that wait until the owner decides a reopened part again. */
  private readonly held = new Set<Id>();
  /** Chapters whose last run ended with the build not done. */
  private readonly stopped = new Set<Id>();
  private current: Run | undefined;
  private outbox: unknown[] = [];
  private scheduled = false;
  private closed = false;
  /** Runs started, for tests. */
  runs = 0;

  constructor(opts: BuildRunnerOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
  }

  get builder(): Builder | undefined {
    return this.opts.builder;
  }

  /** True while a run is going. */
  get busy(): boolean {
    return this.current !== undefined;
  }

  /**
   * The server just started: carry on with every build that was going, not paused, and agreed
   * to on this machine. The others wait for the owner.
   */
  start(): void {
    const s = this.opts.state();
    for (const id of s.chapterOrder) {
      const c = s.chapters[id];
      if (!c || c.state !== 'building' || c.paused) continue;
      if (!this.opts.builder) {
        this.log(`"${c.title}" is building, but no builder is linked.`);
        continue;
      }
      if (reopened(s, id).length > 0) this.held.add(id);
      else if (!this.agreed(s, id)) {
        const check = c.check !== undefined ? ` Its check: ${c.check}` : '';
        this.log(`the log says "${c.title}" is building, but the owner has not agreed to it on this machine, so nothing runs until the owner presses Resume.${check}`);
      } else this.enqueue(id, true, false);
    }
    this.schedule();
  }

  /** Hear the events the board admitted. */
  notify(events: readonly BoardEvent[]): void {
    if (this.closed) return;
    for (const ev of events) this.hear(ev);
    this.release();
    this.schedule();
  }

  /** What the pill goes back to after a wake: building while a run goes, else nothing to say. */
  resting(): PresenceUpdate | undefined {
    const run = this.current;
    if (!run || this.closed) return undefined;
    return { state: 'building', note: this.noteFor(run) };
  }

  /** True while a run goes or waits its turn. */
  get active(): boolean {
    return this.current !== undefined || this.queue.length > 0;
  }

  /** The builder reports what it does. The pill shows it as building, while a run goes and no wake runs. */
  builderPresence(update: PresenceUpdate): void {
    const run = this.current;
    if (!run || this.closed || this.opts.inWake()) return;
    this.opts.presence.set({
      state: 'building',
      note: clip(plain(update.note ?? this.noteFor(run)), NOTE_MAX),
      ...(update.cursor ? { cursor: update.cursor } : {}),
    });
  }

  /** The build that matters now: the one running, else the next in line, else the newest one going. */
  status(): BuildInfo | undefined {
    const s = this.opts.state();
    let id = this.current?.chapter ?? this.queue[0]?.chapter;
    if (id === undefined) {
      for (let i = s.chapterOrder.length - 1; i >= 0; i--) {
        const c = s.chapters[s.chapterOrder[i]!];
        if (c?.state === 'building') {
          id = c.id;
          break;
        }
      }
    }
    if (id === undefined) return undefined;
    const c = s.chapters[id];
    if (!c) return undefined;
    const p = trackProgress(s, id);
    // Not agreed comes before paused and waiting: a build the owner has not agreed to here is
    // never shown as an ordinary paused build, whose Resume would agree to a check nobody showed.
    const state: BuildState =
      this.current?.chapter === id
        ? 'running'
        : this.queue.some((q) => q.chapter === id)
          ? 'queued'
          : !this.agreed(s, id)
            ? 'unagreed'
            : this.held.has(id)
              ? 'waiting'
              : c.paused
                ? 'paused'
                : 'stopped';
    const info: BuildInfo = { chapter: id, title: c.title, state, built: p.built, total: p.total };
    if (state === 'running' && this.current) info.part = this.partInWork(s, this.current)?.name;
    const check = this.current?.chapter === id ? this.current.job.check : c.check;
    if (check !== undefined) info.check = check;
    return info;
  }

  /** The server closes: pause the run, then close the builder. Nothing is posted after this. */
  async close(): Promise<void> {
    if (this.closed) return;
    // What is already said still reaches the feed: the board is open until the builder is closed.
    this.flush();
    this.closed = true;
    this.queue.length = 0;
    const b = this.opts.builder;
    if (!b) return;
    const run = this.current;
    if (run) {
      run.asked = true;
      await this.bounded(() => b.pause(), 'pause');
    }
    await this.bounded(() => b.close(), 'close');
  }

  /* ------------------------------------------------------------- events */

  private hear(ev: BoardEvent): void {
    const s = this.opts.state();
    switch (ev.type) {
      case 'build.start': {
        if (!this.opts.builder) return this.say(ev.chapter, NO_BUILDER);
        this.stopped.delete(ev.chapter);
        return this.enqueue(ev.chapter, false, true);
      }
      case 'build.pause': {
        this.dequeue(ev.chapter);
        if (this.current?.chapter === ev.chapter) this.pauseRun(this.current);
        return;
      }
      case 'build.resume': {
        if (!this.opts.builder) return this.say(ev.chapter, NO_BUILDER);
        this.stopped.delete(ev.chapter);
        const open = reopened(s, ev.chapter);
        if (open.length > 0) {
          this.held.add(ev.chapter);
          const names = open.map((id) => `"${partName(s, id)}"`).join(', ');
          return this.say(ev.chapter, `The build still waits: ${names} ${open.length === 1 ? 'is an idea again' : 'are ideas again'}. Solidify ${open.length === 1 ? 'it' : 'them'} and the build carries on.`);
        }
        this.held.delete(ev.chapter);
        return this.enqueue(ev.chapter, true, true);
      }
      case 'part.state': {
        if (ev.state === 'idea') return this.reopen(ev, s);
        if (this.current && s.chapters[this.current.chapter]?.track.includes(ev.part)) this.refreshPresence();
        return;
      }
      default:
        return;
    }
  }

  /** A decided part on a building chapter's track is an idea again: hold that build. */
  private reopen(ev: BoardEvent & { type: 'part.state' }, s: BoardState): void {
    if (!this.opts.builder) return;
    for (const id of s.chapterOrder) {
      const c = s.chapters[id];
      if (!c || c.state !== 'building' || !c.track.includes(ev.part)) continue;
      this.dequeue(id);
      this.stopped.delete(id);
      this.held.add(id);
      if (this.current?.chapter === id) this.pauseRun(this.current);
      const who = ev.by === 'owner' ? 'you reopened' : 'the agent reopened, from your mark,';
      const then = c.paused ? 'Solidify it again and resume, and the build carries on.' : 'Solidify it again and the build carries on.';
      this.say(id, `The build waits: ${who} "${partName(s, ev.part)}". ${then}`);
    }
  }

  /** A held build whose reopened parts are all decided again carries on, unless the owner paused it. */
  private release(): void {
    if (this.held.size === 0) return;
    const s = this.opts.state();
    for (const id of [...this.held]) {
      const c = s.chapters[id];
      if (!c || c.state !== 'building') {
        this.held.delete(id);
        continue;
      }
      if (reopened(s, id).length > 0) continue;
      this.held.delete(id);
      if (!c.paused) this.enqueue(id, true, false);
    }
  }

  private enqueue(chapter: Id, resume: boolean, announce: boolean): void {
    if (this.queue.some((q) => q.chapter === chapter)) return;
    if (!this.agreed(this.opts.state(), chapter)) return;
    const ahead = this.current && this.current.chapter !== chapter ? this.current.chapter : this.queue[0]?.chapter;
    this.queue.push({ chapter, resume });
    if (announce && ahead !== undefined && ahead !== chapter) {
      const s = this.opts.state();
      const title = s.chapters[chapter]?.title ?? chapter;
      const other = s.chapters[ahead]?.title ?? ahead;
      this.say(chapter, `The build of "${title}" waits its turn: "${other}" builds first, one build at a time.`);
    }
  }

  private dequeue(chapter: Id): void {
    const i = this.queue.findIndex((q) => q.chapter === chapter);
    if (i >= 0) this.queue.splice(i, 1);
  }

  private pauseRun(run: Run): void {
    if (run.asked) return;
    run.asked = true;
    const b = this.opts.builder;
    if (!b) return;
    Promise.resolve()
      .then(() => b.pause())
      .catch((e: unknown) => {
        if (this.closed) return;
        this.say(run.chapter, `The builder did not take the pause: ${messageOf(e)}`, 'problem');
        this.schedule();
      });
  }

  /* --------------------------------------------------------------- runs */

  private schedule(): void {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    // After the board's listeners are done: never post from inside one.
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.closed) return;
      this.flush();
      this.pump();
    });
  }

  private flush(): void {
    const drafts = this.outbox;
    this.outbox = [];
    for (const d of drafts) {
      try {
        this.opts.post([d]);
      } catch (e) {
        this.log(`could not post to the feed: ${messageOf(e)}`);
      }
    }
  }

  /** Start the next build in line, when none runs. */
  private pump(): void {
    const b = this.opts.builder;
    if (this.closed || this.current || !b) return;
    while (this.queue.length > 0) {
      const next = this.queue.shift()!;
      const s = this.opts.state();
      const c = s.chapters[next.chapter];
      if (!c || c.state !== 'building' || c.paused || this.held.has(next.chapter)) continue;
      const job = makeJob(s, next.chapter, next.resume);
      if (job.track.length === 0) continue;
      // The last gate: the owner's consent, with this very check and these parts.
      const consent = this.opts.consent?.(next.chapter, c.check, job.track.map((p) => p.id));
      if (!consent || consent.check !== c.check) continue;
      job.check = consent.check;
      this.begin(b, job);
      return;
    }
  }

  private begin(b: Builder, job: BuildJob): void {
    const run: Run = { chapter: job.chapter, job, asked: false };
    this.current = run;
    this.runs += 1;
    this.stopped.delete(job.chapter);
    this.refreshPresence();
    void (async () => {
      let outcome: { result: unknown } | { error: unknown };
      try {
        outcome = { result: await b.run(job) };
      } catch (e) {
        outcome = { error: e };
      }
      this.end(run, outcome);
    })();
  }

  private end(run: Run, outcome: { result: unknown } | { error: unknown }): void {
    if (this.current === run) this.current = undefined;
    if (this.closed) return;
    const s = this.opts.state();
    const c = s.chapters[run.chapter];
    const title = c?.title ?? run.job.title;
    const left = run.job.track.filter((p) => s.model.parts[p.id]?.state !== 'built');
    const p = trackProgress(s, run.chapter);
    const tally = `${p.built} of ${p.total} parts are built`;
    const retry = 'Pause and resume to try again.';
    const asked = run.asked || c?.paused === true || this.held.has(run.chapter);

    let problem: string | undefined;
    if ('error' in outcome) {
      problem = `The builder failed: ${messageOf(outcome.error)} The build of "${title}" stopped, and ${tally}. ${retry}`;
    } else if (!isResult(outcome.result)) {
      problem = `The builder ended without saying how, and the build of "${title}" stopped. ${tally}. ${retry}`;
    } else if (outcome.result.outcome === 'failed') {
      const why = outcome.result.note ? clip(plain(outcome.result.note).replace(/\s+/g, ' ').trim(), 200) : 'it gave no reason';
      problem = `The build of "${title}" stopped: ${ended(why)} ${cap(tally)}. ${retry}`;
    } else if (!asked && left.length > 0) {
      const names = left.map((x) => `"${x.name}"`).join(', ');
      problem = `The builder stopped (it said "${outcome.result.outcome}"), but nobody paused it and ${left.length === 1 ? 'one part is' : `${left.length} parts are`} not built: ${names}. ${retry}`;
    }
    if (problem !== undefined) {
      this.stopped.add(run.chapter);
      this.say(run.chapter, problem, 'problem');
      this.log(problem);
    } else if ('result' in outcome && isResult(outcome.result) && outcome.result.outcome === 'done' && c?.state === 'built') {
      this.handOver(run.chapter, outcome.result.show);
    }
    // The pill goes back to rest, whatever the builder said last, unless a wake has it now.
    if (!this.opts.inWake() && !this.current) this.opts.presence.set(this.opts.rest());
    this.schedule();
  }

  /** Pass on what a finished build shows, when it is the shape a show has. Anything else is left out. */
  private handOver(chapter: Id, show: unknown): void {
    const to = this.opts.show;
    if (!to || typeof show !== 'object' || show === null) return;
    const { dir, page } = show as { dir?: unknown; page?: unknown };
    if (typeof dir !== 'string' || typeof page !== 'string') {
      this.log('the builder gave something to show that is not a folder and a page. Nothing is shown.');
      return;
    }
    try {
      to(chapter, { dir, page });
    } catch (e) {
      this.log(`could not show the build: ${messageOf(e)}`);
    }
  }

  /* ------------------------------------------------------------ helpers */

  /** Has the owner agreed, on this machine, to the build of this chapter as it stands? */
  private agreed(s: BoardState, chapter: Id): boolean {
    const c = s.chapters[chapter];
    if (!c || c.check === undefined || !this.opts.consent) return false;
    return this.opts.consent(chapter, c.check, jobTrack(s, chapter).map((p) => p.id))?.check === c.check;
  }

  private say(chapter: Id, text: string, kind: 'update' | 'problem' = 'update'): void {
    if (this.closed) return;
    this.outbox.push({ type: 'feed.add', chapter, kind, text: clip(text, FEED_MAX) });
  }

  private refreshPresence(): void {
    const run = this.current;
    if (!run || this.closed || this.opts.inWake()) return;
    this.opts.presence.set({ state: 'building', note: this.noteFor(run) });
  }

  /** The part in work: the one marked building, else the next one not built. */
  private partInWork(s: BoardState, run: Run): { name: string; n: number; of: number } | undefined {
    const c = s.chapters[run.chapter];
    if (!c) return undefined;
    const cur = trackProgress(s, run.chapter).current ?? run.job.track.find((p) => s.model.parts[p.id]?.state !== 'built')?.id;
    if (cur === undefined) return undefined;
    return { name: partName(s, cur), n: c.track.indexOf(cur) + 1, of: c.track.length };
  }

  private noteFor(run: Run): string {
    const w = this.partInWork(this.opts.state(), run);
    const note = w ? `${w.name} (part ${w.n} of ${w.of})` : `"${run.job.title}"`;
    return clip(plain(note), NOTE_MAX);
  }

  private async bounded(fn: () => Promise<void>, what: string): Promise<void> {
    const ms = this.opts.closeTimeoutMs ?? CLOSE_TIMEOUT;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(fn),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            this.log(`the builder's ${what} took longer than ${Math.round(ms / 1000)} s. The server goes on closing.`);
            resolve();
          }, ms);
          timer.unref?.();
        }),
      ]);
    } catch (e) {
      this.log(`the builder's ${what} failed: ${messageOf(e)}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/** The job for a chapter: its title, the parts still to build in track order, the agreed check and the brief. */
export function makeJob(s: BoardState, chapter: Id, resume: boolean): BuildJob {
  const c = s.chapters[chapter];
  const track = jobTrack(s, chapter);
  const job: BuildJob = { chapter, title: c?.title ?? chapter, track, brief: renderBrief(s, chapter) ?? '', resume };
  if (c?.check !== undefined) job.check = c.check;
  return job;
}

/** The parts a run of this chapter would build now, in track order. */
export function jobTrack(s: BoardState, chapter: Id): BuildJob['track'] {
  const track: BuildJob['track'] = [];
  for (const id of s.chapters[chapter]?.track ?? []) {
    const p = Object.hasOwn(s.model.parts, id) ? s.model.parts[id] : undefined;
    // A built part is done. An idea holds the build. A part put off, or dropped, is not built now.
    if (!p || p.dropped || (p.state !== 'solid' && p.state !== 'building')) continue;
    track.push(p.plain !== undefined ? { id, name: p.name, plain: p.plain } : { id, name: p.name });
  }
  return track;
}

/** The parts on a chapter's track that are ideas again. */
export function reopened(s: BoardState, chapter: Id): Id[] {
  const c = s.chapters[chapter];
  if (!c) return [];
  return c.track.filter((id) => {
    const p = s.model.parts[id];
    return p !== undefined && !p.dropped && p.state === 'idea';
  });
}

function partName(s: BoardState, id: Id): string {
  return s.model.parts[id]?.name ?? id;
}

function isResult(r: unknown): r is BuildResult {
  if (typeof r !== 'object' || r === null) return false;
  const o = (r as { outcome?: unknown }).outcome;
  return o === 'done' || o === 'paused' || o === 'failed';
}

function messageOf(e: unknown): string {
  const m = plain(e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim() || 'no reason given';
  return ended(clip(m, 200));
}

/** A reason with a full stop at its end, and only one: what a builder says may bring its own. */
function ended(s: string): string {
  return /[.!?…]$/.test(s) ? s : `${s}.`;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
