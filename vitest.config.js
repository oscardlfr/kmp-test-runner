import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    pool: 'forks',
    setupFiles: ['tests/vitest/setup.js'],
    include: ['tests/vitest/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
      thresholdAutoUpdate: false,
      include: ['bin/**/*.js'],
    },
  },
});
