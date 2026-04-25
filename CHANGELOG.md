# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.2] — 2026-04-25

### Fixed
- Release artifacts now include `package.json`. Without it, `cli.js`'s `readVersion()`
  function (which reads version via `path.join(__dirname, '..', 'package.json')`)
  failed post-install with `ENOENT: no such file or directory`. v0.3.0 + v0.3.1
  artifacts both omitted `package.json` from the `cp` list in `publish-release.yml`,
  so `kmp-test --version` failed even after fixing the wrapper-directory bug in v0.3.1.

### Notes
- v0.3.0 + v0.3.1 users: please reinstall from v0.3.2. The installers themselves
  (`install.sh`, `install.ps1`) are unchanged — the bug is in the release artifacts.
- Run `scripts/uninstall.{sh,ps1}` first to clear the broken install, then re-run
  `scripts/install.{sh,ps1}` from v0.3.2.

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

[0.3.2]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/oscardlfr/kmp-test-runner/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/oscardlfr/kmp-test-runner/releases/tag/v0.1.0
