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

### Other QUEUED ideas

- **`kmp-test doctor`** — env diagnostic (Node version, Gradle wrapper present, JDK version, etc.) — outputs human-readable + `--json` mode
- **`--dry-run`** — print what would run, exit 0 without invoking Gradle
- **`--test-filter`** passthrough — let agents/users filter to a single benchmark or test class (e.g. `*ScaleBenchmark*`); maps to `--tests` for JVM tasks and `-Pandroid.testInstrumentationRunnerArguments.class=…` for Android instrumented tests. Caught as a real-world need while validating v0.3.4 against `dipatternsdemo` (had to bypass the CLI to run a single benchmark class).
- **ANSI color** — auto-detect TTY, plain output when piped
- **Maven Central publish** for Gradle plugin — currently GitHub Packages only; needs Sonatype account + signing keys
- **iOS/macOS TestKit** matrix — needs Mac hardware in CI
- **VitePress/MkDocs docs site** — separate consumer-facing docs beyond README

---

## DONE (recent — newest first)

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
