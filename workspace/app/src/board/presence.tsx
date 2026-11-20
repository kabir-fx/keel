import type { Box, Id, Presence } from '@keel/protocol';
import { useSyncExternalStore } from 'react';
import { PresencePill } from '../chrome';
import { cursorPoint } from '../overlay/cursorPlace';
import type { BoardSource } from '../source';

/*
 * What the agent is doing is heard only by what shows it: the pill, the cursor and the hint
 * line. The board itself does not listen, so a change of presence draws nothing else again.
 */

/** What the agent is doing now, for a component that shows it. */
export function usePresence(source: BoardSource): Presence {
  return useSyncExternalStore(source.subscribe, () => source.presence);
}

/** The presence pill. It leaves a long note to the cursor when the cursor is on the board. */
export function AgentPill({ source, boxOf, titles }: { source: BoardSource; boxOf: (id: Id) => Box | undefined; titles: readonly string[] }) {
  const presence = usePresence(source);
  return <PresencePill presence={presence} cursorSays={!!cursorPoint(presence, boxOf)} titles={titles} />;
}
