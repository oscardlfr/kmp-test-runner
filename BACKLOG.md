# Backlog

> Active and queued tasks for `kmp-test-runner`. Newest first. Read `CLAUDE.md` first for repo state + gitflow rules.

---

## ACTIVE

### v0.6.2 / pre-v0.7 — Update README to reflect post-v0.6.x feature surface

The README has not been touched since v0.5.x. v0.6.0 + v0.6.x added significant surface that should be documented before v0.7 (where API breaks may land):

- **v0.6 Bug 2** — `kotlin("android")` + `com.android.test` plugin detection
- **v0.6 Bug 3** — JS / Wasm source-set + task support (`webTestTask` field)
- **v0.6 Bug 5** — `--no-coverage` alias
- **v0.6 Bug 6** — CONVENTION vs SELF coverage hint discrimination
- **v0.6.x Gap 1** — `errors[].code = "no_summary"` discriminator
- **v0.6.x Gap 2** — Multi-JDK auto-select catalogue + `--java-home` / `--no-jdk-autoselect` flags + `kmp-test doctor` "JDK catalogue" surface
- **v0.6.x Gap 3** — `alias(libs.plugins.<X>)` resolution via version catalogue (+ heuristic fallback)
- **v0.6.x Gap 4** — Per-module convention-plugin coverage detection (heuristic-first via class name)

Two slots:

1. **v0.6.2 (light pass)**: add a "What's new in v0.6.x" section + flag table (`--java-home`, `--no-jdk-autoselect`, `--no-coverage`). Update the `kmp-test doctor` example output to show the new "JDK catalogue" row. Estimate: 30-45min.
2. **Pre-v0.7 (full revamp)**: regenerate the entire README structure — quick-start, install paths (npm + Gradle plugin + GH Release archives), CLI surface table, decision matrix for `parallel` vs `changed` vs `android` vs `benchmark` vs `coverage`, troubleshooting (mismatched JDK, no coverage data, locked daemon, etc.), and a "How the project model works" diagram. Estimate: 2-3h.

The pre-v0.7 pass is critical — v0.7 introduces iOS support (Bug 4 deferred) which is a major surface change and the README must be coherent for new users.

### v0.6.2 — Refine `no_summary` discrimination into specific sub-codes (surfaced 2026-04-30 v0.6.x stress test)

`no_summary` (added in v0.6.x Gap 1) is a defensive catch-all for "the script ran but produced no recognizable test/build summary". Phase J stress test against 9 ex-AMBER-JDK projects post-Adoptium-11-install surfaced 3 distinct real-world causes that all collapse to `no_summary` today:

1. **Project has no test source sets** — Nav3Guide-scenes, kmp-production-sample-master. Wrapper emits `[ERROR] No modules found matching filter: *` after `[SKIP] composeApp (no test source set)`. Currently `no_summary`.
2. **Build fail before tests** (gradle compile error / dep resolution failure) where the script doesn't propagate `BUILD FAILED` to stdout — KMedia-main pattern.
3. **Filter excludes everything** — `--changed-since` with zero changes, `--test-filter` not matching any class. Currently `no_summary`.

Refinements (each ~30-60min, all additive — no API break):

- **Gap 1.1**: discriminator for `[ERROR] No modules found matching filter` → `code: "no_test_modules"`. Reads stdout for the wrapper's literal string.
- **Gap 1.2**: parse `[SKIP] <module> (no test source set)` lines into `state.skipped[]` array on the envelope so agents can suggest `--include-untested`.
- **Gap 1.3**: when `state.errors` already has a discriminated code AND the parse-gap fallback would also fire, prefer the specific code (don't double-emit `no_summary`).
- **Gap 1.4** (out of scope without protocol break): the wrapper script could emit a structured `[KMP_TEST_EXIT_REASON] <code>` line that the parser captures verbatim. Defer to v0.7+ when we control both ends.

Wide-smoke evidence files (already on disk locally): `.smoke/stress-J/OFFICIAL_PROJECTS_*.json` for the 3 Phase J reds.

Estimated effort: 2-3h total for Gaps 1.1-1.3. Patch bump (no API break, additive codes/fields).

### Multi-JDK auto-selection per project (research — surfaced 2026-04-30 v0.6 wide smoke)

When running `kmp-test parallel` against many KMP projects in one session, each project may require a different JDK (KaMPKit JDK 11 / nav3-recipes JDK 11 / Confetti JDK 17 / shared-kmp-libs JDK 21). Today the user must restart the shell with a different `JAVA_HOME` between projects, or pass `--ignore-jdk-mismatch` to bypass the gate. Wide-smoke surface 2026-04-30: 4/20 surveyed projects exited 3 with `jdk_mismatch` because the host's `java -version` was 21.

Investigation questions:
1. **Detect installed JDKs** — common locations on each platform (Eclipse Adoptium / Zulu / Microsoft Build / SAP / `/usr/libexec/java_home -V` on macOS / `update-alternatives --list java` on Linux / `where java` + Registry on Windows). Build a catalogue at startup.
2. **Match required JDK** — when `findRequiredJdkVersion` returns N and the catalogue has a matching install, use it for the spawn (export `JAVA_HOME=<path>` to the gradle subprocess). Bypass the gate.
3. **Surface in `kmp-test doctor`** — list installed JDKs + show which one would be chosen for the current project.
4. **`--java-home <path>`** flag already exists in `scripts/{sh,ps1}` (added v0.5.1 Bug F). Hoist it to the CLI layer so users can override the auto-detected pick.
5. **Per-project config presets** (sister entry below) could pin a specific JDK path — useful when auto-detection picks the wrong major (e.g. project tests fail under JDK 21 even though it satisfies the toolchain version).
6. **`gradle.properties` precedence** — `org.gradle.java.home=<path>` already bypasses the gate; the auto-selection should respect this when present.

Estimated effort: ~3-4h for catalogue + match + doctor surfacing. Probably v0.6.x or v0.7.

### Per-project config presets (post-v0.5.1 idea — needs design)

The CLI currently expects each invocation to carry every flag verbatim — which becomes painful when running it against several real projects with different requirements. Examples surfaced 2026-04-27 while validating v0.5.1:

- One KMP project compiles to `JvmTarget.JVM_21` → benchmarks need `JAVA_HOME=jdk21` to run; without it you hit `UnsupportedClassVersionError` (class file v65 vs runtime v61).
- Another personal Android-only project pins `JavaVersion.VERSION_11` for `compileOptions` → fine on either JDK 17 or 21, but its benchmark module wants `--platform android --config smoke --test-filter '*Scale*'`.
- A third heterogeneous KMP project on a different machine pins JDK 17 toolchain and wants `--coverage-tool none` (no kover/jacoco plugin applied per-module).

Today every `kmp-test ...` invocation has to carry this knowledge as flags + env vars, by memory, every time.

**Proposal sketch** (not yet a phase plan):
- `~/.kmp-test/config.json` (or `.kmp-test.json` in project root) keyed by project name or git-remote, with a per-project preset:
  ```json
  {
    "projects": {
      "shared-kmp-libs": {
        "java_home": "C:/Program Files/Zulu/zulu-21",
        "benchmark": { "config": "main" }
      },
      "<personal-android-only>": {
        "benchmark": { "platform": "android", "config": "smoke", "test_filter": "*Scale*" }
      }
    }
  }
  ```
- `kmp-test benchmark --project shared-kmp-libs` reads the preset and applies env + flags.
- Or auto-detect by `cwd` when no `--project` is passed.
- Doctor extension (Bug F in v0.5.1 Phase 4) could write the JDK requirement back into the config when it detects `jvmTarget = JVM_N` so the next invocation Just Works.

Open questions:
- Schema validation — JSON Schema, or just permissive merge?
- Precedence vs explicit CLI flags — flags always win? Always lose? Configurable per-key?
- Security — `java_home` overrides `$JAVA_HOME`; do we let a checked-in `.kmp-test.json` mutate the spawn env, or only the user-global one?
- Would this benefit from an `init` subcommand that templated the config from observed project state (`jvmTarget`, plugins applied, modules with tests)?

Estimated effort: ~6–10h once the schema is designed. Probably a v0.6 milestone scope, not v0.5.1.

### v0.5.2 candidates _(SHIPPED 2026-04-30 — see DONE section)_

All five gaps shipped in v0.5.2 (PRs #63 / #64 / #65 / #66 / #67). One scope reduction: Gap A's deletion phase (removing `detect_coverage_tool` / `get_coverage_gradle_task` from sh + ps1) was deferred to a future milestone. The pre-work (build-logic detection + coverage-task prediction in JS) shipped, which closed the practical gap without removing the fallback safety net. See DONE section below for closure record.

- **Bug H — `gradle_timeout` exit code consistency** _(DONE in PR #55 step 9, was an open gap)_ — wrapper-script keying-on-bash-exit got 1 (TEST_FAIL) while the JSON envelope reported `exit_code: 3` (ENV_ERROR). Now both agree on 3.

### Side-issue documented in shared-kmp-libs (NOT a kmp-test-runner bug)

- `benchmark-storage` with `kmp-test benchmark --config main --platform jvm` on JDK 21 Windows produces `org.gradle.launcher.daemon.client.DaemonDisappearedException`. The CLI handles this cleanly — emits structured `errors[].code = "module_failed"` envelope. Likely root cause is **MMKV native lib + kotlinx-benchmark + Gradle 9.1 + JDK 21 + Windows** combo (the `BenchmarkMmkvAdapter` class crashes the daemon JVM during benchmark fork). To fix in **shared-kmp-libs side**: try `--no-configuration-cache`, increase `org.gradle.jvmargs=-Xmx8g`, isolate the failing benchmark, or update kotlinx-benchmark plugin version. Other benchmark modules (V13: `*benchmark-network*`) run cleanly with the same setup.

### Deferred

- **README hero banner** — hand-drawn banner from 2026-04-27 has typos (`CONTEXTUAUZATION`, `"savings_rae"`) and informal style that may not fit the "professional infra tool" positioning. Postponed past v0.5.0 pending a cleaner regeneration. File on user's Desktop: `FondoKMPtestRunner.jpeg`.

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

**Reference projects.** Stick with `shared-kmp-libs` for v0.4 (consistent variables — same module count, same deps, same JDK). Other personal KMP projects are tempting cross-validation but at least one larger one (43 modules) hung on Windows MinGW already (per current docs) — adding a third project doesn't validate the claim more, it just adds tokens spent.

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

The official `android` CLI's `describe` subcommand emits a JSON document of build targets + APK paths for an Android project. Currently kmp-test does its own module discovery via bash filesystem walks (`scripts/sh/lib/script-utils.sh` etc.), which on Windows MinGW is the slow path that motivated the [concurrent-invocation safety entry](#concurrent-invocation-safety-multi-agent-scenarios) above and is the suspect for the 10+ min hang against a 43-module personal project. Consider replacing or augmenting the bash discovery with an `android describe` invocation when the CLI is on PATH — gets the official Google schema, faster on Windows.

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

- 2026-04-30: **v0.6.0** — "Real-world diversity hardening." Five bugs surfaced from v0.6 smoke survey against 17 official KMP projects (KaMPKit, Confetti, nowinandroid, Compose Multiplatform html, nav3-recipes, DroidconKotlin, etc.); Bug 4 (iOS support) deferred to v0.7. Suite at release: ~353 vitest + ~175 bats + ~157 Pester (+27 / +16 / +10 over v0.5.2 baseline). Real-world re-validated against KaMPKit + Confetti + nowinandroid + compose-multiplatform/html (5/5 expected behaviors confirmed):
  - **Bug 1 (#73)** — `--dry-run` no longer blocks on JDK toolchain mismatch. Pre-flight `preflightJdkCheck` now skipped when `dryRun === true`. 13/17 projects in the smoke survey hit this — `--dry-run` is for plan inspection, not run validation, so gating it on a JDK mismatch defeats the purpose. Real runs (`parallel`/`changed`/etc.) still gate. Smoke validated against KaMPKit (JDK 11) on JDK 17 host: dry-run exits 0 with plan instead of `jdk_mismatch` error.
  - **Bug 5 (#74)** — `--no-coverage` alias for `--coverage-tool none`. Users naturally reach for `--no-coverage` based on most-CLI conventions; pre-fix neither sh nor ps1 scripts wired it up — only `--coverage-tool none` worked. New `expandNoCoverageAlias` helper expands at the CLI normalization layer BEFORE flag translation, so `kmp-test parallel --no-coverage` works on both Linux and Windows. If `--coverage-tool` is already explicit, user choice wins (conservative). Smoke validated against KaMPKit: PS1 spawn args now contain `-CoverageTool none`, not the rejected `-NoCoverage`.
  - **Bug 2 (#75)** — `analyzeModule` now classifies `com.android.test` and `kotlin("android")` modules as Android. Pre-fix the AGP plugin pattern only matched `library|application`; `com.android.test` modules (Confetti's `androidBenchmark`) fell through to `type=unknown`. New `hasKotlinAndroidPlugin` regex catches both `kotlin("android")` and `id("org.jetbrains.kotlin.android")`. Real-world validated against Confetti: `androidApp` AND `androidBenchmark` now both `type=android`. Out of scope: version-catalog `alias(libs.plugins.<...>)` form (covers nav3-recipes / Confetti's modern modules — separate v0.7 scope).
  - **Bug 6 (#76)** — `detectBuildLogicCoverageHints` distinguishes CONVENTION vs SELF kover/jacoco signals. Pre-fix the naive `\bjacoco\b` scan over all build-logic files false-positived on nowinandroid (`build-logic/convention/build.gradle.kts` only NAMES jacoco-related convention plugins via `register("...Jacoco...")` blocks — but jacoco isn't applied for build-logic itself or for consumer modules from this file). Discrimination now uses path heuristic + registration-noise stripping: files under `build-logic/<X>/src/main/...` → CONVENTION; files outside → SELF (after stripping `register(...) { ... }`, `implementationClass = ...`, `id = libs.plugins.<...>`, `pluginId = ...`, `asProvider().get().pluginId`, and comments). `analyzeModule` only inherits when kind === 'convention'. Return-shape break: `{ hasKover: bool, hasJacoco: bool }` → `{ hasKover: 'convention'\|'self'\|null, ... }`. Real-world validated: nowinandroid → `hasJacoco: 'convention'` (correctly detects real `Plugin<Project>` jacoco classes under `src/main/kotlin/`); shared-kmp-libs → `hasKover: 'convention'` (continues to inherit kover for all 71 modules). Out of scope: per-module convention-plugin application detection (which modules apply `nowinandroid.android.application.jacoco`?) — needs version-catalog plugin-id mapping, separate v0.7 scope. Three CI fixtures locked under `tests/fixtures/build-logic-{convention,self,noise}-jacoco/` are loaded by both bats and Pester via `node --input-type=module -e "..."` to keep the JS classifier as the single source of truth.
  - **Bug 3 (#77)** — JS / Wasm source-set + task support in the project model. `analyzeModule` enumerates 3 additional source-set directories (`jsTest`, `wasmJsTest`, `wasmWasiTest`); `resolveTasksFor` adds `jsTest`/`wasmJsTest` as `unitTestTask` candidates AFTER the JVM ones (KMP+JS modules still pick `jvmTest`); new `webTestTask` field surfaces JS/Wasm test invocation explicitly. Sh and ps1 readers grow `pm_get_web_test_task` / `Get-PmWebTestTask`. Real-world validated against compose-multiplatform/html: `core`, `benchmark-core`, `compose-compiler-integration` all now report `sourceSets.jsTest=true` (previously these source sets weren't enumerated at all). Out of scope: actual JS test EXECUTION in CI (requires Node + browser drivers; v0.6.x follow-up). One CI fixture under `tests/fixtures/kmp-with-js/` covers both JS-only fallback (`:web-only`) and KMP+JS regression (`:kmp-multi`).
  - **Deferred to v0.7**: iOS source-set + task support (Bug 4). Adds 30% of the complexity for ~5% of KMP projects (3/17 with iosTest in survey). Requires macOS GitHub Actions runner job + Xcode integration + xcodebuild OR `gradlew iosSimulatorArm64Test` + simulator boot orchestration. Estimated 6-8h + CI hardware costs.

- 2026-04-30: **v0.5.2** — "Minor-gaps milestone." Five non-blocking follow-ups from the v0.5.1 ship cycle (Phase 4 D1+D4 deferrals + post-ship validation findings + one DX gap). Suite at release: ~326 vitest + ~159 bats + ~147 Pester (+ ~37/~14/~17 over v0.5.1 baseline). Real-world validated against shared-kmp-libs on Windows + S22 Ultra + JDK 21:
  - **Gap E (#63)** — Android `--test-filter` method-level filtering. `kmp-test android --test-filter "FQN#method"` and `--test-filter "FQN.method"` now run a single test method via AndroidJUnitRunner. cli.js splits class+method, resolves wildcards in the class part as before, recombines as `<resolvedClass>#<method>` on the wire; platform scripts (sh + ps1) detect `#` and emit BOTH `-Pandroid.testInstrumentationRunnerArguments.class=` AND `.method=` flags. Same gap closed for `kmp-test benchmark --platform android`. Smoke validated end-to-end on S22 Ultra against `:core-encryption:AndroidEncryptionServiceTest#test_encrypt_returnsBase64EncodedString` and `.test_decrypt_recoversOriginalPlaintext` (heuristic form). Tests: +13 vitest, +5 bats, +2 Pester.
  - **Gap D (#64)** — `summary.json` counter shape regression coverage. PR #54 fixed the PS1 single-item-pipeline collapse where `$modules.Count` returned hashtable-key count (5/11) instead of array length (1) on single-module runs. Bash side audited clean (`${!result_names[@]}` indexed iteration, no `${#hash[@]}` bug-pattern). New `tests/bats/test-android-summary-counts.bats` (5 tests) + `tests/pester/Android-Summary-Counts.Tests.ps1` (9 tests including a negative-guard against the bug-pattern returning) lock the contract at source level. Real-world validated during Gap E smoke run — single-module produced `totalModules:1, passedModules:1, modules.length:1`.
  - **Gap B (#65)** — JDK gate walker unification via ProjectModel fast-path. `gate_jdk_mismatch` (sh) + `Invoke-JdkMismatchGate` (ps1) now consult `pm_get_jdk_requirement` / `Get-PmJdkRequirement` first; the JS canonical walker (9-dir exclude list + depth=12) returns the MAX-of-signals into the model JSON's `jdkRequirement.min`. Legacy walkers (sh: 4 dirs unbounded, ps1: 5 dirs unbounded) preserved as fallback when model.json absent. Eliminates exclusion-list drift. Tests: +2 bats, +2 Pester.
  - **Gap C (#66)** — Cache-key SHA byte-parity across walkers AND across host platforms. JS / bash / PS1 now produce IDENTICAL SHAs for the same logical content regardless of file line endings (CRLF / LF / mixed) or runner OS. Strategy: every walker normalizes by stripping ALL `\r` then trailing `\n+` before hashing — bash uses `tr -d '\r'`, JS uses `s.replace(/\r/g, '').replace(/\n+$/, '')`, PS1 uses `-replace '\r', ''` then `-replace '\n+$', ''`. Pre-fix: Linux bash `$(cat)` only stripped LF (left stray `\r`), Windows Git Bash text-mode read collapsed CRLF→LF transparently — Linux/Windows hashes diverged. Validated against shared-kmp-libs (71 build files): `57f70e4c119d81bfd4ba8590f96025e7c3d4cfcb` on every walker. Tests: +6 vitest, +4 bats, +5 Pester (+ 1 negative guard that fixtures with same logical content but different line endings hash identically).
  - **Gap A (#67)** — Build-logic kover/jacoco detection ported into JS + coverage-task prediction in `resolveTasksFor`. New `lib/project-model.js#detectBuildLogicCoverageHints` walks `build-logic/**/*.{gradle.kts,kt}` (previously only the bash `detect_coverage_tool` scanned this location). `analyzeModule` ORs the per-module signal with the project-wide hint; `resolveTasksFor` predicts `coverageTask` from `(coveragePlugin, type)` when probe data is missing (kover+kmp → `koverXmlReportDesktop`, etc.). Closes the practical gap of "fast-path returns null when it shouldn't": shared-kmp-libs went from 0/71 to 69/71 modules with `resolved.coverageTask` populated. Tests: +16 vitest. **Scope reduction** — deletion of `detect_coverage_tool` / `get_coverage_gradle_task` from sh + ps1 deferred to a future milestone since the legacy chain is still load-bearing for projects without a model.json (no probe + no model = legacy file scan is the only detection path). The pre-work alone closed the user-visible gap.

- 2026-04-29: **v0.5.1** — "Real-world validation hardening, round 2 + Phase 4 ProjectModel refactor". Closes 11 bugs surfaced when v0.5.0 was tested against (a) a 13-module Android-only Gradle 9 project on macOS and (b) `shared-kmp-libs` on Windows + S22 Ultra physical device + JDK 21:
  - **Bug G (#52)** — `--json` envelope now surfaces real signal for `android` + `benchmark` failures. `parseScriptOutput` dispatches per-subcommand (android JSON SUMMARY, benchmark `[OK]/[FAIL]` lines + Result tally, parallel/changed/coverage legacy). New `errors[].code` discriminators (`task_not_found`, `instrumented_setup_failed`, `unsupported_class_version` w/ `class_file_version` + `runtime_version` fields, `module_failed` w/ `log_file`/`logcat_file`/`errors_file` paths). New top-level `benchmark` envelope field `{config, total, passed, failed}`. PS1 parity for benchmark per-task lines.
  - **Bug F (#52)** — JDK toolchain pre-flight gate detects three signals: `jvmToolchain(N)`, `JvmTarget.JVM_N`, `JavaVersion.VERSION_N`; takes MAX. Was: only `jvmToolchain(N)` matched, so projects pinning `jvmTarget = JVM_21` in build-logic without a toolchain crashed at runtime instead of being blocked pre-flight. Function renamed `findRequiredJdkVersion`. SH/PS1 parity.
  - **`--test-filter '*Foo*'` substring resolution (#52)** — wildcards now interpret as wildcards: `*Scale*` → `ScaleBenchmark`. Was: regex word-boundary failed when the next char was a word char.
  - **Bug B' (#51)** — `kmp-test android` no longer hardcodes `connectedDebugAndroidTest`. Probe-based selector picks the first available from `connectedDebugAndroidTest` → `connectedAndroidTest` → `androidConnectedCheck` (KMP `androidLibrary{}` DSL umbrella). New `--device-task` override flag. New `scripts/{sh,ps1}/lib/gradle-tasks-probe` with content-keyed cache at `<project>/.kmp-test-runner-cache/tasks-<sha1>.txt`.
  - **Bug B'' (#51)** — `kmp-test parallel --coverage-tool auto` no longer invokes `jacocoTestReport` on modules that don't have the plugin applied. Probe verifies task existence; emits `[SKIP coverage] <module>` and proceeds with tests only.
  - **Bug E (#51)** — `[OK] Full coverage report generated!` no longer appears with 0% coverage. New `[!] No coverage data collected from any module …` banner; `coverage.modules_contributing` integer + `warnings[].code = "no_coverage_data"` in `--json`.
  - **Bug C' (#51)** — Gradle 9 deprecation routing now covers the coverage-gen pass too (was test-execution-only). Shared `gate_gradle_exit_for_deprecation` (sh) + `Invoke-GradleExitDeprecationGate` (ps1) helper. `warnings[].context` field disambiguates `tests` / `coverage` / `shared coverage` passes; multiple notices in one run all surface as separate warnings.
  - **Bug Z (#53)** — `--json` mode hung indefinitely on Windows when the gradle daemon survived the script exit and held Node's pipe handles open. Fix: redirect child stdout/stderr to temp file descriptors via `fs.openSync` instead of buffered pipes (Windows + jsonMode only). 15+ min hang → 10s envelope.
  - **Bug H (#53 + Phase 4 step 8 in #55)** — `./gradlew` invocations had no watchdog; a hung daemon zombie'd the CLI forever. Fix: `spawnSync` now passes `timeout: KMP_GRADLE_TIMEOUT_MS` (default 30 min) plus `killSignal: 'SIGTERM'`. On timeout, the CLI emits structured `errors[].code = "gradle_timeout"`. Bridges BOTH POSIX SIGTERM and Windows ETIMEDOUT paths. Exit 3 (ENV_ERROR).
  - **Probe-cache regex fix (#54)** — `module_has_task` / `module_first_existing_task` (sh + ps1) now match real `gradlew tasks --all` output (`module:task` with no leading colon). Was: needle had a leading colon that never matched. Fixture format also realigned to gradle's actual output.
  - **PS1 single-item-pipeline collapse (#54)** — `run-android-tests.ps1` summary counts wrapped in `@(...)` to force array semantics. Was: `summary.json: { totalModules: 5, passedModules: 11, modules.length: 1 }` because `Where-Object` results collapsed to a hashtable and `.Count` returned the number of HASHTABLE KEYS instead of the array length.
  - **Phase 4 ProjectModel consolidation refactor (#55)** — single canonical introspector `lib/project-model.js` builds a JSON ProjectModel JSON file at `<project>/.kmp-test-runner-cache/model-<sha1>.json`. Sh and ps1 readers parse it via python3 / `ConvertFrom-Json`; legacy detection runs unchanged when the model is absent. Migrated call-sites: `findRequiredJdkVersion`, `module_has_test_sources`, android device-task selection, coverage-task selection — all delegate to `pm_get_*` / `Get-Pm*` first. 10 atomic commits + 47 new tests. Future detection bugs become a one-place fix.
  - Suite at release: **297 vitest + ~110 bats + ~99 Pester** (was 246 + 87 + 74 at v0.5.0). Coverage 95.84% lines / 84.03% branches on `lib/**/*.js`.
  - Real-world validation against shared-kmp-libs (Win + S22 Ultra + JDK 21): V8 (android tier 1 with model-*.json), V10/V12-real (parallel cold + warm), V13 (benchmark `--config main --platform jvm` happy-path 22s 1/1 passed), V9 (Bug H ETIMEDOUT structured envelope). Coverage report: 95.1% TOTAL on core-encryption modules.

- 2026-04-27: **v0.5.0** — "Real-world Mac validation hardening." Four production bugs surfaced on macOS running v0.4.1 against a 20-module Android-only KMP project, all bundled into one milestone:
  - **Bug A (#43)** — JDK toolchain mismatch becomes BLOCKING by default. Was: warning printed and script continued, then tests failed downstream with `UnsupportedClassVersionError`. Now: exits 3 with a per-OS `JAVA_HOME` hint; `--ignore-jdk-mismatch` / `-IgnoreJdkMismatch` downgrades to WARN; `gradle.properties` `org.gradle.java.home` bypasses the check (gradle's explicit override wins). 12 vitest + 9 bats + 6 Pester. Shared helpers `scripts/sh/lib/jdk-check.sh` + `scripts/ps1/lib/Jdk-Check.ps1`.
  - **Bug B (#44)** — modules without test source sets cause silent failures + misleading reports. Was: script invoked `:module:jacocoTestReport` blindly; api/build-logic modules failed with "task not found" but final output said `[OK] Full coverage report generated!` with 0% coverage. Now: auto-skip modules with no `src/*Test*` directory (9 KMP/Android source-set variants checked); `--exclude-modules "*:api,build-logic"` for explicit exclusion (matches `--module-filter` syntax); `--include-untested` to opt out of the auto-skip. 4 vitest + 10 bats + 9 Pester. Shared helper `module_has_test_sources` in `script-utils.sh`.
  - **Bug C (#46)** — Gradle 9 deprecation noise lumped into `errors[]`. Was: `[!]` prefix indistinguishable from real warnings; `BUILD FAILED` from the deprecation pile ended up in `errors[]`. Now: distinct `[NOTICE]` prefix (sh + ps1); JSON envelope grows `warnings: [{code: "gradle_deprecation", gradle_exit_code, tasks_passed}]`; `BUILD FAILED` suppressed in `errors[]` when paired with the deprecation notice; PowerShell script gains the 3-branch JVM-error/deprecation/per-module logic that bash already had. 10 vitest + 4 bats + 5 Pester.
  - **Bug D (#47)** — installer "installed successfully" but `kmp-test` not on PATH. Was: `~/.zshrc` updated but no `source` hint; broken outright for fish (wrote bash-syntax to `~/.profile`). Now: install.sh detects `$SHELL` and writes the right rc file with the right syntax (zsh / bash / fish via `set -gx PATH` to `~/.config/fish/config.fish` / sh fallback); per-shell hint shows both literal `export`/`set` line AND `source <rc-file>` shortcut. install.ps1: clarified that `$env:PATH` is already updated for the current session. 6 bats E2E (incl. idempotent re-run).
  - **Docs (#45)** — README gains "Heterogeneous projects (modules without tests)" + "JDK toolchain mismatch" sections; flag-reference table + exit-code row updated; `errors` vs `warnings` distinction documented in agentic section.
  - Suite totals at release: **221 vitest + 87 bats + 74 Pester**. README banner deferred per design decision.

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
