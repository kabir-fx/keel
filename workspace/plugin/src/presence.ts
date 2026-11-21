import type { PictureKind, PresenceDoing, PresencePicture, PresenceUpdate } from '@keel/protocol';
import { EventId, Id, PICTURE_KINDS } from '@keel/protocol';

/**
 * What the presence pill shows while the agent calls a tool. The board tools report it
 * themselves when a call runs, and the hosted link reads it from the stream, so both say the
 * same thing and neither one overwrites the other's cursor.
 *
 * The link reads a call twice. When the model begins to write it, the link knows only the tool:
 * `writingPresence` says what the call does and names no place, so the cursor stays where it
 * is. For a `board_post` it becomes more exact as soon as the input written so far holds the
 * kind of its first picture, and again once it holds that picture's title. When the call is
 * whole, `toolPresence` says the same and puts the cursor on what the call answers.
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

/** What each tool does, in the pill's words, and what that keeps the agent busy with. */
const TOOLS: Record<string, { note: string; doing: PresenceDoing }> = {
  board_read: { note: 'reading the board', doing: 'reading' },
  board_post: { note: 'drawing', doing: 'drawing' },
  board_answer: { note: 'answering', doing: 'writing' },
  board_model: { note: 'drawing the model', doing: 'drawing' },
  board_part: { note: 'moving a part', doing: 'drawing' },
  board_update: { note: 'writing an update', doing: 'writing' },
  Read: { note: 'reading the code', doing: 'reading' },
  Grep: { note: 'reading the code', doing: 'reading' },
  Glob: { note: 'reading the code', doing: 'reading' },
};

/** What the link reports when the model begins to think. */
export const THINKING_PRESENCE = { state: 'drawing', note: 'thinking', doing: 'thinking' } as const satisfies PresenceUpdate;

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

/** The most of a title presence takes, as `PresencePicture` in protocol/src/wire.ts says. */
const TITLE_MAX = 120;

/** A title cut to what presence takes, with an ellipsis, never between the halves of one character. */
function fitTitle(title: string): string {
  if (title.length <= TITLE_MAX) return title;
  const cut = title.slice(0, TITLE_MAX - 1);
  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}…`;
}

/** The first picture as presence names it: a kind the contract knows, and its title when that is a string with something in it. */
function pictureOf(kind: unknown, title: unknown): PresencePicture | undefined {
  if (!isPictureKind(kind)) return undefined;
  return typeof title === 'string' && title !== '' ? { kind, title: fitTitle(title) } : { kind };
}

/** What a call of this tool says, and for a post what it says of its first picture. Never a place. */
function callSays(name: string, picture: PresencePicture | undefined): PresenceUpdate {
  const out: PresenceUpdate = { state: 'drawing' };
  const tool = TOOLS[name];
  const note = picture ? KIND_NOTES[picture.kind] : tool?.note;
  if (note) out.note = note;
  if (tool) out.doing = tool.doing;
  if (picture) out.picture = picture;
  return out;
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
  let picture: PresencePicture | undefined;
  if (name === 'board_post' && Array.isArray(args.pictures)) {
    // The first picture, as `postPictureSoFar` reads it while the call is written.
    const first = (args.pictures[0] as { picture?: { kind?: unknown; title?: unknown } } | undefined)?.picture;
    picture = pictureOf(first?.kind, first?.title);
    for (const p of args.pictures as Array<Record<string, unknown>>) {
      item = itemId(p?.id) ?? firstItem(p?.answers) ?? itemId(p?.near);
      if (item) break;
    }
  } else {
    item = firstItem(args.answers);
  }
  const out = callSays(name, picture);
  if (item) out.cursor = { item };
  return out;
}

/**
 * The presence for a tool call the model is still writing, from its input so far: what the tool
 * does, and for a `board_post` its first picture as far as the input holds it whole.
 * Never a cursor: where the call points is known only when it is whole.
 */
export function writingPresence(tool: string, inputSoFar: string): PresenceUpdate {
  const name = bareToolName(tool);
  return callSays(name, name === 'board_post' ? postPictureSoFar(inputSoFar) : undefined);
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

/** The key of the first picture being read when the open containers are `{"pictures": [{"picture": {"<key>": …`. */
function firstPictureKey(open: readonly Open[]): string | undefined {
  if (open.length !== 4) return undefined;
  const [root, list, entry, spec] = open as [Open, Open, Open, Open];
  const there =
    !root.array && root.key === 'pictures' &&
    list.array && list.index === 0 &&
    !entry.array && entry.key === 'picture' &&
    !spec.array;
  return there ? spec.key : undefined;
}

/**
 * A `board_post`'s first picture, from the start of its input as the model writes it:
 * `{"pictures": [{"picture": {"kind": "text", "title": "…", …`. Cut anywhere, with any spacing
 * and keys in any order. The kind is given only when its value is whole and is one the contract
 * knows, and the title only once the kind is given and the title's string is whole; any doubt
 * gives nothing. A `kind` or `title` anywhere else, such as an option inside a spread, is not it.
 */
export function postPictureSoFar(partial: string): PresencePicture | undefined {
  const open: Open[] = [];
  let kind: unknown;
  let title: unknown;
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
      // A string cut short, or one that is not proper JSON, ends the reading: what it holds is unknown.
      const end = stringEnd(partial, i);
      if (end < 0) break;
      let text: unknown;
      try {
        text = JSON.parse(partial.slice(i, end + 1));
      } catch {
        break;
      }
      if (top && !top.array && top.keyNext) top.key = String(text);
      else {
        const key = firstPictureKey(open);
        if (key === 'kind') {
          if (!isPictureKind(text)) return undefined;
          kind = text;
        } else if (key === 'title') title = text;
      }
      i = end;
    }
    // Anything else is spacing, or a number, true, false or null: none of it moves the place.
  }
  return pictureOf(kind, title);
}
