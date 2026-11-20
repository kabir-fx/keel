import { useEffect, useRef } from 'react';
import { typing } from '../input/keys';
import type { Board } from './context';
import type { DropIn, PagePoint } from './drop';

/**
 * Paste: what is on the clipboard lands on the board at the pointer. A file goes the way a
 * dropped file goes, and a link or a bit of text the way dropped text goes.
 *
 * A paste is left to the browser when the owner types in a field, and when the pointer is over
 * a panel and not over the board: there the owner did not point at a place on the board. Only
 * the owner's page pastes. The two guards are Excalidraw's (`pasteFromClipboard` in
 * packages/excalidraw/components/App.clipboard.ts, commit 9fbeaed).
 */
export function usePaste(board: Board, drop: Pick<DropIn, 'addFiles' | 'addText'>): void {
  const dropNow = useRef(drop);
  dropNow.current = drop;

  useEffect(() => {
    if (!board.isOwner) return;
    /**
     * Where the pointer last was on the page. The board itself hears of the pointer only while
     * it is over the board, and a paste must know when it has gone onto a panel.
     */
    const pointer = { x: 0, y: 0, seen: false };
    // Called for every move of the pointer, so it only writes three fields.
    const moved = (e: PointerEvent) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.seen = true;
    };

    /** The middle of the board: where a paste lands when the pointer has not been on the page yet. */
    const middle = (): PagePoint => {
      const r = board.rect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    };

    /** Is this page point on the board itself, with no panel over it? One hit test, when a paste comes. */
    const onBoard = (at: PagePoint): boolean => {
      const boardEl = board.layerEl()?.closest('.board');
      const hit = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(at.x, at.y) : null;
      return !!boardEl && !!hit && hit.closest('.board') === boardEl;
    };

    const paste = (e: ClipboardEvent) => {
      const data = e.clipboardData;
      if (!data || board.mode() !== 'board' || typing(e.target) || typing(document.activeElement)) return;
      const at = pointer.seen ? { x: pointer.x, y: pointer.y } : middle();
      if (!onBoard(at)) return;
      // Read now: a browser empties the clipboard's data once the event is over.
      const files = [...data.files];
      const text = data.getData('text/uri-list') || data.getData('text/plain');
      if (files.length === 0 && !text.trim()) return;
      e.preventDefault();
      if (files.length > 0) void dropNow.current.addFiles(files, at);
      else void dropNow.current.addText(text, at);
    };

    const always = { capture: true, passive: true } as const;
    window.addEventListener('pointermove', moved, always);
    window.addEventListener('pointerdown', moved, always);
    window.addEventListener('paste', paste);
    return () => {
      window.removeEventListener('pointermove', moved, always);
      window.removeEventListener('pointerdown', moved, always);
      window.removeEventListener('paste', paste);
    };
  }, [board]);
}
