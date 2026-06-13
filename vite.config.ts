import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

// Client dev server proxies /api to the Fastify server. In prod the server
// serves the built client (dist/client) via @fastify/static.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: 'src/client',
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/client'),
      '@core': path.resolve(__dirname, './src/core'),
      '@shared': path.resolve(__dirname, './src/shared'),
    },
  },
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // Don't let scan writes (reports/cache) under .earwitness trigger HMR reloads.
    watch: { ignored: ['**/.earwitness/**'] },
    proxy: {
      // Regex (not bare '/api') so it doesn't swallow the client's own /api.ts module.
      '^/api/': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
