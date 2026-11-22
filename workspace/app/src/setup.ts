import type { SetupAsk, SetupInfo } from '@keel/protocol';
import { ROUTES } from '@keel/protocol';

/**
 * What the page asks the server about this machine: is Claude Code installed, new enough and
 * signed in, is there a git. The page that shows it is `SetupPage.tsx`.
 */

export interface SetupHttp {
  base: string;
  token: string;
  fetch?: typeof fetch;
}

function isSetup(v: unknown): v is SetupInfo {
  const git = (v as { git?: { state?: unknown } } | null)?.git;
  return git?.state === 'ready' || git?.state === 'missing';
}

/**
 * How the machine stands, after the step asked for when one is asked. Undefined when the
 * server did not say: it stopped, or it is one from before this page.
 */
export async function callSetup(http: SetupHttp, ask?: SetupAsk): Promise<SetupInfo | undefined> {
  try {
    const res = await (http.fetch ?? fetch)(http.base + ROUTES.setup, {
      method: ask ? 'POST' : 'GET',
      credentials: 'omit',
      cache: 'no-store',
      headers: { authorization: `Bearer ${http.token}`, ...(ask ? { 'content-type': 'application/json' } : {}) },
      ...(ask ? { body: JSON.stringify(ask) } : {}),
    });
    if (!res.ok) return undefined;
    const body: unknown = await res.json();
    return isSetup(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

export interface Step {
  id: 'install' | 'sign-in' | 'git';
  title: string;
  /** `now`: the one step with a button. `later`: it waits for the step before it. `todo`: the owner does it outside the page. */
  state: 'done' | 'now' | 'later' | 'todo';
}

/** The steps the page lists, in order. The agent's two are left out when the linked agent needs nothing. */
export function stepsOf(s: SetupInfo): Step[] {
  const steps: Step[] = [];
  if (s.agent) {
    const a = s.agent.state;
    const install = a === 'missing' || a === 'outdated';
    steps.push({ id: 'install', title: s.agent.name, state: install ? 'now' : 'done' });
    steps.push({ id: 'sign-in', title: 'Claude sign-in', state: a === 'ready' ? 'done' : install ? 'later' : 'now' });
  }
  steps.push({ id: 'git', title: 'git', state: s.git.state === 'ready' ? 'done' : 'todo' });
  return steps;
}

/** The sign-in page's address, when it is one a link may open. */
export function signInUrl(address: unknown): string | undefined {
  if (typeof address !== 'string') return undefined;
  try {
    return new URL(address).protocol === 'https:' ? address : undefined;
  } catch {
    return undefined;
  }
}

const SKIPPED = 'keel:setup-skipped';

/** The owner opened the board without finishing: this tab does not ask again. */
export function setupSkipped(win: Pick<Window, 'sessionStorage'> = window): boolean {
  try {
    return win.sessionStorage.getItem(SKIPPED) === '1';
  } catch {
    return false;
  }
}

export function skipSetup(win: Pick<Window, 'sessionStorage'> = window): void {
  try {
    win.sessionStorage.setItem(SKIPPED, '1');
  } catch {
    // No storage: the page asks again on a reload.
  }
}
