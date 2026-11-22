import type { Box, Id, Presence } from '@keel/protocol';
import { openCount } from '@keel/protocol';
import { useSyncExternalStore } from 'react';
import { PresencePill } from '../chrome';
import { cursorPoint } from '../overlay/cursorPlace';
import type { AgentCursorStore } from '../overlay/cursorStore';
import type { BoardSource } from '../source';
import type { Stillness } from './stillness';
import { useAskNow } from './stillness';

/*
 * What the agent is doing is heard only by what shows it: the pill, the cursor and the hint
 * line. The board itself does not listen, so a change of presence draws nothing else again.
 */

/** What the agent is doing now, for a component that shows it. */
export function usePresence(source: BoardSource): Presence {
  return useSyncExternalStore(source.subscribe, () => source.presence);
}

/**
 * The presence pill. It leaves a long note to the cursor while presence names the cursor's place
 * and nothing leads it: a led cursor is drawing and says no note, so the pill says it then.
 * While the agent holds, it says so, with the marks that wait on the whole board: one wake
 * answers every canvas's.
 */
export function AgentPill({ source, cursor, boxOf, titles, still }: { source: BoardSource; cursor: AgentCursorStore; boxOf: (id: Id) => Box | undefined; titles: readonly string[]; still: Stillness }) {
  const presence = usePresence(source);
  const holding = useSyncExternalStore(source.subscribe, () => source.holding);
  const open = useSyncExternalStore(source.subscribe, () => openCount(source.whole ?? source.state));
  const { led } = useSyncExternalStore(cursor.subscribe, cursor.shown);
  const onHold = source.role === 'owner' ? source.hold : undefined;
  const ask = useAskNow(source, still);
  return <PresencePill presence={presence} cursorSays={!led && !!cursorPoint(presence, boxOf)} titles={titles} holding={holding} open={open} onHold={onHold} ask={ask} />;
}
