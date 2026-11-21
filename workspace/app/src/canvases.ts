import type { BoardState, Id } from '@keel/protocol';
import { canvasBuilds, chapterInWorkOn, chaptersOn, seqOf } from '@keel/protocol';
import { canvasName } from './tryit';

/**
 * The canvases the owner is not looking at, as plain data: what happened on one since the
 * owner last had it in view, so they can tell from where they are and go there in one press.
 */

/** When the owner last had a canvas in view: the last event number then, and the time. */
export interface Seen {
  seq: number;
  at: string;
}

export interface Elsewhere {
  canvas: Id;
  name: string;
  /** What happened there, most pressing first: a problem, an idea built, new pictures. */
  what: 'problem' | 'built' | 'drew';
  /** One short line. */
  line: string;
}

/** What happened on every other canvas since the owner last saw it, newest canvas first. */
export function elsewhere(whole: BoardState, inView: Id | undefined, seen: (canvas: Id) => Seen): Elsewhere[] {
  const out: Elsewhere[] = [];
  for (let i = whole.canvasOrder.length - 1; i >= 0; i--) {
    const canvas = whole.canvasOrder[i]!;
    if (canvas === inView) continue;
    const since = seen(canvas);
    const here = new Set(chaptersOn(whole, canvas).map((c) => c.id));
    const name = canvasName(whole, canvas);
    const problem = whole.feed.some((f) => here.has(f.chapter) && f.kind === 'problem' && seqOf(f.id) > since.seq);
    const built = chaptersOn(whole, canvas).find((c) => c.state === 'built' && !c.merged && c.builtAt !== undefined && c.builtAt > since.at);
    const drew = whole.itemOrder.filter((id) => {
      const s = whole.items[id];
      return !!s && !s.removed && here.has(s.chapter) && s.by === 'agent' && s.item.kind === 'picture' && seqOf(s.event) > since.seq;
    }).length;
    if (problem) out.push({ canvas, name, what: 'problem', line: `The build on “${name}” needs you.` });
    else if (built) out.push({ canvas, name, what: 'built', line: `“${built.title}” is built, on “${name}”. Try it there.` });
    else if (drew > 0) out.push({ canvas, name, what: 'drew', line: `The agent drew ${drew === 1 ? 'a picture' : `${drew} pictures`} on “${name}”.` });
  }
  return out;
}

/**
 * True when everything on a canvas is built and merged: the next note there starts another
 * idea on the same branch, which the owner should know before they write it. While a build
 * waits to be tried and approved, that comes first, and the watch panel says it.
 */
export function allBuilt(state: BoardState, canvas: Id | undefined): boolean {
  if (!canvas || chaptersOn(state, canvas).length === 0) return false;
  const b = canvasBuilds(state, canvas);
  return chapterInWorkOn(state, canvas) === undefined && b.building.length === 0 && b.waiting.length === 0;
}
