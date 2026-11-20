import type { ToolId } from '../chrome';
import type { Sample } from '../tools/types';
import { CLICK_SLOP, CONTROL_SLOP } from './constants';

/**
 * The rules of a press, as plain logic: which buttons start one, when one is held back for the
 * control it landed on, and how its samples wait for the tool. Nothing here listens to the page
 * or changes it; `pointers.ts` is the part that does.
 */

/** A control inside an item (a button, a link, a field): a press on it is for it first, not for the board. */
export const CONTROL = 'button, a, input, textarea, select, [role="button"]';

/**
 * Did the press land on a control inside an item (a button in a picture)? A picture's buttons
 * work with any tool in hand: a drawing tool holds such a press back, and Note and Pin leave a
 * click on one alone.
 */
export const onControl = (target: Element | null): boolean => !!target?.closest(CONTROL)?.closest('[data-item]');

/**
 * Does this button start a press? The main button and the middle one do. The right button
 * starts nothing, and on a Mac neither does the main button with Ctrl held: there that is a
 * right-click.
 */
export function startsPress(button: number, ctrl: boolean, mac: boolean): boolean {
  if (button === 1) return true;
  return button === 0 && !(mac && ctrl);
}

/** The tools that draw. With one in hand a press takes what is under it at once, so a press on a control waits first. */
const DRAWS: ReadonlySet<ToolId> = new Set(['pen', 'box', 'arrow', 'lasso']);

/** What decides whether a press is held back. */
export interface Landing {
  /** The tool in hand. */
  readonly tool: ToolId;
  /** True when this page may mark the board: in any other hand a drawing tool is Select. */
  readonly isOwner: boolean;
  readonly button: number;
  /** Space held makes the press a pan, whatever the tool. */
  readonly spaceHeld: boolean;
  /** True when the press landed on a control inside an item. */
  readonly onControl: boolean;
}

/**
 * Is this press held back? With a drawing tool in the owner's hand, a press of the main button
 * on a control inside an item is: the owner may mean the control. Select leaves a control alone
 * by itself, a pan takes nothing from it, and with Note and Pin a click is the tool's.
 */
export function holdsBack(l: Landing): boolean {
  return l.onControl && l.isOwner && l.button === 0 && !l.spaceHeld && DRAWS.has(l.tool);
}

/**
 * Where a press is.
 *
 * - `held`: held back on a control. The tool has not been told, and the control gets the click
 *   if the pointer lifts now.
 * - `open`: the tool has the press.
 */
export type Stage = 'held' | 'open';

/**
 * The samples of one press on their way to its tool. They are collected as the pointer reports
 * them and handed over together, once a frame, so none is lost and none is handed over twice.
 */
export interface Following {
  stage(): Stage;
  /** True once a sample has been further from where the press went down than the click slop. It never goes back to false. */
  moved(): boolean;
  /**
   * Samples came, oldest first. They wait here for the tool. A held-back press becomes the
   * tool's with the first sample that is further than the control slop from where it went
   * down; the samples from before still wait, so the tool can draw from the first point.
   * Answers where the press is now.
   */
  add(samples: readonly Sample[]): Stage;
  /** Every sample that waits, oldest first; none wait after. A held-back press hands over nothing. */
  take(): readonly Sample[];
}

const further = (down: Sample, s: Sample, slop: number) => Math.hypot(s.x - down.x, s.y - down.y) > slop;

/** Follow a press from where it went down. `held` says it starts held back on a control. */
export function follow(down: Sample, held: boolean): Following {
  let stage: Stage = held ? 'held' : 'open';
  let moved = false;
  let waiting: Sample[] = [];

  return {
    stage: () => stage,
    moved: () => moved,
    add(samples) {
      for (const s of samples) {
        waiting.push(s);
        if (!moved && further(down, s, CLICK_SLOP)) moved = true;
        if (stage === 'held' && further(down, s, CONTROL_SLOP)) stage = 'open';
      }
      return stage;
    },
    take() {
      if (stage === 'held') return [];
      const out = waiting;
      waiting = [];
      return out;
    },
  };
}
