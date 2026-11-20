import type { ArrowItem, Box, Id } from '@keel/protocol';
import type { Ends, Outline } from '../board/shown';
import type { Where } from '../layout';
import { arrowEnds, lassoOutline, shownBoxOf, withArrowsAhead } from '../layout';
import type { Handle } from './resize';
import type { Guide } from './snap';

/**
 * What the owner's hand holds now, frame by frame, outside React: what Select is moving or
 * resizing and by how much, the guides it snapped to, the box it is selecting with. What must
 * follow the hand (the line round the selection, the handles, the arrows tied to what moves,
 * what sits beside a thing that moves) reads it here and is drawn from it, so a drag never draws
 * the whole board again.
 */

/** One frame of what the hand holds. */
export interface Held {
  /** Things drawn moved by `dx`, `dy` (world units): what is moved, and the marks that hang on it. */
  readonly moved: ReadonlySet<Id>;
  readonly dx: number;
  readonly dy: number;
  /**
   * The box each moved or resized thing would be posted with now: its own box, as the log keeps
   * it, not where it is drawn. What is worked out from it (an arrow's ends) is worked out from these.
   */
  readonly stored: ReadonlyMap<Id, Box>;
  /** Things drawn again from `stored`: the arrows and lassos tied to what moves, and the marks that hang on a thing being resized. */
  readonly redraw: ReadonlySet<Id>;
  /** Where everything was when the gesture began. */
  readonly where: Where;
  /** The thing being resized: where it is drawn now, and the handle that is dragged. */
  readonly resize?: { readonly id: Id; readonly box: Box; readonly handle: Handle; readonly cursor: string };
  /** What the gesture snapped to, to draw. */
  readonly guides: readonly Guide[];
  /** The box being drawn to select what it holds, in world units. */
  readonly marquee?: Box;
  /**
   * Arrows drawn as they would be posted now, where the hand changes more than their box: an end
   * dragged by its handle, a label slid along the line, an arrow moved whole that let go of what
   * it pointed at. Each is in `redraw` too.
   */
  readonly drawnAs?: ReadonlyMap<Id, ArrowItem>;
  /** The end, or the label, of the one arrow in `drawnAs` that the hand holds by its handle. */
  readonly grip?: 'from' | 'to' | 'label';
}

/** Is the hand moving things: not resizing one, not selecting with a box, and not holding an arrow by an end or its label? */
export const movesThings = (held: Held | null): boolean => held !== null && !held.resize && !held.marquee && !held.grip;

/** A thing drawn again from what the hand holds: where it is drawn, and for an arrow its ends, for a lasso its outline. */
export interface Redrawn {
  shown: Box;
  ends?: Ends;
  outline?: Outline['loops'];
  /** An arrow the hand changes more than the box of (`Held.drawnAs`): the arrow to draw. */
  item?: ArrowItem;
}

/**
 * The board as a frame of a gesture has it: the things it holds at the boxes it gives them, the
 * arrows it changes more than the box of as it has them (`drawnAs`), and the parts inside a
 * moved picture moved with it. So what is drawn from such an arrow, a lasso round it, is drawn
 * from the arrow in the hand, as the board draws it once the change is in.
 */
export function whereWith(where: Where, held: Pick<Held, 'stored' | 'moved' | 'dx' | 'dy' | 'drawnAs'>): Where {
  const subs = {
    get: (key: string): Box | undefined => {
      const b = where.subs.get(key);
      return b && held.moved.has(key.slice(0, key.indexOf('/'))) ? [b[0] + held.dx, b[1] + held.dy, b[2], b[3]] : b;
    },
  };
  const state = held.drawnAs ? withArrowsAhead(where.state, held.drawnAs) : where.state;
  return { ...where, state, boxes: { get: (id) => held.stored.get(id) ?? where.boxes.get(id) }, subs };
}

/** What the hand holds, for everything that follows it. One per board. */
export class MovingStore {
  private now: Held | null = null;
  private readonly listeners = new Set<() => void>();
  /** The board as this frame has it, worked out once, when first asked for. */
  private frame: Where | undefined;
  /** The things drawn again in this frame, worked out once each, when first asked for. */
  private redrawn = new Map<Id, Redrawn | undefined>();
  /** Where each selected thing is drawn, as the line round the selection last found it. */
  private readonly outlines = new Map<Id, Box>();

  /** What the hand holds now; nothing between gestures. */
  get = (): Held | null => this.now;

  /** A new frame of the gesture, or its end (`null`). Everything that follows it hears at once. */
  set = (held: Held | null): void => {
    this.now = held;
    this.frame = undefined;
    this.redrawn = new Map();
    for (const l of [...this.listeners]) l();
  };

  /** Called on every change. For writing styles and for `useSyncExternalStore`. */
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  /**
   * Where a thing tied to what the hand holds is drawn in this frame, or nothing when it is not
   * one. The same object until the next frame, so React draws it again only when it moved.
   */
  drawn = (id: Id): Redrawn | undefined => {
    const held = this.now;
    if (!held?.redraw.has(id)) return undefined;
    if (this.redrawn.has(id)) return this.redrawn.get(id);
    this.frame ??= whereWith(held.where, held);
    const out = redraw(held, this.frame, id);
    this.redrawn.set(id, out);
    return out;
  };

  /** Is a thing in the hand in this frame: moved, resized, or drawn again because it is tied to what is? */
  holds = (id: Id): boolean => {
    const held = this.now;
    return !!held && (held.resize?.id === id || held.moved.has(id) || held.redraw.has(id));
  };

  /**
   * Where a thing is drawn in this frame, in world units, from where the board has it (`rest`).
   * For what sits beside a thing and is drawn outside it: a lineage arrow, a tag, a chapter's
   * label. A note being resized is as tall here as when the resize began: its height is the
   * page's, known when the hand lets go.
   */
  at = (id: Id, rest: Box): Box => {
    const held = this.now;
    if (!held) return rest;
    if (held.resize?.id === id) return held.resize.box;
    if (held.moved.has(id)) return [rest[0] + held.dx, rest[1] + held.dy, rest[2], rest[3]];
    return this.drawn(id)?.shown ?? rest;
  };

  /** Where a selected thing is drawn, as the line round the selection last found it, in world units. */
  outline = (id: Id): Box | undefined => this.outlines.get(id);

  /** The line round the selection found where its things are drawn. */
  setOutlines = (outlines: ReadonlyMap<Id, Box>): void => {
    this.outlines.clear();
    for (const [id, box] of outlines) this.outlines.set(id, box);
  };
}

/** A thing drawn again on the board as a frame has it (`w`). An arrow the hand changes more than the box of is that board's arrow: it is handed on, to draw. */
function redraw(held: Held, w: Where, id: Id): Redrawn | undefined {
  const s = w.state.items[id];
  const shown = shownBoxOf(w, id);
  if (!s || !shown) return undefined;
  if (s.item.kind === 'arrow') return { shown, ends: arrowEnds(w, s.item, shown), ...(held.drawnAs?.has(id) ? { item: s.item } : {}) };
  if (s.item.kind === 'lasso') return { shown, outline: lassoOutline(w, s.item) };
  return { shown };
}
