# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.8] — 2026-04-26

### Added
- **Concurrent-invocation safety (Tier 1)** — when multiple `kmp-test` runs
  share the same `--project-root` (multi-agent workflows, CI matrix shards,
  human + agent overlap), an advisory lockfile at
  `<project>/.kmp-test-runner.lock` now coordinates them:
  - **First arrival** writes
    `{schema:1, pid, start_time, subcommand, project_root, version}` JSON,
    proceeds, removes the lock on exit (success, failure, or signal).
  - **Second arrival with live PID in the lock** refuses with exit `3` and
    prints PID + age + subcommand of the holder. In `--json` mode the
    envelope includes `errors[].code = "lock_held"`.
  - **Stale lock** (PID dead, e.g. previous run killed `-9`) is reclaimed
    silently — no manual cleanup needed.
  - **Cleanup hooks** for `SIGINT` (Ctrl-C), `SIGTERM`, and
    `uncaughtException` drop the lockfile so a crashed run doesn't leave
    a stuck lock behind.
  - **`doctor` and `--dry-run` skip the lock entirely** — they're read-only
    operations with no side effects worth coordinating.
- **`--force` global flag** — bypasses a live lock when you intentionally
  want concurrent runs (e.g. a debug session alongside CI). Hoisted like
  `--json` / `--dry-run` so it can appear before or after the subcommand.
- **Run-id naming for reports and temp logs** — every run computes a
  `YYYYMMDD-HHMMSS-PID6` run-id (zero-padded last 6 digits of PID) and
  uses it to suffix:
  - `<project>/coverage-full-report-<run-id>.md` (parallel/coverage)
  - `<project>/benchmark-report-<run-id>.md` (benchmark)
  - `${TMPDIR}/gradle-parallel-tests-<run-id>.log` (parallel/coverage)

  The legacy stable filenames (`coverage-full-report.md`,
  `benchmark-report.md`) remain as a "last finished run" mirror copy so
  existing consumers keep working.

### Fixed
- Same-second simultaneous parallel runs no longer clobber each other's
  `gradle-parallel-tests-<timestamp>.log` (now PID-suffixed).
- Two runs against the same project no longer race each other into the
  fixed report filenames — each gets its own versioned copy.

## [0.3.7] — 2026-04-26

### Added
- `--dry-run` global flag: prints the resolved plan (project root, subcommand,
  script path, final argv, spawn command) and exits `0` without invoking the
  underlying script. Hoisted alongside `--json`, so it can appear before or
  after the subcommand. Under `--json` the flag emits the canonical envelope
  with `dry_run: true`, all-zero `tests` counts, and a `plan{}` section
  describing what would have run. Useful for agents that want to introspect
  what `kmp-test` would do without paying the test-execution cost.
- `kmp-test doctor` subcommand: diagnoses the local environment with five
  checks — Node ≥18, `bash` (Linux/macOS) or `pwsh`/`powershell.exe` (Windows),
  `gradlew` in `--project-root` (warn-only), `java -version` (≥17 recommended),
  and `adb version` (warn-only — only needed for the `android` subcommand).
  Human output prints a `CHECK / STATUS / VALUE / MESSAGE` table; `--json`
  emits a single JSON object with a `checks[]` array of
  `{name, status, value, message}` entries. Exit code `0` when all OK or WARN,
  `3` when any FAIL.
- `--test-filter <pattern>` global flag: filters to a single test class without
  forcing the user to bypass the CLI. Mapping per subcommand:
  - JVM tasks (`parallel`, `changed`, `coverage`, `benchmark --platform jvm`):
    appended as `--tests <pattern>` to the gradle command line. Gradle's
    `--tests` handles globs natively, so `*FooTest*` works as-is.
  - Android instrumented (`android`, `benchmark --platform android` or `all`):
    appended as `-Pandroid.testInstrumentationRunnerArguments.class=<FQN>`.
    The Android instrumentation runner does NOT accept wildcards, so the CLI
    pre-resolves a `*Pattern*` glob to a fully-qualified class name by walking
    the project sources for `class <stripped>` declarations (skipping `build/`,
    `.gradle/`, `node_modules/`, `.git/`). If no match is found, the original
    pattern is forwarded — gradle/Android then surfaces a clear error rather
    than the CLI guessing.
  Caught while validating v0.3.4 against `dipatternsdemo` (3 benchmark classes,
  user wanted to filter to a single one).
- Conventional Commits enforcement on PR titles via
  `.github/workflows/commit-lint.yml`. Adapted inline from
  AndroidCommonDoc/reusable-commit-lint.yml so the repo stays standalone (per
  CLAUDE.md "Decouple from L0"). Squash-merge mode — only the PR title is
  validated since branch protection enforces squash-merge and the PR title
  becomes the squash commit message. Valid types:
  `feat,fix,docs,style,refactor,perf,test,build,ci,chore,revert,release`.
  **Branch protection on `main` and `develop` must be updated to require the
  new `commit-lint / 🔤 Commit Lint` check** (manual one-time step).

### Changed
- README "Agentic flags" section added covering `--dry-run`, `--json`,
  `--test-filter`, and the `doctor` subcommand with example invocations.
- Per-subcommand `--help` text now documents `--dry-run` and `--test-filter`
  for `parallel`, `changed`, `android`, `benchmark`, and `coverage`.
- vitest coverage on `lib/cli.js` extended with 35 new tests (91 total) for
  the new helpers (`consumeDryRunFlag`, `consumeTestFilter`,
  `findFirstClassFqn`, `resolveAndroidTestFilter`, `resolvePatternForSubcommand`,
  `runDoctorChecks`, `buildDryRunReport`) and end-to-end `main()` flows for
  `--dry-run`, `doctor`, and `--test-filter`.
- bats tests added for `--dry-run`, `doctor`, and `--test-filter` against a
  stub gradlew (`tests/bats/test-dryrun.bats`, `test-doctor.bats`,
  `test-testfilter.bats`).
- Pester smoke now asserts every `scripts/ps1/*.ps1` declares a `-TestFilter`
  parameter so the CLI's `--test-filter` translation never lands on an
  unknown-parameter error.

## [0.3.6] — 2026-04-25

### Fixed
- `auto-tag.yml` → `publish-release.yml` cascade now fires automatically.
  v0.3.5 exposed that the tag created and pushed by `auto-tag.yml` did NOT
  trigger `publish-release.yml`'s `push: tags:` listener, because GitHub
  Actions blocks pushes made with the default `GITHUB_TOKEN` from triggering
  downstream workflows (anti-recursion guard). Workaround was a manual
  `gh workflow run publish-release.yml -f tag=vX.Y.Z` after every release
  merge.
- Fix uses `workflow_call` (no new credentials needed):
  - `publish-release.yml` adds a `workflow_call:` trigger alongside the
    existing `push: tags:` and `workflow_dispatch:` triggers, parameterized
    on a `tag` input. The version-determination logic resolves `TAG` from
    `inputs.tag` (workflow_call / workflow_dispatch) or `GITHUB_REF_NAME`
    (push:tags:), so all three paths produce identical artefacts.
  - `auto-tag.yml` gains a `release` job that depends on `tag` and
    `uses: ./.github/workflows/publish-release.yml` via workflow_call when
    `tag.outputs.tag_created == 'true'`. No PAT, no GitHub App — a built-in
    cross-workflow dependency that explicitly chains the two.

### Validated
- Second exercise of the auto-publish pipeline. v0.3.5 needed manual
  intervention for the GitHub Release artefacts; v0.3.6 should be 100 %
  hands-off — bump version, merge develop → main, all artefacts land.

## [0.3.5] — 2026-04-25

### Fixed
- `scripts/install.ps1` `Resolve-LatestVersion` now works in PowerShell 7+.
  The previous code accessed `$Response.Headers["Location"]` directly, which
  works on Windows PowerShell 5.1 (where `Headers` is a `Hashtable` /
  `WebHeaderCollection`) but throws `Unable to index into an object of type
  System.Net.Http.Headers.HttpResponseHeaders` on PowerShell 7+. Replaced
  with `Get-LocationHeader` helper that handles both shapes (Hashtable
  indexer, single-string array, and the typed `HttpResponseHeaders.GetValues`
  / `.Location` accessors). Workaround until the fix shipped: pass `-Version`
  explicitly.

### Validated
- First end-to-end exercise of the auto-publish pipeline introduced in
  v0.3.4: bumping `package.json` + `gradle-plugin/build.gradle.kts` to
  `0.3.5` on `develop`, PR `develop → main`, squash-merge → `auto-tag.yml`
  creates `v0.3.5` git tag → cascades to `publish-release.yml` (artefacts)
  → `publish-npm.yml` + `publish-gradle.yml` push their respective
  registries — all without manual intervention. v0.3.4 was a no-op for
  `auto-tag.yml` (tag pre-existed); v0.3.5 was the first real exercise.

## [0.3.4] — 2026-04-25

### Added
- `--json` / `--format json` output mode: emits a single, parseable JSON object on
  stdout with `tool`, `subcommand`, `version`, `project_root`, `exit_code`,
  `duration_ms`, `tests {total/passed/failed/skipped}`, `modules[]`,
  `coverage {tool, missed_lines}`, and `errors[]`. Designed for AI agents and
  structured-output consumers — typical response is a few hundred tokens vs.
  several thousand for raw Gradle + report parsing. Always valid JSON; parse
  failures surface in `errors[]` rather than crashing.
- Per-subcommand `--help` for `parallel`, `changed`, `android`, `benchmark`, and
  `coverage`. Each shows subcommand-specific flags + one usage example,
  ≤30 lines.
- Pre-flight `gradlew` check: before invoking the bash/PowerShell script the
  CLI verifies `<project-root>/gradlew` (or `gradlew.bat` on Windows) exists
  and prints a 3-line helpful error (exit code `3`) when it doesn't.
- Semantic exit codes documented in `--help` and README: `0` success, `1` test
  failure, `2` config error (bad CLI usage), `3` environment error
  (`gradlew`/`bash`/`pwsh` missing).
- README "Agentic usage — token-cost rationale" section comparing three
  approaches: (A) raw Gradle + report parsing, (B) `kmp-test` default,
  (C) `kmp-test --json`. Side-by-side example shows ~80–100 tokens for
  `--json` vs. several thousand for the equivalent raw-Gradle workflow.
- vitest tests for parser, JSON envelope, gradlew pre-flight, and exit-code
  semantics. `bin/kmp-test.js` + `lib/cli.js` line coverage now ~97%.
- bats smoke tests for `--json` output shape, `--format json` alias, missing
  gradlew, and per-subcommand help.

### Changed
- `--project-root` is now formally documented as defaulting to `process.cwd()`,
  so `cd <project> && kmp-test parallel` works without typing the path. (The
  default already existed in code; this release locks it into the public help
  text and README.)
- Global flags `--json` / `--format json` may appear before OR after the
  subcommand (e.g. both `kmp-test --json parallel` and
  `kmp-test parallel --json` work).
- `ENOENT` when spawning `bash`/`pwsh` now exits with `3`
  (environment error) instead of the previous `127`, aligning with the
  documented semantic-exit-code scheme.

### Fixed
- `npm install -g kmp-test-runner` now installs a `kmp-test` binary, matching
  the documented usage. Previously the `bin` field was a string
  (`"bin/kmp-test.js"`), which made npm derive the shim name from the package
  name (`kmp-test-runner`), so users who installed via npm got `kmp-test-runner`
  on `PATH` instead of the documented `kmp-test`. The shell installer
  (`scripts/install.{sh,ps1}`) was unaffected since it creates the `kmp-test`
  shim explicitly.
- `kmp-test benchmark --platform jvm/android` no longer invokes non-existent
  Gradle tasks on incompatible modules. Previously `detect_benchmark_modules`
  returned every module with a benchmark reference and `get_benchmark_gradle_task`
  blindly built a task name (`:module:desktopSmokeBenchmark` for jvm,
  `:module:connectedAndroidTest` for android), so an `androidx.benchmark`-only
  module asked to run as `--platform jvm` produced a `TaskSelectionException`
  after a long Gradle configuration phase. New helpers
  `detect_module_benchmark_platforms` (sh) / `Get-ModuleBenchmarkPlatforms`
  (ps1) categorize each module by detected capability (`androidx.benchmark` →
  android, `kotlinx.benchmark` / `org.jetbrains.kotlinx.benchmark` → jvm), and
  the runner skips modules that don't declare the requested platform with a
  `[SKIP]` warning. If every module/platform combination is skipped, the
  script exits `3` (env error) with a useful hint instead of pretending success.
  Discovered while validating v0.3.4 against `dipatternsdemo` (an
  `androidx.benchmark`-only project).
- `detect_benchmark_modules` (sh) now correctly handles the default
  `--module-filter "*"`. Previously the filter check used a literal substring
  match (`[[ "$mod" != *"*"* ]]`), so passing `*` filtered EVERY module out
  (since module names like "benchmark" don't contain a literal asterisk),
  silently returning zero benchmark modules on any default invocation.
  The filter now treats `*` and the empty string as "match all" and only
  applies substring filtering for non-empty, non-asterisk patterns. Caught
  by the new `detect_benchmark_modules with default filter '*'` regression
  bats test.
- `detect_benchmark_modules` (sh) `include(...)` extraction is now locale-
  portable. Previously it used `grep -oP` (PCRE), which fails under MinGW /
  Git Bash with `grep: -P supports only unibyte and UTF-8 locales` when
  `LC_ALL=C`, returning zero modules. The implementation now uses
  `grep -E` + `sed -E` (POSIX) and is exercised under `LC_ALL=C` by a
  dedicated regression bats test.

## [0.3.3] — 2026-04-25

### Fixed
- `package.json` version bumped from `0.2.0` to `0.3.3` to match the GitHub Release
  tag. Sub-wave c (v0.3.0..v0.3.2) shipped installer + workflow changes only — no
  npm/Gradle code change — and missed bumping `package.json`. Result on v0.3.0/0.3.1/0.3.2:
  `kmp-test --version` returned `0.2.0` post-install (the stale `package.json` value)
  even though users installed from a v0.3.x GitHub Release. v0.3.3 syncs the
  version-string source-of-truth with the release tag.
- Note: the **npm registry** still publishes `kmp-test-runner@0.2.0`. `publish-npm.yml`
  is `workflow_dispatch`-only (intentionally — Trusted Publisher OIDC requires manual
  approval). To publish v0.3.3 to npm, trigger that workflow explicitly.

### Notes
- v0.3.0..v0.3.2 users: please reinstall from v0.3.3. Run `scripts/uninstall.{sh,ps1}`
  first, then `scripts/install.{sh,ps1}` from v0.3.3.

## [0.3.2] — 2026-04-25

> **NOTE:** v0.3.2 reports `kmp-test --version` as `0.2.0` (stale `package.json`).
> Use v0.3.3 — same installer, correct version reporting.

### Fixed
- Release artifacts now include `package.json`. Without it, `cli.js`'s `readVersion()`
  function (which reads version via `path.join(__dirname, '..', 'package.json')`)
  failed post-install with `ENOENT: no such file or directory`. v0.3.0 + v0.3.1
  artifacts both omitted `package.json` from the `cp` list in `publish-release.yml`,
  so `kmp-test --version` failed even after fixing the wrapper-directory bug in v0.3.1.

### Notes
- v0.3.0 + v0.3.1 users: please reinstall from v0.3.3 (NOT v0.3.2 — see note above).

## [0.3.1] — 2026-04-25

### Fixed
- Release artifact extraction. v0.3.0 archives were packaged with files at top level
  (`bin/`, `lib/`, `scripts/` directly), but `install.sh` (`tar --strip-components=1`)
  and `install.ps1` (`Get-ChildItem -Directory | Select-Object -First 1`) both expect
  a single wrapper directory (`kmp-test-runner-${VER}/`). Result on v0.3.0: installers
  ran without error but produced unusable installs (`kmp-test --version` failed with
  `MODULE_NOT_FOUND`). v0.3.1 wraps the archive contents in `kmp-test-runner-${VER}/`
  so the installer extraction logic works as designed.

> **NOTE:** v0.3.1 also has a packaging bug — see v0.3.2.

### Notes
- v0.3.0 users: do NOT install v0.3.1 — install v0.3.2 instead.

## [0.3.0] — 2026-04-25

> **NOTE:** v0.3.0 archives have a packaging bug (no wrapper directory) that breaks
> installer extraction. **Do not install v0.3.0 — use v0.3.1 instead.** The v0.3.0
> installer scripts themselves are sound; only the release artifacts are broken.

### Added
- Shell installer (`scripts/install.sh`) — POSIX-compatible, works on Linux and macOS (bash 3.2+)
- PowerShell installer (`scripts/install.ps1`) — Windows 10/11, PowerShell 5.1+
- Uninstall scripts for both platforms (`scripts/uninstall.sh`, `scripts/uninstall.ps1`)
- GitHub Release workflow (`publish-release.yml`) — tag-triggered, attaches tarball + zip artifacts
- Bats smoke tests for installer detection logic (`tests/installer/install.bats`)
- Pester syntax tests for PowerShell installer (`tests/installer/Install.Tests.ps1`)

### Changed
- README final polish: Quick Start moved to top, Installation section expanded with all 3 shapes,
  10-section canonical order established

## [0.2.0] — 2026-04-25

### Added
- Gradle plugin shape `io.github.oscardlfr.kmp-test-runner` published to GitHub Packages
- 5 Gradle tasks: `parallelTests`, `changedTests`, `androidTests`, `benchmarkTests`, `coverageTask`
- `KmpTestRunnerExtension` DSL with 6 properties: `projectRoot`, `maxWorkers`, `coverageTool`,
  `coverageModules`, `minMissedLines`, `sharedProjectName`
- Kover auto-detect via `pluginManager.withPlugin` — graceful skip if Kover absent
- TestKit 3-target matrix (Android, KMP-desktop, KMP-multiplatform) + structural `CrossShapeParityTest`

### Changed
- npm CLI bumped to v0.2.0 to stay version-synced with Gradle plugin

### Infrastructure
- Trusted Publisher OIDC for npm publish (no static tokens)
- Step-level `GITHUB_TOKEN` scoping in `publish-gradle.yml`

## [0.1.0] — 2026-04-25

### Added
- Initial release of npm CLI shape `kmp-test-runner`
- 5 subcommands: `parallel`, `changed`, `android`, `benchmark`, `coverage`
- Cross-platform via Unix bash scripts + flag translation in `cli.js`
- Bats (≥15 tests), Pester (≥4 syntax tests), Vitest (≥80% coverage), shellcheck (0 warnings) in CI
- TruffleHog secrets scan as required CI status check
- Apache-2.0 license

[0.3.7]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/oscardlfr/kmp-test-runner/releases/tag/v0.1.0
