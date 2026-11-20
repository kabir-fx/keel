import type { BoardState, Id, Item, ItemState } from '@keel/protocol';
import { Id as IdSchema, isMark, targetsOf } from '@keel/protocol';

/**
 * `ROUTES.items`: a few items in full, for an agent that needs more than the digest says.
 * Each comes with `marks`, the ids of the owner's marks that target it. Ink strokes and lasso
 * paths are left out: they are points, the largest thing on a board, and say nothing in words.
 */

/** At most this many ids in one request. */
export const MAX_ITEMS = 50;

/** An item without its points. */
export type LeanItem = Item extends infer T ? (T extends unknown ? Omit<T, 'strokes' | 'path'> : never) : never;

export type ItemView = Omit<ItemState, 'item'> & { item: LeanItem; marks: Id[] };

/** The items named, in the order asked, each with the owner's marks on it. Unknown ids are left out. */
export function itemViews(state: BoardState, ids: readonly Id[]): ItemView[] {
  const want = new Set(ids);
  const marks = new Map<Id, Id[]>();
  for (const id of state.itemOrder) {
    const s = state.items[id];
    if (!s || s.removed || s.by !== 'owner' || !isMark(s.item)) continue;
    for (const t of targetsOf(s.item)) {
      if (!want.has(t.item)) continue;
      const list = marks.get(t.item) ?? [];
      if (!list.includes(id)) list.push(id);
      marks.set(t.item, list);
    }
  }
  const out: ItemView[] = [];
  for (const id of ids) {
    // An id such as "constructor" names nothing on the board, whatever an object has by default.
    const s = Object.hasOwn(state.items, id) ? state.items[id] : undefined;
    if (s) out.push({ ...s, item: lean(s.item), marks: marks.get(id) ?? [] });
  }
  return out;
}

/** The ids of `?ids=a,b`: trimmed, without repeats. Undefined when one is not an id. */
export function idsParam(raw: string | null): Id[] | undefined {
  const ids = [...new Set((raw ?? '').split(',').map((s) => s.trim()).filter(Boolean))];
  return ids.every((id) => IdSchema.safeParse(id).success) ? ids : undefined;
}

function lean(item: Item): LeanItem {
  if (item.kind === 'ink') {
    const { strokes: _strokes, ...rest } = item;
    return rest;
  }
  if (item.kind === 'lasso') {
    const { path: _path, ...rest } = item;
    return rest;
  }
  return item;
}
