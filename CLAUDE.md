# kmp-test-runner

> Standalone parallel test runner for Kotlin Multiplatform and Android Gradle projects. npm CLI + Gradle plugin + shell installers. Apache-2.0.

## Repo state (2026-04-25)

- npm: `kmp-test-runner@0.2.0` (Trusted Publisher OIDC; W31.5a)
- Gradle plugin: `io.github.oscardlfr.kmp-test-runner:0.2.0` (GitHub Packages; W31.5b)
- GitHub Releases: `v0.3.3` (installer artifacts; W31.5c shipped + 3 post-ship hotfixes)
- **Note**: `package.json` is at `0.3.3` but npm registry still at `0.2.0` (`publish-npm.yml` is `workflow_dispatch` only — intentional for OIDC manual approval)

## Layout

- `bin/kmp-test.js` — npm CLI entry point (Node ESM)
- `lib/cli.js` — CLI subcommand dispatch logic
- `scripts/sh/` + `scripts/ps1/` — shell/PowerShell scripts that the CLI dispatches to
- `scripts/install.{sh,ps1}` + `scripts/uninstall.{sh,ps1}` — user installers (POSIX + PowerShell, `--archive` / `-LocalArchive` flag for E2E test injection)
- `scripts/build-artifact.sh` — extracts publish-release.yml build logic for local CI E2E testing
- `gradle-plugin/` — Gradle plugin shape (`KmpTestRunnerPlugin` + `KmpTestRunnerExtension` + 5 task classes; Kover auto-detect)
- `tests/unit/` (vitest) + `tests/bats/` + `tests/pester/` + `tests/installer/` (E2E install/uninstall; Linux+Windows matrix)
- `.github/workflows/` — `ci.yml` (6 jobs: build x2, secrets-scan, gradle-plugin-test, installer-e2e x2), `publish-release.yml` (tag `v*` trigger), `publish-npm.yml` + `publish-gradle.yml` (workflow_dispatch only)
- `BACKLOG.md` — current and queued tasks; check this first

## CRITICAL — Gitflow enforced server-side

**NEVER push directly to `main`.** Branch protection requires:
- PR (no direct push, no force push, no delete)
- All 6 CI checks green: `build (ubuntu-latest)`, `build (windows-latest)`, `secrets-scan`, `gradle-plugin-test`, `installer-e2e (ubuntu-latest)`, `installer-e2e (windows-latest)`
- Linear history (squash/rebase only)
- `enforce_admins: true` (rule applies to repo owner — no bypass)

Workflow for ANY change (incl. one-line hotfixes):

```bash
git checkout main && git pull
git checkout -b feature/<slug>
# edit
git commit -m "type(scope): summary"
git push -u origin feature/<slug>
gh pr create --title "..." --body "..."
# wait for CI green
gh pr merge <num> --squash --delete-branch
git checkout main && git pull
```

For a release: after merging the version-bumping PR, `git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z`. The `publish-release.yml` workflow auto-runs on tag push and creates the GitHub Release with `linux.tar.gz` + `windows.zip` artifacts.

## Versioning

- `package.json` `version` is the source of truth for what `kmp-test --version` reports
- The Git tag (`vX.Y.Z`) MUST match `package.json` version BEFORE tagging — otherwise installer reports wrong version (W31.5c historical bug — caught now by `installer-e2e` regression test)
- npm package version (separate consumer) currently unsynced — only manual `publish-npm.yml` runs publish to npm registry

## Architecture decisions worth knowing

- **No arch suffix on artifacts** — Node.js arch-agnostic; single `linux.tar.gz` + `windows.zip` per release
- **Wrapper directory** — release archives MUST contain `kmp-test-runner-${VER}/` at top level (installer extraction depends on it; W31.5c v0.3.0 historical bug caught here)
- **`package.json` MUST be in artifact** — `cli.js` reads version via `path.join(__dirname, '..', 'package.json')` (v0.3.2 historical bug caught here)
- **Redirect URL primary, API fallback** for download in install scripts — avoids 60/hr unauthenticated `api.github.com` rate limit
- **HKCU PATH only on Windows** — never `Machine` (would require admin)
- **Pester via `shell: pwsh`** — Pester 5.x pre-installed on windows-latest, no `Install-Module` needed
- **`GH_TOKEN` env var** in publish-release.yml — `gh` CLI canonical (NOT `GITHUB_TOKEN`, which is unreliable fallback)
- **Decouple from L0**: 8 patterns must stay 0-hits in scripts (`ANDROID_COMMON_DOC`, `AndroidCommonDoc`, `~/.claude`, `AndroidStudioProjects`, `oscardlfr/AndroidCommonDoc`, `shared-kmp-libs`, `l0_requires`, `L0\b`). Exception: `SKIP_DESKTOP_MODULES`, `SKIP_ANDROID_MODULES`, `PARENT_ONLY_MODULES` are documented consumer-config API (shipped v0.1.0) and excluded from the audit.

## Test strategy

- **Unit (vitest)**: `tests/unit/` — pure Node logic, ≥80% line coverage on `bin/kmp-test.js`
- **Shell (bats)**: `tests/bats/` — sh script behaviors + `tests/installer/install.bats` (8 syntax/safety + 5 E2E with `--archive` flag)
- **PowerShell (Pester v5)**: `tests/pester/` + `tests/installer/Install.Tests.ps1` (6 syntax + 4 E2E with `-LocalArchive` param, `-Tag E2E`)
- **Gradle (TestKit)**: `gradle-plugin/src/test/kotlin/` — 9 tests (3 GradleRunner project tests + parameterized `CrossShapeParityTest`); uses local Maven repo approach (`withPluginClasspath()` is broken for Gradle plugins, do NOT use it)
- **E2E installer**: `installer-e2e` job in `ci.yml` (matrix ubuntu+windows) builds artifact via `scripts/build-artifact.sh`, runs install scripts with `--archive`/`-LocalArchive` flag, asserts `kmp-test --version` matches `package.json`, runs uninstall, verifies clean removal

## Common commands

```bash
# Run all tests
npm test                                    # vitest
npx bats tests/bats/ tests/installer/       # bats (Linux/macOS)
# Pester runs in CI on windows-latest

# Lint shell scripts
npm run shellcheck

# Build artifact locally (same logic as publish-release.yml)
bash scripts/build-artifact.sh 0.3.4 dist/

# Test installer E2E locally
bash scripts/install.sh --version 0.3.4 --prefix /tmp/kmp-test-prefix \
  --archive dist/kmp-test-runner-0.3.4-linux.tar.gz
/tmp/kmp-test-prefix/lib/bin/kmp-test.js --version
/tmp/kmp-test-prefix/lib/bin/kmp-test.js --help

# Build Gradle plugin
cd gradle-plugin && ./gradlew test
```

## Known limitations / out of scope (deferred)

- Maven Central publish — deferred to v0.4.0 (Gradle plugin only on GitHub Packages currently)
- iOS/macOS targets in TestKit — needs Mac hardware
- L0 consumption migration — separate work in `AndroidCommonDoc` repo (the L0 toolkit project that originally housed these scripts)

## When you (Claude) work in this repo

1. **Read `BACKLOG.md` first** — it lists current and queued tasks
2. **Always start a feature branch** (gitflow protected — server-side enforced)
3. **For tests**: do NOT weaken or remove existing tests to make new code pass. If a test fails, fix the production code, not the test
4. **For new install/CI logic**: add E2E coverage that catches the bug class (we have 5 bats E2E + 4 Pester E2E as a baseline; v0.3.0/0.3.2/0.3.3 historical bugs are the regression-test rubric)
5. **Commit message format**: Conventional Commits (`feat(scope): ...`, `fix(scope): ...`, `test(scope): ...`, `docs(scope): ...`)
6. **After PR**: wait for all 6 CI checks green before merge; squash merge; delete branch; pull main
7. **For releases**: bump `package.json` `version` BEFORE tagging; run `installer-e2e` mentally — does the tag match `package.json`?
