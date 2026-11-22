import { useId } from 'react';
import { asPart } from './build';
import type { Face } from './measure';
import { FAMILY, WEIGHT, widest, wrap } from './measure';
import type { LabelSize, PlacedLabel, Route } from './grid';
import { roundedPath } from './grid';
import { T } from './theme';

/** Bits of SVG every diagram shares: arrow heads, labels, step dots, lines of text. */

export type ArrowTone = 'teal' | 'blue' | 'grey' | 'ink';

const STROKE: Record<ArrowTone, string> = { teal: T.teal, blue: T.blue, grey: T.grey, ink: T.text2 };
const LABEL_INK: Record<ArrowTone, string> = { teal: T.tealDark, blue: T.blue, grey: T.text2, ink: T.text2 };

/**
 * A prefix for ids inside one picture's SVG, so two pictures on one page never share a
 * marker. React's own id holds characters that `url(#...)` does not take.
 */
export function useSvgIds(): string {
  return `kp${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

/** An arrow head's length, in widths of its line: the marker scales with the stroke. */
export const HEAD = 7;
export const LINE_WIDTH = 1.8;
export const DASHED_WIDTH = 2;

export function Defs({ ids }: { ids: string }) {
  const head = (tone: ArrowTone) => (
    <marker key={tone} id={`${ids}-ah-${tone}`} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth={HEAD} markerHeight={HEAD} orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill={STROKE[tone]} />
    </marker>
  );
  return (
    <defs>
      {head('teal')}
      {head('blue')}
      {head('grey')}
      {head('ink')}
      <filter id={`${ids}-glow`} x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0" dy="0" stdDeviation="5" floodColor={T.blue} floodOpacity="0.45" />
      </filter>
      <filter id={`${ids}-lit`} x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0" dy="0" stdDeviation="4" floodColor={T.teal} floodOpacity="0.55" />
      </filter>
    </defs>
  );
}

/** An arrow: a line of the drawing. `order` is its place among the drawing's lines (see `build.ts`). */
export function ArrowPath({ ids, r, tone, dashed, width, order }: { ids: string; r: Route; tone: ArrowTone; dashed?: boolean; width?: number; order?: number }) {
  return (
    <path
      {...asPart('line', order)}
      data-dashed={dashed ? '' : undefined}
      d={roundedPath(r.pts)}
      fill="none"
      stroke={STROKE[tone]}
      strokeWidth={width ?? (dashed ? DASHED_WIDTH : LINE_WIDTH)}
      strokeDasharray={dashed ? '7 6' : undefined}
      markerEnd={`url(#${ids}-ah-${tone})`}
    />
  );
}

export const LABEL_FACE: Face = 'ui500';
export const LABEL_SIZE = 11.5;
const LABEL_LH = 14;

/** The room a label takes, for placement before drawing. */
export function labelSize(text: string, maxW: number): LabelSize {
  const lines = wrap(text, maxW, LABEL_FACE, LABEL_SIZE, 4);
  return { lines, w: widest(lines, LABEL_FACE, LABEL_SIZE) + 10, h: lines.length * LABEL_LH + 6 };
}

/**
 * A label centred on its point, on a pale plate so the line underneath stays readable. `order`
 * is its line's, so a label comes in after the line it names.
 */
export function LabelView({ l, tone, order }: { l: PlacedLabel; tone: ArrowTone; order?: number }) {
  return (
    <g {...asPart('label', order)}>
      <rect x={l.x - l.w / 2} y={l.y - l.h / 2} width={l.w} height={l.h} rx={5} fill={T.white} fillOpacity={0.94} />
      {l.lines.map((s, i) => (
        <text
          key={i}
          x={l.x}
          y={l.y - l.h / 2 + 14 + i * LABEL_LH}
          textAnchor="middle"
          fontFamily={FAMILY[LABEL_FACE]}
          fontSize={LABEL_SIZE}
          fontWeight={WEIGHT[LABEL_FACE]}
          fill={LABEL_INK[tone]}
        >
          {s}
        </text>
      ))}
    </g>
  );
}

/** A numbered dot. `hollow` is a step not reached yet; `lit` is the step being played. */
export function StepDot({ x, y, n, size = 20, hollow, lit }: { x: number; y: number; n: number; size?: number; hollow?: boolean; lit?: boolean }) {
  const r = size / 2;
  return (
    <g>
      {lit && <circle cx={x} cy={y} r={r + 4} fill={T.tealMid} fillOpacity={0.6} />}
      <circle cx={x} cy={y} r={r} fill={hollow ? T.white : T.teal} stroke={hollow ? T.teal : T.white} strokeWidth={1.5} />
      <text x={x} y={y + 4} textAnchor="middle" fontFamily={FAMILY.ui700} fontSize={n > 9 ? 10 : 11} fontWeight={700} fill={hollow ? T.teal : T.white}>
        {n}
      </text>
    </g>
  );
}

export function Lines({
  x,
  y,
  lines,
  face,
  size,
  color,
  lh,
  anchor = 'start',
}: {
  x: number;
  y: number;
  lines: readonly string[];
  face: Face;
  size: number;
  color: string;
  lh: number;
  anchor?: 'start' | 'middle' | 'end';
}) {
  return (
    <>
      {lines.map((l, i) => (
        <text key={i} x={x} y={y + i * lh} textAnchor={anchor} fontFamily={FAMILY[face]} fontSize={size} fontWeight={WEIGHT[face]} fill={color}>
          {l}
        </text>
      ))}
    </>
  );
}

/**
 * A thin grey cross laid over a crossed-out thing, under the owner's own stroke, so the thing
 * reads as rejected even where the stroke is small. It fills its positioned parent.
 */
export function CrossOver() {
  return (
    <svg className="kp-crossover" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
      <path {...asPart('line')} d="M3,3 L97,97 M97,3 L3,97" stroke={T.grey} strokeWidth={2} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

