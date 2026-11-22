import type { AgentLink, BoardEvent, BoardState, Digest, ForeignRange, Hold, Id, MarkItem, Presence, PresenceState, PresenceUpdate, WakeReason, WakeResult } from '@keel/protocol';
import { ACT_TYPES, digest, isAct, isForeign, openCount, openThings, renderDigest, targetsOf } from '@keel/protocol';
import { plain } from './text';

/**
 * The pause rule. Marks reach the log at once. The agent wakes once per pause: a short quiet
 * time after the owner's last input. One wake carries everything open since the last one.
 * While the owner draws their own diagram, or has pressed Hold, the agent holds: it wakes when
 * words come, or when the owner asks it to answer now.
 */

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** The kinds of open thing that are acts of the owner, not marks. */
const ACT_KINDS = new Set<string>([...ACT_TYPES, 'part.state']);

/** Quiet time after a stroke-like mark: the owner may still be drawing. */
export const QUIET_LONG = 1500;
/** Quiet time after a closed note, a spoken remark, a file, or an act. */
export const QUIET_SHORT = 300;
/** Waits before each retry of a failed wake. After the last one, wait for the owner. */
export const RETRY_DELAYS = [2000, 8000, 30000] as const;
/** A wake that has not returned by now counts as failed, so a hung link cannot stop every later wake. */
export const WAKE_TIMEOUT = 10 * 60_000;
/** What the pill says the moment a wake starts, before the agent says anything itself. */
export const WAKE_PRESENCE = { state: 'drawing', note: 'reading your marks', doing: 'reading' } as const satisfies PresenceUpdate;

/**
 * The presence a wake sets: the pill's words, and the agent's cursor on the newest fresh thing
 * of the owner's that is on the board, so the owner sees where the agent reads. An act (a
 * solidify, a pick) is not on the board: a solidify stands for the lasso it was made from, while
 * that is on the board, and any other act is given no place.
 * A mark that came with the log from outside (`foreign` in the digest) is passed over: the
 * agent is told not to answer it, so the cursor does not go there.
 */
export function wakePresence(d: Digest, state: BoardState): PresenceUpdate {
  // The digest lists what is open newest last.
  for (let i = d.open.length - 1; i >= 0; i--) {
    const o = d.open[i]!;
    const ev = state.acts[o.id]?.event;
    const id = ev?.type === 'solidify' ? ev.lasso : o.id;
    const s = id === undefined ? undefined : state.items[id];
    if (o.fresh && !o.foreign && s && !s.removed) return { ...WAKE_PRESENCE, cursor: { item: s.item.id } };
  }
  return WAKE_PRESENCE;
}

/**
 * What an event of the owner's is to the pause rule. `words` wake soon and end a hold. A
 * `file` wakes soon too, but dropped in during a hold it is part of the drawing, and ends
 * nothing. A `shape` (a box or an arrow of the owner's own drawing, new or with its label
 * changed) holds at once. A `mark` (ink, a pin, a box or an arrow on one of the agent's
 * pictures, new or with its label changed) waits long. Undefined for what is not the owner's input: a move, a resize, a
 * removal, a placement, a lasso, a system or agent event.
 */
export type Input = 'words' | 'file' | 'shape' | 'mark';

/** True when the mark is drawn on one of the agent's pictures: its anchor, or an end of an arrow, is on one. */
function onAgentPicture(item: MarkItem, state: BoardState): boolean {
  return [item.anchor, ...targetsOf(item)].some((t) => {
    const s = t && state.items[t.item];
    return !!s && s.by === 'agent' && s.item.kind === 'picture';
  });
}

/** A box or an arrow of the owner's own diagram, not a remark on the agent's picture. */
function ownDrawing(item: MarkItem, state: BoardState): boolean {
  return (item.kind === 'box' || item.kind === 'arrow') && !onAgentPicture(item, state);
}

export function inputOf(ev: BoardEvent, state: BoardState): Input | undefined {
  if (ev.by !== 'owner') return undefined;
  if (ev.type === 'item.add') {
    switch (ev.item.kind) {
      case 'note':
      case 'voice':
        return 'words';
      case 'file':
        return 'file';
      case 'box':
      case 'arrow':
        return ownDrawing(ev.item, state) ? 'shape' : 'mark';
      case 'ink':
      case 'pin':
        return 'mark';
      case 'lasso':
        // The owner holding things together, not a remark: a lasso is never open, and wakes nobody.
        return undefined;
      default:
        return undefined;
    }
  }
  // The owner's acts, their own change to a part among them.
  if (isAct(ev)) return 'words';
  if (ev.type === 'item.update' && ev.patch.text !== undefined) {
    // A changed label is what a new box or arrow with those words would be. Editing a note's words is a remark.
    const item = state.items[ev.item]?.item;
    if (item?.kind !== 'box' && item?.kind !== 'arrow') return 'words';
    return ownDrawing(item, state) ? 'shape' : 'mark';
  }
  return undefined;
}

export interface WakeSchedulerOptions {
  link: AgentLink;
  /** The board's state now. */
  state: () => BoardState;
  presence: { get(): Presence; set(update: PresenceUpdate): unknown };
  clock?: Clock;
  log?: (message: string) => void;
  /** How long one wake may take, in ms. 0 means no limit. */
  wakeTimeoutMs?: number;
  /**
   * What the pill goes back to when a good wake ends, when something other than the agent is
   * at work: the build. Undefined, or returning undefined, keeps the pill's own rule.
   */
  resting?: () => PresenceUpdate | undefined;
  /**
   * The events that came with the log from outside and that the owner has not kept. What they
   * left open wakes nobody, and the digest tags it as not a request.
   */
  foreign?: () => readonly ForeignRange[] | undefined;
  /** Called when a hold starts or ends, so the pages can show it. */
  onHold?: (by: Hold | undefined) => void;
}

export class WakeScheduler {
  private readonly link: AgentLink;
  private readonly state: () => BoardState;
  private readonly presence: WakeSchedulerOptions['presence'];
  private readonly clock: Clock;
  private readonly log: (message: string) => void;
  private readonly wakeTimeoutMs: number;
  private readonly resting: (() => PresenceUpdate | undefined) | undefined;
  private readonly foreign: () => readonly ForeignRange[] | undefined;
  private readonly onHold: (by: Hold | undefined) => void;

  private quietTimer: unknown;
  /** Why the agent holds, while it does. Only `start`, `notify`, `hold` and `release` change it. */
  private holdBy: Hold | undefined;
  private retryTimer: unknown;
  private running: Promise<void> | undefined;
  /** A pause ended while a wake ran: wake once more when it resolves. */
  private due = false;
  private failures = 0;
  private lastWakeSeq = 0;
  private closed = false;
  /** What the pill said before this wake, when it was a state worth going back to. */
  private before: PresenceState | undefined;
  /** Wakes started, for `status` and tests. */
  wakes = 0;

  constructor(opts: WakeSchedulerOptions) {
    this.link = opts.link;
    this.state = opts.state;
    this.presence = opts.presence;
    this.clock = opts.clock ?? systemClock;
    this.log = opts.log ?? (() => {});
    this.wakeTimeoutMs = opts.wakeTimeoutMs ?? WAKE_TIMEOUT;
    this.resting = opts.resting;
    this.foreign = opts.foreign ?? (() => undefined);
    this.onHold = opts.onHold ?? (() => {});
  }

  /** The `seq` the agent saw at its last good wake. */
  get seenSeq(): number {
    return this.lastWakeSeq;
  }

  get busy(): boolean {
    return this.running !== undefined;
  }

  /** Why the agent holds its answer now, or undefined when it does not. */
  get holding(): Hold | undefined {
    return this.holdBy;
  }

  /** The owner pressed Hold: no wake for shapes, ink or pins until words or `release`. */
  hold(): void {
    if (this.closed || this.holdBy === 'owner') return;
    this.clearQuiet();
    this.setHold('owner');
  }

  /** The owner asked for an answer now: one wake for everything open. */
  release(): void {
    if (this.closed || this.holdBy === undefined) return;
    this.setHold(undefined);
    this.fire('marks');
  }

  /**
   * Wake now if something is open: the server just started, and marks may have waited. A hold is
   * forgotten in a restart, so when all the owner left open is their own drawing, hold again.
   */
  start(): void {
    if (this.closed || this.holdBy !== undefined) return;
    const state = this.state();
    const outside = this.foreign();
    const own = openThings(state).filter((o) => !outside || !isForeign(outside, o.seq));
    if (own.length > 0 && own.every((o) => o.kind === 'mark' && ownDrawing(o.item, state))) this.setHold('drawing');
    else this.fire('start');
  }

  /** Hear new events. The owner's input restarts the quiet time, or keeps a hold on. */
  notify(events: readonly BoardEvent[]): void {
    if (this.closed) return;
    const state = this.state();
    const heard = new Set<Input>();
    for (const ev of events) {
      const input = inputOf(ev, state);
      if (input) heard.add(input);
    }
    if (heard.size === 0) return;
    // The owner is here again: a failed link gets a fresh set of retries.
    this.clearRetry();
    this.failures = 0;
    const words = heard.has('words') || (heard.has('file') && this.holdBy === undefined);
    if (words) {
      // Words end any hold, and the one wake carries everything open.
      if (this.holdBy !== undefined) this.setHold(undefined);
      this.wait(QUIET_SHORT);
      return;
    }
    if (heard.has('shape') && this.holdBy === undefined) this.setHold('drawing');
    if (this.holdBy !== undefined) this.clearQuiet();
    else this.wait(QUIET_LONG);
  }

  /** Resolves when no wake is running. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  close(): void {
    this.closed = true;
    this.clearQuiet();
    this.clearRetry();
  }

  private wait(delay: number): void {
    this.clearQuiet();
    this.quietTimer = this.clock.setTimeout(() => {
      this.quietTimer = undefined;
      this.fire('marks');
    }, delay);
  }

  private clearQuiet(): void {
    if (this.quietTimer !== undefined) this.clock.clearTimeout(this.quietTimer);
    this.quietTimer = undefined;
  }

  private setHold(by: Hold | undefined): void {
    this.holdBy = by;
    this.onHold(by);
  }

  private clearRetry(): void {
    if (this.retryTimer !== undefined) this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private fire(reason: WakeReason): void {
    // A hold lets nothing through: not a retry, and not a wake that was due. Its end fires.
    if (this.closed || this.holdBy !== undefined) return;
    if (this.running) {
      this.due = true;
      return;
    }
    const state = this.state();
    if (openCount(state) === 0) return;
    // Nothing of the owner's is open: what is open came with the log from outside, and is not kept.
    const outside = this.foreign();
    if (outside && openThings(state).every((o) => isForeign(outside, o.seq))) return;
    this.running = this.run(state, reason).then((result) => {
      this.running = undefined;
      this.after(result);
    });
  }

  private async run(state: BoardState, reason: WakeReason): Promise<WakeResult> {
    const d = digest(state, { since: this.lastWakeSeq, foreign: this.foreign() });
    const freshAct = d.open.some((o) => o.fresh && ACT_KINDS.has(o.kind));
    const why: WakeReason = reason === 'start' ? 'start' : freshAct ? 'act' : 'marks';
    this.wakes += 1;
    // The owner sees at once that the marks reached the agent, not "listening" while it reads.
    const prior = this.presence.get().state;
    // With a resting hook, the build says itself whether it still runs when the wake ends.
    this.before = prior === 'waiting' || (prior === 'building' && !this.resting) ? prior : undefined;
    this.presence.set(wakePresence(d, state));
    const firstOfChapter = d.chapter ? !hasAgentPicture(state, d.chapter.id) : false;
    let result: WakeResult;
    try {
      result = await this.bounded(this.link.wake({ digest: d, text: renderDigest(d), reason: why, firstOfChapter }));
    } catch (e) {
      result = { ok: false, note: e instanceof Error ? e.message : String(e) };
    }
    if (result?.ok) this.lastWakeSeq = d.seq;
    return result ?? { ok: false, note: 'the link returned nothing' };
  }

  /** The wake's own result, or a failure when it takes longer than the limit. */
  private bounded(wake: Promise<WakeResult>): Promise<WakeResult> {
    const limit = this.wakeTimeoutMs;
    if (limit <= 0) return wake;
    return new Promise<WakeResult>((resolve, reject) => {
      const timer = this.clock.setTimeout(() => {
        resolve({ ok: false, note: `no answer after ${Math.round(limit / 60_000)} minutes` });
      }, limit);
      wake.then(
        (r) => {
          this.clock.clearTimeout(timer);
          resolve(r);
        },
        (e) => {
          this.clock.clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  private after(result: WakeResult): void {
    if (this.closed) return;
    if (result.ok) {
      this.failures = 0;
      const p = this.presence.get();
      // The turn is over. While the build runs, the pill shows the build. Else a pill left on
      // "drawing", or "away" from a failure, goes back to listening, or to what it showed before.
      const back = this.resting?.();
      if (back) this.presence.set(back);
      else if (p.state === 'away' || p.state === 'drawing') this.presence.set({ state: this.before ?? 'listening' });
      if (this.due) {
        this.due = false;
        this.fire('marks');
      }
      return;
    }

    this.due = false;
    this.failures += 1;
    // The pill shows why. The reason comes from the link: one plain line.
    const why = plain(result.note ?? '').replace(/\s+/g, ' ').trim() || 'no reason given';
    const note = `the agent did not answer: ${why}`;
    this.presence.set({ state: 'away', note: note.length > 120 ? `${note.slice(0, 119)}…` : note });
    const delay = RETRY_DELAYS[this.failures - 1];
    if (delay === undefined) {
      this.log(`wake failed ${this.failures} times (${why}). Waiting for the owner's next mark.`);
      return;
    }
    this.log(`wake failed (${why}). Retrying in ${delay / 1000} s.`);
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = undefined;
      this.fire('marks');
    }, delay);
  }
}

/** True when the agent has drawn a picture in this chapter, even one it took off the board since. */
export function hasAgentPicture(state: BoardState, chapter: Id): boolean {
  for (const id of state.itemOrder) {
    const s = state.items[id];
    if (s && s.chapter === chapter && s.by === 'agent' && s.item.kind === 'picture') return true;
  }
  return false;
}
