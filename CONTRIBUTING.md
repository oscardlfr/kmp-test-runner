# Contributing to kmp-test-runner

Thank you for your interest in contributing! `kmp-test-runner` is a parallel test runner for Kotlin Multiplatform and Android Gradle projects, distributed in three shapes (npm CLI, Gradle plugin, shell installers) — every change keeps all three in lockstep.

## Getting Started

```bash
git clone git@github.com:oscardlfr/kmp-test-runner.git
cd kmp-test-runner

# Install npm dependencies (CLI + tooling)
npm install

# Verify everything works
npm test                                       # vitest (183+ tests on lib/cli.js + tools/measure-token-cost.js)
npx bats tests/bats/ tests/installer/          # bats — POSIX shell scripts + 5 installer E2E tests
cd gradle-plugin && ./gradlew test && cd ..    # Gradle TestKit — 9 plugin tests
npm run shellcheck                             # POSIX script lint (must stay 0 warnings)
```

Pester tests run in CI on `windows-latest` (pre-installed via `shell: pwsh`); reproduce locally if you have PowerShell 7+:

```powershell
Invoke-Pester -Path tests/pester/ -Output Detailed
```

## Branch Model

Gitflow with two long-lived branches:

| Branch | Purpose |
|--------|---------|
| `main` | Production — every push triggers the v* tag + npm + GitHub Packages + GitHub Release pipeline |
| `develop` | Integration — feature PRs target here |
| `feature/*` | New features → merge to develop |
| `fix/*` | Bug fixes → merge to develop |
| `chore/*`, `ci/*`, `docs/*` | Non-functional changes → merge to develop |
| `release/vX.Y.Z` | Version bump + CHANGELOG → PR to develop, then PR develop → main |

Both `main` and `develop` are protected:

- PR required (no direct pushes, no force-pushes, no deletions)
- All 7 required CI checks green: `build (ubuntu-latest)`, `build (windows-latest)`, `secrets-scan`, `gradle-plugin-test`, `installer-e2e (ubuntu-latest)`, `installer-e2e (windows-latest)`, `Commit Lint`
- Squash/rebase merge only (linear history)
- `enforce_admins: true` — repo owner included

## Making Changes

### 1. Create a branch

```bash
git checkout develop && git pull origin develop
git checkout -b feature/my-change
```

### 2. Make your changes

Follow the conventions in [`CLAUDE.md`](CLAUDE.md) (the project's instructions for AI coding agents — they double as the human contributor guide):

- **Decouple from L0.** Never reference `oscardlfr/AndroidCommonDoc`, `~/.claude`, `AndroidStudioProjects`, `shared-kmp-libs`, or `L0` in scripts/CI. (See `CLAUDE.md` "Decouple from L0" — 8 patterns must stay 0-hits in scripts.)
- **SH and PS1 must stay in parity.** If you change a `scripts/sh/*.sh`, update the corresponding `scripts/ps1/*.ps1` and vice versa. The 4 `kmp-test` subcommand scripts (`run-parallel-coverage-suite`, `run-changed-modules-tests`, `run-android-tests`, `run-benchmarks`) all have both shells.
- **Consumer-config env vars are API.** `SKIP_DESKTOP_MODULES`, `SKIP_ANDROID_MODULES`, `PARENT_ONLY_MODULES` are documented public API since v0.1.0 — don't break them.
- **No `local` keyword outside bash functions.** Causes syntax errors on strict Linux bash.
- **vitest + Pester for new code paths.** New CLI flags need both `cli.test.js` (vitest, mocked spawnSync) and `Invoke-ScriptSmoke.Tests.ps1` (Pester, AST-driven where possible) regression tests.
- **Versions stay in sync** between `package.json`, `gradle-plugin/build.gradle.kts`, and the published Git tag — verified by `installer-e2e` in CI.

### 3. Run checks locally

```bash
# Quick validation
npm test                                       # vitest
npx bats tests/bats/ tests/installer/          # bats (Linux/macOS)
npm run shellcheck                             # ShellCheck — 0 warnings required

# Full validation (matches CI)
cd gradle-plugin && ./gradlew test && cd ..    # Gradle TestKit
bash scripts/build-artifact.sh 0.4.1 dist/     # Local CI E2E artifact build
bash scripts/install.sh --version 0.4.1 \
  --prefix /tmp/kmp-test-prefix \
  --archive dist/kmp-test-runner-0.4.1-linux.tar.gz  # E2E install test
/tmp/kmp-test-prefix/lib/bin/kmp-test.js --version    # → must print 0.4.1
```

### 4. Commit with Conventional Commits

PR titles MUST conform to [Conventional Commits v1.0.0](https://www.conventionalcommits.org/) — branch protection enforces squash-merge so the PR title becomes the squash commit subject.

```
feat(cli): add --dry-run flag
fix(installer): handle PowerShell 7 redirect headers
docs(readme): clarify --module-filter glob syntax
test(bats): add regression for empty SKIP_DESKTOP_MODULES
chore(ci): bump actions/checkout to v5
release: v0.4.1
```

Valid types: `feat | fix | docs | style | refactor | perf | test | build | ci | chore | revert | release`.

Suggested scopes: `cli`, `scripts`, `gradle-plugin`, `installer`, `tools`, `tests`, `ci`, `docs`, `deps`.

Rules: description starts lowercase, no trailing period, ≤72 chars (warning at 73+).

### 5. Open a PR

Target `develop` (never `main` directly — `main` only accepts release PRs from `develop`).

CI runs automatically:
- `build (ubuntu-latest)`, `build (windows-latest)`, `build (macos-latest)` — npm + vitest
- `secrets-scan` — TruffleHog
- `gradle-plugin-test` — Gradle TestKit (9 tests)
- `installer-e2e (ubuntu-latest)`, `installer-e2e (windows-latest)`, `installer-e2e (macos-latest)` — full install/uninstall round-trip with version verification
- `Commit Lint` — Conventional Commits validation on the PR title

All 7 required (the 3 macOS variants are informational). Merge is squash-only.

## What Can You Contribute?

| Area | Examples | Test Required |
|------|----------|---------------|
| **CLI flags** | New `kmp-test <subcommand>` flag | vitest (`tests/vitest/cli.test.js` mocked spawnSync) + Pester (PS1 param wiring) |
| **Subcommand scripts** | New shell logic in `scripts/sh/run-*.sh` + `scripts/ps1/run-*.ps1` | bats (`tests/bats/`) + Pester (`tests/pester/`) — SH and PS1 must stay in parity |
| **Gradle plugin tasks** | New task class in `gradle-plugin/src/main/kotlin/.../tasks/` | Gradle TestKit (`gradle-plugin/src/test/kotlin/`) — extend `CrossShapeParityTest` if it touches a CLI subcommand |
| **Installers** | Changes to `scripts/install.{sh,ps1}` / `scripts/uninstall.{sh,ps1}` | bats `tests/installer/install.bats` + Pester `tests/installer/Install.Tests.ps1` (E2E `--archive`/`-LocalArchive` flow) |
| **Tools** | `tools/measure-token-cost.js` etc. | vitest in `tests/vitest/` |
| **Docs** | README, `docs/*.md`, `CLAUDE.md` | Render preview locally (charts, tables) before submitting |
| **CI** | `.github/workflows/*.yml` | Test on a feature branch first; check `gh run list` after push |
| **Bug fixes** | Any area | Regression test for the bug class (see v0.3.0/v0.3.2/v0.3.3/v0.4.0 historical bugs as the rubric — all have permanent E2E coverage) |

### Key Rules

1. **Every change needs tests.** The PR template asks for it; CI enforces it.
2. **SH and PS1 must stay in parity.** v0.4.0 shipped 4 PowerShell bug fixes that were missing from `run-changed-modules-tests.ps1` / `run-benchmarks.ps1` — bash sibling worked, PowerShell didn't. The Pester test suite added AST-driven splat-parity checks to prevent this regressing.
3. **Don't weaken existing tests to make new code pass.** If a test fails, fix the production code, not the test.
4. **For new install/CI logic, add E2E coverage that catches the bug class.** Existing baseline: 5 bats E2E + 4 Pester E2E covering the v0.3.0/0.3.2/0.3.3 historical install bugs (wrapper directory, `package.json` packaging, version mismatch).
5. **Versions sync across all 3 shapes** — `package.json`, `gradle-plugin/build.gradle.kts`, Git tag. CI's `installer-e2e` verifies `kmp-test --version` matches `package.json` post-install.

## Release Process

Releases are fully automated on push to `main`. The release flow:

1. On `develop`: bump `package.json` `version` and `gradle-plugin/build.gradle.kts` `version` to match. Update `CHANGELOG.md` (rename `[Unreleased]` → `[X.Y.Z]` with date). Commit, push, PR to develop, merge.
2. Open `release: vX.Y.Z` PR from `develop` → `main`. CI runs the full 7-check matrix.
3. Squash-merge to `main`. **Three workflows fire automatically:**
   - `auto-tag.yml` — creates `vX.Y.Z` git tag from `package.json` version
   - `publish-npm.yml` — `npm publish` (skipped if version already on registry)
   - `publish-gradle.yml` — publishes to GitHub Packages (skipped if version already there)
   - `publish-release.yml` (cascaded from auto-tag's tag push via `workflow_call`) — builds `linux.tar.gz` + `windows.zip` and creates the GitHub Release
4. Sync develop with main (`git checkout develop && git merge main && git push`) so the next cycle starts from a clean base. (If branch protection blocks the merge commit, see `release/v0.4.0-clean` pattern in the v0.4.0 PR for the workaround.)

All publish workflows are idempotent — re-pushing the same version is a no-op.

## Questions?

Open a [GitHub issue](https://github.com/oscardlfr/kmp-test-runner/issues) or check [CLAUDE.md](CLAUDE.md) for the project's working notes.
