import type { Presence } from '@keel/protocol';
import { PresenceUpdate } from '@keel/protocol';

/** What the agent does now. Live, in memory, never logged. Listeners hear only real changes. */
export class PresenceHub {
  private current: Presence;
  private readonly listeners = new Set<(p: Presence) => void>();

  constructor(
    initial: PresenceUpdate,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.current = { ...clean(initial), since: now().toISOString() };
  }

  get(): Presence {
    return this.current;
  }

  /** Take an update. `since` moves only when the state changes. Returns the presence in force. */
  set(update: PresenceUpdate): Presence {
    const parsed = PresenceUpdate.safeParse(update);
    if (!parsed.success) return this.current;
    const u = clean(parsed.data);
    const since = u.state === this.current.state ? this.current.since : this.now().toISOString();
    const next: Presence = { ...u, since };
    if (JSON.stringify(next) === JSON.stringify(this.current)) return this.current;
    this.current = next;
    for (const fn of this.listeners) fn(next);
    return next;
  }

  subscribe(fn: (p: Presence) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** Drop undefined fields, so two equal presences serialise the same. */
function clean(u: PresenceUpdate): PresenceUpdate {
  const out: PresenceUpdate = { state: u.state };
  if (u.note !== undefined) out.note = u.note;
  if (u.cursor !== undefined) out.cursor = u.cursor;
  return out;
}
