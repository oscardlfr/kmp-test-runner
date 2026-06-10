// SPDX-License-Identifier: MIT
// lib/parsers/argv-constants.js — shared enum allowlists for orchestrator
// parseArgs validators. Single source of truth; eliminates literal
// duplication across coverage / parallel/dispatch / changed / benchmark
// orchestrators (pre-v0.10 refactor Phase 3 Option B, 2026-05-11).
//
// Pattern: each allowlist is a frozen array consumed by validateEnum(...) in
// lib/orchestrator-utils.js. Adding a value still requires updating help
// text, README flag tables, and the PowerShell wrapper's [ValidateSet(...)]
// in parallel — this file is NOT the only place to change.

export const TEST_TYPE_VALUES = Object.freeze([
  'common', 'jvm', 'android', 'androidUnit', 'androidInstrumented',
  'ios', 'macos', 'js', 'wasm', 'desktop', 'all',
]);

export const COVERAGE_TOOL_VALUES = Object.freeze(['auto', 'kover', 'jacoco', 'none']);

export const PLATFORM_VALUES = Object.freeze(['android', 'jvm', 'all']);

// String-valued flags accepted by the script-backed subcommands, used by the
// cli.js pre-spawn dangling gate: a run whose LAST token is one of these has
// no value to bind, and must exit CONFIG_ERROR before the wrapper spawn —
// on Windows the ps1 wrapper's typed param block otherwise dies with an
// unstructured parameter-binding error that the legacy output parser can
// only classify as `no_summary`.
//
// Deliberately absent (each has a dedicated gate with a richer message):
//   --test-filter        → argv.js#consumeTestFilter
//   --isolated-cache-dir → argv.js#peekIsolatedFlags
// Enum / numeric flags (--test-type, --max-workers, …) are also absent —
// the cli.js pre-spawn validator loop already rejects their dangling form
// via validateEnum / validateNonNegativeInt. Boolean flags live in
// script-dispatcher.js#KNOWN_BOOLEAN_FLAGS.
export const VALUE_BEARING_FLAGS = Object.freeze([
  '--module-filter', '--coverage-modules', '--exclude-coverage',
  '--exclude-modules', '--output-file', '--benchmark-config',
  '--variant', '--android-variant', '--device', '--device-task',
  '--flavor', '--capture-dir', '--gradle-args', '--config',
  '--project-root', '--java-home', '--color',
]);
