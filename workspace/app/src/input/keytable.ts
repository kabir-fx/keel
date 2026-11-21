import type { Board } from '../board/context';
import { fitEverything, fitSelection, pageDown, pageUp, zoomIn, zoomOut, zoomToActual } from '../camera/actions';
import type { ToolId, ViewMode } from '../chrome';
import { NOTE_WHERE } from '../tools/note';
import { NUDGE, NUDGE_FAR } from './constants';
import type { KeyPress } from './match';
import { onMac } from './match';

/**
 * The board's keys, as one table: every shortcut is one entry, with the key it is, when it
 * applies and what it does. The one listener in `keys.ts` walks it, and a tooltip or a hint
 * asks it for a key's words, so what the page says about a key is what the key does.
 *
 * A key press is for the one entry that takes it. When two entries would take the same press,
 * neither runs: that is Excalidraw's rule (packages/excalidraw/actions/manager.tsx, commit
 * 9fbeaed), and a unit test fails on any such pair. To add a key, add an entry.
 */

/** Where and when a key is pressed. With the key itself it decides which entry the press is for. */
export interface KeyContext {
  /** The Board, or the Story. */
  readonly mode: ViewMode;
  /** True while the owner types in a field: a key is then a letter for the field. */
  readonly typing: boolean;
  /** True while a press is open on the board. */
  readonly pressOpen: boolean;
  /** True while the Note tool waits for its click. */
  readonly noteWaits: boolean;
  /** True while a button, a link or another control holds the focus the keyboard put on it: Space is the control's then. */
  readonly control: boolean;
  /** True on a Mac. */
  readonly mac: boolean;
}

/** In place of an entry's keys: any typed character. */
export const CHARACTER = 'character';

/** One shortcut. What it leaves out is the common case: on the Board, no modifier held, not while typing. */
export interface KeyEntry {
  /** Its name: what a tooltip or a hint asks for its words by. */
  readonly name: string;
  /** The keys that do it, as `keyOf` names them. The first is the one the page shows. */
  readonly keys: readonly string[] | typeof CHARACTER;
  /** Which of Cmd and Ctrl must be held: `main` is either of them, `ctrl` is Ctrl and not Cmd. Left out: neither. No entry uses Alt. */
  readonly mod?: 'main' | 'ctrl';
  /** Whether Shift must be held. `any`: it does not matter, as for a sign that needs Shift on some keyboards and not on others. Left out: not held. */
  readonly shift?: boolean | 'any';
  /** The Story, for a key that works there. Left out: the Board. */
  readonly mode?: ViewMode;
  /** `any`: also while the owner types in a field. Left out: not while typing. */
  readonly typing?: 'any';
  /** True: only while no press is open on the board. */
  readonly idle?: true;
  /** True: not while a control has the focus by the keyboard. The key is the control's: Space presses a button. */
  readonly notOnControl?: true;
  /** True: only on a Mac. False: only off it. */
  readonly mac?: boolean;
  /** True: the repeats a held key sends do not run it again. */
  readonly once?: true;
  /** True: the browser keeps its own answer to the key as well. */
  readonly passes?: true;
  /** What it does. False means the key was not used after all, and stays the browser's. */
  run(board: Board, press: KeyPress): boolean | void;
  /** What it does when the key comes up again, or when the window loses focus with the key down. */
  up?(board: Board): void;
}

/** A key that takes a tool in hand. It waits while a press is open: the tool must not change under a gesture. */
const tool = <T extends ToolId>(id: T, key: string) => ({ name: `tool.${id}` as const, keys: [key], idle: true, run: (b: Board) => b.setTool(id) }) satisfies KeyEntry;

const armPan = (b: Board) => {
  if (!b.pressOpen()) b.holdSpace(true);
};

/** Which way each arrow key moves what is selected. */
const ARROW_WAY: Readonly<Record<string, readonly [number, number]>> = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] };

/** Move what is selected the way of the arrow key, `step` world units. */
const nudge = (b: Board, press: KeyPress, step: number): boolean => {
  const [dx, dy] = ARROW_WAY[press.key] ?? [0, 0];
  return b.nudge(dx * step, dy * step);
};

const undo = (b: Board) => {
  if (!b.pressOpen()) b.undo();
};

const redo = (b: Board) => {
  if (!b.pressOpen()) b.redo();
};

const remove = (b: Board) => {
  if (!b.pressOpen()) b.removeSelected();
};

const solidify = (b: Board) => {
  if (!b.pressOpen()) b.solidify();
};

export const KEY_TABLE = [
  tool('select', 's'),
  tool('pan', 'h'),
  tool('pen', 'p'),
  tool('box', 'b'),
  tool('arrow', 'a'),
  tool('note', 'n'),
  tool('pin', 'i'),
  tool('lasso', 'l'),
  tool('eraser', 'e'),
  // Space is the board's: it never scrolls the page. A button the owner reached with the keyboard
  // is the one exception, since Space is how a keyboard presses it; on a button clicked with the
  // pointer Space pans. It arms a pan only while no press is open: the press under way keeps its
  // own tool.
  { name: 'pan.hold', keys: [' '], notOnControl: true, run: armPan, up: (b) => b.holdSpace(false) },
  // Undo and Redo wait while a press is open, and the key is still taken: the browser must not
  // undo in some field instead.
  { name: 'undo', keys: ['z'], mod: 'main', run: undo },
  { name: 'redo', keys: ['z'], mod: 'main', shift: true, run: redo },
  { name: 'redo.y', keys: ['y'], mod: 'ctrl', mac: false, run: redo },
  // Delete and Solidify wait the same way: what a press holds is not taken off the board, or
  // made into a picture, under the hand.
  { name: 'remove', keys: ['Delete', 'Backspace'], run: remove },
  { name: 'solidify', keys: ['s'], shift: true, run: solidify },
  // A selected walk plays with the arrow keys. Else they move what is selected by one unit, and
  // with Shift by five. With nothing selected that can move, the keys stay the browser's. They
  // wait while a press is open: what a drag or a resize holds is the pointer's, and a run of
  // presses begun under it would put the thing back where it was once the keys rested.
  { name: 'walk.on', keys: ['ArrowRight', 'ArrowDown'], idle: true, run: (b, p) => b.stepWalk(1) || nudge(b, p, NUDGE) },
  { name: 'walk.back', keys: ['ArrowLeft', 'ArrowUp'], idle: true, run: (b, p) => b.stepWalk(-1) || nudge(b, p, NUDGE) },
  { name: 'nudge.far', keys: ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'], shift: true, idle: true, run: (b, p) => nudge(b, p, NUDGE_FAR) },
  {
    name: 'escape',
    keys: ['Escape'],
    // Esc during a press belongs to the press (`usePressEndings` takes it back), so this runs
    // only with no press open, and once however long the key is held.
    idle: true,
    once: true,
    passes: true,
    run: (b) => {
      // A drop that hangs over the board goes first. Else Esc leaves the focus view and puts the tools back.
      if (b.endDrop()) return;
      b.closeFocus();
      b.select(undefined);
      b.setTool('select');
    },
  },
  // The tools belong to the Board: in the Story only Esc does something, it goes back.
  { name: 'story.leave', keys: ['Escape'], mode: 'story', run: (b) => b.setMode('board') },
  { name: 'drop', keys: ['d'], once: true, run: (b) => b.openPicker() },
  { name: 'talk', keys: ['t'], once: true, run: (b) => b.startTalk(), up: (b) => b.stopTalk() },
  { name: 'zoom.in', keys: ['+', '='], shift: 'any', run: zoomIn },
  { name: 'zoom.out', keys: ['-', '_'], shift: 'any', run: zoomOut },
  { name: 'zoom.actual', keys: ['0'], shift: 'any', run: zoomToActual },
  { name: 'fit.all', keys: ['1'], shift: 'any', run: fitEverything },
  { name: 'fit.selection', keys: ['2'], shift: 'any', run: fitSelection },
  // With Cmd or Ctrl these are the browser's zoom keys. The board takes them wherever the
  // owner is, also in a note and on a panel, so the page itself is never zoomed.
  { name: 'zoom.in.main', keys: ['+', '='], mod: 'main', shift: 'any', typing: 'any', run: zoomIn },
  { name: 'zoom.out.main', keys: ['-', '_'], mod: 'main', shift: 'any', typing: 'any', run: zoomOut },
  { name: 'zoom.actual.main', keys: ['0'], mod: 'main', shift: 'any', typing: 'any', run: zoomToActual },
  // In the Story they do nothing, and are still taken: a page zoomed in the Story would stay
  // zoomed on the Board, where Cmd+0 sets the board's zoom and not the page's.
  { name: 'story.zoom', keys: ['+', '=', '-', '_', '0'], mod: 'main', shift: 'any', typing: 'any', mode: 'story', run: () => {} },
  { name: 'page.up', keys: ['PageUp'], run: pageUp },
  { name: 'page.down', keys: ['PageDown'], run: pageDown },
  // The Note tool waits for its click: a character typed now is the start of a note, not a
  // tool's key. Say where to click instead of changing the tool under the owner.
  { name: 'note.where', keys: CHARACTER, shift: 'any', run: (b) => b.say(NOTE_WHERE) },
] as const satisfies readonly KeyEntry[];

/** The name of a shortcut in the table. */
export type KeyName = (typeof KEY_TABLE)[number]['name'];

/** Every key the table names: what `keyOf` reads by what it types, on any keyboard. */
export const KNOWN_KEYS: ReadonlySet<string> = new Set(KEY_TABLE.flatMap((entry: KeyEntry) => (entry.keys === CHARACTER ? [] : entry.keys)));

/** A typed character: a letter, a digit or a sign. Space is not one here: on the board it types nothing. */
const isCharacter = (key: string) => key.length === 1 && key !== ' ';

/** Is this press, pressed here and now, for this entry? */
export function applies(entry: KeyEntry, press: KeyPress, ctx: KeyContext): boolean {
  if ((entry.mode ?? 'board') !== ctx.mode) return false;
  if (ctx.typing && entry.typing !== 'any') return false;
  if (ctx.pressOpen && entry.idle) return false;
  if (ctx.control && entry.notOnControl) return false;
  if (entry.mac !== undefined && entry.mac !== ctx.mac) return false;
  if (press.alt) return false;
  const main = press.ctrl || press.meta;
  if (entry.mod === 'main' ? !main : entry.mod === 'ctrl' ? !press.ctrl || press.meta : main) return false;
  if (entry.shift !== 'any' && press.shift !== (entry.shift ?? false)) return false;
  // While the Note tool waits, a typed character belongs to the one entry that says where to click.
  const startsNote = ctx.noteWaits && !main && isCharacter(press.key);
  if (entry.keys === CHARACTER) return startsNote;
  return !startsNote && entry.keys.includes(press.key);
}

/** The one entry a key press is for. When two would take it, neither does: a key never means two things. */
export function entryFor(press: KeyPress, ctx: KeyContext, table: readonly KeyEntry[] = KEY_TABLE): KeyEntry | undefined {
  const found = table.filter((entry) => applies(entry, press, ctx));
  return found.length === 1 ? found[0] : undefined;
}

const BY_NAME: ReadonlyMap<string, KeyEntry> = new Map(KEY_TABLE.map((entry) => [entry.name, entry]));

/** How a key is written where the keycap's own word is not what `keyOf` calls it. */
const KEYCAPS: Readonly<Record<string, string>> = {
  ' ': 'Space',
  Escape: 'Esc',
  ArrowRight: 'Right arrow',
  ArrowLeft: 'Left arrow',
  ArrowUp: 'Up arrow',
  ArrowDown: 'Down arrow',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
};

/**
 * The keys of a shortcut, as the owner's keyboard writes them: "Cmd+Z" on a Mac and "Ctrl+Z"
 * elsewhere, "Shift+S", "T". For where the words round it already say how the key is used.
 */
export function keyCaps(name: KeyName, mac: boolean = onMac()): string {
  const entry = BY_NAME.get(name);
  if (!entry || entry.keys === CHARACTER) return '';
  const key = entry.keys[0] ?? '';
  const mod = entry.mod === 'main' ? (mac ? 'Cmd' : 'Ctrl') : entry.mod === 'ctrl' ? 'Ctrl' : undefined;
  return [mod, entry.shift === true ? 'Shift' : undefined, KEYCAPS[key] ?? (key.length === 1 ? key.toUpperCase() : key)].filter(Boolean).join('+');
}

/**
 * The words for a shortcut: its keys, and "hold" before a key the owner holds ("hold T"). Every
 * tooltip and hint takes a key's words from here, or its keys from `keyCaps`.
 */
export function keyWords(name: KeyName, mac: boolean = onMac()): string {
  const caps = keyCaps(name, mac);
  // A key with something to do when it comes up is one the owner holds.
  return caps && BY_NAME.get(name)?.up ? `hold ${caps}` : caps;
}
