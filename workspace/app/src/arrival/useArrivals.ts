import type { BoardState, Box, Id, Item } from '@keel/protocol';
import type { RefObject } from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { CameraStore } from '../camera/camera';
import { screenToWorld } from '../camera/camera';
import { onReducedMotion } from '../camera/motion';
import type { Fit } from '../camera/fit';
import type { ViewMode } from '../chrome';
import type { FrameLoop } from '../frame';
import type { Edge } from '../lineage';
import { motionPlays } from '../motion/plays';
import type { Point } from '../motion/path';
import { SEEN_SHARE, shownShare } from '../notices';
import type { AgentCursorStore } from '../overlay/cursorStore';
import type { ReadChipAt } from '../reads';
import type { Connection } from '../source';
import type { Cue, Moment } from './cues';
import { looking, readCues } from './cues';
import type { Animate, ArrivalStage } from './player';
import { ArrivalPlayer } from './player';

/** What the arrivals need of the board. */
export interface ArrivalNeeds {
  frames: FrameLoop;
  camera: CameraStore;
  cursor: AgentCursorStore;
  state: BoardState;
  boxes: ReadonlyMap<Id, Box>;
  /** The placeholders at a spot of this page's own, not placed in the log. */
  spots: ReadonlyMap<Id, Box>;
  /** The read chips on the board. */
  chips: readonly ReadChipAt[];
  connection: Connection;
  /** The lineage arrows as drawn: the primary one into a picture is the arrow it arrives along. */
  edges: readonly Edge[];
  fit: Pick<Fit, 'roomKept'>;
  /** The pictures on the board when it first opened; null until the first view is fitted. */
  known: RefObject<Set<Id> | null>;
  mode: ViewMode;
  /** True while the focus view is open: nothing is drawn on there. */
  focusOpen: boolean;
  /** The board's element: a press on it can land what is drawn on. */
  board: RefObject<HTMLElement | null>;
  /** The element the items are drawn in. */
  layer: RefObject<HTMLElement | null>;
  /** The element the camera moves: the lineage arrows are in it. */
  world: RefObject<HTMLElement | null>;
  /** Told when an arrival is over, played out or landed, with its picture's or its read's id. */
  ended?: (id: string) => void;
  /** A test's stand-in for `element.animate`. */
  animate?: Animate;
}

/** What the board does with the arrivals. */
export interface Arrivals {
  /** True while this picture or read is being drawn on, waits its turn, or is held out of sight. */
  has(id: string): boolean;
  /** Land everything at once: before the board is measured or turned into an image. */
  landAll(): void;
  /** The pictures and reads held out of sight now, waiting to be drawn on: the minimap leaves them out. */
  held: ReadonlySet<string>;
}

/**
 * What the agent does drawn on the board as it arrives (`arrival/`): a picture placed, a
 * placeholder finished, a picture redrawn, a read chip written in. Read the cues of each commit
 * in which the state or the boxes changed, before the page is painted, and play what may play.
 *
 * Declared after `useNews` in `App`, so where the camera is going is already set when it asks
 * whether a picture will be in view, and a reveal begun in the same commit holds the wave until
 * the camera stops.
 *
 * Nothing plays, and nothing is made or set on the page, when motion does not play (reduced
 * motion, or no Web Animations), when the page is hidden, outside the board, in the focus view,
 * or for what will not be in view. What plays lands at once when the owner presses on it (or on
 * the mark a chip hangs under), moves, resizes or removes it, when the agent changes it, when its
 * arrow is routed anew, when the page is hidden, the board left or the focus view opened, and
 * when the board goes.
 */
export function useArrivals(n: ArrivalNeeds): Arrivals {
  const { frames, camera, cursor, state, boxes, spots, chips, connection, known, mode, focusOpen, board } = n;
  /** The latest needs, for what the player asks as it plays. */
  const needs = useRef(n);
  needs.current = n;

  /** The page as the arrivals read it, from the latest render. */
  const stage = useMemo<ArrivalStage>(
    () => ({
      item: (id) => {
        const el = needs.current.layer.current?.querySelector<HTMLElement>(`[data-item="${id}"]`);
        const box = needs.current.boxes.get(id);
        return el && box ? { el, box } : undefined;
      },
      arrow: (id) => {
        const edge = needs.current.edges.find((e) => e.to === id && e.primary);
        const path = edge && needs.current.world.current?.querySelector(`[data-lineage="${edge.from}>${edge.to}"]`);
        return path instanceof SVGPathElement ? path : undefined;
      },
      chip: (id) => needs.current.layer.current?.querySelector<HTMLElement>(`[data-read="${id}"]`) ?? undefined,
      boxOf: (el) => {
        const r = el.getBoundingClientRect();
        const origin = needs.current.board.current?.getBoundingClientRect();
        const cam = camera.get();
        const [x, y] = screenToWorld(cam, r.left - (origin?.left ?? 0), r.top - (origin?.top ?? 0));
        return [x, y, r.width / cam.z, r.height / cam.z];
      },
      zoom: () => camera.goal().z,
      drawn: () => camera.get().z,
      settled: () => !camera.gliding(),
      entry: (to: Point) => cursor.entryFor(to) ?? cursor.entryFor(to, camera.goal()),
    }),
    [camera, cursor],
  );
  const player = useMemo(
    () => new ArrivalPlayer({ frames, cursor, stage, animate: needs.current.animate, ended: (id) => needs.current.ended?.(id) }),
    [frames, cursor, stage],
  );
  useEffect(() => () => player.dispose(), [player]);

  /** The board at the last commit the cues were read at, and what was looked at since. */
  const before = useRef<Moment | null>(null);
  const looked = useRef(looking());
  /** What each played, waiting or held thing was drawn from, and where, when it started: a change to either lands it. */
  const started = useRef(new Map<string, { drawn: unknown; box: Box | undefined }>());
  const chipIds = useMemo(() => new Set(chips.map((c) => c.id)), [chips]);

  useLayoutEffect(() => {
    /** What a picture or a chip is drawn from now, and where; none when it is gone. */
    const nowOf = (id: string): { drawn: unknown; box: Box | undefined } | undefined => {
      const chip = chips.find((c) => c.id === id);
      if (chip) return { drawn: chip, box: undefined };
      const s = state.items[id];
      return s && !s.removed ? { drawn: drawnFrom(s.item), box: boxes.get(id) } : undefined;
    };

    // What plays, waits or is held lands when it changed under it: moved, resized, redrawn or
    // removed. Before the cues are played: a redraw of what plays lands it, then plays.
    for (const id of player.ids()) {
      const [was, is] = [started.current.get(id), nowOf(id)];
      if (!was || !is || is.drawn !== was.drawn || is.box !== was.box) player.land(id);
    }
    for (const id of started.current.keys()) if (!player.has(id)) started.current.delete(id);

    const cues = readCues(before.current, { state, boxes, spots, chips: chipIds, connection }, known.current, looked.current);
    before.current = { state, boxes, spots, chips: chipIds, connection };
    if (cues.length === 0 || !mayPlay(needs.current.mode, needs.current.focusOpen)) return;
    const cam = camera.goal();
    const room = needs.current.fit.roomKept();
    const wave: Cue[] = [];
    for (const cue of cues) {
      const box = cue.kind === 'read' ? chipBox(cue.id) : boxes.get(cue.id);
      // What will not be in view simply is there, and the news says so.
      if (!box || shownShare(box, cam, room) < SEEN_SHARE) continue;
      started.current.set(cue.id, nowOf(cue.id)!);
      wave.push(cue);
    }
    player.play(wave);

    /** Where a chip is drawn, in board units; on a page with no layout, the point it hangs from. */
    function chipBox(id: string): Box | undefined {
      const el = stage.chip(id);
      const at = chips.find((c) => c.id === id)?.at;
      const box = el ? stage.boxOf(el) : undefined;
      return box && box[2] > 0 ? box : at && [at[0], at[1], 0, 0];
    }
  }, [state, boxes, spots, chipIds, chips, connection, known, camera, stage, player]);

  // Outside the board, or in the focus view, nothing is drawn on.
  useEffect(() => {
    if (!mayPlay(mode, focusOpen)) player.landAll();
  }, [mode, focusOpen, player]);

  // A page nobody looks at plays nothing: what plays lands as the page is hidden.
  useEffect(() => {
    const hidden = () => {
      if (document.hidden) player.landAll();
    };
    document.addEventListener('visibilitychange', hidden);
    return () => document.removeEventListener('visibilitychange', hidden);
  }, [player]);

  // Reduced motion asked for while the board is open: nothing plays from then on, and what
  // plays or waits lands.
  useEffect(() => onReducedMotion(() => player.landAll()), [player]);

  // A press on a picture that is being drawn on, or waits its turn, lands it before the press does what it always does.
  useEffect(() => {
    const el = board.current;
    if (!el) return;
    const down = (e: PointerEvent) => {
      const id = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-item]')?.dataset.item : undefined;
      if (id && player.has(id)) player.land(id);
      // A chip takes no press: a press on it, or on the mark it hangs under, lands it.
      for (const key of player.ids()) {
        const cue = player.cueOf(key);
        if (cue?.kind !== 'read') continue;
        const chip = stage.chip(key);
        const r = chip?.getBoundingClientRect();
        const on = !!r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        if (on || (id !== undefined && chip?.dataset.mark === id)) player.land(key);
      }
    };
    el.addEventListener('pointerdown', down, true);
    return () => el.removeEventListener('pointerdown', down, true);
  }, [board, player, stage]);

  const held = useSyncExternalStore(player.subscribe, player.held);
  return useMemo(() => ({ has: player.has, landAll: player.landAll, held }), [player, held]);
}

/**
 * What a picture is drawn from: its spec. The agent's update changes it; a placement or a move
 * does not.
 */
const drawnFrom = (item: Item): unknown => (item.kind === 'picture' ? item.picture : item);

/** True when the board may draw a picture on: motion plays, the page is seen, the board is in board mode and no focus view is open. */
function mayPlay(mode: ViewMode, focusOpen: boolean): boolean {
  return mode === 'board' && !focusOpen && motionPlays() && !(typeof document !== 'undefined' && document.hidden);
}
