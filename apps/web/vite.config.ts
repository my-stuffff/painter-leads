import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// `vite --mode mock` (or VITE_MOCK=1) answers every /api call from in-memory data in the browser, so the client can
// be built and checked without the server. The production build never contains the mock: the branch that loads it is
// a compile-time constant there and the dynamic import is dropped.
export default defineConfig(({ mode }) => {
  const mock = mode === 'mock' || process.env.VITE_MOCK === '1';
  return {
    plugins: [react(), tailwindcss()],
    define: { 'import.meta.env.VITE_MOCK': JSON.stringify(mock ? '1' : '0') },
    build: {
      outDir: 'dist/client',
      emptyOutDir: true,
      chunkSizeWarningLimit: 900,
    },
    server: {
      port: 5173,
      proxy: mock ? undefined : { '/api': { target: 'http://localhost:8787', changeOrigin: false } },
    },
    preview: { port: 4173 },
  };
});
