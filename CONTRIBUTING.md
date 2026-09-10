# Contributing

Thanks for helping improve `kmp-test-runner`. The repository uses `develop` as its protected integration branch; `main` is the released pointer and is advanced only by the release workflow.

## Branch and PR workflow

```sh
git switch develop
git pull --ff-only origin develop
git switch -c feature/<short-name>
```

Make focused changes, add regression coverage, and use a Conventional Commit subject. Push the feature branch and open a PR targeting `develop`.

Code-changing PRs should start as drafts. Draft pushes avoid the expensive hosted matrix while local work and review findings are consolidated. Before marking ready, run:

```powershell
pwsh -NoProfile -File tools/local-ci/run.ps1 -Lane All
```

Mark the PR ready once for the final hosted matrix. If a later correction is necessary, return it to draft, consolidate and revalidate locally, then make it ready again.

Never push directly to `develop` or `main`, force-push protected branches, or open a `develop → main` release PR.

## PR titles

Titles follow [Conventional Commits](https://www.conventionalcommits.org/):

```text
feat(cli): add focused test selection
fix(installer): preserve the previous installation on failure
docs: clarify Evidence1 reproduction boundaries
test(android): cover device-task selection
```

Allowed types are `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`, and `release`. Start the description lowercase, omit a trailing period, and keep the title at 72 characters or fewer.

## What to test

| Change | Minimum evidence |
|---|---|
| Node CLI/orchestrator | Focused Vitest regression plus full local gate. |
| Shell or PowerShell behavior | Matching cross-platform change where applicable; Bats/Pester regression. |
| Gradle plugin | Gradle TestKit coverage and CLI/plugin contract review. |
| Installer/release artifact | Linux and Windows installer E2E. |
| Android device behavior | Unit/contract tests and, when required, a controlled device/emulator run. |
| Evaluation harness/schema | Rejection and acceptance tests, validator run, privacy gate. |
| Documentation | Link/reference checks, executable examples, and drift tests where available. |
| CI/release | Local validation plus a deliberately scoped hosted check. |

Do not weaken or delete an existing test to make new behavior pass. Fix the implementation or update a test only when the public contract intentionally changed.

## Focused commands

```sh
npm test
npm run shellcheck
node tools/check-line-endings.mjs
node tools/check-executable-fixtures.mjs
node tools/validate-required-checks.mjs
node tools/validate-plugin.mjs
node tools/sync-versions.js --check
node tools/decouple-audit.mjs
```

The canonical Windows pre-push gate and its prerequisites are documented in [docs/testing/local-ci.md](docs/testing/local-ci.md).

## Public-surface rules

- Keep project discovery and orchestration in Node when possible; keep platform wrappers thin.
- Maintain equivalent Windows/POSIX behavior for shared features.
- Treat consumer configuration and JSON error codes as public API.
- Keep private project names, machine paths, and maintainer-only identifiers out of committed text.
- Never commit credentials, raw authenticated transcripts, VM images/state, or evaluation custody bundles.
- Use [docs/metrics.md](docs/metrics.md) for detailed measurements. README claims must be short, traceable, and within-project.
- Update current reference docs instead of adding a version-history section to the README.

## Required checks

`.github/required-checks.json` is the source of truth. At the time of writing it contains:

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

Do not copy volatile test counts into templates or docs. The validation script checks that workflow and branch-protection expectations stay aligned.

## Release process

Releases use a true fast-forward from `develop` to `main`; there is no release branch and no PR to `main`.

1. Open a normal preparation PR to `develop`: bump `package.json`, run `node tools/sync-versions.js`, and convert `[Unreleased]` in `CHANGELOG.md` to the release version/date.
2. Merge the preparation PR only after required checks pass.
3. Dispatch `.github/workflows/release.yml` with the exact version.
4. The release-bot GitHub App verifies the version and ancestry, then fast-forwards `main` to the already-tested `develop` SHA.
5. The `main` push triggers tagging and idempotent npm, Gradle-package, archive, and GitHub Release publication.

There is no post-release branch synchronization step because `main` and `develop` point to the same commit.

## Issues and pull requests

Use the templates under `.github/`. Include the smallest useful reproduction, a sanitized JSON envelope when available, and the verification you performed. For evaluation changes, distinguish raw custody from committable sanitized evidence.

See [PRODUCT.md](PRODUCT.md) for product principles and [docs/README.md](docs/README.md) for the documentation map.
