import type { Anchor, BoardState, Box, EventDraft, Id, NoteItem, Target } from '@keel/protocol';
import { chapterInWorkOn } from '@keel/protocol';

/** A draft as the app sends it: the server sets `by` from the connection. */
export type Draft = EventDraft extends infer T ? (T extends unknown ? Omit<T, 'by'> : never) : never;

/**
 * The chapter a new mark belongs to, or undefined when no chapter is in work: the one in work
 * on the canvas the state shows (`chapterInWorkOn`). An open mark on a built idea does not
 * hide an idea there that is not built.
 */
export function chapterInWork(state: BoardState): Id | undefined {
  const canvas = state.canvasOrder[state.canvasOrder.length - 1];
  return canvas ? chapterInWorkOn(state, canvas) : undefined;
}

/** A chapter's title from a note: its first six words. */
export function titleFromText(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean).slice(0, 6);
  const title = words.join(' ').replace(/[\s,;:.\-]+$/, '');
  return (title || 'A new idea').slice(0, 90);
}

/** A chapter id from its title, unused on this board: "one-engine-many-requests". */
export function chapterId(title: string, state: BoardState): Id {
  const base =
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'idea';
  // A deleted idea's id is used once (record 0014): a new one never takes it.
  const taken = (id: Id) => !!state.chapters[id] || !!state.removedChapters[id];
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!taken(id)) return id;
  }
}

/**
 * The next free id for an owner's mark: "m" and one more than the highest number in use.
 * `reserved` holds ids already sent but not yet back from the server.
 */
export function nextMarkId(state: BoardState, reserved: ReadonlySet<string> = new Set()): Id {
  let max = 0;
  for (const id of [...state.itemOrder, ...reserved]) {
    const m = /^m(\d+)$/.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  let n = max + 1;
  while (state.items[`m${n}`] || reserved.has(`m${n}`)) n++;
  return `m${n}`;
}

export interface NewNote {
  id: Id;
  text: string;
  box: Box;
  on?: Target;
  anchor?: Anchor;
}

/**
 * What the owner's new note sends: the note, and before it a `chapter.open` when no chapter
 * is in work, titled with the note's first six words.
 */
export function noteDrafts(state: BoardState, note: NewNote): Draft[] {
  const out: Draft[] = [];
  let chapter = chapterInWork(state);
  if (!chapter) {
    const title = titleFromText(note.text);
    chapter = chapterId(title, state);
    out.push({ type: 'chapter.open', chapter, title });
  }
  const item: NoteItem = {
    id: note.id,
    kind: 'note',
    box: note.box.map((n) => Math.round(n)) as unknown as Box,
    text: note.text,
    ...(note.on ? { on: note.on } : {}),
    ...(note.anchor ? { anchor: note.anchor } : {}),
  };
  out.push({ type: 'item.add', chapter, item });
  return out;
}
