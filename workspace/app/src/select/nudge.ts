import type { Box, Id } from '@keel/protocol';
import { NUDGE_REST_MS } from '../input/constants';
import type { Where } from '../layout';
import type { BoardCtx } from '../tools/types';
import { walkOf } from '../walk';
import { leftBehind } from './arrowEdit';
import { landsWhereItWas, movableOf, movedBox, rootsOf, theOne, withFollowers } from './grab';

/** Moving what is selected with the arrow keys. */
export interface Nudger {
  /** Move what is selected by `dx`, `dy` world units. False when nothing selected can move. */
  nudge(dx: number, dy: number): boolean;
  /** Post the run of presses that waits for the keys to rest, now: before anything else changes the board. */
  flush(): void;
}

/** One run of presses: what it moves, where each was drawn when it began, and how far it has gone. */
interface Run {
  ids: readonly Id[];
  from: ReadonlyMap<Id, Box>;
  where: Where;
  dx: number;
  dy: number;
  /**
   * The box each thing is drawn at ahead of the log, as the last press left it: what the run
   * posts. The page lets go of a box drawn ahead only when handed the very one it holds, so the
   * run keeps it.
   */
  ahead: Map<Id, Box>;
  /** Posts the run once the keys rest. */
  timer?: ReturnType<typeof setTimeout>;
}

type NudgeBoard = Pick<BoardCtx, 'isOwner' | 'state' | 'selection' | 'boxes' | 'where' | 'setPendingBox' | 'together' | 'send'>;

/**
 * The arrow keys move what is selected. Each press shows at once, ahead of the log; the run is
 * posted when the keys have rested for `NUDGE_REST_MS`, as one change of each thing's box and
 * one step for Undo, however many presses it had. A run ends early when what is selected
 * changes, and whenever the board asks (`flush`): before a press, Undo or Delete. A run that
 * ends where it began posts nothing. A walk selected alone is never moved by the keys: its
 * arrow keys are for its steps. Nor is an arrow that holds a thing which stays: it would move
 * and show nothing, so it holds on, and goes only where what it holds goes. Excalidraw's rule
 * for the keys (its App.tsx, commit 9fbeaed).
 */
export function createNudge(board: NudgeBoard): Nudger {
  let run: Run | null = null;

  const boxOf = (r: Run, id: Id): Box | undefined => {
    const b = r.from.get(id);
    return b && movedBox(r.where, id, [b[0] + r.dx, b[1] + r.dy, b[2], b[3]]);
  };

  const flush = () => {
    const r = run;
    if (!r) return;
    run = null;
    clearTimeout(r.timer);
    // Back where it began: nothing moved, so nothing is posted and Undo gets no step.
    const still = r.dx === 0 && r.dy === 0;
    const boxes = new Map<Id, Box>();
    for (const [id, box] of r.ahead) {
      const s = board.state().items[id];
      if (!still && s && !s.removed && !landsWhereItWas(r.where, id, box)) boxes.set(id, box);
      // What is not posted (it did not move, or it left the board meanwhile) is drawn where the log has it.
      else board.setPendingBox(id, undefined, box);
    }
    board.together([...boxes.keys()]);
    // Once the board has answered, the thing is drawn from the log again: an Undo, or a move from elsewhere, shows.
    for (const [id, box] of boxes) void board.send({ type: 'item.update', item: id, patch: { box } }).finally(() => board.setPendingBox(id, undefined, box));
  };

  return {
    nudge(dx, dy) {
      const state = board.state();
      if (walkOf(state, theOne(board.selection()))) return false;
      const roots = rootsOf(state, movableOf(board, board.selection()));
      const moving = withFollowers(state, roots);
      const ids = roots.filter((id) => {
        const it = state.items[id]?.item;
        return it?.kind !== 'arrow' || leftBehind(state, it, moving).length === 0;
      });
      if (ids.length === 0) return false;
      if (run && (run.ids.length !== ids.length || run.ids.some((id, i) => id !== ids[i]))) flush();
      if (!run) {
        const from = new Map<Id, Box>();
        for (const id of ids) {
          const b = board.boxes().get(id);
          if (b) from.set(id, b);
        }
        run = { ids, from, where: board.where(), dx: 0, dy: 0, ahead: new Map() };
      }
      const r = run;
      r.dx += dx;
      r.dy += dy;
      clearTimeout(r.timer);
      r.timer = setTimeout(flush, NUDGE_REST_MS);
      for (const id of ids) {
        const box = boxOf(r, id);
        if (!box) continue;
        r.ahead.set(id, box);
        board.setPendingBox(id, box);
      }
      return true;
    },
    flush,
  };
}
