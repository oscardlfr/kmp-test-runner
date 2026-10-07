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
      include: ['lib/**/*.js'],
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        lines: 91,
        functions: 91,
        branches: 83,
        // Vitest 4's V8 AST remapping changed the measured statement rate.
        // The same passing suite measured 89.30% on Linux and 89.71% on Windows
        // after the upgrade; keep a cross-platform floor while tightening the
        // branch and function floors to the new provider's observed baseline.
        statements: 89,
      },
      thresholdAutoUpdate: false,
    },
  },
});
