import type { BoardState, Box, CanvasWork, HomeInfo, Id, Markings, PictureItem, ShowInfo } from '@keel/protocol';
import type { PictureAct } from '@keel/pictures';
import { Picture, StateChip } from '@keel/pictures';
import type { ReactNode } from 'react';
import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ApproveBlock, Said } from './Approve';
import { unionBox } from './camera/camera';
import { ConfirmDialog } from './Confirm';
import type { ReadAsset } from './assetUrl';
import type { Draft } from './drafts';
import { MarkView } from './items';
import type { PostResult, Reply } from './source';
import type { StoryChapter } from './story';
import { itemWords, projectProgress, storyOf, when } from './story';
import type { CanvasCard as Card } from './tryit';
import { canvasCard, deleteWords, heldWhy, homeLine, homeName, remoteOf, tryLabel } from './tryit';
import type { ServerBuild } from './watch';

/**
 * The Story (storyboard screen 7): every canvas, newest first, each with its idea or ideas and
 * their moments as small live drawings; the whole pipeline in its states; the project's
 * progress. A press on a moment goes to it on its canvas.
 *
 * On top, the home branch (record 0014). A canvas owns a branch: its card says each idea's
 * state in words, the branch, and what can be done now: Open, Try it for each built idea,
 * Approve, Delete. "Start a new canvas" is the way to a new branch.
 */

export interface StoryProps {
  /** The whole board: every canvas. */
  state: BoardState;
  boxOf: (id: Id) => Box | undefined;
  markings: Record<Id, Markings>;
  isOwner: boolean;
  /** Go to these items on the board. */
  onGo: (ids: readonly Id[]) => void;
  /** Show a canvas on the board. */
  onOpen: (canvas: Id) => void;
  /** A press on a part of the whole pipeline: open it on the board. */
  onPart: (part: Id) => void;
  /** Start a new, blank canvas and go to it. Resolves with the reason when the board refused it. */
  onNewCanvas: () => Promise<string | undefined>;
  /** What this machine's repository holds for each canvas. */
  works?: ReadonlyMap<string, CanvasWork>;
  /** What the owner can try of each built idea now. */
  shows?: ReadonlyMap<string, ShowInfo>;
  home?: HomeInfo | undefined;
  /** What the server says about the build it drives. */
  server?: ServerBuild | undefined;
  /** Open an idea's try room. */
  onTry?: (chapter: Id) => void;
  post?: ((draft: Draft) => Promise<PostResult>) | undefined;
  /** Delete a canvas, once the owner said yes. Resolves with the reason when the board refused it. */
  onDelete?: (canvas: Id) => Promise<string | undefined>;
  push?: (() => Promise<Reply>) | undefined;
  sync?: (() => Promise<Reply>) | undefined;
  /** Read a dropped file's bytes: a file that is a picture is drawn in a thumbnail as the picture. */
  read?: ReadAsset | undefined;
}

const NO_WORKS: ReadonlyMap<string, CanvasWork> = new Map();
const NO_SHOWS: ReadonlyMap<string, ShowInfo> = new Map();

/** The whole project's model, drawn flat and live: it redraws when a part changes state. */
const WHOLE: PictureItem = {
  id: 'story-pipeline',
  kind: 'picture',
  picture: { kind: 'pipeline', title: 'Every part, in its state', caption: 'Every idea changes it. Press a part to open it on the board.', view: 'flat' },
};

export function Story({ state, boxOf, markings, isOwner, onGo, onOpen, onPart, onNewCanvas, works = NO_WORKS, shows = NO_SHOWS, home, server, onTry, post, onDelete, push, sync, read }: StoryProps) {
  const chapters = useMemo(() => storyOf(state), [state]);
  const canvases = useMemo(() => [...state.canvasOrder].reverse(), [state]);
  const [asked, setAsked] = useState<Id>();
  const asking = asked && state.canvases[asked] ? asked : undefined;
  const cards = useRef<HTMLDivElement>(null);
  const progress = useMemo(() => projectProgress(state), [state]);
  const now = new Date();
  const onAct = (a: PictureAct) => {
    if (a.type === 'tap' && a.sub?.startsWith('part:')) onPart(a.sub.slice(5));
    else if (a.type === 'ask' && a.part) onPart(a.part);
  };
  const focusIn = (selector: string) => requestAnimationFrame(() => cards.current?.querySelector<HTMLElement>(selector)?.focus());
  return (
    <section className="story" data-testid="story" aria-label="The story">
      <div className="story__inner">
        <header className="story__head">
          <h2>The story so far</h2>
          <p>Every canvas, newest first. Each canvas is built on a branch of its own, and goes into {homeName(home)} when you approve it.</p>
        </header>
        {isOwner && <HomeBar home={home} push={push} sync={sync} />}
        <div className="story__chapters" data-testid="chapters" ref={cards}>
          {isOwner && <NewCanvas onNewCanvas={onNewCanvas} home={home} />}
          {canvases.map((id) => (
            <CanvasCardView
              key={id}
              card={canvasCard(state, id, works.get(id), home, server, shows)}
              shows={shows}
              chapters={chapters.filter((c) => state.chapters[c.id]?.canvas === id)}
              work={works.get(id)}
              home={home}
              isOwner={isOwner}
              state={state}
              boxOf={boxOf}
              markings={markings}
              now={now}
              onGo={onGo}
              onOpen={onOpen}
              onTry={onTry}
              post={post}
              push={push}
              read={read}
              onAsk={setAsked}
            />
          ))}
          {canvases.length === 0 && (
            <p className="story__none" data-testid="no-ideas">
              No canvas on this board yet. {isOwner ? 'Start one here, or write on the board.' : ''}
            </p>
          )}
        </div>
        {asking && onDelete && (
          <ConfirmDialog
            title={`Delete ${canvasCard(state, asking, works.get(asking), home).name === 'Untitled canvas' ? 'this untitled canvas' : `“${canvasCard(state, asking, works.get(asking), home).name}”`}?`}
            lines={deleteWords(state, asking, works.get(asking), home, shows)}
            quiet="The board keeps a record that it was here. It cannot be brought back."
            keep="Keep it"
            go="Delete this canvas"
            tone="danger"
            testId="confirm-delete"
            onCancel={() => setAsked(undefined)}
            onGo={async () => {
              const why = await onDelete(asking);
              if (why) return why;
              setAsked(undefined);
              focusIn(`article.chapter:not([data-canvas="${CSS.escape(asking)}"]) .chapter__open, .chapter--new button`);
              return undefined;
            }}
          />
        )}
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

/** The home branch, on top of the Story: where builds start, how it stands with its remote, and Push. */
function HomeBar({ home, push, sync }: { home: HomeInfo | undefined; push: StoryProps['push']; sync: StoryProps['sync'] }) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string }>();
  const line = homeLine(home);
  if (!home || !line) return null;
  const press = async (what: () => Promise<Reply>, done: (note?: string) => string) => {
    setBusy(true);
    setSaid(undefined);
    try {
      const r = await what();
      setSaid(r.ok ? { ok: true, text: done(r.note) } : { ok: false, text: r.reason });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`story__home story__home--${line.tone}`} data-testid="home-line" data-sync={home.sync} data-tone={line.tone}>
      <span className="story__home-label">Home branch</span>
      <span className="story__home-words" data-testid="home-words">
        {line.words}
      </span>
      {line.folder && (
        <span className="story__home-folder" data-testid="home-folder">
          {line.folder}
        </span>
      )}
      <span className="story__home-grow" />
      {line.push && push && (
        <button type="button" className="watch__btn watch__btn--dark" data-testid="home-push" disabled={busy} onClick={() => void press(push, (note) => note ?? 'Pushed.')}>
          Push {home.branch} to {remoteOf(home)}
        </button>
      )}
      {line.lookAgain && sync && (
        <button type="button" className="watch__link" data-testid="home-look" disabled={busy} onClick={() => void press(sync, () => `Looked at ${remoteOf(home)} again.`)}>
          Look at {remoteOf(home)} again
        </button>
      )}
      {said && <Said ok={said.ok} text={said.text} git className="story__home-said" testId="home-said" />}
    </div>
  );
}

/** The way to a new branch: a blank canvas, and the board goes to it. */
function NewCanvas({ onNewCanvas, home }: { onNewCanvas: StoryProps['onNewCanvas']; home: HomeInfo | undefined }) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string>();
  const start = async () => {
    setBusy(true);
    setRefused(undefined);
    const why = await onNewCanvas();
    setBusy(false);
    if (why) setRefused(why);
  };
  return (
    <div className="chapter chapter--new next-idea" data-testid="new-canvas">
      <h3 className="next-idea__label">A new canvas, a new branch</h3>
      <p className="next-idea__branch">
        Each canvas gets a branch of its own, started from {homeName(home)}. Ideas on one canvas are built together, on its branch.
      </p>
      <button type="button" className="watch__btn watch__btn--dark" data-testid="new-canvas-press" disabled={busy} onClick={() => void start()}>
        Start a new canvas
      </button>
      {refused && (
        <p className="chapter__refused" role="alert">
          {refused}
        </p>
      )}
    </div>
  );
}

interface CardProps {
  card: Card;
  shows: ReadonlyMap<string, ShowInfo>;
  /** Its ideas, as the Story tells them, newest first. */
  chapters: StoryChapter[];
  work: CanvasWork | undefined;
  home: HomeInfo | undefined;
  isOwner: boolean;
  state: BoardState;
  boxOf: StoryProps['boxOf'];
  markings: StoryProps['markings'];
  now: Date;
  onGo: StoryProps['onGo'];
  onOpen: StoryProps['onOpen'];
  onTry: StoryProps['onTry'];
  post: StoryProps['post'];
  push: StoryProps['push'];
  read: StoryProps['read'];
  onAsk: (canvas: Id) => void;
}

/** A canvas: its name, each idea on it in words, its branch, Approve, and its moments. */
function CanvasCardView({ card, shows, chapters, work, home, isOwner, state, boxOf, markings, now, onGo, onOpen, onTry, post, push, read, onAsk }: CardProps) {
  const held = heldWhy(state, card.id, work, home);
  const opened = state.canvases[card.id]?.openedAt;
  const moments = chapters.flatMap((c) => c.moments);
  const main = chapters.flatMap((c) => c.main);
  const done = card.ideas.length > 0 && card.ideas.every((i) => i.look === 'merged');
  const look = card.ideas.length === 0 ? 'idea' : done ? 'built' : card.ideas.some((i) => i.look === 'building') ? 'building' : card.ideas.every((i) => i.look === 'built' || i.look === 'merged') ? 'built' : 'solid';
  return (
    <article className={`chapter chapter--canvas chapter--${look}`} data-canvas={card.id} data-state={look}>
      <button type="button" className="chapter__head" onClick={() => onOpen(card.id)} data-tip="Go to it on the board">
        <span className="chapter__title">
          <h3>{card.name}</h3>
          {card.ideas.length === 0 && <StateChip state="idea">blank</StateChip>}
          {done && <StateChip state="built">merged</StateChip>}
        </span>
        <span className="chapter__when">
          {opened ? `started ${when(opened, now)}` : ''}
          {card.ideas.length > 1 ? ` · ${card.ideas.length} ideas, one branch` : ''}
        </span>
      </button>
      <div className="chapter__now">
        {card.ideas.length === 0 ? (
          <p className="chapter__words chapter__words--idea" data-testid="idea-state">
            Blank. A first note on it starts an idea.
          </p>
        ) : (
          <ul className="chapter__ideas">
            {card.ideas.map((i) => (
              <li key={i.id} data-chapter={i.id}>
                <span className="chapter__idea">{i.title}</span>
                <span className={`chapter__words chapter__words--${i.look}`} data-testid="idea-state">
                  {i.words}
                </span>
                {i.tryIt && onTry && (
                  <button
                    type="button"
                    className="watch__btn watch__btn--dark"
                    data-testid="idea-try"
                    data-running={i.running}
                    aria-label={i.running ? `${tryLabel(shows.get(i.id))} of “${i.title}”` : `Try “${i.title}”`}
                    disabled={!!held && !i.running}
                    data-tip={held && !i.running ? held : undefined}
                    onClick={() => onTry(i.id)}
                  >
                    {tryLabel(shows.get(i.id))}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {card.branch && (
          <code className="chapter__branch" data-testid="idea-branch" title={card.branch}>
            {card.branch}
          </code>
        )}
        {card.merged && !card.branch && (
          <code className="chapter__branch" data-testid="idea-branch">
            {card.merged}
          </code>
        )}
        {card.busy && !card.approve && (
          <p className="chapter__busy" role="status" data-testid="idea-busy">
            {card.busy}
          </p>
        )}
        {card.approve && post && <ApproveBlock state={state} canvas={card.id} work={work} home={home} isOwner={isOwner} post={post} push={push} />}
        <div className="chapter__acts">
          <button type="button" className="watch__btn chapter__open" onClick={() => onOpen(card.id)}>
            Open
          </button>
          <span className="chapter__grow" />
          {isOwner && (
            <button type="button" className="watch__btn chapter__delete" data-testid="canvas-delete" aria-label={`Delete ${card.name === 'Untitled canvas' ? 'this untitled canvas' : `“${card.name}”`}…`} onClick={() => onAsk(card.id)}>
              Delete…
            </button>
          )}
        </div>
      </div>
      {moments.length + main.length > 0 && (
        <ol className="chapter__moments" style={{ ['--cols' as string]: Math.max(1, Math.min(2, moments.length + main.length)) }}>
          {moments.map((m) => (
            <li key={m.id}>
              <button type="button" className="moment" data-moment={m.id} onClick={() => onGo(m.items)} data-tip={`Go to "${m.title}" on the board`}>
                <Thumb ids={m.items} state={state} boxOf={boxOf} markings={markings} read={read} />
                <span className="moment__title">
                  {m.n} · {m.title}
                </span>
              </button>
            </li>
          ))}
          {main.map((id) => (
            <li key={id}>
              <button type="button" className="moment moment--main" data-main={id} onClick={() => onGo([id])} data-tip="Go to it on the board">
                <Thumb ids={[id]} state={state} boxOf={boxOf} markings={markings} read={read} />
                <span className="moment__title">{itemWords(state, id)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

const THUMB_W = 236;
const THUMB_H = 132;

/**
 * A small live drawing of some items, as they sit on the board now: the same renderers, scaled
 * down. It cannot be pressed through: the whole thumbnail is one button.
 */
export const Thumb = memo(function Thumb({ ids, state, boxOf, markings, read }: { ids: readonly Id[]; state: BoardState; boxOf: StoryProps['boxOf']; markings: StoryProps['markings']; read?: StoryProps['read'] }) {
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
          return <MarkView key={id} item={it} shown={at} read={it.kind === 'file' ? read : undefined} />;
        })}
      </span>
    </span>
  );
});
