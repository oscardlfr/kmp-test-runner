# Contributing to kmp-test-runner

Thank you for contributing. `kmp-test-runner` is a parallel test runner for Kotlin Multiplatform and Android Gradle projects, distributed as an npm CLI, a Gradle plugin, and release archives with shell installers. Released versions of all three distributions stay in lockstep.

## Getting started

```bash
git clone git@github.com:oscardlfr/kmp-test-runner.git
cd kmp-test-runner
npm ci

# Focused checks available on Linux/macOS
npm test
npx bats tests/bats/ tests/installer/ tests/skill-scripts/
npm run shellcheck

# Gradle plugin
cd gradle-plugin && ./gradlew test && cd ..
```

On Windows, run the Pester surfaces with PowerShell 7 and Pester 5:

```powershell
Invoke-Pester -Path tests/pester/,tests/installer/,tests/skill-scripts/ -CI
```

These commands are useful during development. Before a code-changing PR is marked ready, use the complete local gate described under [Local validation](#local-validation).

## Branch model

The repository has two long-lived branches:

| Branch | Purpose |
|---|---|
| `develop` | Integration trunk. Feature, fix, CI, and documentation PRs target this branch. |
| `main` | Released commits only. It is advanced from `develop` by the protected release workflow, not by PR or manual push. |

Work on a topic branch, normally named for its intent (`feature/*`, `fix/*`, `docs/*`, `ci/*`, or the configured agent prefix). Never push directly to `develop` and never push `main` by hand.

The authoritative required-check list is [`.github/required-checks.json`](.github/required-checks.json). It currently contains these 10 contexts:

- `Commit Lint`
- `build (ubuntu-latest)`
- `build (windows-latest)`
- `bundle-size`
- `decouple-audit`
- `gradle-plugin-test`
- `installer-e2e (ubuntu-latest)`
- `installer-e2e (windows-latest)`
- `secrets-scan`
- `skills-validate`

Do not duplicate or infer a different required-check count from workflow job counts. The manifest is validated in CI and checked against branch protection on protected-branch pushes.

## Making changes

### 1. Create a branch

```bash
git checkout develop
git pull origin develop
git checkout -b feature/my-change
```

### 2. Follow the implementation boundaries

The current operating rules live in [`CLAUDE.md`](CLAUDE.md). In particular:

- Put orchestration behavior in `lib/` and cover it in `tests/vitest/`. The scripts under `scripts/sh/` and `scripts/ps1/` are compatibility launchers, not the primary implementation.
- Keep corresponding shell and PowerShell launch surfaces in parity when a compatibility wrapper changes.
- Treat documented configuration keys and environment variables as public API. Do not silently rename or remove them.
- Do not weaken existing tests to make a change pass. Fix the production behavior or explicitly document a deliberate contract change.
- Add regression coverage for the bug class, not only the reported example.
- Keep version pins synchronized through `node tools/sync-versions.js`; `package.json` is the source of truth.
- Do not commit private project identifiers, real device serials, user-home paths, credentials, or raw evaluation material. Run the repository privacy audit locally.

### 3. Add proportional verification

| Area | Primary implementation | Expected verification |
|---|---|---|
| CLI and Node orchestration | `bin/`, `lib/commands/`, `lib/orchestrators/`, `lib/parsers/`, `lib/envelope/` | Focused Vitest plus the relevant integration/parity tests |
| Compatibility launchers | `scripts/sh/`, `scripts/ps1/` | Vitest dispatch/parity tests and Bats/Pester for the affected surface |
| Gradle plugin | `gradle-plugin/src/main/kotlin/` | Gradle TestKit under `gradle-plugin/src/test/kotlin/`; TaskAction smoke when execution wiring changes |
| Installers and release archives | `scripts/install.*`, `scripts/uninstall.*`, `scripts/build-artifact.sh` | Bats/Pester installer tests and an archive round trip |
| Agent skill or plugin | `.skills/`, `.claude-plugin/` | Skill-script tests plus the repository validators |
| Agentic-eval tooling | `tools/agentic-eval/` | Focused `agentic-eval-*.test.js` suite, schema/integrity gates, and only the explicitly authorized live work |
| Documentation | Markdown files | Link/command/source verification and rendered-table review; explain when no executable behavior changed |
| CI and release workflows | `.github/workflows/`, release tools | Workflow-static and release-gate tests plus local syntax/static checks |

Historical regression context belongs in [`CHANGELOG.md`](CHANGELOG.md) and completed [`BACKLOG.md`](BACKLOG.md) entries. Do not copy volatile test totals or old release versions into new instructions.

## Local validation

On Windows, the canonical pre-push validation combines Linux containers with native Windows checks:

```powershell
pwsh -NoProfile -File tools/local-ci/run.ps1 -Lane All
```

See [`docs/testing/local-ci.md`](docs/testing/local-ci.md) for prerequisites, covered surfaces, and diagnostic lanes. Use a focused lane while investigating, but use `-Lane All` for the final code candidate.

Useful focused commands include:

```bash
npm test
npm run test:coverage
npx bats tests/bats/ tests/installer/ tests/skill-scripts/
npm run shellcheck
node tools/check-line-endings.mjs
node tools/check-executable-fixtures.mjs
node tools/decouple-audit.mjs
node tools/check-bundle-size.mjs
node tools/sync-versions.js --check
cd gradle-plugin && ./gradlew test && cd ..
```

The local gate covers the executable repository checks that can be reproduced safely. GitHub App branch-protection drift, verified-secret lookup, PR-title status, CodeRabbit, and hosted-runner confirmation remain remote-only. macOS validation is opt-in through `.github/workflows/macos-validation.yml` to control runner cost.

## Commit and PR conventions

PR titles must conform to [Conventional Commits v1.0.0](https://www.conventionalcommits.org/), because the title becomes the squash commit subject:

```text
feat(cli): add a dispatch option
fix(installer): preserve the existing user path
docs(metrics): clarify benchmark provenance
test(gradle-plugin): cover node runtime extraction
chore(release): prepare vX.Y.Z
```

Valid types are `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`, and `release`. The description starts lowercase and has no trailing period. The workflow warns, rather than fails, when the normalized title exceeds 72 characters.

Target `develop`. Open code-changing PRs as drafts, consolidate implementation and review corrections locally, and run the full local gate before marking the PR ready. The `ready_for_review` event starts the hosted matrix. If another implementation change is required, return the PR to draft, consolidate the correction, and validate locally again.

CI is path-aware:

- `secrets-scan` always runs.
- Ready code-changing PRs run the full Linux/Windows matrix.
- Agentic-eval-only changes run the focused agentic-eval job.
- Documentation-only changes avoid the heavy jobs; a sentinel reports the required heavy contexts as successful after classifying the diff.
- Drafts defer required hosted work until ready while still running the draft privacy audit.

Use [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md) to record the change, its verification, and anything intentionally out of scope.

## Release process

There is no `develop → main` release PR and no `release/*` branch in the current process.

1. Prepare a normal PR to `develop`:
   - bump `package.json`;
   - run `node tools/sync-versions.js` to update every version pin;
   - promote `[Unreleased]` in `CHANGELOG.md` to the dated release section;
   - use a title such as `chore(release): prepare vX.Y.Z`;
   - pass the local and required hosted checks, then squash-merge.
2. Manually dispatch **Release (fast-forward main from develop)** with the same version.
3. `.github/workflows/release.yml` verifies the version, ancestry, missing tag, and all required checks on the exact `develop` SHA, then the release-bot GitHub App fast-forwards `main` to that commit.
4. The push to `main` triggers:
   - `auto-tag.yml`, which creates `vX.Y.Z` and calls `publish-release.yml` to build the Linux and Windows archives, checksums, and GitHub Release;
   - `publish-npm.yml`, which publishes the npm package when its relevant paths changed;
   - `publish-gradle.yml`, which publishes the Gradle plugin when its relevant paths changed.
5. No branch-sync merge is needed: a successful fast-forward leaves `main` and `develop` on the same commit.

The npm and Gradle registry publishers handle already-published versions as no-ops. Tag creation and the top-level release dispatch deliberately refuse an existing tag; do not describe the entire release cascade as universally idempotent.

## Filing issues

GitHub templates live under [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/) for bug reports and feature requests. When reporting a CLI failure, include the sanitized `--json` envelope when available. Never attach credentials, private paths, unpublished project names, raw agent transcripts, or unsanitized Evidence1 custody material.

Questions can be raised through [GitHub Issues](https://github.com/oscardlfr/kmp-test-runner/issues). For current work and known gaps, consult [`BACKLOG.md`](BACKLOG.md); for released behavior and historical decisions, consult [`CHANGELOG.md`](CHANGELOG.md).
