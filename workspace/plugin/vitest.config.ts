import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'plugin', include: ['test/**/*.test.ts'], testTimeout: 15_000 },
});
