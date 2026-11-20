import type { RefObject } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BoardRect } from '../tools/types';

/** The size of the window, kept current. The chrome's room and the centre of the screen are counted from it. */
export function useViewport(): { w: number; h: number } {
  const [v, setV] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const on = () => setV({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return v;
}

const NOWHERE: BoardRect = { left: 0, top: 0, width: 0, height: 0 };

/**
 * The board's place on the page, from memory. Reading it from the page forces a layout, and a
 * pointer asks for it on every sample: so it is measured when the board mounts, when it or the
 * window changes size, and when anything scrolls, and answered from memory in between.
 */
export function useBoardRect(board: RefObject<HTMLElement | null>): () => BoardRect {
  const rect = useRef<BoardRect>(NOWHERE);
  useLayoutEffect(() => {
    const el = board.current;
    if (!el) return;
    const read = () => {
      const r = el.getBoundingClientRect();
      rect.current = { left: r.left, top: r.top, width: r.width, height: r.height };
    };
    read();
    const sized = typeof ResizeObserver === 'function' ? new ResizeObserver(read) : undefined;
    sized?.observe(el);
    window.addEventListener('resize', read);
    window.addEventListener('scroll', read, true);
    return () => {
      sized?.disconnect();
      window.removeEventListener('resize', read);
      window.removeEventListener('scroll', read, true);
    };
  }, [board]);
  return useCallback(() => rect.current, []);
}
