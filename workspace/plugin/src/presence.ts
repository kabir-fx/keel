import type { PictureKind, PresenceUpdate } from '@keel/protocol';
import { EventId, Id, PICTURE_KINDS } from '@keel/protocol';

/**
 * What the presence pill shows while the agent calls a tool. The board tools report it
 * themselves when a call runs, and the hosted link reads it from the stream, so both say the
 * same thing and neither one overwrites the other's cursor.
 *
 * The link reads a call twice. When the model begins to write it, the link knows only the tool:
 * `writingPresence` says what the call does and names no place, so the cursor stays where it
 * is. For a `board_post` the note becomes more exact as soon as the input written so far holds
 * the kind of its first picture. When the call is whole, `toolPresence` says the same note and
 * puts the cursor on what the call answers.
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

/**
 * The note for a `board_post` whose first picture is of this kind. It names the kinds as the
 * pictures package does (`KIND_WORDS` in pictures/src/Picture.tsx): the plugin does not depend
 * on that package, so the two tables must say the same thing. Only `free` reads differently,
 * because "drawing a drawing" says nothing.
 */
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

export function isPictureKind(value: unknown): value is PictureKind {
  return typeof value === 'string' && (PICTURE_KINDS as readonly string[]).includes(value);
}

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
  let kind: PictureKind | undefined;
  if (name === 'board_post' && Array.isArray(args.pictures)) {
    // The note names the first picture's kind, as `postKindSoFar` reads it while the call is written.
    const first = (args.pictures[0] as { picture?: { kind?: unknown } } | undefined)?.picture?.kind;
    if (isPictureKind(first)) kind = first;
    for (const p of args.pictures as Array<Record<string, unknown>>) {
      item = itemId(p?.id) ?? firstItem(p?.answers) ?? itemId(p?.near);
      if (item) break;
    }
  } else {
    item = firstItem(args.answers);
  }
  const out: PresenceUpdate = { state: 'drawing' };
  const note = kind ? KIND_NOTES[kind] : NOTES[name];
  if (note) out.note = note;
  if (item) out.cursor = { item };
  return out;
}

/**
 * The presence for a tool call the model is still writing, from its input so far: what the tool
 * does, and for a `board_post` the kind of its first picture once the input holds it whole.
 * Never a cursor: where the call points is known only when it is whole.
 */
export function writingPresence(tool: string, inputSoFar: string): PresenceUpdate {
  const name = bareToolName(tool);
  const out: PresenceUpdate = { state: 'drawing' };
  const kind = name === 'board_post' ? postKindSoFar(inputSoFar) : undefined;
  const note = kind ? KIND_NOTES[kind] : NOTES[name];
  if (note) out.note = note;
  return out;
}

/** One open object or array of the JSON read so far, and where in it the reading is. */
type Open = { array: true; index: number } | { array: false; key: string | undefined; keyNext: boolean };

/** The index of the quote that ends the string opening at `start`, or -1 when the text stops first. */
function stringEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '"') return i;
  }
  return -1;
}

/** True when the open containers are `{"pictures": [{"picture": {"kind": …` of the first picture. */
function atFirstKind(open: readonly Open[]): boolean {
  if (open.length !== 4) return false;
  const [root, list, entry, spec] = open as [Open, Open, Open, Open];
  return (
    !root.array && root.key === 'pictures' &&
    list.array && list.index === 0 &&
    !entry.array && entry.key === 'picture' &&
    !spec.array && spec.key === 'kind'
  );
}

/**
 * The kind of a `board_post`'s first picture, from the start of its input as the model writes
 * it: `{"pictures": [{"picture": {"kind": "text", …`. Cut anywhere, with any spacing and keys
 * in any order. A kind is given only when its value is whole and is one the contract knows;
 * any doubt gives nothing. A `kind` anywhere else, such as an option inside a spread, is not it.
 */
export function postKindSoFar(partial: string): PictureKind | undefined {
  const open: Open[] = [];
  for (let i = 0; i < partial.length; i++) {
    const ch = partial[i];
    const top = open[open.length - 1];
    if (ch === '{') {
      open.push({ array: false, key: undefined, keyNext: true });
    } else if (ch === '[') {
      open.push({ array: true, index: 0 });
    } else if (ch === '}' || ch === ']') {
      open.pop();
    } else if (ch === ':') {
      if (top && !top.array) top.keyNext = false;
    } else if (ch === ',') {
      if (top?.array) top.index++;
      else if (top) {
        top.key = undefined;
        top.keyNext = true;
      }
    } else if (ch === '"') {
      // A string cut short, or one that is not proper JSON, leaves the kind unknown.
      const end = stringEnd(partial, i);
      if (end < 0) return undefined;
      let text: unknown;
      try {
        text = JSON.parse(partial.slice(i, end + 1));
      } catch {
        return undefined;
      }
      if (top && !top.array && top.keyNext) top.key = String(text);
      else if (atFirstKind(open)) return isPictureKind(text) ? text : undefined;
      i = end;
    }
    // Anything else is spacing, or a number, true, false or null: none of it moves the place.
  }
  return undefined;
}
