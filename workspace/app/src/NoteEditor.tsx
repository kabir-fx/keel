import { useRef } from 'react';
import { useField } from './field';
import { NOTE_MAX } from './fieldText';

/**
 * A note being written, in the owner's hand. Enter or a press outside it saves it, Shift+Enter
 * starts a new line, and Esc closes it with nothing posted. Looking away (another window,
 * another tab) leaves it open as it is. Every way it can end is in the table in `field.ts`.
 *
 * It reports its height with its words, so the note's box fits its text.
 */
export function NoteEditor({
  at,
  width,
  initial,
  rot,
  onCommit,
  onCancel,
  onType,
  onCut,
}: {
  at: readonly [number, number];
  width: number;
  /** The words the field opens with: none for a new note, the note's own for a change, the owner's own again after a refusal. */
  initial: string;
  rot: number;
  /** The owner is done. `height` is the paper's, in world units. */
  onCommit: (text: string, height: number) => void;
  /** Esc: close with nothing posted. The words are handed over so they can be brought back. */
  onCancel: (text: string) => void;
  /** The words changed. */
  onType?: (text: string) => void;
  /** A paste was cut to what a note holds. */
  onCut?: () => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const field = useField({
    max: NOTE_MAX,
    lines: true,
    onCommit: (text) => onCommit(text, frame.current?.offsetHeight ?? 0),
    onCancel,
    ...(onType ? { onType } : {}),
    ...(onCut ? { onCut } : {}),
  });

  return (
    <div ref={frame} className="item item--note item--editor" data-no-export style={{ left: at[0], top: at[1], width }}>
      <div {...field.paper} className="note note--editing" style={{ transform: `rotate(${rot}deg)` }}>
        <textarea {...field.area} aria-label="Your note" placeholder="Write a note" defaultValue={initial} rows={1} maxLength={NOTE_MAX} spellCheck />
      </div>
    </div>
  );
}
