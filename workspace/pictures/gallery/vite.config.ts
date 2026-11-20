import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The gallery: every picture of the golden fixture at a checkpoint, and the contract's
// examples. Run from workspace/: npx vite --config pictures/gallery/vite.config.ts
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: { port: 5288, strictPort: true, host: '127.0.0.1' },
});
