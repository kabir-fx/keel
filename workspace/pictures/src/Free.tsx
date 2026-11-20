import type { FreePicture } from '@keel/protocol';
import { asPart } from './build';
import { measure } from './measure';
import { Gaps, wholeClass } from './parts';
import type { PictureProps } from './types';
import { NO_MARKINGS } from './types';

/**
 * The agent's own SVG, shown as an image from a data URL. An image cannot run a script, fire
 * a handler or load anything, whatever the SVG holds. Its size comes from the viewBox, so the
 * layout is known before the image loads.
 */
export function svgSize(svg: string, maxW: number): { w: number; h: number } {
  const vb = /viewBox\s*=\s*["']\s*(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(svg);
  const vw = vb ? Number(vb[3]) : 600;
  const vh = vb ? Number(vb[4]) : 400;
  if (!(vw > 0) || !(vh > 0)) return { w: Math.min(maxW, 600), h: 400 };
  const w = Math.min(maxW, Math.max(120, vw));
  return { w: Math.round(w), h: Math.round((w * vh) / vw) };
}

export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function FreeImage({ svg, title, maxW }: { svg: string; title: string; maxW: number }) {
  const { w, h } = svgSize(svg, maxW);
  return <img className="kp-free__img" {...asPart('block')} src={svgDataUrl(svg)} width={w} height={h} alt={title} draggable={false} />;
}

/** A `free` picture: a white sheet, the title, a "free drawing" tag, the image, the caption. No subs. */
export function FreeCard({ item, markings }: PictureProps & { item: { picture: FreePicture } }) {
  const p = item.picture;
  const m = markings ?? NO_MARKINGS;
  const { w } = svgSize(p.svg, 860);
  const width = Math.max(360, w + 40, Math.ceil(measure(p.title, 'head600', 19)) + 150);
  return (
    <article className={`kp kp-sheet kp-free${wholeClass(m)}`} {...asPart('frame')} data-kind="free" style={{ width }}>
      <h3 className="kp-title" {...asPart('head')}>
        <span>{p.title}</span>
        <span className="kp-tag">free drawing</span>
      </h3>
      <FreeImage svg={p.svg} title={p.title} maxW={860} />
      {p.caption && <p className="kp-caption" {...asPart('block')}>{p.caption}</p>}
      <Gaps gaps={p.gaps} />
    </article>
  );
}
