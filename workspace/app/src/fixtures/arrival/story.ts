import type { Actor, BoardEvent, BoardState, Box, Checkpoint, Id, PictureSpec } from '@keel/protocol';
import { admit, emptyState, formatEvent } from '@keel/protocol';
import { shownBoxOf } from '../../layout';
import type { Size } from '../../place';
import { place } from '../../place';

/**
 * The arrival fixture: the first scene of the agent's motion, one checkpoint per step so each
 * step can be played alone (`?fixture=arrival&at=<n>&play=1`).
 *
 * 1. A blank board. The owner writes a note; the agent answers with a text card.
 * 2. The owner writes a second note; the agent answers with a mini.
 * 3. The owner pins a remark on the mini; the agent answers in words only.
 * 4. The owner asks for options; the agent posts a spread of three approaches, from the mini.
 * 5. The agent posts a placeholder, then finishes it.
 * 6. The agent redraws its first text card.
 *
 * Every event goes through the protocol's own `admit`, so the log is one the board accepts. The
 * owner's page places each picture the moment it arrives, as it does on a live board, with the
 * app's own `place()` and the sizes the pictures are drawn at (`SIZES`), so a played board is
 * laid out as the live app would lay it out. Build it with `build.ts`.
 */

export const START = '2026-11-20T10:00:00Z';
const CH = 'reminders';

/**
 * The size each picture is drawn at, in board units, as measured on the system Chrome at 100%
 * once the board's fonts are in: the fixture was opened with no placements, and the boxes the
 * page placed the pictures at were read back. Measure again when a renderer's layout changes.
 */
export const SIZES: Readonly<Record<string, Size>> = {
  read: [380, 152],
  path: [540, 100],
  ways: [1124, 532],
  plan: [588, 367],
};

const lanesOf = (steps: Array<[id: string, lane: 'clock' | 'svc' | 'mail', text: string]>) => ({
  lanes: [
    { id: 'clock', name: 'Clock' },
    { id: 'svc', name: 'Reminder service' },
    { id: 'mail', name: 'Mail' },
  ],
  steps: steps.map(([id, lane, text], i) => ({ id, lane, text, n: i + 1 })),
});

/** The pictures of the scene. */
const PICTURES = {
  read: {
    kind: 'text',
    title: 'How I read it',
    body: 'A small service that knows when each bill is due, and sends one reminder a few days before.',
    questions: ['By email only, or by text as well?', 'How many days before?'],
  },
  path: {
    kind: 'mini',
    title: 'A bill, a queue, then the mail',
    boxes: [{ text: 'bill due soon' }, { text: 'reminder queue', tone: 'blue' }, { text: 'mailer' }, { text: 'their inbox' }],
  },
  ways: {
    kind: 'spread',
    title: 'Three ways to send them',
    request: 'a bill is due on the 14th',
    lean: 'A',
    approaches: [
      {
        title: 'One check a day',
        ...lanesOf([
          ['tick', 'clock', 'Wakes at 8:00'],
          ['scan', 'svc', 'Finds bills due in 3 days'],
          ['send', 'mail', 'Sends one reminder each'],
        ]),
        risk: 'A bill added late in the day waits until tomorrow',
      },
      {
        title: 'A timer per bill',
        ...lanesOf([
          ['set', 'svc', 'Sets a timer when the bill comes'],
          ['ring', 'clock', 'Rings 3 days before'],
          ['send', 'mail', 'Sends the reminder'],
        ]),
        risk: 'Timers are lost when the service restarts',
      },
      {
        title: 'The mail schedules it',
        ...lanesOf([
          ['hand', 'svc', 'Hands the reminder over at once'],
          ['hold', 'mail', 'Holds it until 3 days before'],
          ['send', 'mail', 'Sends it'],
        ]),
        risk: 'A changed due date is hard to take back',
      },
    ],
  },
  planDrawing: {
    kind: 'lanes',
    title: 'One check a day, in full',
    ...lanesOf([['tick', 'clock', 'Wakes at 8:00']]),
  },
  plan: {
    kind: 'lanes',
    title: 'One check a day, in full',
    ...lanesOf([
      ['tick', 'clock', 'Wakes at 8:00'],
      ['scan', 'svc', 'Finds bills due in 3 days'],
      ['mark', 'svc', 'Marks each one as reminded'],
      ['send', 'mail', 'Sends one reminder each'],
    ]),
    flows: [
      { from: 'tick', to: 'scan' },
      { from: 'scan', to: 'mark' },
      { from: 'mark', to: 'send', label: 'one per bill' },
    ],
    risk: 'A bill added late in the day waits until tomorrow',
  },
  reread: {
    kind: 'text',
    title: 'How I read it now',
    body: 'A small service that checks once a day for bills due in three days, and sends each one reminder by email.',
    points: ['One check a day, at 8:00', 'One reminder per bill, never two'],
    questions: ['By text as well, later?'],
  },
} satisfies Record<string, PictureSpec>;

/** One step of the story, as the generator walks it. */
type Beat =
  /** A draft, or a function that makes it from the board as it is by then. */
  | { by: Actor; s: number; draft: Record<string, unknown> | (() => Record<string, unknown>) }
  /** The owner's page places this picture, as it does the moment a picture arrives. */
  | { place: Id; s: number }
  | { checkpoint: Omit<Checkpoint, 'after'> };

const note = (id: Id, box: Box, text: string, rot = 0) => ({ type: 'item.add', chapter: CH, item: { id, kind: 'note', box, text, ...(rot ? { rot } : {}) } });
const picture = (id: keyof typeof PICTURES & Id, extra: Record<string, unknown>) => ({ type: 'item.add', chapter: CH, item: { id, kind: 'picture', picture: PICTURES[id], ...extra } });
const checkpoint = (screen: number, name: string, title: string): Beat => ({
  checkpoint: { screen, name, title, view: { mode: 'board', presence: { state: 'listening' } } },
});

/** The pin's point on the mini: a little right of its middle, as shares of its box. */
const PIN_AT: readonly [number, number] = [0.42, 0.62];

/** The story, in seconds from the board's opening. */
function beats(boxOf: (id: Id) => Box | undefined): Beat[] {
  return [
    { by: 'system', s: 0, draft: { type: 'board.open', name: 'Reminders' } },
    { by: 'owner', s: 4, draft: { type: 'chapter.open', chapter: CH, title: 'Bill reminders' } },
    { by: 'owner', s: 12, draft: note('n-idea', [0, 40, 320, 84], 'I want a small service that reminds people of a bill a few days before it is due.', -0.6) },
    { by: 'agent', s: 16, draft: picture('read', { answers: ['n-idea'] }) },
    { place: 'read', s: 16.2 },
    checkpoint(1, 'read', 'You write a note, and the agent answers with a card'),

    { by: 'owner', s: 31, draft: note('n-how', [0, 380, 320, 60], 'how does a reminder get to them?', 0.5) },
    { by: 'agent', s: 35, draft: picture('path', { answers: ['n-how'] }) },
    { place: 'path', s: 35.2 },
    checkpoint(2, 'mini', 'A second note, and the agent answers with a small drawing'),

    {
      by: 'owner',
      s: 47,
      // A pin is drawn on the thing under the pointer, and hangs on where that thing is then.
      draft: () => {
        const mini = boxOf('path')!;
        const at: [number, number] = [Math.round(mini[0] + mini[2] * PIN_AT[0]), Math.round(mini[1] + mini[3] * PIN_AT[1])];
        return { type: 'item.add', chapter: CH, item: { id: 'pin-queue', kind: 'pin', box: [at[0], at[1], 0, 0], at: [0, 0], on: { item: 'path' }, text: 'why a queue here?', anchor: { item: 'path', box: mini } } };
      },
    },
    { by: 'agent', s: 52, draft: { type: 'answer', answers: ['pin-queue'], read: 'You ask why the queue: so a slow mailer never holds up the check for bills that are due.' } },
    checkpoint(3, 'answer', 'A remark pinned on the drawing, answered in words'),

    { by: 'owner', s: 66, draft: note('n-ways', [0, 640, 320, 60], 'show me a few ways to do it', -0.4) },
    { by: 'agent', s: 72, draft: picture('ways', { answers: ['n-ways'], from: ['path'] }) },
    { place: 'ways', s: 72.2 },
    checkpoint(4, 'spread', 'You ask for options, and the agent lays out three'),

    { by: 'agent', s: 80, draft: { type: 'item.add', chapter: CH, item: { id: 'plan', kind: 'picture', picture: PICTURES.planDrawing, place: { near: 'ways', side: 'below' }, from: ['ways'], status: 'drawing' } } },
    { by: 'agent', s: 86, draft: { type: 'item.update', item: 'plan', patch: { picture: PICTURES.plan, status: 'done' } } },
    { place: 'plan', s: 86.2 },
    checkpoint(5, 'placeholder', 'The agent puts down a placeholder, then finishes it'),

    { by: 'agent', s: 96, draft: { type: 'item.update', item: 'read', patch: { picture: PICTURES.reread } } },
    checkpoint(6, 'redraw', 'The agent redraws its first card'),
  ];
}

export interface Built {
  events: BoardEvent[];
  checkpoints: Checkpoint[];
  /** `log.jsonl`: one event per line. */
  log: string;
  /** `checkpoints.json`. */
  checkpointsJson: string;
}

/** The whole fixture in memory. Throws at the first event the rules refuse. */
export function buildArrival(): Built {
  let state: BoardState = emptyState();
  const events: BoardEvent[] = [];
  const checkpoints: Checkpoint[] = [];
  // Where each item is drawn, as the app's placement sees it: no sub is measured here, and no
  // mark of this story hangs on one.
  const boxOf = (id: Id) => shownBoxOf({ state, boxes: new Map(), subs: new Map() }, id);
  const at = (s: number) => new Date(Date.parse(START) + s * 1000).toISOString();
  const post = (by: Actor, draft: unknown, s: number) => {
    const r = admit(state, draft, by, at(s));
    if (!r.ok) throw new Error(`${by} ${(draft as { type?: string }).type} at ${s} s refused under ${r.rule}: ${r.reason}`);
    state = r.state;
    events.push(r.event);
  };
  for (const beat of beats(boxOf)) {
    if ('checkpoint' in beat) checkpoints.push({ ...beat.checkpoint, after: events[events.length - 1]!.id });
    else if ('place' in beat) post('owner', { type: 'item.place', item: beat.place, box: place(state, beat.place, SIZES[beat.place]!, boxOf) }, beat.s);
    else post(beat.by, typeof beat.draft === 'function' ? beat.draft() : beat.draft, beat.s);
  }
  return {
    events,
    checkpoints,
    log: events.map(formatEvent).join('\n') + '\n',
    checkpointsJson: JSON.stringify(checkpoints, null, 2) + '\n',
  };
}
