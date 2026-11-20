import type { BoardState, Box, Id } from '@keel/protocol';
import { anchorMode, unplaceFromAnchor } from '../anchor';
import type { Where } from '../layout';
import { anchorBox, storedBox } from '../layout';
import { followers, movable } from '../marks';
import type { BoardCtx } from '../tools/types';
import type { Handle } from './resize';
import { handleAt, handleCursor, handlesOf, landed } from './resize';

/**
 * What a move or a resize takes with it, as plain rules on the board's state: which things move
 * themselves, which hang on them, which are tied to them and must be worked out again, and the
 * box to post for a thing the owner put down somewhere.
 */

/** Of the things grabbed, those that move themselves: a thing that hangs on another one grabbed moves with it, not twice. */
export function rootsOf(state: BoardState, grabbed: readonly Id[]): Id[] {
  const hanging = new Set(grabbed.flatMap((id) => followers(state, id)));
  return grabbed.filter((id) => !hanging.has(id));
}

/** The things that move with `roots`: the roots and every mark that hangs on them, in turn. */
export function withFollowers(state: BoardState, roots: readonly Id[]): Set<Id> {
  return new Set([...roots, ...roots.flatMap((id) => followers(state, id))]);
}

/**
 * The marks to work out again while `moving` moves: every arrow among them or tied by an end to
 * one of them, and every lasso round one of them or round such an arrow. Their places come from
 * where their targets are now, so moving them whole would put their ends off their targets.
 */
export function tiedTo(state: BoardState, moving: ReadonlySet<Id>): Set<Id> {
  const out = new Set<Id>();
  for (const id of state.itemOrder) {
    const s = state.items[id];
    if (!s || s.removed || s.item.kind !== 'arrow') continue;
    const a = s.item;
    if (moving.has(id) || moving.has(a.fromTarget?.item ?? '') || moving.has(a.toTarget?.item ?? '')) out.add(id);
  }
  for (const id of state.itemOrder) {
    const s = state.items[id];
    if (!s || s.removed || s.item.kind !== 'lasso') continue;
    if (s.item.targets.some((t) => moving.has(t.item) || out.has(t.item))) out.add(id);
  }
  return out;
}

/**
 * The box to post for a thing the owner put down to be drawn at `shown`: its own box, which for
 * a mark on an anchor is counted from where the anchor was (`unplaceFromAnchor`).
 */
export function storedFor(where: Where, id: Id, shown: Box): Box {
  const s = where.state.items[id];
  if (!s || s.item.kind === 'picture') return shown;
  const a = s.item.anchor;
  const now = a ? anchorBox(where, a) : undefined;
  return a && now ? unplaceFromAnchor(shown, a.box, now, anchorMode(s.item.kind)) : shown;
}

/**
 * The box to post for a thing moved to be drawn at `shown`: its place on whole units, and its
 * size as it was. A move never changes a size: a mark whose box is on tenths keeps it.
 */
export function movedBox(where: Where, id: Id, shown: Box): Box | undefined {
  const own = storedBox(where, id);
  if (!own) return undefined;
  const [x, y] = storedFor(where, id, shown);
  return [Math.round(x), Math.round(y), own[2], own[3]];
}

/**
 * The box to post for a thing resized by `handle`, from being drawn at `start` to being drawn at
 * `drawn`. It lands as it is drawn (`landed`): a size the hand changed on a whole unit, and what
 * the resize held still exactly where it was, so nothing but the dragged edges moves as the
 * pointer lifts. Then it is counted in the thing's own units, which are not those it is drawn in
 * when the card it is on has moved or grown since. A side the hand did not move is posted as it
 * is stored: the way to drawn units and back is not exact.
 */
export function resizedBox(where: Where, id: Id, handle: Handle, start: Box, drawn: Box, fromCentre: boolean): Box | undefined {
  const own = storedBox(where, id);
  if (!own) return undefined;
  const at = landed(start, handle, [drawn[2], drawn[3]], fromCentre);
  const stored = storedFor(where, id, at);
  const side = (i: 0 | 1 | 2 | 3) => (at[i] === start[i] ? own[i] : stored[i]);
  return [side(0), side(1), side(2), side(3)];
}

/**
 * Is `box` the very box the thing has? A thing brought back to within half a unit of where it
 * was lands on its own box: it has not moved, so nothing is posted and Undo gets no step.
 */
export function landsWhereItWas(where: Where, id: Id, box: Box): boolean {
  const own = storedBox(where, id);
  return !!own && own.every((n, i) => n === box[i]);
}

/** The one thing of a selection, when it is one thing: what a part about one thing (a walk, a lasso, lineage) sees. */
export const theOne = (selection: readonly Id[]): Id | undefined => (selection.length === 1 ? selection[0] : undefined);

/** The movable things among `ids`, for this page. */
export function movableOf(board: Pick<BoardCtx, 'isOwner' | 'state'>, ids: readonly Id[]): Id[] {
  return board.isOwner ? ids.filter((id) => movable(board.state(), id)) : [];
}

/**
 * The one thing selected that the owner can resize: a box or a note (every mark is the owner's).
 * A plain label is as wide as its words.
 */
export function resizable(board: Pick<BoardCtx, 'isOwner' | 'state' | 'selection'>): { id: Id; widthOnly: boolean } | undefined {
  const sel = board.selection();
  if (!board.isOwner || sel.length !== 1) return undefined;
  const id = sel[0]!;
  const s = board.state().items[id];
  if (!s || s.removed) return undefined;
  if (s.item.kind === 'box') return { id, widthOnly: false };
  if (s.item.kind === 'note' && !s.item.plain) return { id, widthOnly: true };
  return undefined;
}

/** What a handle under the pointer is: the thing it resizes, the handle, and its cursor. */
export interface HandleUnder {
  id: Id;
  handle: Handle;
  widthOnly: boolean;
  cursor: string;
  /** Where the thing is drawn, in world units, as the line round it last found it. */
  box: Box;
}

/** The handle or edge under a point of the board (board pixels), of the one thing selected that can be resized. */
export function handleUnder(board: Pick<BoardCtx, 'isOwner' | 'state' | 'selection' | 'camera' | 'moving'>, x: number, y: number): HandleUnder | undefined {
  const r = resizable(board);
  const box = r && board.moving.outline(r.id);
  if (!r || !box) return undefined;
  const cam = board.camera.get();
  const onScreen: Box = [box[0] * cam.z + cam.x, box[1] * cam.z + cam.y, box[2] * cam.z, box[3] * cam.z];
  const handle = handleAt(x, y, onScreen, handlesOf(r.widthOnly));
  return handle && { id: r.id, handle, widthOnly: r.widthOnly, cursor: handleCursor(handle, r.widthOnly), box };
}
