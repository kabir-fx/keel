import type { BoardState, Box, Id } from '@keel/protocol';
import { isMark } from '@keel/protocol';
import { memo, useMemo, useSyncExternalStore } from 'react';
import type { HoverStore } from './board/hover';
import { useHovered } from './board/hover';
import { overlaps } from './geometry';
import type { BoxOf } from './place';
import { isSmall } from './place';
import { centre, routeEdge } from './route';
import type { MovingStore } from './select/moving';

export { DETOUR_MAX, edgeEnds, routeEdge, segmentHits } from './route';

/** One lineage arrow: from an item a picture grew out of, or a mark it answers, to the picture. */
export interface Edge {
  from: Id;
  to: Id;
  kind: 'near' | 'from' | 'answers';
  /** The one arrow a picture shows by default. The others show when it is selected or hovered. */
  primary: boolean;
}

const gapOf = (a: Box, b: Box) => Math.hypot(centre(a)[0] - centre(b)[0], centre(a)[1] - centre(b)[1]);

/**
 * The one arrow into a picture the board draws by default: from what it was placed beside
 * (`place.near`), else from the first item it grew out of, else from the nearest mark it
 * answers. A small picture (a text card, a mini, a choice) is placed by the mark it answers,
 * so for one of those the nearest mark comes before the item it grew out of, and the arrow
 * stays short. A source that is not drawn, or that touches the picture, is passed over.
 */
export function primarySource(state: BoardState, id: Id, boxOf: BoxOf): { from: Id; kind: Edge['kind'] } | undefined {
  const s = state.items[id];
  const to = boxOf(id);
  if (!s || s.item.kind !== 'picture' || !to) return undefined;
  const ok = (x: Id | undefined): x is Id => {
    if (!x || x === id) return false;
    const src = state.items[x];
    const b = src && !src.removed ? boxOf(x) : undefined;
    return !!b && !overlaps(b, to);
  };
  const near = s.item.place?.near;
  if (ok(near)) return { from: near, kind: 'near' };
  const marks = (s.item.answers ?? []).filter((a) => {
    const m = state.items[a];
    return !!m && m.by === 'owner' && isMark(m.item) && ok(a);
  });
  const nearest = marks.sort((a, b) => gapOf(boxOf(a)!, to) - gapOf(boxOf(b)!, to))[0];
  const from = s.item.from?.find(ok);
  if (nearest && isSmall(s.item.picture.kind)) return { from: nearest, kind: 'answers' };
  if (from) return { from, kind: 'from' };
  return nearest ? { from: nearest, kind: 'answers' } : undefined;
}

/** How much of box `a` lies inside box `b`, from 0 to 1. */
function shareInside(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const area = a[2] * a[3];
  return area > 0 ? (w * h) / area : 0;
}

/**
 * Every lineage arrow on the board: from each `from` item and each answered mark to the picture.
 * To keep the board calm, at most one of them into each picture is `primary` (see
 * `primarySource`), an answered mark that sits on a picture (it has an anchor) is drawn from
 * that picture, a source lying inside another source shares its arrow, and an arrow is left out
 * when either end is not drawn or the two ends overlap.
 */
export function lineageEdges(state: BoardState, boxOf: BoxOf): Edge[] {
  const out: Edge[] = [];
  for (const id of state.itemOrder) {
    const s = state.items[id];
    if (!s || s.removed || s.item.kind !== 'picture') continue;
    const to = boxOf(id);
    if (!to) continue;
    const sources = new Map<Id, 'from' | 'answers'>();
    const add = (from: Id, kind: 'from' | 'answers') => {
      if (from === id || sources.has(from)) return;
      const src = state.items[from];
      if (!src || src.removed || !boxOf(from)) return;
      sources.set(from, kind);
    };
    for (const f of s.item.from ?? []) add(f, 'from');
    for (const a of s.item.answers ?? []) {
      const m = state.items[a];
      if (!m || m.by !== 'owner' || !isMark(m.item)) continue;
      const on = m.item.anchor?.item;
      add(on && on !== id && boxOf(on) ? on : a, 'answers');
    }
    const main = primarySource(state, id, boxOf);
    if (main) out.push({ from: main.from, to: id, kind: main.kind, primary: true });
    const boxes = [...sources.keys()].map((k) => [k, boxOf(k)!] as const);
    for (const [from, b] of boxes) {
      if (from === main?.from || overlaps(b, to)) continue;
      const inside = boxes.some(([other, ob]) => other !== from && shareInside(b, ob) >= 0.6 && ob[2] * ob[3] > b[2] * b[3]);
      if (!inside) out.push({ from, to: id, kind: sources.get(from)!, primary: false });
    }
  }
  return out;
}

/** No cards in the way. */
const NONE: ReadonlyMap<Id, Box> = new Map();

/**
 * The arrows, in world units, under the items: each picture's one arrow, and all of them into
 * the picture that is selected (`open`) or under the pointer. They go round the cards in
 * `obstacles` where a short route does. An arrow with an end in the owner's hand follows the
 * hand (`moving`).
 */
export const Lineage = memo(function Lineage({
  edges,
  boxOf,
  open,
  hover,
  moving,
  obstacles = NONE,
}: {
  edges: readonly Edge[];
  boxOf: BoxOf;
  open?: Id | undefined;
  hover: HoverStore;
  moving: MovingStore;
  obstacles?: ReadonlyMap<Id, Box>;
}) {
  const hovered = useHovered(hover);
  const shows = open ?? hovered;
  /** The cards where the board has them: the same list until one moves, so an arrow at rest is not routed again. */
  const cards = useMemo(() => [...obstacles.values()], [obstacles]);
  return (
    <svg className="lineage" aria-hidden="true">
      <defs>
        <marker id="lineage-head" orient="auto" markerWidth="5" markerHeight="5" refX="2.5" refY="2" overflow="visible">
          <path d="M0 0 L4 2 L0 4 Z" fill="#1D4ED8" />
        </marker>
      </defs>
      {edges.map((e) => {
        if (!e.primary && e.to !== shows) return null;
        const a = boxOf(e.from);
        const b = boxOf(e.to);
        if (!a || !b) return null;
        return <FollowingPath key={`${e.from}>${e.to}`} moving={moving} byId={obstacles} from={e.from} to={e.to} primary={e.primary} a={a} b={b} obstacles={cards} />;
      })}
    </svg>
  );
});

/** One arrow: its two ends, the boxes it runs between, and the cards it goes round. */
interface PathProps {
  from: Id;
  to: Id;
  primary: boolean;
  a: Box;
  b: Box;
  obstacles: readonly Box[];
}

/**
 * One arrow, between its ends where the board has them; or, while the owner's hand holds one of
 * them, where the hand has it, round the cards where the hand has them. So the arrow follows the
 * hand, and where it is when the hand lets go is where it stays. Only an arrow with an end in
 * the hand draws again as the hand moves: every other arrow keeps its route until the hand lets go.
 */
const FollowingPath = memo(function FollowingPath({ moving, byId, ...path }: PathProps & { moving: MovingStore; byId: ReadonlyMap<Id, Box> }) {
  // The frame itself is what changes as the hand moves; for an arrow with no end in the hand it is always nothing.
  const held = useSyncExternalStore(moving.subscribe, () => (moving.holds(path.from) || moving.holds(path.to) ? moving.get() : null));
  if (!held) return <LineagePath {...path} />;
  const a = moving.at(path.from, path.a);
  const b = moving.at(path.to, path.b);
  // Ends the hand has put on each other have no arrow between them, as on the board at rest.
  if (overlaps(a, b)) return null;
  return <LineagePath {...path} a={a} b={b} obstacles={[...byId].map(([id, card]) => moving.at(id, card))} />;
});

/** One arrow. It is routed again only when one of its ends or a card in the way has moved: the board keeps a box whose numbers did not change. */
const LineagePath = memo(function LineagePath({ from, to, primary, a, b, obstacles }: PathProps) {
  const pts = routeEdge(a, b, obstacles);
  return (
    <path
      data-lineage={`${from}>${to}`}
      data-primary={primary ? '' : undefined}
      d={pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')}
      markerEnd="url(#lineage-head)"
    />
  );
});
