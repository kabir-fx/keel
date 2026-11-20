import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the page runs on Vite and the board server runs on its own port.
// KEEL_SERVER points the proxy at it, for example KEEL_SERVER=http://127.0.0.1:4790.
const server = process.env.KEEL_SERVER ?? 'http://127.0.0.1:4790';

export default defineConfig({
  plugins: [react()],
  server: {
    // The board server answers only to its own Host, so the proxy sends that one. It also
    // checks the page's Origin: start it with --dev-origin http://localhost:5173.
    proxy: {
      '/api': { target: server, changeOrigin: true },
      '/ws': { target: server, ws: true, changeOrigin: true },
    },
  },
  // No source maps ship: the built page is all the browser gets.
  build: { outDir: 'dist', sourcemap: false },
});
