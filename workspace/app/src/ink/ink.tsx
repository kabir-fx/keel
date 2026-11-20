// Ink on the page: one SVG a mark, one filled path a stroke. perfect-freehand turns a stroke's
// points into its outline in `stroke.ts`; this file is only the part React draws.
// Carried from spike S2, reading the contract's strokes (flat x,y pairs in board units).

import type { Box, Stroke } from '@keel/protocol';
import { memo, useMemo } from 'react';
import { padBox, wholeBoxAround } from '../geometry';
import { inkPath, inkWidth, PEN } from './stroke';

export { inkWidth, PEN, samples } from './stroke';

const OWNER_INK = '#C2410C';

/**
 * Where the SVG's box begins, counted from the mark's corner, as the `viewBox` writes it: to a
 * ten-thousandth, far under a pixel at any zoom, so a sum like 0.1 + 0.2 is written 0.3.
 */
const fromCorner = (n: number) => Math.round(n * 1e4) / 1e4;

/**
 * Ink: every stroke of one mark, in one SVG. Saved ink is drawn by this, and so is every stroke
 * the pen is still drawing (the live layer hands it the mark the stroke would be), so the two
 * can never look different.
 *
 * Its points are counted from the top-left corner of `box`, where the mark was drawn; `shown`
 * is where it is drawn now (after its anchor moved or scaled). The points are moved and
 * scaled, not the drawing, so a circle stretched round a wide lane keeps an even line. The
 * fill is an attribute, not CSS: html-to-image loses a CSS-variable fill on SVG paths (seen in
 * the spike).
 */
export const InkMark = memo(function InkMark({ strokes, box, shown }: { strokes: readonly Stroke[]; box: Box; shown: Box }) {
  const sx = box[2] > 0 && shown[2] > 0 ? shown[2] / box[2] : 1;
  const sy = box[3] > 0 && shown[3] > 0 ? shown[3] / box[3] : 1;
  const paths = useMemo(() => strokes.map((s) => inkPath(s.pts, s.w ?? PEN.size, sx, sy)), [strokes, sx, sy]);
  const pad = inkWidth(Math.max(PEN.size, ...strokes.map((s) => s.w ?? PEN.size)), sx, sy) * 2;
  // Chrome snaps what an SVG draws to whole units of the SVG's own box before the board's zoom
  // scales it, so a box off the whole unit nudges the ink by up to half a unit, and by another
  // amount for each box. On whole units, a stroke drawn live in a box of its own and saved in its
  // mark's box lands on the same pixels.
  const [left, top, width, height] = wholeBoxAround(padBox([shown[0], shown[1], box[2] * sx, box[3] * sy], pad));
  return (
    <svg className="ink" style={{ left, top, width, height }} viewBox={`${fromCorner(left - shown[0])} ${fromCorner(top - shown[1])} ${width} ${height}`} aria-hidden="true">
      {paths.map((d, i) => (
        <path key={i} d={d} fill={OWNER_INK} />
      ))}
    </svg>
  );
});
