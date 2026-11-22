import type { ArrowItem, Box, Id, InkItem, MarkItem } from '@keel/protocol';
import { CameraStore } from '../src/camera/camera';
import type { ToolId } from '../src/chrome';
import type { Draft } from '../src/drafts';
import { FrameLoop } from '../src/frame';
import { CLICK_SLOP } from '../src/input/constants';
import { LiveStore } from '../src/live';
import { MovingStore } from '../src/select/moving';
import type { BoardCtx, Label, Press, Sample, UndoStep } from '../src/tools/types';
import { note, openBoard } from './helpers';

/**
 * A tool tested with no app round it: a board context that writes down what a tool does to it,
 * and presses made by hand. The camera is at rest unless a test moves it, so world units are
 * board pixels.
 */

/** A board with one note of the owner's, `m1`, drawn in a real element. What the tools do to it is written down. */
export function fakeBoard(over: { tool?: ToolId; isOwner?: boolean; spaceHeld?: boolean; editing?: boolean } = {}) {
  const log = openBoard();
  log.must('owner', note('m1', [0, 0, 320, 100]));
  const frames = new FrameLoop();
  const camera = new CameraStore({ x: 0, y: 0, z: 1 }, { loop: frames });
  const hand = new LiveStore();
  const boxes = new Map<Id, Box>([['m1', [0, 0, 320, 100]]]);
  const el = document.createElement('div');
  el.dataset.item = 'm1';
  const did = {
    /** What is selected now, in the order it was selected. */
    selection: ['m1'] as readonly Id[],
    /** The one thing selected, when exactly one is. */
    get selected(): Id | undefined {
      return this.selection.length === 1 ? this.selection[0] : undefined;
    },
    captured: [] as number[],
    /** Each time the dispatcher told the page whether a press is open. */
    pressing: [] as boolean[],
    said: [] as string[],
    sent: [] as Draft[],
    marks: [] as MarkItem[],
    labels: [] as Label[],
    pending: [] as Array<[Id, Box | undefined]>,
    pendingArrows: [] as Array<[Id, ArrowItem | undefined]>,
    /** What is drawn ahead of the log now, kept by the board's own rule: with `only`, a thing is let go only by the very one that was set. */
    ahead: new Map<Id, Box>(),
    arrowsAhead: new Map<Id, ArrowItem>(),
    steps: [] as UndoStep[],
    groups: [] as Array<readonly Id[]>,
    dragEnds: 0,
    ids: 0,
  };
  const board: BoardCtx = {
    isOwner: over.isOwner ?? true,
    camera,
    hand,
    frames,
    moving: new MovingStore(),
    state: () => log.state,
    boxes: () => boxes,
    where: () => ({ state: log.state, boxes: new Map(), subs: new Map() }),
    tool: () => over.tool ?? 'select',
    spaceHeld: () => over.spaceHeld ?? false,
    editing: () => over.editing ?? false,
    selected: () => did.selected,
    selection: () => did.selection,
    rect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    toBoard: (x, y) => [x, y],
    toWorld: (x, y) => {
      const cam = camera.get();
      return [(x - cam.x) / cam.z, (y - cam.y) / cam.z];
    },
    itemEl: (id) => (id === 'm1' ? el : undefined),
    hitAt: (target) => target?.closest<HTMLElement>('[data-item]')?.dataset.item,
    measure: () => [],
    reachable: () => true,
    measureAll: () => [],
    outlines: () => new Map(boxes),
    targetBox: () => undefined,
    noteTarget: () => ({}),
    capture: (pointer) => did.captured.push(pointer),
    showPressing: (open) => did.pressing.push(open),
    select: (what) => {
      did.selection = what === undefined ? [] : typeof what === 'string' ? [what] : [...what];
    },
    say: (text) => did.said.push(text),
    send: async (draft) => {
      did.sent.push(draft);
      return { ok: false, rule: 'offline', reason: 'a test board posts nothing' };
    },
    postMark: async (item) => {
      did.marks.push(item);
      return true;
    },
    postNew: async (_id, drafts) => {
      did.sent.push(...drafts);
      return true;
    },
    newId: () => `new-${++did.ids}`,
    freeId: () => {},
    setPendingBox: (id, box, only) => {
      did.pending.push([id, box]);
      if (box) did.ahead.set(id, box);
      else if (!only || did.ahead.get(id) === only) did.ahead.delete(id);
    },
    setPendingArrow: (id, arrow, only) => {
      did.pendingArrows.push([id, arrow]);
      if (arrow) did.arrowsAhead.set(id, arrow);
      else if (!only || did.arrowsAhead.get(id) === only) did.arrowsAhead.delete(id);
    },
    together: (ids) => did.groups.push(ids),
    notComing: () => {},
    recordStep: (step) => {
      did.steps.push(step);
      return () => {
        const i = did.steps.indexOf(step);
        if (i >= 0) did.steps.splice(i, 1);
      };
    },
    dragEnded: () => {
      did.dragEnds += 1;
    },
    openLabel: (label) => did.labels.push(label),
    openNote: () => {},
    showPending: (_items: readonly InkItem[]) => {},
    hidePending: () => {},
    snapshot: async () => undefined,
  };
  return { board, did, camera, hand, el };
}

export const sampleAt = (x: number, y: number): Sample => ({ x, y, wx: x, wy: y, pressure: 0.5, t: 0 });

/** A press that went down at a board point, with the camera at rest (world units are board pixels). */
export function pressAt(x: number, y: number, over: Partial<Press> = {}): Press {
  const down = sampleAt(x, y);
  return {
    pointer: 7,
    device: 'mouse',
    button: 0,
    target: null,
    down,
    downClient: [x, y],
    at: down,
    client: [x, y],
    mods: { shift: false, alt: false, ctrl: false, meta: false },
    moved: false,
    samples: [],
    ...over,
  };
}

/** Move a press, as the dispatcher would: one sample, and `moved` once it is past the click slop. */
export function moveTo(press: Press, x: number, y: number): Press {
  const at = sampleAt(x, y);
  press.samples = [at];
  press.at = at;
  press.client = [x, y];
  if (Math.hypot(x - press.down.x, y - press.down.y) > CLICK_SLOP) press.moved = true;
  return press;
}
