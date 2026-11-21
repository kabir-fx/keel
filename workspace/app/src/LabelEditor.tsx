import type { Box } from '@keel/protocol';
import { useRef } from 'react';
import { useField } from './field';
import { LABEL_MAX_WIDTH, LABEL_MIN_WIDTH } from './input/constants';

/** What both label fields are opened with. */
interface LabelFieldProps {
  placeholder: string;
  /** The words the field opens with: none for a new mark, the owner's own again when the field comes back. */
  initial?: string;
  /** The most letters the mark holds. */
  max: number;
  /** Esc. The words are handed over so they can be brought back. */
  onCancel: (text: string) => void;
  /** The words changed. */
  onType?: (text: string) => void;
  /** A paste was cut to what the mark holds. */
  onCut?: () => void;
}

/**
 * The words on a box, typed in the box itself. The field is drawn as the box will be drawn once
 * it is posted (`MarkView`, the case `box`): the same frame, the same line, the words in the same
 * hand, centred and wrapped at the same width. What the owner sees while typing is what lands.
 *
 * The box grows down with its words, as a posted box does. `onCommit` is handed the height it
 * grew to, in world units, so the box is posted at the size it was drawn and the board's idea of
 * the box (what a press hits, what a lasso holds) is the box on screen.
 */
export function BoxLabelEditor({
  box,
  placeholder,
  initial = '',
  max,
  onCommit,
  onCancel,
  onType,
  onCut,
}: LabelFieldProps & {
  /** The box as it was drawn, in world units. */
  box: Box;
  onCommit: (text: string, height: number) => void;
}) {
  const field = useField({
    max,
    lines: false,
    // The paper is in the world layer, so its height is in world units. A field ends while it is still on the page.
    onCommit: (text) => onCommit(text, field.paper.ref.current?.offsetHeight ?? box[3]),
    onCancel,
    ...(onType ? { onType } : {}),
    ...(onCut ? { onCut } : {}),
  });

  return (
    <div
      {...field.paper}
      className="label-editor label-editor--box"
      data-no-export
      style={{ left: box[0], top: box[1], width: box[2], minHeight: box[3] }}
    >
      <div className="drawn-box drawn-box--editing">
        <textarea
          {...field.area}
          className="drawn-box__words"
          aria-label="A few words"
          placeholder={placeholder}
          defaultValue={initial}
          rows={1}
          maxLength={max}
          spellCheck
        />
      </div>
    </div>
  );
}

/**
 * A few words in the owner's hand, typed onto an arrow or a pin while it is drawn (a box has
 * its own field, `BoxLabelEditor`). Enter or a press outside keeps the mark with the words (none
 * is fine); Esc keeps the mark with no words, or for a pin drops it. Looking away (another
 * window, another tab) leaves it open as it is. Every way it can end is in the table in `field.ts`.
 *
 * The field is as wide as its words, from the width it always had up to a set width, and then
 * it wraps. The page does the fitting: the words are drawn a second time, unseen, in the same
 * hand, and the field takes the width of that.
 */
export function LabelEditor({
  at,
  placeholder,
  initial = '',
  max,
  onCommit,
  onCancel,
  onType,
  onCut,
}: LabelFieldProps & {
  at: readonly [number, number];
  onCommit: (text: string) => void;
}) {
  const fit = useRef<HTMLDivElement>(null);
  const field = useField({ max, lines: false, onCommit, onCancel, ...(onType ? { onType } : {}), ...(onCut ? { onCut } : {}) });

  return (
    <div {...field.paper} className="label-editor" data-no-export style={{ left: at[0], top: at[1] }}>
      <div ref={fit} className="label-editor__fit" data-words={initial} style={{ minWidth: LABEL_MIN_WIDTH, maxWidth: LABEL_MAX_WIDTH }}>
        <textarea
          {...field.area}
          aria-label="A few words"
          placeholder={placeholder}
          defaultValue={initial}
          rows={1}
          maxLength={max}
          spellCheck
          onInput={(e) => {
            // The width first, straight to the page: the height is read from the field as it then wraps.
            if (fit.current) fit.current.dataset.words = e.currentTarget.value;
            field.area.onInput();
          }}
        />
      </div>
    </div>
  );
}
