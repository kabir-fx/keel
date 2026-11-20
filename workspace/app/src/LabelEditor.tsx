import { useRef } from 'react';
import { useField } from './field';
import { LABEL_MAX_WIDTH, LABEL_MIN_WIDTH } from './input/constants';

/**
 * A few words in the owner's hand, typed onto a box, an arrow or a pin while it is drawn. Enter
 * or a press outside keeps the mark with the words (none is fine); Esc keeps the mark with no
 * words, or for a pin drops it. Looking away (another window, another tab) leaves it open as it
 * is. Every way it can end is in the table in `field.ts`.
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
}: {
  at: readonly [number, number];
  placeholder: string;
  /** The words the field opens with: none for a new mark, the owner's own again when the field comes back. */
  initial?: string;
  /** The most letters the mark holds. */
  max: number;
  onCommit: (text: string) => void;
  /** Esc. The words are handed over so they can be brought back. */
  onCancel: (text: string) => void;
  /** The words changed. */
  onType?: (text: string) => void;
  /** A paste was cut to what the mark holds. */
  onCut?: () => void;
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
