import type { BoardEvent, Id, PictureKind, PresenceUpdate } from '@keel/protocol';
import { EventId, isAct } from '@keel/protocol';

/**
 * The script of a played fixture: when each recorded event reaches the board, and what the
 * agent's presence says in between, timed the way a live board would time them, so a film of it
 * is honest. Pure: the same log and range always give the same script. No random, no clock.
 *
 * - The owner's events keep their order and the gaps the log has between them, within bounds.
 * - After the owner's last input before the agent's turn, the agent is woken as the server
 *   wakes it (`server/src/wake.ts`): after the quiet time that input asks for, with the pill on
 *   "reading your marks" and the cursor on the newest mark.
 * - The model then writes its call, and presence follows it as the link reports it
 *   (`followCall` in plugin/src/hosted-link.ts, `writingPresence` and `toolPresence` in
 *   plugin/src/presence.ts): when the call begins, what the tool does and no place; for a post,
 *   the kind of its first picture as soon as that is written; when the call is whole, the same
 *   words and the cursor on what it answers. A moment later its events land, with the
 *   placements of the pictures it posts.
 * - When the agent's turn is over, the pill goes back to listening.
 * - The system's events (a build) come at their own spacing, with no presence of the agent.
 *
 * Server and plugin code are mirrored here, not imported: the page is not built with them.
 */

/** One moment of a play. */
export interface PlayStep {
  /** When, in ms from the start of the play. Never earlier than the step before. */
  at: number;
  /** Recorded events, handed to the board together. */
  events?: BoardEvent[];
  /** What the agent is doing from this moment. */
  presence?: PresenceUpdate;
}

/** The first step comes this long after the play starts, so a play opens on the board as it was. */
export const LEAD = 600;
/** The gap between two of the owner's events: as in the log, but within these bounds. */
export const OWNER_GAP = { min: 400, max: 2400 } as const;
/** The gap before an event of the system: as in the log, but within these bounds. */
export const SYSTEM_GAP = { min: 300, max: 1500 } as const;
/** Two events of the agent further apart than this in the log came with two calls. */
export const ONE_CALL = 1500;
/** The model writes its call: from the wake, or from the call before, until the call is whole. */
export const WRITING = 2000;
/** The model begins to write its call this long after the wake, or after the call before. */
export const CALL_BEGINS = 500;
/** A post's first picture has its kind written this long after the call begins. */
export const KIND_WRITTEN = 200;
/** From the link seeing the whole call to the call's events landing on the board. */
export const CALL_LANDS = 100;
/** From the agent's last call to the end of its turn. */
export const TURN_ENDS = 600;

/** Mirrors `QUIET_SHORT` in server/src/wake.ts: quiet time after a note, a spoken remark, a file or an act. */
export const QUIET_SHORT = 300;
/** Mirrors `QUIET_LONG` in server/src/wake.ts: quiet time after a stroke-like mark. */
export const QUIET_LONG = 1500;
/** Mirrors `WAKE_PRESENCE` in server/src/wake.ts: what the pill says as a wake starts. */
export const WAKE_NOTE = 'reading your marks';

/** Mirrors `quietAfter` in server/src/wake.ts: the quiet time an event asks for, or undefined when it wakes nobody. */
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
      default:
        return undefined;
    }
  }
  if (isAct(ev)) return QUIET_SHORT;
  if (ev.type === 'item.update' && ev.patch.text !== undefined) return QUIET_SHORT;
  return undefined;
}

/** The mark an input of the owner's names, when it names one: the one the wake points the cursor at. */
function markOf(ev: BoardEvent): Id | undefined {
  if (ev.type === 'item.add' && ev.item.kind !== 'picture') return ev.item.id;
  if (ev.type === 'item.update') return ev.item;
  return undefined;
}

/** An item the cursor can sit on: an item id, not an act's event id. As `itemId` in plugin/src/presence.ts. */
const itemIn = (ids: readonly Id[] | undefined): Id | undefined => ids?.find((id) => !EventId.safeParse(id).success);

/** The tool behind an event of the agent's: the one the link names the call by. */
type Tool = 'board_post' | 'board_answer' | 'board_model' | 'board_part' | 'board_update';

function toolOf(ev: BoardEvent): Tool | undefined {
  switch (ev.type) {
    case 'item.add':
    case 'item.update':
      return 'board_post';
    case 'answer':
      return 'board_answer';
    case 'model.patch':
      return 'board_model';
    case 'part.state':
      return 'board_part';
    case 'feed.add':
      return 'board_update';
    default:
      return undefined;
  }
}

/** Mirrors `NOTES` in plugin/src/presence.ts: what each board tool does, in the pill's words. */
const NOTES: Record<Tool, string> = {
  board_post: 'drawing',
  board_answer: 'answering',
  board_model: 'drawing the model',
  board_part: 'moving a part',
  board_update: 'writing an update',
};

/** Mirrors `KIND_NOTES` in plugin/src/presence.ts: what a post says once its first picture's kind is written. */
export const KIND_NOTES: Record<PictureKind, string> = {
  text: 'drawing a card',
  shelf: 'drawing a shelf',
  lanes: 'drawing lanes',
  spread: 'drawing a spread',
  mini: 'drawing a small picture',
  pipeline: 'drawing a pipeline',
  walk: 'drawing a walk',
  focus: 'drawing a focus',
  blueprint: 'drawing a blueprint',
  choice: 'drawing a choice',
  free: 'drawing a free drawing',
};

/** The kind of the picture a post's event draws, when it draws one: a new picture, or a new spec. */
function kindOf(ev: BoardEvent): PictureKind | undefined {
  if (ev.type === 'item.add' && ev.item.kind === 'picture') return ev.item.picture.kind;
  if (ev.type === 'item.update') return ev.patch.picture?.kind;
  return undefined;
}

/** Where a call puts the cursor: on what it redraws, else on what it answers, else beside what it is placed near. */
function cursorOf(ev: BoardEvent): Id | undefined {
  if (ev.type === 'item.update') return ev.item;
  if (ev.type === 'item.add' && ev.item.kind === 'picture') return itemIn(ev.item.answers) ?? ev.item.place?.near;
  if (ev.type === 'answer') return itemIn(ev.answers);
  return undefined;
}

/** What the link reports for one call, read from the events the call made. */
export interface CallPresence {
  /** As the model begins to write it: what the tool does. Never a place. */
  begins: PresenceUpdate;
  /** For a post, once its first picture's kind is written. Never a place. */
  kind?: PresenceUpdate;
  /** When the call is whole: the same words, and the cursor on what it answers. */
  whole: PresenceUpdate;
}

/** As `writingPresence` and `toolPresence` in plugin/src/presence.ts report one call. */
export function callPresence(events: readonly BoardEvent[]): CallPresence {
  const own = events.filter((e) => e.by === 'agent');
  // A post puts its rename and its model patch before its pictures (`postDrafts` in
  // plugin/src/tools.ts): a call that draws a picture is a post, whatever comes first in it.
  const tools = own.map(toolOf);
  const tool = tools.includes('board_post') ? 'board_post' : tools.find((t) => t !== undefined);
  if (!tool) return { begins: { state: 'drawing' }, whole: { state: 'drawing' } };
  const mine = own.filter((e) => toolOf(e) === tool);
  const kind = tool === 'board_post' ? kindOf(mine[0]!) : undefined;
  const note = kind ? KIND_NOTES[kind] : NOTES[tool];
  // A call of one tool: the cursor goes on the first of its events that names a place.
  const item = mine.map(cursorOf).find((i) => i !== undefined);
  return {
    begins: { state: 'drawing', note: NOTES[tool] },
    ...(kind ? { kind: { state: 'drawing', note } } : {}),
    whole: { state: 'drawing', note, ...(item ? { cursor: { item } } : {}) },
  };
}

const ms = (iso: string) => Date.parse(iso);
const within = (n: number, b: { min: number; max: number }) => Math.min(b.max, Math.max(b.min, n));

/**
 * The script for `log[from]` up to, not including, `log[to]`. The events before `from` are on
 * the board when the play starts.
 */
export function playScript(log: readonly BoardEvent[], from = 0, to: number = log.length): PlayStep[] {
  const steps: PlayStep[] = [];
  /** When the latest step happens. */
  let t = 0;
  /** The owner's latest input that wakes the agent, since its last turn: when it came, and the quiet it asks for. */
  let waking: { at: number; quiet: number } | undefined;
  /** The newest mark of the owner's since the agent's last turn. */
  let newest: Id | undefined;
  /** Each call of the agent's: the steps where the link reports it as it is written, and the step where its events land. */
  const calls: Array<{ begins: PlayStep; kind: PlayStep; whole: PlayStep; landed: PlayStep & { events: BoardEvent[] } }> = [];
  /** The agent's turn under way: its latest call, and when that call's latest event was logged. */
  let turn: { call: (typeof calls)[number]; logged: number } | undefined;

  const after = (gap: number) => (steps.length === 0 ? LEAD : t + gap);
  const push = (step: PlayStep) => {
    steps.push(step);
    t = step.at;
  };
  /** A call the model starts to write at `writing`: from the wake, or from the call before. */
  const startCall = (ev: BoardEvent, writing: number) => {
    const call = {
      begins: { at: writing + CALL_BEGINS },
      kind: { at: writing + CALL_BEGINS + KIND_WRITTEN },
      whole: { at: writing + WRITING },
      landed: { at: writing + WRITING + CALL_LANDS, events: [ev] },
    };
    push(call.begins);
    push(call.kind);
    push(call.whole);
    push(call.landed);
    calls.push(call);
    turn = { call, logged: ms(ev.at) };
  };
  const endTurn = () => {
    if (!turn) return;
    push({ at: t + TURN_ENDS, presence: { state: 'listening' } });
    turn = undefined;
  };

  for (let i = from; i < Math.min(to, log.length); i++) {
    const ev = log[i]!;

    // A placement while the agent's turn is under way goes in with its latest call. On a live
    // board the page places a picture the moment it arrives, so the placement is logged right
    // after the call that posted it: handing both to the board together means the page never
    // sees the picture without a box, and never places it itself.
    if (turn && ev.type === 'item.place') {
      turn.call.landed.events.push(ev);
      continue;
    }

    if (ev.by === 'agent') {
      if (turn && ms(ev.at) - turn.logged <= ONE_CALL) {
        turn.call.landed.events.push(ev);
        turn.logged = ms(ev.at);
      } else if (turn) {
        startCall(ev, t);
      } else if (waking) {
        // The owner's input woke the agent: the wake comes first, when the server's would.
        const wake = Math.max(t, waking.at + waking.quiet);
        push({ at: wake, presence: { state: 'drawing', note: WAKE_NOTE, ...(newest ? { cursor: { item: newest } } : {}) } });
        startCall(ev, wake);
      } else {
        // The agent was awake already: its call begins after the lead, or after what came before.
        startCall(ev, steps.length === 0 ? LEAD - CALL_BEGINS : t);
      }
      waking = undefined;
      newest = undefined;
      continue;
    }

    endTurn();
    const gap = i > 0 ? ms(ev.at) - ms(log[i - 1]!.at) : 0;
    if (ev.by === 'owner') {
      push({ at: after(within(gap, OWNER_GAP)), events: [ev] });
      const quiet = quietAfter(ev);
      if (quiet !== undefined) {
        waking = { at: t, quiet };
        newest = markOf(ev) ?? newest;
      }
    } else {
      push({ at: after(within(gap, SYSTEM_GAP)), events: [ev] });
    }
  }
  endTurn();

  // What a call says is known once it is known what the call made. A call that is no post, or
  // whose first picture has no kind to name, says nothing more until it is whole.
  for (const call of calls) {
    const said = callPresence(call.landed.events);
    call.begins.presence = said.begins;
    call.whole.presence = said.whole;
    if (said.kind) call.kind.presence = said.kind;
  }
  return steps.filter((step) => step.events || step.presence);
}

/** How long a script runs: the time of its last step. */
export function lengthOf(script: readonly PlayStep[]): number {
  return script[script.length - 1]?.at ?? 0;
}
