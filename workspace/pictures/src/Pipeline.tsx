import type { PipelinePicture } from '@keel/protocol';
import { useState } from 'react';
import { FlatSvg, LayersSvg, layersSize, layoutFlat, FLAT_FULL } from './PipeSvg';
import { Gaps, StateChip, Strip, wholeClass } from './parts';
import type { PipeModel, WalkMarks } from './pipemodel';
import { pipeModel, walkMarks } from './pipemodel';
import { LOOK_ORDER, lookOf } from './theme';
import type { PictureAct, PictureProps } from './types';
import { NO_MARKINGS } from './types';

export type PipeView = 'flat' | 'layers';

/** With nothing said by the spec or the owner, the model opens in Layers, as the mockups show. */
export const DEFAULT_VIEW: PipeView = 'layers';

/**
 * Which view a pipeline shows. The spec's view comes first, then the board's. Once the owner
 * switches, on this picture or on any other, the owner's choice wins.
 */
function usePipeView(spec: PipeView | undefined, board: PipeView | undefined): [PipeView, (v: PipeView) => void] {
  const [seen, setSeen] = useState(board);
  const [own, setOwn] = useState<PipeView | undefined>(undefined);
  if (board !== seen) {
    setSeen(board);
    setOwn(board);
  }
  return [own ?? spec ?? board ?? DEFAULT_VIEW, setOwn];
}

/** The switch between Layers and Flat. */
export function ViewSwitch({ view, onPick }: { view: PipeView; onPick: (v: PipeView) => void }) {
  return (
    <div className="kp-switch" role="group" aria-label="How the model is drawn">
      {(['layers', 'flat'] as const).map((v) => (
        <button
          key={v}
          type="button"
          className="kp-switch__btn"
          aria-pressed={view === v}
          onClick={(e) => {
            e.stopPropagation();
            onPick(v);
          }}
        >
          {v === 'layers' ? 'Layers' : 'Flat'}
        </button>
      ))}
    </div>
  );
}

/** How to read the picture: the states it shows, and the request on its way through. */
export function Legend({ pm, walk }: { pm: PipeModel; walk?: WalkMarks }) {
  const used = LOOK_ORDER.filter((l) => pm.parts.some((p) => lookOf(p) === l));
  if (used.length === 0 && !walk) return null;
  return (
    <div className="kp-legend" aria-label="How to read it">
      {used.map((l) => (
        <StateChip key={l} state={l} />
      ))}
      {walk && <span className="kp-legend__walk">{walk.walk.id}</span>}
      {walk?.lit !== undefined && (
        <span className="kp-legend__note">
          step {walk.lit} of {walk.walk.steps.length}
        </span>
      )}
    </div>
  );
}

export function pipelineDrawingWidth(pm: PipeModel, view: PipeView): number {
  return view === 'layers' ? layersSize(pm).width : layoutFlat(pm, FLAT_FULL).width + 32;
}

/**
 * The model, drawn. With no `model` in the spec it draws the board's own model and reads it
 * on every render, so a part that changes state changes here at once.
 */
export function PipelineCard({ item, state, markings, view, onAct }: PictureProps & { item: { picture: PipelinePicture } }) {
  const p = item.picture;
  const m = markings ?? NO_MARKINGS;
  const pm = pipeModel(state, p);
  const walk = walkMarks(pm, p.walk, view?.walk);
  const [shown, setShown] = usePipeView(p.view, view?.pipeline);
  const pick = (v: PipeView) => {
    setShown(v);
    onAct?.({ type: 'view.pipeline', view: v } satisfies PictureAct);
  };
  const width = Math.max(640, pipelineDrawingWidth(pm, shown));
  const svgProps = { pm, item: item.id, markings: m, onAct, ...(walk ? { walk } : {}) };
  return (
    <article
      className={`kp kp-pipeline${wholeClass(m)}`}
      data-kind="pipeline"
      data-view={shown}
      data-live={pm.live ? '' : undefined}
      style={{ width }}
    >
      <div className="kp-pipeline__head">
        <Strip head={p.title ?? 'The pipeline'}>{p.caption}</Strip>
        <ViewSwitch view={shown} onPick={pick} />
      </div>
      {pm.parts.length === 0 ? (
        <p className="kp-caption">The model has no part in a lane yet.</p>
      ) : shown === 'layers' ? (
        <div className="kp-pipeline__layers">
          <LayersSvg {...svgProps} />
        </div>
      ) : (
        <div className="kp-sheet kp-pipeline__flat">
          <FlatSvg {...svgProps} />
        </div>
      )}
      <Legend pm={pm} {...(walk ? { walk } : {})} />
      <Gaps gaps={p.gaps} />
    </article>
  );
}
