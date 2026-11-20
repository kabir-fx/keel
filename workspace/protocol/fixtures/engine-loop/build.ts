import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BoardEvent, Checkpoint } from '../../src';
import { admit, emptyState, formatEvent } from '../../src';
import { makeAssets } from './assets';
import { story } from './story';

/**
 * Build the golden fixture: push every beat of `story.ts` through `admit()` and write
 * `log.jsonl`, `checkpoints.json` and `assets/`. Run it from workspace/protocol:
 *
 *   npx tsx fixtures/engine-loop/build.ts
 */

export const START = '2026-11-17T13:00:00Z';

export interface Built {
  events: BoardEvent[];
  checkpoints: Checkpoint[];
  /** `log.jsonl`: one event per line. */
  log: string;
  /** `checkpoints.json`. */
  checkpointsJson: string;
  assets: Record<string, Buffer>;
}

export class Refusal extends Error {
  constructor(
    readonly index: number,
    readonly rule: string,
    readonly reason: string,
  ) {
    super(`beat ${index} refused under ${rule}: ${reason}`);
  }
}

const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');

/** The whole fixture in memory. Throws a `Refusal` at the first beat the rules refuse. */
export function buildFixture(): Built {
  let state = emptyState();
  let ms = Date.parse(START);
  const events: BoardEvent[] = [];
  const checkpoints: Checkpoint[] = [];
  story.forEach((beat, index) => {
    if (index > 0) ms += (beat.gap ?? 2) * 1000;
    const r = admit(state, beat.draft, beat.by, iso(ms));
    if (!r.ok) throw new Refusal(index, r.rule, r.reason);
    state = r.state;
    events.push(r.event);
    if (beat.checkpoint) checkpoints.push({ ...beat.checkpoint, after: r.event.id });
  });
  return {
    events,
    checkpoints,
    log: events.map(formatEvent).join('\n') + '\n',
    checkpointsJson: JSON.stringify(checkpoints, null, 2) + '\n',
    assets: makeAssets(),
  };
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  let built: Built;
  try {
    built = buildFixture();
  } catch (e) {
    if (e instanceof Refusal) {
      const beat = story[e.index];
      console.error(`beat ${e.index} (${beat?.by} ${beat?.draft.type}) refused`);
      console.error(`rule:   ${e.rule}`);
      console.error(`reason: ${e.reason}`);
      process.exit(1);
    }
    throw e;
  }
  mkdirSync(join(here, 'assets'), { recursive: true });
  writeFileSync(join(here, 'log.jsonl'), built.log);
  writeFileSync(join(here, 'checkpoints.json'), built.checkpointsJson);
  for (const [path, bytes] of Object.entries(built.assets)) writeFileSync(join(here, path), bytes);
  console.log(`wrote ${built.events.length} events, ${built.checkpoints.length} checkpoints, ${Object.keys(built.assets).length} assets`);
  for (const c of built.checkpoints) console.log(`  screen ${c.screen} ${c.name}: after ${c.after}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
