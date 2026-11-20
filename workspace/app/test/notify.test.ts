import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetTold, MAX_TOLD, tell, WINDOW_MS } from '../src/notify';
import type { News } from '../src/watch';

class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static sent: string[] = [];
  constructor(_title: string, opts?: { body?: string }) {
    FakeNotification.sent.push(opts?.body ?? '');
  }
}

const news = (n: number, from = 0): News[] => Array.from({ length: n }, (_, i) => ({ kind: 'problem', line: `problem ${from + i}`, tag: `keel-${from + i}` }));
const hidden = { visibilityState: 'hidden' as DocumentVisibilityState };

beforeEach(() => {
  FakeNotification.sent = [];
  forgetTold();
  vi.stubGlobal('Notification', FakeNotification);
});
afterEach(() => vi.unstubAllGlobals());

describe('desktop notifications have a limit', () => {
  it('sends at most three in any minute, and drops the rest: the feed has them', () => {
    let now = 1_000_000;
    const clock = () => now;
    expect(MAX_TOLD).toBe(3);
    expect(WINDOW_MS).toBe(60_000);
    expect(tell(news(5), hidden, clock)).toBe(3);
    expect(FakeNotification.sent).toEqual(['problem 0', 'problem 1', 'problem 2']);
    now += 30_000;
    expect(tell(news(2, 5), hidden, clock)).toBe(0);
    // A minute after the first three, there is room again.
    now += 30_001;
    expect(tell(news(4, 7), hidden, clock)).toBe(3);
    expect(FakeNotification.sent).toHaveLength(6);
  });

  it('a window slides: room comes back one by one as the oldest grow a minute old', () => {
    let now = 0;
    const clock = () => now;
    tell(news(1), hidden, clock);
    now = 20_000;
    tell(news(1, 1), hidden, clock);
    now = 40_000;
    tell(news(1, 2), hidden, clock);
    now = 59_999;
    expect(tell(news(1, 3), hidden, clock)).toBe(0);
    now = 60_000;
    expect(tell(news(2, 4), hidden, clock)).toBe(1);
  });

  it('counts nothing while the tab is shown, or without permission', () => {
    const clock = () => 0;
    expect(tell(news(3), { visibilityState: 'visible' }, clock)).toBe(0);
    FakeNotification.permission = 'denied';
    expect(tell(news(3), hidden, clock)).toBe(0);
    FakeNotification.permission = 'granted';
    expect(tell(news(3), hidden, clock)).toBe(3);
  });
});
