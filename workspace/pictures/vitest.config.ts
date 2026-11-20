import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'pictures',
    environment: 'happy-dom',
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
