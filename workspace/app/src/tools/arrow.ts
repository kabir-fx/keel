import type { Id } from '@keel/protocol';
import type { TargetBoxNow, TieHit, TieNow } from '../binding';
import { aimOf, drawnEnds, keptBoxes, lockAngle, tieAt, tieOn, tieReach, tieTargets } from '../binding';
import type { TargetRect } from '../geometry';
import { MIN_ARROW } from '../input/constants';
import { cmdHeld, followKeys } from '../select/hand';
import type { BoardCtx, Press, Tool } from './types';

/**
 * The Arrow tool: a drag draws an arrow in the live layer, and lifting the pointer opens the
 * field for what it means. The arrow is posted with its label, not here. An arrow too short to
 * be meant is dropped.
 *
 * Each end ties to the thing it lands on, or stops just short of while the arrow points at it
 * (`tieAt`), and the arrow is drawn as it will be once saved: tied, each end stopped short of the
 * thing it holds by its outline. A tie never turns the arrow: it lies on the line the hand drew.
 * The thing the head would tie to is outlined in the overlay. Shift holds the arrow to steps of
 * 15 degrees; Cmd or Ctrl ties it to nothing. A key pressed or let go changes the arrow at once,
 * with no move of the pointer, so what is drawn is what lands.
 */
export function arrowTool(): Tool {
  let from: [number, number] = [0, 0];
  let to: [number, number] = [0, 0];
  /** What the arrow can tie to, measured once, when the press went down. */
  let rects: TargetRect[] = [];
  /** Where each thing an end has tied to is drawn, read once a thing in a press. */
  let boxOf: TargetBoxNow = () => undefined;
  /** The things the tail could tie to: found where the press went down. */
  let fromHits: TieHit[] = [];
  /** What the tail ties to now: the first of them the arrow leaves, at a spot that follows the way the arrow points. */
  let fromTie: TieNow | undefined;
  /** What the head ties to now. */
  let toTie: TieNow | undefined;
  /** What was selected when the drag began: a drag that is cut short gives it back. */
  let selectedBefore: readonly Id[] = [];
  /** Stop following the keys; set while the press is a drag. */
  let offKeys: (() => void) | undefined;

  /** The arrow as the hand has it now: where its head is, what each end ties to, and how it is drawn. */
  const follow = (press: Press, board: BoardCtx) => {
    const at: [number, number] = [press.at.wx, press.at.wy];
    to = press.mods.shift ? lockAngle(from, at) : at;
    const free = cmdHeld(press);
    fromTie = free ? undefined : tieOn(fromHits, from, to, boxOf);
    toTie = free ? undefined : tieAt(to, from, rects, tieReach(board.camera.get().z), boxOf);
    const [a, b] = drawnEnds(aimOf(from, fromTie), aimOf(to, toTie));
    board.hand.set({ shape: { kind: 'arrow', from: a, to: b } });
    board.hand.highlight.show(toTie?.box);
  };

  const end = (board: BoardCtx) => {
    offKeys?.();
    offKeys = undefined;
    board.hand.highlight.show(undefined);
  };

  return {
    down(press, board) {
      // A drawing tool takes the press at once: the picture under it does not get a click.
      board.capture(press.pointer);
      selectedBefore = board.selection();
      board.select(undefined);
      from = to = [press.down.wx, press.down.wy];
      rects = board.measure();
      boxOf = keptBoxes(board.targetBox);
      fromHits = tieTargets(from, rects, tieReach(board.camera.get().z));
      fromTie = toTie = undefined;
      board.hand.set({ shape: { kind: 'arrow', from, to } });
      return true;
    },
    move(press, board) {
      if (!press.moved) return;
      offKeys ??= followKeys(press, () => follow(press, board));
      follow(press, board);
    },
    up(press, board) {
      if (press.moved) follow(press, board);
      end(board);
      const length = Math.hypot(to[0] - from[0], to[1] - from[1]) * board.camera.get().z;
      if (length < MIN_ARROW) {
        board.hand.set({ shape: undefined });
        return;
      }
      const ties = { ...(fromTie ? { from: fromTie.end } : {}), ...(toTie ? { to: toTie.end } : {}) };
      board.openLabel({ kind: 'arrow', from, to, at: [(from[0] + to[0]) / 2 - 60, (from[1] + to[1]) / 2 - 44], ties });
    },
    cancel(_press, board) {
      end(board);
      board.hand.set({ shape: undefined });
      board.select(selectedBefore);
    },
  };
}
