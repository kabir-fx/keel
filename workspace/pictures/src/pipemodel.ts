import type { BoardState, Edge, Id, Lane, ModelData, Part, Walk } from '@keel/protocol';
import { liveParts, liveWalks } from '@keel/protocol';

/**
 * What a pipeline picture draws: the board's own model, read fresh on every render so the
 * picture stays live, or the candidate model the picture carries. Parts with no lane are
 * work off the picture: they are kept apart, for the build track.
 */
export interface PipeModel {
  lanes: Lane[];
  /** The parts drawn: each one has a lane that is drawn. */
  parts: Array<Part & { lane: Id }>;
  /** Parts with no lane, or whose lane is not drawn. */
  offPicture: Part[];
  edges: Edge[];
  walks: Walk[];
  /** True when this is the board's model, so a change of state redraws it. */
  live: boolean;
}

export function pipeModel(state: BoardState, spec: { model?: ModelData; parts?: readonly Id[] }): PipeModel {
  const src = spec.model
    ? { lanes: spec.model.lanes, parts: spec.model.parts, edges: spec.model.edges ?? [], walks: spec.model.walks ?? [] }
    : { lanes: state.model.lanes, parts: liveParts(state), edges: state.model.edges, walks: liveWalks(state) };
  const only = spec.parts ? new Set(spec.parts) : undefined;
  const chosen = only ? src.parts.filter((p) => only.has(p.id)) : src.parts;
  const laneIds = new Set(src.lanes.map((l) => l.id));
  const parts = chosen.filter((p): p is Part & { lane: Id } => p.lane !== undefined && laneIds.has(p.lane));
  const offPicture = chosen.filter((p) => p.lane === undefined || !laneIds.has(p.lane));
  // A picture of some parts keeps only the lanes they sit in.
  const used = new Set(parts.map((p) => p.lane));
  const lanes = only ? src.lanes.filter((l) => used.has(l.id)) : src.lanes;
  const drawn = new Set(parts.map((p) => p.id));
  const edges = src.edges.filter((e) => drawn.has(e.from) && drawn.has(e.to) && e.from !== e.to);
  return { lanes, parts, offPicture, edges, walks: src.walks, live: !spec.model };
}

/**
 * A column for every part. A part's own `col` wins. A part with none lines up over or under a
 * part in another lane it talks to, else takes the first free column of its lane. Columns no
 * part uses are closed up, so a picture of a few parts stays narrow.
 */
export function partColumns(pm: PipeModel): { col: Map<Id, number>; maxCol: number; laneIdx: Map<Id, number> } {
  const laneIdx = new Map(pm.lanes.map((l, i) => [l.id, i]));
  const occ = new Set<string>();
  const col = new Map<Id, number>();
  const key = (lane: Id, c: number) => `${laneIdx.get(lane) ?? 0}/${c}`;
  for (const part of pm.parts) {
    if (part.col === undefined) continue;
    let c = part.col;
    while (occ.has(key(part.lane, c))) c++;
    col.set(part.id, c);
    occ.add(key(part.lane, c));
  }
  const byId = new Map(pm.parts.map((x) => [x.id, x]));
  for (const part of pm.parts) {
    if (col.has(part.id)) continue;
    const near: number[] = [];
    for (const e of pm.edges) {
      const other = e.from === part.id ? e.to : e.to === part.id ? e.from : undefined;
      const oc = other ? col.get(other) : undefined;
      if (other && oc !== undefined && byId.get(other)?.lane !== part.lane) near.push(oc);
    }
    let c = near.find((k) => !occ.has(key(part.lane, k)));
    if (c === undefined) {
      c = 1;
      while (occ.has(key(part.lane, c))) c++;
    }
    col.set(part.id, c);
    occ.add(key(part.lane, c));
  }
  const used = [...new Set(col.values())].sort((a, b) => a - b);
  const closed = new Map(used.map((c, i) => [c, i + 1]));
  for (const [id, c] of col) col.set(id, closed.get(c) ?? c);
  return { col, maxCol: Math.max(1, used.length), laneIdx };
}

/** A walk drawn on a picture: the numbers on each part, the step being played, the edges it travels. */
export interface WalkMarks {
  walk: Walk;
  dots: Map<Id, number[]>;
  /** The step being played, when the owner's view names this walk. */
  lit?: number;
  litPart?: Id;
  travels: (from: Id, to: Id) => boolean;
}

export function walkMarks(pm: PipeModel, walkId: Id | undefined, playing: { id: Id; step: number } | undefined): WalkMarks | undefined {
  if (!walkId) return undefined;
  const walk = pm.walks.find((w) => w.id === walkId);
  if (!walk) return undefined;
  const drawn = new Set(pm.parts.map((p) => p.id));
  const dots = new Map<Id, number[]>();
  for (const s of walk.steps) if (drawn.has(s.part)) dots.set(s.part, [...(dots.get(s.part) ?? []), s.n]);
  for (const v of dots.values()) v.sort((a, b) => a - b);
  // An edge is on the request's way when the walk visits both of its ends.
  const visited = new Set(walk.steps.map((s) => s.part));
  const lit = playing?.id === walkId ? playing.step : undefined;
  const litPart = lit !== undefined ? walk.steps.find((s) => s.n === lit)?.part : undefined;
  return {
    walk,
    dots,
    ...(lit !== undefined ? { lit } : {}),
    ...(litPart !== undefined ? { litPart } : {}),
    travels: (from, to) => visited.has(from) && visited.has(to),
  };
}
