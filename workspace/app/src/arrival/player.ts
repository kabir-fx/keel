import type { Box, Id } from '@keel/protocol';
import type { FrameLoop } from '../frame';
import type { Point } from '../motion/path';
import { ARRIVAL_GUESS_MS, BAND_OUT_MS, GATE_MAX_MS, HAND_STAGGER_MS, HANDS_MAX, LAG_MAX_MS, RATE_MAX, STILL_AFTER_MS } from '../motion/timing';
import { PLAYS, WAITS } from './attributes';
import type { AgentCursorStore, Lead } from '../overlay/cursorStore';
import type { Cue } from './cues';
import type { Arrival, Beat } from './plan';
import { cssOf, cursorAt, ENTER, planArrival, planChip, planFinish, planRedraw, restBy } from './plan';
import { readPicture, routeOf } from './read';

/**
 * Plays arrivals on the page: a picture placed, a placeholder finished, a picture redrawn, a read
 * chip written in. The parts are moved by Web Animations, each film's cursor is led along its
 * legs, and both keep one time.
 *
 * - The cues read in one commit are a wave, and its films play at once. The agent's own cursor
 *   leads the film that starts nearest it; each further one is led by a cursor split off it,
 *   `HAND_STAGGER_MS` after the one before began. At most `HANDS_MAX` play at a time: what is
 *   over that waits, and a cursor whose film is over takes the next, the agent's own first, after
 *   `STILL_AFTER_MS` of stillness. A cue read while films play joins the same way. When nothing
 *   plays and nothing waits, the split cursors merge into the agent's own at the rest of the film
 *   that ended last.
 * - A wave begins a frame after the camera has stopped (`stage.settled()`), or `GATE_MAX_MS`
 *   after it was read. Until then its pictures wait, and the agent's own cursor, when it leads nothing,
 *   travels to where its film will start. When the camera is still, the first film begins in the
 *   commit its cue was read in.
 * - Each part is posed by an animation with a delay and `fill: 'backwards'`, made in the commit
 *   its film begins in, so its first pose is on the page before the page is painted. A picture
 *   is never scaled as it arrives: a band (`div.arrival-band`, made for the film inside the
 *   picture's element) is dragged out to its rectangle, and the picture shows in place when the
 *   band is whole. Each animation is put on the board's clock with `frames.hold`: on a live
 *   board it runs by itself, on a manual clock the clock sets it.
 * - A film's cursor is led with the plan's `cursorAt` at the film's time. On a live board that is
 *   the `currentTime` of one animation made with the others (`clock`): the browser starts them
 *   together on its next frame, and in a frame's callbacks it is the time that frame's
 *   animations are drawn at. So the cursor's tip is on the corner it drags on every painted
 *   frame, however slow the commit was. On a manual clock it is the clock's own time.
 * - What waits is not shown yet, nor is its arrow: an attribute holds it, and the style sheet
 *   (`styles/arrival.css`) does the rest. A finished placeholder that waits keeps its frame: a
 *   band stands where the placeholder was, so the place is never empty. It is planned when it
 *   begins, from where its cursor is then. What is held out of sight is told (`held`,
 *   `subscribe`), so the minimap leaves it out.
 * - Landing ends a film at once: every animation cancelled and off the clock, the band and every
 *   attribute taken off, its cursor let go where it is. The page is then exactly as if nothing
 *   had played.
 *
 * Its own step is on the frame loop only while a film plays or waits.
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
  /** True when the camera is not moving: a wave begins then, so nothing is drawn on under a moving camera. */
  settled(): boolean;
  /** Where a cursor not on the board yet comes in from, on its way to `to`. */
  entry(to: Point): Point | undefined;
}

export interface PlayerNeeds {
  frames: FrameLoop;
  cursor: Pick<AgentCursorStore, 'at' | 'lead' | 'travelTo' | 'split' | 'merge'>;
  stage: ArrivalStage;
  animate?: Animate;
  /** Told when an arrival is over, played out or landed, with its cue's id. */
  ended?: (id: string) => void;
}

/** What plays: every cue but the one that only holds a placeholder out of sight. */
export type Played = Exclude<Cue, { kind: 'settling' }>;

/** One animation of a beat: its keyframes and its timing. */
export interface Motion {
  keyframes: Keyframe[];
  timing: KeyframeAnimationOptions;
}

/** How far past its end a line's dash starts, in its own units: far enough that its round cap shows nothing. */
const HIDE = 4;

/** A film made ready to play: its plan, the elements its beats pose (by index), its arrow, the element it is played on, and where its band goes. */
interface Film {
  arrival: Arrival;
  elements: readonly Element[];
  arrow?: SVGPathElement | undefined;
  root: Element;
  /** The element the picture is drawn in, and whether its root has paper: the band is made in it. */
  item?: { el: HTMLElement; paper: boolean } | undefined;
}

/** A cursor that leads films: the agent's own, or one split off it. */
interface Hand {
  lead: Lead;
  /** When it may take the next film that waits: a moment of stillness after the one it led. */
  ready: number;
}

/** A film on the page. */
interface Playing {
  cue: Played;
  arrival: Arrival;
  /** The board clock's time it began at. */
  start: number;
  /** The animation whose time is the film's on a live board. */
  clock: Animation | undefined;
  animations: Animation[];
  root: Element;
  band: HTMLElement | undefined;
  hand: Hand;
  /** Stops watching its arrow for a new route. */
  unwatch: () => void;
}

/** A cue waiting to begin, and the elements that hold what it brings out of sight. */
interface Waiting {
  cue: Played;
  held: Element[];
  /** The band that stands where a finished placeholder was, until its film begins. */
  frame?: HTMLElement;
}

const page: Animate = (el, keyframes, options) => el.animate(keyframes, options);

const NONE: ReadonlySet<string> = new Set();

export class ArrivalPlayer {
  private readonly playing: Playing[] = [];
  private readonly queue: Waiting[] = [];
  /** Placeholders finished and held out of sight until they have their finished place. */
  private readonly veiled = new Map<Id, Element>();
  private readonly own: Hand;
  /** The cursors split off the agent's own for this wave, until they merge. */
  private split: Hand[] = [];
  /** When the last film began: the next one of a wave begins `HAND_STAGGER_MS` after. */
  private began = -Infinity;
  /** When the cues that wait for the camera to stop were read, and whether it was still at the last frame; null when none wait for it. */
  private gate: { since: number; still: boolean } | null = null;
  /** Where the film that ended last rests: the split cursors merge there. */
  private lastRest: Point | undefined;
  private heldNow: ReadonlySet<string> = NONE;
  private readonly listeners = new Set<() => void>();
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
    this.own = { lead: cursor, ready: -Infinity };
  }

  /** True while what this id names plays, waits, or is held out of sight. */
  has = (id: string): boolean => this.playing.some((p) => p.cue.id === id) || this.queue.some((w) => w.cue.id === id) || this.veiled.has(id);

  /** The ids of what plays or waits, what plays first, then what is held out of sight. */
  ids = (): string[] => [...this.playing.map((p) => p.cue.id), ...this.queue.map((w) => w.cue.id), ...this.veiled.keys()];

  /** What plays now, in the order it began, and when each began on the board's clock. */
  films = (): Array<{ cue: Played; arrival: Arrival; start: number }> => this.playing.map(({ cue, arrival, start }) => ({ cue, arrival, start }));

  /** The cue that plays or waits under this id. */
  cueOf = (id: string): Played | undefined => (this.playing.find((p) => p.cue.id === id) ?? this.queue.find((w) => w.cue.id === id))?.cue;

  /** The ids held out of sight now: waiting to begin, or a finished placeholder veiled. The same set until it changes. */
  held = (): ReadonlySet<string> => this.heldNow;

  /** Called when `held` changes. For `useSyncExternalStore`. */
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  /**
   * Play the cues read in one commit: a wave. Call it in the commit they were read in, before
   * the page is painted.
   */
  play = (cues: readonly Cue[]): void => {
    const now = this.frames.now();
    const wave: Waiting[] = [];
    for (const cue of cues) {
      if (cue.kind === 'settling') {
        this.veil(cue.id);
        continue;
      }
      this.unveil(cue.id);
      if (this.has(cue.id) || wave.some((w) => w.cue.id === cue.id) || !this.exists(cue)) continue;
      wave.push({ cue, held: [] });
    }
    if (wave.length > 0) {
      const at = this.cursor.at();
      const starts = wave.map((w) => this.startOf(w.cue));
      // The agent's own cursor leads the film that starts nearest it.
      if (at && wave.length > 1) {
        const near = (p: Point | undefined) => (p ? Math.hypot(p[0] - at[0], p[1] - at[1]) : Infinity);
        const first = starts.reduce((best, p, i) => (near(p) < near(starts[best]) ? i : best), 0);
        wave.unshift(...wave.splice(first, 1));
        starts.unshift(...starts.splice(first, 1));
      }
      this.queue.push(...wave);
      if (!this.stage.settled()) {
        this.gate ??= { since: now, still: false };
        // To where what begins first will start: an older cue that waits comes before this wave.
        const to = this.startOf(this.queue[0]!.cue);
        if (this.free(this.own) && to) this.cursor.travelTo(to);
      }
      this.pump(now);
      // What did not begin now waits out of sight.
      for (const w of wave) if (this.queue.includes(w)) this.hold(w);
      this.keepUp();
    }
    this.tell();
    if (this.playing.length > 0 || this.queue.length > 0) this.frames.start(this, this.step);
  };

  /** Land what this id names at once, playing, waiting or held: it is simply there. */
  land = (id: string): void => {
    this.unveil(id);
    const p = this.playing.find((f) => f.cue.id === id);
    if (p) this.finish(p);
    else {
      const i = this.queue.findIndex((w) => w.cue.id === id);
      if (i >= 0) {
        const [w] = this.queue.splice(i, 1);
        this.release(w!);
        this.ended(id);
        this.idle();
      }
    }
    this.tell();
  };

  /** Land everything that plays, waits or is held. */
  landAll = (): void => {
    for (const id of [...this.veiled.keys()]) this.unveil(id);
    for (const w of this.queue.splice(0)) {
      this.release(w);
      this.ended(w.cue.id);
    }
    for (const p of [...this.playing]) this.finish(p);
    this.idle();
    this.tell();
  };

  /** Land everything, and leave the frame loop: the board is going. */
  dispose = (): void => {
    this.landAll();
    this.frames.cancel(this);
  };

  /** The film's time: its clock's on a live board, the board's on a manual clock. */
  private time(p: Playing): number {
    const t = p.clock?.currentTime;
    if (this.frames.manual || typeof t !== 'number' || p.clock!.playState === 'idle') return this.frames.now() - p.start;
    return t;
  }

  /** True when a film has played out: its clock says so (Chrome may report a finished clock's time one float step short of its duration), or its time has reached its total. */
  private playedOut(p: Playing): boolean {
    return p.clock?.playState === 'finished' || this.time(p) >= p.arrival.total;
  }

  /** One frame: end the films that are over, and begin what may begin. */
  private step = (): boolean => {
    for (const p of [...this.playing]) if (this.playedOut(p)) this.finish(p, true);
    this.pump(this.frames.now());
    this.tell();
    return this.playing.length > 0 || this.queue.length > 0;
  };

  /** Begin what waits, in turn, as long as the camera has stopped, the stagger allows, and a cursor is free or may be split off. */
  private pump(now: number): void {
    if (this.gate !== null) {
      // The frame the camera lands in is not drawn on: the wave begins on the next.
      const still = this.stage.settled();
      const opens = (still && this.gate.still) || now - this.gate.since >= GATE_MAX_MS;
      this.gate.still = still;
      if (!opens) return;
      this.gate = null;
    }
    while (this.queue.length > 0) {
      if (this.playing.length > 0 && now < this.began + HAND_STAGGER_MS) return;
      const hand = this.handFor(now);
      if (!hand) return;
      const next = this.queue.shift()!;
      this.release(next);
      this.begin(next.cue, hand, now);
    }
  }

  /** True when a cursor leads no film. */
  private free(hand: Hand): boolean {
    return !this.playing.some((p) => p.hand === hand);
  }

  /** The cursor the next film begins with: a free one, the agent's own first, once still; else one to split off once the film is planned, while fewer than `HANDS_MAX` play. */
  private handFor(now: number): Hand | 'split' | undefined {
    const free = [this.own, ...this.split].filter((h) => this.free(h));
    if (free.length > 0) return free.find((h) => now >= h.ready);
    return this.playing.length < HANDS_MAX ? 'split' : undefined;
  }

  /** True when what a cue brings is on the page. */
  private exists(cue: Played): boolean {
    return cue.kind === 'read' ? !!this.stage.chip(cue.id) : !!this.stage.item(cue.id);
  }

  /** Where a cue's film will start, in board units, for the cursor that leads it to go to. */
  private startOf(cue: Played): Point | undefined {
    if (cue.kind === 'read') {
      const chip = this.stage.chip(cue.id);
      const b = chip && this.stage.boxOf(chip);
      return b && [b[0], b[1] + b[3]];
    }
    const box = this.stage.item(cue.id)?.box;
    if (!box) return undefined;
    switch (cue.kind) {
      case 'placed': {
        const arrow = this.stage.arrow(cue.id);
        return (arrow && routeOf(arrow)?.[0]) ?? [box[0], box[1]];
      }
      case 'finished':
        return restBy(cue.from, this.stage.zoom());
      case 'redrawn':
        return restBy(box, this.stage.zoom());
    }
  }

  /** Read the page for a cue and plan its film, from where its cursor is; none when there is nothing to draw on. */
  private film(cue: Played, cursor: Point | undefined, rate: number): Film | undefined {
    const zoom = this.stage.zoom();
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
    const at: Point = [item.box[0], item.box[1]];
    const band = { el: item.el, paper: reading.paper };
    const corner = (b: Box): Point => [b[0] + b[2], b[1] + b[3]];
    switch (cue.kind) {
      case 'placed': {
        const arrow = this.stage.arrow(cue.id);
        const route = arrow && routeOf(arrow);
        const arrival = planArrival({ ...base, at, paper: reading.paper, route, entry: entry(route?.[0] ?? at) });
        return { arrival, elements, arrow, root: reading.root, item: band };
      }
      case 'finished':
        return { arrival: planFinish({ ...base, at, from: cue.from, paper: reading.paper, entry: entry(corner(cue.from)) }), elements, root: reading.root, item: band };
      case 'redrawn':
        return { arrival: planRedraw({ ...base, entry: entry(corner(reading.card)) }), elements, root: reading.root };
    }
  }

  /**
   * Plan and start one film, led by `hand`, or by a cursor split off the agent's own once there is
   * a film to lead: it starts where the agent's own is, so the film is planned from there. What
   * cannot be read simply lands.
   */
  private begin(cue: Played, to: Hand | 'split', now: number): void {
    const from = to === 'split' ? this.cursor.at() : to.lead.at();
    let film = this.film(cue, from, 1);
    const rate = film ? this.rateFor(film.arrival.total) : 1;
    if (film && rate > 1) film = this.film(cue, from, rate);
    if (!film) {
      this.ended(cue.id);
      return;
    }
    const hand: Hand = to === 'split' ? { lead: this.cursor.split(1)[0]!, ready: now } : to;
    if (to === 'split') this.split.push(hand);
    const { arrival, root, arrow } = film;
    const drag = arrival.beats.find((b) => b.part === 'band');
    const band = drag?.pose.kind === 'drag' && film.item ? makeBand(film.item.el, root, film.item.paper, drag.pose.to) : undefined;
    const animations = arrival.beats.flatMap((beat) => this.pose(beat, film!, band, BAND_OUT_MS / rate, now));
    // Made in the same task as the others, so the browser starts it with them: its time is the film's.
    const clock = this.animate(root, [], { duration: arrival.total });
    clock.finished?.catch(() => undefined);
    this.frames.hold(clock, now);
    animations.push(clock);
    root.setAttribute(PLAYS, '');
    const playing: Playing = { cue, arrival, start: now, clock, animations, root, band, hand, unwatch: this.watch(cue.id, arrow) };
    this.playing.push(playing);
    this.began = now;
    hand.lead.lead(() => cursorAt(arrival, this.time(playing)));
  }

  /** The animations that pose one beat's part, made and put on the clock. */
  private pose(beat: Beat, film: Film, band: HTMLElement | undefined, out: number, start: number): Animation[] {
    const el = beat.part === 'arrow' ? film.arrow : beat.part === 'band' ? band : film.elements[beat.part];
    if (!el) return [];
    const made = motionsOf(beat, out).map((m) => this.animate(el, m.keyframes, m.timing));
    for (const a of made) {
      // Landing cancels it, and a cancelled animation's `finished` rejects: nothing waits on it.
      a.finished?.catch(() => undefined);
      this.frames.hold(a, start);
    }
    return made;
  }

  /** Land the film when its arrow is routed anew under it: its dash was measured on the old route. */
  private watch(id: string, arrow: SVGPathElement | undefined): () => void {
    if (!arrow || typeof MutationObserver !== 'function') return () => undefined;
    const watch = new MutationObserver(() => this.land(id));
    watch.observe(arrow, { attributes: true, attributeFilter: ['d'] });
    return () => watch.disconnect();
  }

  /**
   * End a film: nothing of it is left on the page, and its cursor stays where it is. One that
   * played out leaves its cursor still a moment before it takes the next; one landed does not.
   */
  private finish(p: Playing, played = false): void {
    const i = this.playing.indexOf(p);
    if (i < 0) return;
    this.playing.splice(i, 1);
    p.unwatch();
    for (const a of p.animations) {
      a.cancel();
      this.frames.release(a);
    }
    p.band?.remove();
    p.root.removeAttribute(PLAYS);
    p.hand.ready = this.frames.now() + (played ? STILL_AFTER_MS : 0);
    p.hand.lead.lead(null);
    this.lastRest = p.arrival.rest;
    this.ended(p.cue.id);
    this.idle();
  }

  /** Once nothing plays and nothing waits: the split cursors merge into the agent's own where the last film rests, and the player leaves the frame loop. */
  private idle(): void {
    if (this.playing.length > 0 || this.queue.length > 0) return;
    this.gate = null;
    if (this.split.length > 0) {
      const to = this.lastRest ?? this.cursor.at();
      if (to) this.cursor.merge(to);
      this.split = [];
    }
    this.frames.cancel(this);
  }

  /** Hold a finished placeholder out of sight until it has its finished place, and is dragged to it. */
  private veil(id: Id): void {
    const el = this.stage.item(id)?.el;
    if (!el || this.veiled.get(id) === el) return;
    this.unveil(id);
    el.setAttribute(WAITS, '');
    this.veiled.set(id, el);
  }

  /**
   * Hold what a waiting cue brings out of sight: a new picture and its arrow, what is on a
   * redrawn picture (its paper stays), a chip. A finished placeholder keeps its frame: a band
   * stands where the placeholder was.
   */
  private hold(w: Waiting): void {
    const { cue } = w;
    const item = cue.kind === 'read' ? undefined : this.stage.item(cue.id);
    const out: Array<[Element | undefined, string]> =
      cue.kind === 'read'
        ? [[this.stage.chip(cue.id), '']]
        : cue.kind === 'redrawn'
          ? [[item?.el.querySelector('[data-build]') ?? undefined, 'content']]
          : [
              [item?.el, cue.kind === 'finished' ? 'frame' : ''],
              [cue.kind === 'placed' ? this.stage.arrow(cue.id) : undefined, ''],
            ];
    for (const [el, what] of out) {
      if (!el) continue;
      el.setAttribute(WAITS, what);
      w.held.push(el);
    }
    const reading = cue.kind === 'finished' && item ? readPicture(item.el, item.box, this.stage.drawn()) : undefined;
    if (cue.kind === 'finished' && item && reading) {
      const [x, y, width, height] = cue.from;
      w.frame = makeBand(item.el, reading.root, reading.paper, [x - item.box[0], y - item.box[1], width, height]);
    }
  }

  private release(w: Waiting): void {
    for (const el of w.held) el.removeAttribute(WAITS);
    w.frame?.remove();
  }

  private unveil(id: Id): void {
    this.veiled.get(id)?.removeAttribute(WAITS);
    this.veiled.delete(id);
  }

  /** Tell the listeners when what is held out of sight changed. */
  private tell(): void {
    const ids = [...this.queue.map((w) => w.cue.id), ...this.veiled.keys()];
    if (ids.length === this.heldNow.size && ids.every((id) => this.heldNow.has(id))) return;
    this.heldNow = ids.length === 0 ? NONE : new Set(ids);
    for (const l of this.listeners) l();
  }

  /**
   * How far behind the log the board would be, with a film of `total` about to begin. Films play
   * side by side: it is the longest left to play, and a guess for each round of `HANDS_MAX` that
   * cannot begin until others end.
   */
  private behind(total = 0): number {
    const left = Math.max(total, ...this.playing.map((p) => Math.max(0, p.arrival.total - this.time(p))));
    const lanes = HANDS_MAX - this.playing.length - (total > 0 ? 1 : 0);
    const later = Math.max(0, this.queue.length - lanes);
    return left + Math.ceil(later / HANDS_MAX) * (ARRIVAL_GUESS_MS + STILL_AFTER_MS);
  }

  /** The rate a film of this length plays at: faster when the board would fall too far behind, up to `RATE_MAX`. */
  private rateFor(total: number): number {
    return Math.min(RATE_MAX, Math.max(1, this.behind(total) / LAG_MAX_MS));
  }

  /** When even the fastest rate leaves the board too far behind, the oldest that wait simply land. */
  private keepUp(): void {
    while (this.queue.length > 0 && this.behind() / RATE_MAX > LAG_MAX_MS) this.land(this.queue[0]!.cue.id);
  }
}

/** The band a film drags out, in the picture's element and under its root: the paper's colour and corners, at `to` (in the element's pixels) when at rest, where it is not seen. */
function makeBand(item: HTMLElement, root: Element, paper: boolean, to: Box): HTMLElement {
  const band = item.ownerDocument.createElement('div');
  band.className = 'arrival-band';
  const look = getComputedStyle(root);
  if (paper) band.style.backgroundColor = look.backgroundColor;
  else band.setAttribute('data-bare', '');
  band.style.borderRadius = look.borderRadius;
  Object.assign(band.style, boxStyle(to));
  item.prepend(band);
  return band;
}

/** A rectangle as the style properties that place an element. */
const boxStyle = (b: Box) => ({ left: `${b[0]}px`, top: `${b[1]}px`, width: `${b[2]}px`, height: `${b[3]}px` });

/**
 * The animations that pose a beat's part. The first keyframe is the part as it comes in, and
 * the part at rest is the end; where the end is left out, it is the part's own style, so the
 * part ends exactly as it is drawn at rest. The band is seen while it is dragged and as it goes,
 * over `out` after: its own style hides it.
 */
export function motionsOf(beat: Beat, out: number): Motion[] {
  const timing: KeyframeAnimationOptions = { delay: beat.start, duration: beat.ms, easing: cssOf(beat.ease), fill: 'backwards' };
  const one = (keyframes: Keyframe[]): Motion[] => [{ keyframes, timing }];
  const pose = beat.pose;
  switch (pose.kind) {
    case 'draw': {
      // The dash is the line's length, the gap longer, and the offset moves the dash in from before the start.
      const dash = `${pose.length}px ${pose.length + 2 * HIDE}px`;
      return one([
        { strokeDasharray: dash, strokeDashoffset: `${pose.length + HIDE}px`, markerEnd: 'none' },
        { strokeDasharray: dash, strokeDashoffset: '0px', markerEnd: 'none' },
      ]);
    }
    case 'drag': {
      // Dragged from a rectangle (a placeholder's), it stands there from the start, so the place is never empty; from a point, it is not seen before it is dragged.
      const fill: FillMode = pose.from[2] > 0 && pose.from[3] > 0 ? 'backwards' : 'none';
      return [
        { keyframes: [{ ...boxStyle(pose.from), opacity: 1 }, { ...boxStyle(pose.to), opacity: 1 }], timing: { ...timing, fill } },
        { keyframes: [{ opacity: 1 }, { opacity: 0 }], timing: { delay: beat.start + beat.ms, duration: out, easing: cssOf(ENTER), fill: 'none' } },
      ];
    }
    case 'appear':
      return one([{ opacity: 0 }, { opacity: 1 }]);
    case 'rise':
      return one([{ opacity: 0, translate: `0 ${pose.by}px`, offset: 0 }]);
    case 'grow':
      return one([{ opacity: 0, scale: String(pose.from), offset: 0 }]);
    case 'fade':
      return one([
        { opacity: 0, scale: String(pose.from), markerEnd: 'none' },
        { opacity: 1, scale: '1', markerEnd: 'none' },
      ]);
    case 'write':
      // From the left, by a clip: the chip's own transform (it is centred under its mark) is left alone.
      return one([{ clipPath: 'inset(0 100% 0 0 round 999px)' }, { clipPath: 'inset(0 0% 0 0 round 999px)' }]);
  }
}
