import { memo, useSyncExternalStore } from 'react';
import type { Pt } from './geometry';
import { lineBox } from './geometry';
import { InkMark } from './ink/ink';
import { keep, PEN } from './ink/stroke';
import { ArrowPaths } from './items';
import { Highlight } from './overlay/highlight';
import { TrailLayer } from './overlay/trails';

/**
 * What the owner's hand is drawing right now, before it is a mark: the strokes of the pen's
 * current go, a box or an arrow being dragged. It lives outside React's board state, so a stroke
 * redraws only this layer, not the board. A lasso being drawn is a trail (`trails`).
 */
export type Shape =
  | { kind: 'box'; from: readonly [number, number]; to: readonly [number, number] }
  /** An arrow, by where its two ends are drawn: on what they tie to, as the arrow will be once saved. */
  | { kind: 'arrow'; from: readonly [number, number]; to: readonly [number, number] };

export interface LiveState {
  /**
   * The strokes of the pen's current go, in board units, each as the log would keep it. The
   * stroke being drawn is added to in place: `grew` says when, and a new list here says only
   * that a stroke began, ended or went.
   */
  strokes: readonly (readonly Pt[])[];
  /** The pen's width in world units. */
  width: number;
  shape?: Shape;
}

export class LiveStore {
  /**
   * The trails the hand leaves (the eraser's, the lasso's), drawn in the overlay over the board.
   * They are drawn straight to the page, frame by frame: nothing here renders for them.
   */
  readonly trails = new TrailLayer();
  /**
   * The thing an arrow's end would tie to while the owner draws an arrow or drags one of its
   * ends, outlined in the overlay. Like the trails, it is written straight to the page.
   */
  readonly highlight = new Highlight();
  private s: LiveState = { strokes: [], width: PEN.size };
  private readonly listeners = new Set<() => void>();
  /** How many times each stroke has grown. A stroke that is finished never counts up again. */
  private readonly grown = new WeakMap<readonly Pt[], number>();
  private readonly watchers = new Set<() => void>();

  get = (): LiveState => this.s;

  set = (patch: Partial<LiveState>): void => {
    this.s = { ...this.s, ...patch };
    for (const l of this.listeners) l();
  };

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  /**
   * A stroke got more points, in its own list. Only that stroke is drawn again: the layer and
   * the finished strokes of the go do not hear of it. The pen calls this once for each time it
   * is handed samples, which is at most once a frame.
   */
  grew = (stroke: readonly Pt[]): void => {
    this.grown.set(stroke, this.growth(stroke) + 1);
    for (const l of this.watchers) l();
  };

  /** How many times a stroke has grown: what its drawing watches. */
  growth = (stroke: readonly Pt[]): number => this.grown.get(stroke) ?? 0;

  /** Hear of every stroke that grows. */
  watch = (l: () => void): (() => void) => {
    this.watchers.add(l);
    return () => this.watchers.delete(l);
  };
}

/**
 * One stroke of the pen's go, drawn as the mark it would be if it were saved alone now: the
 * same points counted from the same box, through the same `InkMark`. So the line under the
 * pointer is the line that stays. It is drawn again when it grows, and only then; a press that
 * is still a click has one point and draws nothing.
 */
const LiveStroke = memo(function LiveStroke({ store, points, width }: { store: LiveStore; points: readonly Pt[]; width: number }) {
  // The list is added to in place, so its growth is what says "draw again".
  useSyncExternalStore(store.watch, () => store.growth(points));
  if (points.length < 2) return null;
  const { box, strokes } = keep([points], width);
  return <InkMark strokes={strokes} box={box} shown={box} />;
});

/** The live layer, in world units, over the items. Nothing here goes into a snapshot. */
export const Live = memo(function Live({ store }: { store: LiveStore }) {
  const live = useSyncExternalStore(store.subscribe, store.get);
  return (
    <div className="live" data-no-export data-testid="live">
      {live.strokes.map((s, i) => (
        <LiveStroke key={i} store={store} points={s} width={live.width} />
      ))}
      {live.shape && <LiveShape shape={live.shape} />}
    </div>
  );
});

function LiveShape({ shape }: { shape: Shape }) {
  if (shape.kind === 'box') {
    const x = Math.min(shape.from[0], shape.to[0]);
    const y = Math.min(shape.from[1], shape.to[1]);
    const w = Math.abs(shape.to[0] - shape.from[0]);
    const h = Math.abs(shape.to[1] - shape.from[1]);
    return <div className="live-box" style={{ left: x, top: y, width: w, height: h }} />;
  }
  // The box and the paths the arrow will have once it is saved (`ArrowMark`), so it does not move when it is.
  const [x, y, w, h] = lineBox([shape.from, shape.to]);
  return (
    <svg className="line-mark live-line" style={{ left: x, top: y, width: w, height: h }} viewBox={`${x} ${y} ${w} ${h}`} aria-hidden="true">
      <ArrowPaths from={shape.from} to={shape.to} />
    </svg>
  );
}
