import type { BoardState, Box, Item, Markings, MarkItem, PictureItem } from '@keel/protocol';
import type { PictureAct, PictureView } from '@keel/pictures';
import { Picture } from '@keel/pictures';
import type { ReactNode } from 'react';
import { memo } from 'react';
import { headPath, labelPoint, linePath } from './arrowhead';
import type { XY } from './geometry';
import { bboxOf, lineBox, padBox, wholeBoxAround } from './geometry';
import { InkMark } from './ink/ink';
import { pointOn } from './layout';
import { PIN_SIZE } from './markSizes';
import type { Loop } from './outline';
import { loopPath, loopsBox } from './outline';
import { sameReads, stateReads, viewReads } from './pictureReads';

/** A slight, steady tilt for a note, from its id, when the owner did not set one. */
export function tiltOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((Math.abs(h) % 17) - 8) / 10;
}

const boxAttr = (b: Box) => b.map((n) => Math.round(n * 10) / 10).join(',');

/** The frame every item sits in: `data-item` and `data-box` are how the app finds it in the DOM. */
function Frame({ item, shown, kind, children, sized = true, className = '' }: { item: Item; shown: Box; kind: string; children: ReactNode; sized?: boolean; className?: string }) {
  const [x, y, w, h] = shown;
  return (
    <div
      className={`item item--${kind} ${className}`.trim()}
      data-item={item.id}
      data-kind={kind}
      data-box={boxAttr(shown)}
      style={sized ? { left: x, top: y, width: w, minHeight: h } : { left: x, top: y }}
    >
      {children}
    </div>
  );
}

/* ----------------------------------------------------------------- marks */

/** The paper of a note with its words, tilted. A note on the board and a new one on its way to the log share it. */
export function NoteFace({ text, rot, label }: { text: string; rot: number; label?: boolean }) {
  return (
    <div className={label ? 'note note--label' : 'note'} style={{ transform: `rotate(${rot}deg)` }}>
      {text}
    </div>
  );
}

const FileIcon = () => (
  <svg width="22" height="22" viewBox="0 0 20 20" aria-hidden="true" className="file-tile__icon">
    <path d="M5 2.5 H12 L15.5 6 V17.5 H5 Z M12 2.5 V6 H15.5 M7.5 10 H13 M7.5 13 H13" />
  </svg>
);

function sizeWords(n: number | undefined): string | undefined {
  if (n === undefined) return undefined;
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export interface MarkViewProps {
  item: MarkItem;
  shown: Box;
  selected?: boolean;
  /** For a lasso: the tidy outline round where its targets are now. */
  outline?: readonly Loop[];
  /** For a lasso: how many items it holds now. */
  picked?: number;
  /** For an arrow: where its two ends are drawn now, each joined to its target. */
  ends?: readonly [readonly [number, number], readonly [number, number]];
  /** Drawn above the dimmed board, in the focus view. */
  raised?: boolean;
  /** For a file: open it. The page reads it with its token, so there is no link to copy. */
  onOpen?: ((asset: string, name: string) => void) | undefined;
}

/** One of the owner's marks on the board. It draws again only when one of its own props has changed. */
export const MarkView = memo(function MarkView({ item, shown, selected = false, outline, picked, ends, raised = false, onOpen }: MarkViewProps) {
  const sel = [selected ? 'item--selected' : '', raised ? 'item--raised' : ''].filter(Boolean).join(' ');
  switch (item.kind) {
    case 'note':
      return (
        <Frame item={item} shown={shown} kind="note" className={sel}>
          <NoteFace text={item.text} rot={item.rot ?? tiltOf(item.id)} label={item.plain === true} />
        </Frame>
      );
    case 'ink':
      return (
        <div className={`item item--ink ${sel}`.trim()} data-item={item.id} data-kind="ink" data-box={boxAttr(shown)}>
          <InkMark strokes={item.strokes} box={item.box} shown={shown} />
        </div>
      );
    case 'file':
      return (
        <Frame item={item} shown={shown} kind="file" className={sel}>
          <div className="file-tile" style={{ transform: `rotate(${item.rot ?? tiltOf(item.id) / 2}deg)` }}>
            <FileIcon />
            <span className="file-tile__text">
              <b>{item.name}</b>
              <span>{['dropped in by you', sizeWords(item.size)].filter(Boolean).join(' · ')}</span>
            </span>
            {onOpen && (
              <button
                type="button"
                className="file-tile__open"
                aria-label={`Open ${item.name}`}
                data-tip={`Open ${item.name}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen(item.asset, item.name);
                }}
              >
                Open
              </button>
            )}
          </div>
        </Frame>
      );
    case 'voice':
      return (
        <Frame item={item} shown={shown} kind="voice" className={sel}>
          <div className="note note--voice" style={{ transform: `rotate(${item.rot ?? tiltOf(item.id)}deg)` }}>
            <svg width="18" height="18" viewBox="0 0 20 20" aria-label="Said out loud" role="img">
              <rect x="8" y="3" width="4" height="8" rx="2" />
              <path d="M5.5 9.5 a4.5 4.5 0 0 0 9 0 M10 14 V17 M7.5 17 H12.5" />
            </svg>
            <span>{item.text}</span>
          </div>
        </Frame>
      );
    case 'box':
      return (
        <Frame item={item} shown={shown} kind="box" className={sel}>
          <div className="drawn-box">{item.text && <span>{item.text}</span>}</div>
        </Frame>
      );
    case 'pin':
      return (
        <div className={`item item--pin ${sel}`.trim()} data-item={item.id} data-kind="pin" data-box={boxAttr(shown)} style={{ left: shown[0] + item.at[0], top: shown[1] + item.at[1] }}>
          <svg width={PIN_SIZE} height={PIN_SIZE} viewBox="0 0 20 20" aria-hidden="true" className="pin__icon">
            <path d="M10 18 C10 18 15 12.5 15 8.5 A5 5 0 0 0 5 8.5 C5 12.5 10 18 10 18 Z" />
            <circle cx="10" cy="8.5" r="1.8" />
          </svg>
          {item.text && <span className="pin__text">{item.text}</span>}
        </div>
      );
    case 'lasso':
      return outline && outline.length > 0 ? (
        <LassoOutline item={item} outline={outline} picked={picked ?? 0} selected={selected} raised={raised} />
      ) : (
        <LineMark item={item} shown={shown} cls={sel} />
      );
    case 'arrow':
      return <ArrowMark item={item} shown={shown} cls={sel} {...(ends ? { ends } : {})} />;
  }
});

/** The points of a line mark in world units: an arrow's two ends, or a lasso's path. */
export function linePoints(
  item: Extract<MarkItem, { kind: 'arrow' | 'lasso' }>,
  shown: Box,
  ends?: readonly [readonly [number, number], readonly [number, number]],
): Array<[number, number]> {
  if (item.kind === 'arrow') return ends ? [[ends[0][0], ends[0][1]], [ends[1][0], ends[1][1]]] : [pointOn(item.from, item.box, shown), pointOn(item.to, item.box, shown)];
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < item.path.length; i += 2) out.push(pointOn([item.path[i]!, item.path[i + 1]!], item.box, shown));
  return out;
}

/**
 * A lasso with no target left: its path as it was drawn, a line in world units. Its points are
 * counted from the corner of its box, so a moved lasso (a new `box`) is drawn where it was moved to.
 */
function LineMark({ item, shown, cls }: { item: Extract<MarkItem, { kind: 'lasso' }>; shown: Box; cls: string }) {
  const pts = linePoints(item, shown);
  // The SVG is on whole units, as `InkMark` is: Chrome snaps what an SVG draws to its box before
  // the zoom, so off the whole unit the line would sit up to half a unit from where it was drawn.
  const [x, y, w, h] = lineBox(pts);
  return (
    <div className={`item item--lasso ${cls}`.trim()} data-item={item.id} data-kind="lasso" data-box={boxAttr(bboxOf(pts))}>
      <svg className="line-mark" style={{ left: x, top: y, width: w, height: h }} viewBox={`${x} ${y} ${w} ${h}`} aria-hidden="true">
        <path d={`${linePath(pts)} Z`} className="line-mark--lasso" />
      </svg>
    </div>
  );
}

/**
 * An arrow's line and its head, from `from` to `to`, in world units, each a path drawn with the
 * line's stroke. The arrow being drawn, the arrow whose end is dragged and the arrow once saved
 * are all drawn by this, so they come out on the same pixels.
 */
export function ArrowPaths({ from, to }: { from: XY; to: XY }) {
  const head = headPath(from, to);
  return (
    <>
      <path d={linePath([from, to])} />
      {head && <path d={head} className="line-mark__head" />}
    </>
  );
}

/**
 * An arrow: a line in world units from where its two ends are drawn now (`ends`, joined to its
 * targets), or from its own points, counted from the corner of its box, when it has none. Its
 * words sit at their share of the line (`labelAt`), on a chip the colour of the ground that hides
 * the line behind them. The line is not cut there: a line cut in two, or drawn through a mask, is
 * drawn by Chrome on other pixels than the same line whole, and the line must not move when it
 * is saved, or when its words come.
 */
function ArrowMark({ item, shown, cls, ends }: { item: Extract<MarkItem, { kind: 'arrow' }>; shown: Box; cls: string; ends?: readonly [readonly [number, number], readonly [number, number]] }) {
  const [from, to] = linePoints(item, shown, ends) as [[number, number], [number, number]];
  // On whole units, as `LineMark` is, and the same box as the line being drawn (`LiveShape`).
  const [x, y, w, h] = lineBox([from, to]);
  const at = labelPoint(from, to, item.labelAt);
  return (
    <div className={`item item--arrow ${cls}`.trim()} data-item={item.id} data-kind="arrow" data-box={boxAttr(bboxOf([from, to]))}>
      <svg className="line-mark" style={{ left: x, top: y, width: w, height: h }} viewBox={`${x} ${y} ${w} ${h}`} aria-hidden="true">
        <ArrowPaths from={from} to={to} />
      </svg>
      {item.text && (
        <span className="line-mark__text" style={{ left: at[0], top: at[1] }}>
          {item.text}
        </span>
      )}
    </div>
  );
}

/** Where a lasso says how many it holds: just under the left end of its lowest edge. */
function pillAt(outline: readonly Loop[], box: Box): [number, number] {
  const bottom = box[1] + box[3];
  const xs = outline.flat().filter((p) => Math.abs(p[1] - bottom) < 0.5).map((p) => p[0]);
  return [(xs.length ? Math.min(...xs) : box[0]) + 24, bottom + 10];
}

/** A lasso as the owner sees it: a tidy dashed outline round its targets, and how many it holds. */
function LassoOutline({ item, outline, picked, selected, raised }: { item: Extract<MarkItem, { kind: 'lasso' }>; outline: readonly Loop[]; picked: number; selected: boolean; raised: boolean }) {
  const box = loopsBox(outline)!;
  // On whole units, as every SVG on the board is (`LineMark`).
  const [x, y, w, h] = wholeBoxAround(padBox(box, 6));
  return (
    <div className={`item item--lasso${selected ? ' item--selected' : ''}${raised ? ' item--raised' : ''}`} data-item={item.id} data-kind="lasso" data-box={boxAttr(box)}>
      <svg className="line-mark lasso-outline" style={{ left: x, top: y, width: w, height: h }} viewBox={`${x} ${y} ${w} ${h}`} aria-label={`Your lasso round ${picked} ${picked === 1 ? 'item' : 'items'}`} role="img">
        {outline.map((l, i) => (
          <path key={i} d={loopPath(l as Loop)} className="line-mark--lasso" />
        ))}
      </svg>
      <span className="lasso-pill" style={{ left: pillAt(outline, box)[0], top: pillAt(outline, box)[1] }}>
        {picked} picked
      </span>
    </div>
  );
}

/* --------------------------------------------------------------- pictures */

export interface PictureFrameProps {
  item: PictureItem;
  shown: Box;
  /** The whole board. The frame draws again only when the parts its picture reads have changed (`stateReads`). */
  state: BoardState;
  markings: Markings | undefined;
  /** How the owner looks at the board. The frame draws again only when the part its picture reads has changed (`viewReads`). */
  view: PictureView;
  onAct: (act: PictureAct) => void;
  selected?: boolean;
  raised?: boolean;
}

/**
 * Does a picture draw the same with these props as with those? Its own item, box and markings,
 * and the parts of the state and of the view it reads, compared by identity: the reducer never
 * changes an entry in place, and the board keeps a box or a marking whose numbers did not change.
 */
function samePicture(a: PictureFrameProps, b: PictureFrameProps): boolean {
  return (
    a.item === b.item &&
    a.shown === b.shown &&
    a.markings === b.markings &&
    a.onAct === b.onAct &&
    a.selected === b.selected &&
    a.raised === b.raised &&
    (a.view === b.view || sameReads(viewReads(a.view, a.item), viewReads(b.view, b.item))) &&
    (a.state === b.state || sameReads(stateReads(a.state, a.item), stateReads(b.state, b.item)))
  );
}

/** A picture on the board. One event draws again only the pictures it touched, and a change of how the owner looks only those that read it. */
export const PictureFrame = memo(function PictureFrame({ item, shown, state, markings, view, onAct, selected = false, raised = false }: PictureFrameProps) {
  const cls = [selected ? 'item--selected' : '', raised ? 'item--raised' : ''].filter(Boolean).join(' ');
  return (
    <Frame item={item} shown={shown} kind="picture" sized={false} className={cls}>
      <Picture item={item} state={state} markings={markings} view={view} onAct={onAct} />
    </Frame>
  );
}, samePicture);
