import type { LanesBody, LanesFlow, LanesPicture, LanesStep, Markings } from '@keel/protocol';
import { asPart, drawingOrder } from './build';
import type { Grid, PlacedLabel, Rect, Route } from './grid';
import { cellRect, gutterX, placeLabels, route } from './grid';
import { measure, widest, wrap } from './measure';
import { Gaps, Risk, svgTapper, wholeClass } from './parts';
import { ArrowPath, Defs, LabelView, Lines, StepDot, labelSize, useSvgIds } from './svg';
import { T } from './theme';
import type { PictureAct, PictureProps } from './types';
import { NO_MARKINGS } from './types';

/**
 * Lanes: who does what, in what order. One row per lane, one box per step, arrows between.
 * Columns come from the step numbers and the flows, so time runs left to right. Arrows run
 * in the gutters between columns and never through a box, and labels sit where they cover
 * no box. Ported from spike S3, where every layout fault was fixed here and not in a spec.
 */

/** What turns blue in a spread: what no other approach has. Empty for a lanes picture. */
export interface Blue {
  lanes: ReadonlySet<string>;
  steps: ReadonlySet<string>;
  /** By position in `flows`. */
  flows: ReadonlySet<number>;
}

export const NO_BLUE: Blue = { lanes: new Set(), steps: new Set(), flows: new Set() };

const STEP_FACE = 'ui500' as const;
const STEP_SIZE = 12.5;
const STEP_LH = 16;
const BOX_PY = 10;
const BOX_PX = 10;
const LANE_GAP = 8;

interface Metrics {
  boxW: number;
  gut: number;
  /** The label column, left of the boxes. Zero when labels sit on top. */
  labelW: number;
  padT: number;
  padB: number;
}

/** A lanes picture: labels in a column on the left. A spread: labels on top, so approaches stay narrow. */
const WIDE: Metrics = { boxW: 160, gut: 56, labelW: 124, padT: 14, padB: 14 };
const COMPACT: Metrics = { boxW: 128, gut: 52, labelW: 0, padT: 8, padB: 12 };

/**
 * A column for each step. A numbered step is never left of the one before it. A step fed
 * from another lane may sit straight above or below the step that feeds it. A step fed from
 * its own lane goes one column right. The divider starts a fresh column.
 */
export function assignColumns(p: LanesBody): { col: Map<string, number>; maxCol: number; dividerCol?: number } {
  const laneOf = new Map(p.steps.map((s) => [s.id, s.lane]));
  const laneIdx = new Map(p.lanes.map((l, i) => [l.id, i]));
  // Numbered steps in number order; an unnumbered step follows the step listed just before it.
  const numbered = p.steps.filter((s) => s.n !== undefined).sort((a, b) => (a.n ?? 0) - (b.n ?? 0));
  const order: LanesStep[] = [];
  const after = new Map<string, LanesStep[]>();
  let lastListed: string | undefined;
  for (const s of p.steps) {
    if (s.n === undefined) {
      if (lastListed) after.set(lastListed, [...(after.get(lastListed) ?? []), s]);
      else order.push(s);
    }
    lastListed = s.id;
  }
  const emit = (s: LanesStep) => {
    order.push(s);
    for (const t of after.get(s.id) ?? []) emit(t);
  };
  if (numbered.length > 0) numbered.forEach(emit);
  else {
    // Nothing numbered: the order is the order listed.
    order.length = 0;
    order.push(...p.steps);
  }
  // A step left out above (it follows an unnumbered step that was itself never reached) keeps its place.
  for (const s of p.steps) if (!order.includes(s)) order.push(s);

  const col = new Map<string, number>();
  const occ = new Set<string>();
  // Cells a straight vertical arrow runs through.
  const pass = new Set<string>();
  let prevCol = 1;
  let floor = 1;
  let maxCol = 0;
  let dividerCol: number | undefined;
  const rowsFree = (c: number, r1: number, r2: number) => {
    for (let r = Math.min(r1, r2) + 1; r < Math.max(r1, r2); r++) if (occ.has(`${r}/${c}`)) return false;
    return true;
  };
  for (const s of order) {
    const r = laneIdx.get(s.lane) ?? 0;
    const preds = (p.flows ?? []).filter((f) => f.to === s.id && f.from !== s.id && col.has(f.from));
    let c = s.col;
    if (c === undefined) {
      let lo = Math.max(1, floor);
      if (s.n !== undefined) lo = Math.max(lo, prevCol);
      for (const f of preds) {
        const pc = col.get(f.from) ?? 1;
        lo = Math.max(lo, laneOf.get(f.from) === s.lane ? pc + 1 : pc);
      }
      if (p.divider?.before === s.id) lo = Math.max(lo, maxCol + 1);
      c = lo;
      for (;;) {
        if (occ.has(`${r}/${c}`) || pass.has(`${r}/${c}`)) {
          c++;
          continue;
        }
        const cc: number = c;
        const blocked = preds.some((f) => col.get(f.from) === cc && !rowsFree(cc, laneIdx.get(laneOf.get(f.from) ?? '') ?? 0, r));
        if (blocked) {
          c++;
          continue;
        }
        break;
      }
    } else {
      while (occ.has(`${r}/${c}`)) c++;
    }
    col.set(s.id, c);
    occ.add(`${r}/${c}`);
    maxCol = Math.max(maxCol, c);
    for (const f of preds) {
      if (col.get(f.from) !== c) continue;
      const pr = laneIdx.get(laneOf.get(f.from) ?? '') ?? 0;
      for (let k = Math.min(pr, r) + 1; k < Math.max(pr, r); k++) pass.add(`${k}/${c}`);
    }
    if (p.divider?.before === s.id) {
      floor = c;
      dividerCol = c;
    }
    if (s.n !== undefined) prevCol = c;
  }
  return { col, maxCol: Math.max(1, maxCol), dividerCol };
}

export interface LanesBox {
  step: LanesStep;
  row: number;
  col: number;
  lines: string[];
  rect: Rect;
}

export interface LanesArrow {
  flow: LanesFlow;
  index: number;
  r: Route;
  at?: PlacedLabel;
}

export interface LanesLayout {
  width: number;
  height: number;
  grid: Grid;
  compact: boolean;
  lanes: Array<{ id: string; top: number; bottom: number; name: string[]; note: string[] }>;
  boxes: LanesBox[];
  arrows: LanesArrow[];
  dividerX?: number;
  dividerLabel?: string;
}

const LABEL_FACE = 'ui600' as const;
const NOTE_FACE = 'ui400' as const;

/** Lay a lanes body out. Pure: the same body gives the same layout. */
export function layoutLanes(p: LanesBody, compact: boolean): LanesLayout {
  const M = compact ? COMPACT : WIDE;
  const { col, maxCol, dividerCol } = assignColumns(p);
  const laneIdx = new Map(p.lanes.map((l, i) => [l.id, i]));
  const nameSize = compact ? 11.5 : 12.5;
  const noteSize = compact ? 10.5 : 11;
  const labelMax = compact ? 150 : M.labelW - 16;
  const laneText = p.lanes.map((l) => ({
    id: l.id,
    name: wrap(l.name, labelMax, LABEL_FACE, nameSize, 2),
    note: l.note ? wrap(compact ? `· ${l.note}` : l.note, labelMax, NOTE_FACE, noteSize, compact ? 1 : 3) : [],
  }));

  // Labels on top take a row of their own in each lane; the first box keeps clear of the
  // widest label, so an arrow dropping into column 1 never runs through a label.
  let left = M.labelW + 22;
  if (compact) {
    const labelEnd = Math.max(0, ...laneText.map((t) => 12 + Math.max(widest(t.name, LABEL_FACE, nameSize), widest(t.note, NOTE_FACE, noteSize))));
    left = Math.max(18, Math.ceil(labelEnd + 28 - M.boxW / 2));
  }

  const boxes = p.steps.map((s) => ({
    step: s,
    row: laneIdx.get(s.lane) ?? 0,
    col: col.get(s.id) ?? 1,
    lines: wrap(s.text, M.boxW - 2 * BOX_PX, STEP_FACE, STEP_SIZE, 4),
  }));
  const byId = new Map(boxes.map((b) => [b.step.id, b]));
  const flows = (p.flows ?? []).map((f, index) => ({ f, index })).filter(({ f }) => byId.has(f.from) && byId.has(f.to));
  // Rows that hold a loop back (drawn under the boxes) need more room at the bottom.
  const loopRows = new Set(
    flows
      .filter(({ f }) => {
        const a = byId.get(f.from)!;
        const b = byId.get(f.to)!;
        return a.row === b.row && (b.col === a.col || b.col < a.col - 1);
      })
      .map(({ f }) => byId.get(f.from)!.row),
  );

  const hasDots = p.steps.some((s) => s.n !== undefined);
  const top = p.divider?.label ? 24 : hasDots ? 12 : 4;
  const grid: Grid = { left, boxW: M.boxW, gut: M.gut, rows: [], occupied: new Set(), gutterUse: new Map() };
  let y = top;
  const lanes: LanesLayout['lanes'] = [];
  p.lanes.forEach((_, i) => {
    const t = laneText[i]!;
    const hs = boxes.filter((b) => b.row === i).map((b) => b.lines.length * STEP_LH + 2 * BOX_PY);
    const boxH = Math.max(40, ...hs);
    const labelRow = compact ? 8 + t.name.length * 14 + t.note.length * 13 + (hasDots ? 10 : 4) : 0;
    const labelH = compact ? 0 : 14 + t.name.length * 16 + t.note.length * 14 + 10;
    const padT = M.padT + labelRow;
    const bottomPad = M.padB + (loopRows.has(i) ? 26 : 0);
    const h = Math.max(labelH, padT + boxH + bottomPad);
    grid.rows.push({ top: y, boxTop: y + padT, boxH, bottom: y + h });
    lanes.push({ id: t.id, top: y, bottom: y + h, name: t.name, note: t.note });
    y += h + LANE_GAP;
  });
  for (const b of boxes) grid.occupied.add(`${b.row}/${b.col}`);
  // An arrow in the divider's gutter keeps off the dashed line.
  if (dividerCol !== undefined) grid.gutterUse.set(dividerCol - 1, 1);

  const arrows: LanesArrow[] = flows.map(({ f, index }) => {
    const a = byId.get(f.from)!;
    const b = byId.get(f.to)!;
    return { flow: f, index, r: route(grid, a.row, a.col, b.row, b.col) };
  });
  const width = grid.left + maxCol * (M.boxW + M.gut) - M.gut + 26;
  const height = y - LANE_GAP + 4;
  const placedBoxes = boxes.map((b) => ({ ...b, rect: cellRect(grid, b.row, b.col) }));
  const keepOff: Rect[] = placedBoxes.map(({ rect: r }) => ({ x: r.x - 12, y: r.y - 12, w: r.w + 14, h: r.h + 14 }));
  // Labels keep off the lane names too.
  if (compact) {
    lanes.forEach((l) =>
      keepOff.push({ x: 8, y: l.top + 2, w: 8 + Math.max(widest(l.name, LABEL_FACE, nameSize), widest(l.note, NOTE_FACE, noteSize)), h: 8 + l.name.length * 14 + l.note.length * 13 }),
    );
  }
  const labels = placeLabels(
    arrows.map((a) => ({
      r: a.r,
      size: a.flow.label ? labelSize(a.flow.label, a.r.horizontal ? Math.max(96, Math.min(200, a.r.segLen - 28)) : 116) : undefined,
    })),
    keepOff,
    { x: 0, y: 0, w: width, h: height },
  );
  labels.forEach((l, i) => {
    if (l) arrows[i]!.at = l;
  });

  return {
    width,
    height,
    grid,
    compact,
    lanes,
    boxes: placedBoxes,
    arrows,
    ...(dividerCol !== undefined ? { dividerX: gutterX(grid, dividerCol - 1) } : {}),
    ...(p.divider?.label ? { dividerLabel: p.divider.label } : {}),
  };
}

export interface LanesSvgProps {
  body: LanesBody;
  compact: boolean;
  item: string;
  markings: Markings;
  /** The sub of a step: "step:<id>", or "step:a-<id>" inside a spread. */
  stepSub: (id: string) => string;
  /** The sub of a lane, when lanes are tap targets in this picture. */
  laneSub?: (id: string) => string;
  blue?: Blue;
  onAct?: (act: PictureAct) => void;
}

/** The drawing alone: lanes, boxes, arrows, labels, the divider. */
export function LanesSvg({ body, compact, item, markings, stepSub, laneSub, blue = NO_BLUE, onAct }: LanesSvgProps) {
  const ids = useSvgIds();
  const L = layoutLanes(body, compact);
  const tap = svgTapper(item, onAct);
  const nameSize = compact ? 11.5 : 12.5;
  const noteSize = compact ? 10.5 : 11;
  // Drawn on in reading order: the lanes, the steps by column, the arrows, then the divider.
  const boxOf = new Map(L.boxes.map((b, i) => [b.step.id, i]));
  const order = drawingOrder(
    L.lanes.length,
    L.boxes,
    L.arrows.map((a) => ({ from: boxOf.get(a.flow.from)!, to: boxOf.get(a.flow.to)! })),
  );
  const dividerOrder = L.arrows.length;
  return (
    <svg className="kp-svg" width={L.width} height={L.height} viewBox={`0 0 ${L.width} ${L.height}`} role="img" aria-label="lanes">
      <Defs ids={ids} />
      {L.lanes.map((lane, i) => {
        const isBlue = blue.lanes.has(lane.id);
        const sub = laneSub?.(lane.id);
        const crossed = sub !== undefined && markings.crossed.includes(sub);
        const circled = sub !== undefined && !crossed && markings.circled.includes(sub);
        const nameY = lane.top + (compact ? 17 : 22);
        return (
          <g key={lane.id} {...(sub ? tap(sub) : {})} {...asPart('shape', order.bands[i])} data-lane={lane.id} data-blue={isBlue ? '' : undefined} opacity={crossed ? 0.42 : undefined}>
            <rect
              x={0}
              y={lane.top}
              width={L.width}
              height={lane.bottom - lane.top}
              rx={10}
              fill={isBlue ? T.agentPale : T.light}
              stroke={circled ? T.owner : isBlue ? T.blue : 'none'}
              strokeWidth={circled ? 2 : 1.5}
            />
            <Lines x={12} y={nameY} lines={lane.name} face={LABEL_FACE} size={nameSize} color={isBlue ? T.blue : T.text2} lh={compact ? 14 : 16} />
            <Lines
              x={12}
              y={nameY + lane.name.length * (compact ? 14 : 16) - (compact ? 1 : 0)}
              lines={lane.note}
              face={NOTE_FACE}
              size={noteSize}
              color={T.grey}
              lh={compact ? 13 : 14}
            />
          </g>
        );
      })}
      {L.dividerX !== undefined && (
        <g>
          <line {...asPart('line', dividerOrder)} data-dashed="" x1={L.dividerX} x2={L.dividerX} y1={4} y2={L.height} stroke={T.text2} strokeWidth={2} strokeDasharray="8 6" />
          {L.dividerLabel && (
            <text {...asPart('label', dividerOrder)} x={L.dividerX + 8} y={15} fontFamily="Inter, system-ui, sans-serif" fontSize={11.5} fontWeight={600} fill={T.text2}>
              {L.dividerLabel}
            </text>
          )}
        </g>
      )}
      {L.arrows.map((a, j) => (
        <g key={a.index} data-flow={`${a.flow.from}>${a.flow.to}`} data-blue={blue.flows.has(a.index) ? '' : undefined}>
          <ArrowPath ids={ids} r={a.r} tone={blue.flows.has(a.index) ? 'blue' : 'teal'} dashed={a.flow.wait === true} order={order.arrows[j]} />
        </g>
      ))}
      {L.boxes.map(({ step, rect: r, lines }, i) => {
        const isBlue = blue.steps.has(step.id);
        const sub = stepSub(step.id);
        const crossed = markings.crossed.includes(sub);
        const circled = !crossed && markings.circled.includes(sub);
        const textTop = r.y + (r.h - lines.length * STEP_LH) / 2 + 12;
        return (
          <g key={step.id} {...tap(sub)} {...asPart('shape', order.boxes[i])} data-blue={isBlue ? '' : undefined} opacity={crossed ? 0.42 : undefined}>
            {circled && <rect x={r.x - 4} y={r.y - 4} width={r.w + 8} height={r.h + 8} rx={11} fill="none" stroke={T.owner} strokeWidth={2} />}
            <rect
              x={r.x}
              y={r.y}
              width={r.w}
              height={r.h}
              rx={8}
              fill={isBlue ? T.agentBg : T.white}
              stroke={isBlue ? T.blue : T.ink}
              strokeWidth={isBlue ? 2 : 1.5}
            />
            <Lines x={r.x + r.w / 2} y={textTop} lines={lines} face={STEP_FACE} size={STEP_SIZE} color={isBlue ? T.blue : T.ink} lh={STEP_LH} anchor="middle" />
            {step.n !== undefined && <StepDot x={r.x + 2} y={r.y + 2} n={step.n} />}
            {crossed && (
              <path d={`M${r.x + 6},${r.y + 6} L${r.x + r.w - 6},${r.y + r.h - 6} M${r.x + r.w - 6},${r.y + 6} L${r.x + 6},${r.y + r.h - 6}`} stroke={T.grey} strokeWidth={1.5} />
            )}
          </g>
        );
      })}
      {/* Labels last, so they sit above every line. */}
      {L.arrows.map((a, j) => (a.at ? <LabelView key={`l${a.index}`} l={a.at} tone={blue.flows.has(a.index) ? 'blue' : 'teal'} order={order.arrows[j]} /> : null))}
    </svg>
  );
}

/** A `lanes` picture: a white sheet with its title, the drawing, the caption, the risk and the gaps. */
export function LanesCard({ item, markings, onAct }: PictureProps & { item: { picture: LanesPicture } }) {
  const p = item.picture;
  const m = markings ?? NO_MARKINGS;
  const L = layoutLanes(p, false);
  const width = Math.max(420, L.width + 40, Math.ceil(measure(p.title, 'head600', 19)) + 40);
  return (
    <article className={`kp kp-sheet kp-lanes${wholeClass(m)}`} {...asPart('frame')} data-kind="lanes" style={{ width }}>
      <h3 className="kp-title" {...asPart('head')}>{p.title}</h3>
      <LanesSvg body={p} compact={false} item={item.id} markings={m} stepSub={(id) => `step:${id}`} laneSub={(id) => `lane:${id}`} onAct={onAct} />
      {p.caption && <p className="kp-caption" {...asPart('block')}>{p.caption}</p>}
      {p.risk && <Risk>{p.risk}</Risk>}
      <Gaps gaps={p.gaps} />
    </article>
  );
}
