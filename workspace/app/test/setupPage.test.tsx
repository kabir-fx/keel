import type { AgentSetup, SetupAsk, SetupInfo } from '@keel/protocol';
import { ROUTES } from '@keel/protocol';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOOK_MS, SetupGate } from '../src/SetupPage';
import { callSetup, setupSkipped, signInUrl, skipSetup, stepsOf } from '../src/setup';

/**
 * The page before the board: what is left to set up on this machine, one button at a time,
 * and the board in its place once nothing is left.
 */

const READY = { state: 'ready' } as const;
const NO_GIT = { state: 'missing', how: 'Run "xcode-select --install" in a terminal.' } as const;
const claude = (rest: Record<string, unknown>) => ({ name: 'Claude Code', ...rest }) as AgentSetup;
const MISSING: SetupInfo = { agent: claude({ state: 'missing' }), git: READY };
const SIGNED_OUT: SetupInfo = { agent: claude({ state: 'signed-out' }), git: READY };
const SIGNING: SetupInfo = { agent: claude({ state: 'signed-out', signIn: { url: 'https://claude.ai/oauth/authorize?x=1' } }), git: READY };
const DONE: SetupInfo = { agent: claude({ state: 'ready' }), git: READY };

/** A server that answers from `now`, takes each ask into `asks`, and answers an ask with what `after` gives. */
function server(first: SetupInfo, after: (ask: SetupAsk) => SetupInfo | Promise<SetupInfo> = () => first) {
  const s = {
    now: first,
    asks: [] as SetupAsk[],
    looks: 0,
    down: false,
    fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (s.down) throw new Error('down');
      expect(String(url)).toBe(`http://board${ROUTES.setup}`);
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer owner-token');
      if (init?.method === 'POST') {
        const ask = JSON.parse(String(init.body)) as SetupAsk;
        s.asks.push(ask);
        s.now = await after(ask);
      } else {
        s.looks += 1;
      }
      return new Response(JSON.stringify(s.now), { status: 200 });
    }) as typeof fetch,
  };
  return s;
}

const show = (s: ReturnType<typeof server>, first: SetupInfo = s.now) =>
  render(
    <SetupGate http={{ base: 'http://board', token: 'owner-token', fetch: s.fetch }} first={first}>
      <div data-testid="board">the board</div>
    </SetupGate>,
  );
const step = (id: string) => screen.getByTestId(`setup-${id}`);
const tick = (ms = LOOK_MS) => act(() => vi.advanceTimersByTimeAsync(ms));
const press = async (testId: string) => {
  fireEvent.click(screen.getByTestId(testId));
  await act(() => vi.advanceTimersByTimeAsync(0));
};

beforeEach(() => {
  vi.useFakeTimers();
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the steps', () => {
  it('lists install, sign-in and git, with one button: on the first step that is not done', () => {
    expect(stepsOf(MISSING).map((s) => [s.id, s.state])).toEqual([['install', 'now'], ['sign-in', 'later'], ['git', 'done']]);
    expect(stepsOf(SIGNED_OUT).map((s) => [s.id, s.state])).toEqual([['install', 'done'], ['sign-in', 'now'], ['git', 'done']]);
    expect(stepsOf({ ...DONE, git: NO_GIT }).map((s) => [s.id, s.state])).toEqual([['install', 'done'], ['sign-in', 'done'], ['git', 'todo']]);
    expect(stepsOf({ git: NO_GIT }).map((s) => [s.id, s.state])).toEqual([['git', 'todo']]);
  });

  it('opens a sign-in address only when it is https', () => {
    expect(signInUrl('https://claude.ai/oauth/authorize?x=1')).toBe('https://claude.ai/oauth/authorize?x=1');
    for (const bad of ['javascript:alert(1)', 'http://claude.ai/', 'file:///etc/passwd', 'claude.ai', '', undefined, 7]) expect(signInUrl(bad)).toBeUndefined();
  });
});

describe('asking the server', () => {
  it('gives what the server says, and nothing when it does not say', async () => {
    vi.useRealTimers();
    const s = server(SIGNED_OUT);
    const http = { base: 'http://board', token: 'owner-token', fetch: s.fetch };
    expect(await callSetup(http)).toEqual(SIGNED_OUT);
    expect(await callSetup(http, { action: 'sign-in' })).toEqual(SIGNED_OUT);
    expect(s.asks).toEqual([{ action: 'sign-in' }]);

    const answers = (res: () => Response | Promise<Response>) => callSetup({ base: 'http://board', token: 't', fetch: (async () => res()) as typeof fetch });
    expect(await answers(() => new Response('{"error":"no"}', { status: 404 }))).toBeUndefined();
    expect(await answers(() => new Response('{"name":"board"}', { status: 200 }))).toBeUndefined();
    expect(await answers(() => new Response('not json', { status: 200 }))).toBeUndefined();
    expect(await answers(() => Promise.reject(new Error('down')))).toBeUndefined();
  });
});

describe('the setup page', () => {
  it('shows the board at once when nothing is left', () => {
    show(server(DONE));
    expect(screen.getByTestId('board')).toBeTruthy();
    expect(screen.queryByTestId('setup')).toBeNull();
  });

  it('installs Claude Code on a press, says so while it runs, and moves to the sign-in', async () => {
    let finish: (v: SetupInfo) => void = () => {};
    const s = server(MISSING, () => new Promise<SetupInfo>((r) => (finish = r)));
    show(s);
    expect(step('install').dataset.state).toBe('now');
    expect(step('sign-in').dataset.state).toBe('later');
    expect(step('sign-in').textContent).toContain('After Claude Code is installed.');
    expect(screen.queryByTestId('setup-sign-in-go')).toBeNull();
    expect(screen.getByTestId('setup').textContent).toContain('2 steps are left.');

    await press('setup-install-go');
    expect(s.asks).toEqual([{ action: 'install' }]);
    const go = screen.getByTestId('setup-install-go') as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect(go.textContent).toBe('Installing…');

    await act(async () => finish(SIGNED_OUT));
    expect(step('install').dataset.state).toBe('done');
    expect(step('sign-in').dataset.state).toBe('now');
    expect(screen.getByTestId('setup').textContent).toContain('One step is left.');
    expect(screen.queryByTestId('board')).toBeNull();
  });

  it('says it is installing when the server says so, as after a reload', () => {
    show(server({ agent: claude({ state: 'missing', installing: true }), git: READY }));
    expect((screen.getByTestId('setup-install-go') as HTMLButtonElement).disabled).toBe(true);
  });

  it('says why a step failed, in the words the server gave', () => {
    show(server({ agent: claude({ state: 'missing', note: 'The installer could not be fetched: offline' }), git: READY }));
    expect(screen.getByTestId('setup-note').textContent).toBe('The installer could not be fetched: offline');
    expect(screen.getByTestId('setup-note').getAttribute('role')).toBe('alert');
  });

  it('starts a sign-in on a press, waits, and opens the board when the server says it is signed in', async () => {
    const s = server(SIGNED_OUT, () => SIGNING);
    show(s);
    await press('setup-sign-in-go');
    expect(s.asks).toEqual([{ action: 'sign-in' }]);
    expect(screen.getByTestId('setup-waiting').textContent).toContain('Waiting for you to approve the sign-in');
    const link = screen.getByTestId('setup-sign-in-link') as HTMLAnchorElement;
    expect(link.href).toBe('https://claude.ai/oauth/authorize?x=1');
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noreferrer');

    // The owner approves in the other tab. The page hears of it on its next look.
    await tick();
    expect(screen.queryByTestId('board')).toBeNull();
    s.now = DONE;
    await tick();
    expect(screen.getByTestId('board')).toBeTruthy();
    expect(screen.queryByTestId('setup')).toBeNull();

    // With the board open, the page stops asking.
    const looks = s.looks;
    await tick(LOOK_MS * 3);
    expect(s.looks).toBe(looks);
  });

  it('offers no link for an address that is not https', () => {
    show(server({ agent: claude({ state: 'signed-out', signIn: { url: 'javascript:alert(1)' } }), git: READY }));
    expect(screen.getByTestId('setup-waiting')).toBeTruthy();
    expect(screen.queryByTestId('setup-sign-in-link')).toBeNull();
  });

  it('hands over a pasted code, and can start the sign-in again', async () => {
    const refused = { agent: claude({ state: 'signed-out', note: "Couldn't log in: That code wasn't accepted." }), git: READY } satisfies SetupInfo;
    const s = server(SIGNING, (ask) => (ask.action === 'code' ? refused : SIGNING));
    show(s);
    const send = screen.getByTestId('setup-code-go') as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('setup-code'), { target: { value: ' abc#def ' } });
    expect(send.disabled).toBe(false);
    await press('setup-code-go');
    expect(s.asks).toEqual([{ action: 'code', code: ' abc#def ' }]);
    // The sign-in ended: the note says why, and the first button is back.
    expect(screen.getByTestId('setup-note').textContent).toBe("Couldn't log in: That code wasn't accepted.");
    await press('setup-sign-in-go');
    expect(s.asks.at(-1)).toEqual({ action: 'sign-in' });
    await press('setup-sign-in-again');
    expect(s.asks.filter((a) => a.action === 'sign-in')).toHaveLength(2);
  });

  it('says how to get git, with no button, and counts it as a step', () => {
    show(server({ ...DONE, git: NO_GIT }));
    expect(step('git').dataset.state).toBe('todo');
    expect(step('git').textContent).toContain('Not found. A build needs it. Run "xcode-select --install" in a terminal.');
    expect(step('git').querySelector('button')).toBeNull();
    expect(screen.getByTestId('setup').textContent).toContain('One step is left.');
  });

  it('lists only git when the linked agent needs nothing', () => {
    show(server({ git: NO_GIT }));
    expect(screen.queryByTestId('setup-install')).toBeNull();
    expect(screen.queryByTestId('setup-sign-in')).toBeNull();
    expect(step('git')).toBeTruthy();
  });

  it('keeps what is on the page when the server stops answering', async () => {
    const s = server(SIGNED_OUT);
    show(s);
    s.down = true;
    await tick();
    expect(step('sign-in').dataset.state).toBe('now');
  });

  it('opens the board without the setup on a press, and this tab does not ask again', async () => {
    expect(setupSkipped()).toBe(false);
    const s = server(SIGNED_OUT);
    show(s);
    await press('setup-skip');
    expect(screen.getByTestId('board')).toBeTruthy();
    expect(setupSkipped()).toBe(true);
    const looks = s.looks;
    await tick(LOOK_MS * 2);
    expect(s.looks).toBe(looks);
  });

  it('a tab with no storage asks again, and breaks nothing', () => {
    const none = { sessionStorage: { getItem: () => { throw new Error('no storage'); }, setItem: () => { throw new Error('no storage'); } } } as unknown as Window;
    expect(() => skipSetup(none)).not.toThrow();
    expect(setupSkipped(none)).toBe(false);
  });
});
