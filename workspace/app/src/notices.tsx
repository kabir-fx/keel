import type { Elsewhere } from './canvases';
import type { BoardState, Box, HomeInfo, Id } from '@keel/protocol';
import { pictureTitle } from '@keel/protocol';
import { Star } from '@keel/pictures';
import { useState } from 'react';
import type { Camera } from './camera/camera';
import { useHeldBox } from './select/following';
import type { MovingStore } from './select/moving';
import type { Connection } from './source';
import { REOPEN } from './source';
import { homeLine } from './tryit';

/**
 * The quiet things the board says at the top of the screen: that the server is gone or has
 * refused this page, and that the agent drew something the owner cannot see from here.
 */

/* ------------------------------------------------------------ connection */

export function ConnectionNotice({ connection }: { connection: Connection }) {
  if (connection === 'refused') {
    return (
      <div className="notice notice--problem" role="alert" data-testid="connection" data-state="refused">
        <b>This page lost its place on the board.</b> {REOPEN.replace(/keel-board open$/, '')}
        <code className="notice__cmd">keel-board open</code>
      </div>
    );
  }
  if (connection === 'closed') {
    return (
      <div className="notice" role="status" data-testid="connection" data-state="closed">
        The board server is not reachable. The page reconnects by itself when it is back.
      </div>
    );
  }
  return null;
}

/* ----------------------------------------------------------------- nudge */

/** How much of `b` the screen rectangle `room` shows, from 0 to 1, with the camera `cam`. */
export function shownShare(b: Box, cam: Camera, room: Box): number {
  const x = b[0] * cam.z + cam.x;
  const y = b[1] * cam.z + cam.y;
  const w = b[2] * cam.z;
  const h = b[3] * cam.z;
  const iw = Math.max(0, Math.min(x + w, room[0] + room[2]) - Math.max(x, room[0]));
  const ih = Math.max(0, Math.min(y + h, room[1] + room[3]) - Math.max(y, room[1]));
  // A box with no size is seen when its corner is in the room.
  if (w <= 0 || h <= 0) return x >= room[0] && x <= room[0] + room[2] && y >= room[1] && y <= room[1] + room[3] ? 1 : 0;
  // A picture larger than the room counts as seen when it fills most of it.
  const area = Math.min(w * h, room[2] * room[3]);
  return (iw * ih) / area;
}

/** A picture counts as seen once this much of it is in the room the chrome leaves free. */
export const SEEN_SHARE = 0.5;

/** The new pictures the owner has not seen yet, oldest first, among those placed since the board opened. */
export function unseen(state: BoardState, known: ReadonlySet<Id>, seen: ReadonlySet<Id>, boxOf: (id: Id) => Box | undefined): Id[] {
  const out: Id[] = [];
  for (const id of state.itemOrder) {
    const s = state.items[id];
    if (!s || s.removed || s.item.kind !== 'picture' || known.has(id) || seen.has(id) || !boxOf(id)) continue;
    out.push(id);
  }
  return out;
}

/** "New from the agent": a button that goes to what it drew. It never moves the view by itself. */
export function Nudge({ ids, state, onGo }: { ids: readonly Id[]; state: BoardState; onGo: () => void }) {
  if (ids.length === 0) return null;
  const first = state.items[ids[0]!]?.item;
  const title = first?.kind === 'picture' ? pictureTitle(first.picture) : undefined;
  return (
    <button type="button" className="notice notice--nudge" data-testid="nudge" data-n={ids.length} onClick={onGo}>
      <Star />
      <span>
        {ids.length === 1 ? (
          <>
            <b>New from the agent:</b> {title ?? 'a picture'}
          </>
        ) : (
          <b>{ids.length} new from the agent</b>
        )}
      </span>
      <span className="notice__go">Show me</span>
    </button>
  );
}

/* ------------------------------------------------------------ other canvases */

/**
 * What happened on a canvas out of view: the agent drew there, an idea there is built, or its
 * build needs the owner. One press goes there. With news on several, the most recent canvas
 * is named and the rest are counted.
 */
export function ElsewhereNotice({ news, onGo }: { news: readonly Elsewhere[]; onGo: (canvas: Id) => void }) {
  const first = news[0];
  if (!first) return null;
  return (
    <div className={`notice notice--elsewhere notice--${first.what}`} role="status" data-testid="elsewhere" data-canvas={first.canvas} data-what={first.what}>
      <span>
        {first.line}
        {news.length > 1 ? ` And news on ${news.length - 1} more ${news.length === 2 ? 'canvas' : 'canvases'}, in the Story.` : ''}
      </span>
      <span className="notice__actions">
        <button type="button" className="notice__btn notice__btn--dark" data-testid="elsewhere-go" onClick={() => onGo(first.canvas)}>
          Go to “{first.name}”
        </button>
      </span>
    </div>
  );
}

/**
 * Everything on the canvas in view is built: a note written here starts another idea on the
 * same branch. Said before it is written, with the way to a separate one.
 */
export function CanvasDoneNotice({ branch, onNewCanvas }: { branch: string | undefined; onNewCanvas: () => void }) {
  return (
    <div className="notice notice--done" role="status" data-testid="canvas-done">
      <span>
        Everything on this canvas is built. A new note here starts another idea on {branch ? `its branch, ${branch}` : 'its branch'}, built together with the rest. For a separate
        idea, start a new canvas.
      </span>
      <span className="notice__actions">
        <button type="button" className="notice__btn" data-testid="canvas-done-new" onClick={onNewCanvas}>
          Start a new canvas
        </button>
      </span>
    </div>
  );
}

/* ------------------------------------------------------------ the home branch */

/**
 * The home branch needs the owner, or its remote did not answer: said once on the board, in
 * the server's words, with the way to the Story's home line. Nothing when all is well, or it
 * only has commits to push.
 */
export function homeNeeds(home: HomeInfo | undefined): string | undefined {
  if (!home || (home.sync !== 'behind' && home.sync !== 'diverged' && home.sync !== 'unreachable')) return undefined;
  return home.note ?? homeLine(home)?.words;
}

export function HomeNotice({ words, onShow, onDismiss }: { words: string; onShow: () => void; onDismiss: () => void }) {
  return (
    <div className="notice notice--home" role="status" data-testid="home-notice">
      <span>
        <b>Home branch.</b> {words}
      </span>
      <span className="notice__actions">
        <button type="button" className="notice__btn" data-testid="home-notice-show" onClick={onShow}>
          Show it in the Story
        </button>
        <button type="button" className="notice__btn notice__btn--quiet" data-testid="home-notice-dismiss" aria-label="Dismiss this notice" onClick={onDismiss}>
          Dismiss
        </button>
      </span>
    </div>
  );
}

/* ------------------------------------------------------------ not made here */

/**
 * Items on the board that came with the log from outside. The owner sees how many, can bring
 * them into view, and keeps them when they are theirs. Until then the agent leaves them alone.
 */
export function ForeignNotice({ n, words, onShow, onKeep }: { n: number; words: string; onShow: () => void; onKeep: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  if (n === 0) return null;
  return (
    <div className="notice notice--foreign" role="status" data-testid="foreign" data-n={n}>
      <span>{words}</span>
      <span className="notice__actions">
        <button type="button" className="notice__btn" onClick={onShow}>
          Show them
        </button>
        <button
          type="button"
          className="notice__btn notice__btn--dark"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onKeep();
            } finally {
              setBusy(false);
            }
          }}
        >
          Keep them
        </button>
      </span>
    </div>
  );
}

/** The quiet tag on each item that was not made on this machine, at its top-right corner. It stays there while the owner's hand moves the item or resizes it (`moving`). */
export function ForeignTags({ ids, boxOf, moving }: { ids: readonly Id[]; boxOf: (id: Id) => Box | undefined; moving: MovingStore }) {
  return (
    <>
      {ids.map((id) => {
        const b = boxOf(id);
        return b ? <ForeignTag key={id} id={id} rest={b} moving={moving} /> : null;
      })}
    </>
  );
}

/** One tag, at the corner of its item where that is drawn now. */
function ForeignTag({ id, rest, moving }: { id: Id; rest: Box; moving: MovingStore }) {
  const b = useHeldBox(moving, id, rest);
  return (
    <span className="foreign-tag" data-foreign={id} style={{ left: b[0] + b[2], top: b[1] }} aria-label="not made here">
      not made here
    </span>
  );
}
