import type { BlueprintPicture, BoardState, Id } from '@keel/protocol';
import { FLAT_SMALL, FlatSvg, layoutFlat } from './PipeSvg';
import { asPart } from './build';
import { sourceOf } from './describe';
import { Gaps, StateChip, Star, tapper, wholeClass } from './parts';
import { pipeModel } from './pipemodel';
import { Legend } from './Pipeline';
import { lookOf } from './theme';
import type { PictureProps } from './types';
import { NO_MARKINGS } from './types';

/**
 * The blueprint: a solidified idea read back as one picture. The pipeline with the parts to
 * build numbered in build order, the owner's picks and where each came from, what is left
 * out on purpose, how the owner will know it works, the build track, and, just above the
 * button, everything the agent assumed that the owner did not say. "Build this" shows
 * while the chapter is solid and not yet building; once it builds, the track fills in.
 */

const SIDE = 388;
const PAD = 24;

/** The chapter a blueprint belongs to: the one the item was added in. */
export function blueprintChapter(state: BoardState, item: Id) {
  const id = state.items[item]?.chapter;
  return id ? state.chapters[id] : undefined;
}

export function BlueprintCard({ item, state, markings, onAct }: PictureProps & { item: { picture: BlueprintPicture } }) {
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
        {canBuild && (
          <button
            type="button"
            className="kp-btn kp-btn--dark kp-btn--big"
            onClick={(e) => {
              e.stopPropagation();
              if (chapter) onAct?.({ type: 'build.start', chapter: chapter.id, track: [...p.parts], blueprint: item.id, check: p.check });
            }}
          >
            Build this
          </button>
        )}
        <span className="kp-muted">
          {chapter?.state === 'solid'
            ? `Solid means I stop asking and start building. By pressing it you agree that I run this check after each commit: ${p.check}`
            : chapter?.state === 'building'
              ? chapter.paused
                ? 'Paused. Nothing is built while it is paused.'
                : 'Building. Filled parts are built, blue is where I am.'
              : chapter?.state === 'built'
                ? 'Built. Every part on the track has a commit and a check that passed.'
                : 'This idea is not solid. Solidify it to build it.'}
        </span>
      </footer>
      <Gaps gaps={p.gaps} />
    </article>
  );
}
