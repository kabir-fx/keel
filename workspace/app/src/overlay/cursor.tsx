import type { Box, Id } from '@keel/protocol';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { usePresence } from '../board/presence';
import type { CameraStore } from '../camera/camera';
import { laidOut } from '../camera/fit';
import { easeOut, prefersReducedMotion } from '../camera/motion';
import type { FrameLoop } from '../frame';
import { CURSOR_GLIDE_MS } from '../input/constants';
import type { BoardSource } from '../source';
import type { BoardRect } from '../tools/types';
import { cursorPoint, cursorSays, placeCursor, towards } from './cursorPlace';

/** What the agent's cursor needs of the board. */
export interface AgentCursorProps {
  source: BoardSource;
  boxOf: (id: Id) => Box | undefined;
  /** The chapters' titles: a note that is only one of them is not said beside the cursor. */
  titles: readonly string[];
  camera: CameraStore;
  /** The board's one frame loop: the cursor travels to a new place on it. */
  frames: FrameLoop;
  /** The board's place on the page, from memory. */
  rect: () => BoardRect;
}

/**
 * The agent on the board: a blue pointer with an "agent" tag, at the place `presence.cursor`
 * names, drawn in the overlay at one size at any zoom (`cursorPlace.ts` has the rules). It hears
 * the agent for itself, and is mounted only while there is a place to point at. A note too long
 * for the presence pill is said beside it.
 */
export function AgentCursor({ source, boxOf, titles, camera, frames, rect }: AgentCursorProps) {
  const presence = usePresence(source);
  const point = cursorPoint(presence, boxOf);
  if (!point) return null;
  return <Pointer x={point[0]} y={point[1]} away={presence.state === 'away'} said={cursorSays(presence, titles)} camera={camera} frames={frames} rect={rect} />;
}

/**
 * The cursor at a world point. It moves by a transform written straight to the page: when the
 * camera moves, at once, and when the point moves, over a few frames of the board's loop (a
 * jump with reduced motion). Neither draws it again through React.
 */
function Pointer({ x, y, away, said, camera, frames, rect }: { x: number; y: number; away: boolean; said: string | undefined } & Omit<AgentCursorProps, 'source' | 'boxOf' | 'titles'>) {
  const el = useRef<HTMLDivElement>(null);
  /** The world point drawn now: the point itself, or a place on the way to it. */
  const drawn = useRef<readonly [number, number]>([x, y]);
  /** This cursor's key in the frame loop. */
  const [travel] = useState(() => Symbol('agent cursor'));

  const write = useCallback(() => {
    const node = el.current;
    if (!node) return;
    const r = laidOut(rect());
    const at = placeCursor(drawn.current, camera.get(), { w: r.width, h: r.height });
    node.style.transform = `translate(${at.x}px, ${at.y}px)`;
    node.toggleAttribute('data-off', at.off);
  }, [camera, rect]);

  useLayoutEffect(() => {
    const stop = camera.onMove(write);
    window.addEventListener('resize', write);
    return () => {
      stop();
      window.removeEventListener('resize', write);
    };
  }, [camera, write]);

  useLayoutEffect(() => {
    const from = drawn.current;
    if (from[0] === x && from[1] === y) return;
    if (prefersReducedMotion()) {
      drawn.current = [x, y];
      write();
      return;
    }
    let elapsed = 0;
    frames.start(travel, (dt) => {
      elapsed += dt;
      const t = Math.min(1, elapsed / CURSOR_GLIDE_MS);
      drawn.current = towards(from, [x, y], easeOut(t));
      write();
      return t < 1;
    });
    // A new place before this one is reached: the next trip starts from where the cursor is.
    return () => frames.cancel(travel);
  }, [x, y, frames, travel, write]);

  return (
    <div ref={el} className="agent-cursor" data-testid="agent-cursor" data-at={`${x},${y}`} data-away={away ? '' : undefined}>
      <svg className="agent-cursor__arrow" width="22" height="22" viewBox="0 0 20 20" aria-hidden="true">
        <path className="agent-cursor__halo" d="M4 2 L4 16 L7.8 12.6 L10.4 18 L12.8 16.9 L10.2 11.6 L15.4 11.4 Z" />
        <path className="agent-cursor__body" d="M4 2 L4 16 L7.8 12.6 L10.4 18 L12.8 16.9 L10.2 11.6 L15.4 11.4 Z" />
      </svg>
      <span className="agent-cursor__tag">agent</span>
      {said && <p className="agent-cursor__said">{said}</p>}
    </div>
  );
}
