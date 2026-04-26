import { defineConfig } from 'vitest/config';

// measure-token-cost.test.js trips a vitest 2.1.x transform bug on
// Windows-latest CI specifically (Node 20.20.x runner): a SyntaxError
// surfaces at column 25-31 of whatever line the file happens to start its
// imports on, regardless of how the file is restructured (header comments
// removed, vi.mock dropped, import.meta.url removed, structure mirrored
// from cli.test.js, all non-ASCII chars stripped). The same file parses
// cleanly on Linux CI, locally on macOS, and locally on Windows with
// Node 24. cli.test.js, which is structurally similar, parses fine on the
// same Windows CI runner — so the trigger is content-specific and not
// reproducible on Node 24.
//
// Skip only on CI Windows (process.env.CI === 'true' set by GitHub Actions).
// Local Windows dev still runs the full suite.
const winCISkip = process.env.CI === 'true' && process.platform === 'win32'
  ? ['**/measure-token-cost.test.js']
  : [];

export default defineConfig({
  test: {
    include: ['tests/vitest/**/*.test.js'],
    exclude: ['**/node_modules/**', ...winCISkip],
    // pool: default ('threads') — DO NOT use 'forks' (kills coverage)
    coverage: {
      provider: 'v8',
      all: true,
      include: ['lib/**/*.js'],
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
