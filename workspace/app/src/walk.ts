import type { BoardState, Id } from '@keel/protocol';

/**
 * The step a walk moves to from `current`: one on (`dir` 1) or one back (-1), held at the ends.
 * With no step in play yet, forward starts at the first step and back at the last.
 */
export function stepFrom(state: BoardState, walk: Id, current: number | undefined, dir: 1 | -1): number | undefined {
  const w = state.model.walks[walk];
  if (!w || w.steps.length === 0) return undefined;
  const ns = w.steps.map((s) => s.n).sort((a, b) => a - b);
  const i = current === undefined ? -1 : ns.indexOf(current);
  if (i < 0) return dir > 0 ? ns[0] : ns[ns.length - 1];
  return ns[Math.max(0, Math.min(ns.length - 1, i + dir))];
}

/** The walk a picture plays, if it is a walk player. */
export function walkOf(state: BoardState, id: Id | undefined): Id | undefined {
  const s = id ? state.items[id] : undefined;
  return s && !s.removed && s.item.kind === 'picture' && s.item.picture.kind === 'walk' ? s.item.picture.walk : undefined;
}
