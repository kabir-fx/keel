import type { BlueprintPicture, BoardState, Chapter, Id, ShowPlan } from '@keel/protocol';
import { awaitsProof } from '@keel/protocol';
import type { ReactNode } from 'react';
import { FLAT_SMALL, FlatSvg, layoutFlat } from './PipeSvg';
import { asPart } from './build';
import { sourceOf } from './describe';
import { Gaps, StateChip, Star, tapper, wholeClass } from './parts';
import { pipeModel } from './pipemodel';
import { Legend } from './Pipeline';
import { lookOf } from './theme';
import type { BuildPlace, PictureProps } from './types';
import { NO_MARKINGS } from './types';

/**
 * The blueprint: a solidified idea read back as one picture. The pipeline with the parts to
 * build numbered in build order, the owner's picks and where each came from, what is left
 * out on purpose, how the owner will know it works, the build track, and, just above the
 * button, everything the agent assumed that the owner did not say. "Build this" shows
 * while the chapter is solid and not yet building; once it builds, the track fills in.
 * Beside the button: the commands the press agrees to (records 0007 and 0013), and where the
 * build goes (record 0014).
 */

const SIDE = 388;
const PAD = 24;

/** The chapter a blueprint belongs to: the one the item was added in. */
export function blueprintChapter(state: BoardState, item: Id) {
  const id = state.items[item]?.chapter;
  return id ? state.chapters[id] : undefined;
}

/** How the owner will try the result, in words, with the command it runs. */
function showSays(show: ShowPlan | undefined): ReactNode {
  if (!show) return 'Not named. The board shows a page when the build makes one, else a terminal with the check typed in.';
  switch (show.kind) {
    case 'page':
      return 'A page. It opens on the board, and nothing runs.';
    case 'app':
      return (
        <>
          An app. When you press Try it, the board runs <code className="kp-cmd">{show.run}</code> in the build’s own copy and shows it here
          {show.port !== undefined ? `, on port ${show.port}` : ''}.
        </>
      );
    case 'terminal':
      return (
        <>
          A terminal. When you press Try it, the board opens one in the build’s own copy and types <code className="kp-cmd">{show.run}</code>.
        </>
      );
  }
}

/**
 * Where a build started now goes, and what it will not have (plan 5.7). A canvas's first build
 * starts from the home branch on a branch of its own; a later one goes onto that branch, with
 * the ideas already there. Said only while "Build this" waits.
 */
function StartLine({ place, here, onAct }: { place: BuildPlace; here: Chapter[]; onAct: PictureProps['onAct'] }) {
  const quote = (titles: string[]) => (titles.length <= 1 ? `“${titles[0] ?? ''}”` : `${titles.slice(0, -1).map((t) => `“${t}”`).join(', ')} and “${titles[titles.length - 1]}”`);
  const { home, branch, waiting } = place;
  const start = branch
    ? `This build goes onto this canvas’s branch, ${branch}${here.length > 0 ? `, with ${quote(here.map((c) => c.title))}` : ''}.`
    : home
      ? home.commit
        ? `This build starts from ${home.branch} at ${home.commit}, on a branch of its own.`
        : `This build starts from ${home.branch}, which has no commit yet, on a branch of its own.`
      : undefined;
  if (!start && waiting.length === 0) return null;
  return (
    <p className="kp-agree__from" data-testid="blueprint-start">
      {start}
      {waiting.length > 0 && (
        <>
          {start ? ' ' : ''}
          {waiting.length === 1
            ? `${quote([waiting[0]!.title])} is built and not approved yet, so this build will not have it.`
            : `${quote(waiting.map((c) => c.title))} are built and not approved yet, so this build will not have them.`}{' '}
          {waiting.map((c) =>
            c.held && !c.running ? (
              <span key={c.chapter} className="kp-muted" data-held={c.chapter}>
                {c.held}
              </span>
            ) : (
              <button
                key={c.chapter}
                type="button"
                className="kp-link"
                data-try={c.chapter}
                data-running={c.running ? '' : undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  onAct?.({ type: 'try', chapter: c.chapter });
                }}
              >
                {c.running ? `${quote([c.title])} is running: open it` : `Try ${quote([c.title])} first`}
              </button>
            ),
          )}
        </>
      )}
    </p>
  );
}

export function BlueprintCard({ item, state, markings, view, onAct }: PictureProps & { item: { picture: BlueprintPicture } }) {
  const p = item.picture;
  const m = markings ?? NO_MARKINGS;
  const tap = tapper(item.id, m, onAct);
  const chapter = blueprintChapter(state, item.id);
  const pm = pipeModel(state, {});
  const trackNo = new Map(p.parts.map((id, i) => [id, i + 1]));
  const drawn = new Set(pm.parts.map((x) => x.id));
  const flatW = pm.parts.length > 0 ? layoutFlat(pm, FLAT_SMALL, false).width : 0;
  const width = Math.max(860, flatW + SIDE + 3 * PAD);
  const track = p.parts.map((id) => state.model.parts[id]);
  // Built here and checked: a part that was already there does not count.
  const built = track.filter((x) => x && lookOf(x) === 'built').length;
  const building = chapter?.state === 'building';
  const canBuild = chapter?.state === 'solid';
  // Once it builds, what the owner agreed to is the chapter's own: the press took it from here.
  const agreed = canBuild || !chapter?.check ? { check: p.check, setup: p.setup, show: p.show } : { check: chapter.check, setup: chapter.setup, show: chapter.show };
  // The other ideas on this canvas, which share its branch.
  const here = chapter ? state.chapterOrder.flatMap((id) => (id !== chapter.id && state.chapters[id]?.canvas === chapter.canvas ? [state.chapters[id]!] : [])) : [];
  return (
    <article className={`kp kp-blueprint${wholeClass(m)}`} {...asPart('frame')} data-kind="blueprint" data-chapter-state={chapter?.state} style={{ width }}>
      <header className="kp-blueprint__head" {...asPart('head')}>
        <h3 className="kp-title kp-title--big">{p.title}</h3>
        {chapter && <StateChip state={chapter.state} />}
        <span className="kp-blueprint__aside">
          <Star /> read back from your picks
        </span>
      </header>
      {p.summary && <p className="kp-caption" {...asPart('block')}>{p.summary}</p>}
      <div className="kp-blueprint__body" style={{ gridTemplateColumns: `${Math.max(flatW, width - SIDE - 3 * PAD)}px ${SIDE}px`, gap: PAD }}>
        <div className="kp-blueprint__model">
          {pm.parts.length > 0 && <FlatSvg pm={pm} item={item.id} markings={m} onAct={onAct} metrics={FLAT_SMALL} edges={false} trackNo={trackNo} laneSubs={false} />}
          <Legend pm={pm} />
        </div>
        <div className="kp-blueprint__side">
          <section>
            <h4 className="kp-panel__head" {...asPart('block')}>Your picks</h4>
            <ol className="kp-picks">
              {p.picks.map((pick, i) => {
                const src = sourceOf(state, pick.from);
                return (
                  <li key={i} {...tap(`pick:${i + 1}`, 'kp-pick')} {...asPart('block')}>
                    <span className="kp-pick__n">{i + 1}</span>
                    <span>
                      <b>{pick.text}</b>
                      {src && <span className={src.owner ? 'kp-pick__from kp-pick__from--owner' : 'kp-pick__from'}>{src.text}</span>}
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>
          {p.leftOut && p.leftOut.length > 0 && (
            <section>
              <h4 className="kp-panel__head" {...asPart('block')}>Left out on purpose</h4>
              <ul className="kp-leftout" {...asPart('block')}>
                {p.leftOut.map((x, i) => (
                  <li key={i}>
                    {x.text}
                    {x.why && <span className="kp-muted"> · {x.why}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h4 className="kp-panel__head" {...asPart('block')}>How you will know it works</h4>
            <ul className="kp-proof">
              {p.proof.map((x, i) => (
                <li key={i} {...asPart('block')}>{x}</li>
              ))}
            </ul>
          </section>
          <section>
            <h4 className="kp-panel__head" {...asPart('block')}>
              {p.parts.length} {p.parts.length === 1 ? 'part' : 'parts'}, one commit each
              {(building || chapter?.state === 'built') && (
                <span className="kp-track__count">
                  {built} of {p.parts.length} built
                </span>
              )}
            </h4>
            {(building || chapter?.state === 'built') && (
              <div className="kp-track__bar" {...asPart('block')} role="progressbar" aria-valuemin={0} aria-valuemax={p.parts.length} aria-valuenow={built}>
                <span style={{ width: `${(100 * built) / Math.max(1, p.parts.length)}%` }} />
              </div>
            )}
            <ol className="kp-track" {...asPart('block')}>
              {p.parts.map((id, i) => {
                const part = track[i];
                const look = part ? lookOf(part) : 'idea';
                const own = !drawn.has(id);
                const props = own ? tap(`part:${id}`, `kp-track__part k-state k-state--${look}`) : { className: `kp-track__part k-state k-state--${look}` };
                return (
                  <li key={id} {...props}>
                    {look === 'built' ? <span aria-label="built">✓ </span> : null}
                    {i + 1} {part?.name ?? id}
                    {part?.state === 'building' ? <span className="kp-track__now"> · now</span> : null}
                    {own && <span className="kp-track__off"> · off the picture</span>}
                  </li>
                );
              })}
            </ol>
          </section>
        </div>
      </div>
      {p.assumed && p.assumed.length > 0 && (
        <section className="kp-assumed" {...asPart('frame')} aria-labelledby={`${item.id}-assumed`}>
          <h4 className="kp-assumed__head" {...asPart('head')} id={`${item.id}-assumed`}>
            <span className="kp-assumed__mark" aria-hidden="true">
              !
            </span>
            What I assumed
          </h4>
          <p className="kp-assumed__note" {...asPart('block')}>You did not say these. Each one can be wrong.</p>
          <ol className="kp-assumed__list">
            {/* Each one is a tap target, "assumed:<n>"; the owner's cross strikes it through. */}
            {p.assumed.map((a, i) => (
              <li key={i} {...tap(`assumed:${i + 1}`, 'kp-assumed__item')} {...asPart('block')}>
                {a}
              </li>
            ))}
          </ol>
        </section>
      )}
      <footer className="kp-blueprint__foot" {...asPart('block')}>
        <section className="kp-agree" data-testid="blueprint-agrees">
          <h4 className="kp-panel__head">{canBuild ? 'What “Build this” agrees to' : 'What you agreed to with “Build this”'}</h4>
          <dl className="kp-agree__list">
            <div>
              <dt>The check, after each part</dt>
              <dd>
                <code className="kp-cmd">{agreed.check}</code>
              </dd>
            </div>
            {agreed.setup && (
              <div data-agree="setup">
                <dt>The setup, once before the first part</dt>
                <dd>
                  <code className="kp-cmd">{agreed.setup}</code> <span className="kp-muted">It may fetch from the network.</span>
                </dd>
              </div>
            )}
            <div data-agree="show">
              <dt>How you will try it</dt>
              <dd>{showSays(agreed.show)}</dd>
            </div>
          </dl>
        </section>
        {canBuild && view?.build && <StartLine place={view.build} here={here} onAct={onAct} />}
        <div className="kp-blueprint__go">
          {canBuild && (
            <button
              type="button"
              className="kp-btn kp-btn--dark kp-btn--big"
              onClick={(e) => {
                e.stopPropagation();
                if (!chapter) return;
                onAct?.({
                  type: 'build.start',
                  chapter: chapter.id,
                  track: [...p.parts],
                  blueprint: item.id,
                  check: p.check,
                  ...(p.setup !== undefined ? { setup: p.setup } : {}),
                  ...(p.show !== undefined ? { show: p.show } : {}),
                });
              }}
            >
              Build this
            </button>
          )}
          <span className="kp-muted">
            {chapter?.state === 'solid'
              ? 'Solid means I stop asking and start building. Nothing runs before you press it, and only these commands run after.'
              : chapter?.state === 'building'
                ? chapter.paused
                  ? 'Paused. Nothing is built while it is paused.'
                  : awaitsProof(state, chapter.id)
                    ? 'Every part is built. The app is started once before this counts as built.'
                    : 'Building. Filled parts are built, blue is where I am.'
                : chapter?.state === 'built'
                  ? chapter.merged
                    ? `Built, approved, and merged into ${chapter.merged.into} at ${chapter.merged.commit}.`
                    : 'Built. Every part on the track has a commit and a check that passed. Try it, then approve it.'
                  : 'This idea is not solid. Solidify it to build it.'}
          </span>
        </div>
      </footer>
      <Gaps gaps={p.gaps} />
    </article>
  );
}
