# v0.9 Windows-side audit — final closure report

> Companion to the iOS-side wet audit closure (`WET-AUDIT-V0.9-FINAL.md`).
> Closes the 8 bugs surfaced by Claude's Windows-side audit before the v0.9.0 tag.
> Session 2 of v0.9 pre-release validation. All bugs ship to `develop` pre-tag
> per the standing rule (`feedback_no_milestone_deferral_at_pre_release.md`).

## Baseline → Outcome

| Metric | Baseline (session start) | Final (post-PR-#180) |
|---|---|---|
| Branch | `develop` @ `1a0e6dc` | `develop` @ `308ed20` |
| Vitest | 1165 passing | **1224 passing** (+59) |
| Test files | 20 | 22 (+2 new) |
| `package.json.version` | 0.8.1 | 0.8.1 (release ceremony bumps) |
| Open audit bugs | 8 | **0** |

## Per-PR ledger

| # | Bug | Branch | PR | Merge SHA | Vitest delta |
|---|---|---|---|---|---|
| 1 | A.1 — translateFlagForPowerShell mangles `--name=value` | `fix/cli-translate-posix-equals` | #175 | `87912f2` | +2 |
| 2 | A.2 — POSIX form on 4 orchestrators + cli.js pre-spawn | `fix/posix-equals-orchestrators-4` | #176 | `9ebe0bc` | +12 |
| 3 | E + F — coverage-only / isolated-no-lock implications | `fix/parallel-flag-implications` | #177 | `58fdf65` | +5 |
| 4 | K — top-level `schema_version: 1` envelope | `feat/envelope-schema-version` | #178 | `5191373` | +9 |
| 5 | B + C + D — input validation pass | `feat/input-validation-pass` | #179 | `72abdbe` | +25 |
| 6 | I — `--java-home` + `--no-jdk-autoselect` doc rows | `docs/help-flag-coverage-pass` | #180 | `308ed20` | +6 |

PR sequence followed the refactored Knuth plan (PR 6 doc-pass last so it
documents all behavior in PRs 1-5).

## Per-bug closure evidence

### Bug-A.1 — `translateFlagForPowerShell` preserves `--name=value` value verbatim

```bash
$ node -e "const {translateFlagForPowerShell}=require('./lib/cli.js'); \
  console.log(translateFlagForPowerShell('--module-filter=:core-result'));"
-ModuleFilter=:core-result   # post-fix (pre-fix: -ModuleFilter=:coreResult, value mangled)

$ node -e "const {translateFlagForPowerShell}=require('./lib/cli.js'); \
  console.log(translateFlagForPowerShell('--gradle-args=--rerun-tasks'));"
-GradleArgs=--rerun-tasks    # post-fix (pre-fix: -GradleArgs=RerunTasks, lost --)
```

### Bug-A.2 — POSIX `--name=value` form normalized at cli.js + 4 orchestrators

```bash
$ kmp-test android --list-only --module-filter=:benchmark --json \
    --project-root /c/Users/34645/AndroidStudioProjects/dipatternsdemo
# instrumented_modules: ["benchmark"]   (1 module — pre-fix: all 43)

$ kmp-test describe --module-filter=:core-result --json \
    --project-root /c/Users/34645/AndroidStudioProjects/shared-kmp-libs
# describe.modules: 1 entry              (pre-fix: full module list)
```

PowerShell `-File` mangling investigation also documented: the `-File` invocation
parses `--name=:value` as parameter binding (eats `=`, strips leading colon).
Defense in depth: split at cli.js (covers cli → ps1 → runner) AND in each
orchestrator's parseArgs (covers direct `node lib/runner.js <sub>` calls).

### Bug-E — `parallel --coverage-only` implies `--skip-tests`

```bash
$ kmp-test parallel --coverage-only --dry-run --json --project-root <shared-kmp-libs>
# plan.spawn_args includes '-SkipTests'    (post-fix: implication propagated to wrapper)
# Pre-fix: -SkipTests missing, dispatchLeg ran the test suite first.
```

### Bug-F — `parallel --isolated-no-lock` implies `--isolated`

```bash
$ kmp-test parallel --isolated-no-lock --dry-run --json --project-root <shared-kmp-libs>
# isolated: { enabled: true, locked: false }
# Pre-fix: { enabled: false, locked: false } — nonsensical shape.
```

### Bug-K — top-level `schema_version: 1` on every JSON envelope

```bash
$ for sub in info doctor parallel changed describe coverage benchmark android update; do
    kmp-test $sub --json [...] --project-root <shared-kmp-libs> | grep schema_version
  done
# All 9 subcommands return "schema_version": 1
```

### Bug-B — enum validation (`invalid_flag_value`)

```bash
$ kmp-test parallel --test-type bogus --json --project-root <shared-kmp-libs>
# exit_code: 2, errors[0]: { code: "invalid_flag_value", flag: "--test-type",
#   value: "bogus", allowed: [common, jvm, android, ...] }
# Pre-fix: exit_code: 1, errors[0].code: "no_summary" (wrapper validation surfaced as parse-gap).
```

Same shape verified for `--coverage-tool bogus` (parallel) and `--platform bogus`
(benchmark).

### Bug-C — describe regex compile validation (`invalid_regex`)

```bash
$ kmp-test describe --module-filter '[unclosed' --json --project-root <shared-kmp-libs>
# exit_code: 2, errors[0]: { code: "invalid_regex", flag: "--module-filter",
#   value: "[unclosed", message: "...Invalid regular expression..." }
# Pre-fix: exit_code: 0, full module list returned (silent regex failure).
```

### Bug-D — numeric validation (`invalid_flag_value`)

```bash
$ kmp-test parallel --max-workers abc --json [...]
# exit_code: 2, errors[0]: { code: "invalid_flag_value", flag: "--max-workers", value: "abc" }

$ kmp-test parallel --timeout -1 --json [...]
# exit_code: 2, errors[0]: { code: "invalid_flag_value", flag: "--timeout", value: "-1" }

$ kmp-test changed --max-failures abc --json [...]
# exit_code: 2, errors[0]: { code: "invalid_flag_value", flag: "--max-failures", value: "abc" }
```

### Bug-I — `--java-home` + `--no-jdk-autoselect` documented

```bash
$ for sub in parallel changed android coverage benchmark describe; do
    kmp-test $sub --help | grep -E 'java-home|no-jdk-autoselect|ignore-jdk-mismatch' | wc -l
  done
# parallel: 3/2 flags found       (3 includes --ignore-jdk-mismatch which was already there)
# changed:  3/2
# android:  3/2
# coverage: 3/2
# benchmark:3/2
# describe: 2/2 (no --ignore-jdk-mismatch row pre-fix or post-fix; describe doesn't gate JDK)
```

## Quality gates

| Gate | Status | Notes |
|---|---|---|
| `npm test` (vitest, 22 files) | **PASS — 1224/1224** | +59 regression tests across 6 PRs |
| `node tools/sync-versions.js --check` | **PASS** | All targets in sync at 0.8.1 |
| `npm run shellcheck` | SKIPPED (local) | Runs in CI on ubuntu — green per CI history below |
| Branch protection (7 required checks) | **PASS** | All 6 PRs (#175-#180) merged with green CI |
| `gh pr list --state merged --base develop --limit 6` | **PASS** | All session-2 PRs landed |

## Anti-gaming verification

Per `feedback_no_test_gaming_full_coverage.md`, every fix-PR has at least one
regression test that **genuinely fails pre-fix** and passes post-fix.

| PR | Anti-gaming probe | Result |
|---|---|---|
| 1 | Ran both buggy + fixed `translateFlagForPowerShell` against `--module-filter=:core-result` | Diverge: `:coreResult` vs `:core-result` ✓ |
| 2 | Simulated pre-fix `parseArgs(['--module-filter=:foo'])` via inline switch (no helper) | `moduleFilter: ''` vs `:foo` ✓ |
| 3 | Inlined Bug-E (`--coverage-only` only, no helper) | `{coverageOnly:true, skipTests:false}` vs `{...skipTests:true}` ✓ |
| 4 | Snapshot diff confirmed exactly `+ "schema_version": 1` line addition (no other shape drift) | ✓ |
| 5 | **Stronger probe at audit time:** reverted only the `--test-type` validateEnum call in `parallel-orchestrator.js` (kept everything else), ran `input-validation.test.js`. **2 tests failed** (`Bug-B/D: 'parallel' --test-type bogus` + `invalid args envelope shape`). Restored. | ✓ |
| 6 | Pre-fix `documented.has('--java-home')` returns `false` (flag absent from SUBCOMMAND_HELP) | ✓ |

## Test consolidation

- New: `tests/vitest/posix-flags.test.js` — 12 cases (8 unit + 4 parameterized).
- New: `tests/vitest/input-validation.test.js` — 25 cases (9 unit + 13 parameterized + 3 regex variants).
- Updated: `tests/vitest/cli.test.js` (+5: Bug-A.1 + Bug-F).
- Updated: `tests/vitest/parallel-orchestrator.test.js` (+5: Bug-E + Bug-F + repurposed coverage-only test).
- Updated: `tests/vitest/orchestrator-utils.test.js` (+1: Bug-F).
- Updated: `tests/vitest/parity.test.js` (+15: Bug-K × 9 + Bug-I × 6).
- Updated: `tests/vitest/__snapshots__/parity.test.js.snap` (9 snapshots regenerated, diff = `+ "schema_version": 1` only).

## Process notes (lessons applied this session)

1. **`feedback_commit_lint_constraints.md`** (saved this session) — PR #176 burned a CI cycle on `fix(cli,orchestrators): ...` (multi-scope + 75 chars). Rule: one scope, ≤72 chars. Saved the rule mid-session; followed it for PRs 3-6.
2. **Defense-in-depth at two layers (cli.js + orchestrator)** — Bug-A.2 + Bug-E + Bug-B/D taught: cli.js must fix at the cleanedArgs layer for `kmp-test <sub>` paths AND each orchestrator's parseArgs for direct `node lib/runner.js <sub>` paths. The wet investigation surfaced this when PR 2's first wet test still showed 43 modules (PowerShell mangled the `=` form).
3. **PowerShell `-File` mangles `--name=:value`** — eats `=`, strips leading colon. Documented in `cli.js#expandPosixEqualsForm` site comment. This was the load-bearing finding of PR 2.
4. **Snapshot churn from envelope shape changes** — vitest `-u` blindly accepted, but git diff was inspected to confirm the diff was exactly the new field with no unrelated drift. Anti-gaming verification followed.
5. **Test repurposing not gaming when contract changes** — PR 3's pre-existing `--coverage-only filters modules to those listed in --coverage-modules` test asserted the BUGGY behavior (running tests first). Repurposed to verify the new routing (runCoverage stub invoked + args forwarded). Documented in PR body and CHANGELOG.

## Next step

Step 10 release ceremony for v0.9.0 unblocked AFTER iOS-side mac validation
(per `v0_9_step_10_fresh_session_prompt.md`). User explicitly deferred the mac
validation: "cuando termine yo todo el valida que funcione todo de nuevo en ios".
