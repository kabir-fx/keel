/**
 * Trails: the line a press leaves under the pointer, drawn in the overlay. The eraser's fades
 * behind it; the lasso's stays while the loop is drawn and marches round it.
 *
 * A trail's points are kept in board units and drawn through the camera, so a trail stays on
 * the board when the camera moves in the middle of a press. Its width is kept on screen, the dot
 * at its head too, so it looks the same at any zoom. Its outline is the published
 * `@excalidraw/laser-pointer`.
 *
 * Adapted from Excalidraw (MIT licence, copyright 2020 Excalidraw), at commit 9fbeaed:
 * - `Trail` from packages/excalidraw/animatedTrail.ts (`AnimatedTrail`);
 * - `widthAt` from the `sizeMapping` of packages/excalidraw/eraser/index.ts and lasso/index.ts.
 * Changed for the board: a trail is one press's, and runs on the board's one frame loop
 * (`frame.ts`) only while some of it is still fading, so a trail at rest asks for no frame; it
 * is drawn again at once when the camera moves; and with "reduce motion" it does not fade.
 */

import { LaserPointer } from '@excalidraw/laser-pointer';
import type { CameraStore } from '../camera/camera';
import { easeOut, prefersReducedMotion } from '../camera/motion';
import type { FrameLoop } from '../frame';
import type { XY } from '../geometry';
import { outlineToPath } from '../ink/stroke';
import {
  ERASER_TRAIL_FADE_MS,
  ERASER_TRAIL_FADE_POINTS,
  ERASER_TRAIL_SIZE,
  ERASER_TRAIL_STREAMLINE,
  LASSO_TRAIL_FADE_POINTS,
  LASSO_TRAIL_SIZE,
  LASSO_TRAIL_STREAMLINE,
} from '../input/constants';

/** How one kind of trail looks and fades. */
export interface TrailLook {
  /** How far the trail reaches either side of its line at its head, in screen pixels. */
  readonly size: number;
  /** How far the trail lags the pointer to lose its wobble, from 0 to 1. */
  readonly streamline: number;
  /** A point fades to nothing in this many ms. `Infinity`: a point never fades by age. */
  readonly fadeMs: number;
  /** The trail narrows to nothing over this many points back from its head. */
  readonly fadePoints: number;
  /** Keep a dot at the head while the press lasts, when the rest has faded. */
  readonly keepHead: boolean;
  /** Draw one side of the trail, closed into a loop, to be dashed and filled: the lasso's. */
  readonly oneSide: boolean;
  /** The class of its path. Its colours and dashes are styles (`styles/trails.css`). */
  readonly className: string;
}

/** The eraser's trail: a soft smudge that fades fast behind the pointer, with a dot at the pointer. */
export const ERASER_TRAIL: TrailLook = {
  size: ERASER_TRAIL_SIZE,
  streamline: ERASER_TRAIL_STREAMLINE,
  fadeMs: ERASER_TRAIL_FADE_MS,
  fadePoints: ERASER_TRAIL_FADE_POINTS,
  keepHead: true,
  oneSide: false,
  className: 'trail trail--eraser',
};

/** The lasso's trail: the whole loop as it is drawn, with marching dashes and a faint fill. */
export const LASSO_TRAIL: TrailLook = {
  size: LASSO_TRAIL_SIZE,
  streamline: LASSO_TRAIL_STREAMLINE,
  fadeMs: Infinity,
  fadePoints: LASSO_TRAIL_FADE_POINTS,
  keepHead: false,
  oneSide: true,
  className: 'trail trail--lasso',
};

/**
 * How wide a trail is at one of its points, as a share of its full width: it narrows as the
 * point gets older (`age`, in ms) and as it lies further back from the head (`fromHead`, in
 * points), whichever narrows it more, each eased so it falls off late and fast.
 */
export function widthAt(look: TrailLook, age: number, fromHead: number): number {
  const t = Math.max(0, 1 - age / look.fadeMs);
  const l = (look.fadePoints - Math.min(look.fadePoints, fromHead)) / look.fadePoints;
  return Math.min(easeOut(l), easeOut(t));
}

const SVG = 'http://www.w3.org/2000/svg';

/**
 * Where the trails are drawn: one SVG in the overlay, the size of the board. The page puts it
 * there (`TrailsSvg.tsx`); a trail that is drawn before it comes shows in it once it does.
 */
export class TrailLayer {
  private svg: SVGSVGElement | null = null;
  private readonly drawn = new Set<SVGPathElement>();

  /** The SVG came onto the page, or left it. */
  mount = (svg: SVGSVGElement | null): void => {
    this.svg = svg;
    if (svg) for (const path of this.drawn) svg.append(path);
  };

  /** Show a trail's path. */
  show(path: SVGPathElement): void {
    this.drawn.add(path);
    if (this.svg && path.parentNode !== this.svg) this.svg.append(path);
  }

  /** Take a trail's path off. */
  hide(path: SVGPathElement): void {
    this.drawn.delete(path);
    path.remove();
  }
}

/** What a trail is drawn with: the layer, the board's frame loop, its camera, and the clock its points are timed by (ms). */
export interface TrailHost {
  readonly layer: TrailLayer;
  readonly frames: FrameLoop;
  readonly camera: CameraStore;
  readonly now?: () => number;
}

/** A board's trails: what a tool hands a new trail. */
export function trailHost(board: { readonly hand: { readonly trails: TrailLayer }; readonly frames: FrameLoop; readonly camera: CameraStore }): TrailHost {
  return { layer: board.hand.trails, frames: board.frames, camera: board.camera };
}

/**
 * One press's trail, from the point where it went down. `add` gives it the points the pointer
 * reached since, in board units; `end` lets it fade away; `clear` takes it off at once.
 *
 * It is one path in the overlay, drawn again whenever it gets points, whenever the camera moves,
 * and on every frame while some of it is still fading; then it stops asking for frames. With
 * "reduce motion" it does not fade: it shows the whole line, and goes when the press ends.
 */
export class Trail {
  private readonly look: TrailLook;
  private readonly host: TrailHost;
  private readonly laser: LaserPointer;
  private readonly path: SVGPathElement;
  private readonly now: () => number;
  /** True with "reduce motion": the line is drawn whole and never fades. */
  private readonly still: boolean;
  /** The time it is being drawn for: what the width of each point is worked out from. */
  private time = 0;
  private ended = false;
  private readonly offCamera: () => void;

  constructor(look: TrailLook, host: TrailHost, at: XY) {
    this.look = look;
    this.host = host;
    this.now = host.now ?? (() => performance.now());
    this.still = prefersReducedMotion();
    this.laser = new LaserPointer({
      size: look.size,
      streamline: look.streamline,
      keepHead: look.keepHead,
      sizeMapping: this.still ? () => 1 : (c) => widthAt(look, this.time - c.pressure, c.totalLength - c.currentIndex),
    });
    this.path = document.createElementNS(SVG, 'path');
    this.path.setAttribute('class', look.className);
    // A point keeps its time where the laser pointer keeps a pressure.
    this.laser.addPoint([at[0], at[1], this.now()]);
    // The camera says where it is at once, which draws the trail for the first time.
    this.offCamera = host.camera.onMove(() => this.draw());
  }

  /** The pointer reached these points, in board units, oldest first. */
  add(points: readonly XY[]): void {
    if (this.ended) return;
    const t = this.now();
    for (const [x, y] of points) this.laser.addPoint([x, y, t]);
    this.draw();
  }

  /** The press ended: the trail fades away from here, its head too. One that does not fade goes at once. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (!this.fades()) {
      this.clear();
      return;
    }
    this.laser.options.keepHead = false;
    this.draw();
  }

  /** Take the trail off now. */
  clear(): void {
    this.ended = true;
    this.offCamera();
    this.host.frames.cancel(this);
    this.host.layer.hide(this.path);
  }

  /** Does this trail fade by age at all? */
  private fades(): boolean {
    return !this.still && Number.isFinite(this.look.fadeMs);
  }

  /** Is some of it still fading, so the next frame draws it otherwise? Its newest point is the last to fade. */
  private fading(): boolean {
    const newest = this.laser.originalPoints.at(-1);
    return this.fades() && !!newest && this.time - newest[2] < this.look.fadeMs;
  }

  /** Draw it as the camera shows it now, and keep the loop going while it fades. */
  private draw(): void {
    this.time = this.now();
    const d = this.outline();
    if (d) {
      this.path.setAttribute('d', d);
      this.host.layer.show(this.path);
    } else if (this.ended) {
      this.clear();
      return;
    } else {
      this.host.layer.hide(this.path);
    }
    if (this.fading()) {
      this.host.frames.start(this, () => {
        this.draw();
        return this.fading();
      });
    }
  }

  /** The trail's outline on the board's screen, as one closed path. Empty when nothing of it shows. */
  private outline(): string {
    const cam = this.host.camera.get();
    // The width is kept on screen, the head's dot too, so the laser is told it in board units.
    this.laser.options.size = this.look.size / cam.z;
    const screen = this.laser.getStrokeOutline().map(([x, y]) => [x * cam.z + cam.x, y * cam.z + cam.y]);
    // The outline runs up one side of the line and back down the other: the first half is one side.
    return outlineToPath(this.look.oneSide ? screen.slice(0, screen.length / 2) : screen);
  }
}
