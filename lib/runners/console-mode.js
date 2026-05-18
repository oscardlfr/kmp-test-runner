// SPDX-License-Identifier: MIT
// lib/runners/console-mode.js — TTY-aware gradle ANSI gate.
//
// Decides whether spawnGradle should auto-inject `--console=plain` into the
// gradle subprocess argv. The repo itself emits zero ANSI; this defends
// against gradle's own `--console=auto` writing ANSI into pipes when the
// process is captured (e.g. `kmp-test parallel | tee log`) or run under a
// CI harness whose PTY misreports `isTTY`.
//
// `_mode` is module-level state set once by cli.js at entry (--color flag).
// Production callsites use `shouldInjectConsolePlain()` with no arguments;
// tests pass overrides for the decision matrix. Resetting between tests:
// `setConsoleMode('auto')` in beforeEach.

const VALID_MODES = Object.freeze(['always', 'never', 'auto']);

// Initial mode reads `KMP_COLOR_MODE` so the choice survives the
// `node bin/kmp-test.js → pwsh/bash → node lib/runner.js` re-exec chain
// without having to re-thread `--color` through the wrapper scripts.
// cli.js sets the env var on the script spawn before forking.
let _mode = (() => {
  const fromEnv = process.env.KMP_COLOR_MODE;
  return fromEnv && VALID_MODES.includes(fromEnv) ? fromEnv : 'auto';
})();

export function setConsoleMode(mode) {
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`invalid --color mode: ${mode} (expected one of: ${VALID_MODES.join(', ')})`);
  }
  _mode = mode;
  // Propagate to descendant Node processes (lib/runner.js spawned by the
  // ps1/sh wrappers re-reads this on import).
  process.env.KMP_COLOR_MODE = mode;
}

export function getConsoleMode() {
  return _mode;
}

// Returns true when `--console=plain` should be injected into the gradle
// subprocess argv. Decision order: explicit mode wins, then NO_COLOR (POSIX
// standard — any non-empty value means "no color"), then isTTY.
export function shouldInjectConsolePlain({ mode = _mode, env = process.env, isTTY = process.stdout.isTTY } = {}) {
  if (mode === 'always') return false;
  if (mode === 'never') return true;
  if (env.NO_COLOR && env.NO_COLOR !== '') return true;
  if (isTTY === false) return true;
  return false;
}
