import type { Actor, BoardEvent, BoardState, RuleId } from '../src';
import { admit, emptyState } from '../src';

/** A board in memory, for tests: post drafts as an actor and see what the rules say. */
export class Board {
  state: BoardState = emptyState();
  events: BoardEvent[] = [];
  private clock = Date.parse('2026-11-17T13:00:00Z');

  post(by: Actor, draft: Record<string, unknown>) {
    this.clock += 1000;
    const r = admit(this.state, draft, by, new Date(this.clock).toISOString());
    if (r.ok) {
      this.state = r.state;
      this.events.push(r.event);
    }
    return r;
  }

  /** Post a draft that must be admitted. */
  must(by: Actor, draft: Record<string, unknown>): BoardEvent {
    const r = this.post(by, draft);
    if (!r.ok) throw new Error(`refused under ${r.rule}: ${r.reason}`);
    return r.event;
  }

  /** Post a draft that must be refused, and return the rule that refused it. */
  refused(by: Actor, draft: Record<string, unknown>): { rule: RuleId; reason: string } {
    const r = this.post(by, draft);
    if (r.ok) throw new Error(`expected a refusal, but ${r.event.id} was admitted`);
    return { rule: r.rule, reason: r.reason };
  }
}

export const CH = 'engine-loop';
export const CHECK = 'make check';
export const PASSED = { cmd: CHECK, passed: true };

/** An open board with one chapter. */
export function openBoard(): Board {
  const b = new Board();
  b.must('system', { type: 'board.open', name: 'ullm' });
  b.must('owner', { type: 'chapter.open', chapter: CH, title: 'One engine, many requests' });
  return b;
}

export const note = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  type: 'item.add',
  chapter: CH,
  item: { id, kind: 'note', box: [100, 100, 300, 120], text, ...extra },
});

export const picture = (id: string, spec: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: 'item.add',
  chapter: CH,
  item: { id, kind: 'picture', picture: spec, ...extra },
});

export const ink = (id: string, hint: string, item: string, sub?: string) => ({
  type: 'item.add',
  chapter: CH,
  item: { id, kind: 'ink', box: [0, 0, 9, 9], strokes: [{ pts: [0, 0, 9, 9] }], targets: [{ item, ...(sub ? { sub } : {}) }], hint },
});

/** The owner's gate, with the parts the owner saw. */
export const solidify = (parts: string[], picks: string[] = [], extra: Record<string, unknown> = {}) => ({
  type: 'solidify',
  chapter: CH,
  picks,
  parts,
  ...extra,
});

export const blueprint = (parts: string[], extra: Record<string, unknown> = {}) => ({
  kind: 'blueprint',
  title: 'The blueprint',
  picks: [{ text: 'One engine thread', from: { item: 'a2' } }],
  proof: ['ullm sim runs 50 clients'],
  parts,
  check: CHECK,
  ...extra,
});

/**
 * A board with a first note, an answer, and a model: two lanes, a part the repository had
 * (handler), two ideas (door, scheduler), one put off by the agent (metrics), and a walk.
 */
export function ideaBoard(): Board {
  const b = openBoard();
  b.must('owner', note('m1', 'I want one engine that takes many requests at once'));
  b.must('agent', picture('a1', { kind: 'text', title: 'How I read your note', body: 'Many clients, one model.' }, { answers: ['m1'] }));
  b.must('agent', {
    type: 'model.patch',
    chapter: CH,
    ops: [
      { op: 'lane.set', lane: { id: 'api', name: 'API thread' } },
      { op: 'lane.set', lane: { id: 'engine', name: 'Engine thread' } },
      { op: 'part.set', part: { id: 'handler', name: 'Handler', lane: 'api', state: 'built', shelf: true, commit: 'PR 11' } },
      { op: 'part.set', part: { id: 'door', name: 'EngineClient', plain: 'the door: 64 at most', lane: 'api' } },
      { op: 'part.set', part: { id: 'scheduler', name: 'Scheduler', lane: 'engine' } },
      { op: 'part.set', part: { id: 'metrics', name: 'Metrics', lane: 'engine', state: 'later' } },
      { op: 'edge.set', edge: { from: 'handler', to: 'door' } },
      { op: 'edge.set', edge: { from: 'door', to: 'scheduler', label: 'put' } },
      {
        op: 'walk.set',
        walk: {
          id: 'req-42',
          name: 'Follow one request',
          steps: [
            { n: 1, part: 'handler', text: 'starts id req-42' },
            { n: 2, part: 'door', text: 'takes a ticket' },
            { n: 3, part: 'scheduler', text: 'admits req-42' },
          ],
        },
      },
    ],
  });
  b.must('agent', picture('a2', { kind: 'pipeline', title: 'Your pick, in full', view: 'flat', walk: 'req-42' }, { from: ['a1'] }));
  return b;
}

/** The idea board with door and scheduler decided by the owner. `a2` is the owner's pick. */
export function solidBoard(): Board {
  const b = ideaBoard();
  b.must('owner', solidify(['door', 'scheduler'], ['a2']));
  return b;
}

/** The idea board, solidified by the owner and started with "Build this". `a3` is the blueprint. */
export function buildingBoard(): Board {
  const b = solidBoard();
  const solid = b.events[b.events.length - 1]!;
  b.must('agent', picture('a3', blueprint(['door', 'scheduler']), { answers: [solid.id] }));
  b.must('owner', { type: 'build.start', chapter: CH, track: ['door', 'scheduler'], blueprint: 'a3', check: CHECK });
  return b;
}

/** Build one part the honest way: the agent says building, the build's tools report the check. */
export function build(b: Board, part: string, commit = `c0ffee${part.length}`): void {
  b.must('agent', { type: 'part.state', part, state: 'building' });
  b.must('system', { type: 'part.state', part, state: 'built', commit, check: PASSED });
}
