import type {
  Anchor,
  ArrowItem,
  BoardState,
  Box,
  FileItem,
  Id,
  InkItem,
  LassoItem,
  MarkItem,
  PinItem,
  Target,
  VoiceItem,
} from '@keel/protocol';
import { heldLassos, isAnswered, liveItems, liveParts } from '@keel/protocol';
import type { Ties } from './binding';
import { tiesAt } from './binding';
import type { Draft } from './drafts';
import { chapterId, chapterInWork, titleFromText } from './drafts';
import type { InkReading, TargetRect, XY } from './geometry';
import { bboxOf, chooseAnchor, enclosedBy, lassoTargets, readInk, targetAtPoint, thin, toFlat } from './geometry';
import type { Pieces } from './ink/stroke';
import { keep, oneStroke } from './ink/stroke';
import { GO_MAX_STROKES } from './input/constants';

/**
 * The owner's tools, as pure functions: from what the hand did and what is on the board, the
 * mark to post. The app measures the board (`TargetRect`s from the DOM) and says where each
 * target is drawn now (`boxOf`, from the layout), so an anchor's box is the same box the board
 * draws the thing at, and the mark does not jump when it arrives.
 */

/** Where a target is drawn now, in world units. */
export type TargetBox = (t: Target) => Box | undefined;

const r1 = (n: number) => Math.round(n * 10) / 10;
export const roundBox = (b: Box): Box => [r1(b[0]), r1(b[1]), r1(b[2]), r1(b[3])];

/**
 * Points as flat x,y pairs counted from the top-left corner of the mark's box, as the contract
 * counts everything inside a mark. So moving a mark is a change of its box and nothing else.
 */
export function flatFrom(pts: readonly XY[], box: Box): number[] {
  // `+ 0` turns a rounded -0 into 0.
  return toFlat(pts.map((p): XY => [p[0] - box[0], p[1] - box[1]])).map((n) => n + 0);
}

/** The contract's target for a target rect id. */
export function targetOfId(rects: readonly TargetRect[], id: string | undefined): Target | undefined {
  if (!id) return undefined;
  const r = rects.find((t) => t.id === id);
  if (!r) return undefined;
  return r.sub ? { item: r.item, sub: r.sub } : { item: r.item };
}

/** An anchor on a target: the target, and where it is drawn now. */
export function anchorOn(t: Target | undefined, boxOf: TargetBox): Anchor | undefined {
  if (!t) return undefined;
  const box = boxOf(t);
  return box ? { ...t, box: roundBox(box) } : undefined;
}

function withAnchor<T extends object>(item: T, anchor: Anchor | undefined): T & { anchor?: Anchor } {
  return anchor ? { ...item, anchor } : item;
}

/* ------------------------------------------------------------------- ink */

/** The width of the pen in board units: the same on screen at any zoom, within the contract's range. */
export function penWidth(screenPx: number, zoom: number): number {
  return Math.min(24, Math.max(0.5, Math.round((screenPx / zoom) * 10) / 10));
}

/**
 * The presses of one mark, with no more pieces in all than the log takes in a mark: the pieces
 * past that go. The pen never hands over more; this keeps a mark within the contract whatever
 * it is handed.
 */
function withinCap(presses: readonly Pieces[]): Pieces[] {
  const out: Pieces[] = [];
  let room = GO_MAX_STROKES;
  for (const press of presses) {
    const pieces = press.filter((s) => s.length > 0).slice(0, room);
    if (pieces.length === 0) continue;
    out.push(pieces);
    room -= pieces.length;
  }
  return out;
}

/**
 * The ink item for the presses of one mark, as the pen kept them (`ink/stroke.ts`): read for
 * its hint, its targets and its anchor, and counted from its box for the log. Each press is read
 * as the one stroke the hand drew (`oneStroke`), and posted in the pieces it was kept in. The
 * points are posted as they are. The pen thinned them as they came, the go was cut into marks
 * from these same points (`splitGo`), and the live layer drew them the same way, so the mark that
 * arrives is the ink that was under the pointer. `zoom` is the camera's when they were drawn.
 */
export function inkItem(id: Id, drawn: readonly Pieces[], rects: readonly TargetRect[], boxOf: TargetBox, width?: number, zoom = 1): InkItem {
  const presses = withinCap(drawn);
  const reading = readInk(presses.map(oneStroke), rects, zoom);
  const { box, strokes: kept } = keep(presses.flat(), width);
  const targets = reading.targets.map((id) => targetOfId(rects, id)).filter((t): t is Target => !!t);
  const anchor = anchorOn(targetOfId(rects, reading.anchor), boxOf);
  return withAnchor({ id, kind: 'ink' as const, box, strokes: kept, targets, hint: reading.hint }, anchor);
}

/**
 * The presses of one go of the pen, cut into marks that each mean one thing. A press starts a
 * new mark when the mark before it is already a finished circle or cross on something (a pick, a
 * cross-out), or when it points at other things than the mark before it does. Presses on the
 * same thing (the two strokes of a cross) and a free sketch on bare board stay one mark. A press
 * is never cut: its pieces are read as the one stroke the hand drew (`oneStroke`).
 *
 * The presses are read here as each mark is read when it is made, from the same points and at
 * the same `zoom`, so the cut and the marks never disagree about what a stroke is.
 */
export function splitGo(presses: readonly Pieces[], rects: readonly TargetRect[], zoom = 1): Pieces[][] {
  const groups: Pieces[][] = [];
  /** The mark being gathered: its presses, the strokes they read as, and how those read together. */
  let cur: Pieces[] = [];
  let lines: XY[][] = [];
  let read: InkReading | undefined;
  for (const press of presses) {
    const line = oneStroke(press);
    if (line.length === 0) continue;
    const alone = readInk([line], rects, zoom);
    if (read) {
      const before = read;
      const finished = (before.hint === 'circle' || before.hint === 'cross') && before.targets.length > 0;
      const elsewhere = alone.targets.length > 0 && before.targets.length > 0 && !alone.targets.some((t) => before.targets.includes(t));
      if (!finished && !elsewhere) {
        cur.push(press);
        lines.push(line);
        read = readInk(lines, rects, zoom);
        continue;
      }
      groups.push(cur);
    }
    cur = [press];
    lines = [line];
    read = alone;
  }
  if (cur.length > 0) groups.push(cur);
  return groups;
}

/** The region a snapshot of an ink mark shows: the ink and what it points at, with a margin. */
export function snapshotArea(ink: Box, targets: readonly Box[], margin = 24, cap = 2400): Box {
  const all = [ink, ...targets];
  const x0 = Math.min(...all.map((b) => b[0])) - margin;
  const y0 = Math.min(...all.map((b) => b[1])) - margin;
  const x1 = Math.max(...all.map((b) => b[0] + b[2])) + margin;
  const y1 = Math.max(...all.map((b) => b[1] + b[3])) + margin;
  if (x1 - x0 <= cap && y1 - y0 <= cap) return [x0, y0, x1 - x0, y1 - y0];
  return [ink[0] - margin, ink[1] - margin, ink[2] + 2 * margin, ink[3] + 2 * margin];
}

/* ------------------------------------------------------------- box, arrow */

/** A box drawn by dragging from one corner to the other. */
export function boxFromDrag(a: readonly [number, number], b: readonly [number, number]): Box {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])];
}

/** A drawn box: anchored to what it is drawn round, else to what it is drawn on. */
export function boxItem(id: Id, box: Box, rects: readonly TargetRect[], boxOf: TargetBox, text?: string): MarkItem {
  const round = roundBox(box);
  const inside = enclosedBy(round, rects);
  const anchor = anchorOn(targetOfId(rects, chooseAnchor(round, inside, rects)), boxOf);
  const label = text?.trim().slice(0, 200);
  return withAnchor({ id, kind: 'box' as const, box: round, ...(label ? { text: label } : {}) }, anchor);
}

/**
 * The thing an arrow hangs on, from what its two ends hold: the thing it points at, else the
 * thing it starts on; two ends in one picture hang it on the picture. An arrow that holds nothing
 * hangs on nothing.
 */
export function arrowHangsOn(from: Target | undefined, to: Target | undefined): Target | undefined {
  const onePicture = from && to && from.item === to.item && from.sub !== to.sub;
  return onePicture ? { item: to.item } : (to ?? from);
}

/**
 * A drawn arrow. Each end holds on to what it was tied to as it was drawn (`ties`); a mark drawn
 * before the page knew that (a label brought back by a reload) ties its ends to what is under
 * them now, as at 100%. It is anchored to the thing it hangs on (`arrowHangsOn`). Its ends are
 * counted from the top-left corner of its box.
 */
export function arrowItem(
  id: Id,
  from: readonly [number, number],
  to: readonly [number, number],
  rects: readonly TargetRect[],
  boxOf: TargetBox,
  text?: string,
  ties: Ties = tiesAt([r1(from[0]), r1(from[1])], [r1(to[0]), r1(to[1])], rects, boxOf),
): ArrowItem {
  const f: [number, number] = [r1(from[0]), r1(from[1])];
  const t: [number, number] = [r1(to[0]), r1(to[1])];
  const anchorTarget = arrowHangsOn(ties.from?.target, ties.to?.target);
  const label = text?.trim().slice(0, 200);
  const box = roundBox(boxFromDrag(f, t));
  const item: ArrowItem = {
    id,
    kind: 'arrow',
    box,
    from: [r1(f[0] - box[0]), r1(f[1] - box[1])],
    to: [r1(t[0] - box[0]), r1(t[1] - box[1])],
    ...(ties.from ? { fromTarget: ties.from.target, fromTie: ties.from.tie } : {}),
    ...(ties.to ? { toTarget: ties.to.target, toTie: ties.to.tie } : {}),
    ...(label ? { text: label } : {}),
  };
  return withAnchor(item, anchorOn(anchorTarget, boxOf));
}

/* -------------------------------------------------------------------- pin */

/** A pin on the thing under a point: its box is the point, and its own point is the box's corner. Undefined when there is nothing there to pin. */
export function pinItem(id: Id, at: readonly [number, number], rects: readonly TargetRect[], boxOf: TargetBox, text?: string): PinItem | undefined {
  const on = targetOfId(rects, targetAtPoint(at[0], at[1], rects));
  if (!on) return undefined;
  const p: [number, number] = [r1(at[0]), r1(at[1])];
  const words = text?.trim().slice(0, 400);
  return withAnchor({ id, kind: 'pin' as const, box: [p[0], p[1], 0, 0] as Box, at: [0, 0] as [number, number], on, ...(words ? { text: words } : {}) }, anchorOn(on, boxOf));
}

/* ------------------------------------------------------------------ lasso */

/**
 * A lasso: the loop as drawn, and the things mostly inside it. Undefined when it holds
 * nothing. It has no anchor: it is drawn round where its targets are now.
 */
export function lassoItem(id: Id, loop: readonly XY[], rects: readonly TargetRect[]): LassoItem | undefined {
  const pts = thin(loop, 3, 2000);
  if (pts.length < 3) return undefined;
  const targets = lassoTargets(pts, rects)
    .map((t) => targetOfId(rects, t))
    .filter((t): t is Target => !!t)
    .slice(0, 40);
  if (targets.length === 0) return undefined;
  const box = roundBox(bboxOf(pts));
  return { id, kind: 'lasso', box, path: flatFrom(pts, box), targets };
}

/** The items a lasso holds, once each, in order: its picks. */
export function picksOf(lasso: LassoItem): Id[] {
  return [...new Set(lasso.targets.map((t) => t.item))];
}

/** The lassos solidified already, by the owner's `solidify` acts. */
export function solidifiedLassos(state: BoardState): Set<Id> {
  // A lasso a solidify used is answered by it: what `heldLassos` leaves out.
  const held = new Set(heldLassos(state).map((l) => l.id));
  const out = new Set<Id>(liveItems(state).filter((s) => s.item.kind === 'lasso' && !held.has(s.item.id)).map((s) => s.item.id));
  for (const a of Object.values(state.acts)) {
    if (a.event.type === 'solidify' && a.event.lasso) out.add(a.event.lasso);
  }
  return out;
}

/** The lasso Solidify acts on: the selected one if it is open, else the newest open one. */
export function openLasso(state: BoardState, selected?: Id): (LassoItem & { chapter: Id }) | undefined {
  const done = solidifiedLassos(state);
  const open = (id: Id | undefined) => {
    const s = id ? state.items[id] : undefined;
    if (!s || s.removed || s.by !== 'owner' || s.item.kind !== 'lasso' || done.has(s.item.id)) return undefined;
    if (!s.item.targets.some((t) => state.items[t.item] && !state.items[t.item]!.removed)) return undefined;
    return { ...s.item, chapter: s.chapter };
  };
  const sel = open(selected);
  if (sel) return sel;
  for (let i = state.itemOrder.length - 1; i >= 0; i--) {
    const l = open(state.itemOrder[i]);
    if (l) return l;
  }
  return undefined;
}

/**
 * The `solidify` act for a lasso: its items as picks, and the parts it decides. Picks that left
 * the board are left out. The parts are exactly the chapter's ideas as the owner sees them when
 * they press, so a part an agent adds in the same moment is not decided unseen.
 */
export function solidifyDraft(state: BoardState, lasso: LassoItem & { chapter: Id }): Draft {
  const picks = picksOf(lasso).filter((id) => state.items[id] && !state.items[id]!.removed);
  const parts = liveParts(state)
    .filter((p) => p.chapter === lasso.chapter && p.state === 'idea' && !p.external)
    .map((p) => p.id);
  return { type: 'solidify', chapter: lasso.chapter, picks, parts, lasso: lasso.id };
}

/* ------------------------------------------------------------ file, voice */

/** A file the owner dropped in, as a tile at a point. */
export function fileItem(
  id: Id,
  at: readonly [number, number],
  file: { name: string; size: number; type: string },
  asset: string,
  rects: readonly TargetRect[],
  boxOf: TargetBox,
): FileItem {
  const on = targetOfId(rects, targetAtPoint(at[0], at[1], rects));
  const name = file.name.trim().slice(0, 200) || 'file';
  const item: FileItem = {
    id,
    kind: 'file',
    box: [Math.round(at[0]), Math.round(at[1]), 340, 60],
    name,
    asset,
    size: file.size,
    ...(file.type ? { mime: file.type.slice(0, 100) } : {}),
  };
  return withAnchor(item, anchorOn(on, boxOf));
}

/** A remark said out loud, beside the thing the pointer was over. */
export function voiceItem(id: Id, at: readonly [number, number], text: string, on: Target | undefined, boxOf: TargetBox): VoiceItem {
  const words = text.trim().slice(0, 2000);
  const item: VoiceItem = { id, kind: 'voice', box: [Math.round(at[0]) + 16, Math.round(at[1]) + 8, 320, 64], text: words, ...(on ? { on } : {}) };
  return withAnchor(item, anchorOn(on, boxOf));
}

/* ------------------------------------------------------------------ posting */

/**
 * What a new mark sends: the mark, and before it a `chapter.open` when no chapter is in work,
 * titled from the mark's words (a note, a remark, a file name) or "A new idea".
 */
export function markDrafts(state: BoardState, item: MarkItem): Draft[] {
  const out: Draft[] = [];
  let chapter = chapterInWork(state);
  if (!chapter) {
    const words = item.kind === 'note' || item.kind === 'voice' ? item.text : item.kind === 'file' ? item.name.replace(/\.[A-Za-z0-9]+$/, '').replace(/[_-]+/g, ' ') : '';
    const title = words ? titleFromText(words) : 'A new idea';
    chapter = chapterId(title, state);
    out.push({ type: 'chapter.open', chapter, title });
  }
  out.push({ type: 'item.add', chapter, item });
  return out;
}

/** Can the owner move this item? Their own marks (not a lasso: it follows its targets), and any picture. */
export function movable(state: BoardState, id: Id): boolean {
  const s = state.items[id];
  if (!s || s.removed) return false;
  if (s.item.kind === 'picture') return true;
  return s.by === 'owner' && s.item.kind !== 'lasso';
}

/** The items whose marks follow `id` when it moves: marks anchored to it, and to those, in turn. */
export function followers(state: BoardState, id: Id): Id[] {
  const out: Id[] = [];
  const seen = new Set<Id>([id]);
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const x of state.itemOrder) {
      const s = state.items[x];
      if (!s || s.removed || seen.has(x) || s.item.kind === 'picture') continue;
      if (s.item.anchor?.item === cur) {
        seen.add(x);
        out.push(x);
        queue.push(x);
      }
    }
  }
  return out;
}

/** The focus picture on the board for a part or a lane, if the agent has drawn one. */
export function focusFor(state: BoardState, want: { part?: Id; lane?: Id }): Id | undefined {
  for (let i = state.itemOrder.length - 1; i >= 0; i--) {
    const s = state.items[state.itemOrder[i]!];
    if (!s || s.removed || s.item.kind !== 'picture' || s.item.picture.kind !== 'focus') continue;
    const p = s.item.picture;
    if ((want.part !== undefined && p.part === want.part) || (want.lane !== undefined && p.lane === want.lane)) return s.item.id;
  }
  return undefined;
}

/** An `ask` for the same part or lane that the agent has not answered yet. */
export function openAsk(state: BoardState, want: { part?: Id; lane?: Id }): string | undefined {
  for (const a of Object.values(state.acts)) {
    if (a.event.type !== 'ask' || isAnswered(state, a.id)) continue;
    if ((want.part !== undefined && a.event.part === want.part) || (want.lane !== undefined && a.event.lane === want.lane)) return a.id;
  }
  return undefined;
}

/** A file name the board accepts as an asset: "assets/<name>". Same cleaning as the server's. */
export function cleanAssetName(raw: string): string {
  let name = raw.split(/[\\/]/).pop() ?? '';
  name = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/-*\.-*/g, '.')
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[.-]+$/, '');
  if (name.length > 140) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot).slice(0, 12) : '';
    name = `${name.slice(0, 140 - ext.length).replace(/[.-]+$/, '')}${ext}`;
  }
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ? name : 'file';
}
