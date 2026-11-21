import type { BoardState, Id } from '@keel/protocol';
import { openQuestions } from '@keel/protocol';
import type { RefObject } from 'react';
import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { usePresence } from './board/presence';
import type { CameraStore } from './camera/camera';
import type { ToolId } from './chrome';
import { oncePerFrame } from './frame';
import type { HintFacts } from './hints';
import { blueprintWaits, buildWaits, hintFor } from './hints';
import type { LiveStore } from './live';
import type { BoardSource } from './source';
import { crosses } from './tips';
import type { PenTool } from './tools/pen';

/** What the hint line is told by the board: the rest it reads for itself. */
export interface HintLineProps {
  source: BoardSource;
  camera: CameraStore;
  state: BoardState;
  /** The live layer: the pen tells it of every change to its go. */
  hand: LiveStore;
  pen: Pick<PenTool, 'open'>;
  field: HintFacts['field'];
  tool: ToolId;
  /** How many things the open lasso holds. */
  lassoed: number;
  /** The chapter in view. */
  chapter: Id | undefined;
  /** Nothing is on the board, and the board is connected: it is truly empty. */
  empty: boolean;
}

/** The note or the label the owner types in: the paper round its words. */
const OPEN_FIELD = '.item--editor, .label-editor';

/**
 * The line gives its place to the field the owner types in: where the two would cross, the line
 * hides (styles/chrome.css) until the field has grown, moved or closed clear of it. The page is
 * read as the field opens or the line changes, as the field grows, and once a frame while the
 * camera moves the field or the window changes size (the line stands at the window's foot, and
 * goes with it): never under a wheel event itself. The answer is written as an attribute, so
 * nothing renders.
 */
function useGiveWayToField(line: RefObject<HTMLElement | null>, camera: CameraStore, field: HintFacts['field'], says: string | undefined): void {
  useLayoutEffect(() => {
    const el = line.current;
    const paper = field ? document.querySelector<HTMLElement>(OPEN_FIELD) : null;
    if (!el || !paper || !says) return;
    const check = () => {
      const hint = el.querySelector('.hint')?.getBoundingClientRect();
      el.toggleAttribute('data-under-field', !!hint && crosses(hint, paper.getBoundingClientRect()));
    };
    const grows = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(check);
    grows?.observe(paper);
    check();
    // The camera can move many times in a frame, and a window dragged wider tells of many sizes: the page is read once, when the frame's changes are in.
    const lookAgain = oncePerFrame(check);
    const soon = () => lookAgain();
    const offCamera = camera.onMove(soon);
    window.addEventListener('resize', soon);
    return () => {
      grows?.disconnect();
      offCamera();
      window.removeEventListener('resize', soon);
      lookAgain.cancel();
      el.removeAttribute('data-under-field');
    };
  }, [line, camera, field, says]);
}

/**
 * The hint line: the owner's next step, in one quiet line above the toolbar (`hints.ts` says
 * which). It hears the agent and the pen for itself, so neither draws the board again. It never
 * takes a press, and it hides while a press is open on the board (styles/chrome.css), and where
 * the note or the label the owner types in reaches it. Its box is a panel only while it says
 * something: then it truly covers the board there, and a fit keeps clear of it.
 */
export function HintLine({ source, camera, state, hand, pen, field, tool, lassoed, chapter, empty }: HintLineProps) {
  const presence = usePresence(source);
  const penGo = useSyncExternalStore(hand.subscribe, pen.open);
  const questions = useMemo(() => openQuestions(state).length, [state]);
  const toBuild = useMemo(() => blueprintWaits(state, chapter), [state, chapter]);
  const toTry = buildWaits(state, chapter);
  const line = hintFor({ penGo, field, agentWaits: presence.state === 'waiting', questions, lassoed, toBuild, toTry, tool, empty, away: presence.state === 'away' });
  const ref = useRef<HTMLDivElement>(null);
  useGiveWayToField(ref, camera, field, line);
  return (
    <div ref={ref} className="hint-line">
      {line && (
        <p className="hint" data-testid="hint" data-viewport-ui="bottom">
          {line}
        </p>
      )}
    </div>
  );
}
