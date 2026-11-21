import type { BoardState, CanvasWork, HomeInfo, Id, ShowInfo } from '@keel/protocol';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ApproveBlock } from './Approve';
import type { Draft } from './drafts';
import { ShowStream, cellsFor, terminalCell } from './showStream';
import type { BoardSource, PostResult } from './source';
import { TryTerminal } from './TryTerminal';
import type { Tryable } from './tryit';
import { caveatOf, curly, heldWhy, lastLines, proofOf, showPress, showWords, streams, tryableOf } from './tryit';

/**
 * The try room (record 0013): the owner tries a built idea, running, at full size, and approves
 * it. The show fills the room: a frame for a page or an app, a terminal for a terminal. Beside
 * it: what the blueprint promised, as a list to tick; what the app printed; the builder's
 * caveat; and Approve, which a show that fails never hides. It is no code review: nothing here
 * reads the code.
 *
 * Esc closes it, except inside the terminal, where Esc is the terminal's. The focus goes to
 * what the owner needs first, and back to where it was when the room closes. While it is open,
 * no key reaches the board.
 */
export interface TryRoomProps {
  /** The whole board: the idea may be on any canvas. */
  state: BoardState;
  chapter: Id;
  show: ShowInfo | undefined;
  /** What the repository holds for the idea's canvas. */
  work: CanvasWork | undefined;
  home: HomeInfo | undefined;
  source: BoardSource;
  isOwner: boolean;
  post: (draft: Draft) => Promise<PostResult>;
  onClose: () => void;
}

/** What the owner ticked on each idea's list, while the page is open. */
const ticked = new Map<Id, ReadonlySet<number>>();

/** How many lines of what an app printed the room shows. */
export const OUTPUT_LINES = 400;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea, iframe, summary, [tabindex]:not([tabindex="-1"])';

export function TryRoom({ state, chapter, show, work, home, source, isOwner, post, onClose }: TryRoomProps) {
  const c = state.chapters[chapter]!;
  const t = tryableOf(c, show, work);
  const stream = useMemo(() => new ShowStream(() => source.showStream?.(chapter)), [source, chapter]);
  useEffect(() => () => stream.close(), [stream]);
  const text = useSyncExternalStore(stream.subscribe, () => stream.text);
  const showState = t.kind === 'app' || t.kind === 'terminal' ? t.state : undefined;
  useEffect(() => {
    if (streams(t)) stream.connect();
    // Connect once for each state the show is in: a stream that closes stays closed until the state moves on.
  }, [stream, t.kind, showState]);

  const [asking, setAsking] = useState(false);
  /** What the server said when it refused the last press, and whether that press was a start. */
  const [refused, setRefused] = useState<{ reason: string; start: boolean }>();
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const pressRef = useRef<HTMLButtonElement>(null);
  const terminal = useRef<{ focus(): void } | null>(null);

  // The focus goes to what the owner needs first, and back to where it came from at the end.
  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Start has it when there is one to press. Stop never does: a stray Enter would end the show.
    const first = pressRef.current && pressRef.current.textContent !== 'Stop' ? pressRef.current : heading.current;
    first?.focus();
    // A terminal that runs takes the keys at once: it is drawn once this effect has run.
    const typing = requestAnimationFrame(() => terminal.current?.focus());
    return () => {
      cancelAnimationFrame(typing);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  // The focus can fall out of the room: a press turns off while it works, a click lands on its
  // words. A key then starts at the page's body, which the room's own handler never hears.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const outside = (e: KeyboardEvent) => {
      if (e.target instanceof Node && root.current?.contains(e.target)) return;
      e.stopImmediatePropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        close.current();
      }
    };
    window.addEventListener('keydown', outside, true);
    return () => window.removeEventListener('keydown', outside, true);
  }, []);

  const press = showPress(t);
  const run = t.kind === 'app' || t.kind === 'terminal' ? t.run : undefined;
  const doPress = async () => {
    if (!source.show || !run) return;
    setAsking(true);
    setRefused(undefined);
    try {
      if (press === 'Stop') {
        const r = await source.show({ action: 'stop', chapter });
        if (!r.ok) setRefused({ reason: r.reason, start: false });
        return;
      }
      stream.restart();
      const size = stage.current ? cellsFor(stage.current.clientWidth - 24, stage.current.clientHeight - 24, terminalCell()) : undefined;
      const r = await source.show({ action: 'start', chapter, run, ...(t.kind === 'terminal' && size ? size : {}) });
      if (!r.ok) setRefused({ reason: r.reason, start: true });
      else if (t.kind === 'terminal') requestAnimationFrame(() => terminal.current?.focus());
    } finally {
      setAsking(false);
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // No key reaches the board while the room is open.
    e.stopPropagation();
    if (e.key === 'Escape' && !(e.target instanceof HTMLElement && e.target.closest('.try__terminal'))) {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'Tab' && root.current) {
      const all = [...root.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = all[0];
      const last = all[all.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const url = t.kind === 'page' ? t.url : t.kind === 'app' && t.state === 'on' ? t.url : undefined;
  const caveat = caveatOf(state, chapter);
  const kindWord = t.kind === 'page' ? 'The page' : t.kind === 'app' ? 'The app' : t.kind === 'terminal' ? 'The terminal' : 'Nothing to run';
  const held = heldWhy(state, c.canvas, work, home);
  const canPress = isOwner && !!source.show && !!press && !held;
  // A start the server refused leaves the show failed or ended: the stage says why, once.
  const notStarted = refused?.start && ((t.kind === 'app' && t.state === 'failed') || (t.kind === 'terminal' && t.state === 'ended')) ? refused.reason : undefined;
  const alert = refused && !(notStarted !== undefined && (t.kind === 'terminal' || (t.kind === 'app' && notStarted === t.note))) ? refused.reason : undefined;

  return (
    <div
      ref={root}
      className="chrome try"
      role="dialog"
      aria-modal="true"
      aria-labelledby="try-title"
      data-testid="try-room"
      data-chapter={chapter}
      data-kind={t.kind}
      data-state={t.kind === 'app' || t.kind === 'terminal' ? t.state : t.kind === 'none' ? t.why : 'on'}
      onKeyDown={onKeyDown}
    >
      <header className="try__head">
        <span className="try__eyebrow">Try it</span>
        <h2 id="try-title" ref={heading} tabIndex={-1} className="try__title">
          {curly(c.title)}
        </h2>
        {work?.branch && (
          <code className="try__branch" data-testid="try-branch" data-tip="The build’s own branch">
            {work.branch}
          </code>
        )}
        <span className="try__grow" />
        <button type="button" className="watch__btn" data-testid="try-close" onClick={onClose}>
          Back to the board
        </button>
      </header>
      <div className="try__body">
        <section className="try__main" aria-label={kindWord}>
          <div className="try__bar">
            <b className="try__kind">{kindWord}</b>
            {run && <code className="try__run">{run}</code>}
            <span className="try__words" data-testid="try-words" role="status">
              {notStarted !== undefined ? 'It did not start.' : showWords(t, home)}
            </span>
            <span className="try__grow" />
            {url && (
              <a className="watch__btn try__tab" href={url} target="_blank" rel="noopener noreferrer" data-testid="try-tab">
                Open in a new tab
              </a>
            )}
            {canPress && (
              <button
                ref={pressRef}
                type="button"
                className={press === 'Stop' ? 'watch__btn' : 'watch__btn watch__btn--dark'}
                data-testid="try-press"
                disabled={asking}
                data-tip={press === 'Stop' ? `Stop ${run} and everything it started` : `Run ${run} in the build’s own copy`}
                onClick={() => void doPress()}
              >
                {press}
              </button>
            )}
          </div>
          {(t.kind === 'app' || t.kind === 'terminal') && t.boxed === false && (
            <p className="try__unboxed" data-testid="try-unboxed">
              This machine has no sandbox, so the command runs with a short environment and can read and write what you can.
            </p>
          )}
          {alert && (
            <p className="try__refused" data-testid="try-refused" role="alert">
              {alert}
            </p>
          )}
          <div ref={stage} className="try__stage" data-testid="try-stage">
            <Stage t={t} text={text} url={url} title={c.title} stream={stream} terminal={terminal} notStarted={notStarted} held={held} proved={c.proved === true} />
          </div>
          {t.kind === 'app' && t.state === 'on' && (
            <p className="try__frame-note">Nothing in the frame? Some apps refuse to be shown inside another page. Open it in a new tab instead.</p>
          )}
        </section>
        <aside className="try__side" aria-label="Before you approve">
          <Proof chapter={chapter} proof={proofOf(state, chapter)} />
          {t.kind === 'app' && t.state !== 'off' && (
            <details className="try__printed" data-testid="try-printed" open={t.state === 'failed' || t.state === 'starting'}>
              <summary>What the app printed</summary>
              <pre>{text ? lastLines(text, OUTPUT_LINES).join('\n') : 'Nothing yet.'}</pre>
            </details>
          )}
          {caveat && (
            <section className="try__caveat" data-testid="try-caveat">
              <h3>The builder said</h3>
              <p>{caveat.text}</p>
            </section>
          )}
          <div className="try__approve">
            <ApproveBlock state={state} canvas={c.canvas} work={work} home={home} isOwner={isOwner} post={post} push={source.push} />
          </div>
        </aside>
      </div>
    </div>
  );
}

/** The show itself, at the size of the room, or what stands in its place. */
function Stage({
  t,
  text,
  url,
  title,
  stream,
  terminal,
  notStarted,
  held,
  proved,
}: {
  t: Tryable;
  text: string;
  url: string | undefined;
  title: string;
  stream: ShowStream;
  terminal: RefObject<{ focus(): void } | null>;
  /** Why the server refused the start just pressed, when the show did not start. */
  notStarted: string | undefined;
  /** Why nothing can be started now. */
  held: string | undefined;
  /** The app started and answered once when it was built. */
  proved: boolean;
}) {
  if (url) {
    return (
      <iframe
        className="try__frame"
        data-testid="try-frame"
        src={url}
        title={`${title}, as built`}
        referrerPolicy="no-referrer"
        // Record 0013: it runs scripts and keeps its storage, in its own origin, and may not move the board's page.
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
      />
    );
  }
  if (t.kind === 'terminal' && notStarted !== undefined) {
    return (
      <Empty tone="failed" testId="try-failed" head="The terminal did not start">
        <p>{notStarted}</p>
      </Empty>
    );
  }
  if (t.kind === 'terminal' && (t.state === 'on' || text)) {
    return (
      <>
        <TryTerminal stream={stream} label={`A terminal in the copy of ${title}. Esc goes to the terminal: use Back to the board to leave.`} handle={terminal} />
        {t.state === 'ended' && <p className="try__ended">{showWords(t, undefined)} Start again opens a new one.</p>}
      </>
    );
  }
  if (t.kind === 'app' && t.state === 'failed') {
    const lines = lastLines(text);
    return (
      <Empty tone="failed" testId="try-failed" head="The app did not start">
        <p>{t.note ?? notStarted ?? 'The board did not say why.'}</p>
        {lines.length > 0 ? (
          <>
            <p className="try__last-head">The last lines it printed:</p>
            <pre className="try__last" data-testid="try-last">
              {lines.join('\n')}
            </pre>
          </>
        ) : notStarted === undefined ? (
          <p className="try__quiet">It printed nothing.</p>
        ) : null}
        {proved && notStarted === undefined && <p className="try__quiet">It started and answered when it was built, so this is new. Start again runs it once more.</p>}
      </Empty>
    );
  }
  if (t.kind === 'app' && (t.state === 'starting' || t.state === 'on')) {
    const lines = lastLines(text, 6);
    return (
      <Empty tone="wait" testId="try-starting" head={t.state === 'on' ? 'The app runs, at an address the board does not open' : `Starting ${t.run}`}>
        {lines.length > 0 && <pre className="try__last">{lines.join('\n')}</pre>}
      </Empty>
    );
  }
  if (t.kind === 'app' || t.kind === 'terminal') {
    return (
      <Empty tone="off" testId="try-off" head={t.kind === 'app' ? 'The app is not running' : 'No terminal yet'}>
        {held ? (
          <p data-testid="try-held">{held}</p>
        ) : (
          <p>
            Press Start to run <code>{t.run}</code>. Nothing runs before you do.
          </p>
        )}
      </Empty>
    );
  }
  return (
    <Empty tone="none" testId="try-none" head={t.kind === 'none' && t.why === 'merged' ? 'Merged' : 'Nothing to try here'}>
      {t.kind === 'none' && t.why === 'nothing' && <p className="try__quiet">You can still approve it: you decide.</p>}
    </Empty>
  );
}

function Empty({ tone, head, testId, children }: { tone: 'off' | 'wait' | 'failed' | 'none'; head: string; testId: string; children?: ReactNode }) {
  return (
    <div className={`try__empty try__empty--${tone}`} data-testid={testId}>
      <h3>{head}</h3>
      {children}
    </div>
  );
}

/** "How you will know it works", from the blueprint: a list the owner ticks as they try it. */
function Proof({ chapter, proof }: { chapter: Id; proof: readonly string[] }) {
  const [done, setDone] = useState<ReadonlySet<number>>(() => ticked.get(chapter) ?? new Set());
  if (proof.length === 0) {
    return (
      <section className="try__proof" data-testid="try-proof">
        <h3>How you will know it works</h3>
        <p className="try__quiet">The blueprint named nothing to check by hand.</p>
      </section>
    );
  }
  const flip = (i: number) => {
    const next = new Set(done);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    ticked.set(chapter, next);
    setDone(next);
  };
  return (
    <section className="try__proof" data-testid="try-proof">
      <h3>
        How you will know it works{' '}
        <span className="try__count" data-testid="try-proof-count">
          {done.size} of {proof.length}
        </span>
      </h3>
      <ul>
        {proof.map((p, i) => (
          <li key={i}>
            <label>
              <input type="checkbox" checked={done.has(i)} onChange={() => flip(i)} />
              <span>{p}</span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}
