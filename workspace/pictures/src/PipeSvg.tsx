import type { Edge, Id, Markings, Part } from '@keel/protocol';
import type { MouseEvent } from 'react';
import type { Grid, PlacedLabel, Pt, Rect, Route } from './grid';
import { cellRect, finish, placeLabels, roundedPath, route } from './grid';
import { measure, wrap } from './measure';
import type { PipeModel, WalkMarks } from './pipemodel';
import { partColumns } from './pipemodel';
import type { ArrowTone } from './svg';
import { ArrowPath, Defs, LabelView, Lines, StepDot, labelSize, useSvgIds } from './svg';
import type { LookStyle } from './theme';
import { LOOK, T, lookOf } from './theme';
import type { PictureAct } from './types';

/**
 * The two drawings of the model. Flat is the lanes seen from the front, the owner's own
 * drawing style. Layers stacks the same lanes as floors (roadmap Appendix C). Both come from
 * the same columns, so a part sits in the same place in each.
 */

export interface PipeSvgProps {
  pm: PipeModel;
  item: Id;
  markings: Markings;
  walk?: WalkMarks;
  onAct?: (act: PictureAct) => void;
  /** Draw the arrows. The blueprint leaves them out. */
  edges?: boolean;
  /** Small numbers for the build track, by part. */
  trackNo?: ReadonlyMap<Id, number>;
  /** Tap targets for parts and lanes. False draws a picture with none. */
  subs?: boolean;
  /** False keeps the lanes from being tap targets, where the picture's kind offers none. */
  laneSubs?: boolean;
}

/* -------------------------------------------------------------------- shared */

function edgeTone(e: Edge, walk: WalkMarks | undefined): ArrowTone {
  if (!walk) return 'ink';
  return walk.travels(e.from, e.to) ? 'teal' : 'grey';
}

function partTap(props: PipeSvgProps, kind: 'part' | 'lane', id: Id) {
  if (props.subs === false || (kind === 'lane' && props.laneSubs === false)) return {};
  const sub = `${kind}:${id}`;
  const { onAct, item } = props;
  return {
    'data-sub': sub,
    className: onAct ? 'kp-tap' : undefined,
    onClick: onAct
      ? (e: MouseEvent) => {
          e.stopPropagation();
          onAct({ type: 'tap', item, sub });
        }
      : undefined,
    // A double tap opens it: the board asks the agent for a focus on it.
    onDoubleClick: onAct
      ? (e: MouseEvent) => {
          e.stopPropagation();
          onAct({ type: 'ask', what: 'focus', item, ...(kind === 'part' ? { part: id } : { lane: id }) });
        }
      : undefined,
  };
}

const pen = (m: Markings, sub: string) => {
  const crossed = m.crossed.includes(sub);
  return { crossed, circled: !crossed && m.circled.includes(sub) };
};

/** The dots of a walk on one part: done steps filled, steps to come hollow, the played one lit. */
function Dots({ x, y, ns, walk }: { x: number; y: number; ns: readonly number[]; walk: WalkMarks }) {
  return (
    <>
      {ns.map((n, i) => (
        <StepDot key={n} x={x + i * 23} y={y} n={n} size={21} hollow={walk.lit !== undefined && n > walk.lit} lit={walk.lit === n} />
      ))}
    </>
  );
}

/** A small chip with the commit that built a part. */
function CommitChip({ x, y, commit }: { x: number; y: number; commit: string }) {
  const text = commit.length > 16 ? `${commit.slice(0, 15)}…` : commit;
  const w = measure(text, 'ui600', 10.5) + 24;
  return (
    <g>
      <rect x={x} y={y - 9} width={w} height={18} rx={9} fill={T.teal} />
      <path d={`M${x + 7},${y} l3,3 l5,-6`} fill="none" stroke={T.white} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
      <text x={x + 19} y={y + 3.8} fontFamily="Inter, system-ui, sans-serif" fontSize={10.5} fontWeight={600} fill={T.white}>
        {text}
      </text>
    </g>
  );
}

function TrackNo({ x, y, n }: { x: number; y: number; n: number }) {
  return (
    <g>
      <rect x={x - 9} y={y - 9} width={18} height={18} rx={5} fill={T.ink} />
      <text x={x} y={y + 4} textAnchor="middle" fontFamily="Inter, system-ui, sans-serif" fontSize={10.5} fontWeight={700} fill={T.white}>
        {n}
      </text>
    </g>
  );
}

/** What a part says under its name. */
function partLines(part: Part, width: number, nameSize: number, plainMax: number) {
  const name = wrap(part.name, width, 'ui600', nameSize, 2);
  const plainText = part.state === 'building' && !part.external ? 'in work now' : part.plain;
  const plain = plainText && plainMax > 0 ? wrap(plainText, width, 'ui400', nameSize - 1.5, plainMax) : [];
  return { name, plain };
}

/** A commit chip on a part built and checked here. A part that was already there has none. */
const showsCommit = (p: Part) => lookOf(p) === 'built' && p.commit !== undefined;

/* ---------------------------------------------------------------------- flat */

export interface FlatMetrics {
  boxW: number;
  gut: number;
  /** The label column. Zero puts each lane's name on top of its row. */
  labelW: number;
  nameSize: number;
  plainLines: number;
  minBoxH: number;
}

export const FLAT_FULL: FlatMetrics = { boxW: 168, gut: 58, labelW: 136, nameSize: 13, plainLines: 2, minBoxH: 54 };
export const FLAT_SMALL: FlatMetrics = { boxW: 124, gut: 16, labelW: 0, nameSize: 12.5, plainLines: 0, minBoxH: 38 };

export interface FlatLayout {
  width: number;
  height: number;
  grid: Grid;
  lanes: Array<{ id: Id; top: number; bottom: number; name: string[]; note: string[] }>;
  parts: Array<{ part: Part & { lane: Id }; rect: Rect; name: string[]; plain: string[] }>;
  arrows: Array<{ edge: Edge; r: Route; at?: PlacedLabel }>;
}

export function layoutFlat(pm: PipeModel, M: FlatMetrics, withEdges = true): FlatLayout {
  const { col, maxCol, laneIdx } = partColumns(pm);
  const onTop = M.labelW === 0;
  const text = new Map(pm.parts.map((p) => [p.id, partLines(p, M.boxW - 20, M.nameSize, M.plainLines)]));
  const grid: Grid = { left: onTop ? 14 : M.labelW + 18, boxW: M.boxW, gut: M.gut, rows: [], occupied: new Set(), gutterUse: new Map() };
  let y = onTop ? 0 : 14;
  const lanes: FlatLayout['lanes'] = [];
  pm.lanes.forEach((l, i) => {
    const name = wrap(l.name, onTop ? 400 : M.labelW - 16, 'ui600', onTop ? 11.5 : 13, 2);
    const note = l.note && !onTop ? wrap(l.note, M.labelW - 16, 'ui400', 11.5, 3) : [];
    const hs = pm.parts
      .filter((p) => laneIdx.get(p.lane) === i)
      .map((p) => {
        const t = text.get(p.id)!;
        return 20 + t.name.length * 17 + t.plain.length * 15;
      });
    const boxH = Math.max(M.minBoxH, ...hs);
    const padT = onTop ? 26 : 20;
    const padB = onTop ? 12 : 18;
    const labelH = onTop ? 0 : 20 + name.length * 17 + note.length * 15;
    const h = Math.max(labelH, padT + boxH + padB);
    grid.rows.push({ top: y, boxTop: y + padT, boxH, bottom: y + h });
    lanes.push({ id: l.id, top: y, bottom: y + h, name, note });
    y += h + (onTop ? 8 : 10);
  });
  for (const p of pm.parts) grid.occupied.add(`${laneIdx.get(p.lane) ?? 0}/${col.get(p.id) ?? 1}`);
  const at = (id: Id) => {
    const p = pm.parts.find((x) => x.id === id);
    return p ? { r: laneIdx.get(p.lane) ?? 0, c: col.get(p.id) ?? 1 } : undefined;
  };
  const arrows: FlatLayout['arrows'] = withEdges
    ? pm.edges.flatMap((e) => {
        const a = at(e.from);
        const b = at(e.to);
        return a && b ? [{ edge: e, r: route(grid, a.r, a.c, b.r, b.c) }] : [];
      })
    : [];
  const width = grid.left + maxCol * (M.boxW + M.gut) - M.gut + 18;
  const height = y - (onTop ? 8 : 10) + 4;
  const parts = pm.parts.map((p) => {
    const t = text.get(p.id)!;
    return { part: p, rect: cellRect(grid, laneIdx.get(p.lane) ?? 0, col.get(p.id) ?? 1), name: t.name, plain: t.plain };
  });
  const keepOff = parts.map(({ rect: r }) => ({ x: r.x - 12, y: r.y - 14, w: r.w + 14, h: r.h + 16 }));
  placeLabels(
    arrows.map((a) => ({ r: a.r, size: a.edge.label ? labelSize(a.edge.label, 120) : undefined })),
    keepOff,
    { x: 0, y: 0, w: width, h: height },
  ).forEach((l, i) => {
    if (l) arrows[i]!.at = l;
  });
  return { width, height, grid, lanes, parts, arrows };
}

export function FlatSvg(props: PipeSvgProps & { metrics?: FlatMetrics }) {
  const { pm, markings: m, walk, trackNo } = props;
  const M = props.metrics ?? FLAT_FULL;
  const onTop = M.labelW === 0;
  const ids = useSvgIds();
  const L = layoutFlat(pm, M, props.edges !== false);
  return (
    <svg className="kp-svg" width={L.width} height={L.height} viewBox={`0 0 ${L.width} ${L.height}`} role="img" aria-label="the pipeline, flat">
      <Defs ids={ids} />
      {L.lanes.map((lane) => {
        const p = pen(m, `lane:${lane.id}`);
        return (
          <g key={lane.id} {...partTap(props, 'lane', lane.id)} opacity={p.crossed ? 0.42 : undefined}>
            <rect
              x={0}
              y={lane.top}
              width={L.width}
              height={lane.bottom - lane.top}
              rx={10}
              fill={p.circled ? T.tealLight : T.light}
              stroke={p.circled ? T.owner : 'none'}
              strokeWidth={2}
            />
            <Lines x={12} y={lane.top + (onTop ? 17 : 24)} lines={lane.name} face="ui600" size={onTop ? 11.5 : 13} color={onTop ? T.text2 : T.ink} lh={17} />
            <Lines x={12} y={lane.top + 24 + lane.name.length * 17} lines={lane.note} face="ui400" size={11.5} color={T.text2} lh={15} />
          </g>
        );
      })}
      {L.arrows.map((a, i) => (
        <ArrowPath key={i} ids={ids} r={a.r} tone={edgeTone(a.edge, walk)} dashed={a.edge.kind === 'wait'} />
      ))}
      {L.parts.map(({ part, rect: r, name, plain }) => {
        const look = LOOK[lookOf(part)];
        const p = pen(m, `part:${part.id}`);
        const lit = walk?.litPart === part.id;
        const block = name.length * 17 + plain.length * 15;
        const ty = r.y + (r.h - block) / 2 + 13;
        const dots = walk?.dots.get(part.id);
        const n = trackNo?.get(part.id);
        return (
          <g key={part.id} {...partTap(props, 'part', part.id)} data-part={part.id} data-state={lookOf(part)} data-lit={lit ? '' : undefined} opacity={p.crossed ? 0.42 : undefined}>
            {lit && <rect x={r.x - 6} y={r.y - 6} width={r.w + 12} height={r.h + 12} rx={12} fill={T.tealMid} fillOpacity={0.55} />}
            {p.circled && <rect x={r.x - 5} y={r.y - 5} width={r.w + 10} height={r.h + 10} rx={11} fill="none" stroke={T.owner} strokeWidth={2} />}
            <rect
              x={r.x}
              y={r.y}
              width={r.w}
              height={r.h}
              rx={8}
              fill={look.fill}
              stroke={lit ? T.teal : look.stroke}
              strokeWidth={look.width}
              strokeDasharray={look.dash}
              filter={look.glow ? `url(#${ids}-glow)` : undefined}
            />
            <Lines x={r.x + r.w / 2} y={ty} lines={name} face="ui600" size={M.nameSize} color={look.text} lh={17} anchor="middle" />
            <Lines x={r.x + r.w / 2} y={ty + name.length * 17} lines={plain} face="ui400" size={M.nameSize - 1.5} color={look.sub} lh={15} anchor="middle" />
            {dots && walk && <Dots x={r.x + 4} y={r.y + 1} ns={dots} walk={walk} />}
            {showsCommit(part) && !onTop && <CommitChip x={r.x + 4 + (dots?.length ?? 0) * 23} y={r.y + 1} commit={part.commit!} />}
            {n !== undefined && <TrackNo x={r.x + r.w - 2} y={r.y + 1} n={n} />}
          </g>
        );
      })}
      {L.arrows.map((a, i) => (a.at ? <LabelView key={`l${i}`} l={a.at} tone={edgeTone(a.edge, walk)} /> : null))}
    </svg>
  );
}

/* -------------------------------------------------------------------- layers */

/** Appendix C, in px: floors 176 apart, columns 220 apart, blocks 170 by 64, a depth of 90 by 54. */
const LY = { slabX: 200, colStep: 220, blockOff: 62, floorStep: 176, top: 70, blockW: 170, blockH: 64, depthX: 90, depthY: 54, slabH: 14 } as const;

export function layersSize(pm: PipeModel): { width: number; height: number } {
  const { maxCol } = partColumns(pm);
  const W = LY.blockOff + LY.colStep * (maxCol - 1) + LY.blockW + 60;
  return { width: LY.slabX + W + LY.depthX + 12, height: LY.top + (pm.lanes.length - 1) * LY.floorStep + LY.depthY + LY.slabH + 12 };
}

export function LayersSvg(props: PipeSvgProps) {
  const { pm, markings: m, walk } = props;
  const ids = useSvgIds();
  const { col, maxCol, laneIdx } = partColumns(pm);
  const W = LY.blockOff + LY.colStep * (maxCol - 1) + LY.blockW + 60;
  const { width, height } = layersSize(pm);
  const slabTop = (f: number) => LY.top + f * LY.floorStep;
  const bx = (c: number) => LY.slabX + LY.blockOff + (c - 1) * LY.colStep;
  // A block stands on its floor, 20 px behind the front edge.
  const frontTop = (f: number) => slabTop(f) - 30;
  const where = (id: Id) => {
    const p = pm.parts.find((q) => q.id === id);
    return p ? { f: laneIdx.get(p.lane) ?? 0, c: col.get(p.id) ?? 1 } : undefined;
  };
  const occupied = new Set(pm.parts.map((p) => `${laneIdx.get(p.lane) ?? 0}/${col.get(p.id) ?? 1}`));
  const gutter = (c: number) => bx(c) + LY.blockW + 16 + 17;

  const edges =
    props.edges === false
      ? []
      : pm.edges.flatMap((e) => {
          const a = where(e.from);
          const b = where(e.to);
          if (!a || !b) return [];
          const off = b.f > a.f ? -12 : b.f < a.f ? 12 : 0;
          const ax = bx(a.c) + LY.blockW / 2 + off;
          const bxx = bx(b.c) + LY.blockW / 2 + off;
          let pts: Pt[];
          if (a.f === b.f) {
            const my = frontTop(a.f) + LY.blockH / 2;
            let between = false;
            for (let k = Math.min(a.c, b.c) + 1; k < Math.max(a.c, b.c); k++) if (occupied.has(`${a.f}/${k}`)) between = true;
            if (!between && b.c > a.c) pts = [[bx(a.c) + LY.blockW + 16, my], [bx(b.c), my]];
            else if (!between && b.c < a.c) pts = [[bx(a.c), my], [bx(b.c) + LY.blockW + 16, my]];
            else {
              const y = slabTop(a.f) + 44;
              pts = [[ax, frontTop(a.f) + LY.blockH], [ax, y], [bxx, y], [bxx, frontTop(b.f) + LY.blockH]];
            }
          } else {
            const down = b.f > a.f;
            const y0 = down ? slabTop(a.f) + LY.depthY + LY.slabH + 4 : frontTop(a.f) - 12;
            const y1 = down ? frontTop(b.f) - 12 : slabTop(b.f) + LY.depthY + LY.slabH + 4;
            const gapA = down ? slabTop(a.f) + LY.depthY + LY.slabH + 22 : frontTop(a.f) - 30;
            const gapB = down ? frontTop(b.f) - 30 : slabTop(b.f) + LY.depthY + LY.slabH + 22;
            if (a.c === b.c && Math.abs(b.f - a.f) === 1) pts = [[ax, y0], [ax, y1]];
            else if (Math.abs(b.f - a.f) === 1) pts = [[ax, y0], [ax, gapB], [bxx, gapB], [bxx, y1]];
            else {
              // Several floors apart: climb in the strip between columns, never through a block.
              const gx = gutter(Math.min(a.c, b.c)) + (down ? -6 : 6);
              pts = [[ax, y0], [ax, gapA], [gx, gapA], [gx, gapB], [bxx, gapB], [bxx, y1]];
            }
          }
          return [{ edge: e, r: finish(pts) }];
        });
  const blockRects: Rect[] = pm.parts.map((p) => ({
    x: bx(col.get(p.id) ?? 1) - 12,
    y: frontTop(laneIdx.get(p.lane) ?? 0) - 24,
    w: LY.blockW + 30,
    h: LY.blockH + 24,
  }));
  const labels = placeLabels(
    edges.map((e) => ({ r: e.r, size: e.edge.label ? labelSize(e.edge.label, 110) : undefined })),
    blockRects,
    { x: 0, y: 0, w: width, h: height },
  );

  return (
    <svg className="kp-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="the pipeline, in layers">
      <Defs ids={ids} />
      {pm.lanes.map((l, i) => {
        const y = slabTop(i);
        const sx = LY.slabX;
        const p = pen(m, `lane:${l.id}`);
        const name = wrap(l.name, LY.slabX - 30, 'ui600', 15, 2);
        const note = l.note ? wrap(l.note, LY.slabX - 30, 'ui400', 12.5, 3) : [];
        const fill = p.circled ? { top: T.tealLight, front: T.tealMid, side: '#7CC3B9', stroke: T.teal } : { top: T.white, front: T.light2, side: T.line, stroke: T.grey2 };
        const D = LY.depthX;
        const H = LY.depthY;
        return (
          <g key={l.id} opacity={p.crossed ? 0.42 : undefined}>
            {/* The lane's name stands beside the floor. It is not part of what a mark on the lane takes in. */}
            <Lines x={14} y={y + 24} lines={name} face="ui600" size={15} color={T.ink} lh={19} />
            <Lines x={14} y={y + 24 + name.length * 19} lines={note} face="ui400" size={12.5} color={T.text2} lh={16} />
            <g {...partTap(props, 'lane', l.id)}>
              {/* The floor with the blocks that stand on it: what a tap or a circle on the lane takes in. */}
              <rect x={sx} y={frontTop(i) - 14} width={W + D} height={y + H + LY.slabH - (frontTop(i) - 14)} fill="transparent" />
              <polygon points={`${sx},${y + H} ${sx + W},${y + H} ${sx + W + D},${y} ${sx + D},${y}`} fill={fill.top} stroke={fill.stroke} strokeWidth={1.2} />
              <polygon points={`${sx},${y + H} ${sx + W},${y + H} ${sx + W},${y + H + LY.slabH} ${sx},${y + H + LY.slabH}`} fill={fill.front} stroke={fill.stroke} strokeWidth={1.2} />
              <polygon points={`${sx + W},${y + H} ${sx + W + D},${y} ${sx + W + D},${y + LY.slabH} ${sx + W},${y + H + LY.slabH}`} fill={fill.side} stroke={fill.stroke} strokeWidth={1.2} />
            </g>
          </g>
        );
      })}
      {edges.map((e, i) => {
        const tone = edgeTone(e.edge, walk);
        return <ArrowPath key={i} ids={ids} r={e.r} tone={tone} dashed={e.edge.kind === 'wait'} width={tone === 'grey' ? 1.4 : 1.9} />;
      })}
      {pm.parts.map((part) => {
        const f = laneIdx.get(part.lane) ?? 0;
        const X = bx(col.get(part.id) ?? 1);
        const Y = frontTop(f);
        const look: LookStyle = LOOK[lookOf(part)];
        const p = pen(m, `part:${part.id}`);
        const lit = walk?.litPart === part.id;
        const t = partLines(part, LY.blockW - 16, 13, 2);
        const plain = t.name.length > 1 ? t.plain.slice(0, 1) : t.plain;
        const block = t.name.length * 16 + plain.length * 14;
        const ty = Y + (LY.blockH - block) / 2 + 12;
        const stroke = { stroke: lit ? T.teal : look.stroke, strokeWidth: look.width, strokeDasharray: look.dash, strokeLinejoin: 'round' as const };
        const dots = walk?.dots.get(part.id);
        const n = props.trackNo?.get(part.id);
        return (
          <g key={part.id} {...partTap(props, 'part', part.id)} data-part={part.id} data-state={lookOf(part)} data-lit={lit ? '' : undefined} opacity={p.crossed ? 0.42 : undefined}>
            {lit && (
              <path
                d={roundedPath([[X - 7, Y - 3], [X + 7, Y - 17], [X + 193, Y - 17], [X + 193, Y + 57], [X + 179, Y + 71], [X - 7, Y + 71]], 4) + ' Z'}
                fill={T.tealMid}
                fillOpacity={0.6}
              />
            )}
            {p.circled && <rect x={X - 8} y={Y - 18} width={LY.blockW + 32} height={LY.blockH + 26} rx={12} fill="none" stroke={T.owner} strokeWidth={2} />}
            <g filter={look.glow ? `url(#${ids}-glow)` : undefined}>
              <polygon points={`${X},${Y} ${X + 170},${Y} ${X + 186},${Y - 10} ${X + 16},${Y - 10}`} fill={look.top} {...stroke} />
              <polygon points={`${X + 170},${Y} ${X + 186},${Y - 10} ${X + 186},${Y + 54} ${X + 170},${Y + 64}`} fill={look.side} {...stroke} />
              <rect x={X} y={Y} width={170} height={64} fill={look.fill} {...stroke} />
            </g>
            <Lines x={X + 85} y={ty} lines={t.name} face="ui600" size={13} color={look.text} lh={16} anchor="middle" />
            <Lines x={X + 85} y={ty + t.name.length * 16} lines={plain} face="ui400" size={11} color={look.sub} lh={14} anchor="middle" />
            {dots && walk && <Dots x={X + 2} y={Y - 1} ns={dots} walk={walk} />}
            {showsCommit(part) && <CommitChip x={X + 4 + (dots?.length ?? 0) * 23} y={Y - 1} commit={part.commit!} />}
            {n !== undefined && <TrackNo x={X + 160} y={Y + 1} n={n} />}
          </g>
        );
      })}
      {labels.map((l, i) => (l ? <LabelView key={`l${i}`} l={l} tone={edgeTone(edges[i]!.edge, walk)} /> : null))}
    </svg>
  );
}
