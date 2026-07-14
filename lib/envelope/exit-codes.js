// SPDX-License-Identifier: MIT
// lib/envelope/exit-codes.js — semantic exit codes + envelope schema version

/**
 * Semantic exit codes (documented in --help and README).
 * @type {{SUCCESS:0, TEST_FAIL:1, CONFIG_ERROR:2, ENV_ERROR:3}}
 * @property {0} SUCCESS - All tests passed.
 * @property {1} TEST_FAIL - Script ran, tests failed.
 * @property {2} CONFIG_ERROR - Bad CLI usage (unknown subcommand, missing arg, invalid flag value).
 * @property {3} ENV_ERROR - Missing gradlew / bash / pwsh / JDK / project root.
 */
export const EXIT = {
  SUCCESS: 0,        // all tests passed
  TEST_FAIL: 1,      // script ran, tests failed
  CONFIG_ERROR: 2,   // bad CLI usage (unknown subcommand, missing arg)
  ENV_ERROR: 3,      // missing gradlew, missing bash/pwsh, etc.
};

// Top-level envelope schema version. Bumped on every
// breaking shape change to the JSON envelope so agents can branch on
// `envelope.schema_version` without inspecting individual fields. Distinct
// from `describe.schema_version` (which tracks the project-model schema and
// is sourced from buildProjectModel — a different contract). Bump on:
//   - removing or renaming a top-level field
//   - changing the type of an existing field
//   - changing the semantics of an exit-code/error-code mapping
// New ADDITIVE fields (e.g. a future top-level `notices:[]`) do NOT bump.
//
// Version 2 (v0.9 envelope contract — see docs/envelope-contract.md):
//   - OBS-3: `no_test_modules` exit-code semantics split — empty match
//     downstream of a user filter is now CONFIG_ERROR (2); empty match
//     against a project that genuinely has no test modules stays
//     ENV_ERROR (3). Errors[] carries new `caused_by_filter:bool` field
//     to discriminate.
//   - OBS-7: `flavor_unused` promoted from `warnings[]` to `errors[]`,
//     mapped to CONFIG_ERROR (2). Pre-fix the misconfiguration was a
//     soft warning + exit 0.
//   - OBS-4: new `isolated_runtime_race` discriminator + CONFIG_ERROR (2)
//     when `--isolated` is combined with test types that hit shared
//     runtime resources (ios sim, ADB without --device).
// Additive in same release (do NOT bump on their own):
//   - OBS-1: `doctor` envelope unified with other subcommands (added
//     tests/modules/skipped/coverage/errors/warnings empty defaults).
//   - OBS-2: `--dry-run --json` plan now carries `plan.modules[]` and
//     `plan.skipped[]` (resolved module set).
//   - OBS-6: `--list-only` populates top-level `modules[]` + echoes
//     `--device <serial>` to `android.device_serial`.
export const ENVELOPE_SCHEMA_VERSION = 2;

// `update` is the only async subcommand (uses fetch). When main() returns
// this sentinel, bin/kmp-test.js skips its sync process.exit and relies on
// the orchestrator's .then callback to call process.exit when the async
// work resolves. Keeps main() callable as a sync function from cli.test.js
// (89 existing call sites) without introducing a top-level async refactor.
export const ASYNC_DEFERRED = -42;

// Exported for direct test access (iterate real membership instead of a
// hardcoded parallel list) — NOT part of the published envelope contract
// surface. Docs describe the resulting codes/behavior, never these set
// names; keep it that way. Subject to change without a schema_version bump.
//
// CONFIG_ERROR_CODES: discriminated errors[].code values that mean the run
// never should have started as configured (usage-level, not the project's
// fault) — `no_test_modules` also lands here specifically when the empty
// match was caused by a user-supplied filter (see classifyExitCode).
export const CONFIG_ERROR_CODES = new Set(['flavor_unused', 'isolated_runtime_race']);

// ENV_ERROR_CODES: discriminated errors[].code values that mean the
// environment/toolchain couldn't run the tests as opposed to the tests
// themselves failing an assertion. `task_not_found` (gradle can't locate
// the requested task — a stale/misconfigured build, not a failing test) and
// `unsupported_class_version` (JDK/toolchain mismatch) belong here even
// though they're discovered alongside a `module_failed` entry for the same
// module — they take priority over the generic test-failure classification.
export const ENV_ERROR_CODES = new Set([
  'task_not_found', 'unsupported_class_version', 'instrumented_setup_failed',
  'platform_unsupported', 'gradle_timeout',
]);

/**
 * Classifies a discriminated errors[] array (plus an optional test-failure
 * count) into the correct EXIT.* value, honoring the published exit-code
 * contract's priority order: CONFIG_ERROR > ENV_ERROR > TEST_FAIL > SUCCESS.
 * The one central mapping point shared by every orchestrator's final
 * exit-code decision (parallel/android/benchmark) and by
 * enforceErrorsExitCodeInvariant's dispatcher-level promotion target.
 *
 * The TEST_FAIL branch is a catch-all, not an allowlist: any error that
 * survives the CONFIG/ENV checks is presumed a hard failure (matching every
 * orchestrator's pre-existing "any error means something's wrong" default),
 * so an unclassified/future error code never silently falls through to
 * SUCCESS just because nobody added it to a set yet.
 */
export function classifyExitCode(errors, { testsFailed = 0 } = {}) {
  const list = (errors || []).filter(Boolean);
  const isFilteredNoModules = (e) => e.code === 'no_test_modules' && e.caused_by_filter === true;
  if (list.some((e) => CONFIG_ERROR_CODES.has(e.code) || isFilteredNoModules(e))) {
    return EXIT.CONFIG_ERROR;
  }
  if (list.some((e) => ENV_ERROR_CODES.has(e.code) || (e.code === 'no_test_modules' && !isFilteredNoModules(e)))) {
    return EXIT.ENV_ERROR;
  }
  if (testsFailed > 0 || list.length > 0) return EXIT.TEST_FAIL;
  return EXIT.SUCCESS;
}
