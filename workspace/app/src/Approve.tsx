import type { BoardState, CanvasWork, HomeInfo, Id } from '@keel/protocol';
import { canvasBuilds } from '@keel/protocol';
import { useState } from 'react';
import { ConfirmDialog } from './Confirm';
import type { Draft } from './drafts';
import type { PostResult, Reply } from './source';
import { when } from './story';
import { approveCan, approveOutcome, busyWords, homeName, quoted, remoteOf, saidParts } from './tryit';

/**
 * Approve, and what comes after it, for one canvas: the press that merges its branch into the
 * home branch (record 0014), what the server does meanwhile, how it went, where it went, and
 * Push. Every built idea on the canvas goes at once: they share the branch, so the press names
 * them all when there is more than one, and asks first. The watch panel, the try room and the
 * Story show it the same way.
 */
export interface ApproveProps {
  /** The whole board: the canvas's ideas are read from it. */
  state: BoardState;
  canvas: Id;
  work: CanvasWork | undefined;
  home: HomeInfo | undefined;
  isOwner: boolean;
  post: (draft: Draft) => Promise<PostResult>;
  push?: (() => Promise<Reply>) | undefined;
  /** Start a new canvas: offered once everything here is merged, for an idea of its own. */
  onNewCanvas?: (() => void) | undefined;
}

const commits = (n: number) => `${n} ${n === 1 ? 'commit' : 'commits'}`;

export function ApproveBlock({ state, canvas, work, home, isOwner, post, push, onNewCanvas }: ApproveProps) {
  const [pressing, setPressing] = useState(false);
  const [asking, setAsking] = useState(false);
  /** How the last press went. `git`: it ran git, which may have said more than the server's sentence. */
  const [said, setSaid] = useState<{ ok: boolean; text: string; git?: true }>();
  const b = canvasBuilds(state, canvas);
  if (b.waiting.length === 0 && b.merged.length === 0) return null;
  const h = homeName(home);
  const answer = said && <Said ok={said.ok} text={said.text} git={said.git} className="approve__said" testId="approve-said" />;

  if (b.waiting.length === 0) {
    const last = b.merged[b.merged.length - 1]!.merged!;
    const into = last.into;
    const canPush = isOwner && !!push && home?.sync === 'ahead' && home.branch === into;
    const doPush = async () => {
      if (!push) return;
      setPressing(true);
      setSaid(undefined);
      try {
        const r = await push();
        setSaid(r.ok ? { ok: true, text: r.note ? `Pushed. ${r.note}` : `Pushed. ${into} is level with ${home ? remoteOf(home) : 'its remote'}.` } : { ok: false, text: r.reason, git: true });
      } finally {
        setPressing(false);
      }
    };
    return (
      <div className="approve approve--merged" data-testid="approve" data-state="merged">
        <p className="approve__merged" data-testid="merged-line">
          <b>
            Merged into {into} at <code>{last.commit.slice(0, 7)}</code>
          </b>{' '}
          · {when(last.at)}
        </p>
        {canPush && home && (
          <div className="approve__push">
            <p>
              {into} has {commits(home.ahead ?? 1)} that {remoteOf(home)} does not have. A push cannot be taken back.
            </p>
            <button type="button" className="watch__btn" data-testid="push" disabled={pressing} onClick={() => void doPush()}>
              Push {into} to {remoteOf(home)}
            </button>
          </div>
        )}
        {answer}
        {isOwner && onNewCanvas && b.building.length === 0 && (
          <div className="approve__next" data-testid="canvas-done">
            <p>A new note on this canvas starts another idea on its branch, built together with the rest. For a separate idea, start a new canvas.</p>
            <button type="button" className="watch__btn" data-testid="canvas-done-new" onClick={onNewCanvas}>
              Start a new canvas
            </button>
          </div>
        )}
      </div>
    );
  }

  const can = approveCan(state, canvas, work, home)!;
  const outcome = approveOutcome(state, canvas);
  const approve = async (): Promise<string | undefined> => {
    setPressing(true);
    setSaid(undefined);
    try {
      const r = await post({ type: 'canvas.approve', canvas });
      if (!r.ok) setSaid({ ok: false, text: r.reason });
      return r.ok ? undefined : r.reason;
    } finally {
      setPressing(false);
    }
  };
  const behind = work?.behind ?? 0;
  const several = can.waiting.length > 1;
  // What the server does with the branch, said as such. While an idea on the canvas builds, the
  // reason it is held says that idea instead.
  const busy = work?.busy && !(work.busy === 'building' && b.building.length > 0) ? work.busy : undefined;
  const what = [
    work?.branch ? `Approve merges ${work.branch} into ${h} on this machine.` : `Approve merges this canvas’s build into ${h} on this machine.`,
    behind > 0 ? `${h} has ${commits(behind)} this build does not: they are joined in first, and the checks run again.` : undefined,
    home?.sync === 'diverged' ? `${h} and ${home.upstream ?? remoteOf(home)} have both moved, so the merge stays on this machine until they are joined.` : behind > 0 ? undefined : 'Pushing it is a second press.',
  ];
  return (
    <div className="approve" data-testid="approve" data-state={busy ? 'busy' : can.why ? 'held' : outcome && 'line' in outcome ? 'again' : 'ready'}>
      {busy && (
        <p className="approve__busy" data-testid="approve-busy" role="status">
          {busyWords(busy, home, work?.branch)}
        </p>
      )}
      {outcome && 'line' in outcome && !work?.busy && (
        <p className="approve__again" data-testid="approve-again" role="status">
          <b>Not merged.</b> {outcome.line.text}
        </p>
      )}
      {outcome && 'waiting' in outcome && !work?.busy && (
        <p className="approve__busy" data-testid="approve-waiting" role="status">
          Approved. The board server has not merged it yet. Press Approve again if nothing happens.
        </p>
      )}
      {isOwner && (
        <>
          <button
            type="button"
            className="watch__btn watch__btn--dark approve__press"
            data-testid="approve-press"
            disabled={pressing || !!can.why}
            onClick={() => (several ? setAsking(true) : void approve())}
          >
            {several ? `${can.label}…` : can.label}
          </button>
          {can.why && !busy ? (
            <p className="approve__what approve__what--held" data-testid="approve-why">
              {can.why}
            </p>
          ) : (
            <p className="approve__what" data-testid="approve-what">
              {what.filter(Boolean).join(' ')}
            </p>
          )}
        </>
      )}
      {answer}
      {asking && (
        <ConfirmDialog
          title={`Approve ${quoted(can.waiting.map((c) => c.title))}?`}
          lines={[
            `They are built on one branch${work?.branch ? `, ${work.branch}` : ''}, so they go into ${h} together.`,
            behind > 0 ? `${h} has ${commits(behind)} this build does not: they are joined in first, and the checks run again.` : 'Pushing it is a second press.',
          ]}
          keep="Not yet"
          go={`Merge ${can.waiting.length === 2 ? 'both' : `all ${can.waiting.length}`} into ${h}`}
          tone="go"
          testId="confirm-approve"
          onCancel={() => setAsking(false)}
          onGo={async () => {
            const why = await approve();
            if (!why) setAsking(false);
            return why;
          }}
        />
      )}
    </div>
  );
}

/**
 * How a press went, as the server said it. After a git command (`git`), its first sentence,
 * with what git printed after it folded under "What git said", so a refused push reads in one line.
 */
export function Said({ ok, text, git, className, testId }: { ok: boolean; text: string; git?: true | undefined; className: string; testId: string }) {
  const { head, more } = git ? saidParts(text) : { head: text, more: undefined };
  return (
    <div className={ok ? className : `${className} ${className}--no`} data-testid={testId} role="status">
      <span>{head}</span>
      {more && (
        <details className="said__more" data-testid={`${testId}-more`}>
          <summary>What git said</summary>
          <pre>{more}</pre>
        </details>
      )}
    </div>
  );
}
