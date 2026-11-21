import type { Box, Id, InkItem } from '@keel/protocol';
import { chaptersOn } from '@keel/protocol';
import type { PictureView } from '@keel/pictures';
import { Picture } from '@keel/pictures';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { landFirst } from './arrival/land';
import { useArrivals } from './arrival/useArrivals';
import { usePictureActs } from './board/acts';
import { useAhead } from './board/ahead';
import { useChapterInView, useFollowChapter } from './board/chapterInView';
import { useBoard } from './board/context';
import { useDrop } from './board/drop';
import { useFirstView, useKeptView } from './board/firstView';
import { flashItems } from './board/flash';
import { useFocusView } from './board/focusView';
import { useFontsReady } from './board/fonts';
import { useHover } from './board/hover';
import { useLog } from './board/log';
import { MarkLabel, useMarkLabel } from './board/markLabel';
import { measuringOf } from './board/measure';
import { useNews } from './board/news';
import { NoteEditing, NoteGhost, useNotes } from './board/notes';
import { useOneUse } from './board/oneUse';
import { useBoardRect, useViewport } from './board/page';
import { usePaste } from './board/paste';
import { usePlacement } from './board/placement';
import { AgentPill } from './board/presence';
import { useShown } from './board/shown';
import { snapshotInk } from './board/snapshot';
import { useStoryNav } from './board/storyNav';
import { hangsOnSubs, useSubRects } from './board/subRects';
import { useTalk } from './board/talk';
import { useToast } from './board/toast';
import { partPicture, useWatching, watchedChapter } from './board/watching';
import { BackToBoard } from './camera/BackToBoard';
import { CameraStore } from './camera/camera';
import { useFit } from './camera/fit';
import { useGesture } from './camera/gesture';
import type { MiniBox } from './camera/Minimap';
import { Minimap } from './camera/Minimap';
import { useWheel } from './camera/wheel';
import { useWorldTransform } from './camera/world';
import { ZoomControl } from './camera/ZoomControl';
import type { ToolId, ViewMode } from './chrome';
import { BoardPill, TalkCaption, Toast, Toolbar, ViewSwitch } from './chrome';
import { FocusCrumb, OpeningNotice } from './focus';
import type { Clock } from './frame';
import { FrameLoop } from './frame';
import { foreignWords } from './foreign';
import { HintLine } from './HintLine';
import { InkMark } from './ink/ink';
import { useGuards } from './input/guards';
import { typing, useKeys } from './input/keys';
import { capture, createPointers, usePressEndings } from './input/pointers';
import { PictureFrame } from './items';
import { ChapterLabels } from './labels';
import { Lineage } from './lineage';
import { Live, LiveStore } from './live';
import { openLasso, picksOf, solidifyDraft } from './marks';
import { allBuilt } from './canvases';
import { CanvasDoneNotice, ConnectionNotice, ElsewhereNotice, ForeignNotice, ForeignTags, HomeNotice, Nudge, homeNeeds } from './notices';
import { canvasName } from './tryit';
import { canNotify } from './notify';
import { AgentCursor } from './overlay/cursor';
import { AgentCursorStore } from './overlay/cursorStore';
import { Overlay } from './overlay/Overlay';
import { SelectionLayer } from './overlay/selection';
import { TrailsSvg } from './overlay/TrailsSvg';
import { ReadChip } from './reads';
import { FollowingMark } from './select/following';
import { theOne } from './select/grab';
import { MovingStore } from './select/moving';
import { createNudge } from './select/nudge';
import { useCursor } from './select/useCursor';
import type { BoardSource } from './source';
import { NO_SPEECH } from './speech';
import { Story } from './StoryView';
import { createTools, drawsOrMoves, toolFor } from './tools';
import { Tooltip } from './Tooltip';
import { readView, viewKey } from './view';
import type { Camera } from './camera/camera';
import { CanvasSource, canvasToShow, newCanvasId } from './canvasSource';
import { useBuildPlace, useCanvasInView, useElsewhere } from './board/canvasView';
import { TryRoom } from './TryRoom';
import { createUndo } from './undo';
import { createCanvasUndo } from './board/canvasUndo';
import { stepFrom, walkOf } from './walk';
import { Watch } from './WatchPanel';

// What the tests take from this module, kept where they have always found it.
export { viewable } from './board/drop';
export { PEN_PAUSE } from './input/constants';
export { NOTE_WHERE } from './tools/note';

/** What the page hands the board: where the log comes from, and what to open on. */
export interface AppProps {
  source: BoardSource;
  /** Fit the first view to these items. */
  show?: readonly Id[] | undefined;
  /** The walk's step and the pipeline's view to open with. */
  view?: PictureView | undefined;
  /** A focus picture to open the focus view on, as a checkpoint says. */
  focus?: Id | undefined;
  /** The Board or the Story, to open with. */
  mode?: ViewMode | undefined;
  /**
   * Keep where the owner looks (the camera and the Board or the Story) in this page's storage,
   * per board, and come back to it on a reload. Off for fixtures: a checkpoint says the view.
   */
  remember?: boolean | undefined;
  /**
   * The clock the board's one frame loop runs on. A fixture played for a test or a review hands
   * in a manual one, so a moment asked for twice shows the same frame. Left out, the page's own.
   */
  clock?: Clock | undefined;
}

/**
 * The board: the canvas, the owner's tools and the chrome round them.
 *
 * This component is wiring. Each part of the board lives in its own module: the tools under
 * `tools/`, the pointer and the keys under `input/`, the camera under `camera/`, and the rest
 * (the log, where things are, placement, the focus view, notes, talk, drop-in, what is new)
 * under `board/`. They meet in the board's one object (`board/context.ts`), filled below.
 *
 * The order of the hooks is the order their effects run in, and parts of it matter: the
 * camera is written to the page before anything is measured, pictures are placed before the
 * subs are measured, and the first view is fitted after both.
 */
export function App({ source: board0, show, view: firstView = {}, focus: firstFocus, mode: firstMode = 'board', remember = false, clock }: AppProps) {
  /* ------------------------------------------------------------ the source, as the canvas in view shows it */

  /** The whole board: the Story, the try room and the canvases out of view read it. */
  const whole = useSyncExternalStore(board0.subscribe, () => board0.state);
  /** The canvas the owner asked for. While it is there it is in view, else the newest one. */
  const [askedCanvas, setAskedCanvas] = useState<Id>();
  /** On a reload, the canvas the owner had in view, as this page kept it. */
  const keptCanvas = useMemo(() => (remember && whole.name ? readView(viewKey(whole.name))?.canvas : undefined), [remember, whole.name]);
  const canvas = canvasToShow(whole, askedCanvas ?? keptCanvas);
  const canvasRef = useRef<Id | undefined>(canvas);
  canvasRef.current = canvas;
  /** The board as the canvas in view shows it: everything below reads this one (record 0014). */
  const source = useMemo(() => new CanvasSource(board0, () => canvasRef.current), [board0]);
  const state = useSyncExternalStore(source.subscribe, () => source.state);
  const connection = useSyncExternalStore(source.subscribe, () => source.connection);
  const build = useSyncExternalStore(source.subscribe, () => source.build);
  const foreign = useSyncExternalStore(source.subscribe, () => source.foreign);
  const works = useSyncExternalStore(source.subscribe, () => source.works);
  const shows = useSyncExternalStore(source.subscribe, () => source.shows);
  const home = useSyncExternalStore(source.subscribe, () => source.home);
  const canPlace = source.role !== 'agent';
  const isOwner = source.role === 'owner';
  const fontsReady = useFontsReady();
  const viewport = useViewport();

  /* ------------------------------------------------------------ what the owner holds and looks at */

  const [tool, setToolState] = useState<ToolId>('select');
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [selection, setSelection] = useState<readonly Id[]>([]);
  /**
   * What is selected as of the last `select`, also before React has drawn it. A tool that ends
   * and one that begins in the same turn (a new press over one whose lift never came) both read
   * the selection, and the second must see what the first just put back.
   */
  const selectionNow = useRef<readonly Id[]>([]);
  selectionNow.current = selection;
  /** The one thing selected, when exactly one is: what a part about one thing (a walk, a lasso, lineage) shows. */
  const selected = theOne(selection);
  const selectedSet = useMemo(() => new Set(selection), [selection]);
  /** How the owner looks at the pictures: the walk being played, the pipeline view. Not in the log. */
  const [view, setView] = useState<PictureView>(firstView);
  /** Ink between the pen's pause and the log: drawn so the snapshot can see it. */
  const [pendingInk, setPendingInk] = useState<readonly InkItem[]>([]);
  /** The Board, or the Story of every chapter. The board stays laid out under the Story. */
  const [mode, setMode] = useState<ViewMode>(firstMode);
  const [watchFolded, setWatchFolded] = useState(false);
  /** The idea whose try room is open. */
  const [trying, setTrying] = useState<Id>();
  /** The owner has read what the board said about the home branch: it is not said again while the page is open. */
  const [homeRead, setHomeRead] = useState(false);
  /** Where the camera was on each canvas the owner left, while the page is open. */
  const cameras = useRef(new Map<Id, Camera>());

  /** Where each anchored sub is now, measured from the DOM, in world units. */
  const [subRects, setSubRects] = useState<ReadonlyMap<string, Box>>(() => new Map());
  /** Draws the board again, so what was skipped while a picture was drawn on is measured. */
  const [, measureAgain] = useState(0);
  const hover = useHover();

  /* ------------------------------------------------------------ the page */

  /** The one frame loop of this board: the camera's glide runs on it, and so does whatever else moves by itself. */
  const frames = useMemo(() => (clock ? new FrameLoop(clock, () => clock.now()) : new FrameLoop()), [clock]);
  const camera = useMemo(() => new CameraStore({ x: 0, y: 0, z: 1 }, { loop: frames }), [frames]);
  const hand = useMemo(() => new LiveStore(), []);
  /** Where the agent's cursor is: it goes where presence says, or where an arrival leads it. */
  const agentCursor = useMemo(() => new AgentCursorStore(frames, camera), [frames, camera]);
  const moving = useMemo(() => new MovingStore(), []);
  const appRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const groundRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const rect = useBoardRect(boardRef);
  /** True once the first view is fitted. */
  const fitted = useRef(false);
  /** The pictures on the board when it first opened: only later ones are news. */
  const known = useRef<Set<Id> | null>(null);
  /** When the last drag on the board ended. */
  const lastDragEnd = useRef(0);

  /* ------------------------------------------------------------ the board's one object, its tools and its pointer */

  const [board, fillBoard] = useBoard({ isOwner, camera, hand, frames, moving });
  const [tools] = useState(createTools);
  const [pointers] = useState(() => createPointers(board, (press) => toolFor(tools, press, board)));
  // Undo posts straight to the source: what it posts is no new step, and it says its own line.
  // One list of steps per canvas: Undo takes back only what was done on the canvas in view.
  const [undoer] = useState(() => createCanvasUndo(() => createUndo(board, tools.pen, (draft) => source.post(draft)), () => canvasRef.current));
  const [nudger] = useState(() => createNudge(board));

  /* ------------------------------------------------------------ where things are */

  const { toast, say, close: closeToast } = useToast();
  const ahead = useAhead();
  const shown = useShown(state, ahead, subRects, foreign);
  const { boxes, boxOf, live, marks, tagged, outlines, ends } = shown;
  const chapters = useChapterInView(camera, source, state, viewport, board.boxes, fitted);
  /** The build of the chapter in view shows while it builds, and once it is built. */
  const watchChapter = watchedChapter(state, mode, chapters.chapter);
  // Nothing is on the board, and nothing is on its way: the connection is open.
  const empty = live.length === 0 && connection === 'open';

  /* ------------------------------------------------------------ the parts, in the order their effects run */

  useWorldTransform(camera, worldRef, groundRef, boardRef);
  useWheel(boardRef, camera, rect, board);
  useGesture(boardRef, camera, rect, board);
  const focus = useFocusView({ board, source, camera, viewport, state, boxes, watchFolded, setWatchFolded });
  const { focusView, opening, raised, crumb } = focus;
  const log = useLog(source, camera, say, focus.made, undoer.steps);
  const fit = useFit(camera, source, layerRef, boxes, rect);
  useKeys(board);
  usePressEndings(pointers);
  useGuards(boardRef);
  const notes = useNotes(board, tool, remember);
  const labels = useMarkLabel(board, remember, notes.isOpen);
  const postMark = useOneUse(board, labels.label, log.postMark);
  const talk = useTalk(board);
  const drop = useDrop(board, source);
  usePaste(board, drop);
  usePlacement({ source, camera, state, fontsReady, canPlace, ahead, subRects, measureLayer: measureRef, say });
  const subsSettled = useSubRects({ camera, layer: layerRef, live, stored: shown.stored, subRects, setSubRects });
  useFirstView({
    canvas,
    camera,
    state,
    // Read as of this render, with no subscription, so a change of presence does not draw the
    // board again. That is enough: the first view reads it once, when it fits, and everything
    // the fit waits for (the connection, the fonts, the places, the measured subs) arrives
    // through a render.
    presence: source.presence,
    connection,
    viewport,
    fontsReady,
    waiting: shown.waiting,
    subsSettled,
    live,
    boxes,
    boxOf,
    show,
    firstFocus,
    remember,
    mode,
    setMode,
    room: fit.room,
    fitTo: fit.fitTo,
    openFocusView: focus.openView,
    pinView: chapters.pin,
    fitted,
    known,
  });
  useKeptView({ camera, source, remember, mode, modeNow: board.mode, inView: chapters.inView, chapterRef: chapters.chapterRef, fitted, canvas });
  // A selected mark that left the board is no longer selected.
  useEffect(() => {
    if (selection.some((id) => !state.items[id] || state.items[id]!.removed)) setSelection((sel) => sel.filter((id) => state.items[id] && !state.items[id]!.removed));
  }, [state, selection]);
  useCursor(boardRef, board, tool, spaceHeld);
  const news = useNews({ board, source, camera, boxes, fit, focus, lastMark: log.lastMark, known, spots: ahead.provisional });
  // After the news: where the camera is going is set when an arrival asks what will be in view.
  const arrivals = useArrivals({
    frames,
    camera,
    cursor: agentCursor,
    state,
    boxes,
    spots: ahead.provisional,
    chips: shown.chips,
    connection,
    edges: shown.edges,
    fit,
    known,
    mode,
    focusOpen: !!focusView,
    board: boardRef,
    layer: layerRef,
    world: worldRef,
    // The subs a mark hangs on are not measured on a picture being drawn on: measure them once it is whole.
    ended: (id) => {
      if (hangsOnSubs(shown.live, id)) measureAgain((n) => n + 1);
    },
  });
  useFollowChapter(camera, boxes, chapters.look);
  useWatching(state, chapters.chapter, connection);
  const story = useStoryNav({ board, mode, fit, focus, pinView: chapters.pin });
  const onAct = usePictureActs(board, log.send, setView, lastDragEnd, setTrying);
  // A try room closes when its idea leaves the board.
  useEffect(() => {
    if (trying && !whole.chapters[trying]) setTrying(undefined);
  }, [trying, whole]);
  useCanvasInView({ canvas, camera, cameras, fitted, known, live, boxes, fit, viewport, focus, select: () => setSelection([]) });
  const away = useElsewhere(whole, canvas);

  /* ------------------------------------------------------------ what the board's object does, as of this render */

  const setTool = useCallback(
    (t: ToolId) => {
      if (t !== 'pen' && tools.pen.waiting()) void tools.pen.finish(board);
      hand.set({ shape: undefined });
      setToolState(t);
    },
    [hand, tools, board],
  );

  const openPicker = useCallback(() => fileRef.current?.click(), []);

  const lassoNow = useMemo(() => openLasso(state, selected), [state, selected]);
  /** How many things the open lasso holds: Solidify and the hint line count them. */
  const picked = lassoNow ? picksOf(lassoNow).filter((id) => state.items[id] && !state.items[id]!.removed).length : 0;
  const doSolidify = useCallback(() => {
    const l = openLasso(source.state, selected);
    if (!l) return;
    void log.send(solidifyDraft(source.state, l));
  }, [source, selected, log.send]);

  /** Select marks and pictures, one, several or none; a click on the ground selects nothing. */
  const select = (what: Id | readonly Id[] | undefined) => {
    // What has left the board leaves the selection by the effect above, also when it leaves later.
    const next = what === undefined ? [] : typeof what === 'string' ? [what] : what;
    selectionNow.current = next;
    setSelection(next);
  };

  /** One step of the selected walk, on or back. False when no walk is selected. */
  const stepWalk = (dir: 1 | -1): boolean => {
    const walk = walkOf(source.state, selected);
    if (!walk) return false;
    const step = stepFrom(source.state, walk, view.walk?.id === walk ? view.walk.step : undefined, dir);
    if (step !== undefined) setView((v) => ({ ...v, walk: { id: walk, step } }));
    return true;
  };

  /** Show another canvas on the board. Its camera comes back as the owner left it. */
  const showCanvas = (next: Id) => {
    if (canvas && next !== canvas) cameras.current.set(canvas, camera.get());
    setAskedCanvas(next);
  };

  /** A new, blank canvas: the way to a new branch. The board goes to it. */
  const newCanvas = async (): Promise<string | undefined> => {
    const id = newCanvasId(source.whole);
    const r = await log.send({ type: 'canvas.open', canvas: id });
    if (!r.ok) return r.reason;
    showCanvas(id);
    setMode('board');
    return undefined;
  };

  /**
   * Delete a canvas the owner said yes to. A build that runs on it is paused first. When it was
   * the one in view, the newest one left comes into view; with none left, the board is one
   * empty canvas, ready for a first note.
   */
  const deleteCanvas = async (gone: Id): Promise<string | undefined> => {
    for (const c of chaptersOn(source.whole, gone)) {
      if (c.state !== 'building' || c.paused) continue;
      const paused = await log.send({ type: 'build.pause', chapter: c.id });
      if (!paused.ok) return paused.reason;
    }
    const r = await log.send({ type: 'canvas.remove', canvas: gone });
    if (!r.ok) return r.reason;
    cameras.current.delete(gone);
    undoer.forget(gone);
    if (canvas === gone) setAskedCanvas(source.whole.canvasOrder[source.whole.canvasOrder.length - 1]);
    return undefined;
  };

  /** Fit the whole board. A fit is a look round: the chapter the owner works in stays theirs. */
  const fitAll = () => {
    const keep = chapters.chapterRef.current;
    fit.fitTo();
    chapters.pin(keep);
  };

  /** Is the owner drawing or typing? Then the view never moves by itself. */
  const busy = (): boolean => {
    if (drawsOrMoves(tools, pointers.tool())) return true;
    if (tools.pen.open() || talk.listening()) return true;
    if (notes.editor !== null || labels.label !== null) return true;
    return typing(typeof document === 'undefined' ? null : document.activeElement);
  };

  /** Show a part on the board: the newest picture of the whole model, lit for a moment. */
  const showPart = (part: Id) => {
    const id = partPicture(state, boxes, part);
    if (!id) return;
    focus.close();
    fit.fitTo([id]);
    board.flash([id]);
  };

  fillBoard({
    // What the board measures for a gesture, and the image a stroke sends, is the board at rest.
    ...landFirst(measuringOf({ board: boardRef, layer: layerRef, camera, source, rect }, shown, raised), arrivals.landAll),
    state: () => source.state,
    boxes: () => boxes,
    where: () => shown.where,
    tool: () => tool,
    spaceHeld: () => spaceHeld,
    editing: () => notes.editor !== null || labels.label !== null,
    selected: () => theOne(selectionNow.current),
    selection: () => selectionNow.current,
    capture: (pointer) => capture(boardRef.current, pointer),
    showPressing: (open) => void appRef.current?.toggleAttribute('data-pressing', open),
    select,
    say,
    send: log.send,
    postMark,
    postNew: log.postNew,
    newId: log.newId,
    freeId: log.freeId,
    setPendingBox: ahead.setPendingBox,
    setPendingArrow: ahead.setPendingArrow,
    recordStep: undoer.record,
    dragEnded: () => {
      lastDragEnd.current = Date.now();
    },
    openLabel: labels.open,
    openNote: notes.open,
    showPending: (items) => flushSync(() => setPendingInk((list) => [...list, ...items])),
    hidePending: (id) => setPendingInk((list) => list.filter((x) => x.id !== id)),
    snapshot: (item, rects) => {
      arrivals.landAll();
      return snapshotInk(worldRef.current, source, item, rects);
    },
    mode: () => mode,
    view: () => view,
    viewport: () => viewport,
    pointer: pointers.last,
    pressOpen: pointers.open,
    busy,
    layerEl: () => layerRef.current,
    flushMoves: pointers.flush,
    setTool,
    setMode,
    holdSpace: setSpaceHeld,
    // A run of arrow-key moves is posted before anything else changes the board.
    undo: () => {
      nudger.flush();
      undoer.undo();
    },
    redo: () => {
      nudger.flush();
      undoer.redo();
    },
    together: log.together,
    removeSelected: () => {
      nudger.flush();
      undoer.removeSelected();
    },
    solidify: doSolidify,
    stepWalk,
    nudge: nudger.nudge,
    openFocus: focus.open,
    closeFocus: focus.close,
    openPicker,
    endDrop: drop.end,
    startTalk: talk.start,
    stopTalk: talk.stop,
    zoomBy: fit.zoomBy,
    fitAll,
    flash: (ids) => flashItems(layerRef.current, ids),
  });

  /* ------------------------------------------------------------ draw */

  /** What every picture is told about how the owner looks: with the focus view open, which picture it shows large (it may drop its own title: the crumb says it). */
  const buildPlace = useBuildPlace(whole, canvas, home, works, shows);
  const pictureView = useMemo<PictureView>(() => {
    const where: PictureView = buildPlace ? { ...view, build: buildPlace } : view;
    return focusView ? { ...where, focus: focusView.id } : where;
  }, [view, focusView, buildPlace]);

  const miniBoxes: MiniBox[] = useMemo(
    () =>
      live.flatMap((s) => {
        const b = boxes.get(s.item.id);
        // What the board holds out of sight, waiting to be drawn on, the map does not show either.
        if (!b || arrivals.held.has(s.item.id)) return [];
        const tone: MiniBox['tone'] = s.item.kind === 'picture' ? 'agent' : s.item.kind === 'note' || s.item.kind === 'file' ? 'owner' : 'owner-line';
        return [{ box: b, tone }];
      }),
    [live, boxes, arrivals.held],
  );

  const editing = notes.editor?.mode === 'edit' ? notes.editor.id : undefined;
  const panMode = spaceHeld || tool === 'pan';
  const selectedPicture = selected && state.items[selected]?.item.kind === 'picture' ? selected : undefined;
  const chapterTitles = useMemo(() => state.chapterOrder.map((id) => state.chapters[id]?.title ?? ''), [state]);

  return (
    <div ref={appRef} className="app" data-tool={tool} data-mode={mode} data-pan={panMode ? '' : undefined} data-focus={focusView ? focusView.id : undefined}>
      <div
        ref={boardRef}
        className="board"
        data-testid="board"
        onPointerOver={hover.onPointerOver}
        // The camera is the only way the board moves: a scroll (a focus that scrolls an
        // element into view) would shift every item off where the camera says it is.
        onScroll={(e) => {
          e.currentTarget.scrollTop = 0;
          e.currentTarget.scrollLeft = 0;
        }}
        onPointerLeave={hover.onPointerLeave}
        onPointerDown={(e) => {
          nudger.flush();
          pointers.down(e);
        }}
        onPointerMove={pointers.move}
        onPointerUp={pointers.up}
        onPointerCancel={pointers.cancel}
        onLostPointerCapture={pointers.lost}
        onDoubleClick={notes.onDoubleClick}
        onDragEnter={drop.onDragEnter}
        onDragOver={drop.onDragOver}
        onDragLeave={drop.onDragLeave}
        onDrop={drop.onDrop}
      >
        <div ref={groundRef} className="ground" />
        <div ref={worldRef} className="world">
          <ChapterLabels state={state} boxOf={boxOf} moving={moving} />
          <Lineage edges={shown.edges} boxOf={boxOf} open={selectedPicture} hover={hover} moving={moving} obstacles={shown.cards} />
          <div ref={layerRef} className="layer">
            {focusView && <div className="focus-dim" data-focus-dim="" data-no-export aria-hidden="true" />}
            {live.map((s) => {
              const b = boxes.get(s.item.id);
              if (!b || s.item.id === editing) return null;
              const up = !!raised?.has(s.item.id);
              if (s.item.kind === 'picture') {
                return (
                  <PictureFrame
                    key={s.item.id}
                    item={s.item}
                    shown={b}
                    state={state}
                    markings={marks[s.item.id]}
                    view={pictureView}
                    onAct={onAct}
                    selected={selectedSet.has(s.item.id)}
                    raised={up}
                  />
                );
              }
              const o = s.item.kind === 'lasso' ? outlines.get(s.item.id) : undefined;
              const e = s.item.kind === 'arrow' ? ends.get(s.item.id) : undefined;
              return (
                <FollowingMark
                  key={s.item.id}
                  moving={moving}
                  item={s.item}
                  shown={b}
                  selected={selectedSet.has(s.item.id)}
                  outline={o?.loops}
                  picked={o?.picked}
                  raised={up}
                  onOpen={s.item.kind === 'file' ? drop.openFile : undefined}
                  {...(e ? { ends: e } : {})}
                />
              );
            })}
            {shown.chips.map((c) => (
              <ReadChip key={c.id} chip={c} raised={!!raised?.has(c.mark)} />
            ))}
          </div>
          {pendingInk.map((it) => (
            <div key={it.id} className="item item--ink item--pending" data-box={it.box.join(',')}>
              <InkMark strokes={it.strokes} box={it.box} shown={it.box} />
            </div>
          ))}
          <Live store={hand} />
          <NoteGhost ghost={notes.ghost} />
          <MarkLabel labels={labels} />
          <NoteEditing notes={notes} />
          <ForeignTags ids={tagged} boxOf={boxOf} moving={moving} />
          <div ref={measureRef} className="measure" aria-hidden="true">
            {shown.waiting.map((id) => {
              const s = state.items[id];
              if (!s || s.item.kind !== 'picture') return null;
              return (
                <div key={id} data-measure={id}>
                  <Picture item={s.item} state={state} markings={marks[id]} view={view} />
                </div>
              );
            })}
          </div>
        </div>
        <Overlay>
          <SelectionLayer board={board} selection={selection} state={state} boxes={boxes} ends={ends} />
          <TrailsSvg layer={hand.trails} />
          <AgentCursor source={source} cursor={agentCursor} state={state} boxOf={boxOf} titles={chapterTitles} camera={camera} rect={rect} waiting={arrivals.held.size > 0} />
        </Overlay>
        {drop.dropping && (
          <div className="drop-hint" data-testid="drop-hint">
            <span>Let go to drop it in where it lands</span>
          </div>
        )}
      </div>
      {mode === 'board' && isOwner && (
        <HintLine
          source={source}
          camera={camera}
          state={state}
          hand={hand}
          pen={tools.pen}
          field={labels.label ? 'label' : notes.editor ? 'note' : undefined}
          tool={tool}
          lassoed={picked}
          chapter={chapters.chapter}
          empty={empty}
        />
      )}
      {mode === 'story' && (
        <Story
          state={whole}
          boxOf={(id) => boxOf(id) ?? whole.items[id]?.item.box}
          markings={marks}
          isOwner={isOwner}
          onGo={(ids) => {
            const on = whole.chapters[whole.items[ids[0] ?? '']?.chapter ?? '']?.canvas;
            if (on) showCanvas(on);
            story.goTo(ids);
          }}
          onOpen={(id) => {
            showCanvas(id);
            setMode('board');
          }}
          onPart={(part) => {
            setMode('board');
            focus.open({ part });
          }}
          onNewCanvas={newCanvas}
          works={works}
          shows={shows}
          home={home}
          server={build}
          onTry={setTrying}
          post={log.send}
          onDelete={deleteCanvas}
          push={source.push}
          sync={source.sync}
        />
      )}
      <BoardPill state={mode === 'story' ? whole : state} chapter={chapters.chapter} mode={mode} canvas={canvas ? canvasName(whole, canvas) : undefined} />
      <ViewSwitch
        mode={mode}
        onMode={(m) => {
          if (m === 'story') {
            focus.stopOpening();
            setSelection([]);
          }
          setMode(m);
        }}
      />
      <AgentPill source={source} cursor={agentCursor} boxOf={boxOf} titles={chapterTitles} />
      {mode === 'board' && focusView && crumb && <FocusCrumb crumb={crumb} onBack={focus.close} />}
      {mode === 'board' && opening && !focusView && <OpeningNotice name={opening.name} onStop={focus.stopOpening} />}
      {watchChapter && (
        <Watch
          state={state}
          chapter={watchChapter}
          server={build}
          isOwner={isOwner}
          folded={watchFolded}
          onFold={setWatchFolded}
          post={log.send}
          notifies={canNotify()}
          onPart={showPart}
          work={works.get(state.chapters[watchChapter]?.canvas ?? '')}
          home={home}
          show={shows.get(watchChapter)}
          onTry={() => setTrying(watchChapter)}
          push={source.push}
          onNewCanvas={() => void newCanvas()}
        />
      )}
      {trying && whole.chapters[trying] && isOwner && (
        <TryRoom
          key={trying}
          state={whole}
          chapter={trying}
          show={shows.get(trying)}
          work={works.get(whole.chapters[trying]!.canvas)}
          home={home}
          source={source}
          isOwner={isOwner}
          post={log.send}
          onClose={() => setTrying(undefined)}
        />
      )}
      <div className="notices">
        <ConnectionNotice connection={connection} />
        {mode === 'board' && isOwner && !homeRead && homeNeeds(home) && (
          <HomeNotice
            words={homeNeeds(home)!}
            onShow={() => {
              setHomeRead(true);
              setMode('story');
            }}
            onDismiss={() => setHomeRead(true)}
          />
        )}
        {away[0] && (
          <ElsewhereNotice
            news={away}
            onGo={(id) => {
              showCanvas(id);
              setMode('board');
            }}
          />
        )}
        {mode === 'board' && isOwner && !watchChapter && allBuilt(state, canvas) && (
          <CanvasDoneNotice branch={canvas ? works.get(canvas)?.branch : undefined} onNewCanvas={() => void newCanvas()} />
        )}
        <Nudge ids={news.fresh} state={state} onGo={news.showNews} />
        {mode === 'board' && !focusView && <BackToBoard camera={camera} boxes={boxes} fit={fit} rect={rect} />}
        {mode === 'board' && foreign && tagged.length > 0 && (
          <ForeignNotice
            n={tagged.length}
            words={foreignWords(tagged.length)}
            onShow={() => {
              focus.close();
              fit.fitAfterRender(tagged);
              board.flash(tagged);
            }}
            onKeep={async () => {
              const ok = (await source.keep?.()) ?? false;
              if (!ok) say('The board did not keep them. Try again in a moment.');
            }}
          />
        )}
      </div>
      {talk.talking && <TalkCaption text={talk.talking.text} />}
      {mode === 'board' && (
        <Toolbar
          tool={tool}
          onTool={setTool}
          onDrop={openPicker}
          talk={{ supported: talk.supported, listening: !!talk.talking, start: talk.start, stop: talk.stop, unsupported: () => say(NO_SPEECH) }}
          solidify={{ count: picked, onSolidify: doSolidify }}
        />
      )}
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        data-testid="file-input"
        onChange={(e) => {
          const files = [...(e.currentTarget.files ?? [])];
          e.currentTarget.value = '';
          if (files.length) void drop.addFiles(files);
        }}
      />
      <ZoomControl camera={camera} onZoom={fit.zoomBy} onFit={fitAll} />
      <Minimap boxes={miniBoxes} camera={camera} rect={rect} />
      <Toast text={toast} onClose={closeToast} />
      <Tooltip />
    </div>
  );
}
