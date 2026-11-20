import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BoardState, Checkpoint, PictureItem } from '@keel/protocol';
import { parseLog, pictureItems, replay } from '@keel/protocol';

/** The golden fixture, read from the protocol package, as the board stood at each checkpoint. */

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'protocol', 'fixtures', 'engine-loop');
const { events } = parseLog(readFileSync(join(dir, 'log.jsonl'), 'utf8'));
export const checkpoints = JSON.parse(readFileSync(join(dir, 'checkpoints.json'), 'utf8')) as Checkpoint[];

export function at(screen: number): { state: BoardState; cp: Checkpoint } {
  const cp = checkpoints.find((c) => c.screen === screen);
  if (!cp) throw new Error(`no checkpoint ${screen}`);
  const end = events.findIndex((e) => e.id === cp.after);
  return { state: replay(events.slice(0, end + 1)), cp };
}

export function pictures(state: BoardState): PictureItem[] {
  return pictureItems(state).map((s) => s.item);
}

export function item(state: BoardState, id: string): PictureItem {
  const s = state.items[id];
  if (!s || s.item.kind !== 'picture') throw new Error(`"${id}" is not a picture`);
  return s.item;
}
