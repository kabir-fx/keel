import type { BoardState, Box, Id, Markings, PictureItem } from '@keel/protocol';
import type { PictureAct } from '@keel/pictures';
import { Picture, StateChip } from '@keel/pictures';
import type { ReactNode } from 'react';
import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { unionBox } from './camera/camera';
import { MarkView } from './items';
import type { StoryChapter } from './story';
import { itemWords, projectProgress, storyOf, when } from './story';

/**
 * The Story (storyboard screen 7): every idea as a chapter, newest first, with its moments as
 * small live drawings; the whole pipeline in its states; the project's progress; and a note
 * that starts the next idea. A press on a chapter or a moment goes to it on the board.
 */

export interface StoryProps {
  state: BoardState;
  boxOf: (id: Id) => Box | undefined;
  markings: Record<Id, Markings>;
  isOwner: boolean;
  /** Go to these items on the board. */
  onGo: (ids: readonly Id[]) => void;
  /** A press on a part of the whole pipeline: open it on the board. */
  onPart: (part: Id) => void;
  /** Start the next idea with this note. Resolves false when the board refused it. */
  onNextIdea: (text: string) => Promise<boolean>;
}

/** The whole project's model, drawn flat and live: it redraws when a part changes state. */
const WHOLE: PictureItem = {
  id: 'story-pipeline',
  kind: 'picture',
  picture: { kind: 'pipeline', title: 'Every part, in its state', caption: 'Every idea changes it. Press a part to open it on the board.', view: 'flat' },
};

export function Story({ state, boxOf, markings, isOwner, onGo, onPart, onNextIdea }: StoryProps) {
  const chapters = useMemo(() => storyOf(state), [state]);
  const progress = useMemo(() => projectProgress(state), [state]);
  const now = new Date();
  const onAct = (a: PictureAct) => {
    if (a.type === 'tap' && a.sub?.startsWith('part:')) onPart(a.sub.slice(5));
    else if (a.type === 'ask' && a.part) onPart(a.part);
  };
  return (
    <section className="story" data-testid="story" aria-label="The story">
      <div className="story__inner">
        <header className="story__head">
          <h2>The story so far</h2>
          <p>Every idea, newest first. Press a moment to go back to it on the board.</p>
        </header>
        <div className="story__chapters" data-testid="chapters">
          {chapters.map((c) => (
            <ChapterCard key={c.id} chapter={c} state={state} boxOf={boxOf} markings={markings} now={now} onGo={onGo} />
          ))}
        </div>
        <div className="story__row">
          <section className="story__whole" aria-label="The whole pipeline, as it stands">
            <h2>The whole pipeline, as it stands</h2>
            <div className="story__pipeline" data-testid="whole-pipeline">
              <FitWidth>
                <Picture item={WHOLE} state={state} view={{}} onAct={onAct} />
              </FitWidth>
            </div>
          </section>
          <aside className="story__side">
            <Meter label="parts built here" testId="progress-parts" built={progress.parts.built} total={progress.parts.total} big />
            {progress.already > 0 && (
              <p className="story__already" data-testid="progress-already" data-n={progress.already}>
                {progress.already === 1 ? '1 more part was' : `${progress.already} more parts were`} already in the repository before the board. Nothing was built for {progress.already === 1 ? 'it' : 'them'} here.
              </p>
            )}
            <Meter label={progress.chapters.total === 1 ? 'idea built' : 'ideas built'} testId="progress-chapters" built={progress.chapters.built} total={progress.chapters.total} />
            <p className="story__legend-note">The legend under the pipeline says what each look means.</p>
            {isOwner && <NextIdea onNextIdea={onNextIdea} />}
          </aside>
        </div>
      </div>
    </section>
  );
}

/** Shrink what is inside to the width there is, never grow it: the whole pipeline reads at a glance. */
function FitWidth({ children }: { children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<{ k: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const o = outer.current;
    const i = inner.current;
    if (!o || !i || typeof ResizeObserver === 'undefined') return;
    const look = () => {
      // A transform does not change the offset sizes: they stay the natural ones.
      const w = i.offsetWidth;
      const h = i.offsetHeight;
      const room = o.clientWidth;
      if (w <= 0 || room <= 0) return;
      const k = Math.min(1, room / w);
      setFit((prev) => (prev && Math.abs(prev.k - k) < 0.005 && Math.abs(prev.h - h * k) < 1 ? prev : { k, h: h * k }));
    };
    look();
    const ro = new ResizeObserver(look);
    ro.observe(o);
    ro.observe(i);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={outer} className="fit-width" style={fit ? { height: fit.h } : undefined}>
      <div ref={inner} className="fit-width__inner" style={fit && fit.k < 1 ? { transform: `scale(${fit.k})` } : undefined}>
        {children}
      </div>
    </div>
  );
}

function Meter({ label, built, total, testId, big = false }: { label: string; built: number; total: number; testId: string; big?: boolean }) {
  return (
    <div className={big ? 'meter meter--big' : 'meter'} data-testid={testId} data-built={built} data-total={total}>
      <p className="meter__words">
        <b>
          {built} of {total}
        </b>{' '}
        {label}
      </p>
      <div className="meter__bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={built}>
        <span style={{ width: `${total > 0 ? (100 * built) / total : 0}%` }} />
      </div>
    </div>
  );
}

function NextIdea({ onNextIdea }: { onNextIdea: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    const ok = await onNextIdea(t);
    setBusy(false);
    if (ok) setText('');
  };
  return (
    <form
      className="next-idea"
      data-testid="next-idea"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="next-idea__label" htmlFor="next-idea-text">
        Start the next idea
      </label>
      <textarea
        id="next-idea-text"
        className="next-idea__note"
        value={text}
        maxLength={2000}
        rows={3}
        placeholder="Write it as you would on the board"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <div className="next-idea__foot">
        <span>It goes on the board, clear of everything there, and the agent starts on it.</span>
        <button type="submit" className="watch__btn watch__btn--dark" disabled={busy || !text.trim()}>
          Start it
        </button>
      </div>
    </form>
  );
}

function ChapterCard({ chapter: c, state, boxOf, markings, now, onGo }: { chapter: StoryChapter; state: BoardState; boxOf: StoryProps['boxOf']; markings: StoryProps['markings']; now: Date; onGo: StoryProps['onGo'] }) {
  const all = () => state.itemOrder.filter((id) => state.items[id] && !state.items[id]!.removed && state.items[id]!.chapter === c.id);
  const times = [`started ${when(c.openedAt, now)}`, c.builtAt ? `built ${when(c.builtAt, now)}` : undefined].filter(Boolean).join(' · ');
  const look = c.state === 'building' && c.paused ? 'paused' : c.state;
  return (
    <article className={`chapter chapter--${c.state}`} data-chapter={c.id} data-state={c.state}>
      <button type="button" className="chapter__head" onClick={() => onGo(all())} data-tip="Go to it on the board">
        <span className="chapter__title">
          <h3>{c.title}</h3>
          <StateChip state={c.state}>{look === 'paused' ? 'paused' : undefined}</StateChip>
        </span>
        <span className="chapter__when">{times}</span>
        {c.total > 0 ? (
          <span className="chapter__progress" data-testid="chapter-progress">
            <span>
              {c.built} of {c.total} parts built here
              {c.already > 0 ? ` · ${c.already} already there` : ''}
            </span>
            <span className="meter__bar meter__bar--small" aria-hidden="true">
              <span style={{ width: `${(100 * c.built) / c.total}%` }} />
            </span>
          </span>
        ) : (
          <span className="chapter__progress chapter__progress--none">{c.state === 'idea' ? 'Not decided yet' : 'Not built yet'}</span>
        )}
      </button>
      <ol className="chapter__moments" style={{ ['--cols' as string]: Math.max(1, Math.min(3, c.moments.length + c.main.length)) }}>
        {c.moments.map((m) => (
          <li key={m.id}>
            <button type="button" className="moment" data-moment={m.id} onClick={() => onGo(m.items)} data-tip={`Go to "${m.title}" on the board`}>
              <Thumb ids={m.items} state={state} boxOf={boxOf} markings={markings} />
              <span className="moment__title">
                {m.n} · {m.title}
              </span>
            </button>
          </li>
        ))}
        {c.main.map((id) => (
          <li key={id}>
            <button type="button" className="moment moment--main" data-main={id} onClick={() => onGo([id])} data-tip="Go to it on the board">
              <Thumb ids={[id]} state={state} boxOf={boxOf} markings={markings} />
              <span className="moment__title">{itemWords(state, id)}</span>
            </button>
          </li>
        ))}
      </ol>
    </article>
  );
}

const THUMB_W = 236;
const THUMB_H = 132;

/**
 * A small live drawing of some items, as they sit on the board now: the same renderers, scaled
 * down. It cannot be pressed through: the whole thumbnail is one button.
 */
export const Thumb = memo(function Thumb({ ids, state, boxOf, markings }: { ids: readonly Id[]; state: BoardState; boxOf: StoryProps['boxOf']; markings: StoryProps['markings'] }) {
  const placed = ids
    .map((id) => ({ id, s: state.items[id], b: boxOf(id) }))
    .filter((x): x is { id: Id; s: NonNullable<typeof x.s>; b: Box } => !!x.s && !x.s.removed && !!x.b && x.s.item.kind !== 'lasso');
  const u = unionBox(placed.map((x) => x.b));
  if (!u) return <span className="thumb thumb--empty" style={{ width: THUMB_W, height: THUMB_H }} aria-hidden="true" />;
  const s = Math.min(THUMB_W / Math.max(u[2], 1), THUMB_H / Math.max(u[3], 1), 0.6);
  const dx = (THUMB_W - u[2] * s) / 2;
  const dy = (THUMB_H - u[3] * s) / 2;
  return (
    <span className="thumb" style={{ width: THUMB_W, height: THUMB_H }} aria-hidden="true" data-thumb={ids.join(' ')}>
      <span className="thumb__world" style={{ width: u[2], height: u[3], transform: `translate(${dx}px, ${dy}px) scale(${s})` }}>
        {placed.map(({ id, s: st, b }) => {
          const at: Box = [b[0] - u[0], b[1] - u[1], b[2], b[3]];
          const it = st.item;
          if (it.kind === 'picture') {
            return (
              <span key={id} className="thumb__item" style={{ left: at[0], top: at[1] }}>
                <Picture item={it} state={state} markings={markings[id]} view={{}} />
              </span>
            );
          }
          return <MarkView key={id} item={it} shown={at} />;
        })}
      </span>
    </span>
  );
});
