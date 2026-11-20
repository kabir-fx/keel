import type { Anchor, Box, Id, Target } from '@keel/protocol';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { ToolId } from '../chrome';
import { targetAt } from '../dom';
import { noteDrafts } from '../drafts';
import { NOTE_MAX } from '../fieldText';
import { NOTE_HEIGHT_SLACK } from '../input/constants';
import { keyWords } from '../input/keytable';
import { NoteFace, tiltOf } from '../items';
import { NoteEditor } from '../NoteEditor';
import type { NoteDraft } from '../noteDraft';
import { readNoteDraft } from '../noteDraft';
import { NOTE_WHERE } from '../tools/note';
import type { NoteTarget } from '../tools/types';
import type { Board } from './context';
import type { Opening } from './oneField';
import { HAD_IT, asUndoLeftIt, useOneField } from './oneField';

/** How wide a new note is, in world units. */
export const NOTE_WIDTH = 320;
/** The least height of a note, in world units. */
const NOTE_MIN_HEIGHT = 48;

/** About how tall a note of this text is drawn, in world units: the hand is about 24 letters a line. */
export const noteHeight = (text: string) => 28 + 30 * Math.max(1, text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 24)), 0));

/** What the board says when Esc closes a new note with words in it: they were not sent, and they are not lost. */
export const noteClosed = () => `Closed, and not sent. Undo (${keyWords('undo')}) opens it again with your words.`;
/** What the board says when Esc closes a change to a note. */
export const changeClosed = () => `Closed, and your note is as it was. Undo (${keyWords('undo')}) opens it again with what you typed.`;
/** What the board says when the note being changed is taken off the board under the owner's hand. */
export const NOTE_GONE = 'That note was taken off the board. Your words are still here: Enter posts them as a new note, Esc closes them.';
/** What the board says when a reload brings back the note that was being typed: it is open again, and still not sent. */
export const NOTE_BACK = 'The note you were typing is back, as you left it. Enter posts it, Esc closes it.';
/** What the board says when a paste was cut to what a note holds. */
export const NOTE_FULL = `A note holds ${NOTE_MAX.toLocaleString('en-US')} letters. The rest of what you pasted was left out.`;

/** A new note being written: where, and on what. */
interface NewNote {
  mode: 'new';
  at: [number, number];
  on?: Target;
  anchor?: Anchor;
  /**
   * The id it was first posted with. Every post of it uses that id, and it is held for it until
   * the board has the note, so an answer that was lost never makes a second note: once the
   * board holds the id, the note is that note, and the owner's words are a change to it.
   */
  id?: Id;
}

/** One of the owner's notes being changed: where it is drawn, and how it is tilted. */
interface NoteChange {
  mode: 'edit';
  id: Id;
  shown: Box;
  rot: number;
}

/** A note that is being written: a new one, or one of the owner's being changed. */
type Editor = NewNote | NoteChange;

/** A new note between Enter and the log: drawn where it will be, so nothing blinks. */
interface Ghost {
  box: Box;
  text: string;
  rot: number;
}

/** What the open field is drawn with, and what its endings do. */
interface NoteField {
  key: number;
  at: [number, number];
  width: number;
  rot: number;
  initial: string;
  onCommit(text: string, height: number): void;
  onCancel(text: string): void;
  onType(text: string): void;
  onCut(): void;
}

/** The notes being written on one board. */
export interface Notes {
  /** The note being written; null when none is. */
  editor: Editor | null;
  /** The field of the note being written; null when none is. */
  field: NoteField | null;
  ghost: Ghost | null;
  /** Open the editor for a new note at a world point, on what it was clicked on. */
  open(at: [number, number], target: NoteTarget): void;
  /** A double click with Select on one of the owner's notes opens it for a change. */
  onDoubleClick(e: ReactMouseEvent<HTMLDivElement>): void;
  /** True while a note's field is open, also before React has drawn it: a label on its way back waits for it. */
  isOpen(): boolean;
}

/** A new note, with only what it has. */
const newNote = (at: [number, number], on: Target | undefined, anchor: Anchor | undefined, id: Id | undefined): NewNote => ({
  mode: 'new',
  at,
  ...(on ? { on } : {}),
  ...(anchor ? { anchor } : {}),
  ...(id ? { id } : {}),
});

/** What is kept in the browser for a note with these words. */
const draftOf = (e: Editor, text: string): NoteDraft =>
  e.mode === 'new'
    ? { text, at: e.at, ...(e.on ? { on: e.on } : {}), ...(e.anchor ? { anchor: e.anchor } : {}), ...(e.id ? { id: e.id } : {}) }
    : { text, at: [e.shown[0], e.shown[1]], edit: e.id };

/**
 * Writing notes: where the editor is open, posting a new note or a change to one, and keeping
 * the owner's words whatever happens to the field. What each ending of the field does is in the
 * table in `field.ts`; this is the part that is the notes' own:
 *
 * - Esc posts nothing. The words go to Undo, which opens the field again with them.
 * - The board refuses a note: the field opens again with the words.
 * - A new note keeps the id it was first posted with, whatever becomes of its field, so the
 *   board never holds it twice: a post whose answer was lost, posted again, is that note.
 * - A reload: the words are kept in the browser as they are typed (`remember`), and the field
 *   opens again with them. A posted note and a closed one keep nothing, and a note the board
 *   has by then is not opened again.
 * - The note being changed is taken off the board: its words go up as a new note in its place.
 *
 * One field is open at a time (`useOneField`): a note that comes back while a note or a label
 * is open waits for it to close.
 */
export function useNotes(board: Board, tool: ToolId, remember = false): Notes {
  const [ghost, setGhost] = useState<Ghost | null>(null);
  /** The opening the owner was last told has lost its note. */
  const told = useRef(0);

  /** The note on the board that a change is of, while it is there. */
  const noteOf = (id: Id) => {
    const s = board.state().items[id];
    return s && !s.removed && s.item.kind === 'note' ? s.item : undefined;
  };

  /** Are these words worth keeping for the owner: something typed, and for a change to a note, not the note as it stands? */
  const worth = (e: Editor, text: string): boolean => {
    const words = text.trim();
    if (!words) return false;
    return e.mode === 'new' || words !== noteOf(e.id)?.text.trim();
  };

  /**
   * An editor as the board is now:
   * - a note that moved while its change waited is changed where it is;
   * - a change to a note that has left stays where the note was: the board says so when it
   *   opens, and Enter posts its words as a new note there;
   * - a new note whose id the board holds is that note, and its words are a change to it. An id
   *   the board holds for anything else (a note taken off since, another tab's mark) is not
   *   its own any more: it takes a new one when it is posted.
   */
  const asItIsNow = (e: Editor): Editor => {
    const note = e.id ? noteOf(e.id) : undefined;
    if (e.mode === 'edit') return note ? { ...e, shown: board.boxes().get(e.id) ?? e.shown, rot: note.rot ?? tiltOf(e.id) } : e;
    if (!e.id) return e;
    if (note) return { mode: 'edit', id: e.id, shown: board.boxes().get(e.id) ?? note.box, rot: note.rot ?? tiltOf(e.id) };
    return board.state().items[e.id] ? newNote(e.at, e.on, e.anchor, undefined) : e;
  };

  /** Does the board hold this note with these words? Then it was posted, though its answer may have been lost. */
  const hasIt = (e: Editor, text: string): boolean => {
    const now = asItIsNow(e);
    return now.mode === 'edit' && noteOf(now.id)?.text.trim() === text.trim();
  };

  /**
   * The note a kept draft is of, as the board is now. What it was on, if that is not on this
   * board (the board was made again under the same name), is left out: the note is on the
   * ground in the same place. An id the board does not hold was never taken, and is not held
   * on this page: the note takes a new one when it is posted.
   */
  const editorOf = (d: NoteDraft): Editor => {
    if (d.edit) return { mode: 'edit', id: d.edit, shown: [d.at[0], d.at[1], NOTE_WIDTH, NOTE_MIN_HEIGHT], rot: 0 };
    const items = board.state().items;
    const there = <T extends { item: Id }>(t: T | undefined) => (t && items[t.item] ? t : undefined);
    return newNote(d.at, there(d.on), there(d.anchor), d.id && items[d.id] ? d.id : undefined);
  };

  const one = useOneField<Editor, NoteDraft>({
    board,
    kind: 'note',
    draftBoard: () => (remember ? board.state().name || undefined : undefined),
    draftOf: (e, text) => (worth(e, text) ? draftOf(e, text) : undefined),
    readDraft: (key) => {
      const draft = readNoteDraft(key);
      if (!draft) return undefined;
      const e = editorOf(draft);
      // The board has these words already: the note, or the change, landed as the page went.
      return hasIt(e, draft.text) ? undefined : { of: asItIsNow(e), text: draft.text };
    },
    backLine: NOTE_BACK,
    // No note is open: is a label?
    free: () => !board.editing(),
    asNow: asItIsNow,
  });
  const { open } = one;

  // A click with the Note tool that lands on a panel cannot place a note: say where to click.
  useEffect(() => {
    if (tool !== 'note' || open) return;
    const down = (e: PointerEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!t || !t.closest('.chrome, .notices') || t.closest('.toolbar')) return;
      board.say(NOTE_WHERE);
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [tool, open, board]);

  // The note being changed has left the board, under the owner's hand or while its change
  // waited: say so, once, and leave the field as it is.
  useEffect(() => {
    if (!open || open.of.mode !== 'edit' || told.current === open.n || noteOf(open.of.id)) return;
    told.current = open.n;
    board.say(NOTE_GONE);
  });

  /**
   * A note that is posted or closed puts the Note tool down. Another tool the owner took in
   * hand meanwhile (the note came back by itself, or by Undo) stays.
   */
  const putNoteToolDown = () => {
    if (board.tool() === 'note') board.setTool('select');
  };

  const postNew = async (o: Opening<Editor>, e: NewNote, raw: string, height: number) => {
    const text = raw.trim();
    one.close();
    // No words: the note only closes. Nothing is kept for it either: the draft went with its last word.
    if (!text) return;
    putNoteToolDown();
    const id = e.id ?? board.newId();
    const sent = newNote(e.at, e.on, e.anchor, id);
    // On its way, the note is still only the owner's: its words are in the browser until the
    // board has them, with the id they went with, so a reload can tell whether it has them.
    one.keep(o, raw, sent);
    one.flush();
    const box: Box = [e.at[0], e.at[1], NOTE_WIDTH, Math.max(NOTE_MIN_HEIGHT, Math.round(height))];
    setGhost({ box, text, rot: tiltOf(id) });
    try {
      const drafts = noteDrafts(board.state(), { id, text, box, ...(e.on ? { on: e.on } : {}), ...(e.anchor ? { anchor: e.anchor } : {}) });
      if (await board.postNew(id, drafts)) {
        landed(o, id);
      } else if (hasIt(sent, text)) {
        // Refused only because the board holds its id: it took an earlier post whose answer was lost.
        landed(o, id);
        board.say(HAD_IT);
      } else {
        // A refused note comes back to the owner with its words and its id, so nothing is lost and nothing is posted twice.
        one.bringBack(sent, text);
      }
    } finally {
      setGhost(null);
    }
  };

  /** The board has the note: only now is its draft let go, and its id free. */
  const landed = (o: Opening<Editor>, id: Id) => {
    one.forget(o);
    board.freeId(id);
  };

  const postChange = async (o: Opening<Editor>, e: NoteChange, raw: string, height: number) => {
    const note = noteOf(e.id);
    // The note left the board while it was changed: the words go up as a new note in its place.
    if (!note) return postNew(o, newNote([e.shown[0], e.shown[1]], undefined, undefined, undefined), raw, height);
    one.close();
    const text = raw.trim();
    const h = Math.max(NOTE_MIN_HEIGHT, Math.round(height));
    const patch: { text?: string; box?: Box } = {};
    if (text && text !== note.text) patch.text = text;
    if (text && Math.abs(h - note.box[3]) > NOTE_HEIGHT_SLACK) patch.box = [note.box[0], note.box[1], note.box[2], h];
    // No words, or nothing changed: the note stays as it was, and nothing is posted.
    const changed = patch.text !== undefined || patch.box !== undefined;
    if (changed) one.flush();
    const refused = changed && !(await board.send({ type: 'item.update', item: e.id, patch })).ok;
    // A refused change comes back to the owner with what they typed, so nothing is lost.
    if (refused) one.bringBack(e, raw);
    else one.forget(o);
  };

  /**
   * Esc: nothing is posted. Words worth keeping go to Undo, which opens the field again with
   * them. Esc on that field, with the words as Undo brought them, only puts it away: the step is
   * on the redo list still. Redo then changes nothing, and says again what Undo does.
   */
  const cancel = (o: Opening<Editor>, raw: string) => {
    const e = o.of;
    one.close();
    one.forget(o);
    putNoteToolDown();
    if (asUndoLeftIt(o, raw) || !worth(e, raw)) return;
    const closed = e.mode === 'new' ? noteClosed : changeClosed;
    board.recordStep({
      what: e.mode === 'new' ? 'the note you closed' : 'the change to your note',
      undo: () => {
        one.bringBackByUndo(e, raw);
        return true;
      },
      redo: () => {
        board.say(closed());
        return true;
      },
    });
    board.say(closed());
  };

  const fieldOf = (o: Opening<Editor>): NoteField => {
    const e = o.of;
    return {
      key: o.n,
      at: e.mode === 'new' ? e.at : [e.shown[0], e.shown[1]],
      width: e.mode === 'new' ? NOTE_WIDTH : e.shown[2],
      rot: e.mode === 'new' ? 0 : e.rot,
      initial: o.text,
      onCommit: (text, height) => {
        // A new note the board has by now (an answer that was lost) is that note: Enter posts the words as a change to it, if they changed.
        const now = asItIsNow(e);
        void (now.mode === 'new' ? postNew(o, now, text, height) : postChange(o, now, text, height));
      },
      onCancel: (text) => cancel(o, text),
      onType: (text) => one.keep(o, text),
      onCut: () => board.say(NOTE_FULL),
    };
  };

  return {
    editor: open?.of ?? null,
    field: open ? fieldOf(open) : null,
    ghost,
    open: (at, { on, anchor }) => one.show(newNote(at, on, anchor, undefined), ''),
    onDoubleClick: (e) => {
      if (board.tool() !== 'select' || one.isOpen() || !board.isOwner) return;
      const id = targetAt(e.clientX, e.clientY)?.item;
      const note = id ? noteOf(id) : undefined;
      const shown = id ? board.boxes().get(id) : undefined;
      if (!id || !note || !shown) return;
      one.show({ mode: 'edit', id, shown, rot: note.rot ?? tiltOf(id) }, note.text);
    },
    isOpen: one.isOpen,
  };
}

/** The new note on its way to the log, drawn where it will be. */
export function NoteGhost({ ghost }: { ghost: Ghost | null }) {
  if (!ghost) return null;
  return (
    <div className="item item--note item--ghost" data-no-export style={{ left: ghost.box[0], top: ghost.box[1], width: ghost.box[2] }}>
      <NoteFace text={ghost.text} rot={ghost.rot} />
    </div>
  );
}

/**
 * The editor of the note being written, in the world layer: it follows pan and zoom with the
 * board. Each opening is an editor of its own (its key is the opening's number), so one never
 * takes over another's words.
 */
export function NoteEditing({ notes }: { notes: Notes }) {
  const f = notes.field;
  if (!f) return null;
  return <NoteEditor key={f.key} at={f.at} width={f.width} initial={f.initial} rot={f.rot} onCommit={f.onCommit} onCancel={f.onCancel} onType={f.onType} onCut={f.onCut} />;
}
