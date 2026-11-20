import type { BoardState, Id, PartState } from '@keel/protocol';
import { isMark, liveParts, pictureTitle } from '@keel/protocol';
import { StateChip, Star } from '@keel/pictures';
import { keyWords } from './input/keytable';
import { followers } from './marks';

/**
 * The focus view: one part or one lane, opened. It is the focus picture the agent drew, shown
 * large over the dimmed board, with a crumb that says where it sits. It is the same board, so
 * every tool works in it, and a mark made on it hangs on the focus picture's subs.
 */

/** What the owner tapped to open: a part or a lane, and the picture it was tapped on. */
export interface Want {
  item?: Id;
  part?: Id;
  lane?: Id;
}

/** The part or lane by its plain name: "the bridge", "Runner". */
export function wantName(state: BoardState, want: Want): string {
  if (want.part) return state.model.parts[want.part]?.name ?? want.part;
  if (want.lane) {
    const name = state.model.lanes.find((l) => l.id === want.lane)?.name ?? want.lane;
    return /^the /i.test(name) ? `the ${name.slice(4)}` : name;
  }
  return 'it';
}

/** What the crumb says: where the focus came from, what is open, its state, and its size. */
export interface Crumb {
  back: string;
  name: string;
  state?: PartState | 'outside';
  count?: string;
}

export function crumbOf(state: BoardState, focus: Id): Crumb | undefined {
  const s = state.items[focus];
  if (!s || s.item.kind !== 'picture' || s.item.picture.kind !== 'focus') return undefined;
  const p = s.item.picture;
  const from = s.item.from?.map((id) => state.items[id]?.item).find((it) => it?.kind === 'picture');
  const back = from?.kind === 'picture' ? (from.picture.kind === 'pipeline' ? 'Pipeline' : pictureTitle(from.picture)) : 'The board';
  if (p.part) {
    const part = state.model.parts[p.part];
    return { back, name: part?.name ?? p.title ?? p.part, ...(part ? { state: part.external ? 'outside' : part.state } : {}) };
  }
  if (p.lane) {
    const lane = state.model.lanes.find((l) => l.id === p.lane);
    const parts = liveParts(state).filter((x) => x.lane === p.lane);
    const looks = new Set(parts.map((x) => (x.external ? 'outside' : x.state)));
    return {
      back,
      name: lane?.name ?? p.title ?? p.lane,
      ...(looks.size === 1 ? { state: [...looks][0]! } : {}),
      count: `${parts.length} ${parts.length === 1 ? 'part' : 'parts'}`,
    };
  }
  return { back, name: pictureTitle(p) };
}

/**
 * What stays above the dim in the focus view: the focus picture, the marks that hang on it
 * (and on those), the marks made while it was open, and the pictures that answer any of them
 * or were placed beside them, with their own marks.
 */
export function raisedOf(state: BoardState, focus: Id, made: Iterable<Id> = []): Set<Id> {
  const out = new Set<Id>([focus, ...followers(state, focus)]);
  for (const id of made) if (state.items[id] && !state.items[id]!.removed) out.add(id);
  for (let pass = 0; pass < 3; pass++) {
    const before = out.size;
    for (const id of state.itemOrder) {
      const s = state.items[id];
      if (!s || s.removed || out.has(id)) continue;
      const it = s.item;
      if (it.kind === 'picture') {
        const near = it.place?.near;
        const answers = (it.answers ?? []).some((a) => out.has(a) && state.items[a] && isMark(state.items[a]!.item));
        if ((near && out.has(near)) || answers) {
          out.add(id);
          for (const f of followers(state, id)) out.add(f);
        }
      } else if (it.anchor && out.has(it.anchor.item)) out.add(id);
    }
    if (out.size === before) break;
  }
  return out;
}

export function FocusCrumb({ crumb, onBack }: { crumb: Crumb; onBack: () => void }) {
  return (
    <nav className="chrome crumb" aria-label="Where this sits" data-testid="focus-crumb" data-viewport-ui="top">
      <button type="button" className="crumb__back" onClick={onBack} data-tip={`Back to the board (${keyWords('escape')})`}>
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M10 3 L5 8 L10 13" />
        </svg>
        {crumb.back}
      </button>
      <span className="crumb__sep" aria-hidden="true">
        /
      </span>
      <b className="crumb__name">{crumb.name}</b>
      {crumb.state && <StateChip state={crumb.state} />}
      <span className="crumb__note">{[crumb.count, 'Esc goes back'].filter(Boolean).join(' · ')}</span>
    </nav>
  );
}

/** Said while the agent draws a focus the owner asked for. It opens by itself when it arrives. */
export function OpeningNotice({ name, onStop }: { name: string; onStop: () => void }) {
  return (
    <div className="chrome crumb crumb--opening" role="status" data-testid="focus-opening" data-viewport-ui="top">
      <Star />
      <span>
        The agent is opening <b>{name}</b>
      </span>
      <span className="presence-sign presence-sign--drawing" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <button type="button" className="crumb__stop" aria-label="Stop waiting" data-tip="Stop waiting: it stays on the board when it comes" onClick={onStop}>
        <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M3 3 L11 11 M11 3 L3 11" />
        </svg>
      </button>
    </div>
  );
}
