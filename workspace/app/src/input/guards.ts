import type { RefObject } from 'react';
import { useEffect } from 'react';
import { typing } from './keys';

/**
 * The browser's own answers to the pointer that the board has no use for, switched off once:
 *
 * - No context menu on the board. A right-click, and on a Mac a Ctrl-click, does nothing.
 * - No native drag of a link or a picture inside an item. A drag must draw or move; a ghost
 *   image lifted by the browser would also take the pointer away in the middle of it.
 * - A sideways two-finger swipe never goes back a page. That one is a style rule
 *   (`overscroll-behavior-x`, in styles/base.css), not a listener.
 *
 * Inside a field the owner types in (a note, a label) the menu and the drag stay the browser's:
 * the owner needs paste and spelling there, and may move a word.
 */

/** Add the board's defences to its element. Answers with what takes them off again. */
function addGuards(board: HTMLElement): () => void {
  const unlessTyping = (e: Event) => {
    if (!typing(e.target)) e.preventDefault();
  };
  board.addEventListener('contextmenu', unlessTyping);
  board.addEventListener('dragstart', unlessTyping);
  return () => {
    board.removeEventListener('contextmenu', unlessTyping);
    board.removeEventListener('dragstart', unlessTyping);
  };
}

/** Keep the board's defences on while the board is on the page. */
export function useGuards(board: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = board.current;
    if (!el) return;
    return addGuards(el);
  }, [board]);
}
