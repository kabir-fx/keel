import type { Camera, CameraStore } from '../camera/camera';
import { screenToWorld, worldToScreen } from '../camera/camera';
import { prefersReducedMotion } from '../camera/motion';
import type { FrameLoop } from '../frame';
import { EASE } from '../motion/ease';
import type { Path, Point } from '../motion/path';
import { arc, at, distance } from '../motion/path';
import { CURSOR_ENTER_MS, travelMs } from '../motion/timing';
import { entryPoint } from './cursorPlace';

/** What the cursor's element hands the store while it is on the page: the board's size, and how to draw the cursor where the store says it is. */
export interface CursorView {
  size(): { w: number; h: number };
  draw(): void;
}

/** What React needs to know of the cursor: whether it is on the board yet, and whether something leads it. Both change seldom. */
export interface CursorShown {
  readonly placed: boolean;
  readonly led: boolean;
}

/** What a cursor store is made with. Tests hand in their own answer to "reduce motion". */
export interface CursorOptions {
  /** True when the page asks for reduced motion: a trip is then a jump. Asked at each trip. */
  reduced?: () => boolean;
}

/** A trip under way: its path, how long it takes and how long it has run, in ms. */
interface Trip {
  /** Null for the first trip on a board until its first frame: where it comes in from is worked out then, through the camera of that frame. */
  path: Path | null;
  to: Point;
  ms: number;
  elapsed: number;
}

const same = (a: Point, b: Point): boolean => a[0] === b[0] && a[1] === b[1];

/**
 * Where the agent's cursor is on the board, outside React: one per board, like the camera.
 *
 * It is where something leads it, else at the place presence names, else where it last was. It
 * is first on the board the first time something leads it or presence names a place, and then
 * comes in from the nearest edge of the view, from the next frame. Between two places it travels on a gentle curve, eased in
 * and out, over a time that grows with the distance on the screen; a new place mid-trip sets off
 * from where it is, so it never jumps. With reduced motion it jumps.
 *
 * It moves on the board's frame loop only while it travels or is led, and draws through the view
 * its element hands it, straight to the page: React hears only `CursorShown`.
 *
 * Another part of the board leads it (the arrival drawing a picture's arrow):
 *
 *     cursor.lead(() => at(route, EASE.draw(elapsed / ms)));  // drawn at that point every frame
 *     cursor.lead(null);  // let go: it stays where it was left
 *
 * A lead should start from `cursor.at()`, where the cursor is now, so it does not jump there; a
 * cursor not on the board yet comes in from `entryFor` its first point. Let go, it stays where
 * the lead left it, and travels on only when presence names a new place: one named while it was
 * led, or later. The place presence named before the lead is where the lead began, and the
 * cursor does not walk back to it.
 */
export class AgentCursorStore {
  private drawn: Point | undefined;
  /** The place presence names now, if it names one. */
  private named: Point | undefined;
  /** True when presence named its place while the cursor was led: let go, it travels there. */
  private namedWhileLed = false;
  private leader: (() => Point) | null = null;
  private trip: Trip | null = null;
  private view: CursorView | null = null;
  private shownNow: CursorShown = { placed: false, led: false };
  private readonly listeners = new Set<() => void>();
  private readonly frames: FrameLoop;
  private readonly camera: CameraStore;
  private readonly reduced: () => boolean;

  constructor(frames: FrameLoop, camera: CameraStore, options: CursorOptions = {}) {
    this.frames = frames;
    this.camera = camera;
    this.reduced = options.reduced ?? prefersReducedMotion;
  }

  /** Where the cursor is drawn now, in board units; undefined before it was first on the board. */
  at = (): Point | undefined => this.drawn;

  /** Whether it is on the board yet, and whether something leads it. The same object until one of them changes. */
  shown = (): CursorShown => this.shownNow;

  /** True while it travels to a place. */
  travelling = (): boolean => this.trip !== null;

  /** Called when `shown` changes. For `useSyncExternalStore`. */
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  /**
   * Lead the cursor: it is drawn at `to()` at once and on every frame after, until it is led
   * elsewhere or let go with `null`. Let go, it stays where it was left, and travels on only to
   * a place presence named while it was led.
   */
  lead = (to: (() => Point) | null): void => {
    if (to) {
      this.stopTrip();
      if (!this.leader) this.namedWhileLed = false;
      this.leader = to;
      this.drawn = to();
      this.draw();
      this.frames.cancel(this);
      this.frames.start(this, () => {
        if (this.leader !== to) return false;
        this.drawn = to();
        this.draw();
        return true;
      });
    } else if (this.leader) {
      this.leader = null;
      this.frames.cancel(this);
      if (this.named && this.namedWhileLed) this.goToward(this.named);
      this.namedWhileLed = false;
    }
    this.tell();
  };

  /**
   * The place presence names now, in board units, or undefined when it names none. Naming none
   * starts no trip and stops none: a trip under way ends where it was going, and the cursor
   * stays there. A place it is at, or already on its way to, starts no new trip.
   */
  goTo = (place: Point | undefined): void => {
    if (!place) {
      this.named = undefined;
      return;
    }
    if (this.named && same(this.named, place)) return;
    this.named = place;
    if (this.leader) {
      this.namedWhileLed = true;
      return;
    }
    this.goToward(place);
    this.tell();
  };

  /** The cursor's element is on the page: draw through it. Returns how to take it off again. */
  attach = (view: CursorView): (() => void) => {
    this.view = view;
    this.draw();
    return () => {
      if (this.view === view) this.view = null;
    };
  };

  /** Set off for `to` from where the cursor is: in from the edge the first time, on a curve after. */
  private goToward(to: Point): void {
    const from = this.drawn;
    if (this.trip ? same(this.trip.to, to) : from && same(from, to)) return;
    this.stopTrip();
    if (!this.view || this.reduced()) return this.jump(to);
    // The first time, it is not on the board until the next frame, when the board's first view
    // has settled: it comes in from the edge of the view the owner sees.
    if (!from) return this.travel(null, to, CURSOR_ENTER_MS);
    this.travel(arc(from, to), to, travelMs(distance(from, to) * this.camera.get().z));
  }

  /**
   * Where a cursor not on the board yet comes in from on its way to `to`: the nearest edge of the
   * view through `cam` (the camera now, by default), in board units. None when `to` is out of
   * that view, or when the cursor's element is not on the page.
   */
  entryFor = (to: Point, cam: Camera = this.camera.get()): Point | undefined => {
    if (!this.view) return undefined;
    const edge = entryPoint(worldToScreen(cam, to[0], to[1]), this.view.size());
    return edge ? screenToWorld(cam, edge[0], edge[1]) : undefined;
  };

  private jump(to: Point): void {
    this.drawn = to;
    this.draw();
  }

  /** Travel along `path` to `to` over `ms`; a null path comes in from the edge, from the next frame. */
  private travel(path: Path | null, to: Point, ms: number): void {
    const trip: Trip = { path, to, ms, elapsed: 0 };
    this.trip = trip;
    this.frames.start(this, (dt) => {
      if (this.trip !== trip) return false;
      if (!trip.path) {
        // Its first frame on the board: drawn at the edge, and on its way from the next one.
        const from = this.entryFor(to);
        trip.path = from ? arc(from, to) : null;
        this.drawn = from ?? to;
        this.draw();
        this.tell();
        if (from) return true;
        this.trip = null;
        return false;
      }
      trip.elapsed += dt;
      const t = trip.elapsed / trip.ms;
      this.drawn = at(trip.path, EASE.move(t));
      this.draw();
      if (t < 1) return true;
      this.trip = null;
      return false;
    });
  }

  private stopTrip(): void {
    if (!this.trip) return;
    this.trip = null;
    this.frames.cancel(this);
  }

  private draw(): void {
    this.view?.draw();
  }

  private tell(): void {
    const placed = this.drawn !== undefined;
    const led = this.leader !== null;
    if (placed === this.shownNow.placed && led === this.shownNow.led) return;
    this.shownNow = { placed, led };
    for (const l of this.listeners) l();
  }
}
