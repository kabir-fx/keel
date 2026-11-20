import type { ReactNode } from 'react';

/**
 * One layer in screen space, over the board. What must keep its size on screen at any zoom is
 * drawn here and not in the world: the selection's border and handles, guide lines, the target
 * an arrow would tie to, trails, the agent's cursor. It never takes a press, and nothing in it
 * goes into a snapshot.
 */
export function Overlay({ children }: { children?: ReactNode }) {
  return (
    <div className="overlay" data-no-export aria-hidden="true">
      {children}
    </div>
  );
}
