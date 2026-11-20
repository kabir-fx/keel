import type { News } from './watch';

/**
 * Desktop notifications, for the owner who left the tab while the agent builds. The board asks
 * once, when the owner presses "Build this", and tells only while the tab is hidden: a problem,
 * a choice the agent made, a reopened part, the chapter built.
 */

type NotificationLike = {
  permission: NotificationPermission;
  requestPermission?: () => Promise<NotificationPermission>;
  new (title: string, options?: { body?: string; tag?: string }): unknown;
};

function api(): NotificationLike | undefined {
  const n = (globalThis as { Notification?: NotificationLike }).Notification;
  return typeof n === 'function' ? n : undefined;
}

/** True when the browser lets the board tell the owner. */
export function canNotify(): boolean {
  return api()?.permission === 'granted';
}

/** Ask, once, whether the board may tell the owner. A browser that has no notifications is left alone. */
export function askToNotify(): void {
  const n = api();
  if (!n || n.permission !== 'default' || typeof n.requestPermission !== 'function') return;
  try {
    void Promise.resolve(n.requestPermission()).catch(() => undefined);
  } catch {
    // An old browser takes a callback instead, or refuses outright: either way, nothing to do.
  }
}

/** At most this many notifications in any `WINDOW_MS`: a stream of problems must not flood the owner. */
export const MAX_TOLD = 3;
export const WINDOW_MS = 60_000;

/** When each of the latest notifications went, newest last. */
let told: number[] = [];

/** Start counting afresh. For tests. */
export function forgetTold(): void {
  told = [];
}

/**
 * Tell the owner, only while the tab is hidden, and at most `MAX_TOLD` times in any `WINDOW_MS`.
 * What is over the limit is dropped: the feed has it anyway. Returns how many were sent.
 */
export function tell(
  news: readonly News[],
  doc: Pick<Document, 'visibilityState'> | undefined = typeof document === 'undefined' ? undefined : document,
  clock: () => number = Date.now,
): number {
  const n = api();
  if (!n || n.permission !== 'granted' || !doc || doc.visibilityState !== 'hidden') return 0;
  let sent = 0;
  for (const x of news) {
    const now = clock();
    told = told.filter((t) => now - t < WINDOW_MS);
    if (told.length >= MAX_TOLD) break;
    try {
      new n('Keel', { body: x.line, tag: x.tag });
      told.push(now);
      sent += 1;
    } catch {
      // Some browsers allow notifications only from a service worker: the board says it in the feed anyway.
    }
  }
  return sent;
}
