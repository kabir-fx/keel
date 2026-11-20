import type { BoardEvent, BoardState, PictureKind, PictureSpec } from '@keel/protocol';
import { PictureSpec as PictureSchema, audit, checkPicture, emptyState, isAnswered, openThings, pictureAnswers, pictureTitle, replay } from '@keel/protocol';
import type { BoardSpec, Want } from './boards';

/**
 * What a recorded board's run is judged on, from the board log and the agent's transcript:
 * every open thing answered, the picture kinds expected, every picture within the rules, the
 * seconds from the wake to the first and the last picture, and the tokens and cost of the turn.
 * Pure: the runner and the tests both call it.
 */

/** One line of the hosted link's transcript: a stream line with the time it came, or a wake. */
export interface TranscriptLine {
  t: number;
  keel?: 'wake' | 'turn' | 'turn-cost';
  /** For a `turn-cost` line: what that one turn cost. */
  usd?: number;
  text?: string;
  type?: string;
  subtype?: string;
  model?: string;
  tools?: string[];
  is_error?: boolean;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: Usage;
  message?: { id?: string; usage?: Usage; content?: Array<Record<string, unknown>> };
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface PictureOut {
  id: string;
  kind: PictureKind;
  title: string;
  status: 'drawing' | 'done';
  answers: string[];
  from: string[];
  spec: PictureSpec;
}

export interface ToolCall {
  s: number;
  name: string;
  error?: string;
}

export interface RunResult {
  board: BoardSpec['id'];
  ok: boolean;
  checks: Check[];
  /** The open things the agent was woken for, and the event that answered each. */
  answered: Record<string, string | null>;
  pictures: PictureOut[];
  numbers: {
    pictures: number;
    /** Seconds from the wake to the first picture the owner sees (a placeholder counts). */
    firstPicture?: number;
    /** Seconds from the wake to the first finished picture. */
    firstDone?: number;
    lastPicture?: number;
    turnSeconds?: number;
    apiCalls?: number;
    /** The context of the first model call at the wake: system prompt, tools and the digest. */
    contextAtWake?: number;
    inputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    refusals: number;
    model?: string;
  };
  tools: ToolCall[];
  refusals: string[];
  questions: number;
}

const BOARD_TOOL = /^mcp__board__/;

const sum = (u: Usage | undefined) => (u ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) : 0);

function wantText(w: Want): string {
  return typeof w === 'string' ? w : w.join(' or ');
}

/** Judge one run. `seed` is the log the board started from; `log` is the log after the turn. */
export function checkRun(board: BoardSpec, seed: readonly BoardEvent[], log: readonly BoardEvent[], transcript: readonly TranscriptLine[]): RunResult {
  const checks: Check[] = [];
  const cutSeq = seed.length;
  const before: BoardState = replay([...seed]);
  const after = log.slice(cutSeq);
  const { state, problems } = audit(log, emptyState());

  // The seed is kept as it was.
  // The last moves were posted live, so their time is the server's: compare all but the time.
  const noTime = (e: BoardEvent | undefined) => (e ? JSON.stringify({ ...e, at: '' }) : '');
  const kept = log.slice(0, cutSeq).every((e, i) => noTime(e) === noTime(seed[i]));
  checks.push({ name: 'the seed is untouched', ok: kept && log.length >= cutSeq });

  // Every open thing answered.
  const wasOpen = openThings(before).map((o) => o.id);
  // An event that answered for good, or the finished picture on the board that answers it now.
  const answered: Record<string, string | null> = {};
  const byPicture = pictureAnswers(state);
  for (const id of wasOpen) {
    const pic = byPicture.get(id);
    answered[id] = state.answered[id] ?? (isAnswered(state, id, byPicture) && pic !== undefined ? `e${pic}` : null);
  }
  const stillOpen = openThings(state).map((o) => o.id);
  checks.push({
    name: 'every open thing is answered',
    ok: stillOpen.length === 0,
    detail: stillOpen.length ? `still open: ${stillOpen.join(', ')}` : `${wasOpen.length} answered`,
  });

  // The rules, replayed on the whole log.
  checks.push({
    name: 'every event passes the rules',
    ok: problems.length === 0,
    detail: problems.length ? problems.map((p) => `${p.id} ${p.rule}: ${p.reason}`).join('; ') : undefined,
  });

  // The agent's pictures, as they stand at the end.
  const ids: string[] = [];
  for (const ev of after) {
    if (ev.by === 'agent' && ev.type === 'item.add' && ev.item.kind === 'picture' && !ids.includes(ev.item.id)) ids.push(ev.item.id);
  }
  const pictures: PictureOut[] = [];
  const bad: string[] = [];
  for (const id of ids) {
    const s = state.items[id];
    if (!s || s.item.kind !== 'picture') continue;
    const it = s.item;
    pictures.push({
      id,
      kind: it.picture.kind,
      title: pictureTitle(it.picture),
      status: it.status ?? 'done',
      answers: it.answers ?? [],
      from: it.from ?? [],
      spec: it.picture,
    });
    const parsed = PictureSchema.safeParse(it.picture);
    const v = parsed.success ? checkPicture(state, parsed.data) : { ok: false as const, reason: parsed.error.message };
    if (!v.ok) bad.push(`${id}: ${v.reason}`);
  }
  checks.push({ name: 'every picture passes the grammar and the rules', ok: bad.length === 0, detail: bad.join('; ') || undefined });

  const drawing = pictures.filter((p) => p.status === 'drawing').map((p) => p.id);
  checks.push({ name: 'no placeholder is left drawing', ok: drawing.length === 0, detail: drawing.join(', ') || undefined });

  const done = pictures.filter((p) => p.status === 'done');
  const missing = board.kinds.filter((w) => !done.some((p) => (typeof w === 'string' ? p.kind === w : w.includes(p.kind))));
  checks.push({
    name: 'the picture kinds expected',
    ok: missing.length === 0,
    detail: `want ${board.kinds.map(wantText).join(', ')}; got ${done.map((p) => p.kind).join(', ') || 'none'}${missing.length ? `; missing ${missing.map(wantText).join(', ')}` : ''}`,
  });

  if (board.model) {
    const patched = after.some((e) => e.by === 'agent' && e.type === 'model.patch');
    checks.push({ name: 'the model is patched', ok: patched });
  }

  // Screens 5 and 6: the read-back waits, "Build this" gets one card, a changing mark reopens.
  if (board.still) {
    const moved = after.filter((e) => e.type === 'part.state' && (e.state === 'building' || e.state === 'built'));
    checks.push({ name: 'nothing moves toward built', ok: moved.length === 0, detail: moved.map((e) => `${e.id} ${e.by}`).join(', ') || undefined });
  }
  if (board.blueprint) {
    const bp = done.find((p) => p.spec.kind === 'blueprint');
    const spec = bp?.spec.kind === 'blueprint' ? bp.spec : undefined;
    const notSolid = (spec?.parts ?? []).filter((id) => state.model.parts[id]?.state !== 'solid');
    checks.push({
      name: 'the blueprint names a check and solid parts',
      ok: spec !== undefined && (spec.check ?? '').trim().length > 0 && notSolid.length === 0,
      detail: spec ? `check "${spec.check ?? ''}", ${spec.parts.length} parts${notSolid.length ? `; not solid: ${notSolid.join(', ')}` : ''}` : 'no blueprint',
    });
  }
  if (board.card) {
    const card = done.find((p) => p.kind === 'text' && p.answers.includes(board.card!));
    checks.push({ name: `a text card answers ${board.card}`, ok: card !== undefined, detail: card ? `"${card.title}"` : undefined });
  }
  if (board.reopen) {
    const { part, because } = board.reopen;
    const ev = after.find((e) => e.by === 'agent' && e.type === 'part.state' && e.part === part && e.state === 'idea' && (e.because ?? []).includes(because));
    checks.push({ name: `part ${part} is reopened because of ${because}`, ok: ev !== undefined && state.model.parts[part]?.state === 'idea', detail: ev?.id });
    // The change shows on the part itself: its plain words or its note, changed after the reopen.
    const was = before.model.parts[part];
    const now = state.model.parts[part];
    const changed = now !== undefined && (now.plain !== was?.plain || now.note !== was?.note || now.name !== was?.name);
    checks.push({ name: `part ${part} says the change`, ok: changed, detail: now ? `"${now.name}": ${now.plain ?? ''}${now.note ? ` · note: ${now.note}` : ''}` : undefined });
  }

  const questions = done.reduce((n, p) => n + (p.spec.kind === 'text' ? (p.spec.questions?.length ?? 0) : 0), 0);
  checks.push({ name: 'at most three questions', ok: questions <= 3, detail: `${questions}` });

  // Times, from the wake.
  const wake = transcript.find((l) => l.keel === 'wake');
  const t0 = wake?.t;
  const secs = (at: string) => (t0 === undefined ? undefined : Math.round((Date.parse(at) - t0) / 100) / 10);
  const picEvents = after.filter(
    (e) => e.by === 'agent' && ((e.type === 'item.add' && e.item.kind === 'picture') || (e.type === 'item.update' && e.patch.picture !== undefined)),
  );
  const firstDoneEv = picEvents.find((e) => (e.type === 'item.add' ? e.item.kind === 'picture' && e.item.status !== 'drawing' : true));

  // The turn, from the transcript.
  const result = [...transcript].reverse().find((l) => l.type === 'result');
  const init = transcript.find((l) => l.type === 'system' && l.subtype === 'init');
  const calls = new Map<string, Usage | undefined>();
  for (const l of transcript) {
    if (l.type === 'assistant' && l.message?.id && !calls.has(l.message.id)) calls.set(l.message.id, l.message.usage);
  }
  const firstUsage = [...calls.values()][0];

  const tools: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  const refusals: string[] = [];
  for (const l of transcript) {
    for (const c of l.message?.content ?? []) {
      if (l.type === 'assistant' && c.type === 'tool_use') {
        const call: ToolCall = { s: t0 === undefined ? 0 : Math.round((l.t - t0) / 100) / 10, name: String(c.name).replace(BOARD_TOOL, '') };
        tools.push(call);
        byId.set(String(c.id), call);
      }
      if (l.type === 'user' && c.type === 'tool_result' && c.is_error === true) {
        const call = byId.get(String(c.tool_use_id));
        const body = Array.isArray(c.content) ? c.content.map((x: { text?: string }) => x.text ?? '').join(' ') : String(c.content ?? '');
        if (call) call.error = body.slice(0, 300);
        if (call?.name.startsWith('board_')) refusals.push(`${call.name}: ${body.slice(0, 300)}`);
      }
    }
  }

  checks.push({ name: 'the turn ended without an error', ok: result !== undefined && result.is_error !== true });

  const numbers: RunResult['numbers'] = {
    pictures: pictures.length,
    firstPicture: picEvents[0] ? secs(picEvents[0].at) : undefined,
    firstDone: firstDoneEv ? secs(firstDoneEv.at) : undefined,
    lastPicture: picEvents.length ? secs(picEvents[picEvents.length - 1]!.at) : undefined,
    turnSeconds: result && t0 !== undefined ? Math.round((result.t - t0) / 100) / 10 : undefined,
    apiCalls: calls.size,
    contextAtWake: firstUsage ? sum(firstUsage) : undefined,
    inputTokens: result?.usage?.input_tokens,
    cacheReadTokens: result?.usage?.cache_read_input_tokens,
    cacheWriteTokens: result?.usage?.cache_creation_input_tokens,
    outputTokens: result?.usage?.output_tokens,
    // The turn's own cost, as the link worked it out; else the stream's running total.
    costUsd: [...transcript].reverse().find((l) => l.keel === 'turn-cost')?.usd ?? result?.total_cost_usd,
    refusals: refusals.length,
    model: init?.model,
  };

  // "ok" is what the brief asks of a run: every open thing answered with pictures of the expected kinds.
  const must = [
    'the seed is untouched',
    'every open thing is answered',
    'every event passes the rules',
    'every picture passes the grammar and the rules',
    'the picture kinds expected',
    'the model is patched',
    'no placeholder is left drawing',
    'nothing moves toward built',
    'the blueprint names a check and solid parts',
  ];
  const ok = checks.filter((c) => must.includes(c.name) || c.name.startsWith('a text card answers') || c.name.startsWith('part ')).every((c) => c.ok);
  return { board: board.id, ok, checks, answered, pictures, numbers, tools, refusals, questions };
}

/** The run as a few lines a person reads: the checks, the numbers, then every picture in full. */
export function report(r: RunResult): string {
  const n = r.numbers;
  const lines = [
    `BOARD ${r.board} · ${r.ok ? 'PASS' : 'FAIL'}${n.model ? ` · ${n.model}` : ''}`,
    ...r.checks.map((c) => `  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` (${c.detail})` : ''}`),
    `  pictures ${n.pictures} · first ${n.firstPicture ?? '-'} s · first finished ${n.firstDone ?? '-'} s · last ${n.lastPicture ?? '-'} s · turn ${n.turnSeconds ?? '-'} s`,
    `  context at wake ${n.contextAtWake ?? '-'} · calls ${n.apiCalls ?? '-'} · in ${n.inputTokens ?? '-'} · cache read ${n.cacheReadTokens ?? '-'} · cache write ${n.cacheWriteTokens ?? '-'} · out ${n.outputTokens ?? '-'} · $${n.costUsd?.toFixed(4) ?? '-'}`,
    `  refusals ${n.refusals}${r.refusals.length ? `: ${r.refusals.join(' | ')}` : ''}`,
    `  tools ${r.tools.map((t) => `${t.s}s ${t.name}${t.error ? ' (error)' : ''}`).join(' · ')}`,
    '  answered:',
    ...Object.entries(r.answered).map(([k, v]) => `    ${k} ← ${v ?? 'NOT ANSWERED'}`),
    '',
    ...r.pictures.flatMap((p) => [
      `${p.id} ${p.kind} "${p.title}" [${p.status}] answers ${p.answers.join(' ') || '-'}${p.from.length ? ` from ${p.from.join(' ')}` : ''}`,
      JSON.stringify(p.spec, null, 1),
      '',
    ]),
  ];
  return lines.join('\n');
}
