import type { Id, MarkItem, PinItem } from '@keel/protocol';
import { useEffect } from 'react';
import { LABEL_MAX, PIN_MAX } from '../fieldText';
import { keyWords } from '../input/keytable';
import { LabelEditor } from '../LabelEditor';
import type { Shape } from '../live';
import { arrowItem, boxItem } from '../marks';
import type { LabelDraft } from '../noteDraft';
import { readLabelDraft } from '../noteDraft';
import type { Label } from '../tools/types';
import type { FieldBoard, Opening } from './oneField';
import { HAD_IT, asUndoLeftIt, useOneField } from './oneField';

/** What the board says when Esc drops a pin that had words: they are not lost. */
export const pinDropped = () => `The pin is dropped. Undo (${keyWords('undo')}) brings it back with its words.`;

/** What the board says when a reload brings back the mark that was being labelled. */
export const LABEL_BACK = 'The mark you were labelling is back, with its words. Enter posts it.';

/** What the board says when a paste was cut to what a mark holds. */
export const labelFull = (max: number) => `A label holds ${max} letters. The rest of what you pasted was left out.`;

/** The most words a mark of this kind holds. */
const maxOf = (l: Label) => (l.kind === 'pin' ? PIN_MAX : LABEL_MAX);

/** The words a mark of this kind is posted with: as typed, trimmed and cut to what it holds. */
const wordsOf = (l: Label, raw: string) => raw.trim().slice(0, maxOf(l));

/** A drawn mark that waits for its words. */
interface Drawn {
  label: Label;
  /**
   * The id the mark was first posted with. Every post of it uses that id, and it is held for it
   * until the board has the mark, so an answer that was lost never makes a second mark. While
   * the board holds the mark (it took a post whose answer was lost, or Esc posted it with no
   * words and Undo brought the words back), the words go onto it.
   */
  mark?: Id;
}

/** What a label needs of the board: a field's, and Undo, which a step with nothing left to bring hands its press on to. */
export type LabelBoard = FieldBoard;

/** What the open field is drawn with, and what its endings do. */
interface LabelField {
  key: number;
  at: [number, number];
  placeholder: string;
  initial: string;
  max: number;
  onCommit(text: string): void;
  onCancel(text: string): void;
  onType(text: string): void;
  onCut(): void;
}

/** The label of the mark that was just drawn, on one board. */
export interface MarkLabels {
  /** The mark that waits for its words; null when none does. */
  label: Label | null;
  /** The field its words are typed in; null when no mark waits. */
  field: LabelField | null;
  /** Open the field for the words of a mark that is drawn and not posted yet. */
  open(label: Label): void;
}

/** A box or an arrow that waits for its words is drawn in the live layer, as it was while it was dragged. A pin draws itself. */
function shapeOf(l: Label): Shape | undefined {
  if (l.kind === 'box') return { kind: 'box', from: [l.box[0], l.box[1]], to: [l.box[0] + l.box[2], l.box[1] + l.box[3]] };
  if (l.kind === 'arrow') return { kind: 'arrow', from: l.from, to: l.to };
  return undefined;
}

/**
 * A box, an arrow or a pin is drawn first and labelled after: this keeps the drawn mark while
 * the owner types, and posts it with its words. What each ending of the field does is in the
 * table in `field.ts`; this is the part that is the labels' own:
 *
 * - Esc keeps a box or an arrow with no words; a pin is its words, so it goes. Words that were
 *   typed go to Undo, which brings the field back with them.
 * - The board refuses the mark: it is drawn again, and its field opens with the words. It keeps
 *   the id it was first posted with, so the board never holds it twice.
 * - A reload: the mark and its words are kept in the browser as they are typed (`remember`),
 *   and come back. A mark with no words keeps nothing, nor does one Esc posted with no words,
 *   and a mark the board has by then is not opened again.
 *
 * One field is open at a time (`useOneField`). `noteOpen` says a note's field is open: a label
 * on its way back waits for it, as it waits for a label that is open. A note on its way back
 * goes first: its hook runs before this one.
 */
export function useMarkLabel(board: LabelBoard, remember = false, noteOpen: () => boolean = () => false): MarkLabels {
  /** The words on the mark with this id, while the board holds it as a mark of this kind. */
  const held = (l: Label, id: Id | undefined): { text: string } | undefined => {
    const s = id ? board.state().items[id] : undefined;
    if (!s || s.removed || s.item.kind !== l.kind) return undefined;
    return { text: 'text' in s.item ? (s.item.text ?? '') : '' };
  };

  const one = useOneField<Drawn, LabelDraft>({
    board,
    kind: 'label',
    draftBoard: () => (remember ? board.state().name || undefined : undefined),
    // A mark with no words keeps nothing.
    draftOf: (d, text) => (text.trim() ? { label: d.label, text, ...(d.mark ? { mark: d.mark } : {}) } : undefined),
    readDraft: (key) => {
      const draft = readLabelDraft(key);
      if (!draft) return undefined;
      const there = held(draft.label, draft.mark);
      // The board has the mark with these words: it landed as the page went.
      if (there && there.text === wordsOf(draft.label, draft.text)) return undefined;
      // A mark the board does not hold was never taken, and its id is not held on this page: it takes a new one when it is posted.
      return { of: { label: draft.label, ...(there && draft.mark ? { mark: draft.mark } : {}) }, text: draft.text };
    },
    backLine: LABEL_BACK,
    free: () => !noteOpen(),
  });
  const { open } = one;

  // The mark that waits for its words is drawn in the live layer. One that came back by itself
  // (a refusal, a reload) is drawn again here, once it is the open one: whatever cleared the
  // live layer when the field before it closed has run by then.
  useEffect(() => {
    const shape = open ? shapeOf(open.of.label) : undefined;
    if (shape && !board.hand.get().shape) board.hand.set({ shape });
  }, [open, board]);

  const close = () => {
    one.close();
    board.hand.set({ shape: undefined });
  };

  /** The mark with these words, as it is posted: against what is on the board now. */
  const markOf = (l: Label, id: Id, raw: string): MarkItem => {
    const rects = board.measure();
    if (l.kind === 'box') return boxItem(id, l.box, rects, board.targetBox, raw);
    if (l.kind === 'arrow') return arrowItem(id, l.from, l.to, rects, board.targetBox, raw, l.ties);
    const words = wordsOf(l, raw);
    const { text: _old, ...rest } = l.pin;
    return { ...rest, id, ...(words ? { text: words } : {}) } satisfies PinItem;
  };

  /** The board has the mark: only now is its draft let go, and its id free. */
  const landed = (o: Opening<Drawn>, id: Id) => {
    one.forget(o);
    board.freeId(id);
  };

  /**
   * Post the mark with these words. It answers with the mark's id, or with nothing when the
   * board refused: the mark then comes back as it was drawn, with `back` in its field and its
   * id kept, so nothing the owner made is lost and nothing is posted twice.
   */
  const post = async (o: Opening<Drawn>, raw: string, back: string = raw): Promise<Id | undefined> => {
    const { label, mark } = o.of;
    close();
    const words = wordsOf(label, raw);
    const there = held(label, mark);
    if (there && mark) {
      // The board holds the mark: the words go onto it. No words leave it as it is.
      if (!words || words === there.text) {
        one.forget(o);
        return mark;
      }
      // On its way, the change is still only the owner's: its words are in the browser until the board has them.
      one.keep(o, raw);
      one.flush();
      const ok = (await board.send({ type: 'item.update', item: mark, patch: { text: words } })).ok;
      if (ok) one.forget(o);
      else one.bringBack(o.of, back);
      return ok ? mark : undefined;
    }
    // An id the board holds for something else (the mark, taken off since; another tab's) is not this mark's any more.
    const id = mark && !board.state().items[mark] ? mark : board.newId();
    const sent: Drawn = { label, mark: id };
    // On its way, the mark is still only the owner's: its words are in the browser until the
    // board has them, with the id it went with, so a reload can tell whether it has them.
    one.keep(o, raw, sent);
    one.flush();
    if (await board.postMark(markOf(label, id, raw))) {
      landed(o, id);
      return id;
    }
    if (held(label, id)?.text === words) {
      // Refused only because the board holds its id: it took an earlier post whose answer was lost.
      landed(o, id);
      board.say(HAD_IT);
      return id;
    }
    one.bringBack(sent, back);
    return undefined;
  };

  /**
   * Esc: a pin goes; a box or an arrow stays with no words. Words that were typed go to Undo.
   * Esc on the field Undo opened, with the words as Undo brought them, only puts it away: the
   * step is on the redo list still, and nothing is posted (the mark is not posted again). Redo
   * then changes nothing, and says again what the first Esc said.
   */
  const cancel = (o: Opening<Drawn>, raw: string) => {
    const { label } = o.of;
    if (asUndoLeftIt(o, raw)) {
      close();
      one.forget(o);
      return;
    }
    const typed = raw.trim() !== '';
    if (label.kind === 'pin') {
      close();
      one.forget(o);
      if (!typed) return;
      board.recordStep({
        what: 'the pin you dropped',
        undo: () => {
          one.bringBackByUndo(o.of, raw);
          return true;
        },
        redo: () => {
          board.say(pinDropped());
          return true;
        },
      });
      board.say(pinDropped());
      return;
    }
    // The words are recorded before the mark is posted, so the mark is the newer step: Undo
    // takes the mark off, and Undo again brings its field back with the words.
    const step: { mark?: Id } = {};
    const forgetWords = typed
      ? board.recordStep({
          what: label.kind === 'box' ? 'the words on your box' : 'the words on your arrow',
          undo: () => {
            one.bringBackByUndo({ label, ...(step.mark ? { mark: step.mark } : {}) }, raw);
            return true;
          },
          // The first Esc said nothing: the mark it posted is there to see.
          redo: () => true,
        })
      : undefined;
    void post(o, '', raw).then((mark) => {
      if (mark) step.mark = mark;
      // Refused: the field is back already, with the words in it. Their step has nothing more
      // to bring, so it leaves Undo's list and costs the owner no press.
      else forgetWords?.();
    });
  };

  const fieldOf = (o: Opening<Drawn>): LabelField => {
    const { label } = o.of;
    return {
      key: o.n,
      at: label.at,
      placeholder: label.kind === 'pin' ? 'A few words' : label.kind === 'box' ? 'A label, if you like' : 'Say what it means',
      initial: o.text,
      max: maxOf(label),
      onCommit: (text) => void post(o, text),
      onCancel: (text) => cancel(o, text),
      onType: (text) => one.keep(o, text),
      onCut: () => board.say(labelFull(maxOf(label))),
    };
  };

  return {
    label: open?.of.label ?? null,
    field: open ? fieldOf(open) : null,
    open: (label) => one.show({ label }, ''),
  };
}

/** The mark that waits for its words: a pin shown where it will be, and the field the words are typed in. */
export function MarkLabel({ labels }: { labels: MarkLabels }) {
  const { label, field: f } = labels;
  if (!label || !f) return null;
  return (
    <>
      {label.kind === 'pin' && (
        <div className="item item--pin item--ghost" data-no-export style={{ left: label.pin.box[0] + label.pin.at[0], top: label.pin.box[1] + label.pin.at[1] }}>
          <svg width="26" height="26" viewBox="0 0 20 20" aria-hidden="true" className="pin__icon">
            <path d="M10 18 C10 18 15 12.5 15 8.5 A5 5 0 0 0 5 8.5 C5 12.5 10 18 10 18 Z" />
            <circle cx="10" cy="8.5" r="1.8" />
          </svg>
        </div>
      )}
      <LabelEditor key={f.key} at={f.at} placeholder={f.placeholder} initial={f.initial} max={f.max} onCommit={f.onCommit} onCancel={f.onCancel} onType={f.onType} onCut={f.onCut} />
    </>
  );
}
