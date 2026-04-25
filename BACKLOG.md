# Backlog

> Active and queued tasks for `kmp-test-runner`. Newest first. Read `CLAUDE.md` first for repo state + gitflow rules.

---

## ACTIVE

_(none — pick from QUEUED below or open a new entry)_

---

## QUEUED — post-v0.3.4 ideas (newest first)

### Real token-cost metrics for README "Agentic usage" section

The README "Agentic usage — token-cost rationale" section currently makes a qualitative claim ("~80–100 tokens vs. several thousand"). It would be more credible with **measured numbers from a real KMP project run**, not estimated.

Open question: how to measure realistically and reproducibly? Options to think through:

- **Token counter:** use `tiktoken` (OpenAI) and / or Anthropic's `count_tokens` API endpoint to count the actual stdout an agent would consume.
- **Three runs on the same project:**
  - **A. raw Gradle**: `./gradlew :module1:test :module2:test ... --parallel` + `koverHtmlReport`, then read every generated `build/reports/**/index.html` + `*.xml`. Capture full stdout + report file contents.
  - **B. `kmp-test` default**: capture full stdout (already markdown-summarized).
  - **C. `kmp-test --json`**: capture single JSON line.
- **Same project, same module set** for fair comparison. Could use DawSync or a fixture — DawSync is more credible (real production codebase) but moves token counts every commit.
- **Repeat 3 times, report mean ± std** — token counts vary by which tests run, log volume, ANSI density.
- Output a small report (markdown table) committed to the repo, referenced from README. Keeps the claim self-auditable.

Estimated effort: 2–3h. Could be a `tools/measure-token-cost.sh` script + `docs/token-cost-measurement.md`.

### Concurrent-invocation safety (multi-agent scenarios)

When multiple AI agents (or humans, or CI matrix shards) run `kmp-test` against the **same project root** simultaneously, several output paths collide and a few resources contend. Gradle itself is safe — its daemon serializes builds and `.gradle/` lockfiles prevent corruption. The CLI layer does not.

**Hard collisions (data clobber):**
- `<project>/coverage-full-report.md` and `<project>/benchmark-report.md` — fixed names. Two runs → last writer wins. An agent reading the report mid-write sees garbage.
- `${TMPDIR}/gradle-parallel-tests-<YYYYMMDD-HHMMSS>.log` — date-second granularity. Same-second invocations clobber. Missing `$$` (PID).

**Resource contention:**
- `kmp-test android` device auto-detect — two parallel runs without explicit `--device` both pick `emulator-5554`, tests interleave on the same device.
- `kmp-test changed` reads `git status` then runs — if another process commits between detection and execution, the detected module set is stale.

**Soft contention (slow, not corrupt):**
- Gradle's own daemon + `.gradle/` lockfile serialize builds against the same project. Second invocation just waits. Correct but invisible.

**Proposed deliverable — three tiers, ship tier 1 first:**

1. **Cheap hardening (~1h):** add `$$` / PID to `TEMP_LOG` filename; per-invocation run-id (timestamp + PID hash) in report filenames; advisory lockfile at `<project>/.kmp-test-runner.lock` with `{pid, start_time, subcommand, project_root}` JSON; on collision warn + offer `--force` override. Stale-lock detection (PID dead → reclaim).
2. **Audit + docs (~30min):** grep every output path in `scripts/sh/` and `scripts/ps1/`; produce `docs/concurrency.md` with the collision matrix (subcommand × resource × outcome) so consumers know what's safe.
3. **Opt-in isolation (~3-4h):** `--isolated` global flag → injects `--project-cache-dir <tmp>` into every gradle invocation, giving each run its own `.gradle/` cache. Slow (no cache hits), but truly parallel-safe. Ideal for CI multi-agent fan-out.

Out of scope for this item: cross-host coordination (use a real lock manager), Gradle-internal concurrency tuning, or rewriting the daemon model.

### Other QUEUED ideas

- **ANSI color** — auto-detect TTY, plain output when piped
- **Maven Central publish** for Gradle plugin — currently GitHub Packages only; needs Sonatype account + signing keys
- **iOS/macOS TestKit** matrix — needs Mac hardware in CI
- **VitePress/MkDocs docs site** — separate consumer-facing docs beyond README

---

## DONE (recent — newest first)

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
