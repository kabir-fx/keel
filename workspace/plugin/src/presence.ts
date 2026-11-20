import type { PresenceUpdate } from '@keel/protocol';
import { EventId, Id } from '@keel/protocol';

/**
 * What the presence pill shows while the agent calls a tool. The board tools report it
 * themselves, and the hosted link reads it from the stream, so both say the same thing and
 * neither one overwrites the other's cursor.
 */

/** `mcp__board__board_post` and `mcp__plugin_x_board__board_post` are both `board_post`. */
export function bareToolName(name: string): string {
  const i = name.lastIndexOf('__');
  return name.startsWith('mcp__') && i >= 0 ? name.slice(i + 2) : name;
}

/** An item the cursor can sit on: an item id, and not an act, which is an event id. */
function itemId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return Id.safeParse(value).success && !EventId.safeParse(value).success ? value : undefined;
}

function firstItem(list: unknown): string | undefined {
  if (!Array.isArray(list)) return undefined;
  for (const v of list) {
    const id = itemId(v);
    if (id) return id;
  }
  return undefined;
}

const NOTES: Record<string, string> = {
  board_read: 'reading the board',
  board_post: 'drawing',
  board_answer: 'answering',
  board_model: 'drawing the model',
  board_part: 'moving a part',
  board_update: 'writing an update',
  Read: 'reading the code',
  Grep: 'reading the code',
  Glob: 'reading the code',
};

/** The presence for one tool call: `drawing`, with the cursor on the item it answers. */
export function toolPresence(tool: string, input: unknown): PresenceUpdate {
  const name = bareToolName(tool);
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = {};
    }
  }
  const args = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  let item: string | undefined;
  if (name === 'board_post' && Array.isArray(args.pictures)) {
    for (const p of args.pictures as Array<Record<string, unknown>>) {
      item = itemId(p?.id) ?? firstItem(p?.answers) ?? itemId(p?.near);
      if (item) break;
    }
  } else {
    item = firstItem(args.answers);
  }
  const out: PresenceUpdate = { state: 'drawing' };
  const note = NOTES[name];
  if (note) out.note = note;
  if (item) out.cursor = { item };
  return out;
}
