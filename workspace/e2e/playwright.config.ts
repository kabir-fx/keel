import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Each run serves the app on its own port unless told one, so two runs at once (two agents
// on one checkout) never share, or stop, each other's server. The main process picks the port
// and its workers inherit it through the environment.
process.env.KEEL_E2E_PORT ??= String(5200 + (process.pid % 700));
const PORT = Number(process.env.KEEL_E2E_PORT);

// Each run also builds the app into a folder of its own, named by its port, and serves it from
// there. Two runs at once would otherwise build into the same `app/dist`, and one would empty
// the folder the other is serving.
process.env.KEEL_E2E_DIST ??= join(tmpdir(), `keel-e2e-dist-${PORT}`);
const DIST = process.env.KEEL_E2E_DIST;

/**
 * End-to-end runs on the system Chrome: no browser is downloaded. The app is built from
 * workspace/app into this run's own folder and served from it by `vite preview`, in fixture
 * mode, so no board server is needed. A built page has no hot reload, so a file another agent
 * saves mid-run cannot reload a page under a test.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: [['list']],
  use: {
    channel: 'chrome',
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    // The camera jumps where it would glide, so every test sees it land at once. A test of the
    // glide itself turns this off with `page.emulateMedia({ reducedMotion: 'no-preference' })`.
    reducedMotion: 'reduce',
  },
  webServer: {
    command: `npx vite build --logLevel warn --outDir "${DIST}" --emptyOutDir && npx vite preview --outDir "${DIST}" --port ${PORT} --strictPort --host 127.0.0.1`,
    cwd: '../app',
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
