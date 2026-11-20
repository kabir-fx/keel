import type { ArrowEnd, ArrowItem, BoardEvent, BoardState, Id, Item, ItemPatch, ItemState } from '@keel/protocol';
import { emptyState, isMark, reduce } from '@keel/protocol';
import type { Draft } from './drafts';
import { STEP_WAIT_MS } from './input/constants';
import { keyWords } from './input/keytable';
import { plainRefusal } from './refusal';
import type { PostResult } from './source';
import type { PenTool } from './tools/pen';
import type { BoardCtx, UndoStep } from './tools/types';

/**
 * Undo and Redo: the owner's steps on this page, as a list.
 *
 * A step is one whole gesture: a mark added, things taken off, a move, a change of words. The
 * log tells this module about every event it posts for the owner (`StepRecorder`), so no tool
 * has to remember to. Undo appends the opposite event to the log (take off, put back, change
 * back), and Redo goes the other way. The list lives on this page and starts empty.
 *
 * Four rules keep Undo from taking back the wrong thing:
 *
 * - A step has its place in the list from the moment its gesture ends, before the board has
 *   answered. Undo waits for a step that is still on its way: it never takes back the one before.
 *   A gesture that posts several events, or posts after a while, says so first (`together`).
 * - What a step replaced is the thing as it will be once every earlier event on it has landed:
 *   a second move made before the first is answered goes back to the first move's place.
 * - Before a step is taken back, what it wrote must still be what the board holds. A thing the
 *   agent or another tab has changed since is left as it is, and the board says so; the rest of
 *   the step is taken back. Undo writes only what the step wrote, so nothing anyone else changed
 *   is written over.
 * - Undo and Redo run one at a time, in the order they were asked for.
 *
 * One gesture is one step, and a new step empties the redo list: those are Excalidraw's rules
 * (packages/excalidraw/history.ts, commit 9fbeaed). Its store is not taken: here a step is
 * events on the log.
 */

/* ------------------------------------------------------------ what a step did */

/**
 * One thing a step did to the board.
 *
 * - `on`: it put a thing on the board (a mark added, a thing put back). `item` is the thing then.
 * - `off`: it took a thing off. `item` is the thing as it was.
 * - `change`: it changed a thing. `was` and `now` are the thing before and after, `patch` is
 *   the change as the board admitted it, and `back` is the change that puts back what it
 *   replaced, when the board has a way to say that.
 */
type Part =
  | { did: 'on'; id: Id; item: Item }
  | { did: 'off'; id: Id; item: Item }
  | { did: 'change'; id: Id; patch: ItemPatch; back: ItemPatch | undefined; was: Item; now: Item };

const isObject = (v: unknown): v is Readonly<Record<string, unknown>> => typeof v === 'object' && v !== null;

/** Equal by value. A field that is missing equals one that is not set. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!isObject(a) || !isObject(b) || Array.isArray(a) !== Array.isArray(b)) return false;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) if (!same(a[key], b[key])) return false;
  return true;
}

/**
 * A field of an item, as the board means it. No label and an empty one are the same thing, and
 * so are an arrow's label with no place and one in the middle: a change back can only write the
 * second of each pair.
 */
function held(item: Item, field: string): unknown {
  const value = (item as Readonly<Record<string, unknown>>)[field];
  if (field === 'text' && value === '') return undefined;
  if (field === 'labelAt' && value === 0.5) return undefined;
  return value;
}

const sameFields = (a: Item, b: Item, fields: Iterable<string>): boolean => {
  for (const field of fields) if (!same(held(a, field), held(b, field))) return false;
  return true;
};

const sameItem = (a: Item, b: Item): boolean => sameFields(a, b, new Set([...Object.keys(a), ...Object.keys(b)]));

/** The fields of an item that each key of a change writes. */
const WRITES: Readonly<Record<keyof ItemPatch, readonly string[]>> = {
  box: ['box'],
  rot: ['rot'],
  text: ['text'],
  labelAt: ['labelAt'],
  arrowFrom: ['from', 'fromTarget', 'fromTie'],
  arrowTo: ['to', 'toTarget', 'toTie'],
  anchor: ['anchor'],
  picture: ['picture'],
  status: ['status'],
  answers: ['answers'],
  from: ['from'],
};

const keysOf = (patch: ItemPatch) => (Object.keys(patch) as Array<keyof ItemPatch>).filter((key) => patch[key] !== undefined);

/** Every field of an item a change writes. */
const written = (patch: ItemPatch): string[] => keysOf(patch).flatMap((key) => WRITES[key]);

/** One end of an arrow as it is, in the shape a change sets it again. */
function endOf(arrow: ArrowItem, which: 'from' | 'to'): ArrowEnd {
  const target = which === 'from' ? arrow.fromTarget : arrow.toTarget;
  const tie = which === 'from' ? arrow.fromTie : arrow.toTie;
  return { at: arrow[which], ...(target ? { target } : {}), ...(tie ? { tie } : {}) };
}

/**
 * The change that puts back what `patch` replaced on `was`. Nothing when the board has no way
 * to say it: a thing that had no place before cannot be given none again, and what only the
 * agent may write is not the owner's to put back.
 */
function patchBack(patch: ItemPatch, was: Item): ItemPatch | undefined {
  const back: ItemPatch = {};
  for (const key of keysOf(patch)) {
    if (key === 'box' && was.box) back.box = was.box;
    else if (key === 'rot' && was.kind !== 'picture' && was.rot !== undefined) back.rot = was.rot;
    else if (key === 'text' && (was.kind === 'note' || was.kind === 'voice' || was.kind === 'box' || was.kind === 'arrow' || was.kind === 'pin')) back.text = was.text ?? '';
    else if (key === 'labelAt' && was.kind === 'arrow') back.labelAt = was.labelAt ?? 0.5;
    else if (key === 'arrowFrom' && was.kind === 'arrow') back.arrowFrom = endOf(was, 'from');
    else if (key === 'arrowTo' && was.kind === 'arrow') back.arrowTo = endOf(was, 'to');
    else if (key === 'anchor' && was.kind === 'arrow') back.anchor = was.anchor ?? null;
    else return undefined;
  }
  return back;
}

/** An event that can be part of a step: it adds, changes, takes off or puts back one thing. */
type ThingDraft = Extract<Draft, { type: 'item.add' | 'item.update' | 'item.remove' | 'item.restore' }>;

/** Does this event, once the board has taken it, make a step? Placing a picture, solidify, "Build this", a choice and an ask do not. */
const makesStep = (draft: Draft): draft is ThingDraft =>
  draft.type === 'item.add' ? isMark(draft.item) : draft.type === 'item.update' || draft.type === 'item.remove' || draft.type === 'item.restore';

/** The thing an event of a step is on. */
const thingOf = (draft: ThingDraft): Id => (draft.type === 'item.add' ? draft.item.id : draft.item);

/** One thing alone on a board, for the reducer. */
const alone = (id: Id, s: ItemState | undefined): BoardState => ({ ...emptyState(), items: s ? { [id]: s } : {}, itemOrder: s ? [id] : [] });

/** What an admitted event makes of one thing, worked out by the board's own reducer. */
const applied = (id: Id, s: ItemState | undefined, event: BoardEvent): ItemState | undefined => reduce(alone(id, s), event).items[id];

/**
 * What an admitted event did to its thing. `before` is the thing as the owner saw it when the
 * gesture ended (see `Flight`): what a change replaced is read from there, and what it wrote is
 * worked out by the board's own reducer, so the two never depend on what else arrived in between.
 */
function partOf(event: BoardEvent, before: ItemState | undefined): Part | undefined {
  if (event.type === 'item.add') return { did: 'on', id: event.item.id, item: event.item };
  if (event.type !== 'item.update' && event.type !== 'item.remove' && event.type !== 'item.restore') return undefined;
  const id = event.item;
  if (!before) return undefined;
  if (event.type === 'item.remove') return { did: 'off', id, item: before.item };
  if (event.type === 'item.restore') return { did: 'on', id, item: before.item };
  const now = applied(id, before, event)?.item ?? before.item;
  return { did: 'change', id, patch: event.patch, back: patchBack(event.patch, before.item), was: before.item, now };
}

/* ------------------------------------------------------------ what is on its way */

/**
 * One event on its way to the log, on one thing: the owner's, or one Undo or Redo posts.
 *
 * The thing as the event found it is the board as it was when the event left, with every
 * earlier event on the same thing that was still on its way then played over it, as the board
 * admitted it. So a second move made before the first is answered replaced the first move's
 * place, not the place before it. An event ahead that the board refused changed nothing.
 */
interface Flight {
  readonly id: Id;
  /** The thing as the board held it when this event left. */
  readonly found: ItemState | undefined;
  /** The events on the same thing that were on their way when this one left, oldest first. */
  readonly ahead: readonly Flight[];
  /** The event as the board admitted it, once it has. */
  admitted?: BoardEvent;
}

/** The thing as an event found it: see `Flight`. */
const foundBy = (flight: Flight): ItemState | undefined =>
  flight.ahead.reduce((s, ahead) => (ahead.admitted ? applied(flight.id, s, ahead.admitted) : s), flight.found);

/** Is the thing still as this part of a step left it? */
function asLeft(part: Part, state: BoardState): boolean {
  const s = state.items[part.id];
  if (!s) return false;
  if (part.did === 'off') return s.removed;
  if (s.removed) return false;
  return part.did === 'on' ? sameItem(s.item, part.item) : sameFields(s.item, part.now, written(part.patch));
}

/** Is the thing still as taking this part of a step back left it? */
function asTakenBack(part: Part, state: BoardState): boolean {
  const s = state.items[part.id];
  if (!s) return false;
  if (part.did === 'on') return s.removed;
  if (s.removed) return false;
  return part.did === 'off' ? sameItem(s.item, part.item) : sameFields(s.item, part.was, written(part.patch));
}

/** The event that takes a part of a step back, or nothing when the board has no way to say it. */
function undoing(part: Part): Draft | undefined {
  if (part.did === 'on') return { type: 'item.remove', item: part.id };
  if (part.did === 'off') return { type: 'item.restore', item: part.id };
  return part.back ? { type: 'item.update', item: part.id, patch: part.back } : undefined;
}

/** The event that does a part of a step again. */
function redoing(part: Part): Draft {
  if (part.did === 'on') return { type: 'item.restore', item: part.id };
  if (part.did === 'off') return { type: 'item.remove', item: part.id };
  return { type: 'item.update', item: part.id, patch: part.patch };
}

/* ------------------------------------------------------------ a step, and its words */

/** One step of the owner's, in its place in the list. */
interface Step {
  /** What it did to the board, in the order it did it. */
  parts: Part[];
  /** A step recorded by hand, which knows its own way back. */
  byHand?: UndoStep;
  /** How many of its events are on their way to the log. */
  flying: number;
  /** The things whose next event is part of it, and has not left yet. */
  coming: Set<Id>;
  /** Called once nothing of it is on its way any more. */
  onLanded: Array<() => void>;
}

const newStep = (parts: Part[] = []): Step => ({ parts, flying: 0, coming: new Set(), onLanded: [] });

/** True once everything of a step has reached the board, or never will. */
const landed = (step: Step): boolean => step.flying === 0 && step.coming.size === 0;

const NOUN: Readonly<Record<Item['kind'], string>> = {
  note: 'note',
  ink: 'ink',
  box: 'box',
  arrow: 'arrow',
  pin: 'pin',
  lasso: 'lasso',
  file: 'file',
  voice: 'remark',
  picture: 'picture',
};

/** The marks the owner draws; the others are added. */
const DRAWN: ReadonlySet<Item['kind']> = new Set(['ink', 'box', 'arrow', 'lasso']);

const kindOf = (part: Part): Item['kind'] => (part.did === 'change' ? part.was.kind : part.item.kind);

/** What the owner did to a thing, said from their side: "drew", "took off", "moved". */
function verbOf(parts: readonly Part[]): string | undefined {
  if (parts.every((part) => part.did === 'on')) return parts.every((part) => DRAWN.has(kindOf(part))) ? 'drew' : 'added';
  if (parts.every((part) => part.did === 'off')) return 'took off';
  if (!parts.every((part) => part.did === 'change')) return undefined;
  return parts.every((part) => part.did === 'change' && written(part.patch).every((field) => field === 'box')) ? 'moved' : 'changed';
}

/** Parts of a step in a few words, for a line to the owner: "the note you moved", "the 3 things you took off". */
function nameOfParts(parts: readonly Part[]): string {
  const [first] = parts;
  const verb = verbOf(parts);
  if (!first || !verb) return 'your last step';
  if (parts.length === 1) return `the ${NOUN[kindOf(first)]} you ${verb}`;
  return `the ${parts.length} ${first.did === 'on' ? 'marks' : 'things'} you ${verb}`;
}

/** A step in a few words, for a line to the owner. */
const nameOf = (step: Step): string => step.byHand?.what ?? nameOfParts(step.parts);

type Way = 'undo' | 'redo';

const WORD: Readonly<Record<Way, string>> = { undo: 'Undo', redo: 'Redo' };

/* ------------------------------------------------------------ the list */

/**
 * What the log tells Undo about the events it posts for the owner. This is the one place steps
 * are recorded.
 */
export interface StepRecorder {
  /**
   * The page is about to post this for the owner. `state` is the board as it is now. If the
   * event makes a step, it is part of the step that waits for it (`together`), or else a step
   * of its own, which takes its place in the list at once. The answer is what to call with the
   * board's reply, or with nothing when no reply will come. Nothing comes back for an event
   * that makes no step.
   */
  begin(draft: Draft, state: BoardState): ((result: PostResult | undefined) => void) | undefined;
  /**
   * One gesture is about to post on these things: the next event the owner posts on each of
   * them (an add, a change or a take-off) is part of one step, which takes its place in the list
   * now. The marks of one go of the pen, a drag of three things, Delete with three selected.
   * Undo waits for the step until each of its events has come, or `notComing` says it will not.
   * A thing an earlier gesture still waits for stays with that gesture.
   */
  together(ids: readonly Id[]): void;
  /** The event on this thing that a gesture said was coming will not be posted. */
  notComing(id: Id): void;
}

/** Undo, Redo and Delete on one board. */
export interface Undo {
  /**
   * Take back the owner's last step. Inside a go of the pen that is not a mark yet, that is its
   * last stroke.
   */
  undo(): void;
  /** Do again the step Undo last took back. */
  redo(): void;
  /** Delete: the board is the owner's, so anything selected comes off, an agent's picture too. Undo puts it back. */
  removeSelected(): void;
  /**
   * Record a step the log does not show (a note closed with Esc), with its own way back. It
   * becomes the newest step. The answer takes it out of the list again, wherever it is by then.
   */
  record(step: UndoStep): () => void;
  /** What the log calls: see `StepRecorder`. */
  steps: StepRecorder;
}

/**
 * One board's Undo. `post` is how Undo and Redo themselves post: straight to the board, with no
 * step recorded for it, and with nothing said, because Undo says its own line. It is not the
 * board's `send`, which would record Undo's own events as new steps and empty the redo list.
 */
export function createUndo(board: BoardCtx, pen: Pick<PenTool, 'dropStroke'>, post: (draft: Draft) => Promise<PostResult>): Undo {
  /** The steps that are done, oldest first. */
  const done: Step[] = [];
  /** The steps Undo took back, the last one taken back last. */
  const undone: Step[] = [];
  /** Counts the new steps: an Undo that finishes after a new step was made must not fill the redo list again. */
  let made = 0;
  /** The Undos and Redos that wait their turn. */
  const asked: Array<() => void | Promise<void>> = [];
  let busy = false;
  /** The events on their way to the log, by the thing they are on, oldest first. */
  const onItsWay = new Map<Id, Flight[]>();

  const remove = (list: Step[], step: Step) => {
    const i = list.indexOf(step);
    if (i >= 0) list.splice(i, 1);
  };

  /**
   * An event on this thing leaves now. The answer is what to call once the board has answered
   * it, with the event as admitted (nothing when it was not): it gives back the thing as the
   * event found it.
   */
  const leave = (id: Id, state: BoardState) => {
    const ahead = onItsWay.get(id) ?? [];
    const flight: Flight = { id, found: state.items[id], ahead: [...ahead] };
    onItsWay.set(id, [...ahead, flight]);
    return (admitted: BoardEvent | undefined): ItemState | undefined => {
      if (admitted) flight.admitted = admitted;
      const still = (onItsWay.get(id) ?? []).filter((f) => f !== flight);
      if (still.length > 0) onItsWay.set(id, still);
      else onItsWay.delete(id);
      return foundBy(flight);
    };
  };

  /** Post one of Undo's or Redo's own events, on the way like any other (see `Flight`). */
  const postOwn = async (id: Id, draft: Draft): Promise<PostResult> => {
    const answered = leave(id, board.state());
    let result: PostResult | undefined;
    try {
      result = await post(draft);
      return result;
    } finally {
      answered(result?.ok ? result.event : undefined);
    }
  };

  /** The step that waits for the next event on this thing: the first gesture that said so has it. */
  const waitingFor = (id: Id): Step | undefined => done.find((s) => s.coming.has(id));

  /** A new step was made: there is nothing to redo any more. */
  const stepMade = () => {
    made += 1;
    undone.length = 0;
  };

  /**
   * A step takes its place, as the newest. An Undo or a Redo that still waits its turn was
   * asked for before this step: it must not take it back, so it is dropped.
   */
  const place = (step: Step): Step => {
    done.push(step);
    asked.length = 0;
    return step;
  };

  /** Something of a step arrived. Once all of it has, whoever waits for it goes on; a step that left nothing on the board is no step. */
  const arrive = (step: Step) => {
    if (!landed(step)) return;
    if (step.parts.length === 0 && !step.byHand) remove(done, step);
    for (const go of step.onLanded.splice(0)) go();
  };

  /** Resolves once a step has landed. Nothing when it has already. */
  const landing = (step: Step, way: Way): Promise<void> | undefined => {
    if (landed(step)) return undefined;
    return new Promise<void>((resolve) => {
      // An event that was to come and never does must not hold Undo up for good. What comes
      // later is a step of its own.
      const giveUp = setTimeout(() => {
        step.coming.clear();
        board.say(
          step.parts.length > 0
            ? `${WORD[way]} stopped waiting for the rest of ${nameOf(step)}: it has not reached the board.`
            : `${WORD[way]} stopped waiting: your last step has not reached the board.`,
        );
        arrive(step);
      }, STEP_WAIT_MS);
      step.onLanded.push(() => {
        clearTimeout(giveUp);
        resolve();
      });
    });
  };

  /**
   * Post a step's events the other way (Undo) or once more (Redo), one at a time. A refusal
   * stops it. What was posted has crossed to the other list; the rest stays where it was, less
   * the event the board refused for good.
   */
  const replay = async (step: Step, way: Way, moves: ReadonlyArray<{ part: Part; draft: Draft }>): Promise<void> => {
    const name = nameOf(step);
    const at = made;
    // A step that is redone is done again from now: one made while its events are on their way comes after it.
    if (way === 'redo') {
      remove(undone, step);
      done.push(step);
    }
    let crossed = 0;
    let refusal: Extract<PostResult, { ok: false }> | undefined;
    for (const { part, draft } of moves) {
      if (draft.type === 'item.remove' && board.selection().includes(part.id)) board.select(board.selection().filter((id) => id !== part.id));
      const r = await postOwn(part.id, draft);
      if (!r.ok) {
        refusal = r;
        break;
      }
      crossed += 1;
    }
    /** Parts as the step did them: Undo went through them backwards. */
    const inOrder = (parts: Part[]) => (way === 'undo' ? parts.reverse() : parts);
    const gone = inOrder(moves.slice(0, crossed).map((m) => m.part));
    // What the board would not save now (it is not connected) can be tried again; what it refused for good cannot.
    const stay = inOrder(moves.slice(refusal && refusal.rule !== 'offline' ? crossed + 1 : crossed).map((m) => m.part));
    const [stillDone, takenBack] = way === 'undo' ? [stay, gone] : [gone, stay];
    // A new step made meanwhile has emptied the redo list: nothing goes back on it.
    const redoable = takenBack.length > 0 && made === at;
    if (stillDone.length > 0) {
      step.parts = stillDone;
      if (redoable) undone.push(newStep(takenBack));
    } else {
      remove(done, step);
      step.parts = takenBack;
      if (redoable) undone.push(step);
    }
    if (!refusal) return;
    board.say(refusal.rule === 'offline' ? `Not ${way === 'undo' ? 'undone' : 'redone'}: ${refusal.reason}` : `${WORD[way]} skipped ${name}: ${plainRefusal(refusal)}`);
  };

  /**
   * Take a step of the log's back, or do it again, thing by thing. A thing that is no longer as
   * the step left it, or that the board has no way to put back, is left as it is and leaves the
   * step, and the board says so in one line; the rest of the step crosses.
   */
  const cross = (step: Step, way: Way): void | Promise<void> => {
    const state = board.state();
    const holds = way === 'undo' ? asLeft : asTakenBack;
    const changed: Part[] = [];
    const noWay: Part[] = [];
    const moves: Array<{ part: Part; draft: Draft }> = [];
    for (const part of way === 'undo' ? [...step.parts].reverse() : step.parts) {
      const draft = way === 'undo' ? undoing(part) : redoing(part);
      if (!holds(part, state)) changed.push(part);
      else if (!draft) noWay.push(part);
      else moves.push({ part, draft });
    }
    if (changed.length > 0) board.say(`${WORD[way]} skipped ${nameOfParts(changed)}: it has changed since.`);
    if (noWay.length > 0) board.say(`Undo cannot take back ${nameOfParts(noWay)}.`);
    if (moves.length === 0) {
      remove(way === 'undo' ? done : undone, step);
      return;
    }
    const kept = moves.map((m) => m.part);
    step.parts = way === 'undo' ? kept.reverse() : kept;
    return replay(step, way, moves);
  };

  /** Take a step recorded by hand back, or do it again, its own way. */
  const crossByHand = (step: Step, hand: UndoStep, way: Way): void | Promise<void> => {
    const at = made;
    if (way === 'redo') {
      remove(undone, step);
      done.push(step);
    }
    const after = (ok: boolean) => {
      if (way === 'redo') {
        if (ok) return;
        remove(done, step);
        board.say(`Redo could not take ${hand.what} away again.`);
        return;
      }
      remove(done, step);
      if (!ok) board.say(`Undo could not bring back ${hand.what}.`);
      else if (hand.redo && made === at) undone.push(step);
    };
    const answer = way === 'undo' ? hand.undo() : (hand.redo?.() ?? false);
    return typeof answer === 'boolean' ? after(answer) : answer.then(after);
  };

  const undoNow = (): void | Promise<void> => {
    const step = done.at(-1);
    if (!step) {
      board.say('There is nothing to undo.');
      return;
    }
    const takeBack = () => {
      // It never reached the board (the board refused it, and said so): there is nothing to take back.
      if (!done.includes(step)) return;
      return step.byHand ? crossByHand(step, step.byHand, 'undo') : cross(step, 'undo');
    };
    const wait = landing(step, 'undo');
    return wait ? wait.then(takeBack) : takeBack();
  };

  const redoNow = (): void | Promise<void> => {
    // A step still on its way is newer than anything Undo took back: once it lands, there is nothing to redo.
    const flying = done.find((s) => !landed(s));
    const wait = flying && landing(flying, 'redo');
    if (wait) return wait.then(redoNow);
    const step = undone.at(-1);
    if (!step) {
      board.say('There is nothing to redo.');
      return;
    }
    return step.byHand ? crossByHand(step, step.byHand, 'redo') : cross(step, 'redo');
  };

  /** Run what was asked for, one at a time. One that needs no waiting runs at once, in the turn it was asked in. */
  const run = () => {
    while (!busy) {
      const job = asked.shift();
      if (!job) return;
      const going = job();
      if (!going) continue;
      busy = true;
      void going.finally(() => {
        busy = false;
        run();
      });
    }
  };

  const ask = (job: () => void | Promise<void>) => {
    asked.push(job);
    run();
  };

  return {
    undo() {
      // A go of the pen is not a step yet: Undo inside it takes back its last stroke.
      if (pen.dropStroke(board)) return;
      ask(undoNow);
    },
    redo() {
      ask(redoNow);
    },
    removeSelected() {
      const state = board.state();
      const ids = board.selection().filter((id) => state.items[id] && !state.items[id]!.removed);
      board.select(undefined);
      if (ids.length === 0) return;
      // Several things taken off at once are one step: one Undo puts them all back.
      board.together(ids);
      const pictures = ids.filter((id) => state.items[id]!.item.kind === 'picture');
      void Promise.all(ids.map((id) => board.send({ type: 'item.remove', item: id }))).then((rs) => {
        if (rs.some((r, i) => r.ok && pictures.includes(ids[i]!))) board.say(`Taken off the board. Undo (${keyWords('undo')}) puts it back.`);
      });
    },
    record(hand) {
      const step = place({ ...newStep(), byHand: hand });
      stepMade();
      return () => {
        remove(done, step);
        remove(undone, step);
      };
    },
    steps: {
      begin(draft, state) {
        if (!makesStep(draft)) return undefined;
        // An event a gesture said was coming is part of that gesture's step. Any other is a step of its own.
        const id = thingOf(draft);
        const step = waitingFor(id) ?? place(newStep());
        step.coming.delete(id);
        step.flying += 1;
        const answered = leave(id, state);
        return (result) => {
          step.flying -= 1;
          const event = result?.ok ? result.event : undefined;
          const found = answered(event);
          const part = event ? partOf(event, found) : undefined;
          if (part) {
            if (step.parts.length === 0) stepMade();
            step.parts.push(part);
          }
          arrive(step);
        };
      },
      together(ids) {
        const fresh = [...new Set(ids)].filter((id) => !waitingFor(id));
        if (fresh.length === 0) return;
        place(newStep()).coming = new Set(fresh);
      },
      notComing(id) {
        for (const step of [...done]) if (step.coming.delete(id)) arrive(step);
      },
    },
  };
}
