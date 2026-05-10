// SPDX-License-Identifier: MIT
// lib/envelope/exit-codes.js — semantic exit codes + envelope schema version

// Semantic exit codes (documented in --help and README)
export const EXIT = {
  SUCCESS: 0,        // all tests passed
  TEST_FAIL: 1,      // script ran, tests failed
  CONFIG_ERROR: 2,   // bad CLI usage (unknown subcommand, missing arg)
  ENV_ERROR: 3,      // missing gradlew, missing bash/pwsh, etc.
};

// v0.9 session 2 Bug-K — top-level envelope schema version. Bumped on every
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
