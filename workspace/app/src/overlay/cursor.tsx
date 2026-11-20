import type { BoardState, Box, Id } from '@keel/protocol';
import type { CSSProperties } from 'react';
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { usePresence } from '../board/presence';
import type { CameraStore } from '../camera/camera';
import { laidOut } from '../camera/fit';
import { CURSOR_DIM_MS, CURSOR_REST_HOLD_MS } from '../motion/timing';
import type { BoardSource } from '../source';
import type { BoardRect } from '../tools/types';
import { cursorLook, cursorPoint, cursorSays, markOf, placeCursor, tagWords } from './cursorPlace';
import type { AgentCursorStore } from './cursorStore';

/** What the agent's cursor needs of the board. */
export interface AgentCursorProps {
  source: BoardSource;
  /** Where the cursor is, and where it goes: one per board. */
  cursor: AgentCursorStore;
  /** The board now: the cursor waits beside an owner's mark, and inside a picture's corner. */
  state: BoardState;
  boxOf: (id: Id) => Box | undefined;
  /** The chapters' titles: a note that is only one of them is not said beside the cursor. */
  titles: readonly string[];
  camera: CameraStore;
  /** The board's place on the page, from memory. */
  rect: () => BoardRect;
}

/** How long the cursor holds at rest before it dims, and how long it takes to: for the style sheet, from `motion/timing.ts`. */
const REST_TIMES = { '--cursor-hold': `${CURSOR_REST_HOLD_MS}ms`, '--cursor-dim': `${CURSOR_DIM_MS}ms` } as CSSProperties;

/**
 * The agent on the board: a blue pointer with an "agent" tag, drawn in the overlay at one size at
 * any zoom (`cursorPlace.ts` has the rules). It hears the agent for itself and tells the store
 * the place presence names; the store says where it is (`cursorStore.ts`). It is on the board
 * from the first time it has a place, and stays where it last was when presence names none.
 *
 * Its place is a transform written straight to the page, on every camera move and on every frame
 * of a trip: neither draws it again through React. A note too long for the presence pill is said
 * beside it.
 */
export function AgentCursor({ source, cursor, state, boxOf, titles, camera, rect }: AgentCursorProps) {
  const presence = usePresence(source);
  const { placed, led } = useSyncExternalStore(cursor.subscribe, cursor.shown);
  const el = useRef<HTMLDivElement>(null);
  const tag = useRef<HTMLSpanElement>(null);
  /** How wide the tag is drawn, in screen pixels; 0 until it is measured. */
  const tagWidth = useRef(0);

  const size = useCallback(() => {
    const r = laidOut(rect());
    return { w: r.width, h: r.height };
  }, [rect]);

  const draw = useCallback(() => {
    const node = el.current;
    const p = cursor.at();
    if (!node || !p) return;
    const [cam, board] = [camera.get(), size()];
    let at = placeCursor(p, cam, board, tagWidth.current);
    // The tag is measured the first time it shows after its words changed: off the board it is
    // put away, and has no width to read.
    if (!at.off && tagWidth.current === 0 && tag.current) {
      node.removeAttribute('data-off');
      tagWidth.current = tag.current.offsetWidth;
      at = placeCursor(p, cam, board, tagWidth.current);
    }
    node.style.transform = `translate(${at.x}px, ${at.y}px)`;
    node.toggleAttribute('data-off', at.off);
    node.toggleAttribute('data-flip', at.flip);
  }, [camera, cursor, size]);

  useLayoutEffect(() => cursor.attach({ size, draw }), [cursor, size, draw]);

  useLayoutEffect(() => {
    const stop = camera.onMove(draw);
    window.addEventListener('resize', draw);
    return () => {
      stop();
      window.removeEventListener('resize', draw);
    };
  }, [camera, draw]);

  const place = cursorPoint(presence, boxOf, markOf(state));
  const [px, py] = place ?? [Number.NaN, Number.NaN];
  useLayoutEffect(() => cursor.goTo(Number.isNaN(px) ? undefined : [px, py]), [cursor, px, py]);

  // The element is new: put it where the cursor is before the page is painted.
  useLayoutEffect(() => {
    if (placed) draw();
  }, [placed, draw]);

  const look = cursorLook(presence.state, led);
  // Led, it is drawing: the tag is its name and the dots, and the pill says the note. Words
  // beside it would hang over what it draws.
  const words = look === 'working' && !led ? tagWords(presence, titles) : undefined;

  // The tag has new words, or is new: it is measured again, and hung on the side where it fits.
  useLayoutEffect(() => {
    tagWidth.current = 0;
    draw();
  }, [placed, look, words, draw]);

  if (!placed) return null;
  // The pill leaves a long note to the cursor only while presence names a place and nothing
  // leads the cursor (`AgentPill`).
  const said = place && !led ? cursorSays(presence, titles) : undefined;
  return (
    <div
      ref={el}
      className="agent-cursor"
      data-testid="agent-cursor"
      data-at={place ? `${place[0]},${place[1]}` : undefined}
      data-away={look === 'away' ? '' : undefined}
      data-rest={look === 'rest' ? '' : undefined}
      style={REST_TIMES}
    >
      <svg className="agent-cursor__arrow" width="22" height="22" viewBox="0 0 20 20" aria-hidden="true">
        <path className="agent-cursor__halo" d="M4 2 L4 16 L7.8 12.6 L10.4 18 L12.8 16.9 L10.2 11.6 L15.4 11.4 Z" />
        <path className="agent-cursor__body" d="M4 2 L4 16 L7.8 12.6 L10.4 18 L12.8 16.9 L10.2 11.6 L15.4 11.4 Z" />
      </svg>
      <span ref={tag} className="agent-cursor__tag">
        <span className="agent-cursor__name">agent</span>
        {words && <span className="agent-cursor__words">{words}</span>}
        {look === 'working' && (
          <span className="presence-sign presence-sign--drawing" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        )}
      </span>
      {said && <p className="agent-cursor__said">{said}</p>}
    </div>
  );
}
