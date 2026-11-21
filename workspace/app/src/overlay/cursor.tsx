import type { BoardState, Box, Id } from '@keel/protocol';
import type { CSSProperties } from 'react';
import { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { usePresence } from '../board/presence';
import type { CameraStore } from '../camera/camera';
import { prefersReducedMotion } from '../camera/motion';
import { laidOut } from '../camera/fit';
import {
  CURSOR_DIM_MS,
  CURSOR_REST_HOLD_MS,
  CURSOR_WORDS_MS,
  CURSOR_WORDS_RISE_PX,
  DROP_BOB_MS,
  DROP_BOB_PX,
  DROP_DOTS_MS,
  DROP_LEAN_DEG,
  DROP_LOOK_PX,
  DROP_POSE_MS,
  DROP_READ_MS,
  DROP_SCRIBBLE_DEG,
  DROP_SCRIBBLE_MS,
  DROP_SPLIT_MS,
  DROP_SPLIT_OVERSHOOT,
  DROP_SWELL,
  DROP_SWELL_MS,
} from '../motion/timing';
import type { BoardSource } from '../source';
import type { BoardRect } from '../tools/types';
import { CURSOR_SIZE, cursorPoint, cursorSays, DROPLET_SHARE, dropPose, markOf, placeCursor, tagWords } from './cursorPlace';
import type { AgentCursorStore } from './cursorStore';
import { Drop } from './drop';

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
  /** A picture of the agent's waits to be drawn: the figure is at work until it is. */
  waiting: boolean;
}

/** The figure's times and distances, for the style sheet, from `motion/timing.ts`. */
const FIGURE_TIMES = {
  '--cursor-hold': `${CURSOR_REST_HOLD_MS}ms`,
  '--cursor-dim': `${CURSOR_DIM_MS}ms`,
  '--drop-pose': `${DROP_POSE_MS}ms`,
  '--drop-lean': `${DROP_LEAN_DEG}deg`,
  '--drop-read': `${DROP_READ_MS}ms`,
  '--drop-look': `${DROP_LOOK_PX}px`,
  '--drop-bob': `${DROP_BOB_MS}ms`,
  '--drop-bob-px': `${DROP_BOB_PX}px`,
  '--drop-dots': `${DROP_DOTS_MS}ms`,
  '--drop-scribble': `${DROP_SCRIBBLE_MS}ms`,
  '--drop-scribble-deg': `${DROP_SCRIBBLE_DEG}deg`,
  '--drop-split': `${DROP_SPLIT_MS}ms`,
  '--drop-overshoot': `${DROP_SPLIT_OVERSHOOT}`,
  '--words-in': `${CURSOR_WORDS_MS}ms`,
  '--words-rise': `${CURSOR_WORDS_RISE_PX}px`,
} as CSSProperties;

/**
 * The agent on the board: an ink drop with an "agent" tag, drawn in the overlay at one size at
 * any zoom (`cursorPlace.ts` has the rules), and a smaller droplet for each cursor split off it.
 * It hears the agent for itself and tells the store the place presence names; the store says
 * where every cursor is (`cursorStore.ts`). It is on the board from the first time it has a
 * place, and stays where it last was when presence names none.
 *
 * Every cursor's place is a transform written straight to the page, on every camera move and on
 * every frame of a trip: neither draws it again through React. A note too long for the presence
 * pill is said beside it.
 */
export function AgentCursor({ source, cursor, state, boxOf, titles, camera, rect, waiting }: AgentCursorProps) {
  const presence = usePresence(source);
  const shown = useSyncExternalStore(cursor.subscribe, cursor.shown);
  const { placed, led, count } = shown;
  const el = useRef<HTMLDivElement>(null);
  const tag = useRef<HTMLSpanElement>(null);
  const heading = useRef<HTMLSpanElement>(null);
  const droplets = useRef(new Map<number, HTMLDivElement>());
  /** How wide the tag, or the title under it, is drawn, in screen pixels; 0 until measured. */
  const tagWidth = useRef(0);
  const lastCount = useRef(count);

  const size = useCallback(() => {
    const r = laidOut(rect());
    return { w: r.width, h: r.height };
  }, [rect]);

  const draw = useCallback(() => {
    const [cam, board] = [camera.get(), size()];
    const node = el.current;
    const p = cursor.at();
    if (node && p) {
      let at = placeCursor(p, cam, board, tagWidth.current);
      // The tag is measured the first time it shows after its words changed: off the board it is
      // put away, and has no width to read.
      if (!at.off && tagWidth.current === 0 && tag.current) {
        node.removeAttribute('data-off');
        tagWidth.current = Math.max(tag.current.offsetWidth, heading.current?.offsetWidth ?? 0);
        at = placeCursor(p, cam, board, tagWidth.current);
      }
      node.style.transform = `translate(${at.x}px, ${at.y}px)`;
      node.toggleAttribute('data-off', at.off);
      node.toggleAttribute('data-flip', at.flip);
    }
    if (droplets.current.size === 0) return;
    for (const d of cursor.drawnAll()) {
      const drop = droplets.current.get(d.id);
      if (!drop) continue;
      const at = placeCursor(d.at, cam, board);
      drop.style.transform = d.share < 1 ? `translate(${at.x}px, ${at.y}px) scale(${d.share})` : `translate(${at.x}px, ${at.y}px)`;
      drop.style.opacity = d.share < 1 ? String(d.share) : '';
      drop.toggleAttribute('data-off', at.off);
    }
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

  // The element is new: put it where the cursor is before the page is painted. So are droplets.
  useLayoutEffect(() => {
    if (placed || count > 1) draw();
  }, [placed, count, draw]);

  // Fewer cursors drawn: split ones went into the drop, and it swells once.
  useLayoutEffect(() => {
    if (count < lastCount.current && !prefersReducedMotion()) {
      el.current?.querySelector('.drop__scale')?.animate([{ transform: 'scale(1)' }, { transform: `scale(${DROP_SWELL})`, offset: 0.4 }, { transform: 'scale(1)' }], { duration: DROP_SWELL_MS, easing: 'ease-in-out' });
    }
    lastCount.current = count;
  }, [count]);

  const pose = dropPose(presence, { led: led || waiting, count });
  const working = pose !== 'asleep' && pose !== 'away';
  // Led, it is drawing: the tag is its name, and the pill says the note. Words beside it would
  // hang over what it draws. That it works, the drop shows: the tag is for words.
  const words = working && !led ? tagWords(presence, titles) : undefined;
  const title = working && !led ? presence.picture?.title : undefined;

  // The tag has new words, or is new: it is measured again, and hung on the side where it fits.
  useLayoutEffect(() => {
    tagWidth.current = 0;
    draw();
  }, [placed, words, title, draw]);

  // The pill leaves a long note to the cursor only while presence names a place and nothing
  // leads the cursor (`AgentPill`).
  const said = place && !led ? cursorSays(presence, titles) : undefined;
  return (
    <>
      {placed && (
        <div
          ref={el}
          className="agent-cursor"
          data-testid="agent-cursor"
          data-pose={pose}
          data-at={place ? `${place[0]},${place[1]}` : undefined}
          data-away={pose === 'away' ? '' : undefined}
          data-rest={pose === 'asleep' ? '' : undefined}
          style={FIGURE_TIMES}
        >
          <Drop size={CURSOR_SIZE} />
          <span ref={tag} className="agent-cursor__tag">
            <span className="agent-cursor__name">agent</span>
            {words && (
              <span key={words} className="agent-cursor__words">
                {words}
              </span>
            )}
          </span>
          {title && (
            <span ref={heading} key={title} className="agent-cursor__title">
              {title}
            </span>
          )}
          {said && <p className="agent-cursor__said">{said}</p>}
        </div>
      )}
      {/* Over the drop and its tag: a droplet comes out of it, and goes back into it, in sight. */}
      {count > 1 &&
        cursor
          .drawnAll()
          .slice(1)
          .map((d) => (
            <div
              key={d.id}
              ref={(n) => {
                if (n) droplets.current.set(d.id, n);
                else droplets.current.delete(d.id);
              }}
              className="agent-cursor agent-droplet"
              data-testid="agent-droplet"
              data-pose="led"
              style={FIGURE_TIMES}
            >
              <Drop size={CURSOR_SIZE * DROPLET_SHARE} />
            </div>
          ))}
    </>
  );
}
