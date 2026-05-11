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
