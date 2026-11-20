import type { BoardState, PictureSpec, Target } from '@keel/protocol';
import { APPROACH_LETTERS, approachIndex, isMark, subId, subKind, targetsOf } from '@keel/protocol';

/**
 * Plain words for a thing on the board, so a blueprint can say where each pick came from:
 * "your circle on A", "your note on the model step".
 */

function inPicture(p: PictureSpec, sub: string): string | undefined {
  const kind = subKind(sub);
  const id = subId(sub);
  switch (p.kind) {
    case 'spread': {
      if (kind === 'approach') {
        const i = approachIndex(id);
        return i >= 0 ? (APPROACH_LETTERS[i] ?? id.toUpperCase()) : undefined;
      }
      if (kind === 'step') {
        const dash = id.indexOf('-');
        const a = p.approaches[approachIndex(id.slice(0, dash))];
        const stepId = id.slice(dash + 1);
        if (a && a.kind !== 'free') {
          const s = a.steps.find((x) => x.id === stepId);
          if (s) return `the ${s.text}`;
        }
      }
      return undefined;
    }
    case 'lanes':
      if (kind === 'step') return p.steps.find((s) => s.id === id)?.text;
      if (kind === 'lane') return p.lanes.find((l) => l.id === id)?.name;
      return undefined;
    case 'focus':
      if (kind === 'option') return p.options?.items.find((o) => o.id === id)?.name;
      return undefined;
    case 'choice':
      if (kind === 'option') return p.options.find((o) => o.id === id)?.label;
      return undefined;
    case 'shelf':
      if (kind === 'tile') return p.tiles.find((t) => t.id === id)?.name;
      return undefined;
    case 'mini':
      if (kind === 'box') return p.boxes[Number(id) - 1]?.text;
      return undefined;
    case 'walk':
      if (kind === 'step') return `step ${id}`;
      return undefined;
    case 'text':
      if (kind === 'q') return `question ${id}`;
      return undefined;
    case 'blueprint':
      if (kind === 'pick') return p.picks[Number(id) - 1]?.text;
      return undefined;
    default:
      return undefined;
  }
}

/** How many marks the words for a target look through to reach a picture: a note on a circle on a card is two. */
const MARKS_THROUGH = 2;

/**
 * The most items the words for one pick's source read, one after the other: the owner's mark
 * the pick came from, the marks looked through, and what the last of them is on. Whoever must
 * know when those words change (the board, to draw a blueprint again) follows this many.
 */
export const SOURCE_CHAIN = MARKS_THROUGH + 2;

/** The words for a target: the thing inside a picture, or the picture, or a mark. */
export function describeTarget(state: BoardState, t: Target, depth = 0): string | undefined {
  const s = state.items[t.item];
  if (!s) return undefined;
  if (t.sub) {
    const kind = subKind(t.sub);
    const id = subId(t.sub);
    if (kind === 'part') return state.model.parts[id]?.name ?? id;
    if (kind === 'lane') {
      const lane = state.model.lanes.find((l) => l.id === id);
      if (lane) return lane.name;
    }
    if (s.item.kind === 'picture') {
      const w = inPicture(s.item.picture, t.sub);
      if (w) return w;
    }
  }
  const item = s.item;
  if (item.kind === 'picture') {
    const p = item.picture;
    return 'title' in p && p.title ? p.title : p.kind;
  }
  if (depth >= MARKS_THROUGH) return undefined;
  const on = targetsOf(item)[0];
  return on ? describeTarget(state, on, depth + 1) : undefined;
}

const MARK_WORD: Record<string, string> = {
  note: 'note',
  box: 'box',
  arrow: 'arrow',
  pin: 'pin',
  lasso: 'lasso',
  file: 'file',
  voice: 'words',
};

/** Where a pick came from, and whether the owner made it. */
export function sourceOf(state: BoardState, from: Target | undefined): { text: string; owner: boolean } | undefined {
  if (!from) return undefined;
  const s = state.items[from.item];
  if (!s) return undefined;
  const item = s.item;
  if (s.by === 'owner' && isMark(item)) {
    const word = item.kind === 'ink' ? (item.hint === 'circle' ? 'circle' : item.hint === 'cross' ? 'cross' : 'drawing') : (MARK_WORD[item.kind] ?? item.kind);
    const on = targetsOf(item)[0];
    const what = on ? describeTarget(state, on) : undefined;
    return { text: what ? `from your ${word} on ${what}` : `from your ${word}`, owner: true };
  }
  const what = describeTarget(state, from);
  // An agent picture is named by its title, in quotes, so it reads as a name mid-sentence.
  const named = !from.sub && item.kind === 'picture' && what ? `“${what}”` : what;
  return { text: named ? `from ${named}` : 'from the board', owner: false };
}
