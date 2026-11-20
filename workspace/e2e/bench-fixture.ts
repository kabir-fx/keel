import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BoardEvent, Box, Checkpoint, PictureSpec } from '@keel/protocol';
import { admit, emptyState, formatEvent } from '@keel/protocol';

/**
 * Build the bench's fixture: 300 items on a grid, a mix like a long session's. The agent's
 * pictures of every kind the board draws without a focus or a walk, each placed by the owner
 * so nothing waits for room; the owner's notes, free ink, arrows between neighbours, and one
 * lasso. Every event goes through the protocol's own `admit`, so the log is one the board
 * accepts. The same seed gives the same board. Run it from workspace/e2e, and check in what it
 * writes:
 *
 *   npx tsx bench-fixture.ts
 */

const OUT = fileURLToPath(new URL('../app/src/fixtures/bench/', import.meta.url));
const START = Date.parse('2026-11-18T09:00:00Z');

/** The grid is this many cells wide: its 300 cells make 15 rows. */
const COLS = 20;
/** One grid cell, in board units. A picture may be drawn wider than its cell. */
const CELL: readonly [number, number] = [620, 500];

/** How many of each, in the 299 cells that hold one item. The lasso lies over four of them. */
const MIX = { note: 90, ink: 50, arrow: 39, text: 28, mini: 24, lanes: 18, shelf: 14, choice: 10, free: 10, spread: 8, pipeline: 8 } as const;
type Kind = keyof typeof MIX;

/** A small fixed-seed generator (mulberry32), so the board is the same on every run. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = random(20261118);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const round = (n: number) => Math.round(n * 10) / 10;

const WORDS = 'queue engine request stream token client handler thread bridge model batch cache wait reply cap door lane step order retry'.split(' ');
const sentence = (n: number) => {
  const w = Array.from({ length: n }, () => pick(WORDS));
  return `${w.join(' ').replace(/^./, (c) => c.toUpperCase())}?`;
};

function picture(kind: Exclude<Kind, 'note' | 'ink' | 'arrow'>, n: number): PictureSpec {
  switch (kind) {
    case 'text':
      return { kind, title: `My read, number ${n}`, body: `${sentence(14)} ${sentence(10)}`, points: [sentence(6), sentence(7), sentence(5)], questions: [sentence(8), sentence(6)] };
    case 'mini':
      return { kind, title: `Yes. ${sentence(4)}`, boxes: [{ text: 'client' }, { text: 'queue', tone: 'blue' }, { text: 'engine', tone: 'teal' }, { text: 'reply' }], caption: sentence(12) };
    case 'lanes':
      return {
        kind,
        title: `Who waits for whom, ${n}`,
        lanes: [
          { id: 'client', name: 'Client' },
          { id: 'api', name: 'API thread' },
          { id: 'engine', name: 'Engine thread' },
        ],
        steps: [
          { id: 's1', lane: 'client', text: 'Posts a request', n: 1 },
          { id: 's2', lane: 'api', text: 'Puts it on the queue', n: 2 },
          { id: 's3', lane: 'engine', text: 'Takes a batch', n: 3 },
          { id: 's4', lane: 'engine', text: 'Makes one token each', n: 4 },
          { id: 's5', lane: 'api', text: 'Streams the token back', n: 5 },
        ],
        flows: [
          { from: 's1', to: 's2' },
          { from: 's2', to: 's3', label: 'queue' },
          { from: 's3', to: 's4' },
          { from: 's4', to: 's5', wait: true },
        ],
        caption: sentence(10),
      };
    case 'shelf':
      return {
        kind,
        title: 'Already on the shelf',
        tiles: [
          { id: 'tok', name: 'Tokenizer', plain: 'turns words into numbers', ref: 'src/tok.rs', state: 'built' },
          { id: 'sched', name: 'Scheduler', plain: 'picks the next batch', ref: 'src/sched.rs', state: 'idea' },
          { id: 'http', name: 'HTTP server', plain: 'takes the requests', ref: 'src/http.rs', state: 'built' },
        ],
      };
    case 'choice':
      return {
        kind,
        title: `I chose one wake-up a turn (${n})`,
        body: sentence(12),
        options: [
          { id: 'a', label: 'One wake-up a turn', note: sentence(6) },
          { id: 'b', label: 'A wake-up per token', note: sentence(6) },
        ],
        chosen: 'a',
      };
    case 'free':
      return {
        kind,
        title: `The screen, sketched (${n})`,
        svg:
          '<svg viewBox="0 0 400 260" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="10" width="380" height="240" rx="8" fill="#F4F6F9" stroke="#0F1B2D" stroke-width="1.5"/>' +
          '<rect x="30" y="30" width="340" height="40" fill="#fff" stroke="#0F1B2D" stroke-width="1.5"/><text x="44" y="56" font-size="16" fill="#0F1B2D">Ask the engine</text>' +
          '<rect x="30" y="90" width="160" height="140" fill="#fff" stroke="#0F1B2D" stroke-width="1.5"/><rect x="210" y="90" width="160" height="140" fill="#fff" stroke="#1D4ED8" stroke-width="1.5"/>' +
          '<polygon points="190,160 210,150 210,170" fill="#1D4ED8"/></svg>',
        caption: sentence(9),
      };
    case 'spread':
      return {
        kind,
        title: `Two ways to stream (${n})`,
        request: 'a client asks what is 2 + 2',
        approaches: [
          {
            title: 'One queue',
            lanes: [{ id: 'api', name: 'API' }, { id: 'engine', name: 'Engine' }],
            steps: [{ id: 'q', lane: 'api', text: 'Queue the request' }, { id: 'run', lane: 'engine', text: 'Run the batch' }],
            risk: 'One slow client holds the line',
          },
          {
            title: 'A queue per client',
            lanes: [{ id: 'api', name: 'API' }, { id: 'engine', name: 'Engine' }],
            steps: [{ id: 'q2', lane: 'api', text: 'Queue per client' }, { id: 'run', lane: 'engine', text: 'Run the batch' }],
            risk: 'More queues to keep',
          },
        ],
        lean: 'B',
        caption: sentence(10),
      };
    case 'pipeline':
      return { kind, title: `The engine, drawn (${n})`, view: n % 2 ? 'flat' : 'layers' };
  }
}

/** Points along a free sketch in a cell, counted from its box's corner, and how the app would read it. */
function sketch(w: number, h: number): { strokes: Array<{ pts: number[] }>; hint: 'circle' | 'cross' | 'underline' | 'none' } {
  const shape = pick(['circle', 'cross', 'underline', 'none'] as const);
  const pts = (n: number, at: (t: number) => [number, number]) => Array.from({ length: n + 1 }, (_, i) => at(i / n)).flatMap(([x, y]) => [round(x), round(y)]);
  const wobble = () => (rnd() - 0.5) * 6;
  if (shape === 'circle') return { hint: shape, strokes: [{ pts: pts(48, (t) => [w / 2 + (w / 2 - 6) * Math.cos(t * 2.1 * Math.PI) + wobble(), h / 2 + (h / 2 - 6) * Math.sin(t * 2.1 * Math.PI) + wobble()]) }] };
  if (shape === 'cross') {
    return { hint: shape, strokes: [{ pts: pts(16, (t) => [6 + t * (w - 12), 6 + t * (h - 12) + wobble()]) }, { pts: pts(16, (t) => [w - 6 - t * (w - 12), 6 + t * (h - 12) + wobble()]) }] };
  }
  if (shape === 'underline') return { hint: shape, strokes: [{ pts: pts(24, (t) => [6 + t * (w - 12), h - 8 + wobble()]) }] };
  return { hint: shape, strokes: [{ pts: pts(60, (t) => [6 + t * (w - 12), h / 2 + (h / 2 - 8) * Math.sin(t * 9) + wobble()]) }] };
}

interface Built {
  events: BoardEvent[];
  checkpoints: Checkpoint[];
}

function buildBench(): Built {
  let state = emptyState();
  let ms = START;
  const events: BoardEvent[] = [];
  const post = (by: 'owner' | 'agent' | 'system', draft: Record<string, unknown>) => {
    ms += 1000;
    const r = admit(state, draft, by, new Date(ms).toISOString());
    if (!r.ok) throw new Error(`${by} ${String(draft.type)} refused under ${r.rule}: ${r.reason}`);
    state = r.state;
    events.push(r.event);
    return r.event;
  };

  // The kinds, shuffled over the cells. The last cell stays empty: 299 items and the lasso.
  const kinds: Kind[] = (Object.entries(MIX) as Array<[Kind, number]>).flatMap(([k, n]) => Array<Kind>(n).fill(k));
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [kinds[i], kinds[j]] = [kinds[j]!, kinds[i]!];
  }
  const cells = kinds.map((kind, i) => ({ kind, i, col: i % COLS, row: Math.floor(i / COLS), id: `${kind.slice(0, 2)}-${i}` }));
  const cellBox = (c: { col: number; row: number }): Box => [c.col * CELL[0], c.row * CELL[1], CELL[0], CELL[1]];
  const chapter = (row: number) => `part-${Math.floor(row / 5) + 1}`;

  post('system', { type: 'board.open', name: 'The bench' });
  for (const n of [1, 2, 3]) post('owner', { type: 'chapter.open', chapter: `part-${n}`, title: `Part ${n} of a long session` });
  post('agent', {
    type: 'model.patch',
    ops: [
      { op: 'lane.set', lane: { id: 'api', name: 'API thread' } },
      { op: 'lane.set', lane: { id: 'engine', name: 'Engine thread' } },
      { op: 'part.set', part: { id: 'http', name: 'HTTP server', lane: 'api' } },
      { op: 'part.set', part: { id: 'queue', name: 'The queue', lane: 'api' } },
      { op: 'part.set', part: { id: 'sched', name: 'Scheduler', lane: 'engine' } },
      { op: 'part.set', part: { id: 'loop', name: 'Engine loop', lane: 'engine' } },
    ],
  });

  // The owner's marks first, so every picture has a note to answer.
  for (const c of cells) {
    const [x, y] = cellBox(c);
    if (c.kind === 'note') {
      const text = c.i % 3 ? sentence(6 + (c.i % 9)) : `${sentence(12)} ${sentence(10)} ${sentence(8)}`;
      post('owner', { type: 'item.add', chapter: chapter(c.row), item: { id: c.id, kind: 'note', box: [x + 60, y + 60, 300 + (c.i % 4) * 40, 90 + (c.i % 3) * 40], text, rot: round((rnd() - 0.5) * 4) } });
    } else if (c.kind === 'ink') {
      const [iw, ih] = [260 + Math.floor(rnd() * 200), 120 + Math.floor(rnd() * 200)];
      post('owner', { type: 'item.add', chapter: chapter(c.row), item: { id: c.id, kind: 'ink', box: [x + 40, y + 40, iw, ih], targets: [], ...sketch(iw, ih) } });
    }
  }

  // The agent's pictures, each answering the nearest note before it, a third also grown from
  // the picture before; then the owner places each one in its cell.
  const notes = cells.filter((c) => c.kind === 'note');
  let previous: string | undefined;
  for (const c of cells) {
    if (c.kind === 'note' || c.kind === 'ink' || c.kind === 'arrow') continue;
    const answers = [(notes.filter((n) => n.i < c.i).at(-1) ?? notes[0]!).id];
    const from = previous && c.i % 3 === 0 ? [previous] : undefined;
    post('agent', { type: 'item.add', chapter: chapter(c.row), item: { id: c.id, kind: 'picture', picture: picture(c.kind, c.i), answers, ...(from ? { from } : {}), status: 'done' } });
    const [x, y] = cellBox(c);
    post('owner', { type: 'item.update', item: c.id, patch: { box: [x + 30, y + 30, 520, 400] } });
    previous = c.id;
  }

  // Arrows from the item on the left of their cell to the one on the right, where there is one.
  const at = new Map(cells.map((c) => [`${c.col},${c.row}`, c]));
  for (const c of cells.filter((k) => k.kind === 'arrow')) {
    const [x, y, w, h] = cellBox(c);
    const end = (dc: number) => {
      const n = at.get(`${c.col + dc},${c.row}`);
      return n && n.kind !== 'arrow' && n.kind !== 'ink' ? { item: n.id } : undefined;
    };
    const [fromTarget, toTarget] = [end(-1), end(1)];
    const lift = 40 + Math.floor(rnd() * 80);
    post('owner', {
      type: 'item.add',
      chapter: chapter(c.row),
      item: { id: c.id, kind: 'arrow', box: [x - 40, y + h / 2 - lift, w + 80, lift], from: [0, lift], to: [w + 80, 0], ...(fromTarget ? { fromTarget } : {}), ...(toTarget ? { toTarget } : {}) },
    });
  }

  // One lasso round the four cells at the top left, holding what is in them.
  const held = cells.filter((c) => c.col < 2 && c.row < 2 && c.kind !== 'arrow' && c.kind !== 'ink').map((c) => ({ item: c.id }));
  const [lw, lh] = [CELL[0] * 2, CELL[1] * 2];
  const loop = Array.from({ length: 41 }, (_, i) => {
    const t = (i / 40) * 2 * Math.PI;
    return [round(lw / 2 + (lw / 2 - 10) * Math.cos(t)), round(lh / 2 + (lh / 2 - 10) * Math.sin(t))];
  }).flat();
  post('owner', { type: 'item.add', chapter: 'part-1', item: { id: 'lasso', kind: 'lasso', box: [0, 0, lw, lh], path: loop, targets: held } });

  const cursorOn = cells.find((c) => c.kind === 'text')!.id;
  const checkpoints: Checkpoint[] = [
    {
      screen: 1,
      name: 'bench',
      title: 'The bench: 300 items',
      after: events.at(-1)!.id,
      view: { mode: 'board', presence: { state: 'listening', note: 'listening', cursor: { item: cursorOn } } },
    },
  ];
  return { events, checkpoints };
}

function main(): void {
  const { events, checkpoints } = buildBench();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}log.jsonl`, events.map(formatEvent).join('\n') + '\n');
  writeFileSync(`${OUT}checkpoints.json`, JSON.stringify(checkpoints, null, 2) + '\n');
  const items = events.filter((e) => e.type === 'item.add').length;
  console.log(`bench fixture: ${events.length} events, ${items} items, in ${OUT}`);
}

main();
