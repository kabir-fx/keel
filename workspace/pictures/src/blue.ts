import type { Approach, LanesApproach, LanesFlow, LanesLane, LanesStep } from '@keel/protocol';
import type { Blue } from './Lanes';
import { NO_BLUE } from './Lanes';

/**
 * What turns blue in a spread. The renderer decides, not the agent: a lane, step or flow is
 * blue when no other approach has it with the same id and the same words. A step also keeps
 * its lane: the same step moved to another lane is a different step. Words compare without
 * case, spacing or punctuation.
 */

const norm = (s?: string): string => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export const laneKey = (l: LanesLane): string => `${l.id}|${norm(l.name)}`;
export const stepKey = (s: LanesStep): string => `${s.id}|${s.lane}|${norm(s.text)}`;
export const flowKey = (f: LanesFlow): string => `${f.from}>${f.to}|${norm(f.label)}`;

export const isLanes = (a: Approach): a is LanesApproach => a.kind !== 'free';

/** For each approach, by position: what is blue in it. A free approach has nothing blue. */
export function blueOf(approaches: readonly Approach[]): Blue[] {
  const lanesOnes = approaches.filter(isLanes);
  // With one drawing of lanes there is nothing to compare it with.
  if (lanesOnes.length < 2) return approaches.map(() => NO_BLUE);
  return approaches.map((a, i) => {
    if (!isLanes(a)) return NO_BLUE;
    const others = approaches.filter((o, j): o is LanesApproach => j !== i && isLanes(o));
    const lanes = new Set(others.flatMap((o) => o.lanes.map(laneKey)));
    const steps = new Set(others.flatMap((o) => o.steps.map(stepKey)));
    const flows = new Set(others.flatMap((o) => (o.flows ?? []).map(flowKey)));
    return {
      lanes: new Set(a.lanes.filter((l) => !lanes.has(laneKey(l))).map((l) => l.id)),
      steps: new Set(a.steps.filter((s) => !steps.has(stepKey(s))).map((s) => s.id)),
      flows: new Set((a.flows ?? []).flatMap((f, k) => (flows.has(flowKey(f)) ? [] : [k]))),
    };
  });
}
