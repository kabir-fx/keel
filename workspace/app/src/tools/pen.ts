import type { Id, InkItem } from '@keel/protocol';
import type { Pt } from '../geometry';
import type { Drawing, Pieces } from '../ink/stroke';
import { carriedOn, drawing, PEN } from '../ink/stroke';
import { GO_MAX_STROKES, PEN_PAUSE } from '../input/constants';
import { inkItem, penWidth, splitGo } from '../marks';
import type { BoardCtx, Press, Sample, Tool } from './types';

/** The Pen tool, with what the board needs of the go in its hand. */
export interface PenTool extends Tool {
  /** True while a go is open: strokes wait to become a mark, or one is being drawn. */
  open(): boolean;
  /** True when finished strokes wait for the pen's pause. */
  waiting(): boolean;
  /** Make the finished strokes of the go into marks now, without waiting for the pause. */
  finish(board: BoardCtx): Promise<void>;
  /**
   * Take back the last finished stroke of the go, as Undo does while the go is not a mark yet:
   * all of the press that drew it. The strokes before it stay, and wait for the pause again; a
   * press that is down is left to draw on. False when no finished stroke waits.
   */
  dropStroke(board: BoardCtx): boolean;
}

/**
 * Make the presses of one go into ink marks: read them against the board, draw them at once,
 * take each mark's snapshot, and post it. The go is cut into marks and each mark is read from
 * the same points, the ones the pen kept and the live layer drew, at the zoom they were drawn at.
 */
async function commitInk(board: BoardCtx, presses: readonly Pieces[], width: number, zoom: number): Promise<void> {
  if (presses.length === 0) return;
  const rects = board.measure();
  // One go of the pen can hold several marks: a circle on one approach, then a cross on another.
  const items = splitGo(presses, rects, zoom).map((group) => inkItem(board.newId(), group, rects, board.targetBox, width, zoom));
  // However many marks the go became, it is one step for Undo, from the moment the pen rests.
  board.together(items.map((item) => item.id));
  board.showPending(items);
  /** How many of the marks have had their answer: each is drawn as waiting until it has. */
  let answered = 0;
  const settle = (item: InkItem) => {
    board.freeId(item.id);
    board.hidePending(item.id);
  };
  try {
    for (const item of items) {
      const asset = await board.snapshot(item, rects);
      await board.postMark(asset ? { ...item, snapshot: asset } : item);
      settle(item);
      answered += 1;
    }
  } finally {
    // A post that threw ends the go: the mark it was posting and the marks after it are not
    // coming, and none of them stays drawn as if it were.
    for (const item of items.slice(answered)) settle(item);
  }
}

/**
 * The Pen: every press that becomes a drag draws a stroke, and the strokes of one go (drawn
 * with no long pause between them) become ink marks together once the pen has rested. The go
 * is drawn in the live layer until then.
 *
 * A stroke is one list of points that grows in place as the samples arrive, thinned as the log
 * wants them (`drawing` in `ink/stroke.ts`). The live layer is told once for each call to
 * `move`, which is at most once a frame, and draws that stroke the way it will be saved, so
 * nothing shifts when the pen lifts. A lone click draws nothing and makes no mark.
 *
 * A go is made at one zoom: its strokes are drawn at one width and read at one size. A stroke
 * begun at another zoom than the strokes that wait first makes those into their marks, as the
 * pause would have, and begins a go of its own. So no stroke changes once it is drawn.
 *
 * A press is the owner's one stroke, however many pieces it is kept in. The go is held as a list
 * of presses, each the list of its pieces, so a press is read as one stroke, is never cut apart
 * into two marks, and goes whole when Undo takes it or it is cut short. Only the log and the
 * live layer see the pieces, and only the cap on strokes in a mark counts them.
 */
export function penTool(): PenTool {
  /** The finished presses of the go, oldest first, each in the pieces it was kept in. */
  let done: (readonly (readonly Pt[])[])[] = [];
  /** The pieces of the press that is down that are full. Its piece being drawn is `cur`. */
  let filled: (readonly Pt[])[] = [];
  let cur: Drawing | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** The samples of a press that is still a click. They join the stroke once the press is a drag, so it draws from its first point. */
  let held: Pt[] = [];
  /** The camera's zoom when the go began: every stroke of the go is drawn at the width it gives, and read at the size it gives. */
  let zoom = 1;
  /** What was selected when the stroke began: a stroke that is cut short gives it back. */
  let selectedBefore: readonly Id[] = [];

  // A mouse reports a flat 0.5; only a real pen gets real pressure.
  const point = (press: Press, s: Sample): Pt => [s.wx, s.wy, press.device === 'pen' && s.pressure > 0 ? s.pressure : 0.5];

  /** Every piece of the go, in the order drawn: what the live layer shows. */
  const shown = (): readonly (readonly Pt[])[] => [...done.flat(), ...filled, ...(cur ? [cur.pts] : [])];

  /** How many pieces the go holds, finished or full: what the log's cap on strokes in a mark counts. */
  const pieces = () => done.reduce((n, press) => n + press.length, 0) + filled.length;

  const rest = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  /** Wait for the pause, then make the go into marks. Not while a press is down: its lift starts the wait. */
  const wait = (board: BoardCtx) => {
    if (done.length > 0 && !cur) timer = setTimeout(() => void finish(board), PEN_PAUSE);
  };

  /**
   * Make the go into marks now: its finished presses, and the full pieces of a press that is
   * down, which draws on in the go that comes next.
   */
  const finish = async (board: BoardCtx) => {
    rest();
    const presses: Pieces[] = filled.length > 0 ? [...done, filled] : done;
    done = [];
    filled = [];
    board.hand.set({ strokes: shown() });
    await commitInk(board, presses, penWidth(PEN.size, zoom), zoom);
  };

  /**
   * The piece being drawn is full: it ends where it is, and a new piece of the same press
   * carries on with the samples it had no room for (`carriedOn`). No point is let go, so nothing
   * on screen changes. A go that reaches its most pieces this way is made into marks there, as a
   * lift would make it. Gives back what the new piece had no room for.
   */
  const carryOn = (board: BoardCtx, full: Drawing, more: readonly Pt[]): readonly Pt[] => {
    filled.push(full.pts);
    cur = carriedOn(full.pts, zoom);
    const left = cur.add(more);
    board.hand.set({ strokes: shown() });
    if (pieces() >= GO_MAX_STROKES) void finish(board);
    return left;
  };

  return {
    down(press, board) {
      // The pen takes the press at once: the picture under it does not get a click.
      board.capture(press.pointer);
      selectedBefore = board.selection();
      board.select(undefined);
      const z = board.camera.get().z;
      // Strokes that wait from another zoom become their marks first, at their own width and size.
      if (done.length > 0 && z !== zoom) void finish(board);
      rest();
      zoom = z;
      cur = drawing(point(press, press.down), zoom);
      held = [];
      board.hand.set({ strokes: shown(), width: penWidth(PEN.size, zoom) });
      return true;
    },
    move(press, board) {
      if (!cur) return;
      // Every sample the browser collected, not only the last one.
      for (const s of press.samples) held.push(point(press, s));
      // Still a click: nothing shows until the press is a drag, so a click never flashes a dot.
      if (!press.moved) return;
      let left = cur.add(held);
      held = [];
      board.hand.grew(cur.pts);
      while (left.length > 0 && cur) left = carryOn(board, cur, left);
    },
    up(press, board) {
      const stroke = cur;
      cur = null;
      held = [];
      if (stroke && press.moved) {
        // A loop whose ends nearly meet is closed as the pen lifts.
        if (stroke.lift()) board.hand.grew(stroke.pts);
        done.push([...filled, stroke.pts]);
      } else {
        // A lone click makes no mark: it drew nothing, and it adds nothing to the go.
        board.hand.set({ strokes: shown() });
      }
      filled = [];
      if (pieces() >= GO_MAX_STROKES) void finish(board);
      else wait(board);
    },
    cancel(_press, board) {
      // The press that was cut short goes, every piece of it. The finished presses of the go stay, and wait for the pause again.
      rest();
      cur = null;
      held = [];
      filled = [];
      board.hand.set({ strokes: shown() });
      board.select(selectedBefore);
      wait(board);
    },
    open: () => done.length > 0 || cur !== null,
    waiting: () => done.length > 0,
    finish,
    dropStroke(board) {
      // The press that is down, if one is, is not finished: the last finished one goes, whole.
      if (done.length === 0) return false;
      rest();
      done = done.slice(0, -1);
      board.hand.set({ strokes: shown() });
      wait(board);
      return true;
    },
  };
}
