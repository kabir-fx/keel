import type { ArrowItem, Box, Id } from '@keel/protocol';
import type { RefObject } from 'react';
import { useCallback, useRef, useState } from 'react';

/** Where the page has put things that the log does not say yet. */
export interface Ahead {
  /** Boxes the app has posted and the log has not confirmed yet. */
  pending: ReadonlyMap<Id, Box>;
  /** Spots for placeholders the agent is still drawing: here only, never posted. */
  provisional: ReadonlyMap<Id, Box>;
  /** Arrows the app has posted a change of, each as it will be, that the log has not confirmed yet. */
  arrows: ReadonlyMap<Id, ArrowItem>;
  /** Set or drop several pending boxes at once. With `only`, a box is dropped only if it is still that one. */
  setPendingBoxes(boxes: ReadonlyMap<Id, Box | undefined>, only?: Box): void;
  setPendingBox(id: Id, box: Box | undefined, only?: Box): void;
  /**
   * Set or drop a pending arrow. With `only`, it is dropped only if it is still that one. An
   * arrow that is set carries its own box, so the pending box of the same arrow is let go.
   */
  setPendingArrow(id: Id, arrow: ArrowItem | undefined, only?: ArrowItem): void;
  /** Add spots for placeholders. */
  addProvisional(boxes: ReadonlyMap<Id, Box>): void;
  /** Keep only the placeholder spots for which `keep` is true. */
  keepProvisional(keep: (id: Id) => boolean): void;
  /** Both, as they were when this render ran: what the placement effect of the render reads. */
  now: RefObject<ReadonlyMap<Id, Box>>;
  /** Pictures whose placement the board refused: they are not tried again. */
  refused: RefObject<Set<Id>>;
}

/**
 * What the page knows ahead of the log: the box of a move or a placement that is posted and not
 * back yet, the spot of a placeholder the agent is still drawing, and an arrow whose ends or
 * label the owner has just set again.
 */
export function useAhead(): Ahead {
  const [pending, setPending] = useState<ReadonlyMap<Id, Box>>(() => new Map());
  const [provisional, setProvisional] = useState<ReadonlyMap<Id, Box>>(() => new Map());
  // The same boxes, kept current outside React: an effect that runs twice on one render (as
  // under StrictMode) must see what its first run posted, or it would post it again.
  const pendingRef = useRef(new Map<Id, Box>());
  const provisionalRef = useRef(new Map<Id, Box>());
  const refused = useRef(new Set<Id>());

  const setPendingBoxes = useCallback((boxes: ReadonlyMap<Id, Box | undefined>, only?: Box) => {
    const next = new Map(pendingRef.current);
    for (const [id, box] of boxes) {
      if (box !== undefined) next.set(id, box);
      else if (!only || next.get(id) === only) next.delete(id);
    }
    pendingRef.current = next;
    setPending(next);
  }, []);
  const setPendingBox = useCallback((id: Id, box: Box | undefined, only?: Box) => setPendingBoxes(new Map([[id, box]]), only), [setPendingBoxes]);

  const [arrows, setArrows] = useState<ReadonlyMap<Id, ArrowItem>>(() => new Map());
  const arrowsRef = useRef(new Map<Id, ArrowItem>());
  const setPendingArrow = useCallback((id: Id, arrow: ArrowItem | undefined, only?: ArrowItem) => {
    const cur = arrowsRef.current;
    if (arrow === undefined && (!cur.has(id) || (only && cur.get(id) !== only))) return;
    const next = new Map(cur);
    if (arrow) next.set(id, arrow);
    else next.delete(id);
    arrowsRef.current = next;
    setArrows(next);
    // The box of an earlier move of this arrow, still on its way, would be drawn in place of the arrow's own until that move is answered.
    if (arrow && pendingRef.current.has(id)) setPendingBoxes(new Map([[id, undefined]]));
  }, [setPendingBoxes]);

  const addProvisional = useCallback((boxes: ReadonlyMap<Id, Box>) => {
    const next = new Map([...provisionalRef.current, ...boxes]);
    provisionalRef.current = next;
    setProvisional(next);
  }, []);
  const keepProvisional = useCallback((keep: (id: Id) => boolean) => {
    const cur = provisionalRef.current;
    if (cur.size === 0) return;
    const kept = new Map([...cur].filter(([id]) => keep(id)));
    if (kept.size === cur.size) return;
    provisionalRef.current = kept;
    setProvisional(kept);
  }, []);

  const now = useRef<ReadonlyMap<Id, Box>>(new Map());
  now.current = new Map([...provisionalRef.current, ...pendingRef.current]);

  return { pending, provisional, arrows, setPendingBoxes, setPendingBox, setPendingArrow, addProvisional, keepProvisional, now, refused };
}
