import '@fontsource/caveat/600.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/space-grotesk/600.css';
import '@fontsource/space-grotesk/700.css';
import '@keel/pictures/styles.css';
import './styles/index.css';

import type { Id } from '@keel/protocol';
import { ROUTES } from '@keel/protocol';
import type { PictureView } from '@keel/pictures';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { cutAt, fixtureNames, loadFixture, openingOf } from './fixture';
import type { BoardSource } from './source';
import { CODE_SPENT, forgetToken, localSource, OPEN_FROM_TERMINAL, serverSource, socketUrl, takeCode, takeToken, tradeCode } from './source';

/**
 * Two ways in:
 * - `?fixture=<name>&at=<checkpoint>` replays a fixture in memory, with no server, opening on
 *   what the checkpoint's view says.
 * - otherwise the page talks to the board server that served it, with the owner's token: traded
 *   for the one-time code in the address, or kept in this page's own storage from before.
 */
async function boot(): Promise<{ source: BoardSource; show?: Id[]; view?: PictureView; focus?: Id; mode?: 'board' | 'story'; fixture?: boolean } | { problem: string; title?: string }> {
  const params = new URLSearchParams(window.location.search);
  const fixture = params.get('fixture');
  if (fixture) {
    const fx = await loadFixture(fixture);
    if (!fx) return { problem: `There is no fixture "${fixture}". Fixtures here: ${fixtureNames().join(', ') || 'none'}.` };
    const at = params.has('at') ? Number(params.get('at')) : undefined;
    const { events, checkpoint } = cutAt(fx, Number.isFinite(at) ? at : undefined);
    if (checkpoint) document.title = `${checkpoint.title} · Keel`;
    const opening = openingOf(checkpoint);
    const source = localSource({
      events,
      ...(opening.presence ? { presence: opening.presence } : {}),
      // Each event the board admits is announced, so a test can watch what the app posts.
      onAdmit: (event) => window.dispatchEvent(new CustomEvent('keel:admit', { detail: event })),
    });
    return { source, fixture: true, view: opening.view, mode: opening.mode, ...(opening.show ? { show: opening.show } : {}), ...(opening.focus ? { focus: opening.focus } : {}) };
  }

  // The address from the terminal holds a code that works once. The page trades it for the
  // owner's token, which lasts while that server runs, and keeps the token in its own storage.
  // Every call and the websocket carry the token; no cookie is used.
  const code = takeCode();
  let token: string | undefined;
  let spent = false;
  if (code) {
    const got = await tradeCode(code, { base: window.location.origin, route: ROUTES.session });
    if (got.ok) token = got.token;
    else spent = got.why === 'spent';
  }
  // The same address opened twice in one browser: the token from the first time still works.
  token ??= takeToken();
  if (!token) return spent ? { problem: CODE_SPENT, title: 'This address no longer opens the board' } : { problem: OPEN_FROM_TERMINAL, title: 'This page has no key to the board' };
  return {
    source: serverSource({
      url: socketUrl(window.location, token, ROUTES.ws),
      http: { base: window.location.origin, token },
      onRefused: () => forgetToken(),
    }),
  };
}

const root = createRoot(document.getElementById('root')!);
boot().then((r) => {
  if ('problem' in r) {
    root.render(
      <main className="problem" data-testid="problem">
        <h1>{r.title ?? 'The board cannot open'}</h1>
        <p>{r.problem}</p>
      </main>,
    );
    return;
  }
  root.render(
    <StrictMode>
      <App source={r.source} show={r.show} view={r.view} focus={r.focus} mode={r.mode} remember={!r.fixture} />
    </StrictMode>,
  );
});
