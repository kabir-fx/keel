import type { BoardState, FocusPicture, Id, Markings } from '@keel/protocol';
import type { ReactNode } from 'react';
import { liveParts } from '@keel/protocol';
import { wrap } from './measure';
import { Gaps, LeanChip, StateChip, Star, isCrossed, tapper, wholeClass } from './parts';
import type { PipeModel } from './pipemodel';
import { partColumns, pipeModel } from './pipemodel';
import { CrossOver, Lines } from './svg';
import { LOOK, T, lookOf } from './theme';
import type { PictureProps } from './types';
import { NO_MARKINGS } from './types';

/**
 * One part, or one lane, opened up. Where it sits in the model, what crosses its edge, the
 * cutaway, its one promise and what that costs, a decision already made, the ways it could
 * go for the owner to circle or cross, the agent's lean, and the lines worth reading.
 */

const LEFT = 252;
const CENTER = 640;
const RIGHT = 340;
const GAP = 16;

/** A small map of the model with the opened thing lit: a floor for each lane, a block for each part. */
export function WhereItSits({ pm, part, lane }: { pm: PipeModel; part?: Id; lane?: Id }) {
  const { col, maxCol } = partColumns(pm);
  const width = LEFT - 34;
  // The floors shrink with the number of columns, so the lane names keep their room.
  const cell = Math.max(9, Math.min(20, (width - 118 - 34) / maxCol));
  const slabW = 16 + maxCol * cell;
  const rowH = 36;
  const nameX = slabW + 28;
  const height = pm.lanes.length * rowH + 6;
  return (
    <svg className="kp-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Where it sits">
      {pm.lanes.map((l, i) => {
        const y = 10 + i * rowH;
        const lit = l.id === lane || pm.parts.some((p) => p.id === part && p.lane === l.id);
        const name = wrap(l.name, width - nameX, lit ? 'ui600' : 'ui400', 12, 2);
        return (
          <g key={l.id}>
            <polygon points={`0,${y + 12} ${slabW},${y + 12} ${slabW + 18},${y} 18,${y}`} fill={lit && lane ? T.tealMid : T.white} stroke={lit && lane ? T.teal : T.grey2} strokeWidth={1.2} />
            <polygon points={`0,${y + 12} ${slabW},${y + 12} ${slabW},${y + 16} 0,${y + 16}`} fill={lit && lane ? T.teal : T.light2} stroke={lit && lane ? T.teal : T.grey2} strokeWidth={1} />
            {pm.parts
              .filter((p) => p.lane === l.id)
              .map((p) => {
                const x = 10 + ((col.get(p.id) ?? 1) - 1) * cell;
                const on = p.id === part;
                const look = LOOK[lookOf(p)];
                return (
                  <rect
                    key={p.id}
                    x={x}
                    y={y - 1}
                    width={cell - 5}
                    height={8}
                    rx={1.5}
                    fill={on ? T.teal : look.fill}
                    stroke={on ? T.tealDark : look.stroke}
                    strokeWidth={on ? 1.5 : 1}
                    strokeDasharray={on ? undefined : look.dash ? '2 1.5' : undefined}
                  />
                );
              })}
            <Lines x={nameX} y={y + 11} lines={name} face={lit ? 'ui600' : 'ui400'} size={12} color={lit ? T.tealDark : T.text2} lh={14} />
          </g>
        );
      })}
    </svg>
  );
}

function Panel({ head, children, agent }: { head: string; children: ReactNode; agent?: boolean }) {
  return (
    <section className={agent ? 'kp-card kp-focus__panel' : 'kp-sheet kp-focus__panel'}>
      <h4 className={agent ? 'kp-card__head' : 'kp-panel__head'}>
        {agent && <Star />}
        <span>{head}</span>
      </h4>
      {children}
    </section>
  );
}

function partName(state: BoardState, id: Id | undefined): string | undefined {
  if (!id) return undefined;
  return state.model.parts[id]?.name;
}

function Crossings({ p, state }: { p: FocusPicture; state: BoardState }) {
  const groups = [
    { dir: 'in' as const, head: 'Coming in', word: 'from' },
    { dir: 'out' as const, head: 'Going out', word: 'to' },
  ];
  return (
    <>
      {groups.map((g) => {
        const rows = (p.crosses ?? []).filter((c) => c.dir === g.dir);
        if (rows.length === 0) return null;
        return (
          <div key={g.dir} className="kp-cross">
            <span className="kp-cross__head">{g.head}</span>
            <ul>
              {rows.map((c, i) => {
                const other = partName(state, c.part);
                return (
                  <li key={i}>
                    <code className="kp-mono">{c.what}</code>
                    <span>
                      {c.note}
                      {other && (
                        <span className="kp-muted">
                          {c.note ? ' · ' : ''}
                          {g.word} {other}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </>
  );
}

function Cutaway({ p }: { p: FocusPicture }) {
  const inside = p.inside ?? [];
  if (inside.length === 0) return null;
  const cols = inside.length <= 2 ? inside.length : inside.length === 4 ? 2 : 3;
  return (
    <div className="kp-cutaway" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {inside.map((x, i) => (
        <div key={i} className={`kp-inside kp-inside--${x.tone ?? 'plain'}`}>
          <b>{x.name}</b>
          {x.plain && <span className="kp-muted">{x.plain}</span>}
          {x.holds && x.holds.length > 0 && (
            <span className="kp-inside__holds">
              {x.holds.map((h, k) => (
                <code key={k} className="kp-mono kp-mono--teal">
                  {h}
                </code>
              ))}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function Options({ p, item, m, onAct }: { p: FocusPicture; item: Id; m: Markings; onAct: PictureProps['onAct'] }) {
  const o = p.options;
  if (!o) return null;
  const tap = tapper(item, m, onAct);
  return (
    <section className="kp-card kp-focus__options">
      <h4 className="kp-card__head">
        <Star />
        <span>{o.title}</span>
      </h4>
      <div className="kp-options" style={{ gridTemplateColumns: `repeat(${Math.min(o.items.length, 2)}, 1fr)` }}>
        {o.items.map((x, i) => {
          const sub = `option:${x.id}`;
          return (
            <div key={x.id} {...tap(sub, 'kp-option')}>
              <div className="kp-option__head">
                <b>
                  {i + 1} · {x.name}
                </b>
                {o.lean === x.id && <LeanChip />}
              </div>
              {x.body && <p>{x.body}</p>}
              {x.risk && (
                <p className="kp-option__risk">
                  <b>Risk:</b> {x.risk}
                </p>
              )}
              {isCrossed(m, sub) && <CrossOver />}
            </div>
          );
        })}
      </div>
      {p.lean && (
        <p className="kp-text__lean">
          <b>My lean:</b> {p.lean}
        </p>
      )}
    </section>
  );
}

export function FocusCard({ item, state, markings, view, onAct }: PictureProps & { item: { picture: FocusPicture } }) {
  const p = item.picture;
  const m = markings ?? NO_MARKINGS;
  const pm = pipeModel(state, {});
  const part = p.part ? state.model.parts[p.part] : undefined;
  const lane = p.lane ? state.model.lanes.find((l) => l.id === p.lane) : undefined;
  const title = p.title ?? part?.name ?? lane?.name ?? 'A part, opened';
  const laneParts = p.lane ? liveParts(state).filter((x) => x.lane === p.lane) : [];
  // A lane shows a state when all its parts share one.
  const laneLooks = new Set(laneParts.map(lookOf));
  const laneLook = laneLooks.size === 1 ? [...laneLooks][0] : undefined;
  const right = [p.promise, p.cost, p.made, p.code?.length].some(Boolean);
  const width = LEFT + GAP + CENTER + (right ? GAP + RIGHT : 0);
  const columns = right ? `${LEFT}px ${CENTER}px ${RIGHT}px` : `${LEFT}px ${CENTER}px`;
  return (
    <article className={`kp kp-focus${wholeClass(m)}`} data-kind="focus" style={{ width }}>
      <header className="kp-focus__head">
        {/* Shown large, the app's crumb already names it. */}
        {view?.focus !== item.id && <h3 className="kp-title">{title}</h3>}
        {part && <StateChip state={lookOf(part)} />}
        {lane && laneLook && <StateChip state={laneLook} />}
        {lane && (
          <span className="kp-muted">
            {p.title ? `${lane.name}, ` : ''}
            {laneParts.length} {laneParts.length === 1 ? 'part' : 'parts'}
            {lane.note ? ` · ${lane.note}` : ''}
          </span>
        )}
        {part && (part.plain || part.lane) && (
          <span className="kp-muted">
            {[part.plain, state.model.lanes.find((l) => l.id === part.lane)?.name].filter(Boolean).join(' · ')}
          </span>
        )}
      </header>
      <div className="kp-focus__grid" style={{ gridTemplateColumns: columns, gap: GAP }}>
        <div className="kp-focus__col">
          <Panel head="Where it sits">
            <WhereItSits pm={pm} {...(p.part ? { part: p.part } : {})} {...(p.lane ? { lane: p.lane } : {})} />
          </Panel>
          {p.crosses && p.crosses.length > 0 && (
            <Panel head="What crosses it">
              <Crossings p={p} state={state} />
            </Panel>
          )}
        </div>
        <div className="kp-focus__col">
          {(p.summary || p.inside?.length) && (
            <section className="kp-sheet kp-focus__panel">
              <h4 className="kp-card__head">
                <Star />
                <span>{p.title ? 'Inside' : `${title}, opened`}</span>
              </h4>
              <Cutaway p={p} />
              {p.summary && <p className="kp-caption">{p.summary}</p>}
            </section>
          )}
          <Options p={p} item={item.id} m={m} onAct={onAct} />
          {p.lean && !p.options && (
            <p className="kp-text__lean">
              <b>My lean:</b> {p.lean}
            </p>
          )}
        </div>
        {right && (
          <div className="kp-focus__col">
            {p.promise && (
              <Panel head="Its one promise" agent>
                <p className="kp-text__body">{p.promise}</p>
              </Panel>
            )}
            {p.cost && (
              <Panel head="What it costs" agent>
                <p className="kp-text__body">{p.cost}</p>
              </Panel>
            )}
            {p.made && (
              <Panel head="A decision I made" agent>
                <p className="kp-text__body">
                  <b>{p.made.title}</b>
                  {p.made.body && <> {p.made.body}</>}
                </p>
              </Panel>
            )}
            {p.code && p.code.length > 0 && (
              <Panel head="Lines to read yourself">
                <ul className="kp-code">
                  {p.code.map((c, i) => (
                    <li key={i}>
                      <code className="kp-mono">
                        {c.path}
                        {c.lines ? `:${c.lines}` : ''}
                      </code>
                      {c.note && <span className="kp-muted">{c.note}</span>}
                    </li>
                  ))}
                </ul>
              </Panel>
            )}
          </div>
        )}
      </div>
      <Gaps gaps={p.gaps} />
    </article>
  );
}
