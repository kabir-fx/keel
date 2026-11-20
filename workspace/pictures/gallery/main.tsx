import '@fontsource/caveat/600.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/space-grotesk/600.css';
import '@fontsource/space-grotesk/700.css';
import '../src/styles.css';
import './gallery.css';

import type { BoardState, Checkpoint, PictureItem } from '@keel/protocol';
import { admit, markings, parseLog, pictureItems, pictureTitle, replay } from '@keel/protocol';
import { StrictMode, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { PictureAct, PictureView } from '../src';
import { Picture } from '../src';
import { examplesBoard } from '../test/examples';
import checkpointsJson from '../../protocol/fixtures/engine-loop/checkpoints.json';
import logText from '../../protocol/fixtures/engine-loop/log.jsonl?raw';

/**
 * The gallery: every picture of the golden fixture at a checkpoint, `?at=1` to `?at=7`, and
 * the contract's examples, `?at=examples`. The owner's acts are played on a copy of the board,
 * so "Build this" and a changed choice show what they do. Nothing is sent anywhere.
 */

const { events } = parseLog(logText);
const checkpoints = checkpointsJson as Checkpoint[];

function boardAt(at: string): { state: BoardState; items: string[]; checkpoint?: Checkpoint } {
  if (at === 'examples') return examplesBoard(true);
  const checkpoint = checkpoints.find((c) => String(c.screen) === at) ?? checkpoints[checkpoints.length - 1]!;
  const end = events.findIndex((e) => e.id === checkpoint.after);
  const state = replay(events.slice(0, end + 1));
  return { state, items: pictureItems(state).map((s) => s.item.id), checkpoint };
}

function Gallery({ at }: { at: string }) {
  const start = useMemo(() => boardAt(at), [at]);
  const [state, setState] = useState(start.state);
  const [view, setView] = useState<PictureView>(() => ({
    ...(start.checkpoint?.view.pipeline ? { pipeline: start.checkpoint.view.pipeline } : {}),
    ...(start.checkpoint?.view.walk ? { walk: start.checkpoint.view.walk } : {}),
  }));
  const [acts, setActs] = useState<string[]>([]);
  const marks = markings(state);

  const onAct = (act: PictureAct) => {
    setActs((a) => [JSON.stringify(act), ...a].slice(0, 6));
    if (act.type === 'walk.step') setView((v) => ({ ...v, walk: { id: act.walk, step: act.step } }));
    else if (act.type === 'view.pipeline') setView((v) => ({ ...v, pipeline: act.view }));
    else if (act.type !== 'tap') {
      const r = admit(state, act, 'owner', new Date().toISOString());
      if (r.ok) setState(r.state);
      else setActs((a) => [`refused under ${r.rule}: ${r.reason}`, ...a].slice(0, 6));
    }
  };

  return (
    <main className="g" data-pictures={start.items.length}>
      <header className="g-head">
        <h1>Pictures</h1>
        <nav>
          {checkpoints.map((c) => (
            <a key={c.screen} href={`?at=${c.screen}`} aria-current={String(c.screen) === at ? 'page' : undefined} title={c.title}>
              {c.screen} {c.name}
            </a>
          ))}
          <a href="?at=examples" aria-current={at === 'examples' ? 'page' : undefined}>
            examples
          </a>
        </nav>
        {start.checkpoint && <p>{start.checkpoint.title}</p>}
      </header>
      {start.items.map((id) => {
        const s = state.items[id];
        if (!s || s.item.kind !== 'picture' || s.removed) return null;
        const item: PictureItem = s.item;
        return (
          <figure key={id} className="g-fig" data-shot={id}>
            <figcaption>
              <b>{id}</b> · {item.picture.kind} · {pictureTitle(item.picture)}
            </figcaption>
            <div className="g-item" data-item={id}>
              <Picture item={item} state={state} markings={marks[id]} view={view} onAct={onAct} />
            </div>
          </figure>
        );
      })}
      <aside className="g-acts" aria-label="What the pictures told the board" data-no-shot>
        {acts.length === 0 ? 'Tap something.' : acts.map((a, i) => <div key={i}>{a}</div>)}
      </aside>
    </main>
  );
}

const at = new URLSearchParams(window.location.search).get('at') ?? '2';
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Gallery at={at} />
  </StrictMode>,
);

