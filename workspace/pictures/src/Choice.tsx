import type { ChoicePicture } from '@keel/protocol';
import { asPart } from './build';
import { Star, tapper, wholeClass } from './parts';
import type { PictureProps } from './types';
import { NO_MARKINGS } from './types';

/**
 * A choice the agent made alone while building. It never blocks: one option is in force,
 * from the board's state, and the owner can change it with one press.
 */
export function ChoiceCard({ item, state, markings, onAct }: PictureProps & { item: { picture: ChoicePicture } }) {
  const p = item.picture;
  const m = markings ?? NO_MARKINGS;
  const tap = tapper(item.id, m, onAct);
  const s = state.items[item.id];
  const chosen = s?.chosen ?? p.chosen;
  const byOwner = s?.chosenBy === 'owner';
  const part = p.part ? state.model.parts[p.part] : undefined;
  return (
    <article className={`kp kp-choice${wholeClass(m)}`} {...asPart('frame')} data-kind="choice" data-chosen={chosen} style={{ width: 440 }}>
      <h3 className="kp-card__head" {...asPart('head')}>
        <Star />
        <span>{p.title}</span>
        <span className="kp-choice__yours">yours to change</span>
      </h3>
      {p.body && <p className="kp-text__body" {...asPart('block')}>{p.body}</p>}
      {part && <p className="kp-muted kp-choice__part" {...asPart('block')}>In {part.name}</p>}
      <ul className="kp-choice__options">
        {p.options.map((o) => {
          const on = o.id === chosen;
          return (
            <li key={o.id} {...tap(`option:${o.id}`, `kp-choice__option${on ? ' kp-choice__option--on' : ''}`)} {...asPart('block')}>
              <span className="kp-choice__label">
                <b>{o.label}</b>
                {o.note && <span className="kp-muted">{o.note}</span>}
              </span>
              {on ? (
                <span className="kp-choice__state">{byOwner ? 'your pick' : 'in force'}</span>
              ) : (
                <button
                  type="button"
                  className="kp-btn kp-btn--line"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAct?.({ type: 'choice.pick', item: item.id, option: o.id });
                  }}
                >
                  Use this instead
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </article>
  );
}
