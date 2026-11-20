import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'app',
    environment: 'happy-dom',
    include: ['test/**/*.test.{ts,tsx}'],
    // The page asks for reduced motion in every test unless the test says otherwise.
    setupFiles: ['test/setup.ts'],
  },
});
