import type { TextPicture } from '@keel/protocol';
import { Star, subClass, wholeClass } from './parts';
import type { PictureProps } from './types';

/** The card's width grows with what it has to say, in three steps, so cards line up. */
export function textWidth(p: TextPicture): number {
  const len =
    p.title.length +
    (p.body?.length ?? 0) +
    (p.points ?? []).join(' ').length +
    (p.lean?.length ?? 0) +
    (p.questions ?? []).join(' ').length;
  if (len > 480) return 540;
  if (len > 180) return 460;
  return 380;
}

/**
 * An agent card: the star header, a few plain sentences, points, the agent's lean, and at
 * most three questions. Each question is a tap target, `q:1` to `q:3`.
 */
export function TextCard({ item, markings, onAct }: PictureProps & { item: { picture: TextPicture } }) {
  const p = item.picture;
  const m = markings ?? { crossed: [], circled: [] };
  const paragraphs = (p.body ?? '').split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  return (
    <article className={`kp kp-card kp-text${wholeClass(m)}`} data-kind="text" style={{ width: textWidth(p) }}>
      <h3 className="kp-card__head">
        <Star />
        <span>{p.title}</span>
      </h3>
      {paragraphs.map((t, i) => (
        <p key={i} className="kp-text__body">
          {t}
        </p>
      ))}
      {p.points && p.points.length > 0 && (
        <ul className="kp-text__points">
          {p.points.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      )}
      {p.lean && (
        <p className="kp-text__lean">
          <b>My read:</b> {p.lean}
        </p>
      )}
      {p.questions && p.questions.length > 0 && (
        <ol className="kp-text__questions" aria-label="Questions for you">
          {p.questions.map((q, i) => {
            const sub = `q:${i + 1}`;
            return (
              <li
                key={sub}
                data-sub={sub}
                className={subClass(m, sub)}
                onClick={onAct ? () => onAct({ type: 'tap', item: item.id, sub }) : undefined}
              >
                <b>{i + 1}.</b> {q}
              </li>
            );
          })}
        </ol>
      )}
    </article>
  );
}
