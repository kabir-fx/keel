import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildArrival } from './story';

/**
 * Write the arrival fixture's `log.jsonl` and `checkpoints.json` beside this file, from
 * `story.ts`. Run it from workspace/app, and check in what it writes:
 *
 *   npx tsx src/fixtures/arrival/build.ts
 */

const built = buildArrival();
writeFileSync(fileURLToPath(new URL('./log.jsonl', import.meta.url)), built.log);
writeFileSync(fileURLToPath(new URL('./checkpoints.json', import.meta.url)), built.checkpointsJson);
console.log(`wrote ${built.events.length} events, ${built.checkpoints.length} checkpoints`);
for (const c of built.checkpoints) console.log(`  ${c.screen} ${c.name}: after ${c.after}`);
