import type { AgentLink, BoardEvent, BoardState, ForeignRange, Id, Presence, PresenceState, PresenceUpdate, WakeReason, WakeResult } from '@keel/protocol';
import { ACT_TYPES, digest, isAct, isForeign, openCount, openThings, renderDigest } from '@keel/protocol';
import { plain } from './text';

/**
 * The pause rule. Marks reach the log at once. The agent wakes once per pause: a short quiet
 * time after the owner's last input. One wake carries everything open since the last one.
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
export const WAKE_PRESENCE = { state: 'drawing', note: 'reading your marks' } as const satisfies PresenceUpdate;

/**
 * How long to wait for quiet after this event, or undefined when it is not input for the
 * agent. Moves, placements, removals and system or agent events never wake anyone.
 */
export function quietAfter(ev: BoardEvent): number | undefined {
  if (ev.by !== 'owner') return undefined;
  if (ev.type === 'item.add') {
    switch (ev.item.kind) {
      case 'note':
      case 'voice':
      case 'file':
        return QUIET_SHORT;
      case 'ink':
      case 'box':
      case 'arrow':
      case 'pin':
        return QUIET_LONG;
      case 'lasso':
        // The owner holding things together, not a remark: a lasso is never open, and wakes nobody.
        return undefined;
      default:
        return undefined;
    }
  }
  // The owner's acts, their own change to a part among them.
  if (isAct(ev)) return QUIET_SHORT;
  // Editing the words of a note or a label is a remark too.
  if (ev.type === 'item.update' && ev.patch.text !== undefined) return QUIET_SHORT;
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

  private quietTimer: unknown;
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
  }

  /** The `seq` the agent saw at its last good wake. */
  get seenSeq(): number {
    return this.lastWakeSeq;
  }

  get busy(): boolean {
    return this.running !== undefined;
  }

  /** Wake now if something is open: the server just started, and marks may have waited. */
  start(): void {
    this.fire('start');
  }

  /** Hear new events. The owner's input restarts the quiet time. */
  notify(events: readonly BoardEvent[]): void {
    if (this.closed) return;
    let delay: number | undefined;
    for (const ev of events) delay = quietAfter(ev) ?? delay;
    if (delay === undefined) return;
    // The owner is here again: a failed link gets a fresh set of retries.
    this.clearRetry();
    this.failures = 0;
    if (this.quietTimer !== undefined) this.clock.clearTimeout(this.quietTimer);
    this.quietTimer = this.clock.setTimeout(() => {
      this.quietTimer = undefined;
      this.fire('marks');
    }, delay);
  }

  /** Resolves when no wake is running. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  close(): void {
    this.closed = true;
    if (this.quietTimer !== undefined) this.clock.clearTimeout(this.quietTimer);
    this.quietTimer = undefined;
    this.clearRetry();
  }

  private clearRetry(): void {
    if (this.retryTimer !== undefined) this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private fire(reason: WakeReason): void {
    if (this.closed) return;
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
    this.presence.set(WAKE_PRESENCE);
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
