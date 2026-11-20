import type { Actor, BoardEvent, BoardState, Box } from '@keel/protocol';
import { admit, emptyState } from '@keel/protocol';

/** A board in memory for tests: post drafts as an actor, and fail loudly on a refusal. */
export class Board {
  state: BoardState = emptyState();
  events: BoardEvent[] = [];
  private clock = Date.parse('2026-11-17T13:00:00Z');

  must(by: Actor, draft: Record<string, unknown>): BoardEvent {
    this.clock += 1000;
    const r = admit(this.state, draft, by, new Date(this.clock).toISOString());
    if (!r.ok) throw new Error(`refused under ${r.rule}: ${r.reason}`);
    this.state = r.state;
    this.events.push(r.event);
    return r.event;
  }
}

export const CH = 'engine-loop';

export function openBoard(): Board {
  const b = new Board();
  b.must('system', { type: 'board.open', name: 'uLLM' });
  b.must('owner', { type: 'chapter.open', chapter: CH, title: 'One engine, many requests' });
  return b;
}

export const note = (id: string, box: Box, extra: Record<string, unknown> = {}, chapter = CH) => ({
  type: 'item.add',
  chapter,
  item: { id, kind: 'note', box, text: `note ${id}`, ...extra },
});

export const text = (id: string, extra: Record<string, unknown>, chapter = CH) => ({
  type: 'item.add',
  chapter,
  item: { id, kind: 'picture', picture: { kind: 'text', title: `card ${id}` }, ...extra },
});

export const lanes = (id: string, extra: Record<string, unknown>, chapter = CH) => ({
  type: 'item.add',
  chapter,
  item: {
    id,
    kind: 'picture',
    picture: { kind: 'lanes', title: `lanes ${id}`, lanes: [{ id: 'api', name: 'API' }], steps: [{ id: 's1', lane: 'api', text: 'one' }] },
    ...extra,
  },
});

/** Place a picture by hand, as the app would after measuring it. */
export const placeAt = (id: string, box: Box) => ({ type: 'item.update', item: id, patch: { box } });
