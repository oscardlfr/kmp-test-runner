# Backlog

> Active and queued tasks for `kmp-test-runner`. Newest first. Read `CLAUDE.md` first for repo state + gitflow rules.

---

## ACTIVE

_(none — pick from QUEUED below or open a new entry)_

---

## QUEUED — post-v0.3.4 ideas (newest first)

### Integrate with Google's `android` CLI for agents (skills system)

Google ships an [`android` CLI for AI agents](https://developer.android.com/tools/agents/android-cli) that covers project create/describe/run/emulator but has no test subcommand. It also ships a pluggable `skills` subsystem (`android skills`, `android init` for skill registration). Idea: package `kmp-test` as a discoverable `android` skill so any agent using the official CLI auto-finds the testing slice without separate setup. Investigate the skill manifest format, registration command, what context is passed to the skill, and whether the skill can shell out to `kmp-test --json` cleanly.

Estimated effort: 2–3h investigation + ~1h to ship a minimal skill if the format is straightforward. Win: makes kmp-test a first-class citizen for agents using Google's tooling, zero integration work on the agent side.

### Use `android describe` JSON as module-discovery source (pending review)

The official `android` CLI's `describe` subcommand emits a JSON document of build targets + APK paths for an Android project. Currently kmp-test does its own module discovery via bash filesystem walks (`scripts/sh/lib/script-utils.sh` etc.), which on Windows MinGW is the slow path that motivated the [concurrent-invocation safety entry](#concurrent-invocation-safety-multi-agent-scenarios) above and is the suspect for the 10+ min hang against `dipatternsdemo` (43-module project). Consider replacing or augmenting the bash discovery with an `android describe` invocation when the CLI is on PATH — gets the official Google schema, faster on Windows.

Open questions: (1) does `describe` cover KMP-only (non-Android) modules, or only AGP-rooted ones? (2) what's the schema stability guarantee, esp. for multi-module multi-target KMP? (3) fallback path when `android` CLI isn't installed — keep bash discovery as default, opt-in via `--use-android-describe` flag.

Estimated effort: 3–4h research + refactor in `scripts/sh/lib/`. Pending review on (1) above before committing — if `describe` doesn't enumerate KMP non-AGP modules it's not a drop-in replacement.

### Other QUEUED ideas

- **ANSI color** — auto-detect TTY, plain output when piped
- **Maven Central publish** for Gradle plugin — currently GitHub Packages only; needs Sonatype account + signing keys
- **iOS/macOS TestKit** matrix — needs Mac hardware in CI
- **VitePress/MkDocs docs site** — separate consumer-facing docs beyond README

---

## DONE (recent — newest first)

- 2026-04-26: **Real token-cost metrics for the "Agentic usage" claim** — `tools/measure-token-cost.js` (Node + js-tiktoken; `--project-root`, `--module-filter`, `--test-task`, `--runs`) runs the three approaches (A: raw `./gradlew + read build/reports/**`, B: `kmp-test parallel`, C: `kmp-test parallel --json`) against any KMP project and emits a markdown table with token counts. First run against `shared-kmp-libs:core-result:desktopTest` produced **A 12,816 tok / B 376 tok / C 100 tok** — `--json` is **128× cheaper than raw gradle**. Captured run logs committed to `tools/runs/`; methodology + caveats in `docs/token-cost-measurement.md`; README "Agentic usage" section updated to link the doc. Replaces the prior qualitative claim with a self-auditable measurement.
- 2026-04-26: **v0.3.7** — DX & agentic features bundle. `--dry-run` (skip spawn, print/JSON the resolved plan), `kmp-test doctor` subcommand (5 env checks: Node, shell, gradlew, JDK, ADB; human table + `--json` array), and `--test-filter <pattern>` passthrough (gradle `--tests` for JVM, `-Pandroid.testInstrumentationRunnerArguments.class=` for Android with `*Pattern*` → FQN resolution by source scan). Plus Conventional Commits enforcement on PR titles via `.github/workflows/commit-lint.yml` (adapted inline from AndroidCommonDoc reusable workflow — repo stays standalone). 91 vitest + 52 bats tests. **Branch protection must be updated to add `commit-lint / 🔤 Commit Lint` as required check.**
- 2026-04-25: **v0.3.6** — `auto-tag.yml` → `publish-release.yml` cascade now fires automatically via `workflow_call` (no PAT, no rotation). v0.3.5 had needed manual `gh workflow run -f tag=...` to ship artefacts because GitHub blocks `GITHUB_TOKEN`-pushed events from triggering downstream workflows. v0.3.6's merge was the first 100 %-hands-off cascade end-to-end (auto-tag → release artefacts → npm publish → gradle publish), ~90 sec from merge to all artefacts visible. (PR #15 + #16)
- 2026-04-25: **v0.3.5** — `scripts/install.ps1` `Resolve-LatestVersion` now works in PowerShell 7+ via new `Get-LocationHeader` helper (the old `$Response.Headers["Location"]` indexer threw on `HttpResponseHeaders`). Also added `develop` to `ci.yml` triggers (PR-to-develop checks were not running). Was the first real exercise of the auto-publish pipeline (v0.3.4's was a no-op for auto-tag). Caught while validating v0.3.4 install.ps1 against the live GitHub Release. (PR #13 + #14)
- 2026-04-25: **Auto-publish on push to `main`** — `publish-npm.yml` + `publish-gradle.yml` + new `auto-tag.yml` all trigger on push to main with skip-if-already-published idempotency. Bumping `package.json` (and `gradle-plugin/build.gradle.kts`) + merging develop → main now produces npm publish + gradle publish + git tag + GitHub Release artefacts in one shot. Documented in CLAUDE.md gitflow section.
- 2026-04-25: **`develop` branch** added as integration branch alongside `main`. Daily work goes to `develop`; releases promote `develop → main` and trigger the auto-publish pipeline.
- 2026-04-25: **v0.3.4** — Agentic CLI. `--json` / `--format json` output mode, per-subcommand `--help`, pre-flight `gradlew` check, semantic exit codes (0/1/2/3). README "Agentic usage — token-cost rationale" section. Shipped via 4 PRs (#8 feature + #9 bin-name + #10 benchmark platform-filter + #11 coverage + 2 latent bug fixes).
- 2026-04-25: **Full E2E installer test coverage** (W31.5c post-ship hardening) — `scripts/build-artifact.sh` + 5 bats E2E + 4 Pester E2E + `installer-e2e` CI matrix job. Catches all 3 historical bugs (wrapper dir, missing package.json, version sync) as regression tests.
- 2026-04-25: **v0.3.3** — third hotfix; `package.json` version bumped from stale `0.2.0` to `0.3.3`. First fully working release.
- 2026-04-25: **v0.3.2** — second hotfix; added `package.json` to release artifacts.
- 2026-04-25: **v0.3.1** — first hotfix; wrapped release artifacts in `kmp-test-runner-${VER}/` directory so installer extraction works.
- 2026-04-25: **v0.3.0** — W31.5c original ship. Installer scripts (POSIX + PowerShell) + `CHANGELOG.md` + README polish + `publish-release.yml` workflow.
- 2026-04-25: **v0.2.0** — W31.5b. Gradle plugin shape (5 tasks, Kover auto-detect, GitHub Packages publish).
- 2026-04-24: **v0.1.0** — W31.5a. Initial npm CLI release with 5 subcommands (parallel, changed, android, benchmark, coverage).
- 2026-04-25: **Branch protection** on `main` (PR required, 6 CI checks, linear history, enforce_admins).
