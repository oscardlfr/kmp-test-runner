# kmp-test-runner repository guide

> Operational rules for humans and coding agents. Product principles live in `PRODUCT.md`, current work in `BACKLOG.md`, released history in `CHANGELOG.md`, and user-facing usage in `README.md`.

## Current release pins

- npm: `kmp-test-runner@0.14.0`
- Gradle plugin: `io.github.oscardlfr.kmp-test-runner:0.14.0`
- GitHub Releases: `v0.14.0`
- `package.json` is the version source of truth; `node tools/sync-versions.js` updates the other release pins.

Historical v0.6/v0.7 implementation notes and the v0.8 Node-orchestration migration remain available in [`CHANGELOG.md`](CHANGELOG.md) and the completed sections of [`BACKLOG.md`](BACKLOG.md). They are history, not current operating instructions.

## Repository layout

- `bin/kmp-test.js` — npm executable entry point.
- `lib/cli.js` and `lib/commands/` — CLI parsing and subcommand dispatch.
- `lib/orchestrators/` — current orchestration for parallel, coverage, changed, Android, benchmark, info, describe, and update flows.
- `lib/project/`, `lib/parsers/`, and `lib/envelope/` — project discovery, report parsing, typed diagnostics, and JSON-envelope construction.
- `lib/runners/` and `scripts/{sh,ps1}/` — dispatch compatibility layer and thin direct-invocation launchers.
- `scripts/install.{sh,ps1}`, `scripts/uninstall.{sh,ps1}`, and `scripts/build-artifact.sh` — installers and release-archive construction.
- `gradle-plugin/` — Gradle plugin, extension, bundled runtime extraction, five public tasks, and TestKit suite.
- `tests/vitest/`, `tests/bats/`, `tests/pester/`, `tests/installer/`, and `tests/skill-scripts/` — executable verification surfaces.
- `tools/local-ci/` — reproducible Linux-container plus native-Windows pre-push gate.
- `tools/agentic-eval/` and `docs/audits/` — evaluation harness, operational evidence, and historical audits; privacy and authorization rules apply.
- `.github/workflows/` — path-aware CI, manual macOS validation, protected release fast-forward, and publishers.

## Git and CI

The repository has two long-lived branches:

- `develop` is the integration trunk. All normal PRs target it.
- `main` contains released commits. It is fast-forwarded from `develop` only by the protected `Release` workflow.

Never push directly to `develop`, never push `main` by hand, and never open a `develop → main` PR. Use a topic branch and squash-merge through a PR to `develop`.

The authoritative required contexts are stored in [`.github/required-checks.json`](.github/required-checks.json):

1. `Commit Lint`
2. `build (ubuntu-latest)`
3. `build (windows-latest)`
4. `bundle-size`
5. `decouple-audit`
6. `gradle-plugin-test`
7. `installer-e2e (ubuntu-latest)`
8. `installer-e2e (windows-latest)`
9. `secrets-scan`
10. `skills-validate`

`tools/validate-required-checks.mjs` validates the manifest schema and checks protected-branch drift when the required GitHub App credentials are available. When a required context changes, update the workflow, manifest, and branch/ruleset configuration together.

### PR workflow and CI cost discipline

Code-changing PRs start as drafts. Finish the implementation and review pass locally, run:

```powershell
pwsh -NoProfile -File tools/local-ci/run.ps1 -Lane All
```

Then push the consolidated candidate and mark the PR ready. GitHub Actions is the final hosted confirmation, not an iterative debugger. If another implementation correction is required, return the PR to draft before pushing it.

`.github/workflows/ci.yml` classifies the diff:

- source, workflow, package, Gradle-plugin, and general test changes run the full Linux/Windows matrix;
- agentic-eval-only changes run the focused agentic-eval suite;
- documentation-only changes skip the heavy jobs and use the status sentinel for required heavy contexts;
- `secrets-scan` remains unconditional;
- macOS jobs run only through the manually dispatched `macOS Validation` workflow.

PR titles follow Conventional Commits: `<type>[scope][!]: <description>`. The description starts lowercase and has no trailing period. GitHub is configured to use the PR title as the squash subject, and `Commit Lint` validates that title.

### Daily workflow

```bash
git checkout develop
git pull origin develop
git checkout -b feature/<slug>
# edit and run focused tests
git commit -m "type(scope): summary"
git push -u origin feature/<slug>
gh pr create --draft --base develop --title "type(scope): summary" --body-file <file>
# complete review and the full local gate
gh pr ready
# wait for all contexts from .github/required-checks.json
gh pr merge <number> --squash --delete-branch
git checkout develop
git pull origin develop
```

## Release workflow

`main` is a release pointer that fast-forwards to an already-validated `develop` commit. There is no release branch and no release PR to `main`.

1. Land a normal preparation PR on `develop`: bump `package.json`, run `node tools/sync-versions.js`, and promote the `CHANGELOG.md` `[Unreleased]` section to `[X.Y.Z] — <date>`.
2. Dispatch **Release (fast-forward main from develop)** with version `X.Y.Z`.
3. `.github/workflows/release.yml` validates that the input equals `develop`'s package version, `main` is an ancestor of `develop`, the tag does not exist, and every required context is green on the exact `develop` SHA.
4. A short-lived release-bot GitHub App token fast-forwards `main`. Humans, including the owner, do not bypass this rule.
5. The `main` push triggers the release cascade:
   - `auto-tag.yml` creates `vX.Y.Z` and calls `publish-release.yml` for archives, checksums, and the GitHub Release;
   - `publish-npm.yml` publishes through npm Trusted Publisher OIDC when npm-shape paths changed;
   - `publish-gradle.yml` publishes to GitHub Packages when Gradle-plugin paths changed.
6. Do not merge `main` back into `develop`; after a true fast-forward they already reference the same commit.

The npm publisher skips an existing registry version. The Gradle publisher treats an authoritative HTTP 409/already-exists response as a successful no-op. The top-level release workflow and tag creation fail closed when `vX.Y.Z` already exists. Manual publisher dispatch is a guarded recovery path, not the normal release flow.

## Versioning invariants

- `package.json#version` is the source of truth.
- `node tools/sync-versions.js` applies the version to `gradle-plugin/build.gradle.kts`, the README plugin sample, the three release-pin lines above, and `.claude-plugin/plugin.json`.
- `node tools/sync-versions.js --check` is verification-only and runs in CI.
- The Git tag, package metadata, Gradle plugin, and installer-visible `kmp-test --version` must agree before publishing.
- Release archives contain a top-level `kmp-test-runner-${VER}/` directory and include `package.json`; installers depend on both invariants.
- Release artifacts are architecture-independent Node distributions: one Linux/macOS tarball and one Windows zip, each with SHA-256 checksum.

## Architecture rules

### Logic in Node, compatibility at the edges

Module discovery, Gradle dispatch, parallelism, output parsing, JDK/Android SDK resolution, coverage aggregation, and JSON-envelope construction belong in `lib/`. Shell and PowerShell wrappers are compatibility launchers. Do not add new orchestration logic to both shell dialects.

When a wrapper must change, keep its sibling surface and direct-invocation behavior in parity. Preserve the existing thin-launcher size tests. The Gradle plugin extracts the bundled Node runtime files and invokes the same Node runner; it does not maintain an independent shell implementation of product behavior.

### Public contracts

- The `--json` envelope is an API. Additive fields are preferred; renames and removals require an explicit compatibility decision and migration note.
- Error conditions that agents must branch on use typed `errors[].code` values and consistent exit-code classification.
- Configuration files, environment variables, and Gradle extension properties documented as public API remain backward compatible unless a release explicitly changes the contract.
- iOS and macOS execution requires a macOS host and must fail with `platform_unsupported` elsewhere.
- Cancellation, timeout, missing-toolchain, missing-device, and report-unavailable cases must not become false passes.

### Privacy and repository independence

`node tools/decouple-audit.mjs` always scans committed text for public private-data shapes such as real device serials and user-home paths. Optional private patterns are loaded from `KMP_PRIVATE_PATTERNS_FILE` or a gitignored `tools/.private-patterns.json`; `KMP_PRIVATE_SCAN_REQUIRED=1` fails closed if that source is missing. Never inline private identifiers into source, tests, docs, or CI configuration.

The shipped skip variables (`SKIP_DESKTOP_MODULES`, `SKIP_ANDROID_MODULES`, `SKIP_IOS_MODULES`, `SKIP_MACOS_MODULES`, and `PARENT_ONLY_MODULES`) are consumer configuration, not private-project coupling.

Agentic-eval evidence has stricter rules: authorization is explicit, paid live sessions are bounded, raw prompts/transcripts and credentials are not committed, and public evidence must pass the harness privacy and integrity gates.

### Documentation discipline

- Keep the README timeless: installation, usage, value, verified examples, and links to deeper guides. Version-by-version history belongs in `CHANGELOG.md`.
- Every published metric must identify its evidence, date, tokenizer/measurement method, and limitations. Ratios must use numerator and denominator from the same project and capture unless an inline label explicitly says cross-project.
- Do not present historical plans or audit proposals as implemented behavior. Label them historical/partial and link to current implementation or backlog status.
- Record real implementation gaps in `BACKLOG.md`; do not invent a milestone, drop an item, or change its priority without user direction.
- Do not publish volatile test counts as durable project contracts.

### CI and macOS cost

Keep the required per-PR matrix on Linux and Windows. macOS validation is opt-in through `.github/workflows/macos-validation.yml`, which contains the macOS Vitest, installer, Bash 3.2, and Gradle-plugin jobs. Do not add recurring or per-PR macOS spend without an explicit product decision.

## Verification strategy

- **Vitest:** Node implementation, CLI contracts, schemas, parity, workflow static checks, and tooling.
- **Bats:** POSIX launchers, installer behavior, and skill scripts.
- **Pester:** Windows launchers, installer behavior, Evidence1 PowerShell surfaces, and skill scripts.
- **Gradle TestKit:** plugin application, extension/task contracts, bundled runtime extraction, and TaskAction behavior.
- **Installer E2E:** build an archive, install it, verify the packaged version and CLI, uninstall it, and confirm cleanup.
- **Wide-smoke/manual validation:** representative public projects and platform-specific behavior that cannot be reproduced in ordinary CI.

Useful focused commands:

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
cd gradle-plugin && ./gradlew test
```

On Windows, the final code gate is `pwsh -NoProfile -File tools/local-ci/run.ps1 -Lane All`. Do not substitute passing focused tests for that final gate.

## Before declaring work complete

1. Read `BACKLOG.md` and the relevant implementation before editing.
2. Preserve unrelated user changes and stay within assigned files/worktree.
3. Add or update proportional tests; never weaken an existing assertion merely to make CI green.
4. Run focused checks, review the diff adversarially, then run the full local gate for code changes.
5. Verify documentation statements against the current implementation and workflows.
6. Use a Conventional Commit PR title and wait for every context in `.github/required-checks.json`.
7. For a release, prepare `develop` first and use the guarded fast-forward workflow; never tag or push `main` manually.
