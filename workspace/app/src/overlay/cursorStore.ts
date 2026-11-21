import type { Camera, CameraStore } from '../camera/camera';
import { screenToWorld, worldToScreen } from '../camera/camera';
import { prefersReducedMotion } from '../camera/motion';
import type { FrameLoop } from '../frame';
import { EASE } from '../motion/ease';
import type { Path, Point } from '../motion/path';
import { arc, at, distance } from '../motion/path';
import { CURSOR_ENTER_MS, DROP_SINK_SHARE, travelMs } from '../motion/timing';
import { entryPoint } from './cursorPlace';

/** What the cursor's element hands the store while it is on the page: the board's size, and how to draw the cursors where the store says they are. */
export interface CursorView {
  size(): { w: number; h: number };
  draw(): void;
}

/** What React needs to know of the cursors: whether the agent's own is on the board yet, whether something leads it, and how many cursors are drawn (1 when not split). All change seldom. */
export interface CursorShown {
  readonly placed: boolean;
  readonly led: boolean;
  readonly count: number;
}

/** A cursor something can lead: the agent's own, or one split off it. */
export interface Lead {
  at(): Point | undefined;
  lead(to: (() => Point) | null): void;
}

/** One cursor drawn now: where it is, and how much of it is left (1, or less while it merges away). */
export interface Drawn {
  readonly id: number;
  readonly at: Point;
  readonly share: number;
}

/** What a cursor store is made with. Tests hand in their own answer to "reduce motion". */
export interface CursorOptions {
  /** True when the page asks for reduced motion: a trip is then a jump. Asked at each trip. */
  reduced?: () => boolean;
  /** True when nobody is looking at the page: a trip is then a jump too. Asked at each trip. */
  hidden?: () => boolean;
}

/** A trip under way: its path, how long it takes and how long it has run, in ms. */
interface Trip {
  /** Null for the first trip on a board until its first frame: where it comes in from is worked out then, through the camera of that frame. */
  path: Path | null;
  to: Point;
  ms: number;
  elapsed: number;
}

/** A cursor split off the agent's own. */
interface Hand {
  readonly id: number;
  drawn: Point | undefined;
  leader: (() => Point) | null;
  /** Its flight into the drop, once `merge` was called: it is gone when it lands. */
  trip: Trip | null;
  share: number;
}

const same = (a: Point, b: Point): boolean => a[0] === b[0] && a[1] === b[1];

/**
 * Where the agent's cursor is on the board, outside React: one per board, like the camera.
 *
 * It is where something leads it, else at the place presence names, else where it last was. It
 * is first on the board the first time something leads it or presence names a place, and then
 * comes in from the nearest edge of the view, from the next frame. Between two places it travels
 * on a gentle curve, eased in and out, over a time that grows with the distance on the screen; a
 * new place mid-trip sets off from where it is, so it never jumps. With reduced motion, or on a
 * page nobody is looking at, every trip and merge is a jump.
 *
 * It moves on the board's frame loop only while a cursor travels, is led or merges, and draws
 * through the view its element hands it, straight to the page: React hears only `CursorShown`.
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
 * cursor does not walk back to it. `travelTo` sends it somewhere itself: it ends a lead, and
 * forgets a place named during one.
 *
 * Several pictures are drawn at once by cursors split off the agent's own (`split`), each led as
 * the agent's own is, and brought back into it with `merge`:
 *
 * - Split before the agent's own was ever on the board, the split cursors have no place either:
 *   they are not drawn, and a lead puts each where it says, as it does the agent's own.
 * - Split again, there are more: each new one starts where the agent's own is then.
 * - A split cursor let go stays where it was left until the merge.
 * - Merge: every cursor's lead ends and each flies from where it is to the point, all in the time
 *   the longest of their trips takes, so they land together. Over the last part of the flight a
 *   split cursor goes into the drop (its share falls to 0) and it is gone as it lands; a lead on
 *   it after the merge began does nothing. One that never had a place is simply gone. Not split,
 *   merge is `travelTo`. With reduced motion every cursor jumps and the split ones are gone at once.
 * - While split or merging, a place presence names does not move the agent's own, nor does a lead
 *   of its own letting go: it would walk away from the merge. Once the merge is over it travels
 *   to that place, as it does when a single film lets it go.
 * - A lead on the agent's own, or `travelTo`, during a merge takes it out of the merge: it goes
 *   where it is sent, and the split cursors still fly to the point and are gone there.
 */
export class AgentCursorStore implements Lead {
  private drawn: Point | undefined;
  /** The place presence names now, if it names one. */
  private named: Point | undefined;
  /** True when presence named its place while the cursor was led: let go, it travels there. */
  private namedWhileLed = false;
  /** True when presence named its place while the cursors were split: the merge over, it travels there. */
  private namedWhileSplit = false;
  private leader: (() => Point) | null = null;
  private trip: Trip | null = null;
  private hands: Hand[] = [];
  private nextId = 1;
  /** Every cursor drawn now, made again only when one moves: a camera move reads it as it is. */
  private all: readonly Drawn[] = [];
  private view: CursorView | null = null;
  private shownNow: CursorShown = { placed: false, led: false, count: 1 };
  private readonly listeners = new Set<() => void>();
  private readonly frames: FrameLoop;
  private readonly camera: CameraStore;
  private readonly reduced: () => boolean;
  private readonly hidden: () => boolean;

  constructor(frames: FrameLoop, camera: CameraStore, options: CursorOptions = {}) {
    this.frames = frames;
    this.camera = camera;
    this.reduced = options.reduced ?? prefersReducedMotion;
    this.hidden = options.hidden ?? (() => typeof document !== 'undefined' && document.hidden);
  }

  /** Where the agent's own cursor is drawn now, in board units; undefined before it was first on the board. */
  at = (): Point | undefined => this.drawn;

  /** Whether it is on the board yet, whether something leads it, and how many cursors are drawn. The same object until one of them changes. */
  shown = (): CursorShown => this.shownNow;

  /** Every cursor drawn now, the agent's own first. For the view. */
  drawnAll = (): readonly Drawn[] => this.all;

  /** True while the agent's own travels to a place. */
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
      this.trip = null;
      if (!this.leader) this.namedWhileLed = false;
      this.leader = to;
      this.drawn = to();
      this.draw();
      this.run();
    } else if (this.leader) {
      this.leader = null;
      if (this.named && this.namedWhileLed) {
        if (this.hands.length > 0) this.namedWhileSplit = true;
        else this.goToward(this.named);
      }
      this.namedWhileLed = false;
      this.rest();
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
    if (this.hands.length > 0) {
      this.namedWhileSplit = true;
      return;
    }
    this.goToward(place);
    this.tell();
  };

  /** Travel to a board point on the usual curve. Nothing leads it, and presence does not call it back. */
  travelTo = (place: Point): void => {
    this.leader = null;
    this.namedWhileLed = false;
    this.namedWhileSplit = false;
    this.goToward(place);
    this.rest();
    this.tell();
  };

  /** Split `n` more cursors off the agent's own, where it is now. Each is led like the agent's own, and is drawn until `merge`. */
  split = (n: number): Lead[] => {
    const leads: Lead[] = [];
    for (let i = 0; i < n; i++) {
      const hand: Hand = { id: this.nextId++, drawn: this.drawn, leader: null, trip: null, share: 1 };
      this.hands.push(hand);
      leads.push({ at: () => (this.hands.includes(hand) ? hand.drawn : undefined), lead: (to) => this.leadHand(hand, to) });
    }
    if (n > 0) {
      this.draw();
      this.tell();
    }
    return leads;
  };

  /** Bring every cursor together at `at`: each flies there on the usual curve, the split ones are gone on arrival, and the agent's own is there. */
  merge = (to: Point): void => {
    if (this.hands.length === 0) return this.travelTo(to);
    if (this.leader && this.namedWhileLed) this.namedWhileSplit = true;
    this.leader = null;
    this.namedWhileLed = false;
    this.hands = this.hands.filter((h) => h.drawn);
    if (this.still()) {
      this.hands = [];
      this.trip = null;
      this.jump(to);
      this.merged();
      this.rest();
      this.tell();
      return;
    }
    const z = this.camera.get().z;
    const froms = [...this.hands.map((h) => h.drawn!), ...(this.drawn ? [this.drawn] : [])];
    const ms = Math.max(...froms.map((p) => travelMs(distance(p, to) * z)));
    for (const h of this.hands) {
      h.leader = null;
      h.trip = { path: arc(h.drawn!, to), to, ms, elapsed: 0 };
    }
    if (this.drawn) this.trip = same(this.drawn, to) ? null : { path: arc(this.drawn, to), to, ms, elapsed: 0 };
    else this.jump(to);
    if (this.hands.length === 0) this.merged();
    this.run();
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

  private leadHand(hand: Hand, to: (() => Point) | null): void {
    if (!this.hands.includes(hand) || hand.trip) return;
    if (to) {
      hand.leader = to;
      hand.drawn = to();
      this.draw();
      this.run();
    } else if (hand.leader) {
      hand.leader = null;
      this.rest();
    }
    this.tell();
  }

  /** Set off for `to` from where the cursor is: in from the edge the first time, on a curve after. */
  private goToward(to: Point): void {
    const from = this.drawn;
    if (this.trip ? same(this.trip.to, to) : from && same(from, to)) return;
    this.trip = null;
    if (this.still()) return this.jump(to);
    // The first time, it is not on the board until the next frame, when the board's first view
    // has settled: it comes in from the edge of the view the owner sees.
    this.trip = from ? { path: arc(from, to), to, ms: travelMs(distance(from, to) * this.camera.get().z), elapsed: 0 } : { path: null, to, ms: CURSOR_ENTER_MS, elapsed: 0 };
    this.run();
  }

  /** True when nothing may play: a trip is a jump. */
  private still(): boolean {
    return !this.view || this.reduced() || this.hidden();
  }

  /** The merge is over: on to a place presence named while the cursors were split. */
  private merged(): void {
    if (!this.namedWhileSplit) return;
    this.namedWhileSplit = false;
    if (!this.named) return;
    if (this.leader) this.namedWhileLed = true;
    else this.goToward(this.named);
  }

  private jump(to: Point): void {
    this.drawn = to;
    this.draw();
  }

  private moving(): boolean {
    return this.leader !== null || this.trip !== null || this.hands.some((h) => h.leader || h.trip);
  }

  /** Move on the frame loop from the next frame, if it does not already. */
  private run(): void {
    this.frames.start(this, this.step);
  }

  /** Ask for no more frames once nothing moves. */
  private rest(): void {
    if (!this.moving()) this.frames.cancel(this);
  }

  private step = (dt: number): boolean => {
    if (this.leader) this.drawn = this.leader();
    else if (this.trip) this.stepOwn(this.trip, dt);
    for (const h of this.hands) {
      if (h.leader) h.drawn = h.leader();
      else if (h.trip) {
        h.trip.elapsed += dt;
        const t = h.trip.elapsed / h.trip.ms;
        h.drawn = at(h.trip.path!, EASE.move(t));
        h.share = Math.min(1, (1 - t) / DROP_SINK_SHARE);
      }
    }
    const split = this.hands.length > 0;
    this.hands = this.hands.filter((h) => h.share > 0);
    if (split && this.hands.length === 0) this.merged();
    this.draw();
    this.tell();
    return this.moving();
  };

  private stepOwn(trip: Trip, dt: number): void {
    if (!trip.path) {
      // Its first frame on the board: drawn at the edge, and on its way from the next one.
      const from = this.entryFor(trip.to);
      this.drawn = from ?? trip.to;
      if (from) trip.path = arc(from, trip.to);
      else this.trip = null;
      return;
    }
    trip.elapsed += dt;
    const t = trip.elapsed / trip.ms;
    this.drawn = at(trip.path, EASE.move(t));
    if (t >= 1) this.trip = null;
  }

  private draw(): void {
    const all: Drawn[] = this.drawn ? [{ id: 0, at: this.drawn, share: 1 }] : [];
    for (const h of this.hands) if (h.drawn) all.push({ id: h.id, at: h.drawn, share: h.share });
    this.all = all;
    this.view?.draw();
  }

  private tell(): void {
    const placed = this.drawn !== undefined;
    const led = this.leader !== null;
    const count = 1 + this.hands.filter((h) => h.drawn).length;
    const was = this.shownNow;
    if (placed === was.placed && led === was.led && count === was.count) return;
    this.shownNow = { placed, led, count };
    for (const l of this.listeners) l();
  }
}
