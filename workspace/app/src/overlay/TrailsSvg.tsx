import type { TrailLayer } from './trails';

/** The overlay's layer of trails: one SVG the size of the board, which each trail draws its path into. */
export function TrailsSvg({ layer }: { layer: TrailLayer }) {
  return <svg className="trails" data-testid="trails" ref={layer.mount} />;
}
