import type { MiniPicture, Tone } from '@keel/protocol';
import type { Pt, Rect, Route } from './grid';
import { finish, placeLabels } from './grid';
import { measure, widest, wrap } from './measure';
import { Star, svgTapper, wholeClass } from './parts';
import { ArrowPath, Defs, LabelView, Lines, labelSize, useSvgIds } from './svg';
import { T } from './theme';
import type { PictureProps } from './types';
import { NO_MARKINGS } from './types';

/**
 * A small reply picture: two to five boxes and the arrows between them, in an agent card.
 * Boxes stand in columns by how far down the flow they are, so a flow runs left to right;
 * a flow back runs under the boxes, and a flow that skips a column runs over them.
 */

const TONE: Record<Tone, { fill: string; stroke: string; text: string; sub: string; width: number }> = {
  plain: { fill: T.white, stroke: T.ink, text: T.ink, sub: T.text2, width: 1.5 },
  blue: { fill: '#D7E0FB', stroke: T.blue, text: T.blue, sub: T.blue, width: 1.75 },
  teal: { fill: T.tealLight, stroke: T.teal, text: T.tealDark, sub: T.tealDark, width: 1.5 },
  grey: { fill: T.ground, stroke: T.grey2, text: T.grey, sub: T.grey, width: 1.5 },
  dark: { fill: T.fill, stroke: T.fill, text: T.white, sub: '#C9D2E3', width: 1.5 },
};

const NAME = { face: 'ui600', size: 13, lh: 16 } as const;
const SUB = { face: 'ui400', size: 11.5, lh: 14 } as const;
const PAD_X = 14;
const ROW_GAP = 12;
const MARGIN = 20;

export interface MiniLayout {
  width: number;
  height: number;
  boxes: Array<{ rect: Rect; name: string[]; sub: string[] }>;
  arrows: Array<{ r: Route; label?: string; wait?: boolean; at?: ReturnType<typeof placeLabels>[number] }>;
}

export function layoutMini(p: MiniPicture): MiniLayout {
  const n = p.boxes.length;
  const flows: NonNullable<MiniPicture['flows']> = p.flows ?? p.boxes.slice(1).map((_, i) => ({ from: i + 1, to: i + 2 }));
  // How far down the flow each box is. A flow to a box listed earlier is a flow back.
  const rank = p.boxes.map(() => 0);
  const touched = new Set(flows.flatMap((f) => [f.from - 1, f.to - 1]));
  for (let i = 0; i < n; i++) {
    // A box no flow touches stands after the box listed before it.
    if (!touched.has(i) && i > 0) rank[i] = rank[i - 1]! + 1;
    for (const f of flows) if (f.from - 1 === i && f.to - 1 > i) rank[f.to - 1] = Math.max(rank[f.to - 1]!, rank[i]! + 1);
  }
  const text = p.boxes.map((b) => {
    const name = wrap(b.text, 176, NAME.face, NAME.size, 2);
    const sub = b.sub ? wrap(b.sub, 176, SUB.face, SUB.size, 2) : [];
    const w = Math.max(64, Math.ceil(Math.max(widest(name, NAME.face, NAME.size), widest(sub, SUB.face, SUB.size)) + 2 * PAD_X));
    const h = 16 + name.length * NAME.lh + sub.length * SUB.lh + (sub.length ? 2 : 0);
    return { name, sub, w, h: Math.max(36, h) };
  });
  const cols = Math.max(...rank) + 1;
  const colW = Array.from({ length: cols }, (_, c) => Math.max(...text.filter((_, i) => rank[i] === c).map((t) => t.w)));
  // The gap before a column fits the longest label of a flow that crosses it.
  const gapBefore = Array.from({ length: cols }, (_, c) => {
    const labels = flows.filter((f) => f.label && rank[f.to - 1] === c && rank[f.from - 1] === c - 1).map((f) => measure(f.label!, 'ui500', 11.5) + 18);
    return c === 0 ? 0 : Math.max(36, ...labels);
  });
  const colX: number[] = [];
  let x = 0;
  for (let c = 0; c < cols; c++) {
    x += gapBefore[c]!;
    colX.push(x);
    x += colW[c]!;
  }
  const diagramW = x;
  const stackH = (c: number) => {
    const hs = text.filter((_, i) => rank[i] === c).map((t) => t.h);
    return hs.reduce((a, b) => a + b, 0) + ROW_GAP * Math.max(0, hs.length - 1);
  };
  const innerH = Math.max(...Array.from({ length: cols }, (_, c) => stackH(c)));
  const skips = flows.some((f) => rank[f.to - 1]! - rank[f.from - 1]! > 1);
  const backs = flows.some((f) => rank[f.to - 1]! <= rank[f.from - 1]!);
  const top = skips ? MARGIN : 4;
  const rects: Rect[] = [];
  const yIn = new Array<number>(cols).fill(0);
  for (let i = 0; i < n; i++) {
    const c = rank[i]!;
    const t = text[i]!;
    const y0 = top + (innerH - stackH(c)) / 2 + yIn[c]!;
    yIn[c] = yIn[c]! + t.h + ROW_GAP;
    rects.push({ x: colX[c]! + (colW[c]! - t.w) / 2, y: y0, w: t.w, h: t.h });
  }
  const height = top + innerH + (backs ? MARGIN : 4);
  const arrows = flows.map((f) => {
    const a = rects[f.from - 1]!;
    const b = rects[f.to - 1]!;
    const ra = rank[f.from - 1]!;
    const rb = rank[f.to - 1]!;
    const acy = a.y + a.h / 2;
    const bcy = b.y + b.h / 2;
    let pts: Pt[];
    if (rb === ra + 1) {
      const mx = colX[rb]! - gapBefore[rb]! / 2;
      pts = Math.abs(acy - bcy) < 1 ? [[a.x + a.w, acy], [b.x, bcy]] : [[a.x + a.w, acy], [mx, acy], [mx, bcy], [b.x, bcy]];
    } else if (rb > ra) {
      const y = 6;
      pts = [[a.x + a.w / 2, a.y], [a.x + a.w / 2, y], [b.x + b.w / 2 - 8, y], [b.x + b.w / 2 - 8, b.y]];
    } else if (rb === ra) {
      const rx = Math.max(a.x + a.w, b.x + b.w) + 14;
      pts = [[a.x + a.w, acy], [rx, acy], [rx, bcy], [b.x + b.w, bcy]];
    } else {
      const y = height - 6;
      pts = [[a.x + a.w / 2, a.y + a.h], [a.x + a.w / 2, y], [b.x + b.w / 2 + 8, y], [b.x + b.w / 2 + 8, b.y + b.h]];
    }
    return { r: finish(pts), label: f.label, wait: f.wait };
  });
  const width = diagramW + (flows.some((f) => rank[f.to - 1] === rank[f.from - 1]) ? 22 : 0);
  const placed = placeLabels(
    arrows.map((a) => ({ r: a.r, size: a.label ? labelSize(a.label, 150) : undefined })),
    rects.map((r) => ({ x: r.x - 3, y: r.y - 3, w: r.w + 6, h: r.h + 6 })),
  );
  return {
    width,
    height,
    boxes: rects.map((rect, i) => ({ rect, name: text[i]!.name, sub: text[i]!.sub })),
    arrows: arrows.map((a, i) => ({ ...a, at: placed[i] })),
  };
}

export function MiniCard({ item, markings, onAct }: PictureProps & { item: { picture: MiniPicture } }) {
  const p = item.picture;
  const m = markings ?? NO_MARKINGS;
  const ids = useSvgIds();
  const L = layoutMini(p);
  const tap = svgTapper(item.id, onAct);
  // As wide as the drawing or the title needs, and at least as wide as a text card.
  const width = Math.max(360, L.width + 34, Math.ceil(measure(p.title, 'ui600', 13)) + 60);
  const svgW = Math.max(L.width, 1);
  return (
    <article className={`kp kp-card kp-mini${wholeClass(m)}`} data-kind="mini" style={{ width }}>
      <h3 className="kp-card__head">
        <Star />
        <span>{p.title}</span>
      </h3>
      <svg className="kp-svg" width={svgW} height={L.height} viewBox={`0 0 ${svgW} ${L.height}`} role="img" aria-label={p.title}>
        <Defs ids={ids} />
        {L.arrows.map((a, i) => (
          <ArrowPath key={i} ids={ids} r={a.r} tone="ink" dashed={a.wait === true} width={1.6} />
        ))}
        {L.boxes.map((b, i) => {
          const box = p.boxes[i]!;
          const tone = TONE[box.tone ?? 'plain'];
          const sub = `box:${i + 1}`;
          const crossed = m.crossed.includes(sub);
          const circled = !crossed && m.circled.includes(sub);
          const r = b.rect;
          const block = b.name.length * NAME.lh + b.sub.length * SUB.lh + (b.sub.length ? 2 : 0);
          const ty = r.y + (r.h - block) / 2 + 12;
          return (
            <g key={sub} {...tap(sub)} opacity={crossed ? 0.42 : undefined}>
              {circled && <rect x={r.x - 4} y={r.y - 4} width={r.w + 8} height={r.h + 8} rx={10} fill="none" stroke={T.owner} strokeWidth={2} />}
              <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={7} fill={tone.fill} stroke={tone.stroke} strokeWidth={tone.width} />
              <Lines x={r.x + r.w / 2} y={ty} lines={b.name} face={NAME.face} size={NAME.size} color={tone.text} lh={NAME.lh} anchor="middle" />
              <Lines x={r.x + r.w / 2} y={ty + b.name.length * NAME.lh + 1} lines={b.sub} face={SUB.face} size={SUB.size} color={tone.sub} lh={SUB.lh} anchor="middle" />
            </g>
          );
        })}
        {L.arrows.map((a, i) => (a.at ? <LabelView key={`l${i}`} l={a.at} tone="ink" /> : null))}
      </svg>
      {p.caption && <p className="kp-text__body">{p.caption}</p>}
    </article>
  );
}
