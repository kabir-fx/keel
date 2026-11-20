import type { BoardState, Id } from '@keel/protocol';
import { Star, StateChip } from '@keel/pictures';
import { useLayoutEffect, useRef, useState } from 'react';
import type { Draft } from './drafts';
import type { PostResult } from './source';
import type { FeedLine, ServerBuild } from './watch';
import { buildStatus, feedOf, goesOn, reopenedParts, trackOf } from './watch';

/**
 * Watching a build (storyboard screen 6), drawn: the build track, the feed, Pause and Resume, what
 * the server says about the build, and a line that says the owner can leave. It shows while
 * the chapter in view builds or is built, and folds away to one line.
 */

/** How many of the remarks the builder will follow the panel lists before "and N more". */
export const REMARKS_SHOWN = 5;

export interface WatchProps {
  state: BoardState;
  chapter: Id;
  /** What the server says about the build it drives. */
  server?: ServerBuild | undefined;
  isOwner: boolean;
  folded: boolean;
  onFold: (folded: boolean) => void;
  post: (draft: Draft) => Promise<PostResult>;
  /** True when the browser will tell the owner, while away, that something needs them. */
  notifies?: boolean;
  /** Show a part on the board. */
  onPart?: (part: Id) => void;
}

export function Watch({ state, chapter, server, isOwner, folded, onFold, post, notifies = false, onPart }: WatchProps) {
  const c = state.chapters[chapter];
  const track = trackOf(state, chapter);
  const status = buildStatus(state, chapter, server);
  const lines = feedOf(state, chapter);
  const reopened = reopenedParts(state, chapter);
  const [busy, setBusy] = useState(false);
  const [lit, setLit] = useState<string>();
  const feedRef = useRef<HTMLOListElement>(null);

  // Newest last: keep the newest in view as the feed grows.
  useLayoutEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length, folded]);

  if (!c || (c.state !== 'building' && c.state !== 'built') || !status) return null;
  const building = c.state === 'building';

  const act = async (draft: Draft) => {
    setBusy(true);
    try {
      await post(draft);
    } finally {
      setBusy(false);
    }
  };

  const showProblem = (id: string) => {
    onFold(false);
    setLit(id);
    requestAnimationFrame(() => feedRef.current?.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' }));
    setTimeout(() => setLit((x) => (x === id ? undefined : x)), 2400);
  };

  /**
   * Resume where the build was not agreed on this machine: the owner's agreement to run the
   * check here. A build that is not paused is paused first, so Resume is a real resume.
   */
  const agree = async () => {
    setBusy(true);
    try {
      if (!c.paused) {
        const r = await post({ type: 'build.pause', chapter });
        if (!r.ok) return;
      }
      await post({ type: 'build.resume', chapter });
    } finally {
      setBusy(false);
    }
  };

  const unagreed = status.state === 'unagreed';
  const pause =
    building && isOwner && !unagreed ? (
      c.paused ? (
        <button type="button" className="watch__btn watch__btn--go" disabled={busy} onClick={() => void act({ type: 'build.resume', chapter })}>
          Resume
        </button>
      ) : (
        <button type="button" className="watch__btn" disabled={busy} onClick={() => void act({ type: 'build.pause', chapter })}>
          Pause
        </button>
      )
    ) : null;

  return (
    <aside className={`chrome watch${folded ? ' watch--folded' : ''}`} data-testid="watch" data-viewport-ui={folded ? 'top' : 'side'} data-state={status.state} data-chapter={chapter} aria-label={`The build of ${c.title}`}>
      <header className="watch__head">
        <Star />
        <h2 className="watch__title">The build</h2>
        {track && (
          <span className="watch__where" data-testid="watch-where">
            {track.words}
          </span>
        )}
        <span className="watch__grow" />
        {pause}
        <button
          type="button"
          className="watch__fold"
          aria-expanded={!folded}
          aria-label={folded ? 'Show the build' : 'Fold the build away'}
          data-tip={folded ? 'Show the build' : 'Fold the build away'}
          onClick={() => onFold(!folded)}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path d={folded ? 'M4 6 L8 10 L12 6' : 'M4 10 L8 6 L12 10'} />
          </svg>
        </button>
      </header>
      {!folded && (
        <div className="watch__body">
          <p className={`watch__status watch__status--${status.state}`} data-testid="watch-status" role="status">
            {status.words}
            {status.problem && (
              <>
                {' '}
                <button type="button" className="watch__link" onClick={() => showProblem(status.problem!)}>
                  See why in the feed
                </button>
              </>
            )}
          </p>
          {unagreed && (
            <div className="watch__agree" data-testid="watch-agree">
              {status.check ? <code className="watch__check">{status.check}</code> : <p>The board names no check for it.</p>}
              {status.remarks && status.remarks.length > 0 && (
                <div className="watch__remarks" data-testid="watch-remarks">
                  <p>The builder will also follow these remarks on the parts:</p>
                  <ul>
                    {status.remarks.slice(0, REMARKS_SHOWN).map((r, i) => (
                      <li key={i}>
                        <b>{r.part}:</b> {r.text}
                      </li>
                    ))}
                  </ul>
                  {status.remarks.length > REMARKS_SHOWN && <p className="watch__more">and {status.remarks.length - REMARKS_SHOWN} more, on the board</p>}
                </div>
              )}
              {isOwner && (
                <button type="button" className="watch__btn watch__btn--dark" disabled={busy} onClick={() => void agree()}>
                  Resume
                </button>
              )}
            </div>
          )}
          {building && reopened.length > 0 && (
            <div className="watch__reopened" data-testid="watch-reopened">
              <p>
                <b>The build waits for you.</b> {reopened.length === 1 ? 'A decided part is an idea again' : `${reopened.length} decided parts are ideas again`}: nothing more is built until
                you decide.
              </p>
              <ul>
                {reopened.map((id) => (
                  <li key={id}>
                    <span>{state.model.parts[id]?.name ?? id}</span>
                    {isOwner && (
                      <button
                        type="button"
                        className="watch__btn watch__btn--dark"
                        disabled={busy}
                        aria-label={`Solidify this part: ${state.model.parts[id]?.name ?? id}`}
                        onClick={() => void act({ type: 'part.state', part: id, state: 'solid' })}
                      >
                        Solidify this part
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {track && (
            <ol className="watch__track" aria-label="The build track" data-testid="track">
              {track.parts.map((p) => (
                <li key={p.id} data-part={p.id} data-state={p.state} data-now={p.now ? '' : undefined}>
                  <button type="button" className="watch__part" onClick={() => onPart?.(p.id)} data-tip={p.commit ? `${p.name}: built in ${p.commit}` : p.name}>
                    <StateChip state={p.state}>
                      {p.state === 'built' && !p.shelf ? '✓ ' : ''}
                      {p.n} {p.name}
                      {p.now ? ' · now' : ''}
                      {p.shelf ? ' · already there' : ''}
                    </StateChip>
                  </button>
                </li>
              ))}
            </ol>
          )}
          <ol className="watch__feed" ref={feedRef} aria-label="Updates, newest last" data-testid="feed">
            {lines.length === 0 && <li className="feed__empty">Nothing yet. The first update comes with the first part.</li>}
            {lines.map((l) => (
              <FeedRow key={l.id} line={l} lit={lit === l.id} />
            ))}
          </ol>
          {building && goesOn(status) && (
            <p className="watch__leave" data-testid="watch-leave">
              <b>You can leave.</b>{' '}
              {notifies
                ? 'The build goes on without you, and this tab tells you when something needs you.'
                : 'The build goes on without you. Everything it does stays on the board.'}
            </p>
          )}
        </div>
      )}
    </aside>
  );
}

function FeedRow({ line, lit }: { line: FeedLine; lit: boolean }) {
  return (
    <li className={`feed__line feed__line--${line.kind}${lit ? ' feed__line--lit' : ''}`} data-id={line.id} data-kind={line.kind}>
      <time className="feed__time">{line.time}</time>
      <div className="feed__said">
        <span className="feed__text">{line.text}</span>
        {(line.commit || line.check) && (
          <span className="feed__proof">
            {line.commit && <code className="feed__commit">{line.commit}</code>}
            {line.check && (
              <span className={`feed__check feed__check--${line.check.passed ? 'passed' : 'failed'}`}>
                {line.check.cmd} · {line.check.passed ? 'passed' : 'failed'}
              </span>
            )}
          </span>
        )}
      </div>
    </li>
  );
}
