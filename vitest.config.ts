import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Single node project for MVP — unit tests live in core/server/shared. A jsdom
// client project can be added later when we test React components.
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
    include: ['src/{core,server,shared}/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      exclude: ['src/server/index.ts', 'src/client/**'],
    },
  },
});
