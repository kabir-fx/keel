import type { RefObject } from 'react';
import { useLayoutEffect, useRef } from 'react';
import type { Board } from '../board/context';
import type { ToolId } from '../chrome';
import { oncePerFrame } from '../frame';
import { onControl } from '../input/press';
import { endUnder, onLabel } from './arrowGrip';
import type { CursorState, Over } from './cursor';
import { cursorFor } from './cursor';
import { handleUnder, movableOf } from './grab';
import { movesThings } from './moving';

/** What is under a page point, for the cursor: a control in a picture, a handle, a thing the owner can move, or the ground. */
function overAt(board: Board, target: EventTarget | null, clientX: number, clientY: number): Over {
  const el = target instanceof Element ? target : null;
  if (onControl(el)) return 'control';
  const [x, y] = board.toBoard(clientX, clientY);
  const handle = handleUnder(board, x, y);
  if (handle) return { resize: handle.cursor };
  if (endUnder(board, x, y)) return 'end';
  if (onLabel(board, el)) return 'label';
  const [wx, wy] = board.toWorld(clientX, clientY);
  const hit = board.hitAt(el, wx, wy);
  return hit && movableOf(board, [hit]).length > 0 ? 'movable' : 'ground';
}

/** Write the cursor for a state on the board's element, when it changes. */
function show(el: HTMLElement | null, s: CursorState): void {
  const cursor = cursorFor(s);
  if (el && el.style.cursor !== cursor) el.style.cursor = cursor;
}

/**
 * Show the cursor the board's state calls for (`cursorFor`), on the board's element, set from
 * code. What is under the pointer is looked at once a frame as it moves, and not during a
 * press: what the press holds decides then.
 */
export function useCursor(boardEl: RefObject<HTMLElement | null>, board: Board, tool: ToolId, space: boolean): void {
  const now = useRef<CursorState>({ tool, owner: board.isOwner, space, grip: 'none', holding: 'none', over: 'ground' });

  useLayoutEffect(() => {
    now.current.tool = tool;
    now.current.space = space;
    show(boardEl.current, now.current);
  }, [boardEl, tool, space]);

  useLayoutEffect(() => {
    const el = boardEl.current;
    const offGrip = board.camera.onGrip((grip) => {
      now.current.grip = grip;
      show(el, now.current);
    });
    const offHeld = board.moving.subscribe(() => {
      const held = board.moving.get();
      // An arrow dragged by itself is drawn again, not moved by a style: it is a move all the same; so is its label slid along
      // it. An end dragged by its handle is not: the hand keeps what it showed over the handle as the press went down.
      now.current.holding = held?.resize ? { resize: held.resize.cursor } : movesThings(held) || held?.grip === 'label' ? 'moving' : 'none';
      show(el, now.current);
    });
    const hover = oncePerFrame((target: EventTarget | null, x: number, y: number) => {
      now.current.over = overAt(board, target, x, y);
      show(el, now.current);
    });
    const moved = (e: PointerEvent) => {
      if (!board.pressOpen()) hover(e.target, e.clientX, e.clientY);
    };
    const left = () => {
      hover.cancel();
      now.current.over = 'ground';
      show(el, now.current);
    };
    el?.addEventListener('pointermove', moved);
    el?.addEventListener('pointerleave', left);
    return () => {
      offGrip();
      offHeld();
      hover.cancel();
      el?.removeEventListener('pointermove', moved);
      el?.removeEventListener('pointerleave', left);
    };
  }, [boardEl, board]);
}
