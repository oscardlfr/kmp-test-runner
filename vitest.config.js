import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/vitest/**/*.test.js'],
    // Windows-only tests spawn Windows PowerShell or pwsh, often several times in one test, and
    // one PowerShell start alone can take 1-3 s on a loaded hosted runner. The 5 s default failed
    // such tests on slow runs with nothing wrong; other platforms keep the 5 s default.
    testTimeout: process.platform === 'win32' ? 30_000 : 5_000,
    // pool: default ('threads') — DO NOT use 'forks' (kills coverage)
    coverage: {
      provider: 'v8',
      all: true,
      include: ['lib/**/*.js'],
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        lines: 91,
        functions: 90,
        branches: 80,
        statements: 91,
      },
      thresholdAutoUpdate: false,
    },
  },
});
