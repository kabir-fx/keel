import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Are you sure: a question before a press that cannot be taken back on the board, with
 * exactly what it does (plan 5.6). The press that keeps things as they are has the focus, so
 * Enter or a stray Space changes nothing. Esc cancels, and so does a press beside it. While it
 * is open, no key reaches the board.
 */
export interface ConfirmProps {
  title: string;
  lines: readonly string[];
  /** The words of the press that changes nothing. */
  keep: string;
  /** The words of the press that goes ahead. */
  go: string;
  /** `danger` for what takes things away. */
  tone: 'danger' | 'go';
  /** A quiet line under the list. */
  quiet?: string;
  testId: string;
  onCancel: () => void;
  /** Resolves with the reason when it did not go through. */
  onGo: () => Promise<string | undefined>;
}

export function ConfirmDialog({ title, lines, keep, go, tone, quiet, testId, onCancel, onGo }: ConfirmProps) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string>();
  const cancel = useRef<HTMLButtonElement>(null);
  const ahead = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancel.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const press = async () => {
    setBusy(true);
    setRefused(undefined);
    const why = await onGo();
    setBusy(false);
    if (why) setRefused(why);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!busy) onCancel();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      (document.activeElement === cancel.current ? ahead.current : cancel.current)?.focus();
    }
  };

  return (
    <div className="confirm-veil" onPointerDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="confirm" role="alertdialog" aria-modal="true" aria-labelledby={`${testId}-title`} aria-describedby={`${testId}-what`} data-testid={testId} onKeyDown={onKeyDown}>
        <h2 id={`${testId}-title`}>{title}</h2>
        <ul id={`${testId}-what`} className="confirm__what">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        {quiet && <p className="confirm__quiet">{quiet}</p>}
        {refused && (
          <p className="confirm__refused" role="alert">
            {refused}
          </p>
        )}
        <div className="confirm__acts">
          <button ref={cancel} type="button" className="watch__btn" disabled={busy} onClick={onCancel}>
            {keep}
          </button>
          <button ref={ahead} type="button" className={tone === 'danger' ? 'watch__btn confirm__delete' : 'watch__btn watch__btn--dark'} data-testid={`${testId}-press`} disabled={busy} onClick={() => void press()}>
            {go}
          </button>
        </div>
      </div>
    </div>
  );
}
