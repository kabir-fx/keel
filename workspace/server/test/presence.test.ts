import { describe, expect, it } from 'vitest';
import type { Presence } from '@keel/protocol';
import { PresenceHub } from '../src/presence';

describe('the presence hub', () => {
  it('passes what the agent is busy with and the picture it writes on to the page, and tells presences apart by them', () => {
    const hub = new PresenceHub({ state: 'listening' });
    const heard: Presence[] = [];
    hub.subscribe((p) => heard.push(p));
    hub.set({ state: 'drawing', note: 'drawing a card', doing: 'drawing' });
    hub.set({ state: 'drawing', note: 'drawing a card', doing: 'drawing', picture: { kind: 'text' } });
    hub.set({ state: 'drawing', note: 'drawing a card', doing: 'drawing', picture: { kind: 'text', title: 'Why' } });
    hub.set({ state: 'drawing', note: 'drawing a card', doing: 'writing', picture: { kind: 'text', title: 'Why' } });
    // The same presence, its keys in another order, is no change.
    hub.set({ picture: { title: 'Why', kind: 'text' }, doing: 'writing', note: 'drawing a card', state: 'drawing' });
    expect(heard.map(({ since: _, ...p }) => p)).toEqual([
      { state: 'drawing', note: 'drawing a card', doing: 'drawing' },
      { state: 'drawing', note: 'drawing a card', doing: 'drawing', picture: { kind: 'text' } },
      { state: 'drawing', note: 'drawing a card', doing: 'drawing', picture: { kind: 'text', title: 'Why' } },
      { state: 'drawing', note: 'drawing a card', doing: 'writing', picture: { kind: 'text', title: 'Why' } },
    ]);
    expect(hub.get()).toEqual({ state: 'drawing', note: 'drawing a card', doing: 'writing', picture: { kind: 'text', title: 'Why' }, since: expect.any(String) });
  });
});
