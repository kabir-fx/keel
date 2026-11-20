import type { Box, Id } from '@keel/protocol';
import type { FrameLoop } from '../frame';
import type { Point } from '../motion/path';
import { ARRIVAL_GUESS_MS, LAG_MAX_MS, PULL_FADE_SHARE, RATE_MAX, STILL_AFTER_MS } from '../motion/timing';
import { PLAYS, WAITS } from './attributes';
import type { AgentCursorStore } from '../overlay/cursorStore';
import type { Cue } from './cues';
import type { Arrival, Beat, Pose } from './plan';
import { cssOf, cursorAt, ENTER, planArrival, planChip, planFinish, planRedraw } from './plan';
import { readPicture, routeOf } from './read';

/**
 * Plays arrivals on the page, one after another: a picture placed, a placeholder finished, a
 * picture redrawn, a read chip written in. The parts are moved by Web Animations, the cursor is
 * led along its legs, and both keep one time.
 *
 * - Each part is posed by an animation with a delay and `fill: 'backwards'`, made in the commit
 *   in which the picture first has its box, so its first pose is on the page before the page is
 *   painted. Each is put on the board's clock with `frames.hold`: on a live board it runs by
 *   itself, on a manual clock the clock sets it.
 * - The cursor is led with the plan's `cursorAt` at the film's time. On a live board that is the
 *   `currentTime` of one animation made with the others (`clock`): the browser starts them
 *   together on its next frame, and in a frame's callbacks it is the time that frame's
 *   animations are drawn at. So the cursor's tip is on the corner it pulls on every painted
 *   frame, however slow the commit was. On a manual clock it is the clock's own time, which sets
 *   the animations after its callbacks run.
 * - A picture that waits its turn is not shown yet, nor is its arrow: an attribute holds it,
 *   and the style sheet (`styles/arrival.css`) does the rest. It is planned when its turn comes,
 *   from where the cursor is then.
 * - Landing ends an arrival at once: every animation cancelled and off the clock, every
 *   attribute taken off, the cursor let go where it is. The page is then exactly as if nothing
 *   had played.
 *
 * Its own step is on the frame loop only while an arrival plays or waits.
 */

/** What makes an animation: the page's `element.animate`, or a test's stand-in. */
export type Animate = (el: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) => Animation;

/** The page as the player reads it. */
export interface ArrivalStage {
  /** The element a picture is drawn in and its box; none when it is not on the board. */
  item(id: Id): { el: HTMLElement; box: Box } | undefined;
  /** The path of the picture's arrow; none when it has none. */
  arrow(id: Id): SVGPathElement | undefined;
  /** The element of a read chip; none when it is not on the board. */
  chip(id: string): HTMLElement | undefined;
  /** Where an element is drawn, in board units. */
  boxOf(el: Element): Box;
  /**
   * The zoom what plays will be seen at: where the camera is going. What is timed and spaced on
   * the screen is reckoned with it: how long a stroke takes, how far outside the corner the
   * cursor rests.
   */
  zoom(): number;
  /**
   * The zoom the page is drawn at now. What is measured on the page is read with it: while the
   * camera glides, an element's size on the screen is at this zoom, not the one it goes to.
   */
  drawn(): number;
  /** Where a cursor not on the board yet comes in from, on its way to `to`. */
  entry(to: Point): Point | undefined;
}

export interface PlayerNeeds {
  frames: FrameLoop;
  cursor: Pick<AgentCursorStore, 'at' | 'lead'>;
  stage: ArrivalStage;
  animate?: Animate;
  /** Told when an arrival is over, played out or landed, with its cue's id. */
  ended?: (id: string) => void;
}

/** What plays: every cue but the one that only holds a placeholder out of sight. */
export type Played = Exclude<Cue, { kind: 'settling' }>;

/** How far past its end a line's dash starts, in its own units: far enough that its round cap shows nothing. */
const HIDE = 4;

/** A film made ready to play: its plan, the elements its beats pose (by index), its arrow, and the element it is played on. */
interface Film {
  arrival: Arrival;
  elements: readonly Element[];
  arrow?: SVGPathElement | undefined;
  root: Element;
}

/** An arrival on the page. */
interface Playing {
  cue: Played;
  arrival: Arrival;
  /** The board clock's time it began at. */
  start: number;
  /** The animation whose time is the film's on a live board. */
  clock: Animation | undefined;
  animations: Animation[];
  root: Element;
  /** Stops watching its arrow for a new route. */
  unwatch: () => void;
}

/** A cue waiting its turn, and the elements that hold what it brings out of sight. */
interface Waiting {
  cue: Played;
  held: Element[];
}

const page: Animate = (el, keyframes, options) => el.animate(keyframes, options);

export class ArrivalPlayer {
  private playing: Playing | null = null;
  private readonly queue: Waiting[] = [];
  /** Placeholders finished and held out of sight until they have their finished place. */
  private readonly veiled = new Map<Id, Element>();
  /** When the last arrival was over: the next waits a moment of stillness after it. */
  private over = -Infinity;
  private readonly frames: FrameLoop;
  private readonly cursor: PlayerNeeds['cursor'];
  private readonly stage: ArrivalStage;
  private readonly animate: Animate;
  private readonly ended: (id: string) => void;

  constructor({ frames, cursor, stage, animate = page, ended = () => undefined }: PlayerNeeds) {
    this.frames = frames;
    this.cursor = cursor;
    this.stage = stage;
    this.animate = animate;
    this.ended = ended;
  }

  /** True while what this id names plays, waits its turn, or is held out of sight. */
  has = (id: string): boolean => this.playing?.cue.id === id || this.queue.some((w) => w.cue.id === id) || this.veiled.has(id);

  /** The ids of what plays or waits, the playing one first, then what is held out of sight. */
  ids = (): string[] => [...(this.playing ? [this.playing.cue.id] : []), ...this.queue.map((w) => w.cue.id), ...this.veiled.keys()];

  /** What plays now, and when it began on the board's clock. */
  now = (): { cue: Played; arrival: Arrival; start: number } | null => this.playing && { cue: this.playing.cue, arrival: this.playing.arrival, start: this.playing.start };

  /** The cue that plays or waits under this id. */
  cueOf = (id: string): Played | undefined => (this.playing?.cue.id === id ? this.playing.cue : this.queue.find((w) => w.cue.id === id)?.cue);

  /**
   * Play a cue: now, when nothing plays and the board has been still long enough, else when its
   * turn comes. Call it in the commit the cue was read in, before the page is painted.
   */
  play = (cue: Played): void => {
    this.unveil(cue.id);
    if (this.playing?.cue.id === cue.id || this.queue.some((w) => w.cue.id === cue.id) || !this.exists(cue)) return;
    const now = this.frames.now();
    if (!this.playing && this.queue.length === 0 && now >= this.over + STILL_AFTER_MS) {
      this.begin(cue, now);
    } else {
      this.queue.push({ cue, held: this.hold(cue) });
      this.keepUp();
    }
    if (this.playing || this.queue.length > 0) this.frames.start(this, this.step);
  };

  /** Hold a finished placeholder out of sight until it has its finished place, and is pulled to it. */
  veil = (id: Id): void => {
    const el = this.stage.item(id)?.el;
    if (!el || this.veiled.get(id) === el) return;
    this.unveil(id);
    el.setAttribute(WAITS, '');
    this.veiled.set(id, el);
  };

  /** Land what this id names at once, playing, waiting or held: it is simply there. */
  land = (id: string): void => {
    this.unveil(id);
    if (this.playing?.cue.id === id) {
      this.finish(this.playing);
      return;
    }
    const i = this.queue.findIndex((w) => w.cue.id === id);
    if (i < 0) return;
    const [w] = this.queue.splice(i, 1);
    this.release(w!);
    this.ended(id);
  };

  /** Land everything that plays, waits or is held. */
  landAll = (): void => {
    for (const id of [...this.veiled.keys()]) this.unveil(id);
    if (this.playing) this.finish(this.playing);
    for (const w of this.queue.splice(0)) {
      this.release(w);
      this.ended(w.cue.id);
    }
  };

  /** Land everything, and leave the frame loop: the board is going. */
  dispose = (): void => {
    this.landAll();
    this.frames.cancel(this);
  };

  /** The film's time of what plays: its clock's on a live board, the board's on a manual clock. */
  private time(p: Playing): number {
    const t = p.clock?.currentTime;
    if (this.frames.manual || typeof t !== 'number' || p.clock!.playState === 'idle') return this.frames.now() - p.start;
    return t;
  }

  /** One frame: end the arrival that is over, and start the next once the board has been still. */
  private step = (): boolean => {
    const p = this.playing;
    if (p && this.time(p) >= p.arrival.total) this.finish(p, true);
    const now = this.frames.now();
    while (!this.playing && this.queue.length > 0 && now >= this.over + STILL_AFTER_MS) {
      const next = this.queue.shift()!;
      this.release(next);
      this.begin(next.cue, now);
    }
    return this.playing !== null || this.queue.length > 0;
  };

  /** True when what a cue brings is on the page. */
  private exists(cue: Played): boolean {
    return cue.kind === 'read' ? !!this.stage.chip(cue.id) : !!this.stage.item(cue.id);
  }

  /** Read the page for a cue and plan its film; none when there is nothing to draw on. */
  private film(cue: Played, rate: number): Film | undefined {
    const zoom = this.stage.zoom();
    const cursor = this.cursor.at();
    const entry = (to: Point) => (cursor ? undefined : this.stage.entry(to));
    if (cue.kind === 'read') {
      const chip = this.stage.chip(cue.id);
      if (!chip) return undefined;
      const box = this.stage.boxOf(chip);
      return { arrival: planChip({ chip: box, cursor, entry: entry([box[0], box[1] + box[3]]), zoom, rate }), elements: [chip], root: chip };
    }
    const item = this.stage.item(cue.id);
    const reading = item && readPicture(item.el, item.box, this.stage.drawn());
    if (!item || !reading) return undefined;
    const base = { card: reading.card, cursor, parts: reading.planned, zoom, rate };
    const elements = reading.parts.map((p) => p.el);
    const corner = (b: Box): Point => [b[0] + b[2], b[1] + b[3]];
    switch (cue.kind) {
      case 'placed': {
        const arrow = this.stage.arrow(cue.id);
        const route = arrow && routeOf(arrow);
        const arrival = planArrival({ ...base, paper: reading.paper, route, entry: entry(route?.[0] ?? [item.box[0], item.box[1]]) });
        return { arrival, elements, arrow, root: reading.root };
      }
      case 'finished':
        return { arrival: planFinish({ ...base, from: cue.from, paper: reading.paper, entry: entry(corner(cue.from)) }), elements, root: reading.root };
      case 'redrawn':
        return { arrival: planRedraw({ ...base, entry: entry(corner(reading.card)) }), elements, root: reading.root };
    }
  }

  /** Plan and start one film. What cannot be read simply lands. */
  private begin(cue: Played, now: number): void {
    let film = this.film(cue, 1);
    const rate = film ? this.rateFor(film.arrival.total) : 1;
    if (film && rate > 1) film = this.film(cue, rate);
    if (!film) {
      this.ended(cue.id);
      return;
    }
    const { arrival, root, arrow } = film;
    const animations = arrival.beats.flatMap((beat) => this.pose(beat, film!, now));
    // Made in the same task as the others, so the browser starts it with them: its time is the film's.
    const clock = this.animate(root, [], { duration: arrival.total });
    clock.finished?.catch(() => undefined);
    this.frames.hold(clock, now);
    animations.push(clock);
    root.setAttribute(PLAYS, '');
    const playing: Playing = { cue, arrival, start: now, clock, animations, root, unwatch: this.watch(cue.id, arrow) };
    this.playing = playing;
    this.cursor.lead(() => cursorAt(arrival, this.time(playing)));
  }

  /** The animations that pose one beat's part, made and put on the clock. */
  private pose(beat: Beat, film: Film, start: number): Animation[] {
    const el = beat.part === 'arrow' ? film.arrow : film.elements[beat.part];
    if (!el) return [];
    const timing: KeyframeAnimationOptions = { delay: beat.start, duration: beat.ms, easing: cssOf(beat.ease), fill: 'backwards' };
    const made = keyframesFor(beat.pose).map(([frames, share]) =>
      this.animate(el, frames, share === 1 ? timing : { ...timing, duration: beat.ms * share, easing: cssOf(ENTER) }),
    );
    for (const a of made) {
      // Landing cancels it, and a cancelled animation's `finished` rejects: nothing waits on it.
      a.finished?.catch(() => undefined);
      this.frames.hold(a, start);
    }
    return made;
  }

  /** Land the arrival when its arrow is routed anew under it: its dash was measured on the old route. */
  private watch(id: string, arrow: SVGPathElement | undefined): () => void {
    if (!arrow || typeof MutationObserver !== 'function') return () => undefined;
    const watch = new MutationObserver(() => this.land(id));
    watch.observe(arrow, { attributes: true, attributeFilter: ['d'] });
    return () => watch.disconnect();
  }

  /**
   * End an arrival: nothing of it is left on the page, and the cursor stays where it is. One that
   * played out is followed by a moment of stillness; one landed at once is not.
   */
  private finish(p: Playing, played = false): void {
    if (this.playing !== p) return;
    this.playing = null;
    if (played) this.over = this.frames.now();
    p.unwatch();
    for (const a of p.animations) {
      a.cancel();
      this.frames.release(a);
    }
    p.root.removeAttribute(PLAYS);
    this.cursor.lead(null);
    this.ended(p.cue.id);
    if (this.queue.length === 0) this.frames.cancel(this);
  }

  /**
   * Hold what a waiting cue brings out of sight: a new picture and its arrow, a finished
   * placeholder, what is on a redrawn picture (its paper stays), a chip.
   */
  private hold(cue: Played): Element[] {
    const out: Array<[Element | undefined, string]> =
      cue.kind === 'read'
        ? [[this.stage.chip(cue.id), '']]
        : cue.kind === 'redrawn'
          ? [[this.stage.item(cue.id)?.el.querySelector('[data-build]') ?? undefined, 'content']]
          : [
              [this.stage.item(cue.id)?.el, ''],
              [cue.kind === 'placed' ? this.stage.arrow(cue.id) : undefined, ''],
            ];
    const held: Element[] = [];
    for (const [el, what] of out) {
      if (!el) continue;
      el.setAttribute(WAITS, what);
      held.push(el);
    }
    return held;
  }

  private release(w: Waiting): void {
    for (const el of w.held) el.removeAttribute(WAITS);
  }

  private unveil(id: Id): void {
    this.veiled.get(id)?.removeAttribute(WAITS);
    this.veiled.delete(id);
  }

  /** How far behind the log the board would be: what is left of the arrival playing, and the guess of each that waits. */
  private behind(waiting = this.queue.length): number {
    const p = this.playing;
    const left = p ? Math.max(0, p.arrival.total - this.time(p)) : 0;
    return left + waiting * (ARRIVAL_GUESS_MS + STILL_AFTER_MS);
  }

  /** The rate a film of this length plays at, with what waits behind it: faster when the board would fall too far behind, up to `RATE_MAX`. */
  private rateFor(total: number): number {
    return Math.min(RATE_MAX, Math.max(1, (total + this.behind()) / LAG_MAX_MS));
  }

  /** When even the fastest rate leaves the board too far behind, the oldest that wait simply land. */
  private keepUp(): void {
    while (this.queue.length > 0 && this.behind() / RATE_MAX > LAG_MAX_MS) this.land(this.queue[0]!.cue.id);
  }
}

/**
 * The keyframes that pose a part, each with the share of the beat it takes: the first keyframe
 * is the part as it comes in, and the part at rest is the end. Where the end is left out, it is
 * the part's own style, so the part ends exactly as it is drawn at rest.
 */
export function keyframesFor(pose: Pose): Array<[Keyframe[], number]> {
  switch (pose.kind) {
    case 'draw': {
      // The dash is the line's length, the gap longer, and the offset moves the dash in from before the start.
      const dash = `${pose.length}px ${pose.length + 2 * HIDE}px`;
      return [
        [
          [
            { strokeDasharray: dash, strokeDashoffset: `${pose.length + HIDE}px`, markerEnd: 'none' },
            { strokeDasharray: dash, strokeDashoffset: '0px', markerEnd: 'none' },
          ],
          1,
        ],
      ];
    }
    case 'pull': {
      // From nothing, about the point it is pulled from; its paper fades in over the first of it.
      const origin = `${pose.origin[0]}px ${pose.origin[1]}px`;
      return [
        [
          [
            { scale: '0', transformOrigin: origin },
            { scale: '1', transformOrigin: origin },
          ],
          1,
        ],
        [[{ opacity: 0, offset: 0 }], PULL_FADE_SHARE],
      ];
    }
    case 'rise':
      return [[[{ opacity: 0, translate: `0 ${pose.by}px`, offset: 0 }], 1]];
    case 'grow':
      return [[[{ opacity: 0, scale: String(pose.from), offset: 0 }], 1]];
    case 'fade':
      return [
        [
          [
            { opacity: 0, scale: String(pose.from), markerEnd: 'none' },
            { opacity: 1, scale: '1', markerEnd: 'none' },
          ],
          1,
        ],
      ];
    case 'reshape':
      // About the top left, a move and a scale on one easing: the corner runs on a straight line.
      return [
        [
          [
            { translate: `${pose.move[0]}px ${pose.move[1]}px`, scale: `${pose.scale[0]} ${pose.scale[1]}`, transformOrigin: '0 0' },
            { translate: '0px 0px', scale: '1 1', transformOrigin: '0 0' },
          ],
          1,
        ],
      ];
    case 'write':
      // From the left, by a clip: the chip's own transform (it is centred under its mark) is left alone.
      return [[[{ clipPath: 'inset(0 100% 0 0 round 999px)' }, { clipPath: 'inset(0 0% 0 0 round 999px)' }], 1]];
  }
}
