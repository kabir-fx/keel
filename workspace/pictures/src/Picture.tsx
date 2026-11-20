import type { PictureKind, PictureSpec } from '@keel/protocol';
import { pictureTitle } from '@keel/protocol';
import { BlueprintCard } from './Blueprint';
import { asPart } from './build';
import { ChoiceCard } from './Choice';
import { FocusCard } from './Focus';
import { FreeCard } from './Free';
import { LanesCard } from './Lanes';
import { MiniCard } from './Mini';
import { PipelineCard } from './Pipeline';
import { ShelfCard } from './Shelf';
import { SpreadCard } from './Spread';
import { WalkCard } from './Walk';
import { Star, wholeClass } from './parts';
import { TextCard } from './text';
import type { PictureProps } from './types';

/** The kinds this package draws. A kind not listed gets the plain card. */
export const DRAWN_KINDS: readonly PictureKind[] = [
  'text',
  'shelf',
  'lanes',
  'spread',
  'mini',
  'pipeline',
  'walk',
  'focus',
  'blueprint',
  'choice',
  'free',
];

/**
 * One picture, drawn by its kind. A renderer draws at its own natural size and holds no
 * position: the board places it. Everything a mark can point at carries `data-sub`, and every
 * part it is made of carries `data-build`, for the order it is drawn on in (see `build.ts`).
 */
export function Picture(props: PictureProps) {
  const { item } = props;
  if (item.status === 'drawing') return <Drawing spec={item.picture} />;
  const p = item.picture;
  switch (p.kind) {
    case 'text':
      return <TextCard {...props} item={{ ...item, picture: p }} />;
    case 'shelf':
      return <ShelfCard {...props} item={{ ...item, picture: p }} />;
    case 'lanes':
      return <LanesCard {...props} item={{ ...item, picture: p }} />;
    case 'spread':
      return <SpreadCard {...props} item={{ ...item, picture: p }} />;
    case 'mini':
      return <MiniCard {...props} item={{ ...item, picture: p }} />;
    case 'pipeline':
      return <PipelineCard {...props} item={{ ...item, picture: p }} />;
    case 'walk':
      return <WalkCard {...props} item={{ ...item, picture: p }} />;
    case 'focus':
      return <FocusCard {...props} item={{ ...item, picture: p }} />;
    case 'blueprint':
      return <BlueprintCard {...props} item={{ ...item, picture: p }} />;
    case 'choice':
      return <ChoiceCard {...props} item={{ ...item, picture: p }} />;
    case 'free':
      return <FreeCard {...props} item={{ ...item, picture: p }} />;
    default:
      return <Plain {...props} />;
  }
}

/** The placeholder the owner sees at once, while the agent draws. */
export function Drawing({ spec }: { spec: PictureSpec }) {
  return (
    <article className="kp kp-card kp-drawing" {...asPart('frame')} data-kind={spec.kind} data-status="drawing" aria-busy="true" style={{ width: 360 }}>
      <h3 className="kp-card__head" {...asPart('head')}>
        <Star />
        <span>{pictureTitle(spec)}</span>
      </h3>
      <div className="kp-drawing__bars" aria-hidden="true" {...asPart('block')}>
        <div className="kp-drawing__bar" style={{ width: '92%' }} />
        <div className="kp-drawing__bar" style={{ width: '68%' }} />
        <div className="kp-drawing__bar" style={{ width: '80%' }} />
      </div>
      <p className="kp-drawing__note" {...asPart('block')}>The agent is drawing this.</p>
    </article>
  );
}

const KIND_WORDS: Record<PictureKind, string> = {
  text: 'card',
  shelf: 'shelf',
  lanes: 'lanes',
  spread: 'spread',
  mini: 'small picture',
  pipeline: 'pipeline',
  walk: 'walk',
  focus: 'focus',
  blueprint: 'blueprint',
  choice: 'choice',
  free: 'drawing',
};

/** A plain card for a kind that has no renderer yet: its title, its kind, and its caption. */
export function Plain({ item, markings }: PictureProps) {
  const p = item.picture;
  const m = markings ?? { crossed: [], circled: [] };
  const caption = 'caption' in p ? p.caption : 'summary' in p ? p.summary : undefined;
  return (
    <article className={`kp kp-plain${wholeClass(m)}`} {...asPart('frame')} data-kind={p.kind}>
      <h3 className="kp-plain__head" {...asPart('head')}>
        <span>{pictureTitle(p)}</span>
        <span className="kp-plain__kind">{KIND_WORDS[p.kind]}</span>
      </h3>
      {caption && <p className="kp-plain__note" {...asPart('block')}>{caption}</p>}
      <p className="kp-plain__note" {...asPart('block')}>This kind of picture is not drawn on the board yet.</p>
    </article>
  );
}
