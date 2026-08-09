// SPDX-License-Identifier: MIT
// lib/parsers/argv-constants.js — shared enum allowlists and flag registries
// for orchestrator parseArgs validators. Single source of truth; eliminates
// literal duplication across coverage / parallel/dispatch / changed /
// benchmark orchestrators (pre-v0.10 refactor Phase 3 Option B, 2026-05-11).
//
// Pattern: each allowlist is a frozen array consumed by validateEnum(...) in
// lib/orchestrator-utils.js. Adding a value requires updating help text and
// README flag tables — this file is NOT the only place to change.

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

// Flags whose values may intentionally start with `--` — they forward
// verbatim to an external tool (Gradle). requireFlagValue skips the
// flag-shaped-value guard for these so that e.g.
// `--gradle-args --no-parallel` is not mis-classified as a missing value.
export const OPAQUE_VALUE_FLAGS = Object.freeze(new Set(['--gradle-args']));

// Union of all --flag tokens accepted by any script-backed subcommand.
// Used by the cli.js Layer-1 unknown-flag gate (rejects flags unknown to
// ALL subcommands — e.g. --no-such-kmp-flag — before the PS wrapper spawns,
// where an unrecognized param would produce an unstructured binding error).
//
// Does NOT include flags stripped by cli.js before this gate runs (--dry-run,
// --json, --format, --force, --color) but DOES include flags that are consumed
// or peeked AFTER the gate (--test-filter, --isolated*, --project-root, etc.)
// because they are still present in cleanedArgs at gate time.
//
// Layer-2 (each orchestrator's default: case) catches cross-subcommand misuse
// (e.g. --android-variant with `changed`); both layers emit unknown_flag.
export const ALL_KNOWN_FLAGS = Object.freeze(new Set([
  // VALUE_BEARING_FLAGS (string value):
  '--module-filter', '--coverage-modules', '--exclude-coverage',
  '--exclude-modules', '--output-file', '--benchmark-config',
  '--variant', '--android-variant', '--device', '--device-task',
  '--flavor', '--capture-dir', '--gradle-args', '--config',
  '--project-root', '--java-home', '--color',
  // Enum / numeric (pre-spawn validated in cli.js):
  '--test-type', '--coverage-tool', '--platform',
  '--max-workers', '--timeout', '--min-missed-lines',
  // Boolean flags (from script-dispatcher.js KNOWN_BOOLEAN_FLAGS):
  '--skip-tests', '--include-shared', '--include-untested',
  '--no-coverage', '--coverage-only', '--ignore-jdk-mismatch',
  '--list-only', '--list', '--no-jdk-autoselect', '--isolated',
  '--isolated-no-lock', '--staged-only', '--show-modules-only',
  '--no-adb', '--skip-probe', '--no-cache', '--clear-data',
  '--auto-retry', '--capture-on-fail', '--skip-app', '--verbose',
  '--fresh-daemon', '--prerelease', '--check', '--ignore-gradle-timeout',
  // Additional flags consumed/peeked by cli.js at or after gate time:
  '--isolated-cache-dir', '--test-filter',
  // Orchestrator-only flags not in the sets above:
  '--no-config-cache', '--no-coverage-xml-autofix', '--benchmark',
  '--strict-timeouts',
]));
