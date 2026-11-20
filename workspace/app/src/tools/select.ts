import type { ArrowItem, Box, Id } from '@keel/protocol';
import { unionBox, viewOf } from '../camera/camera';
import { laidOut } from '../camera/fit';
import { overlaps } from '../geometry';
import { MIN_NOTE_WIDTH, MIN_RESIZE_BOX, SNAP_DISTANCE } from '../input/constants';
import { CONTROL } from '../input/press';
import type { Where } from '../layout';
import { boxFromDrag } from '../marks';
import type { LetGo } from '../select/arrowEdit';
import { lettingGo } from '../select/arrowEdit';
import type { ArrowGrip } from '../select/arrowGrip';
import { cancelGrip, dropGrip, gripAt, moveGrip } from '../select/arrowGrip';
import type { HandleUnder } from '../select/grab';
import { handleUnder, landsWhereItWas, movableOf, movedBox, resizedBox, rootsOf, storedFor, tiedTo, withFollowers } from '../select/grab';
import { followKeys, pointerNow } from '../select/hand';
import type { Held } from '../select/moving';
import { resized } from '../select/resize';
import type { SnapTargets } from '../select/snap';
import { resizeGuides, snapMove, snapResize, snapTargets } from '../select/snap';
import { panGesture } from './pan';
import type { BoardCtx, Press, Tool } from './types';

/** The Select tool, with one more question the board asks of it. */
export interface SelectTool extends Tool {
  /** True while the open press moves, resizes or selects with a box: the view must not move by itself under it. */
  moving(): boolean;
}

/** A move, once the press has become a drag: what moves, how it is drawn, and what it snaps to. */
interface Dragging {
  /** The things that move themselves, and where each was drawn when the drag began. */
  roots: ReadonlyMap<Id, Box>;
  /** Everything drawn moved: the roots and what hangs on them, less what is drawn again. */
  moved: ReadonlySet<Id>;
  /** The elements moved by a style: the moved things and their read chips. */
  els: HTMLElement[];
  /** The elements of the roots, lifted over the rest while they move. */
  lifted: HTMLElement[];
  /** The elements of what hangs on the roots and of the marks tied to what moves: kept over the lifted roots, as they lie over them at rest. */
  carried: HTMLElement[];
  redraw: ReadonlySet<Id>;
  where: Where;
  /** The box round the roots when the drag began, and what it snaps to. None for a move that does not snap: an arrow by itself. */
  union: Box | undefined;
  targets: SnapTargets;
  /** What the move does to the arrows it moves whole: they let go of what stays behind. */
  letGo: LetGo;
  /** Stop following the camera and the keys. */
  off: () => void;
}

/** What one press of Select is doing. */
type Gesture =
  /** Looking round: a press on the ground, or on a thing that cannot move. A click selects `hit`. */
  | { kind: 'look'; hit: Id | undefined }
  /** Moving what is grabbed. `added` is true when the press put `hit` in the selection. */
  | { kind: 'move'; hit: Id; added: boolean; grabbed: Id[]; drag: Dragging | null }
  /** Resizing one box or note by a handle. */
  | { kind: 'resize'; at: HandleUnder; el: HTMLElement | undefined; start: Box; where: Where; redraw: ReadonlySet<Id>; targets: SnapTargets | null; off: () => void }
  /** Selecting with a box drawn on the ground, from where every thing is drawn when it began. */
  | { kind: 'box'; outlines: ReadonlyMap<Id, Box> | null }
  /** Taking the arrow selected by one of its ends, or by its label. */
  | { kind: 'arrow'; grip: ArrowGrip };

/** Is a thing on the board now? One taken off in the middle of a gesture (from another page of the owner's) is not posted. */
function onBoard(board: BoardCtx, id: Id): boolean {
  const s = board.state().items[id];
  return !!s && !s.removed;
}

/** The snap reach, in world units: `SNAP_DISTANCE` on the screen. */
const reachOf = (board: BoardCtx) => SNAP_DISTANCE / board.camera.get().z;

/** Cmd or Ctrl held turns snapping off. */
const snaps = (press: Press) => !press.mods.meta && !press.mods.ctrl;

/** The boxes of the things in view that a gesture lines up with: all but `leave`. Collected once, when it starts. */
function targetsFor(board: BoardCtx, outlines: ReadonlyMap<Id, Box>, leave: ReadonlySet<Id>): SnapTargets {
  const r = laidOut(board.rect());
  const view = viewOf(board.camera.get(), { w: r.width, h: r.height });
  const boxes: Box[] = [];
  for (const [id, b] of outlines) if (!leave.has(id) && overlaps(b, view)) boxes.push(b);
  return snapTargets(boxes);
}

const NO_GUIDES: Held['guides'] = [];

/** Where a drag puts what it moves: how far, and the guides it snapped to. */
interface Offset {
  dx: number;
  dy: number;
  guides: Held['guides'];
}

/** The read chips under a thing: they move with it. They are drawn in the same layer as it. */
function chipsOf(el: HTMLElement | undefined, id: Id): HTMLElement[] {
  return el?.parentElement ? [...el.parentElement.querySelectorAll<HTMLElement>(`.read-chip[data-mark="${id}"]`)] : [];
}

/**
 * Select: a click selects a thing, Shift and a click adds it or takes it away, a drag moves
 * what is selected, a handle resizes a box or a note, and Shift and a drag on the ground
 * adds what the box drawn holds to what is selected. A plain drag on the ground, or on a thing
 * that cannot move, looks round.
 *
 * A move and a resize are drawn by styles on the elements while the pointer is down, and what
 * is tied to them is drawn from the board's `moving` store; each becomes one change of each
 * thing's box when the pointer lifts. A move is the pointer now less where it went down, both in
 * world units, so the thing stays under the pointer whatever the camera does meanwhile. The
 * rules for a click, Shift and a press on one of several are Excalidraw's (its
 * App.selectionTool.ts, commit 9fbeaed).
 */
export function selectTool(): SelectTool {
  const look = panGesture();
  let gesture: Gesture | null = null;
  /** What was selected when the press went down: a press cut short gives it back. */
  let before: readonly Id[] = [];

  const toggled = (sel: readonly Id[], id: Id) => (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);

  /* ---------------------------------------------------------------- moving */

  const startDrag = (press: Press, board: BoardCtx, grabbed: readonly Id[]): Dragging => {
    board.capture(press.pointer);
    const state = board.state();
    const roots = rootsOf(state, grabbed);
    const hanging = withFollowers(state, roots);
    const redraw = tiedTo(state, hanging);
    const moved = new Set([...hanging].filter((id) => !redraw.has(id)));
    const els: HTMLElement[] = [];
    for (const id of moved) {
      const el = board.itemEl(id);
      if (el) els.push(el, ...chipsOf(el, id));
    }
    const lifted = roots.map((id) => board.itemEl(id)).filter((el): el is HTMLElement => !!el);
    for (const el of lifted) el.classList.add('item--dragging');
    const carried = [...hanging, ...redraw]
      .filter((id) => !roots.includes(id))
      .map((id) => board.itemEl(id))
      .filter((el): el is HTMLElement => !!el);
    for (const el of carried) el.classList.add('item--carried');
    const outlines = board.outlines();
    // An arrow moved by itself lines up with nothing. Its box is only the room its two ends take, and an end let go of a thing would snap back onto that thing's side, as if it still held it.
    const snapping = !(roots.length === 1 && state.items[roots[0]!]?.item.kind === 'arrow');
    const shown = new Map<Id, Box>();
    for (const id of roots) {
      const b = board.boxes().get(id);
      if (b) shown.set(id, b);
    }
    const drag: Dragging = {
      roots: shown,
      moved,
      els,
      lifted,
      carried,
      redraw,
      where: board.where(),
      union: snapping ? unionBox(roots.map((id) => outlines.get(id)).filter((b): b is Box => !!b)) : undefined,
      targets: targetsFor(board, outlines, new Set([...hanging, ...redraw])),
      letGo: lettingGo(board.where(), grabbed, hanging),
      off: () => {},
    };
    const again = () => {
      if (gesture?.kind === 'move' && gesture.drag === drag) moveBy(press, board, drag);
    };
    // A wheel in the middle of the drag moves the world under the pointer: the thing goes with the pointer, not with the world.
    const offCamera = board.camera.onMove(again);
    const offKeys = followKeys(press, again);
    drag.off = () => {
      offCamera();
      offKeys();
    };
    return drag;
  };

  /** Where the drag puts things now: the pointer's way from where it went down, locked to one axis with Shift, snapped unless Cmd or Ctrl is held. */
  const offsetOf = (press: Press, board: BoardCtx, drag: Dragging): Offset => {
    const [wx, wy] = pointerNow(press, board);
    let dx = wx - press.down.wx;
    let dy = wy - press.down.wy;
    if (drag.letGo.holds(dx, dy, board.camera.get().z)) return { dx: 0, dy: 0, guides: NO_GUIDES };
    const lock = press.mods.shift ? (Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y') : undefined;
    if (lock === 'x') dy = 0;
    if (lock === 'y') dx = 0;
    if (!snaps(press) || !drag.union) return { dx, dy, guides: NO_GUIDES };
    const s = snapMove(drag.union, dx, dy, drag.targets, reachOf(board));
    if (!lock) return s;
    // Shift holds the other axis where it is: a snap does not move it off. The guides are those of where it lands.
    return snapMove(drag.union, lock === 'x' ? s.dx : 0, lock === 'y' ? s.dy : 0, drag.targets, 0);
  };

  const storedAfter = (drag: Dragging, dx: number, dy: number): Map<Id, Box> => {
    const out = new Map<Id, Box>();
    for (const [id, b] of drag.roots) out.set(id, storedFor(drag.where, id, [b[0] + dx, b[1] + dy, b[2], b[3]]));
    return out;
  };

  const moveBy = (press: Press, board: BoardCtx, drag: Dragging) => {
    const { dx, dy, guides } = offsetOf(press, board, drag);
    for (const el of drag.els) el.style.translate = `${dx}px ${dy}px`;
    const stored = storedAfter(drag, dx, dy);
    const drawnAs = new Map<Id, ArrowItem>();
    for (const [id, change] of drag.letGo.changes(dx, dy)) {
      stored.set(id, change.item.box);
      drawnAs.set(id, change.item);
    }
    board.moving.set({ moved: drag.moved, dx, dy, stored, redraw: drag.redraw, where: drag.where, guides, drawnAs });
  };

  const putBack = (board: BoardCtx, drag: Dragging) => {
    drag.off();
    for (const el of drag.els) el.style.translate = '';
    for (const el of drag.lifted) el.classList.remove('item--dragging');
    for (const el of drag.carried) el.classList.remove('item--carried');
    board.moving.set(null);
  };

  const drop = (press: Press, board: BoardCtx, drag: Dragging) => {
    const { dx, dy } = offsetOf(press, board, drag);
    putBack(board, drag);
    board.dragEnded();
    // Back where it began: nothing moved, so nothing is posted and Undo gets no step.
    if (dx === 0 && dy === 0) return;
    const moved = new Map<Id, Box>();
    for (const [id, b] of drag.roots) {
      const box = movedBox(drag.where, id, [b[0] + dx, b[1] + dy, b[2], b[3]]);
      // Its place lands on whole units: brought back to within half a unit of where it was, a thing has not moved.
      if (box && !landsWhereItWas(drag.where, id, box) && onBoard(board, id)) moved.set(id, box);
    }
    // Nothing moved: nothing is posted, and no arrow lets go of anything.
    if (moved.size === 0) return;
    // An arrow that let go of what it pointed at changes its ends with its box, whether it moved itself or was carried.
    const letGo = new Map([...drag.letGo.changes(dx, dy)].filter(([id]) => onBoard(board, id)));
    const boxes = new Map([...moved].filter(([id]) => !letGo.has(id)));
    // A drag of several things is one step for Undo.
    board.together([...boxes.keys(), ...letGo.keys()]);
    for (const [id, untied] of letGo) {
      // It is drawn as it was dropped until the board has answered.
      board.setPendingArrow(id, untied.item);
      void board.send({ type: 'item.update', item: id, patch: untied.patch }).then(() => board.setPendingArrow(id, undefined, untied.item));
    }
    for (const [id, box] of boxes) {
      board.setPendingBox(id, box);
      void board.send({ type: 'item.update', item: id, patch: { box } }).then(() => board.setPendingBox(id, undefined, box));
    }
  };

  /* ---------------------------------------------------------------- resizing */

  /** Draw the frame of a box or a note at a box, by its styles. */
  const frameStyle = (el: HTMLElement | undefined, box: Box, widthOnly: boolean) => {
    if (!el) return;
    el.style.left = `${box[0]}px`;
    el.style.top = `${box[1]}px`;
    el.style.width = `${box[2]}px`;
    // A note's height follows its words while it is resized; a box's is its own.
    el.style.minHeight = widthOnly ? '0px' : `${box[3]}px`;
  };

  const resizeTo = (press: Press, board: BoardCtx, g: Extract<Gesture, { kind: 'resize' }>): Box => {
    const [wx, wy] = pointerNow(press, board);
    const rules = { keepRatio: press.mods.shift, fromCentre: press.mods.alt, widthOnly: g.at.widthOnly, min: [g.at.widthOnly ? MIN_NOTE_WIDTH : MIN_RESIZE_BOX, MIN_RESIZE_BOX] as const };
    let dx = wx - press.down.wx;
    let dy = wy - press.down.wy;
    let box = resized(g.start, g.at.handle, dx, dy, rules);
    if (g.targets && snaps(press)) {
      const s = snapResize(box, g.at.handle, g.targets, reachOf(board));
      dx += s.dx;
      dy += s.dy;
      box = resized(g.start, g.at.handle, dx, dy, rules);
    }
    return box;
  };

  const showResize = (press: Press, board: BoardCtx, g: Extract<Gesture, { kind: 'resize' }>) => {
    const box = resizeTo(press, board, g);
    frameStyle(g.el, box, g.at.widthOnly);
    board.moving.set({
      moved: new Set(),
      dx: 0,
      dy: 0,
      stored: new Map([[g.at.id, storedFor(g.where, g.at.id, box)]]),
      redraw: g.redraw,
      where: g.where,
      resize: { id: g.at.id, box, handle: g.at.handle, cursor: g.at.cursor },
      guides: g.targets && snaps(press) ? resizeGuides(box, g.at.handle, g.targets) : NO_GUIDES,
    });
  };

  /** Put the element back as React drew it: React writes a style only when its own value changes. */
  const endResize = (board: BoardCtx, g: Extract<Gesture, { kind: 'resize' }>) => {
    g.off();
    const shown = board.boxes().get(g.at.id);
    if (shown) frameStyle(g.el, shown, false);
    board.moving.set(null);
  };

  /* ---------------------------------------------------------------- the tool */

  return {
    down(press, board) {
      // A press on a button inside a picture is the button's.
      if (press.target?.closest(CONTROL)) return false;
      before = board.selection();
      const handle = handleUnder(board, press.down.x, press.down.y);
      if (handle) {
        gesture = { kind: 'resize', at: handle, el: board.itemEl(handle.id), start: handle.box, where: board.where(), redraw: new Set(), targets: null, off: () => {} };
        return true;
      }
      const grip = gripAt(press, board);
      if (grip) {
        gesture = { kind: 'arrow', grip };
        return true;
      }
      const hit = board.hitAt(press.target, press.down.wx, press.down.wy);
      if (hit && movableOf(board, [hit]).length > 0) {
        // A press on one of several takes them all; on another thing, that thing (with Shift, as well).
        const added = !before.includes(hit);
        const sel = added ? (press.mods.shift ? [...before, hit] : [hit]) : before;
        if (added) board.select(sel);
        gesture = { kind: 'move', hit, added, grabbed: movableOf(board, sel), drag: null };
        return true;
      }
      if (!hit && press.mods.shift) gesture = { kind: 'box', outlines: null };
      else {
        gesture = { kind: 'look', hit };
        look.start(board);
      }
      return true;
    },
    move(press, board) {
      const g = gesture;
      if (!g) return;
      if (g.kind === 'look') {
        look.move(press, board);
        return;
      }
      if (!press.moved) return;
      if (g.kind === 'arrow') {
        moveGrip(press, board, g.grip);
        return;
      }
      if (g.kind === 'move') {
        g.drag ??= startDrag(press, board, g.grabbed);
        moveBy(press, board, g.drag);
        return;
      }
      if (g.kind === 'resize') {
        if (!g.targets) {
          board.capture(press.pointer);
          const state = board.state();
          const hanging = withFollowers(state, [g.at.id]);
          hanging.delete(g.at.id);
          g.redraw = new Set([...hanging, ...tiedTo(state, new Set([g.at.id, ...hanging]))]);
          g.targets = targetsFor(board, board.outlines(), new Set([g.at.id, ...g.redraw]));
          const again = () => {
            if (gesture === g) showResize(press, board, g);
          };
          // A wheel in the middle of the resize moves the world under the pointer: the edge goes with the pointer, not with the world.
          const offCamera = board.camera.onMove(again);
          const offKeys = followKeys(press, again);
          g.off = () => {
            offCamera();
            offKeys();
          };
        }
        showResize(press, board, g);
        return;
      }
      if (!g.outlines) {
        board.capture(press.pointer);
        g.outlines = board.outlines();
      }
      board.moving.set({ moved: new Set(), dx: 0, dy: 0, stored: new Map(), redraw: new Set(), where: board.where(), guides: NO_GUIDES, marquee: boxFromDrag([press.down.wx, press.down.wy], pointerNow(press, board)) });
    },
    up(press, board) {
      const g = gesture;
      gesture = null;
      if (!g) return;
      if (g.kind === 'look') {
        if (press.moved) look.end(press, board);
        else {
          board.camera.hold('none');
          // A click on a thing selects it, with Shift adds it or takes it away; on the ground it selects nothing (Shift there draws a box).
          board.select(g.hit ? (press.mods.shift ? toggled(before, g.hit) : [g.hit]) : []);
        }
        return;
      }
      if (g.kind === 'arrow') {
        dropGrip(press, board, g.grip);
        return;
      }
      if (g.kind === 'move') {
        if (g.drag) drop(press, board, g.drag);
        else if (!press.mods.shift) board.select([g.hit]);
        else if (!g.added) board.select(toggled(before, g.hit));
        return;
      }
      if (g.kind === 'resize') {
        // A press that never became a drag (`targets` waits for one) resizes nothing.
        if (!g.targets) {
          endResize(board, g);
          return;
        }
        // Its size lands on whole units, and what the resize held still stays exactly where it was.
        const box = resizedBox(g.where, g.at.id, g.at.handle, g.start, resizeTo(press, board, g), press.mods.alt);
        // A note is as tall as its words at its new width, as the page has just laid them out; one not laid out keeps its height.
        const tall = g.at.widthOnly ? g.el?.offsetHeight : undefined;
        endResize(board, g);
        // Taken off the board meanwhile, or back at the box it has: nothing is posted, and Undo gets no step.
        // A note's height is not the hand's to change: back at its width, its words lie as they did, whatever the page says they need.
        if (!box || landsWhereItWas(g.where, g.at.id, box) || !onBoard(board, g.at.id)) return;
        const stored: Box = tall ? [box[0], box[1], box[2], tall] : box;
        board.setPendingBox(g.at.id, stored);
        void board.send({ type: 'item.update', item: g.at.id, patch: { box: stored } }).then(() => board.setPendingBox(g.at.id, undefined, stored));
        return;
      }
      board.moving.set(null);
      if (!press.moved || !g.outlines) return;
      const area = boxFromDrag([press.down.wx, press.down.wy], pointerNow(press, board));
      const held = [...g.outlines].filter(([id, b]) => holds(area, b) && !before.includes(id)).map(([id]) => id);
      // Shift adds, here as on a click: what was selected stays, and what the box holds joins it. Excalidraw's rule for a box drawn with Shift (its App.selectionTool.ts).
      board.select([...before, ...held]);
    },
    cancel(_press, board) {
      // A gesture cut short puts back what it changed, and what was selected. A look round stays where it got to: only the hand lets go.
      const g = gesture;
      gesture = null;
      if (g?.kind === 'move' && g.drag) putBack(board, g.drag);
      else if (g?.kind === 'resize') endResize(board, g);
      else if (g?.kind === 'box') board.moving.set(null);
      else if (g?.kind === 'arrow') cancelGrip(board, g.grip);
      board.camera.hold('none');
      board.select(before);
    },
    moving: () => gesture !== null && gesture.kind !== 'look',
  };
}

/** Does `area` hold all of `b`? */
const holds = (area: Box, b: Box) => b[0] >= area[0] && b[1] >= area[1] && b[0] + b[2] <= area[0] + area[2] && b[1] + b[3] <= area[1] + area[3];
