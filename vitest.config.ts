import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Single node project for MVP — unit tests live in core/server/shared, plus PURE
// client logic (*.test.ts, e.g. readiness). React component tests (*.test.tsx) need a
// jsdom project, deliberately deferred — they won't run here (the glob is .test.ts only).
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/client'),
      '@core': path.resolve(__dirname, 'src/core'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  test: {
    passWithNoTests: true,
    environment: 'node',
    include: ['src/{core,server,shared}/**/*.test.ts', 'src/client/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      exclude: ['src/server/index.ts', 'src/client/**'],
    },
  },
});
