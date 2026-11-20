import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BoardEvent, PictureKind } from '@keel/protocol';
import { parseLog } from '@keel/protocol';

/**
 * The recorded boards: seven moments of the golden fixture (protocol/fixtures/engine-loop),
 * each cut just before the agent answers. The repository is uLLM at the commit before its
 * engine loop landed, so the agent looks at the same shelf the story's agent saw.
 * Boards e to g are screens 5 and 6: the read-back, "Build this", and a mark during the build.
 */

export const FIXTURE_DIR = fileURLToPath(new URL('../../protocol/fixtures/engine-loop/', import.meta.url));

/** uLLM before Merge #13 (the engine loop): the first parent of 06dd28f. */
export const ULLM_COMMIT = '8656103';

/** A kind, or a list of kinds of which any one will do. */
export type Want = PictureKind | readonly PictureKind[];

export interface BoardSpec {
  id: 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g';
  title: string;
  /** The last event of the golden log that the seed keeps. */
  cut: string;
  /** Owner events the seed adds after the cut, as drafts: a mark the golden log does not have. */
  extra?: ReadonlyArray<Record<string, unknown>>;
  /** Picture kinds the answer must hold, in its final state. */
  kinds: readonly Want[];
  /** The answer must patch the board's model. */
  model?: boolean;
  /** The answer is a blueprint with a check, on solid parts, and nothing moves toward built. */
  blueprint?: boolean;
  /** The agent moves no part: no "building", no "built". */
  still?: boolean;
  /** This act must be answered by a text card. */
  card?: string;
  /** The agent must reopen this part, naming this mark as the cause. */
  reopen?: { part: string; because: string };
  /** The golden events that answer the board, when the golden log mixes the builder in. */
  golden?: readonly string[];
}

export const BOARDS: Record<BoardSpec['id'], BoardSpec> = {
  a: { id: 'a', title: 'A first note and a sketch', cut: 'e11', kinds: [['mini', 'text'], 'shelf', 'spread'] },
  b: { id: 'b', title: 'Marks on a spread: circles, a cross, questions', cut: 'e26', kinds: ['mini', 'text'] },
  c: { id: 'c', title: 'A pick: "2: yes, draw it"', cut: 'e31', kinds: ['pipeline', 'walk'], model: true },
  d: { id: 'd', title: 'A tap on the bridge', cut: 'e42', kinds: ['focus'] },
  e: { id: 'e', title: 'Solidify: the blueprint, and wait', cut: 'e51', kinds: ['blueprint'], blueprint: true, still: true },
  f: { id: 'f', title: '"Build this": you can leave', cut: 'e54', kinds: ['text'], still: true, card: 'e54', golden: ['e64'] },
  g: {
    id: 'g',
    title: 'A mark during the build changes a decided part',
    cut: 'e64',
    extra: [
      {
        by: 'owner',
        chapter: 'engine-loop',
        type: 'item.add',
        item: {
          id: 'note-change',
          kind: 'note',
          box: [700, 120, 330, 70],
          rot: -1,
          anchor: { item: 'pipe', sub: 'part:try-it', box: [0, 0, 100, 100] },
          text: 'change this: 20 fake clients, not 50. and two of them give up after 1 s.',
          on: { item: 'pipe', sub: 'part:try-it' },
        },
      },
    ],
    kinds: [['mini', 'text']],
    reopen: { part: 'try-it', because: 'note-change' },
  },
};

/** The golden log as text, one event per line. */
export function goldenLines(): string[] {
  return fs.readFileSync(path.join(FIXTURE_DIR, 'log.jsonl'), 'utf8').split('\n').filter((l) => l.trim());
}

/** The seed of a board: the golden log up to and including its cut, then its extra events, numbered on. */
export function seedLines(board: BoardSpec): string[] {
  const lines = goldenLines();
  const i = lines.findIndex((l) => (JSON.parse(l) as { id: string }).id === board.cut);
  if (i < 0) throw new Error(`The golden log has no event ${board.cut}.`);
  const out = lines.slice(0, i + 1);
  const last = JSON.parse(out[out.length - 1]!) as { at: string };
  (board.extra ?? []).forEach((draft, k) => {
    const at = new Date(Date.parse(last.at) + (k + 1) * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    out.push(JSON.stringify({ ...draft, id: `e${i + 2 + k}`, at }));
  });
  return out;
}

/**
 * The seed, split for a live start. The server wakes no agent for a log it finds on disk: a
 * repository can ship any log. So the board's own last moves, from the owner's last event on,
 * are posted live after the server starts, each with its actor's token, as the owner would.
 */
export function splitSeed(board: BoardSpec): { disk: string[]; live: BoardEvent[] } {
  const lines = seedLines(board);
  const events = lines.map((l) => JSON.parse(l) as BoardEvent);
  let i = events.length - 1;
  while (i > 0 && events[i]!.by !== 'owner') i -= 1;
  return { disk: lines.slice(0, i), live: events.slice(i) };
}

export function seedEvents(board: BoardSpec): BoardEvent[] {
  const { events, problems } = parseLog(seedLines(board).join('\n'));
  if (problems.length) throw new Error(`The seed of board ${board.id} does not parse: ${JSON.stringify(problems[0])}`);
  return events;
}

/**
 * The golden agent's own answer to a board: the events after the cut, up to the owner's next
 * move, or the board's `golden` events when the golden log mixes the builder's in, numbered on.
 */
export function goldenAnswer(board: BoardSpec): BoardEvent[] {
  const all = parseLog(goldenLines().join('\n')).events;
  const start = all.findIndex((e) => e.id === board.cut) + 1;
  const out: BoardEvent[] = [];
  for (const ev of all.slice(start)) {
    if (ev.by === 'owner') break;
    if (board.golden && !board.golden.includes(ev.id)) continue;
    out.push(ev);
  }
  return board.golden ? out.map((e, k) => ({ ...e, id: `e${start + 1 + k}` })) : out;
}
