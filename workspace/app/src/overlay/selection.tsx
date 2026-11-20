import type { BoardState, Box, Id } from '@keel/protocol';
import { useLayoutEffect, useRef } from 'react';
import type { Ends } from '../board/shown';
import { outlineOf } from '../board/measure';
import type { Camera } from '../camera/camera';
import { unionBox } from '../camera/camera';
import { SELECT_LINE, SELECT_PAD } from '../input/constants';
import { gripArrow } from '../select/arrowGrip';
import { resizable } from '../select/grab';
import type { Held } from '../select/moving';
import { movesThings } from '../select/moving';
import type { Handle } from '../select/resize';
import type { BoardCtx } from '../tools/types';
import type { EndName } from './endHandles';
import { EndHandles, placeEnds } from './endHandles';
import { guidePath, Guides } from './guides';
import { Handles, placeHandles } from './handles';
import { HighlightLayer } from './highlight';

/**
 * What is selected, drawn in the overlay: a line one pixel wide, four pixels round each selected
 * thing, the same on screen at any zoom, and a faint box round them all when there are several;
 * the handles of a thing that can be resized, or on the ends of an arrow; the guides a move
 * snapped to; the box being drawn to select with; the thing an arrow's end would tie to. A
 * render draws the elements; the camera and the hand place them, frame by frame, by writing
 * their styles, with no render.
 */

/** The selection as one render of the board has it. */
export interface SelectionProps {
  board: Pick<BoardCtx, 'camera' | 'moving' | 'itemEl' | 'isOwner' | 'state' | 'selection' | 'hand'>;
  selection: readonly Id[];
  state: BoardState;
  boxes: ReadonlyMap<Id, Box>;
  ends: ReadonlyMap<Id, Ends>;
}

/** A box in world units, on the screen. */
const onScreen = ([x, y, w, h]: Box, cam: Camera): Box => [x * cam.z + cam.x, y * cam.z + cam.y, w * cam.z, h * cam.z];
/** A point in world units, on the screen. */
const toScreen = ([x, y]: readonly [number, number], cam: Camera): [number, number] => [x * cam.z + cam.x, y * cam.z + cam.y];

/** How far out from a thing its ring's outer edge is: the gap, and the line. */
const RING_OUT = SELECT_PAD + SELECT_LINE;

/**
 * Put an element round a box on the screen, `out` pixels out from it, on whole pixels; or hide
 * it. This runs on every move of the camera: an element already hidden is not written again.
 */
function placeRound(el: HTMLElement, box: Box | undefined, out: number): void {
  if (!box) {
    if (!el.hidden) el.hidden = true;
    return;
  }
  const left = Math.round(box[0] - out);
  const top = Math.round(box[1] - out);
  el.hidden = false;
  el.style.transform = `translate(${left}px, ${top}px)`;
  el.style.width = `${Math.round(box[0] + box[2] + out) - left}px`;
  el.style.height = `${Math.round(box[1] + box[3] + out) - top}px`;
}

/** Where a selected thing is drawn in this frame of a gesture, in world units, from where it is drawn at rest. */
function heldOutline(id: Id, rest: Box, held: Held | null, redrawn: () => Box | undefined, widthOnly: boolean): Box {
  if (!held) return rest;
  if (held.resize?.id === id) {
    const [x, y, w, h] = held.resize.box;
    return [x, y, w, widthOnly ? rest[3] : h];
  }
  if (held.moved.has(id)) return [rest[0] + held.dx, rest[1] + held.dy, rest[2], rest[3]];
  return redrawn() ?? rest;
}

/** What is selected, its handles, the guides and the box that selects, in the overlay: drawn by a render, placed by the camera and the hand. */
export function SelectionLayer({ board, selection, state, boxes, ends }: SelectionProps) {
  const rings = useRef(new Map<Id, HTMLElement>());
  const all = useRef<HTMLDivElement>(null);
  const marquee = useRef<HTMLDivElement>(null);
  const handles = useRef(new Map<Handle, HTMLElement>());
  const endEls = useRef(new Map<EndName, HTMLElement>());
  const guides = useRef<SVGPathElement | null>(null);
  /** The size each selected thing in a frame is drawn at, as the page last laid it out, in world units. */
  const sizes = useRef(new Map<Id, [number, number]>());

  const many = selection.length > 1;
  const canResize = resizable({ isOwner: board.isOwner, state: () => state, selection: () => selection });
  const resizeId = canResize?.id;
  const widthOnly = canResize?.widthOnly ?? false;
  const arrowId = gripArrow({ isOwner: board.isOwner, state: () => state, selection: () => selection })?.id;

  useLayoutEffect(() => {
    const { camera, moving } = board;
    /** Where each selected thing is drawn at rest, in world units. */
    const rest = (id: Id): Box | undefined => {
      const s = state.items[id];
      const shown = boxes.get(id);
      return s && shown ? outlineOf(s.item, shown, ends.get(id), sizes.current.get(id)) : undefined;
    };
    const place = () => {
      const cam = camera.get();
      const held = moving.get();
      const now = new Map<Id, Box>();
      for (const id of selection) {
        const at = rest(id);
        const s = state.items[id];
        if (!at || !s) continue;
        const redrawn = () => {
          const d = moving.drawn(id);
          return d && outlineOf(s.item, d.shown, d.ends, sizes.current.get(id));
        };
        now.set(id, heldOutline(id, at, held, redrawn, widthOnly));
      }
      if (!held) moving.setOutlines(now);
      for (const [id, el] of rings.current) {
        const b = now.get(id);
        placeRound(el, b && onScreen(b, cam), RING_OUT);
      }
      const union = many ? unionBox([...now.values()]) : undefined;
      if (all.current) placeRound(all.current, union && onScreen(union, cam), RING_OUT);
      // The handles are not there while what is selected moves.
      const one = resizeId && !movesThings(held) ? now.get(resizeId) : undefined;
      placeHandles(handles.current, one && onScreen(one, cam));
      // An arrow's end handles are on its ends as drawn, while an end is dragged too; not while the arrow moves whole.
      const arrowEnds = arrowId && !movesThings(held) ? (moving.drawn(arrowId)?.ends ?? ends.get(arrowId)) : undefined;
      placeEnds(endEls.current, arrowEnds && [toScreen(arrowEnds[0], cam), toScreen(arrowEnds[1], cam)]);
      const d = held ? guidePath(held.guides, cam) : '';
      if (guides.current && guides.current.getAttribute('d') !== d) guides.current.setAttribute('d', d);
      if (marquee.current) placeRound(marquee.current, held?.marquee && onScreen(held.marquee, cam), 0);
    };
    // A thing in a frame is as big as the page lays it out: a picture grows as it builds, a note as its words wrap.
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver((entries) => {
            for (const e of entries) {
              const id = (e.target as HTMLElement).dataset.item;
              const size = e.borderBoxSize[0];
              if (id && size) sizes.current.set(id, [size.inlineSize, size.blockSize]);
            }
            place();
          });
    for (const id of selection) {
      const el = board.itemEl(id);
      if (el) observer?.observe(el);
    }
    const offCamera = camera.onMove(place);
    const offMoving = moving.subscribe(place);
    return () => {
      offCamera();
      offMoving();
      observer?.disconnect();
    };
  }, [board, selection, state, boxes, ends, many, resizeId, widthOnly, arrowId]);

  const keepRing = (id: Id) => (el: HTMLElement | null) => {
    if (el) rings.current.set(id, el);
    else rings.current.delete(id);
  };
  const keepHandle = (corner: Handle, el: HTMLElement | null) => {
    if (el) handles.current.set(corner, el);
    else handles.current.delete(corner);
  };
  const keepEnd = (name: EndName, el: HTMLElement | null) => {
    if (el) endEls.current.set(name, el);
    else endEls.current.delete(name);
  };

  return (
    <div className="selection-layer">
      {selection.map((id) => (
        <div key={id} className="select-ring" data-ring={id} hidden ref={keepRing(id)} />
      ))}
      {many && <div className="select-ring select-ring--all" data-ring-all="" hidden ref={all} />}
      {resizeId && <Handles keep={keepHandle} />}
      {arrowId && <EndHandles keep={keepEnd} />}
      <HighlightLayer highlight={board.hand.highlight} camera={board.camera} />
      <Guides
        path={(el) => {
          guides.current = el;
        }}
      />
      <div className="select-marquee" data-testid="select-marquee" hidden ref={marquee} />
    </div>
  );
}
