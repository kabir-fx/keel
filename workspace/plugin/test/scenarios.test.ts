import { describe, expect, it } from 'vitest';
import type { BoardEvent } from '@keel/protocol';
import { BOARDS, goldenAnswer, seedEvents } from '../scenarios/boards';
import type { TranscriptLine } from '../scenarios/check';
import { checkRun, report } from '../scenarios/check';

/**
 * The recorded boards' checks, on canned logs: the golden fixture's own answer to each board
 * must pass, and a log with a mark left open, or a placeholder never finished, must fail.
 */

/** A transcript as the hosted link writes it: a wake, two model calls, one refused post, a result. */
function transcript(wakeAt: number): TranscriptLine[] {
  const usage = { input_tokens: 6, cache_creation_input_tokens: 21_000, cache_read_input_tokens: 0, output_tokens: 40 };
  return [
    { t: wakeAt, keel: 'wake', text: 'BOARD uLLM · ...' },
    { t: wakeAt + 300, type: 'system', subtype: 'init', model: 'claude-sonnet-test', tools: ['Read'] },
    { t: wakeAt + 2000, type: 'assistant', message: { id: 'm1', usage, content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__board__board_post', input: {} }] } },
    { t: wakeAt + 2100, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: [{ type: 'text', text: 'Refused picture 1 of 1 (mini).' }] }] } },
    { t: wakeAt + 5000, type: 'assistant', message: { id: 'm2', usage: { ...usage, cache_read_input_tokens: 21_000 }, content: [{ type: 'tool_use', id: 'tu2', name: 'mcp__board__board_post', input: {} }] } },
    { t: wakeAt + 5100, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'Posted: a-1' }] } },
    {
      t: wakeAt + 9000,
      type: 'result',
      is_error: false,
      duration_ms: 9000,
      num_turns: 2,
      total_cost_usd: 0.0421,
      usage: { input_tokens: 12, cache_creation_input_tokens: 21_000, cache_read_input_tokens: 21_000, output_tokens: 900 },
    },
  ];
}

function run(id: keyof typeof BOARDS, answer: (events: BoardEvent[]) => BoardEvent[] = (x) => x) {
  const board = BOARDS[id];
  const seed = seedEvents(board);
  const golden = answer(goldenAnswer(board));
  const wakeAt = Date.parse(seed[seed.length - 1]!.at) + 1000;
  return checkRun(board, seed, [...seed, ...golden], transcript(wakeAt));
}

describe('the recorded boards', () => {
  it.each(['a', 'b', 'c', 'd', 'e', 'f'] as const)('board %s: the golden agent\'s own answer passes', (id) => {
    const r = run(id);
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(Object.values(r.answered).every((v) => v !== null)).toBe(true);
  });

  it('board a: wants the read, the shelf and the spread', () => {
    const r = run('a');
    expect(r.pictures.map((p) => p.kind)).toEqual(['mini', 'shelf', 'spread']);
    expect(r.answered['n-first']).toBe('e15');
  });

  it('measures the seconds from the wake, the tokens, the cost and the refusals', () => {
    const r = run('d');
    // The golden focus lands 6 s after the tap; the wake was 1 s after it.
    expect(r.numbers.firstPicture).toBe(5);
    expect(r.numbers.lastPicture).toBe(5);
    expect(r.numbers.turnSeconds).toBe(9);
    expect(r.numbers.contextAtWake).toBe(21_006);
    expect(r.numbers.apiCalls).toBe(2);
    expect(r.numbers).toMatchObject({ outputTokens: 900, cacheReadTokens: 21_000, costUsd: 0.0421, refusals: 1, model: 'claude-sonnet-test' });
    expect(r.refusals[0]).toContain('board_post: Refused picture 1 of 1');
    expect(r.tools.map((t) => t.name)).toEqual(['board_post', 'board_post']);
  });

  it('board e: a blueprint with no check fails, and so does a part moved toward built', () => {
    const noCheck = run('e', (evs) =>
      evs.map((e) => (e.type === 'item.add' && e.item.kind === 'picture' && e.item.picture.kind === 'blueprint' ? ({ ...e, item: { ...e.item, picture: { ...e.item.picture, check: undefined } } } as unknown as BoardEvent) : e)),
    );
    expect(noCheck.ok).toBe(false);
    expect(noCheck.checks.find((c) => c.name === 'the blueprint names a check and solid parts')?.ok).toBe(false);
    const ok = run('e');
    expect(ok.checks.find((c) => c.name === 'the blueprint names a check and solid parts')?.detail).toBe('check "make check", 7 parts');
  });

  it('board f: the golden log\'s own builder events would fail it; the card alone passes', () => {
    const board = BOARDS.f;
    const seed = seedEvents(board);
    const all = goldenAnswer({ ...board, golden: undefined });
    expect(all.some((e) => e.type === 'part.state')).toBe(true);
    const r = checkRun(board, seed, [...seed, ...all], transcript(Date.parse(seed.at(-1)!.at) + 1000));
    expect(r.checks.find((c) => c.name === 'nothing moves toward built')?.ok).toBe(false);
    expect(run('f').checks.find((c) => c.name === 'a text card answers e54')).toMatchObject({ ok: true, detail: '"You can leave."' });
  });

  it('board g: a reopen that names the mark passes; an answer that does not reopen fails', () => {
    const board = BOARDS.g;
    const seed = seedEvents(board);
    expect(seed.at(-1)).toMatchObject({ id: 'e65', by: 'owner', item: { id: 'note-change' } });
    const at = (s: number) => new Date(Date.parse(seed.at(-1)!.at) + s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const reply = {
      id: 'e68',
      at: at(6),
      by: 'agent',
      chapter: 'engine-loop',
      type: 'item.add',
      item: {
        id: 'reply-change',
        kind: 'picture',
        answers: ['note-change'],
        picture: { kind: 'mini', title: 'Reopened: try it', boxes: [{ text: '50 fake clients' }, { text: '20, two give up after 1 s', tone: 'blue' }], caption: 'Read as: change the try-it part.' },
      },
    } as unknown as BoardEvent;
    const reopen = { id: 'e66', at: at(3), by: 'agent', type: 'part.state', part: 'try-it', state: 'idea', because: ['note-change'] } as unknown as BoardEvent;
    // After the reopen, the part itself says the change, so the owner sees it on the picture.
    const change = {
      id: 'e67',
      at: at(4),
      by: 'agent',
      chapter: 'engine-loop',
      type: 'model.patch',
      ops: [{ op: 'part.set', part: { id: 'try-it', name: 'Try it: 20 fake clients', plain: 'two give up after 1 s', note: 'Changed by your note: 20 clients, not 50, and two give up after 1 s.' } }],
    } as unknown as BoardEvent;
    const wake = Date.parse(seed.at(-1)!.at) + 1000;
    const good = checkRun(board, seed, [...seed, reopen, change, reply], transcript(wake));
    expect(good.checks.filter((c) => !c.ok)).toEqual([]);
    expect(good.ok).toBe(true);
    // A reopen with the card but no change to the part fails: "it now includes your change" would be a lie.
    const unchanged = checkRun(board, seed, [...seed, reopen, { ...reply, id: 'e67' } as BoardEvent], transcript(wake));
    expect(unchanged.ok).toBe(false);
    expect(unchanged.checks.find((c) => c.name === 'part try-it says the change')?.ok).toBe(false);
    const bad = checkRun(board, seed, [...seed, { ...reply, id: 'e66' } as BoardEvent], transcript(wake));
    expect(bad.ok).toBe(false);
    expect(bad.checks.find((c) => c.name === 'part try-it is reopened because of note-change')?.ok).toBe(false);
  });

  it('a mark left open fails the run and is named', () => {
    // Drop the agent's reply to the question on B.
    const r = run('b', (evs) => evs.filter((e) => !(e.type === 'item.add' && e.item.id === 'reply-line')).map(renumber(26)));
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'every open thing is answered')).toMatchObject({ ok: false, detail: 'still open: note-http, arrow-http' });
    expect(r.answered['note-http']).toBeNull();
  });

  it('a placeholder never finished fails the run, and so does a missing kind', () => {
    const r = run('d', (evs) =>
      evs.map((e) => (e.type === 'item.add' && e.item.kind === 'picture' ? { ...e, item: { ...e.item, status: 'drawing' as const } } : e)),
    );
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'no placeholder is left drawing')).toMatchObject({ ok: false, detail: 'focus' });
    expect(r.checks.find((c) => c.name === 'the picture kinds expected')?.ok).toBe(false);
    expect(report(r)).toContain('BOARD d · FAIL');
  });

  it('a pick with no model patch fails', () => {
    const r = run('c', (evs) => evs.filter((e) => e.type !== 'model.patch'));
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === 'the model is patched')?.ok).toBe(false);
  });
});

/** Number events again from `after + 1`, as a log with an event taken out would be. */
function renumber(after: number) {
  let n = after;
  return (e: BoardEvent): BoardEvent => ({ ...e, id: `e${++n}` });
}
