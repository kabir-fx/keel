import type { Actor, Box, Checkpoint, EventDraft, Item, PictureSpec, Place } from '../../src';
import { ROADMAP_BYTES } from './assets';
import { CROSS, circleOf, inkAt, sketchStrokes } from './draw';

/**
 * The golden fixture: the seven storyboard screens (docs/private/mockups, Main to Story) as
 * one board log. One beat is one event, in the order things happen across the screens.
 * The words are the mockups' words. A text is shortened only where a schema limit forces it.
 */

type Dist<T> = T extends unknown ? Omit<T, 'by'> : never;

/** A draft with no `id`, no `at` and no `by`: the log owner stamps all three. */
export type Draft = Dist<EventDraft>;

export interface Beat {
  by: Actor;
  draft: Draft;
  /** Seconds after the previous beat. Default 2. */
  gap?: number;
  /** The end of a screen: what the owner was looking at after this event. */
  checkpoint?: Omit<Checkpoint, 'after'>;
}

export const story: Beat[] = [];

const CH = 'engine-loop';
const CH2 = 'api-server';

/** Seconds since 13:00:00 at the last beat. */
let clock = 0;

function post(by: Actor, draft: Draft, gap = 2, checkpoint?: Omit<Checkpoint, 'after'>): string {
  if (story.length > 0) clock += gap;
  story.push({ by, draft, ...(gap !== 2 ? { gap } : {}), ...(checkpoint ? { checkpoint } : {}) });
  return `e${story.length}`;
}

/** The gap that puts the next beat at 13:00 plus `min` minutes. */
function atMin(min: number): number {
  const gap = min * 60 - clock;
  if (gap < 2) throw new Error(`the story is already past minute ${min} (it is at ${clock} s)`);
  return gap;
}

const owner = (draft: Draft, gap?: number) => post('owner', draft, gap);
const agent = (draft: Draft, gap?: number) => post('agent', draft, gap);
const system = (draft: Draft, gap?: number) => post('system', draft, gap);

/* ------------------------------------------------------------- helpers */

/** What a mark made on a picture is drawn against: the thing, in its own 100 by 100 space. */
const on = (item: string, sub?: string) => ({ item, ...(sub ? { sub } : {}), box: [0, 0, 100, 100] as Box });

const target = (item: string, sub?: string) => ({ item, ...(sub ? { sub } : {}) });

/**
 * The helpers below give a mark's strokes, path, ends and point in the same space as its
 * box, because that is how the mockups draw them. The contract counts them from the box's
 * top-left corner, so `add` moves them there.
 */
const add = (chapter: string, item: Item): Draft => ({ type: 'item.add', chapter, item: local(item) });

function local(item: Item): Item {
  if (item.kind === 'picture') return item;
  const [x, y] = item.box;
  const shift = (pts: number[]) => pts.map((v, i) => Math.round((v - (i % 2 === 0 ? x : y)) * 10) / 10);
  switch (item.kind) {
    case 'ink':
      return { ...item, strokes: item.strokes.map((s) => ({ ...s, pts: shift(s.pts) })) };
    case 'lasso':
      return { ...item, path: shift(item.path) };
    case 'arrow':
      return { ...item, from: [item.from[0] - x, item.from[1] - y], to: [item.to[0] - x, item.to[1] - y] };
    case 'pin':
      return { ...item, at: [item.at[0] - x, item.at[1] - y] };
    default:
      return item;
  }
}

const pic = (
  chapter: string,
  id: string,
  picture: PictureSpec,
  rest: { place?: Place; answers?: string[]; from?: string[]; status?: 'drawing' | 'done' },
): Draft => add(chapter, { id, kind: 'picture', picture, ...rest });

const note = (id: string, text: string, box: Box, rest: { rot?: number; plain?: boolean; on?: { item: string; sub?: string }; anchor?: ReturnType<typeof on> } = {}): Draft =>
  add(CH, { id, kind: 'note', box, text, ...rest });

/** A circle or a cross the owner drew on a thing of a picture. */
const ink = (id: string, strokes: ReturnType<typeof circleOf>, hint: 'circle' | 'cross', item: string, sub: string | undefined, box: Box): Draft =>
  add(CH, { id, kind: 'ink', box, strokes, targets: [target(item, sub)], hint, anchor: on(item, sub) });

/** An arrow from one of the owner's notes to a thing of a picture, drawn in that thing's space. */
function arrow(id: string, noteId: string, item: string, sub: string, from: [number, number], to: [number, number]): Draft {
  const [x0, y0] = [Math.min(from[0], to[0]), Math.min(from[1], to[1])];
  return add(CH, {
    id,
    kind: 'arrow',
    box: [x0, y0, Math.abs(from[0] - to[0]), Math.abs(from[1] - to[1])],
    from,
    to,
    fromTarget: target(noteId),
    toTarget: target(item, sub),
    anchor: on(item, sub),
  });
}

/* ================================================================ 1 · A blank canvas */

system({ type: 'board.open', name: 'uLLM' });
owner({ type: 'chapter.open', chapter: CH, title: 'A new idea' }, 3);

owner(
  note(
    'n-first',
    'I want one engine that takes many requests at once and streams the text back to each one. Not sure yet how the pieces should talk.',
    [250, 230, 440, 180],
    { rot: -0.8 },
  ),
  20,
);
owner(
  add(CH, {
    id: 'drop-roadmap',
    kind: 'file',
    box: [262, 440, 340, 60],
    rot: 0.5,
    name: 'AGENT_ROADMAP.md',
    asset: 'assets/AGENT_ROADMAP.md',
    mime: 'text/markdown',
    size: ROADMAP_BYTES,
  }),
  25,
);
owner(
  add(CH, {
    id: 'sketch',
    kind: 'ink',
    box: [760, 210, 800, 380],
    strokes: sketchStrokes(),
    targets: [],
    hint: 'none',
    snapshot: 'assets/sketch.png',
  }),
  70,
);
// The owner's handwriting inside the sketch, as notes at the positions the mockup draws them.
owner(note('label-clients', 'lots of clients', [782, 238, 170, 34], { plain: true }), 8);
owner(note('label-engine', 'engine ??', [1101, 374, 170, 40], { plain: true }), 6);
owner(note('label-model', 'model', [1420, 378, 120, 34], { plain: true }), 5);
owner(note('label-waits', 'who waits for who?', [1052, 254, 230, 34], { rot: -3, plain: true }), 6);
owner(note('label-text-back', 'text back, a bit at a time', [912, 564, 330, 34], { plain: true }), 6);
system({ type: 'moment.add', chapter: CH, title: 'Your note and sketch', items: ['n-first', 'sketch'] });

story[story.length - 1]!.checkpoint = {
  screen: 1,
  name: 'main',
  title: 'A blank canvas. You write what you want and sketch it',
  view: {
    mode: 'board',
    show: ['n-first', 'drop-roadmap', 'sketch', 'label-clients', 'label-engine', 'label-model', 'label-waits', 'label-text-back'],
    presence: {
      state: 'listening',
      note: 'I can see many clients, a middle and a model. Keep going. I will draw when you pause.',
      cursor: { at: [1262, 600] },
    },
  },
};

/* ================================================================ 2 · The agent answers in pictures */

agent({ type: 'chapter.rename', chapter: CH, title: 'The engine loop' }, 20);

agent(
  pic(
    CH,
    'read',
    {
      kind: 'mini',
      title: 'How I read your sketch',
      boxes: [{ text: 'clients' }, { text: 'the middle ?', tone: 'blue' }, { text: 'model' }],
      caption: 'Many clients, one model, and a middle that takes turns. The model exists. The middle is what we design.',
    },
    { answers: ['sketch', 'label-clients', 'label-engine', 'label-model', 'label-waits', 'label-text-back'], from: ['n-first'], place: { near: 'sketch', side: 'right' } },
  ),
  6,
);

agent(
  pic(
    CH,
    'shelf',
    {
      kind: 'shelf',
      title: 'Already on the shelf',
      tiles: [
        { id: 'runner', name: 'Runner', plain: 'runs one step of the model', ref: 'pull request 11', state: 'built' },
        { id: 'stand-in', name: 'Stand-in model', plain: 'same plug as the Runner, no GPU needed', ref: 'pull request 11', state: 'built' },
        { id: 'stop-check', name: 'Stop check', plain: 'turns tokens into text and knows the end', ref: 'pull request 12', state: 'built' },
        { id: 'trace-checker', name: 'Trace checker', plain: 'finds a request that ended wrong', ref: 'from M0', state: 'built' },
      ],
    },
    { from: ['read'], place: { near: 'read', side: 'right' } },
  ),
  4,
);

agent(
  pic(
    CH,
    'spread',
    {
      kind: 'spread',
      title: 'A first spread to react to',
      request: 'a client posts “what is 2 + 2”',
      caption: 'Three ways the middle can work, each drawn for the same request: “what is 2 + 2”. Blue marks what differs. Circle, cross out, or draw on them.',
      approaches: [
        {
          title: 'The engine gets its own thread',
          lanes: [
            { id: 'api', name: 'API thread' },
            { id: 'queues', name: 'queues' },
            { id: 'engine-own', name: 'engine thread, its own' },
          ],
          steps: [
            { id: 'handler', lane: 'api', text: 'handler' },
            { id: 'tickets', lane: 'queues', text: 'tickets' },
            { id: 'scheduler', lane: 'engine-own', text: 'scheduler' },
            { id: 'model-step', lane: 'engine-own', text: 'model step' },
            { id: 'text', lane: 'queues', text: 'text' },
            { id: 'wakes', lane: 'api', text: 'handler wakes' },
          ],
          flows: [
            { from: 'handler', to: 'tickets' },
            { from: 'tickets', to: 'scheduler' },
            { from: 'scheduler', to: 'model-step' },
            { from: 'model-step', to: 'text' },
            { from: 'text', to: 'wakes' },
          ],
          caption: 'The model, the scheduler and the requests get a thread of their own. The server thread only passes notes.',
          risk: 'A new request can wait one full step.',
        },
        {
          title: 'No second thread for the engine',
          lanes: [
            { id: 'api', name: 'API thread', note: 'shares the server thread' },
            { id: 'helper', name: 'helper thread' },
          ],
          steps: [
            { id: 'handler', lane: 'api', text: 'handler' },
            { id: 'scheduler', lane: 'api', text: 'scheduler' },
            { id: 'model-step', lane: 'helper', text: 'model step' },
            { id: 'wakes', lane: 'api', text: 'handler wakes' },
          ],
          flows: [
            { from: 'handler', to: 'scheduler' },
            { from: 'scheduler', to: 'model-step' },
            { from: 'model-step', to: 'wakes' },
          ],
          caption: 'One thread less. Only the model step leaves the server thread.',
          risk: 'The scheduler shares that thread with every HTTP handler, and they slow each other.',
        },
        {
          title: 'A cap on the queue, as the roadmap says',
          lanes: [
            { id: 'api', name: 'API thread' },
            { id: 'queues', name: 'queues' },
            { id: 'engine', name: 'engine thread' },
          ],
          steps: [
            { id: 'handler', lane: 'api', text: 'handler' },
            { id: 'capped-tickets', lane: 'queues', text: 'tickets · max N' },
            { id: 'scheduler', lane: 'engine', text: 'scheduler' },
            { id: 'model-step', lane: 'engine', text: 'model step' },
            { id: 'text', lane: 'queues', text: 'text' },
            { id: 'wakes', lane: 'api', text: 'handler wakes' },
          ],
          flows: [
            { from: 'handler', to: 'capped-tickets', label: 'full: answers “busy”' },
            { from: 'capped-tickets', to: 'scheduler' },
            { from: 'scheduler', to: 'model-step' },
            { from: 'model-step', to: 'text' },
            { from: 'text', to: 'wakes' },
          ],
          caption: 'Like A, with a cap on the ticket queue. A full queue answers “busy”.',
          risk: 'The engine empties that queue every turn, so the cap rarely fires.',
        },
      ],
    },
    { answers: ['n-first', 'drop-roadmap'], from: ['read', 'shelf'], place: { near: 'read', side: 'below' } },
  ),
  5,
);

// The owner reacts: circles A, a note on the model step, an arrow, a note on B, a cross on B, a note on C.
owner(ink('circle-a', circleOf('M 300 8 C 480 4, 568 96, 566 212 C 564 332, 450 412, 284 410 C 112 408, 8 326, 10 206 C 12 88, 122 14, 316 10'), 'circle', 'spread', 'approach:a', [-6, -6, 112, 112]), 40);
owner(note('this-one', 'this one', [4, 104, 120, 40], { on: target('spread', 'approach:a'), anchor: on('spread', 'approach:a') }), 6);
owner(
  ink('circle-fake', circleOf('M 89 8 C 129 6, 148 18, 146 32 C 144 50, 119 57, 87 56 C 53 55, 31 46, 32 30 C 33 14, 59 8, 97 9'), 'circle', 'spread', 'step:a-model-step', [-6, -6, 112, 112]),
  14,
);
owner(
  note('note-fake', 'can this be a fake one? I want to try it with no GPU', [108, 8, 330, 92], {
    rot: -0.8,
    on: target('spread', 'step:a-model-step'),
    anchor: on('spread', 'step:a-model-step'),
  }),
  16,
);
owner(arrow('arrow-fake', 'note-fake', 'spread', 'step:a-model-step', [108, 52], [98, 30]), 4);
owner(
  note('note-http', 'so the scheduler fights with HTTP here?', [108, 8, 340, 92], {
    rot: 0.6,
    on: target('spread', 'step:b-scheduler'),
    anchor: on('spread', 'step:b-scheduler'),
  }),
  25,
);
owner(arrow('arrow-http', 'note-http', 'spread', 'step:b-scheduler', [108, 50], [98, 40]), 4);
owner(ink('cross-b', CROSS, 'cross', 'spread', 'approach:b', [0, 0, 100, 100]), 18);
owner(
  ink('circle-capped', circleOf('M 72 4 C 118 2, 141 15, 139 30 C 137 49, 106 57, 70 56 C 30 55, 4 45, 5 28 C 6 11, 36 4, 82 5'), 'circle', 'spread', 'step:c-capped-tickets', [-6, -6, 112, 112]),
  20,
);
owner(
  note('note-cap', 'why not just cap the queue?', [108, 8, 310, 62], {
    rot: -0.5,
    on: target('spread', 'step:c-capped-tickets'),
    anchor: on('spread', 'step:c-capped-tickets'),
  }),
  12,
);
owner(arrow('arrow-cap', 'note-cap', 'spread', 'step:c-capped-tickets', [108, 40], [98, 30]), 4);

// The agent answers each mark with a small picture, then says how it read the rest.
agent(
  pic(
    CH,
    'reply-fake',
    {
      kind: 'mini',
      title: 'It is on the shelf already',
      boxes: [{ text: 'Runner: the real model' }, { text: 'Stand-in: no GPU', tone: 'blue' }, { text: 'the engine' }],
      flows: [{ from: 1, to: 3 }, { from: 2, to: 3 }],
      caption:
        'Read as: try the engine without the GPU. The stand-in model exists. What is missing is one command that runs the engine on it with fake clients. I added that to A.',
    },
    { answers: ['circle-fake', 'note-fake', 'arrow-fake'], place: { near: 'note-fake', side: 'below' } },
  ),
  30,
);
agent(
  pic(
    CH,
    'reply-line',
    {
      kind: 'mini',
      title: 'Yes. One thread means one line',
      boxes: [{ text: 'http' }, { text: 'http' }, { text: 'sched', tone: 'blue' }, { text: 'http' }, { text: 'http' }],
      caption:
        'Everything on one thread stands in one line. Each turn of the scheduler is time no handler gets. In A the two lines never mix.',
    },
    { answers: ['note-http', 'arrow-http'], place: { near: 'note-http', side: 'below' } },
  ),
  5,
);
agent(
  pic(
    CH,
    'my-read',
    {
      kind: 'text',
      title: 'My read, and two questions',
      body: 'My read: A. It keeps one thread for the model, as your rules ask. C’s cap sits on the wrong thing. I would count open requests at the door instead.',
      questions: ['Is 64 open requests a fair cap?', 'Shall I draw A in full, so you can follow one request through it?'],
    },
    { answers: ['circle-a', 'this-one', 'cross-b', 'circle-capped', 'note-cap', 'arrow-cap'], place: { near: 'note-cap', side: 'below' } },
  ),
  6,
);
system({ type: 'moment.add', chapter: CH, title: 'Three ways, your marks', items: ['spread', 'circle-a', 'cross-b'] });
owner(
  note('note-draw', '2: yes, draw it', [104, 20, 112, 40], { rot: -3, on: target('my-read', 'q:2'), anchor: on('my-read', 'q:2') }),
  35,
);

story[story.length - 1]!.checkpoint = {
  screen: 2,
  name: 'pictures',
  title: 'The agent answers in pictures. You draw on them and it thinks along',
  view: {
    mode: 'board',
    show: ['n-first', 'sketch', 'read', 'shelf', 'spread', 'reply-fake', 'reply-line', 'my-read', 'note-draw'],
    presence: { state: 'drawing', note: 'drawing A in full' },
  },
};

/* ================================================================ 3 · The model */

const PART = (
  id: string,
  name: string,
  plain: string,
  lane: string | undefined,
  col: number | undefined,
  extra: { state?: 'later' | 'built'; shelf?: boolean; commit?: string; files?: string[]; external?: boolean } = {},
) => ({ op: 'part.set' as const, part: { id, name, plain, ...(lane ? { lane } : {}), ...(col ? { col } : {}), ...extra } });

agent(
  {
    type: 'model.patch',
    chapter: CH,
    ops: [
      { op: 'lane.set', lane: { id: 'clients', name: 'Clients', note: 'outside uLLM' } },
      { op: 'lane.set', lane: { id: 'api', name: 'API thread', note: 'asyncio event loop' } },
      { op: 'lane.set', lane: { id: 'bridge', name: 'The bridge', note: 'two queues, no locks' } },
      { op: 'lane.set', lane: { id: 'engine', name: 'Engine thread', note: 'only it touches the model' } },
      PART('clients', 'Clients', 'up to 64 open at once', 'clients', 2, { external: true }),
      PART('tokenizer', 'Tokenizer', 'words into ids', 'api', 1, { state: 'built', shelf: true, commit: 'on the shelf' }),
      PART('handler', 'Handler', 'a later idea', 'api', 2, { state: 'later' }),
      PART('engine-client', 'EngineClient', 'the door: 64 at most', 'api', 3, { files: ['src/ullm/core/client.py'] }),
      PART('stream', 'Stream', 'the handler sleeps here', 'api', 4),
      PART('inbound-queue', 'Inbound queue', 'tickets go down', 'bridge', 3),
      PART('output-queues', 'Output queues', 'one per request', 'bridge', 4),
      PART('request', 'Request', 'its state, one legal path', 'engine', 1, { files: ['src/ullm/core/request.py'] }),
      PART('scheduler', 'Scheduler', 'who runs next', 'engine', 2, { files: ['src/ullm/core/scheduler.py'] }),
      PART('engine-loop', 'Engine loop', 'one turn, one step', 'engine', 3, { files: ['src/ullm/core/engine.py'] }),
      PART('runner', 'Runner', 'the model, on the GPU', 'engine', 4, { state: 'built', shelf: true, commit: 'pull request 11' }),
      PART('try-it', 'Try it: 50 fake clients', 'one command to try it', 'engine', 5),
      PART('stand-in', 'Stand-in model', 'no GPU', 'engine', 6, { state: 'built', shelf: true, commit: 'pull request 11' }),
      PART('same-tokens', 'Same tokens as mlx-lm', 'on the real model', undefined, undefined),
      PART('roadmap-sentence', 'The roadmap sentence', 'one sentence in the roadmap', undefined, undefined),
      { op: 'edge.set', edge: { from: 'clients', to: 'handler' } },
      { op: 'edge.set', edge: { from: 'handler', to: 'engine-client' } },
      { op: 'edge.set', edge: { from: 'engine-client', to: 'inbound-queue' } },
      { op: 'edge.set', edge: { from: 'inbound-queue', to: 'engine-loop' } },
      { op: 'edge.set', edge: { from: 'engine-loop', to: 'scheduler' } },
      { op: 'edge.set', edge: { from: 'engine-loop', to: 'runner' } },
      { op: 'edge.set', edge: { from: 'runner', to: 'output-queues' } },
      { op: 'edge.set', edge: { from: 'output-queues', to: 'stream' } },
      { op: 'edge.set', edge: { from: 'stream', to: 'clients' } },
      {
        op: 'walk.set',
        walk: {
          id: 'req-42',
          name: 'Follow one request: req-42',
          steps: [
            { n: 1, part: 'clients', text: 'The client posts “what is 2 + 2”' },
            { n: 2, part: 'handler', text: 'A handler starts. It names it req-42' },
            { n: 3, part: 'tokenizer', text: 'The words become token ids' },
            { n: 4, part: 'inbound-queue', text: 'A ticket goes on the inbound queue' },
            { n: 5, part: 'stream', text: 'The handler sleeps. Others are served' },
            { n: 6, part: 'engine-loop', text: 'The engine’s next turn takes the ticket' },
            { n: 7, part: 'scheduler', text: 'The scheduler admits req-42: its prefill' },
            { n: 8, part: 'runner', text: 'The model runs on the GPU: first token “2”' },
            { n: 9, part: 'output-queues', text: '“2” goes into req-42’s output queue' },
            { n: 10, part: 'stream', text: 'The handler wakes and sends “2”' },
            { n: 11, part: 'clients', text: 'The user sees “2”: time to first token' },
            { n: 12, part: 'engine-loop', text: 'Steps 8 to 11 repeat for each token' },
            { n: 13, part: 'request', text: 'The end token: req-42 is released' },
          ],
        },
      },
    ],
  },
  8,
);

agent(
  pic(
    CH,
    'pipe',
    {
      kind: 'pipeline',
      title: 'Your pick, in full',
      caption: 'A, with the cap at the door and a way to try it with no GPU. One request is on its way through.',
      view: 'layers',
      walk: 'req-42',
    },
    { answers: ['note-draw'], from: ['spread'], place: { near: 'spread', side: 'below' } },
  ),
  4,
);
agent(
  pic(CH, 'walk', { kind: 'walk', title: 'Follow one request: req-42', walk: 'req-42' }, { from: ['pipe'], place: { near: 'pipe', side: 'right' } }),
  3,
);
agent(
  pic(
    CH,
    'hint',
    {
      kind: 'text',
      title: 'When it looks right, lasso what you want to keep and press Solidify.',
      body: 'I will read it back as one picture before I build anything.',
    },
    { from: ['pipe'], place: { near: 'walk', side: 'below' } },
  ),
  3,
);

owner(
  add(CH, {
    id: 'voice-sleeps',
    kind: 'voice',
    box: [108, 8, 336, 76],
    rot: -0.5,
    text: 'so the handler just sleeps here?',
    on: target('walk', 'step:5'),
    anchor: on('walk', 'step:5'),
  }),
  45,
);
agent(
  pic(
    CH,
    'reply-sleeps',
    {
      kind: 'text',
      title: 'Yes. A sleeping handler holds no thread.',
      body: 'The server thread serves the other clients meanwhile.',
    },
    { answers: ['voice-sleeps'], place: { near: 'voice-sleeps', side: 'below' } },
  ),
  5,
);
owner(
  ink(
    'circle-bridge',
    circleOf('M 312 6 C 500 2, 616 30, 616 72 C 616 116, 482 140, 304 140 C 124 140, 8 114, 8 70 C 8 28, 142 4, 334 8'),
    'circle',
    'pipe',
    'lane:bridge',
    [-6, -6, 112, 112],
  ),
  30,
);
owner(
  note('note-fills', 'what if this fills up?', [60, 104, 300, 40], { rot: -2, on: target('pipe', 'lane:bridge'), anchor: on('pipe', 'lane:bridge') }),
  6,
);
agent({ type: 'answer', answers: ['circle-bridge'], read: 'Open the bridge' }, 4);
agent({ type: 'moment.add', chapter: CH, title: 'The model, one request', items: ['pipe', 'walk'] }, 2);

story[story.length - 1]!.checkpoint = {
  screen: 3,
  name: 'model',
  title: 'Your pick becomes a model of the pipeline. You follow one request through it',
  view: {
    mode: 'board',
    show: ['pipe', 'walk', 'reply-sleeps', 'hint'],
    walk: { id: 'req-42', step: 8 },
    pipeline: 'layers',
    presence: { state: 'listening' },
  },
};

/* ================================================================ 4 · Focus */

const ask = owner({ type: 'ask', what: 'focus', lane: 'bridge', item: 'pipe' }, 40);

agent(
  pic(
    CH,
    'focus',
    {
      kind: 'focus',
      lane: 'bridge',
      title: 'The bridge, opened',
      summary:
        'Down. Tickets are plain data. The queue itself has no cap, because the door already counts every open request. Up. The engine never waits for a handler. It hands this turn’s bundle to the server thread and goes on.',
      crosses: [
        { dir: 'in', what: 'Submit', part: 'engine-client', note: 'a new request' },
        { dir: 'in', what: 'Abort', part: 'engine-client', note: 'the client left' },
        { dir: 'in', what: 'Shutdown', part: 'engine-client', note: 'stop everything' },
        { dir: 'out', what: 'Delta', part: 'stream', note: 'a piece of text' },
        { dir: 'out', what: 'Finished', part: 'stream', note: 'the end, with counts' },
        { dir: 'out', what: 'Failed', part: 'stream', note: 'the end, with a reason' },
      ],
      inside: [
        { name: 'EngineClient, the door', plain: '61 of 64 open' },
        { name: 'Inbound queue', plain: 'a ticket waits at most one step', holds: ['Submit req-44', 'Abort req-41', 'Submit req-43'] },
        { name: 'Engine loop', plain: 'takes every ticket at the start of a turn' },
        { name: 'Output queues', plain: 'one for each open request', holds: ['req-41 “The”', 'req-42 “2”', 'req-43 “Hi”'] },
        { name: 'This turn’s outputs', plain: 'one bundle: “The”, “2”, “Hi”' },
        { name: 'One wake-up per turn', plain: 'not one per token' },
      ],
      promise:
        'Every accepted request gets exactly one ending, and nothing after it. No request can wait forever, even if the engine dies.',
      cost: 'A new request can wait one full step before the engine sees it. A long prefill makes that wait longer.',
      made: {
        title: 'One wake-up for each engine turn, not one for each token.',
        body: 'The server thread wakes less often.',
      },
      options: {
        title: 'Two ways to stop a flood',
        items: [
          {
            id: 'cap-queue',
            name: 'Cap the ticket queue',
            body: 'The roadmap’s way: the ticket queue, cap 8, emptied every turn. The waiting line inside the engine has no cap.',
            risk: 'The cap sits where nothing piles up. The line behind it keeps growing.',
          },
          {
            id: 'cap-door',
            name: 'Cap the door',
            body: 'Count the open requests. The door counts everything the engine still holds: 3 in the queue, 40 waiting, 1 running, 20 leaving = 64. The 65th hears “busy, come back in 1 s” at once.',
          },
        ],
        lean: 'cap-door',
      },
      lean: 'Cap the door. It needs no shared counter, and a client that leaves can always be told. It changes one sentence in the roadmap.',
    },
    { answers: [ask, 'note-fills'], from: ['pipe'], place: { near: 'pipe', side: 'below' } },
  ),
  6,
);

owner(ink('cross-queue', CROSS, 'cross', 'focus', 'option:cap-queue', [0, 0, 100, 100]), 40);
owner(
  ink(
    'circle-door',
    circleOf('M 240 8 C 380 4, 452 60, 452 144 C 452 232, 364 280, 226 278 C 92 276, 8 226, 8 140 C 8 58, 96 10, 256 10'),
    'circle',
    'focus',
    'option:cap-door',
    [-6, -6, 112, 112],
  ),
  12,
);
owner(
  note('note-door', 'this. and tell them when to come back', [10, 108, 340, 40], {
    rot: -1,
    on: target('focus', 'option:cap-door'),
    anchor: on('focus', 'option:cap-door'),
  }),
  10,
);
agent(
  pic(
    CH,
    'read-marks',
    {
      kind: 'text',
      title: 'How I read your marks',
      body: 'The cap goes on the door: 64 open requests. The 65th is refused at once, with a time to come back. One sentence in the roadmap changes. I will show you that edit with the rest.',
    },
    { answers: ['cross-queue', 'circle-door', 'note-door'], place: { near: 'focus', side: 'right' } },
  ),
  6,
);
system({ type: 'moment.add', chapter: CH, title: 'The bridge, opened', items: ['focus', 'circle-door'] }, 2);

story[story.length - 1]!.checkpoint = {
  screen: 4,
  name: 'focus',
  title: 'You tap one part. The board opens it up',
  view: {
    mode: 'board',
    show: ['focus', 'read-marks'],
    focus: 'focus',
    pipeline: 'layers',
    presence: { state: 'listening' },
  },
};

/* ================================================================ 5 · Solidify */

owner(
  add(CH, {
    id: 'lasso',
    kind: 'lasso',
    box: [60, 155, 480, 500],
    path: inkAt('M 14 14 C 90 8, 170 12, 236 10 C 240 60, 234 120, 238 170 C 320 166, 400 172, 464 170 C 468 270, 462 390, 466 488 C 320 494, 150 486, 12 490 C 8 330, 16 170, 14 14 Z', 60, 155)
      .flatMap((s) => s.pts),
    targets: [
      target('spread', 'approach:a'),
      target('reply-fake'),
      target('pipe'),
      target('focus', 'option:cap-door'),
      target('focus'),
    ],
  }),
  60,
);
// Written just under the lasso, in the lasso's own space, so it stays there wherever the pictures land.
owner(note('note-yes', 'yes. this is it.', [62, 104, 230, 60], { rot: -2, anchor: on('lasso') }), 15);
const solid = owner(
  {
    type: 'solidify',
    chapter: CH,
    picks: ['spread', 'reply-fake', 'pipe', 'focus'],
    // The parts the owner saw as ideas when they pressed. The Handler is put off, so it is not one of them.
    parts: ['engine-client', 'stream', 'inbound-queue', 'output-queues', 'request', 'scheduler', 'engine-loop', 'try-it', 'same-tokens', 'roadmap-sentence'],
    lasso: 'lasso',
  },
  5,
);
agent(
  pic(
    CH,
    'blueprint',
    {
      kind: 'blueprint',
      title: 'The blueprint',
      summary: 'What I will build, in one picture. Nothing else.',
      picks: [
        { text: 'The engine gets its own thread', from: target('circle-a') },
        { text: 'The cap sits on the door: 64 open requests', from: target('circle-door') },
        { text: 'One command to try it with no GPU', from: target('note-fake') },
        { text: 'One wake-up for each engine turn. My choice.', from: target('focus') },
      ],
      leftOut: [{ text: 'No HTTP yet. That is the next idea.' }, { text: 'One request at a time. Batches come later.' }],
      proof: [
        '50 fake clients at once. Some leave early. Every request must end properly.',
        'On the real model: the same tokens as mlx-lm.',
      ],
      parts: ['request', 'scheduler', 'engine-loop', 'engine-client', 'try-it', 'same-tokens', 'roadmap-sentence'],
      check: 'make check',
    },
    { answers: ['note-yes', solid], from: ['lasso'], place: { near: 'lasso', side: 'right' } },
  ),
  8,
);
system({ type: 'moment.add', chapter: CH, title: 'The blueprint', items: ['blueprint'] }, 2);

story[story.length - 1]!.checkpoint = {
  screen: 5,
  name: 'solidify',
  title: 'You lasso your picks and solidify. The agent reads the idea back',
  view: {
    mode: 'board',
    // The lasso runs round the whole board. The screen is the read-back.
    show: ['blueprint', 'note-yes'],
    pipeline: 'layers',
    presence: { state: 'waiting', note: 'waiting for your go' },
  },
};

/* ================================================================ 6 · Watch */

const TRACK = ['request', 'scheduler', 'engine-loop', 'engine-client', 'try-it', 'same-tokens', 'roadmap-sentence'];
const check = { cmd: 'make check', passed: true };

// Times follow the feed on the screen: you pressed Build this at 13:20, Request at 13:41, Scheduler at 14:02.
const start = owner({ type: 'build.start', chapter: CH, track: TRACK, blueprint: 'blueprint', check: 'make check' }, atMin(20));
// The owner picked the pipeline picture, so it stays as they saw it. The build gets a picture
// of its own, which comes from it. Both are views of the same model, and both fill in.
agent(
  pic(
    CH,
    'pipe-build',
    {
      kind: 'pipeline',
      title: 'The blueprint, being built',
      caption: 'Filled parts are built. Blue is where I am. Solid outlines come next.',
      view: 'layers',
    },
    { from: ['pipe', 'blueprint'], place: { near: 'blueprint', side: 'below' } },
  ),
  3,
);
agent({ type: 'part.state', part: 'request', state: 'building' }, 3);
system({ type: 'part.state', part: 'request', state: 'built', commit: '658b4ec', check }, atMin(41));
system(
  {
    type: 'feed.add',
    chapter: CH,
    kind: 'commit',
    part: 'request',
    commit: '658b4ec',
    check,
    text: 'Request is built. +160 lines. A move between states that is not on the list raises and changes nothing. WAITING›PREFILLING›RUNNING›FINISHED',
  },
  2,
);
agent({ type: 'part.state', part: 'scheduler', state: 'building' }, 3);
system({ type: 'part.state', part: 'scheduler', state: 'built', commit: 'eb39c5b', check }, atMin(62));
system(
  {
    type: 'feed.add',
    chapter: CH,
    kind: 'commit',
    part: 'scheduler',
    commit: 'eb39c5b',
    check,
    text: 'Scheduler is built. +59 lines, tests written first. The oldest request goes first. One prefill or one decode per step.',
  },
  2,
);
agent({ type: 'part.state', part: 'engine-loop', state: 'building' }, 3);
agent(
  {
    type: 'feed.add',
    chapter: CH,
    kind: 'update',
    part: 'engine-loop',
    text: 'Engine loop: the five things one turn does. 1 read tickets, 2 plan a step, 3 run the step, 4 add the token, 5 send outputs. Three are written, the fourth is in work, the fifth is to come.',
  },
  4,
);

agent(
  pic(
    CH,
    'leave',
    {
      kind: 'text',
      title: 'You can leave.',
      body: 'I will mark this board if something needs you. So far nothing does.',
    },
    { answers: [start], place: { near: 'pipe', side: 'below' } },
  ),
  4,
);

owner(
  note('note-one', 'only one request at a time here?', [-40, 112, 350, 62], {
    rot: -0.6,
    on: target('pipe-build', 'part:scheduler'),
    anchor: on('pipe-build', 'part:scheduler'),
  }),
  90,
);
owner(arrow('arrow-one', 'note-one', 'pipe-build', 'part:scheduler', [60, 114], [50, 100]), 4);
agent(
  pic(
    CH,
    'reply-one',
    {
      kind: 'text',
      title: 'For now, yes.',
      body: 'The limit is 1 in this idea. Batches come with a later idea and change only that number. I kept building.',
    },
    { answers: ['note-one', 'arrow-one'], place: { near: 'note-one', side: 'right' } },
  ),
  8,
);
agent(
  pic(
    CH,
    'choice',
    {
      kind: 'choice',
      title: 'A choice I made while building',
      body: 'The last piece of a reply arrives together with the reason it ended. One message less for the server. I did not stop for it.',
      options: [
        { id: 'together', label: 'The last piece arrives with the reason', note: 'One message less for the server.' },
        { id: 'apart', label: 'The reason comes in its own message' },
      ],
      chosen: 'together',
      part: 'engine-loop',
    },
    { from: ['blueprint'], place: { near: 'pipe-build', side: 'right' } },
  ),
  15,
);
system({ type: 'moment.add', chapter: CH, title: 'Built, part by part', items: ['pipe-build', 'choice'] }, 2);

story[story.length - 1]!.checkpoint = {
  screen: 6,
  name: 'watch',
  title: 'The agent builds in the background. The same picture fills in',
  view: {
    mode: 'board',
    show: ['pipe-build', 'choice', 'reply-one'],
    pipeline: 'layers',
    presence: { state: 'building', note: 'building part 3 of 7', cursor: { item: 'pipe-build' } },
  },
};

/* ================================================================ 7 · Story */

// The rest of the build, with the real commits of uLLM's M1-T3, so the chapter is built before the next idea.
const REST: Array<[string, string, string]> = [
  ['engine-loop', '74c7662', 'Engine loop is built. The engine loop, one delivery per turn.'],
  ['engine-client', 'eccb136', 'Client is built. EngineClient, the asyncio side of the bridge.'],
  ['try-it', '5a780b4', 'Try it is built. ullm sim and make sim, checked by the trace checker.'],
  ['same-tokens', 'b75a1ff', 'Same tokens is built. Greedy tokens through EngineClient equal mlx-lm’s.'],
  ['roadmap-sentence', '126622e', 'The roadmap sentence is built. E5 bounds open requests, not the queue.'],
];
REST.forEach(([part, commit, text], i) => {
  if (part !== 'engine-loop') agent({ type: 'part.state', part, state: 'building' }, 60);
  system({ type: 'part.state', part, state: 'built', commit, check }, i === 0 ? 400 : 420);
  system({ type: 'feed.add', chapter: CH, kind: 'commit', part, commit, check, text }, 2);
});

owner({ type: 'chapter.open', chapter: CH2, title: 'API server' }, 200);
owner(
  add(CH2, {
    id: 'note-api',
    kind: 'note',
    box: [1250, 228, 310, 96],
    rot: -0.8,
    text: 'Now put HTTP in front of it. curl should just work.',
  }),
  25,
);
agent(
  {
    type: 'model.patch',
    chapter: CH2,
    ops: [{ op: 'part.set', part: { id: 'batches', name: 'Batches of many', lane: 'engine', state: 'later' } }],
  },
  8,
);
agent({ type: 'part.state', part: 'handler', state: 'idea', chapter: CH2 }, 3);
agent(
  pic(
    CH2,
    'drawing',
    {
      kind: 'text',
      title: 'Drawing two ways to stream the reply',
      body: 'The engine side is built, so both pictures start from the model below.',
    },
    { from: ['note-api'], status: 'drawing', place: { near: 'note-api', side: 'below' } },
  ),
  10,
);

story[story.length - 1]!.checkpoint = {
  screen: 7,
  name: 'story',
  title: 'Zoom out. The board is the story, and the next idea starts on it',
  view: {
    mode: 'story',
    show: ['note-api', 'drawing'],
    pipeline: 'layers',
    presence: { state: 'drawing', note: 'drawing 2 pictures' },
  },
};
