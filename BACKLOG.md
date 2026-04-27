# Backlog

> Active and queued tasks for `kmp-test-runner`. Newest first. Read `CLAUDE.md` first for repo state + gitflow rules.

---

## ACTIVE

### v0.5.0 — Real-world Mac validation hardening (in progress)

4 production bugs surfaced when a user ran `kmp-test v0.4.1` on a corporate Mac against a 20-module OpenNative project. Bundled into milestone v0.5.0.

- **Bug A — JDK toolchain mismatch is non-blocking, tests fail with `UnsupportedClassVersionError`** _(DONE — PR #43 merged d48c6e5)_
  - BLOCKS by default with exit 3 and a per-OS hint for setting `JAVA_HOME`. `--ignore-jdk-mismatch` / `-IgnoreJdkMismatch` downgrades to a warning. `gradle.properties` `org.gradle.java.home` still bypasses the check.

- **Bug B — Modules without tests/coverage cause silent failures and misleading reports** _(in this PR)_
  - Was: script invoked `:module:jacocoTestReport` even when modules don't define the task; api/aggregator modules failed with "task not found" but final output said `[OK] Full coverage report generated!` with 0% coverage.
  - Now: **auto-skip modules with no `src/*Test*` directory** by default. Plus new `--exclude-modules <pattern>` for explicit exclusion (self-documenting). Opt-out via `--include-untested` for projects in early development. Tests: 4 vitest + 10 bats + 9 Pester.

- **Bug C — Gradle 9 deprecation exit-code-1 noise mixed with stderr** _(in this PR)_
  - Was: `[!]` prefix indistinguishable from real warnings; `BUILD FAILED` from the deprecation pile ended up in `errors[]`.
  - Now: distinct `[NOTICE]` prefix (sh + ps1) + JSON envelope grows `warnings: [{code: "gradle_deprecation", gradle_exit_code, tasks_passed}]`. PowerShell script gains the missing 3-branch JVM-error/deprecation/per-module logic that bash already had. Tests: 10 vitest + 4 bats + 5 Pester.

- **Bug D — Installer macOS PATH UX: "installed successfully" but `kmp-test` not on PATH** _(queued)_
  - `~/.zshrc` updated, but new shell required to pick it up. Fix: detect shell (`$SHELL`), suggest the explicit `source ~/.zshrc` or `~/.bashrc`, and print the literal `export PATH=...` line for use right now.

- **Bonus — README hero banner** _(needs design decision)_
  - Hand-drawn banner provided. Has typos ("CONTEXTUAUZATION", `"savings_rae"`); decide whether to ship as-is, regenerate, or commission cleaner version.

---

## QUEUED — post-v0.3.4 ideas (newest first)

### Multi-feature token-cost measurement (v0.4 milestone)

Today's measurement (PRs #27–#29) covers **one** scenario: `kmp-test parallel` with Kover coverage on a single failing module of `shared-kmp-libs`. The "127–154× cheaper than raw gradle" claim in the README only stands up for that scenario. The CLI ships several other features the same agent-cost story applies to but we haven't measured:

- **`coverage`** (= `parallel --skip-tests`) — "I already ran tests, just regenerate the report." Approach A is `./gradlew koverXmlReport` (or `jacocoXmlReport`) + read the aggregated report; B/C are `kmp-test coverage` markdown / `--json`. Hypothesis: the largest A:C ratio of the lot, because A drops the test logs but the aggregated XML is still huge.
- **`changed`** — incremental retry of changed modules. Approach A is `git diff` filter + per-module raw gradle + reports for that subset; B/C are `kmp-test changed --json`. Hypothesis: matches `parallel`'s ratio but at smaller absolute scale.
- **`benchmark`** — `kotlinx-benchmark` runs. Approach A is `./gradlew :module:nativeBenchmark` + read benchmark report JSON/HTML; B/C are `kmp-test benchmark --json`. Hypothesis: distinct story — benchmark output is denser/structured, the savings story is "you don't need the per-iteration noise."
- **`android`** (instrumented tests on emulator) — out of scope for v0.4; needs an emulator + connected device, breaks the CI repro story. Defer to v1.0 with an Android-flavored variant of the measurement script.
- **`doctor`** — too small (<200 tokens regardless of mode). Skip.

**Coverage-tool variation worth one extra column.** The default is Kover; JaCoCo is supported but currently undocumented in the README (separate quick-fix entry below). For one project run it twice (Kover, JaCoCo) and tabulate side-by-side — the A row will diverge (different XML schemas), B/C should be identical (CLI normalises). One row per coverage tool answers "does the savings claim depend on Kover?"

**Reference projects.** Stick with `shared-kmp-libs` for v0.4 (consistent variables — same module count, same deps, same JDK). `dawsync` and `dipatternsdemo` are tempting cross-validation but `dipatternsdemo`'s 43-module discovery hung on Windows MinGW already (per current docs) — adding a third project doesn't validate the claim more, it just adds tokens spent.

**Chart redesign (mandatory).** 4 features × 3 approaches × 4 tokenizers = 48 bars in one chart is unreadable. Two viable layouts:
- **One chart per feature** at the top of `docs/token-cost-measurement.md`, then a single "summary" row in the README with feature on x-axis and `A:C ratio` on y-axis (one number per feature). README stays scannable, doc has the full breakdown.
- **One markdown bar table per feature** (no Mermaid), like the current README structure. Renders everywhere, easy to scan for "which feature gets which savings."

Recommend the second — Mermaid xychart-beta has been a pain (PRs #28–#29 history) and a clean markdown table per feature is more durable.

**Cost projection.** `messages.countTokens` calls cost ~$3–15/MTok depending on model. 4 features × 3 captures × 3 Claude models × ~25k input tokens average ≈ 900k tokens ≈ **$3–14 per full re-measure**. Acceptable as a one-time investment per release that updates these numbers; not OK to re-run on every PR. Treat the captures in `tools/runs/` as authoritative for the docs and only re-measure when the CLI's output shape changes (e.g. `--json` schema bump).

**Effort estimate.** Per feature: ~1–2h to add the "approach A" raw-gradle equivalent in `tools/measure-token-cost.js`, capture, tokenize, write up. 3 features = 4–6h coding + ~$10 API. Plus 2–3h for the chart redesign and doc reorg. Total **~8–10h** for v0.4.

**Out of scope for this entry.** README quick-fix mentioning Kover/JaCoCo as supported coverage tools (currently undocumented — separate small entry below).

### Document Kover and JaCoCo in README (quick win)

`--coverage-tool` accepts `kover`, `jacoco`, or `none` (current default `kover`). README never mentions either tool by name — only references "coverage" generically. New users land on the README, see "coverage" with no signal that JaCoCo is supported, assume Kover-only or look for `--jacoco`-style flags. Quick fix: a 1-paragraph "Coverage tools" subsection under "Usage" naming both tools, the default, and the flag.

Estimated effort: 15 min. Probably bundle into the next docs PR.

### macOS bats end-to-end validation (deuda from PR #30)

PR #30 added `macos-latest` to the CI matrix for `build` (vitest) and `installer-e2e` (install.bats E2E only). The wider `tests/bats/` suite is intentionally skipped on macOS because the bats step **hung** for 12+ minutes on macos-latest in the first run (cancelled to avoid burning runner minutes). Suspected culprit: `tests/bats/test-concurrency.bats` (v0.3.8 lockfile work) — its concurrency tests fork a stub `gradlew` that `sleep 30`, send SIGINT to the parent, then `wait $cli_pid`. BSD signal handling on macOS may not deliver SIGINT to forked sub-processes the same way Linux does, leaving `wait` stuck.

Investigate steps:

1. Re-enable bats on macOS in `build` matrix with a `timeout 60 npx bats tests/bats/...` wrapper so the hang fails fast with logs identifying the specific test.
2. Run that specific test on a macOS machine (not GH Actions) to reproduce locally.
3. Likely fix in the test: `kill -TERM` after `kill -INT` with a short `wait` timeout; or move the test to a Linux-only `if` guard if the underlying CLI signal handling is genuinely platform-different (unlikely — Node's `spawnSync` should handle signals consistently).

Side benefit of the investigation: would surface whether v0.3.8's lockfile + signal-handling code has any real macOS bug, not just a test-only artifact.

Estimated effort: 1–2h investigation + likely a 1-line test fix once the hanging test is identified.

### Adapt CLI to project's Gradle config (workers / parallel / cache)

`kmp-test parallel` always injects `--parallel --continue` into the gradlew invocation, regardless of the consumer project's `gradle.properties`. Some projects deliberately turn parallel execution off (`org.gradle.parallel=false`), cap workers (`org.gradle.workers.max=2`), or disable build cache (`org.gradle.caching=false`) — because their build has shared state that breaks under parallel, or they're on a constrained box. Today we override silently and the user has no signal we did so.

Today's escape hatches:
- `--max-workers <N>` exists; passing `1` effectively serializes per Gradle's worker model (does NOT remove `--parallel` though, so configuration phase still parallelizes).
- `FRESH_DAEMON` env var stops daemons.
- Nothing for caching, configure-on-demand, or generic gradlew arg passthrough.

**Three levels, ship cheapest first:**

1. **Doctor surfacing (~30min)** — `kmp-test doctor` reads `<project>/gradle.properties` (and `~/.gradle/gradle.properties`) and prints the resolved values for `org.gradle.parallel`, `org.gradle.workers.max`, `org.gradle.caching`, `org.gradle.daemon`, `org.gradle.jvmargs`, `org.gradle.configureondemand`. Pure diagnostic — surfaces mismatches between project intent and what the CLI is about to do. Adds a `gradle_config{}` section to `--json` output. Zero behavior change.
2. **Generic pass-through (~1h)** — `--gradle-args "..."` global flag that appends arbitrary tokens to the gradlew invocation. Lets any agent or user inject `--no-parallel`, `--no-build-cache`, `--max-workers 1`, `-Pflag=value`, etc. Documented as an escape hatch — the CLI still has its opinionated defaults. Lower precedence than dedicated flags.
3. **Auto-detect + respect (~2-3h)** — read `gradle.properties` at startup; if `org.gradle.parallel=false`, drop the `--parallel` injection; if `workers.max` is set, do not pass `--max-workers` unless explicitly overridden on the CLI; if `caching=false`, don't fight it. Most invasive — changes default behavior. Needs migration note ("`kmp-test parallel` no longer always parallelizes — set `org.gradle.parallel=true` if you want the previous behavior, or pass `--max-workers >1`").

**Why this matters for agents.** An agent calling `kmp-test parallel` against a repo it didn't build doesn't know whether the project supports parallel execution. Today the CLI happily parallelizes a project where Gradle would normally have refused — sometimes that's a fast pass, sometimes it's a flaky failure pinned on the agent. Surfacing the mismatch (level 1) buys most of the value at minimal risk; auto-respect (level 3) eliminates the foot-gun entirely but is a behavior change.

**Out of scope.** Per-task gradle.properties (init.gradle, root vs subproject overrides) — too project-specific. Java-toolchain auto-detection (already partial via `--java-home`).

Estimated effort per level above. Recommend shipping level 1 + 2 as a single v0.4.x DX bundle alongside the existing "DX/UX parity" entry below; level 3 deserves its own release with migration notes.

### Integrate with Google's `android` CLI for agents (skills system)

Google ships an [`android` CLI for AI agents](https://developer.android.com/tools/agents/android-cli) that covers project create/describe/run/emulator but has no test subcommand. It also ships a pluggable `skills` subsystem (`android skills`, `android init` for skill registration). Idea: package `kmp-test` as a discoverable `android` skill so any agent using the official CLI auto-finds the testing slice without separate setup. Investigate the skill manifest format, registration command, what context is passed to the skill, and whether the skill can shell out to `kmp-test --json` cleanly.

Estimated effort: 2–3h investigation + ~1h to ship a minimal skill if the format is straightforward. Win: makes kmp-test a first-class citizen for agents using Google's tooling, zero integration work on the agent side.

### DX/UX parity audit — borrow good ideas from Google's `android` CLI

Google's [`android` CLI for agents](https://developer.android.com/tools/agents/android-cli) is a well-thought-out agentic toolbelt. Sister entries above already cover **integration** (ship a `kmp-test` skill, use `android describe` for discovery). This one is about **inspiration** — patterns kmp-test should consider adopting from their UX, not from their plumbing.

Audit items (priority-ranked):

**High value — small ship slices**

- **`--debug` / `--release` flags** (from `android run`): explicit build-variant selection across subcommands. Currently only `kmp-test android` has `--flavor`; add a global `--variant <debug|release>` (or paired `--debug`/`--release` switches) that propagates to the gradle invocation. The android CLI's pattern is the obvious idiom; agents already know it.
- **`kmp-test describe`** subcommand mirroring `android describe`: emit project metadata as a single JSON document (modules, test tasks per module, coverage tool detected, dependency graph hints) **without** running anything. Lets an agent plan, then execute — same shape as `android describe`'s JSON of build targets + APK paths. Today an agent has to either guess module names or run `--module-filter '*' --dry-run --json` and parse the plan.
- **`kmp-test info`** (lighter sibling to `doctor`): print environment paths/versions only (Node, JDK, gradlew, ADB), no PASS/WARN/FAIL judgments. `doctor` is for diagnosis; `info` is for "tell me where things are." Android CLI ships both.
- **`kmp-test update`** (from `android update`): re-run the install script for the latest GitHub release, idempotent. Currently users have to remember the curl one-liner.

**Medium value — quality-of-life**

- **`--sdk` / `--java-home` hoisted to CLI**: scripts already accept `--java-home`; surface it as a global CLI flag (matches `android --sdk=PARAM`). Useful when an agent needs to test against a specific JDK without env-var dance.
- **`--capture-on-fail` for `kmp-test android`**: take a screenshot + dump UI state when an instrumented test fails (Android CLI's `screen` + `layout` together). Agentic-friendly artifact — the failure context an agent gets to act on.
- **Subcommand grouping**: android groups by topic (`emulator <subsub>`, `sdk <subsub>`, `skills <subsub>`). Our flat namespace (parallel/changed/android/benchmark/coverage/doctor) is fine for 6 commands but won't scale past ~10. Decide now whether to migrate to verb/noun (`kmp-test run parallel`, `kmp-test run changed`, `kmp-test diagnose doctor`, `kmp-test diagnose info`) before more commands accumulate. Probably defer until 8+ commands.

**Lower priority — speculative**

- **`kmp-test docs`** (from `android docs`): opens the README anchor or specific section in `$BROWSER` / man-page. Marginal win when `--help` already exists.
- **`kmp-test devices`** (from `android emulator` + `screen`): wrap ADB device-listing/management. Probably out of scope — `adb devices` is fine.
- **`kmp-test sdk`** (from `android sdk`): install/check SDK packages. Out of scope — `doctor` already flags missing tooling.

Estimated effort per item: 1-3h each except the subcommand-grouping refactor (full day if done with backwards compat). Recommend shipping the high-value 4 (`--debug`/`--release`, `describe`, `info`, `update`) as a single v0.4.0 "DX-parity" PR and leaving the rest as separate backlog candidates.

### Use `android describe` JSON as module-discovery source (pending review)

The official `android` CLI's `describe` subcommand emits a JSON document of build targets + APK paths for an Android project. Currently kmp-test does its own module discovery via bash filesystem walks (`scripts/sh/lib/script-utils.sh` etc.), which on Windows MinGW is the slow path that motivated the [concurrent-invocation safety entry](#concurrent-invocation-safety-multi-agent-scenarios) above and is the suspect for the 10+ min hang against `dipatternsdemo` (43-module project). Consider replacing or augmenting the bash discovery with an `android describe` invocation when the CLI is on PATH — gets the official Google schema, faster on Windows.

Open questions: (1) does `describe` cover KMP-only (non-Android) modules, or only AGP-rooted ones? (2) what's the schema stability guarantee, esp. for multi-module multi-target KMP? (3) fallback path when `android` CLI isn't installed — keep bash discovery as default, opt-in via `--use-android-describe` flag.

Estimated effort: 3–4h research + refactor in `scripts/sh/lib/`. Pending review on (1) above before committing — if `describe` doesn't enumerate KMP non-AGP modules it's not a drop-in replacement.

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

**Three tiers — Tier 1 shipped in v0.3.8 (2026-04-26):**

1. **Cheap hardening (~1h)** — ✅ **DONE in v0.3.8**: PID-suffixed `TEMP_LOG`; run-id `YYYYMMDD-HHMMSS-PID6` versioned report filenames + legacy mirror; advisory lockfile at `<project>/.kmp-test-runner.lock` with `{schema, pid, start_time, subcommand, project_root, version}` JSON; `--force` global flag bypasses a live lock; stale-lock reclaim (PID dead) is automatic; SIGINT/SIGTERM/uncaughtException handlers clean up. `--json` mode surfaces `errors[].code = "lock_held"`. Doctor + dry-run skip the lock.
2. **Audit + docs (~30min)** — partly done (Tier 1 ships with `docs/concurrency.md` stub); full collision matrix (subcommand × resource × outcome) still queued.
3. **Opt-in isolation (~3-4h)** — queued: `--isolated` global flag → injects `--project-cache-dir <tmp>` into every gradle invocation, giving each run its own `.gradle/` cache. Slow (no cache hits), but truly parallel-safe. Ideal for CI multi-agent fan-out.

Out of scope for this item: cross-host coordination (use a real lock manager), Gradle-internal concurrency tuning, or rewriting the daemon model.

### Other QUEUED ideas

- **ANSI color** — auto-detect TTY, plain output when piped
- **Maven Central publish** for Gradle plugin — currently GitHub Packages only; needs Sonatype account + signing keys
- **iOS/macOS TestKit** matrix — needs Mac hardware in CI
- **VitePress/MkDocs docs site** — separate consumer-facing docs beyond README

---

## DONE (recent — newest first)

- 2026-04-26: **v0.3.8** — Tier 1 concurrent-invocation safety. Advisory lockfile at `<project>/.kmp-test-runner.lock` (`{schema:1, pid, start_time, subcommand, project_root, version}` JSON); `--force` global flag bypasses live lock; stale-PID reclaim is automatic; SIGINT/SIGTERM/uncaughtException cleanup hooks; `--json` mode emits `errors[].code = "lock_held"`. Run-id naming `YYYYMMDD-HHMMSS-PID6` for `coverage-full-report-<id>.md`, `benchmark-report-<id>.md`, and `gradle-parallel-tests-<id>.log`; legacy stable filenames retained as a last-finished mirror so existing consumers keep working. Tests: 121 vitest (96% line coverage on cli.js, +30 lockfile-specific cases) + 12 bats (`tests/bats/test-concurrency.bats`, 3 skipped under MinGW due to MSYS PID semantics — Linux CI runs all of them) + 10 Pester 5 (`tests/pester/Concurrency.Tests.ps1`). `doctor` and `--dry-run` skip the lock since they're read-only.
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
