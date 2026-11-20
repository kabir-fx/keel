import type { Camera } from '../camera/camera';
import type { Guide } from '../select/snap';

/** How long the ticks at the ends and in the middle of an equal gap are, in screen pixels. Excalidraw's (renderer/renderSnaps.ts). */
const TICK = 8;

const r = (n: number) => Math.round(n) + 0.5;

/**
 * The guides a gesture snapped to, as one SVG path in screen pixels: a line through what lines
 * up, and for an equal gap a line across it with a tick at each end and two in its middle. Each
 * is put on the middle of a pixel, so a line one pixel wide is crisp.
 */
export function guidePath(guides: readonly Guide[], cam: Camera): string {
  const sx = (x: number) => x * cam.z + cam.x;
  const sy = (y: number) => y * cam.z + cam.y;
  /** A segment along an axis at `at` across it: from `from` to `to`, in world units. */
  const seg = (axis: 'x' | 'y', at: number, from: number, to: number) =>
    axis === 'x' ? `M${r(sx(at))} ${r(sy(from))}V${r(sy(to))}` : `M${r(sx(from))} ${r(sy(at))}H${r(sx(to))}`;
  const tick = (axis: 'x' | 'y', along: number, at: number) => {
    const half = TICK / 2;
    return axis === 'x' ? `M${r(sx(along))} ${r(sy(at) - half)}v${TICK}` : `M${r(sx(at) - half)} ${r(sy(along))}h${TICK}`;
  };
  return guides
    .map((g) => {
      if (g.kind === 'line') return seg(g.axis, g.at, g.from, g.to);
      // An equal gap lies along its axis: a line across it, ticks at its ends, two in its middle.
      const mid = (g.from + g.to) / 2;
      const gapLine = g.axis === 'x' ? seg('y', g.at, g.from, g.to) : seg('x', g.at, g.from, g.to);
      const midTicks = [-1.5, 1.5].map((d) => tick(g.axis, mid + d / cam.z, g.at)).join('');
      return `${gapLine}${tick(g.axis, g.from, g.at)}${tick(g.axis, g.to, g.at)}${midTicks}`;
    })
    .join('');
}

/** The guides' one path, drawn in the overlay in keel's blue. It is written by the selection's layer, frame by frame, with no render. */
export function Guides({ path }: { path: (el: SVGPathElement | null) => void }) {
  return (
    <svg className="snap-guides" data-testid="snap-guides">
      <path ref={path} />
    </svg>
  );
}
