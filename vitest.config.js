import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/vitest/**/*.test.js'],
    // pool: default ('threads') — DO NOT use 'forks' (kills coverage)
    coverage: {
      provider: 'v8',
      all: true,
      include: ['bin/**/*.js'],
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
      thresholdAutoUpdate: false,
    },
  },
});
