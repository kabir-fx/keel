import type { Box } from '@keel/protocol';
import { FrameLoop } from '../frame';
import { GLIDE_MS } from '../input/constants';
import { between, easeOut, prefersReducedMotion } from './motion';

/** The one world transform: screen = world * z + (x, y), relative to the board's top-left corner. */
export interface Camera {
  x: number;
  y: number;
  z: number;
}

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 4;

/**
 * A zoom the board can take: rounded to 6 decimals, so steps that should meet do (100% after
 * a step in and a step out is 1, not 0.9999999), and kept between 20% and 400%.
 */
export function clampZoom(z: number): number {
  const rounded = Math.round((z + Number.EPSILON) * 1e6) / 1e6;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, rounded));
}

export function screenToWorld(cam: Camera, sx: number, sy: number): [number, number] {
  return [(sx - cam.x) / cam.z, (sy - cam.y) / cam.z];
}

export function worldToScreen(cam: Camera, wx: number, wy: number): [number, number] {
  return [wx * cam.z + cam.x, wy * cam.z + cam.y];
}

/** What a board of this size shows through the camera, in world units. */
export function viewOf(cam: Camera, size: { w: number; h: number }): Box {
  return [-cam.x / cam.z, -cam.y / cam.z, size.w / cam.z, size.h / cam.z];
}

export const sameCamera = (a: Camera, b: Camera): boolean => a.x === b.x && a.y === b.y && a.z === b.z;

/**
 * The camera at zoom `z` (as the board can take it) with the screen point (sx, sy) fixed: the
 * world point under it stays under it. At a limit it answers with `cam` itself.
 */
export function zoomTo(cam: Camera, sx: number, sy: number, z: number): Camera {
  const next = clampZoom(z);
  if (next === cam.z) return cam;
  const k = next / cam.z;
  return { z: next, x: sx - (sx - cam.x) * k, y: sy - (sy - cam.y) * k };
}

/** Zoom by `factor` about a screen point, keeping that point fixed. */
export function zoomAt(cam: Camera, sx: number, sy: number, factor: number): Camera {
  return zoomTo(cam, sx, sy, cam.z * factor);
}

/**
 * The camera that shows `box` inside the screen rectangle `room`, at most at `maxZoom`. The zoom
 * is rounded down, never up, so the box never reaches past the room by a hair.
 */
export function fitBox(box: Box, room: Box, maxZoom = 1): Camera {
  const [bx, by, bw, bh] = box;
  const [rx, ry, rw, rh] = room;
  const fits = Math.min(maxZoom, rw / Math.max(bw, 1), rh / Math.max(bh, 1));
  const rounded = clampZoom(fits);
  const z = rounded > fits ? clampZoom(rounded - 1e-6) : rounded;
  return { z, x: rx + (rw - bw * z) / 2 - bx * z, y: ry + (rh - bh * z) / 2 - by * z };
}

/** The box around several boxes. */
export function unionBox(boxes: readonly Box[]): Box | undefined {
  if (boxes.length === 0) return undefined;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y, w, h] of boxes) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + w);
    y1 = Math.max(y1, y + h);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

/**
 * How the owner's hand holds the camera, for the cursor: not at all, a pan pressed and not yet
 * moved (an open hand), or a pan under way (a closed hand).
 */
export type Grip = 'none' | 'armed' | 'moving';

type Listener = (cam: Camera) => void;

/** A glide under way: where it began, where it goes, how long it takes, and how long it has run, in ms. */
interface Glide {
  from: Camera;
  to: Camera;
  ms: number;
  elapsed: number;
}

/** What a camera is made with. Tests hand in their own frames and their own answer to "reduce motion". */
export interface CameraOptions {
  /** The board's one frame loop: a glide is a step in it. */
  loop?: FrameLoop;
  /** True when the page asks for reduced motion: a glide is then a jump. Asked at each glide. */
  reduced?: () => boolean;
}

/**
 * Holds the camera outside React. Pan and zoom move the world through `onMove` listeners that
 * write the transform straight to the DOM, so a drag never re-renders the board. Listeners
 * that do render (the zoom label, the chapter in view) hear at most once a frame.
 *
 * The camera moves two ways. `set` is the owner's hand (a wheel, a pan, a pinch): it moves at
 * once, and stops a glide where it is. `glide` is the board showing the owner something (a fit,
 * the focus view, what is new): it goes there over a few frames, so the owner sees where they
 * went, and with "reduce motion" it jumps.
 */
export class CameraStore {
  private cam: Camera;
  private readonly now = new Set<Listener>();
  private readonly framed = new Set<() => void>();
  private frame = 0;
  private readonly loop: FrameLoop;
  private readonly reduced: () => boolean;
  private glideNow: Glide | null = null;
  private gripNow: Grip = 'none';
  private readonly grips = new Set<(grip: Grip) => void>();

  constructor(cam: Camera, options: CameraOptions = {}) {
    this.cam = cam;
    this.loop = options.loop ?? new FrameLoop();
    this.reduced = options.reduced ?? prefersReducedMotion;
  }

  get = (): Camera => this.cam;

  /** Where the camera is going: the end of the glide under way, else where it is. A step that adds to a move (a zoom key pressed twice) starts from here. */
  goal = (): Camera => this.glideNow?.to ?? this.cam;

  /** True while the camera glides. */
  gliding = (): boolean => this.glideNow !== null;

  /** Move the camera now, as the owner's hand does. A glide under way stops where it is. */
  set = (cam: Camera): void => {
    this.stop();
    this.apply(cam);
  };

  /**
   * Glide to `to` over `ms`: the zoom changes by the same ratio each moment, and every world
   * point travels a straight line on the screen, slowing as it arrives. It lands exactly on
   * `to`. With "reduce motion" it is a jump, and takes no frames.
   */
  glide = (to: Camera, ms: number = GLIDE_MS): void => {
    this.stop();
    if (sameCamera(to, this.cam)) return;
    if (ms <= 0 || this.reduced()) {
      this.apply(to);
      return;
    }
    const g: Glide = { from: this.cam, to, ms, elapsed: 0 };
    this.glideNow = g;
    this.loop.start(this, (dt) => {
      if (this.glideNow !== g) return false;
      g.elapsed += dt;
      const t = g.elapsed / g.ms;
      if (t >= 1) {
        // The glide is over and its step is out of the loop before the landing is told. A
        // listener may start the next glide from it, and the loop takes no new step under a
        // key that is still running.
        this.stop();
        this.apply(g.to);
        return false;
      }
      this.apply(between(g.from, g.to, easeOut(t)));
      return true;
    });
  };

  /** End a glide under way at once, at its end. For a view that must arrive before the owner sees it. */
  land = (): void => {
    const g = this.glideNow;
    if (!g) return;
    this.stop();
    this.apply(g.to);
  };

  /** Stop a glide where it is. */
  stop = (): void => {
    if (!this.glideNow) return;
    this.glideNow = null;
    this.loop.cancel(this);
  };

  /** Called on every change, at once. For writing styles, not for React state. */
  onMove = (l: Listener): (() => void) => {
    this.now.add(l);
    l(this.cam);
    return () => this.now.delete(l);
  };

  /** Called at most once a frame. For `useSyncExternalStore`. */
  subscribe = (l: () => void): (() => void) => {
    this.framed.add(l);
    return () => this.framed.delete(l);
  };

  /** How the owner's hand holds the camera now. */
  grip = (): Grip => this.gripNow;

  /** A pan was pressed, got under way, or ended. */
  hold = (grip: Grip): void => {
    if (grip === this.gripNow) return;
    this.gripNow = grip;
    for (const l of this.grips) l(grip);
  };

  /** Called at once with the grip, and on every change of it. For the cursor. */
  onGrip = (l: (grip: Grip) => void): (() => void) => {
    this.grips.add(l);
    l(this.gripNow);
    return () => this.grips.delete(l);
  };

  private apply(cam: Camera): void {
    if (sameCamera(cam, this.cam)) return;
    this.cam = cam;
    for (const l of this.now) l(cam);
    if (this.framed.size === 0 || this.frame) return;
    const flush = () => {
      this.frame = 0;
      for (const l of this.framed) l();
    };
    if (typeof requestAnimationFrame === 'function') this.frame = requestAnimationFrame(flush);
    else flush();
  }
}
