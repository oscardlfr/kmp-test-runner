# Repository working guide

`kmp-test-runner` is an MIT-licensed npm CLI, Gradle plugin, and release-installer set for Kotlin Multiplatform and Android Gradle projects.

## Published shapes

- npm: `kmp-test-runner@0.14.0`
- Gradle plugin: `io.github.oscardlfr.kmp-test-runner:0.14.0`
- GitHub Releases: `v0.14.0`

`package.json` is the version source of truth. `node tools/sync-versions.js` propagates it to the plugin, README sample, this file, and the Claude plugin manifest.

## Repository map

- `bin/kmp-test.js` — CLI entry point.
- `lib/` — discovery, orchestration, Gradle execution, parsing, reports, and JSON envelopes.
- `scripts/sh/`, `scripts/ps1/` — thin platform entry points and installers.
- `gradle-plugin/` — Gradle plugin and TestKit tests.
- `tests/vitest/`, `tests/bats/`, `tests/pester/`, `tests/installer/` — automated tests.
- `tools/local-ci/` — Docker Linux plus native Windows pre-push gate.
- `tools/agentic-eval/` — agentic evaluation harness.
- `docs/evaluation/` — current Evidence1/operator documentation.
- `tools/runs/` and `docs/audits/` — dated evidence and historical audits.
- `BACKLOG.md` — active work; read it before changing scope.

## Branch model

`develop` is the protected integration branch. `main` is the protected released pointer.

- Never push directly to either branch.
- Feature/docs/fix branches target `develop`.
- Use squash/rebase history and a Conventional Commit PR title.
- Code-changing PRs start as drafts; consolidate changes and run the full local gate before making them ready.
- `.github/required-checks.json` is the only canonical required-check inventory.
- Do not open a `develop → main` PR.

Daily flow:

```sh
git switch develop
git pull --ff-only origin develop
git switch -c feature/<slug>
# implement and verify
git push -u origin feature/<slug>
gh pr create --draft --base develop --title "type(scope): summary"
pwsh -NoProfile -File tools/local-ci/run.ps1 -Lane All
gh pr ready
```

## Release flow

1. Merge a preparation PR to `develop` with the version bump, synchronized version surfaces, and changelog date.
2. Dispatch `.github/workflows/release.yml` with that exact version.
3. The release-bot GitHub App verifies version/ancestry and fast-forwards `main` to the tested `develop` SHA.
4. The `main` push triggers tag, npm, Gradle package, archives, and GitHub Release publication.

There is no release branch, `main` PR, squash release commit, or post-release sync. Publish workflows are idempotent for an already published version.

## Required engineering rules

- Never weaken an existing test to make a new code path pass.
- Add a regression test for the bug class.
- Keep orchestration in Node and platform wrappers thin.
- When shared SH/PS1 behavior changes, update and test both surfaces.
- Use pure fixtures/fakes where possible; keep Windows file-lock tests sequential.
- Preserve `CancellationException` in any KMP consumer examples, but do not add unrelated app-architecture guidance to this repository.
- Avoid private project names, user home paths, IDE directories, and maintainer-only identifiers in committed text. Run `node tools/decouple-audit.mjs`.
- Never commit credentials, authenticated raw transcripts, VM images/state, private measurement scopes, or Evidence1 custody bundles.

## Documentation rules

- Keep `README.md` short: onboarding, core commands, platforms, one metrics summary, and links.
- Put detailed measurements in `docs/metrics.md`; never construct a ratio from different projects/captures.
- Put current eval operations in `docs/evaluation/` and implementation contracts in `tools/agentic-eval/README.md`.
- Treat dated audit/run files as immutable historical snapshots. Add a correction note rather than rewriting history.
- Do not add “What's new in vX” sections to README; use `CHANGELOG.md`.
- `docs/cli-reference.md` is tested against parser flags. Update it with any public CLI flag.
- Milestone assignment belongs to the maintainer. Do not create, move, or drop milestone scope without explicit direction.

## Verification

Focused commands:

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

Before a code-changing PR becomes ready on Windows:

```powershell
pwsh -NoProfile -File tools/local-ci/run.ps1 -Lane All
```

macOS-heavy validation is manually dispatched to control runner cost. Do not add a broad macOS PR matrix without an explicit product decision.

## Install/release invariants

- Release archives have one top-level `kmp-test-runner-<version>/` directory.
- The archive contains `package.json`; the CLI reads its version at runtime.
- Installer downloads use the release redirect first and API fallback.
- Checksums are verified before extraction.
- Windows modifies HKCU/user PATH only.
- Offline installer E2E must verify the installed `kmp-test --version` matches `package.json`.

## Evidence1

The current versioned launcher supports registered one-cell product and free-baseline canaries on the prepared `Evidence1-Runner` VM. It still assumes fixed VM/path/version/source bindings and is not a clean-room ISO provisioner. Follow [docs/evaluation/evidence1-live-canary.md](docs/evaluation/evidence1-live-canary.md) and preserve one-use authorization/custody semantics.

## Further reading

- [Product principles](PRODUCT.md)
- [Contributor guide](CONTRIBUTING.md)
- [Documentation index](docs/README.md)
- [Local CI](docs/testing/local-ci.md)
- [Metrics](docs/metrics.md)
- [Agentic evaluation](docs/evaluation/README.md)
