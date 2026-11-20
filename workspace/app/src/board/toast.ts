import { useCallback, useRef, useState } from 'react';

/** How long the board's one line stays up, in ms. */
const TOAST_MS = 6000;

/** The one line the board says to the owner: a refusal, a hint, what Undo did. A new line replaces the old. */
export function useToast(): { toast: string | undefined; say: (text: string) => void; close: () => void } {
  const [toast, setToast] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const say = useCallback((text: string) => {
    setToast(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(undefined), TOAST_MS);
  }, []);
  const close = useCallback(() => setToast(undefined), []);
  return { toast, say, close };
}
