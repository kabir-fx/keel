import type { WalkPicture } from '@keel/protocol';
import { useEffect, useRef, useState } from 'react';
import { asPart } from './build';
import { Star, tapper, wholeClass } from './parts';
import type { PictureProps } from './types';
import { NO_MARKINGS } from './types';

/** How long the player stays on a step. */
export const PLAY_MS = 1600;

const Chevron = ({ back }: { back?: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d={back ? 'M10 3 L5 8 L10 13' : 'M6 3 L11 8 L6 13'} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const PlayIcon = ({ playing }: { playing: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    {playing ? <path d="M3 2 H5.5 V12 H3 Z M8.5 2 H11 V12 H8.5 Z" fill="currentColor" /> : <path d="M3 1.5 L12 7 L3 12.5 Z" fill="currentColor" />}
  </svg>
);

/**
 * The step player for one walk of the board's model. Back, play and next; the list of steps,
 * each a tap target "step:<n>". The step being played belongs to the owner's view: every
 * move tells the board with `walk.step`, and every picture that shows the walk lights the
 * same step. Until the board hands a step back, the player keeps its own.
 */
export function WalkCard({ item, state, markings, view, onAct }: PictureProps & { item: { picture: WalkPicture } }) {
  const p = item.picture;
  const m = markings ?? NO_MARKINGS;
  const walk = state.model.walks[p.walk];
  const [own, setOwn] = useState(0);
  const [playing, setPlaying] = useState(false);
  const step = view?.walk?.id === p.walk ? view.walk.step : own;
  const ns = walk ? [...walk.steps].sort((a, b) => a.n - b.n).map((s) => s.n) : [];
  const at = ns.indexOf(step);
  const stepRef = useRef(step);
  stepRef.current = step;

  const go = (n: number) => {
    stepRef.current = n;
    setOwn(n);
    onAct?.({ type: 'walk.step', walk: p.walk, step: n });
  };
  const next = () => {
    const i = ns.indexOf(stepRef.current);
    const n = ns[i + 1];
    if (n !== undefined) go(n);
    return n !== undefined;
  };

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      if (!next()) setPlaying(false);
    }, PLAY_MS);
    return () => clearInterval(t);
    // `next` reads the step from a ref, so the timer need not restart on each step.
  }, [playing]);

  const tap = tapper(item.id, m, onAct);
  if (!walk) {
    return (
      <article className={`kp kp-sheet kp-walk${wholeClass(m)}`} {...asPart('frame')} data-kind="walk" style={{ width: 400 }}>
        <h3 className="kp-card__head" {...asPart('head')}>
          <Star />
          <span>{p.title ?? p.walk}</span>
        </h3>
        <p className="kp-caption" {...asPart('block')}>This walk is not in the model any more.</p>
      </article>
    );
  }
  const atEnd = at === ns.length - 1;
  return (
    <article className={`kp kp-sheet kp-walk${wholeClass(m)}`} {...asPart('frame')} data-kind="walk" data-step={step || undefined} style={{ width: 420 }}>
      <h3 className="kp-card__head" {...asPart('head')}>
        <Star />
        <span>{p.title ?? walk.name}</span>
        <span className="kp-walk__id">{walk.id}</span>
      </h3>
      <div className="kp-walk__controls" {...asPart('block')}>
        <button type="button" className="kp-btn kp-btn--icon" aria-label="Back one step" disabled={at <= 0} onClick={(e) => (e.stopPropagation(), go(ns[at - 1]!))}>
          <Chevron back />
        </button>
        <button
          type="button"
          className="kp-btn kp-btn--icon kp-btn--teal"
          aria-label={playing ? 'Pause' : 'Play'}
          aria-pressed={playing}
          onClick={(e) => {
            e.stopPropagation();
            if (playing) setPlaying(false);
            else {
              if (atEnd || at < 0) go(ns[0]!);
              setPlaying(true);
            }
          }}
        >
          <PlayIcon playing={playing} />
        </button>
        <button type="button" className="kp-btn kp-btn--icon" aria-label="Next step" disabled={atEnd} onClick={(e) => (e.stopPropagation(), next())}>
          <Chevron />
        </button>
        <span className="kp-walk__bar" aria-hidden="true">
          {ns.map((n, i) => (
            <span key={n} className={`kp-walk__seg${at >= 0 && i < at ? ' kp-walk__seg--done' : ''}${i === at ? ' kp-walk__seg--now' : ''}`} />
          ))}
        </span>
        <span className="kp-walk__count">{at >= 0 ? `${at + 1} of ${ns.length}` : `${ns.length} steps`}</span>
      </div>
      <ol className="kp-walk__steps">
        {[...walk.steps]
          .sort((a, b) => a.n - b.n)
          .map((s) => {
            const sub = `step:${s.n}`;
            const now = s.n === step;
            const ahead = at >= 0 && s.n > step;
            return (
              <li
                key={s.n}
                {...tap(sub, `kp-walk__step${now ? ' kp-walk__step--now' : ''}${ahead ? ' kp-walk__step--ahead' : ''}`)}
                {...asPart('block')}
                aria-current={now ? 'step' : undefined}
              >
                <span className="kp-dot">{s.n}</span>
                <span>{s.text}</span>
              </li>
            );
          })}
      </ol>
    </article>
  );
}
