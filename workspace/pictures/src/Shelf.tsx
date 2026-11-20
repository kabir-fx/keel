import type { BoardState, ShelfPicture, ShelfTile } from '@keel/protocol';
import { StateChip, Star, tapper, wholeClass } from './parts';
import type { Look } from './theme';
import { LOOK_ORDER, lookOf } from './theme';
import type { PictureProps } from './types';
import { NO_MARKINGS } from './types';

const TILE_W = 156;
const TILE_GAP = 10;
const PER_ROW = 4;

/**
 * How a tile is drawn. A tile that names a part takes that part's look from the model. A
 * built tile with no part is on the shelf, so it was there before the board: "already there".
 */
export function tileLook(state: BoardState, t: ShelfTile): Look | undefined {
  const part = t.part ? state.model.parts[t.part] : undefined;
  if (part) return lookOf(part);
  if (t.state === 'built') return 'shelf';
  return t.state;
}

/** "Already on the shelf": one tile for each thing the repository has, in its state. Tap target "tile:<id>". */
export function ShelfCard({ item, state, markings, onAct }: PictureProps & { item: { picture: ShelfPicture } }) {
  const p = item.picture;
  const m = markings ?? NO_MARKINGS;
  const tap = tapper(item.id, m, onAct);
  const cols = Math.min(PER_ROW, p.tiles.length);
  const width = Math.max(360, cols * TILE_W + (cols - 1) * TILE_GAP + 34);
  const looks = p.tiles.map((t) => tileLook(state, t));
  const used = LOOK_ORDER.filter((l) => looks.includes(l));
  return (
    <article className={`kp kp-card kp-shelf${wholeClass(m)}`} data-kind="shelf" style={{ width }}>
      <h3 className="kp-card__head">
        <Star />
        <span>{p.title ?? 'Already on the shelf'}</span>
        {used.length > 0 && (
          <span className="kp-card__aside kp-shelf__legend">
            {used.map((l) => (
              <StateChip key={l} state={l} />
            ))}
          </span>
        )}
      </h3>
      <div className="kp-shelf__tiles" style={{ gridTemplateColumns: `repeat(${cols}, ${TILE_W}px)`, gap: TILE_GAP }}>
        {p.tiles.map((t, i) => (
          <div key={t.id} {...tap(`tile:${t.id}`, `kp-tile kp-tile--${looks[i] ?? 'none'}`)} data-state={looks[i]}>
            <b className="kp-tile__name">{t.name}</b>
            {t.plain && <span className="kp-tile__plain">{t.plain}</span>}
            {t.ref && <span className="kp-tile__ref">{t.ref}</span>}
          </div>
        ))}
      </div>
    </article>
  );
}
