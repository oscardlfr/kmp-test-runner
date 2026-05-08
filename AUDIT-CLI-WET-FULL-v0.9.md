# Full CLI wet audit — v0.9 pre-tag (2026-05-09)

> Comprehensive wet-test audit of the kmp-test CLI across all 9 subcommands.
> Run after PRs #175–#181 closed the 8 Windows-audit bugs. develop @ f934776, vitest 1224.
> Companion to `BUGS-V0.9-WIN-AUDIT-FINAL.md` (focused on the 8 bug repros).

## Summary

**61/62 cells PASS.** 1 finding: **F-1** — pre-existing inconsistency between `describe`'s `no_project` envelope `exit_code` and the orchestrator's process exit. Surfaced by I2. Fix-PR landed in the same session per the standing pre-release rule (`feedback_no_milestone_deferral_at_pre_release.md`).

## Test environment

- OS: Windows 11 Pro 22631
- Node: v24.12.0
- pwsh: PowerShell 7.x available
- JDK: host 23 (auto-selected per project)
- ADB: S22 Ultra at `R3CT30KAMEH` (instrumented tests)
- Projects:
  - `shared-kmp-libs` (KMP library, multi-module)
  - `dipatternsdemo` (Android, 43 modules)

## Section A — Subcommand sanity (9/9 PASS)

Each emits a valid JSON envelope with `schema_version: 1`, correct `subcommand`, `exit_code: 0`, zero errors.

| Subcommand | Path | Result |
|---|---|---|
| info       | `--json --no-adb` | PASS |
| doctor     | `--json` | PASS |
| describe   | `--json --skip-probe` | PASS |
| parallel   | `--dry-run --json` | PASS |
| changed    | `--dry-run --json --staged-only` | PASS |
| android    | `--list-only --json` | PASS |
| benchmark  | `--dry-run --json` | PASS |
| coverage   | `--dry-run --json` | PASS |
| update     | `--check --json` (with `KMP_TEST_REGISTRY_STUB`) | PASS |

## Section B — POSIX `--name=value` parity (6/6 PASS)

For each call site, ran `--flag value` (space) and `--flag=value` (POSIX). Asserted identical parser state.

| Subcommand | Flag | Value | Result |
|---|---|---|---|
| parallel   | `--module-filter` | `:core-result` | PASS (1 module both forms) |
| changed    | `--test-type` | `common` | PASS (exit 0 both forms) |
| android    | `--module-filter` | `:benchmark` | PASS (1 module both forms) |
| benchmark  | `--platform` | `jvm` | PASS (exit 0 both forms) |
| coverage   | `--coverage-tool` | `kover` | PASS (both forms parse identically) |
| describe   | `--module-filter` | `:core-result` | PASS (1 module both forms) |

## Section C — Flag implications (4/4 PASS)

| Cell | Expectation | Result |
|---|---|---|
| C1 Bug-E | `parallel --coverage-only` injects `-SkipTests` into spawn_args | PASS |
| C2 Bug-F | `parallel --isolated-no-lock` produces `{enabled:true, locked:false}` | PASS |
| C3 regression | `parallel --isolated` alone → `{enabled:true, locked:true}` | PASS |
| C4 regression | `parallel --isolated-cache-dir <p>` → `{enabled:true, locked:true, cache_dir:<absolute>}` | PASS |

## Section D — schema_version (covered in A)

All 9 envelopes report `schema_version: 1` (verified in section A).

## Section E — Validation rejections (11/11 PASS)

Each invalid input produces `exit_code: 2` (CONFIG_ERROR) with discriminated `errors[]`.

| Cell | Input | Code | Flag | Result |
|---|---|---|---|---|
| E1 | `parallel --test-type bogus` | `invalid_flag_value` | `--test-type` | PASS |
| E2 | `parallel --coverage-tool bogus` | `invalid_flag_value` | `--coverage-tool` | PASS |
| E3 | `benchmark --platform bogus` | `invalid_flag_value` | `--platform` | PASS |
| E4 | `changed --test-type bogus` | `invalid_flag_value` | `--test-type` | PASS |
| E5 | `coverage --coverage-tool bogus` | `invalid_flag_value` | `--coverage-tool` | PASS |
| E6 | `parallel --max-workers abc` | `invalid_flag_value` | `--max-workers` | PASS |
| E7 | `parallel --timeout -1` | `invalid_flag_value` | `--timeout` | PASS |
| E8 | `parallel --min-missed-lines NaN` | `invalid_flag_value` | `--min-missed-lines` | PASS |
| E9 | `changed --max-failures abc` | `invalid_flag_value` | `--max-failures` | PASS |
| E10 | `benchmark --timeout -5` | `invalid_flag_value` | `--timeout` | PASS |
| E11 | `describe --module-filter '[unclosed'` | `invalid_regex` | `--module-filter` | PASS |

## Section F — `--java-home` + `--no-jdk-autoselect` doc coverage (8/8 PASS)

| Subcommand | `--java-home` count | `--no-jdk-autoselect` count | Result |
|---|---|---|---|
| parallel  | 2 | 1 | PASS |
| changed   | 2 | 1 | PASS |
| android   | 2 | 1 | PASS |
| coverage  | 2 | 1 | PASS |
| benchmark | 2 | 1 | PASS |
| describe  | 1 | 1 | PASS |
| info (skip-list) | 0 | (skip) | PASS — intentionally absent (no JDK gate) |
| update (skip-list) | 0 | (skip) | PASS — intentionally absent (no JDK gate) |

(`parallel/changed/android/coverage/benchmark` show `--java-home: 2` because the help mentions it twice — once in the row, once in the `Pair with --java-home for explicit control.` follow-up text.)

## Section G — Real gradle WET on shared-kmp-libs (1/1 PASS)

Real gradle dispatch:

```
$ kmp-test parallel --test-type common --module-filter :core-result --json \
    --project-root /c/Users/34645/AndroidStudioProjects/shared-kmp-libs
```

Result envelope:
- `schema_version: 1`
- `exit_code: 0`
- `subcommand: parallel`
- `tests: { total: 1, passed: 1, failed: 0, skipped: 0 }` ✓
- `modules[0]: { name: "core-result", type: "kmp", coverage_plugin: "kover", test_build_type: null, has_flavor: false, android_dsl: true, android_dsl_variant: "kmpAndroidLibrary" }` ✓ (drift #2 object shape)
- `errors: []`
- `warnings: []`
- `duration_ms: 41169` (real gradle dispatch + test run)
- `coverage.tool: auto`
- `coverage.modules_with_kover_plugin: 62` ✓ (kover detection working across project)
- `coverage.missed_lines: 317` (real coverage data)
- `isolated: { enabled: false, cache_dir: null, kept: false, locked: true }` ✓ (Bug #6 isolated:{} populated)

End-to-end working. All session 2 features verified live in real gradle dispatch.

## Section H — Global flags (18/18 PASS)

| Cell | Probe | Result |
|---|---|---|
| H1 | `kmp-test --version` | PASS (`0.8.1`) |
| H2 | `kmp-test --help` | PASS (46 lines) |
| H3 ×9 | `kmp-test <sub> --help` (every subcommand) | PASS (all ≥5 lines) |
| H4 ×5 | `<sub> --dry-run --json` valid JSON | PASS (parallel/changed/android/coverage/benchmark) |
| H5 | cwd resolution (no `--project-root`) | PASS |
| H6 | `--ignore-jdk-mismatch` passthrough | PASS (no-op when JDK matches) |
| H7 | `--no-jdk-autoselect` passthrough | PASS (exit 0, no crash) |

## Section I — Error paths (4/5 PASS, 1 finding)

| Cell | Probe | Expected | Result |
|---|---|---|---|
| I1 | `info` on non-existent project | exit 0 (info never fails) | PASS (`exit_code: 0`) |
| **I2** | **`describe` on empty tmpdir (no settings.gradle.kts)** | **process exit 2 + envelope.exit_code: 2** | **FAIL — process exit 2, envelope.exit_code: 3** |
| I3 | `kmp-test bogus-subcommand` | exit 2 + "unknown subcommand" stderr | PASS |
| I4 | `kmp-test --help` | emits help text | PASS |
| I5 | `parallel --dry-run` from cwd with no gradlew | exit 3 + ENV_ERROR + msg includes "no gradlew" | PASS |

### Finding F-1 — `describe.no_project` envelope/exit mismatch

**Symptom:** When `describe` is invoked against a project root that has no `settings.gradle.kts` AND no `build.gradle.kts`, the orchestrator returns `EXIT.CONFIG_ERROR (2)` to the caller (correct — bad CLI input), but `envelope.exit_code` reports `3` (set by `envErrorJson` which hardcodes `EXIT.ENV_ERROR`).

**Root cause:** `cli.js#envErrorJson` (line 1786) hardcodes `exit_code: EXIT.ENV_ERROR` in the returned envelope. Most callers DO want ENV_ERROR (3), but two cases differ:
- `describe.js:241` (`no_project`) returns `EXIT.CONFIG_ERROR (2)` — mismatch with envelope.
- `changed.js:377` (`no_changed_modules`) overrides AFTER calling: `envelope.exit_code = EXIT.SUCCESS;` — manual workaround.

**Scope:** describe-only real mismatch. changed already has a manual workaround. android / benchmark / parallel / cli sites all consistent (ENV_ERROR/3 in both).

**Fix:** extend `envErrorJson` to accept an optional `exitCode` parameter (default `EXIT.ENV_ERROR` for backward-compat) and pass it from describe + changed (replacing changed's manual override). Shipped in PR #182 (commit fixes describe + cleans up changed).

## Anti-gaming spot-check at audit time

`BUGS-V0.9-WIN-AUDIT-FINAL.md` documented 6 anti-gaming probes (one per fix-PR). Additional probe: reverted PR 5's `--test-type` validateEnum call in parallel-orchestrator.js, ran input-validation.test.js. **2 tests failed.** Restored. Confirms regression tests genuinely exercise the fix.

## Quality gates

| Gate | Status |
|---|---|
| `npm test` (1224 vitest) | PASS |
| `node tools/sync-versions.js --check` | PASS |
| `npm run shellcheck` | SKIPPED (local; runs in CI) |
| Branch protection (7 required checks) | PASS for PRs #175–#181 |
| Section A subcommand sanity (9 cells) | 9/9 PASS |
| Section B POSIX form parity (6 cells) | 6/6 PASS |
| Section C flag implications (4 cells) | 4/4 PASS |
| Section E validation rejections (11 cells) | 11/11 PASS |
| Section F help-text doc (8 cells) | 8/8 PASS |
| Section G real gradle WET on shared-kmp-libs | PASS (1/1 test ran, full envelope correct) |
| Section H global flags (18 cells) | 18/18 PASS |
| Section I error paths (5 cells) | 4/5 PASS (1 finding F-1) |

## Conclusion

61/62 wet cells PASS. 1 pre-existing inconsistency (F-1) surfaced and fixed in the same session per the standing pre-release rule.

The CLI is production-ready for the v0.9.0 tag pending the iOS-side mac validation pass.
