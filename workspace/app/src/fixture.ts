import type { BoardEvent, Checkpoint, Id, PresenceUpdate } from '@keel/protocol';
import { parseLog } from '@keel/protocol';
import type { PictureView } from '@keel/pictures';

/**
 * Fixtures: a board log with checkpoints, replayed with no server and no agent.
 * The golden fixture lives in the protocol package. The app keeps a small sample of its own.
 * A fixture of the protocol wins over the app's own one of the same name.
 */

const LOGS = {
  ...import.meta.glob<string>('./fixtures/*/log.jsonl', { query: '?raw', import: 'default' }),
  ...import.meta.glob<string>('../../protocol/fixtures/*/log.jsonl', { query: '?raw', import: 'default' }),
};
const CHECKPOINTS = {
  ...import.meta.glob<Checkpoint[]>('./fixtures/*/checkpoints.json', { import: 'default' }),
  ...import.meta.glob<Checkpoint[]>('../../protocol/fixtures/*/checkpoints.json', { import: 'default' }),
};

const nameOf = (path: string) => /fixtures\/([^/]+)\/[^/]+$/.exec(path)?.[1];

function byName<T>(files: Record<string, () => Promise<T>>): Map<string, () => Promise<T>> {
  const out = new Map<string, () => Promise<T>>();
  // The protocol's fixtures come last in the spread above, and the protocol path sorts after
  // the app's, so a later entry of the same name replaces an earlier one.
  for (const [path, load] of Object.entries(files)) {
    const name = nameOf(path);
    if (name) out.set(name, load);
  }
  return out;
}

export function fixtureNames(): string[] {
  return [...byName(LOGS).keys()].sort();
}

export interface Fixture {
  name: string;
  events: BoardEvent[];
  checkpoints: Checkpoint[];
  problems: string[];
}

export async function loadFixture(name: string): Promise<Fixture | undefined> {
  const log = byName(LOGS).get(name);
  if (!log) return undefined;
  const text = await log();
  const { events, problems } = parseLog(text);
  const cps = byName(CHECKPOINTS).get(name);
  const checkpoints = cps ? await cps() : [];
  return { name, events, checkpoints, problems: problems.map((p) => `line ${p.line}: ${p.reason}`) };
}

/** The events up to a checkpoint, and the checkpoint. With no `at`, the whole log. */
export function cutAt(fx: Fixture, at: number | undefined): { events: BoardEvent[]; checkpoint?: Checkpoint } {
  if (at === undefined) return { events: fx.events };
  const checkpoint = fx.checkpoints.find((c) => c.screen === at) ?? fx.checkpoints[at - 1];
  if (!checkpoint) return { events: fx.events };
  const i = fx.events.findIndex((e) => e.id === checkpoint.after);
  return { events: i >= 0 ? fx.events.slice(0, i + 1) : fx.events, checkpoint };
}

/** What the app opens with at a checkpoint: what the owner was looking at then. */
export interface Opening {
  mode: 'board' | 'story';
  /** Fit the first view to these items. */
  show?: Id[];
  /** The focus picture that is open. */
  focus?: Id;
  /** The walk's step and the pipeline's view, handed to every picture. */
  view: PictureView;
  presence?: PresenceUpdate;
}

/** A checkpoint's view as the app's first view. None of it is in the log. */
export function openingOf(checkpoint: Checkpoint | undefined): Opening {
  const v = checkpoint?.view;
  const view: PictureView = {};
  if (v?.pipeline) view.pipeline = v.pipeline;
  if (v?.walk) view.walk = { ...v.walk };
  return {
    mode: v?.mode ?? 'board',
    ...(v?.show ? { show: [...v.show] } : {}),
    ...(v?.focus ? { focus: v.focus } : {}),
    view,
    ...(v?.presence ? { presence: v.presence } : {}),
  };
}
