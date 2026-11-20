import type { Approach, SpreadPicture } from '@keel/protocol';
import { APPROACH_LETTERS, approachSub } from '@keel/protocol';
import { FreeImage, svgSize } from './Free';
import { LanesSvg, layoutLanes } from './Lanes';
import { blueOf, isLanes } from './blue';
import { measure } from './measure';
import { Gaps, LeanChip, Letter, Risk, Strip, isCrossed, tapper, wholeClass } from './parts';
import { CrossOver } from './svg';
import type { PictureProps } from './types';
import { NO_MARKINGS } from './types';

/**
 * A spread: two to four approaches to one request, side by side, lettered A to D. Each is a
 * lanes drawing or a free one. Blue is what no other approach has. A crossed approach stays,
 * dimmed under a cross; a circled one keeps an outline.
 */

const GAP = 20;

/** The width of one approach card. */
export function approachWidth(a: Approach): number {
  const titleW = measure(a.title, 'head600', 17) + 32 + 80;
  if (!isLanes(a)) return Math.ceil(Math.max(320, svgSize(a.svg, 520).w + 36, titleW));
  return Math.ceil(Math.max(320, layoutLanes(a, true).width + 36, titleW));
}

export function SpreadCard({ item, markings, onAct }: PictureProps & { item: { picture: SpreadPicture } }) {
  const p = item.picture;
  const m = markings ?? NO_MARKINGS;
  const tap = tapper(item.id, m, onAct);
  const blue = blueOf(p.approaches);
  const widths = p.approaches.map(approachWidth);
  const width = widths.reduce((a, b) => a + b, 0) + GAP * (widths.length - 1);
  return (
    <article className={`kp kp-spread${wholeClass(m)}`} data-kind="spread" style={{ width }}>
      <Strip head={p.title}>
        {p.caption ?? (
          <>
            Each approach follows the same request: <b>{p.request}</b>. Blue marks what differs.
          </>
        )}
      </Strip>
      <div className="kp-spread__row" style={{ gap: GAP }}>
        {p.approaches.map((a, i) => {
          const letter = APPROACH_LETTERS[i] ?? 'A';
          const sub = approachSub(i);
          const crossed = isCrossed(m, sub);
          const props = tap(sub, 'kp-sheet kp-approach');
          return (
            <section key={sub} {...props} style={{ width: widths[i] }} aria-label={`Approach ${letter}: ${a.title}`}>
              <header className="kp-approach__head">
                <Letter>{letter}</Letter>
                <h4 className="kp-approach__title">{a.title}</h4>
                {!isLanes(a) && <span className="kp-tag">free drawing</span>}
                {p.lean === letter && <LeanChip />}
              </header>
              {isLanes(a) ? (
                <LanesSvg
                  body={a}
                  compact
                  item={item.id}
                  markings={m}
                  stepSub={(id) => `step:${letter.toLowerCase()}-${id}`}
                  blue={blue[i]}
                  onAct={onAct}
                />
              ) : (
                <FreeImage svg={a.svg} title={a.title} maxW={520} />
              )}
              {a.caption && <p className="kp-caption">{a.caption}</p>}
              <Risk>{a.risk}</Risk>
              <Gaps gaps={a.gaps} />
              {crossed && <CrossOver />}
            </section>
          );
        })}
      </div>
      <Gaps gaps={p.gaps} />
    </article>
  );
}
