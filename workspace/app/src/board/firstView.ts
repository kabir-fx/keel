import type { BoardState, Box, Id, ItemState, Presence } from '@keel/protocol';
import { currentChapter } from '@keel/protocol';
import type { RefObject } from 'react';
import { useEffect, useLayoutEffect } from 'react';
import { cursorPoint } from '../overlay/cursorPlace';
import type { CameraStore } from '../camera/camera';
import { fitBox, unionBox } from '../camera/camera';
import type { ViewMode } from '../chrome';
import { PILL_NOTE_MAX } from '../chrome';
import type { BoxOf } from '../place';
import type { BoardSource, Connection } from '../source';
import { readView, viewKey, writeView } from '../view';

/** How long the camera must rest before where the owner looks is written down, in ms. */
const KEEP_AFTER = 250;

/** What the first view needs of the render it runs in. */
export interface FirstViewNeeds {
  camera: CameraStore;
  state: BoardState;
  presence: Presence;
  connection: Connection;
  viewport: { w: number; h: number };
  fontsReady: boolean;
  /** Pictures that still wait for a place. */
  waiting: readonly Id[];
  /** True once the things marks hang on are measured and have not moved. */
  subsSettled: RefObject<boolean>;
  live: readonly ItemState[];
  boxes: ReadonlyMap<Id, Box>;
  boxOf: BoxOf;
  /** Fit the first view to these items. */
  show: readonly Id[] | undefined;
  /** A focus picture to open the focus view on. */
  firstFocus: Id | undefined;
  /** Come back to where the owner looked on this board, if this page kept it. */
  remember: boolean;
  mode: ViewMode;
  setMode(mode: ViewMode): void;
  room(): Box;
  fitTo(ids?: readonly Id[], extra?: readonly Box[]): void;
  openFocusView(id: Id, fit?: readonly Id[]): void;
  pinView(chapter: Id | undefined): void;
  /** Set true here, once: the first view is fitted. */
  fitted: RefObject<boolean>;
  /** Set here, once: the pictures on the board when it first opened. Only later ones are news. */
  known: RefObject<Set<Id> | null>;
}

/**
 * The first view: fit the items named by the checkpoint, or the whole board, once every picture
 * has a place and the things marks hang on are measured, so a mark on a sub is fitted where it
 * is drawn.
 */
export function useFirstView(p: FirstViewNeeds): void {
  useLayoutEffect(() => {
    const { camera, state, presence, boxes, live, show } = p;
    if (p.fitted.current || !p.fontsReady || p.connection !== 'open' || p.waiting.length > 0 || !p.subsSettled.current) return;
    p.fitted.current = true;
    p.known.current = new Set(live.filter((s) => s.item.kind === 'picture').map((s) => s.item.id));
    if (p.firstFocus && boxes.get(p.firstFocus) && state.items[p.firstFocus]?.item.kind === 'picture') {
      // Esc goes back to the whole board.
      const all = unionBox([...boxes.values()]);
      if (all) camera.set(fitBox(all, p.room(), 1));
      p.openFocusView(p.firstFocus, show);
      // The first view arrives as the board opens: it does not glide in.
      camera.land();
      return;
    }
    // Back where the owner was on this board, as they left it.
    const kept = p.remember ? readView(viewKey(state.name)) : undefined;
    if (kept && !show?.length) {
      camera.set(kept.camera);
      if (kept.mode !== p.mode) p.setMode(kept.mode);
      if (kept.chapter && state.chapters[kept.chapter]) p.pinView(kept.chapter);
      return;
    }
    // The agent is part of the first view: its cursor, and what it says beside it.
    const at = cursorPoint(presence, p.boxOf);
    const long = !!presence.note && presence.note.length > PILL_NOTE_MAX;
    const agent: Box[] = at ? [[at[0], at[1], long ? 340 : 80, long ? 150 : 40]] : [];
    // With nothing kept, the first view is the chapter in work, not the whole board.
    const work = currentChapter(state);
    const own = !show?.length && p.remember && work ? live.filter((s) => s.chapter === work).map((s) => s.item.id) : [];
    if (boxes.size > 0) {
      p.fitTo(show?.length ? show : own, agent);
      camera.land();
    }
    else camera.set({ x: Math.round(p.viewport.w / 2 - 400), y: 200, z: 1 });
    if (own.length > 0) p.pinView(work);
  });
}

/** What keeping the view needs of the render it runs in. */
export interface KeptViewNeeds {
  camera: CameraStore;
  source: BoardSource;
  remember: boolean;
  mode: ViewMode;
  /** The latest mode, read when the view is written down. */
  modeNow(): ViewMode;
  /** The chapter in view as last measured: a change of it is written down too. */
  inView: Id | undefined;
  chapterRef: RefObject<Id | undefined>;
  fitted: RefObject<boolean>;
}

/** Keep where the owner looks (the camera, the Board or the Story, the chapter), per board, so a reload comes back to it. */
export function useKeptView({ camera, source, remember, mode, modeNow, inView, chapterRef, fitted }: KeptViewNeeds): void {
  useEffect(() => {
    if (!remember) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const keep = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (fitted.current && source.state.name) {
          const chapter = chapterRef.current;
          writeView(viewKey(source.state.name), { camera: camera.get(), mode: modeNow(), ...(chapter ? { chapter } : {}) });
        }
      }, KEEP_AFTER);
    };
    const off = camera.subscribe(keep);
    keep();
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [remember, camera, source, mode, inView, modeNow, chapterRef, fitted]);
}
