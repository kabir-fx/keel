import type { ClipboardEvent, KeyboardEvent, MouseEvent as ReactMouseEvent, RefObject, UIEvent } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { TAB_TEXT, fieldHeight, fitPaste, plainText, roomIn } from './fieldText';
import { typing } from './input/keys';

/**
 * A field the owner types in on the board: a note, or the few words on a box, an arrow or a
 * pin. This is where a field ends. On this board a saved note is posted to the log, and that
 * wakes the agent, so "the owner is done" and "the owner looked away" must never be mixed up:
 * the owner's words are never lost, and never sent by accident.
 *
 * Every way a field can end, and what happens then. "Posts" is the field's `onCommit` and
 * "closes" its `onCancel`; what those do for a note is in `board/notes.tsx`, and for a label in
 * `board/markLabel.tsx`. Each row has its tests in `test/notes.test.tsx` and `e2e/text.spec.ts`.
 *
 * | What happens                  | A new note                   | A note being changed         | A label on a box or an arrow  | A pin's label                |
 * |-------------------------------|------------------------------|------------------------------|-------------------------------|------------------------------|
 * | Enter                         | posts it; with no words it   | posts the change; with no    | posts the mark with the words | posts the pin with the words |
 * |                               | only closes                  | words the note stays as it   | (none is fine)                | (none is fine)               |
 * |                               |                              | was                          |                               |                              |
 * | Shift+Enter                   | a new line                   | a new line                   | as Enter                      | as Enter                     |
 * | Enter, Esc or Tab while an    | the input method's key: nothing closes, and the board types nothing                                                        |
 * | input method composes         |                                                                                                                            |
 * | Esc                           | closes, posts nothing; Undo  | closes, the note as it was;  | posts the mark with no words; | drops the pin, posts         |
 * |                               | opens it again: same place,  | Undo opens it again with     | Undo takes the mark off, and  | nothing; Undo brings it back |
 * |                               | same thing, same words       | what was typed               | once more brings the field    | with its words               |
 * |                               |                              |                              | back with the words           |                              |
 * | Esc on the field Undo opened, | puts it away, and nothing more: no step is recorded, nothing is posted (a box or an arrow is not posted again), the redo   |
 * | with its words as Undo        | list is left as it is, and the words are let go from the browser. So the next Undo goes on to the step before. Words       |
 * | brought them                  | changed in it, then Esc: a new step with the new words, as above. A field that came back any other way (a refusal, a       |
 * |                               | reload, a field a tool sent back in line) records its step on Esc, as above                                                |
 * | Redo of the step of an Esc    | changes nothing on the board (no field is open by then: only then does the board hear a key) and says again what the Esc   |
 * |                               | said. The step is Undo's again, and Undo opens the field with the words once more                                          |
 * | A press on the board          | posts, as Enter, one frame after the press, once. It is saved from the press itself, so it does not wait for a blur. The   |
 * |                               | board's tools do nothing with the press: the dispatcher turns it away while a field is open. A click on a button inside a  |
 * |                               | picture (a choice's option, "Next step") still presses it, as on a panel: the owner pressed it on purpose                  |
 * | A press on a panel, or        | posts, as Enter, the same way. The press still does what it does there (it picks a tool, it folds a panel)                 |
 * | anywhere else outside         |                                                                                                                            |
 * | A press on the field's own    | the field stays open and keeps the focus                                                                                   |
 * | paper                         |                                                                                                                            |
 * | Tab, Shift+Tab                | Tab types spaces. Neither leaves the field, so neither can post                                                            |
 * | The focus goes elsewhere on   | posts, as Enter: a blur with the page still in focus                                                                       |
 * | the page some other way       |                                                                                                                            |
 * | The window loses focus        | stays open with its words, and nothing is posted. The words are written to the browser at once. The focus is in the field  |
 * | The tab is hidden             | again when the owner is back                                                                                               |
 * | A reload, a closed tab, a     | nothing is posted. The words, written to the browser a little after each key and when the page is hidden, open the field   |
 * | crash                         | again after the reload: the same place, on the same thing (a label: the same mark, drawn again), and the board says so. A  |
 * |                               | field with no words is not kept, and a fixture keeps nothing. Each tab keeps its own: a page never opens, nor clears, what |
 * |                               | another open tab is typing, and what a tab that is gone was typing opens in the next page on the board. What the board has |
 * |                               | by then is not opened again, and a note on a thing this board does not have comes back on the ground                       |
 * | The board refuses it          | the field opens again where it was, with the words, and the board says why. On its way and refused, the words stay in the  |
 * |                               | browser. If the owner is typing in another field by then, or a press is under way on the board, it waits for that to end,  |
 * |                               | and never takes its focus. A field a tool opens over another sends that one back in line, with its words                   |
 * | The board took it, but its    | it keeps the id of its first post. Posted again, it is the note or the mark the board holds: nothing is posted twice, and  |
 * | answer was lost               | words changed since go onto it                                                                                             |
 * | What it is on is taken off    | nothing changes: the board   | stays open, and the board    | nothing changes: the mark is  | nothing changes: the pin is  |
 * | the board while it is typed   | takes a note on a thing that | says so; Enter posts the     | read against what is on the   | posted as it was placed      |
 * |                               | has left                     | words as a new note in the   | board when the owner is done  |                              |
 * |                               |                              | same place                   |                               |                              |
 * | The board itself leaves the   | nothing is posted: a field that goes any way but by its own ending posts nothing. The words stay in the browser            |
 * | page                          |                                                                                                                            |
 *
 * The agent cannot take the owner's note off the board (the contract's rule R6): a note that
 * leaves while it is changed left from another page of the owner's. It is handled the same.
 *
 * The rows down to the hidden tab are handled here. Esc's Undo and Redo, the words kept in the
 * browser, a refusal, a lost answer and a thing taken off are the work of whoever opened the
 * field: `useNotes` for a note, `useMarkLabel` for a label, and `useOneField` under both.
 *
 * The rules are Excalidraw's where saving is harmless there and here alike (the press outside
 * that saves on the next frame, the 5% of room, the scroll put back, Tab as spaces, a paste made
 * plain), read in its packages/excalidraw/wysiwyg/textWysiwyg.tsx at commit 9fbeaed and written
 * again for the board. Where Excalidraw saves on Esc, on every blur and when the page closes,
 * the board does not: there a save is free, here it is a message to the agent.
 */

/** What a field needs from whoever opens it. */
export interface FieldNeeds {
  /** The most letters the field holds. */
  max: number;
  /** True for a note: Shift+Enter starts a new line. False for a label: a few words, with no line ends. */
  lines: boolean;
  /** The owner is done: the words are theirs to post. Called once, and never after `onCancel`. */
  onCommit(text: string): void;
  /** Esc: close the field and post no words. Called once, and never after `onCommit`. */
  onCancel(text: string): void;
  /** The words changed. Called on every change: it must be light. */
  onType?(text: string): void;
  /** A paste did not fit in the field, and was cut. */
  onCut?(): void;
}

/** A field's handlers: `paper` for the element round it that is part of it, `area` for the textarea itself. */
export interface Field {
  paper: {
    ref: RefObject<HTMLDivElement | null>;
    onMouseDown(e: ReactMouseEvent): void;
  };
  area: {
    ref: RefObject<HTMLTextAreaElement | null>;
    onInput(): void;
    onBlur(): void;
    onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void;
    onPaste(e: ClipboardEvent<HTMLTextAreaElement>): void;
    onScroll(e: UIEvent<HTMLTextAreaElement>): void;
  };
}

/**
 * Put text in the field at the caret, as the owner's own typing. `insertText` is the one way
 * that keeps the field's own Undo; where a browser has none, the text is set and the field told.
 */
function typeInto(el: HTMLTextAreaElement, text: string): void {
  if (!text) return;
  if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, text)) return;
  const start = el.selectionStart;
  el.setRangeText(text, start, el.selectionEnd, 'end');
  el.setSelectionRange(start + text.length, start + text.length);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** The field takes a key for itself: it does nothing else in the browser, and the board's keys never hear it. */
function take(e: KeyboardEvent): void {
  e.preventDefault();
  e.stopPropagation();
}

/** The wiring of one field. Spread `paper` on the element round the textarea and `area` on the textarea. */
export function useField(needs: FieldNeeds): Field {
  const paper = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  /** True once the field has ended, in any way. Nothing that comes after is heard, so it ends once. */
  const done = useRef(false);
  const latest = useRef(needs);
  latest.current = needs;

  const end = useCallback((how: 'commit' | 'cancel') => {
    if (done.current) return;
    done.current = true;
    const text = plainText(area.current?.value ?? '', latest.current.lines);
    if (how === 'commit') latest.current.onCommit(text);
    else latest.current.onCancel(text);
  }, []);

  /** Fit the field to its text, with a little room, and put back any scroll the browser made. */
  const grow = useCallback(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = '0px';
    const { height, spare } = fieldHeight(el.scrollHeight);
    el.style.height = `${height}px`;
    el.style.marginBottom = `${-spare}px`;
    el.scrollTop = 0;
    el.scrollLeft = 0;
  }, []);

  useLayoutEffect(() => {
    const el = area.current;
    done.current = false;
    if (el) {
      grow();
      // A field that comes back by itself (a refusal, a reload) never takes the focus from one the owner is typing in.
      const elsewhere = document.activeElement !== el && typing(document.activeElement);
      if (!elsewhere) {
        el.focus({ preventScroll: true });
        el.setSelectionRange(el.value.length, el.value.length);
      }
    }
    // A field that leaves the page has ended, also when the board itself is torn down with the
    // field open: a frame asked for by a press just before must not post what is left of it.
    return () => {
      done.current = true;
    };
  }, [grow]);

  useEffect(() => {
    // A press outside the field saves it, from the press itself and one frame later: the blur
    // that also saves does not always come, and the press must first be turned away by the
    // board. A frame that comes after the field has ended some other way ends nothing.
    const outside = (e: PointerEvent) => {
      const within = e.target instanceof Node && (paper.current ?? area.current)?.contains(e.target);
      if (!done.current && !within) requestAnimationFrame(() => end('commit'));
    };
    window.addEventListener('pointerdown', outside, true);
    return () => window.removeEventListener('pointerdown', outside, true);
  }, [end]);

  return {
    paper: {
      ref: paper,
      // A press on the paper round the words keeps the focus in the field. (The board turns
      // every press away while a field is open, so the press does nothing there either.)
      onMouseDown: (e) => {
        if (e.target !== area.current) e.preventDefault();
      },
    },
    area: {
      ref: area,
      onInput: () => {
        grow();
        latest.current.onType?.(plainText(area.current?.value ?? '', latest.current.lines));
      },
      onBlur: () => {
        // Looked away (another window, another tab): the page has lost the focus, and the field
        // is still the one it would come back to. Only a blur inside the page is the owner leaving.
        if (document.hasFocus() && document.activeElement !== area.current) end('commit');
      },
      onKeyDown: (e) => {
        // While an input method composes a letter, its keys are its own. Safari says so only by the key code.
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === 'Escape') {
          take(e);
          end('cancel');
        } else if (e.key === 'Enter' && !(latest.current.lines && e.shiftKey)) {
          take(e);
          end('commit');
        } else if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          take(e);
          const el = e.currentTarget;
          if (!e.shiftKey) typeInto(el, TAB_TEXT.slice(0, roomIn(latest.current.max, el.value.length, el.selectionEnd - el.selectionStart)));
        }
      },
      onPaste: (e) => {
        const el = e.currentTarget;
        const pasted = e.clipboardData.getData('text/plain');
        // A picture or a file on the clipboard is nothing a field can hold.
        if (!pasted) return;
        e.preventDefault();
        e.stopPropagation();
        const fit = fitPaste(pasted, roomIn(latest.current.max, el.value.length, el.selectionEnd - el.selectionStart), latest.current.lines);
        typeInto(el, fit.text);
        if (fit.cut) latest.current.onCut?.();
      },
      onScroll: (e) => {
        const el = e.currentTarget;
        if (el.scrollTop === 0 && el.scrollLeft === 0) return;
        // The browser scrolled the field to show the caret: the field grows to its text instead.
        grow();
      },
    },
  };
}
