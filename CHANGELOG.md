# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.3.4]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/oscardlfr/kmp-test-runner/releases/tag/v0.1.0
