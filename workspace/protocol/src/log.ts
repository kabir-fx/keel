import type { BoardEvent, EventDraft } from './events';
import { Stamp, parseDraft, parseEvent, stamp } from './events';
import type { Actor } from './ids';
import { MAX_SEQ } from './ids';
import { reduce, step } from './reduce';
import type { RuleId } from './rules';
import { check } from './rules';
import type { BoardState } from './state';

/** The log on disk is one JSON event per line. */
export function formatEvent(ev: BoardEvent): string {
  return JSON.stringify(ev);
}

export interface LogProblem {
  line: number;
  reason: string;
}

/** Read a log. A broken line is reported and skipped: one bad line does not lose the board. */
export function parseLog(text: string): { events: BoardEvent[]; problems: LogProblem[] } {
  const events: BoardEvent[] = [];
  const problems: LogProblem[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]?.trim();
    if (!raw) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      problems.push({ line: i + 1, reason: 'not JSON' });
      continue;
    }
    const r = parseEvent(value);
    if (r.ok) events.push(r.value);
    else problems.push({ line: i + 1, reason: r.reason });
  }
  return { events, problems };
}

export type Admitted =
  | { ok: true; event: BoardEvent; state: BoardState }
  | { ok: false; rule: RuleId; reason: string };

/**
 * The one way an event enters a board: check its shape, check the rules, number it, apply it.
 * `by` is who the sender really is. It replaces whatever the draft claims.
 */
export function admit(state: BoardState, input: unknown, by: Actor, at: string): Admitted {
  const candidate = typeof input === 'object' && input !== null ? { ...(input as object), by } : input;
  const parsed = parseDraft(candidate);
  if (!parsed.ok) return { ok: false, rule: 'shape', reason: parsed.reason };
  // What is admitted must read back from the log: a time or a number the log's own schema
  // refuses would be lost on the next start.
  if (state.seq + 1 > MAX_SEQ) return { ok: false, rule: 'shape', reason: 'This log is full: it cannot number another event.' };
  if (!Stamp.shape.at.safeParse(at).success) return { ok: false, rule: 'shape', reason: `"${at}" is not a time the log can hold.` };
  try {
    const verdict = check(state, parsed.value);
    if (!verdict.ok) return verdict;
    const event = stamp(parsed.value, state.seq + 1, at);
    return { ok: true, event, state: reduce(state, event) };
  } catch (e) {
    // The rules and the reducer are written never to throw. If one does, the event is refused
    // and the board stays as it was.
    return { ok: false, rule: 'shape', reason: `The event could not be checked: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Admit several drafts as one: all of them, or none. */
export function admitAll(
  state: BoardState,
  inputs: readonly unknown[],
  by: Actor,
  at: string,
): { ok: true; events: BoardEvent[]; state: BoardState } | { ok: false; rule: RuleId; reason: string; index: number } {
  let s = state;
  const events: BoardEvent[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const r = admit(s, inputs[i], by, at);
    if (!r.ok) return { ...r, index: i };
    s = r.state;
    events.push(r.event);
  }
  return { ok: true, events, state: s };
}

/**
 * Replay a log through the rules, as if each event were arriving now.
 * A fixture or a log from disk is legal when this finds no problem.
 */
export function audit(events: readonly BoardEvent[], start: BoardState): { state: BoardState; problems: Array<{ id: string; rule: RuleId; reason: string }> } {
  // A copy of its own, changed in place: a copy per event would make a long log quadratic.
  const state = structuredClone(start);
  const problems: Array<{ id: string; rule: RuleId; reason: string }> = [];
  for (const ev of events) {
    const { id, at: _at, ...draft } = ev;
    const expected = `e${state.seq + 1}`;
    if (id !== expected) problems.push({ id, rule: 'R4', reason: `Expected event ${expected}, found ${id}. The log has a gap or a repeat.` });
    try {
      const verdict = check(state, draft as EventDraft);
      if (!verdict.ok) problems.push({ id, rule: verdict.rule, reason: verdict.reason });
    } catch (e) {
      problems.push({ id, rule: 'shape', reason: `The event could not be checked: ${e instanceof Error ? e.message : String(e)}` });
    }
    step(state, ev);
  }
  return { state, problems };
}
