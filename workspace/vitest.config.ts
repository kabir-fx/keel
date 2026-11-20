import { defineConfig } from 'vitest/config';

// One project per package. A package adds its own vitest.config.ts when it needs a DOM.
export default defineConfig({
  test: {
    projects: ['protocol', 'pictures', 'server', 'app', 'plugin'],
  },
});
