import type { AgentSetup, SetupAsk, SetupInfo } from '@keel/protocol';
import { setupDone } from '@keel/protocol';
import type { FormEvent, ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SetupHttp, Step } from './setup';
import { callSetup, signInUrl, skipSetup, stepsOf } from './setup';

/**
 * The page before the board, shown while this machine is not ready: Claude Code installed,
 * signed in, and a git to build with. It asks the server how things stand every `LOOK_MS`,
 * so a sign-in finished in another tab, or an install finished in a terminal, moves it on.
 * When nothing is left, the board takes its place.
 */

export const LOOK_MS = 1500;

type Pending = SetupAsk['action'];

export function SetupGate({ http, first, children }: { http: SetupHttp; first: SetupInfo; children: ReactNode }) {
  const [info, setInfo] = useState(first);
  const [skipped, setSkipped] = useState(false);
  const [pending, setPending] = useState<Pending>();
  const asked = useRef(0);
  const shown = useRef(0);
  const open = skipped || setupDone(info);

  const ask = useCallback(
    async (step?: SetupAsk) => {
      const n = ++asked.current;
      const got = await callSetup(http, step);
      // An answer that was asked for before the one on the page is old news.
      if (!got || n < shown.current) return;
      shown.current = n;
      setInfo(got);
    },
    [http],
  );

  useEffect(() => {
    if (open) return;
    const timer = setInterval(() => void ask(), LOOK_MS);
    return () => clearInterval(timer);
  }, [open, ask]);

  if (open) return <>{children}</>;

  const act = async (step: SetupAsk) => {
    setPending(step.action);
    await ask(step);
    setPending(undefined);
  };
  const skip = () => {
    skipSetup();
    setSkipped(true);
  };
  return <SetupPage info={info} pending={pending} onAct={(s) => void act(s)} onSkip={skip} />;
}

export function SetupPage({ info, pending, onAct, onSkip }: { info: SetupInfo; pending?: Pending; onAct: (ask: SetupAsk) => void; onSkip: () => void }) {
  const steps = stepsOf(info);
  const left = steps.filter((s) => s.state !== 'done').length;
  return (
    <main className="setup" data-testid="setup">
      <div className="setup__card">
        <h1>Set up Keel</h1>
        <p className="setup__lead">
          {info.agent
            ? `The agent on the board is ${info.agent.name}, on your own Claude account. `
            : ''}
          {left === 1 ? 'One step is left.' : `${left} steps are left.`}
        </p>
        <ol className="setup__steps">
          {steps.map((step, i) => (
            <li key={step.id} className={`setup__step setup__step--${step.state}`} data-testid={`setup-${step.id}`} data-state={step.state}>
              <span className="setup__mark" aria-hidden="true">
                {step.state === 'done' ? '✓' : i + 1}
              </span>
              <div className="setup__body">
                <h2>{step.title}</h2>
                <StepBody step={step} info={info} pending={pending} onAct={onAct} />
              </div>
            </li>
          ))}
        </ol>
        <button type="button" className="setup__skip" data-testid="setup-skip" onClick={onSkip}>
          Open the board without this
        </button>
      </div>
    </main>
  );
}

function StepBody({ step, info, pending, onAct }: { step: Step; info: SetupInfo; pending?: Pending; onAct: (ask: SetupAsk) => void }) {
  if (step.id === 'git') {
    return info.git.state === 'ready' ? <p>Ready.</p> : <p>Not found. A build needs it. {info.git.how}</p>;
  }
  const agent = info.agent!;
  if (step.id === 'install') {
    if (agent.state !== 'missing') return <p>Installed.</p>;
    const busy = agent.installing === true || pending === 'install';
    return (
      <>
        <p>{busy ? 'Installing. This takes a minute or two.' : 'Not installed yet. This runs the installer from Anthropic, into your home folder.'}</p>
        <Note agent={agent} />
        <div className="setup__acts">
          <button type="button" className="watch__btn watch__btn--go" data-testid="setup-install-go" disabled={busy} onClick={() => onAct({ action: 'install' })}>
            {busy ? 'Installing…' : `Install ${agent.name}`}
          </button>
        </div>
      </>
    );
  }
  if (agent.state === 'ready') return <p>Signed in.</p>;
  if (agent.state === 'missing') return <p>After {agent.name} is installed.</p>;
  return <SignIn agent={agent} pending={pending} onAct={onAct} />;
}

function Note({ agent }: { agent: AgentSetup }) {
  const note = agent.state === 'ready' ? undefined : agent.note;
  return note ? (
    <p className="setup__note" role="alert" data-testid="setup-note">
      {note}
    </p>
  ) : null;
}

function SignIn({ agent, pending, onAct }: { agent: Extract<AgentSetup, { state: 'signed-out' }>; pending?: Pending; onAct: (ask: SetupAsk) => void }) {
  const [code, setCode] = useState('');
  const starting = pending === 'sign-in';
  const url = signInUrl(agent.signIn?.url);
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (code.trim() === '') return;
    onAct({ action: 'code', code });
    setCode('');
  };

  if (!agent.signIn) {
    return (
      <>
        <p>Your browser opens the Claude sign-in page in a new tab. Approve it there, and this page moves on by itself.</p>
        <Note agent={agent} />
        <div className="setup__acts">
          <button type="button" className="watch__btn watch__btn--go" data-testid="setup-sign-in-go" disabled={starting} onClick={() => onAct({ action: 'sign-in' })}>
            {starting ? 'Opening…' : 'Sign in to Claude'}
          </button>
        </div>
      </>
    );
  }
  return (
    <>
      <p data-testid="setup-waiting">Waiting for you to approve the sign-in, in the tab that opened. This page moves on by itself.</p>
      <Note agent={agent} />
      <details className="setup__more">
        <summary>No tab opened, or the page shows a code</summary>
        {url && (
          <p>
            <a href={url} target="_blank" rel="noreferrer" data-testid="setup-sign-in-link">
              Open the sign-in page
            </a>
            . When it shows a code, paste it here.
          </p>
        )}
        <form className="setup__code" onSubmit={send}>
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="The code from the sign-in page"
            aria-label="The code from the sign-in page"
            autoComplete="off"
            spellCheck={false}
            data-testid="setup-code"
          />
          <button type="submit" className="watch__btn" disabled={pending === 'code' || code.trim() === ''} data-testid="setup-code-go">
            {pending === 'code' ? 'Checking…' : 'Use the code'}
          </button>
        </form>
      </details>
      <div className="setup__acts">
        <button type="button" className="watch__btn" data-testid="setup-sign-in-again" disabled={starting} onClick={() => onAct({ action: 'sign-in' })}>
          Start the sign-in again
        </button>
      </div>
    </>
  );
}
