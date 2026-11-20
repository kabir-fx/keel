import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { crosses, pageClock, placeTip, TipTimer } from './tips';

/**
 * The board's tooltips, in place of the browser's own: a control says what its tip reads with a
 * `data-tip` attribute, and this one tip shows it. The timing is `TipTimer`'s (`tips.ts`).
 *
 * A tip never takes a press and never takes the focus: a control that shows one is still reached
 * with Tab and pressed with Space or Enter, and its accessible name is its own label. A press
 * anywhere, Esc, or the window losing the focus puts the tip away. Where a tip lands on the hint
 * line, the line gives it its place.
 */

/** The control with a tip that an event happened in, if any. */
function tipped(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>('[data-tip]') : null;
}

/** What shows: the control, and its words as they are now. */
interface Shown {
  el: HTMLElement;
  text: string;
}

export function Tooltip() {
  const [shown, setShown] = useState<Shown | null>(null);
  const [timer] = useState(
    () =>
      new TipTimer<HTMLElement>(
        (el) => setShown(el ? { el, text: el.dataset.tip ?? '' } : null),
        pageClock,
        (el) => el.isConnected,
      ),
  );
  const tipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const over = (e: PointerEvent) => {
      // A finger has no hover: a tip would only cover what it pressed.
      if (e.pointerType !== 'touch') timer.over(tipped(e.target));
    };
    // Leaving the window: no pointerover follows.
    const out = (e: PointerEvent) => {
      if (e.relatedTarget === null) timer.over(null);
    };
    const putAway = () => timer.putAwayNow();
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') timer.putAwayNow();
    };
    document.addEventListener('pointerover', over);
    document.addEventListener('pointerout', out);
    window.addEventListener('pointerdown', putAway, true);
    window.addEventListener('keydown', esc, true);
    window.addEventListener('blur', putAway);
    return () => {
      document.removeEventListener('pointerover', over);
      document.removeEventListener('pointerout', out);
      window.removeEventListener('pointerdown', putAway, true);
      window.removeEventListener('keydown', esc, true);
      window.removeEventListener('blur', putAway);
      timer.over(null);
    };
  }, [timer]);

  // While a tip shows: it goes with its control when the control leaves the page (no pointerout
  // comes then), and its words follow the control's.
  useEffect(() => {
    if (!shown) return;
    const { el } = shown;
    const watch = new MutationObserver(() => {
      if (!el.isConnected) timer.over(null);
      else if ((el.dataset.tip ?? '') !== shown.text) setShown({ el, text: el.dataset.tip ?? '' });
    });
    watch.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-tip'] });
    return () => watch.disconnect();
  }, [shown, timer]);

  // Placed once it is drawn, at the size it is drawn. One layout a tip: all that is read from the page is read before anything is written to it.
  useLayoutEffect(() => {
    const tip = tipRef.current;
    if (!shown || !tip) return;
    const size = tip.getBoundingClientRect();
    const hint = document.querySelector('.hint')?.getBoundingClientRect();
    const at = placeTip(shown.el.getBoundingClientRect(), size, { width: window.innerWidth, height: window.innerHeight });
    tip.style.left = `${at.left}px`;
    tip.style.top = `${at.top}px`;
    // A tip over a tool lands on the hint line: the line waits while such a tip shows (styles/chrome.css).
    tip.toggleAttribute('data-on-hint', !!hint && crosses({ ...at, width: size.width, height: size.height }, hint));
  }, [shown]);

  if (!shown || !shown.text) return null;
  return (
    <div ref={tipRef} className="tooltip" role="tooltip" data-testid="tooltip">
      {shown.text}
    </div>
  );
}
