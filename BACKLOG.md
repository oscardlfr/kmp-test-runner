# Backlog

> Active and queued tasks for `kmp-test-runner`. Newest first. Read `CLAUDE.md` first for repo state + gitflow rules.

---

## ROADMAP (locked 2026-05-05 — user-decided buckets)

> **Status (2026-06-07):** the v0.9 + v0.10 buckets below are ✅ **RELEASED** and kept for traceability (not open work). Current published version is **v0.12.0** — v0.11.x + v0.12.0 shipped as discrete PRs, not new milestone buckets. The live near-term queue is "📋 QUEUED follow-ups" further down.
>
> Milestone view of the v0.9 / v0.10 buckets (now released — see Status above). Order within each milestone was **load-bearing**: features land FIRST, validation gates next, token-cost re-measurement after that, README refresh LAST (right before tagging the release). This applied uniformly to v0.9 and v0.10. Detailed entries below; search by title.
>
> **Hard rule**: Claude sessions cannot create v0.11 or move items to v1.0 without explicit user consent. See `CLAUDE.md` "Project conventions" + memory `feedback_release_milestone_decisions.md`.

### v0.9 — minor (locked 2026-05-05) — ✅ RELEASED 2026-05-09

1. ✅ **parallel parity-gap (6 flags)** — DONE 2026-05-05 (v0.9 step 1; CHANGELOG [0.9.0]). `--clear-data`, `--auto-retry`, `--device <serial>`, `--flavor <name>`, `--device-task <name>`, `class=<FQN>#<method>` filter shape. ~3-4h. See entry "v0.9 — parallel parity gap" below.
2. ✅ **`--gradle-args` passthrough** — DONE 2026-05-05 (v0.9 step 2; CHANGELOG [0.9.0]). Tier 2 of "Adapt CLI to Gradle config". ~1h. See entry "Adapt CLI to project's Gradle config" Tier 2.
3. ✅ **DX-parity bundle** — DONE 2026-05-05 (v0.9 step 3; CHANGELOG [0.9.0]). global `--variant`, `kmp-test describe`, `kmp-test info`, `kmp-test update`. ~4-8h. See entry "DX/UX parity audit" — high-value 4 items.
4. ✅ **Concurrency Tier 3 `--isolated` flag** — DONE 2026-05-05 (v0.9 step 4; CHANGELOG [0.9.0]). opt-in `--project-cache-dir <tmp>` per run. ~3-4h. See entry "Concurrent-invocation safety" Tier 3.
5. ✅ **Cross-platform parity check in CI** — DONE 2026-05-06 (v0.9 step 5; CHANGELOG [0.9.0]). flag matrix audit + envelope schema snapshot + README ↔ code drift detection + platform-behaviour matrix. ~4-5h. New entry below.
6. ✅ **Buildable cross-platform E2E fixture (build only, NO CI matrix)** — DONE 2026-05-06 (PR #151 / `f296d21` on develop). Synthetic KMP fixture under `tests/fixtures/kmp-cross-platform-e2e/` with `:sample` exercising `jvm()` + `js(IR)` + `wasmJs` + `iosX64`/`iosSimulatorArm64`/`iosArm64` + `macosArm64` + `androidLibrary { withHostTestBuilder { } }`. Pinned Kotlin 2.3.20 / AGP 9.0.1 / Gradle 9.1.0. Vitest 1004 → 1018 (+14 in `tests/vitest/cross-platform-fixture.test.js`). Zero new CI minutes. See L975 entry below for closure details.
7. ✅ **macOS validation gate** — DONE 2026-05-06 (PRs #153 + #154 + #155 on develop). Manual smoke driver `tools/macos-validation-gate.mjs` with 4 modes (`dry`/`probe`/`scoped`/`full`); 45-cell matrix. Probe sweep on the 3 KMP projects (in-repo fixture + the reference KMP composite project + `KaMPKit`) reports **44 PASS / 0 DRIFT / 1 SKIP**. **Wet pass** (real gradle invocations across jvm/desktop/jsTest/wasmJsTest/iosSimulatorArm64Test/macosArm64Test/testAndroidHostTest, plus `kmp-test android` instrumented on a connected Samsung S22) executed real tests on real hardware — surfaced **3 inline-fixed bugs** (gradlew exec-bit on the v0.9 fixture, parallel-orchestrator hybrid-plugin gate, android-orchestrator parseTestCounts new-plugin format). Evidence: the macOS gate summary + the macOS gate wet-results notes (PR #155). See L372 entry below for closure details.
8. ✅ **Token-cost re-measurement** — DONE 2026-05-07 (PR #<TBD> on develop). Re-ran the full matrix on a reference KMP composite project (4 gradle-backed + 2 agent-query features). `tools/measure-token-cost.js` extended with `info` + `describe` features (B+C only — no raw-gradle equivalent); `skipApproachA` + `acceptsModuleFilter` per-feature flags. New numbers committed under `tools/runs/`. Headline: coverage A=28.7M cl100k tokens (74 MB kover reports) → C=372 = **77,114× reduction**; coverage A overflows Anthropic's `count_tokens` (413 request_too_large) — even Anthropic's own tokenizer can't process raw gradle on a real KMP project. Vitest 1068 → 1078 (+10). Evidence: the v0.9 measurement notes. README prose deferred to step 9 (re-framing required, not a one-line tweak). See L412 entry below for closure details.
9. ✅ **README v0.9 refresh + CHANGELOG** — DONE 2026-05-XX (PR #<num>). Token-cost narrative re-framed against a reference KMP composite project (consumed the v0.9 measurement notes); 6 new flag rows + 3 new subcommand entries documented; canonical `class=<FQN>#<method>` filter shape documented; AI-agent envelope JSON example bumped to `version: "0.9.0"`; CHANGELOG `[0.9.0]` section assembled per-PR (steps 1–9). Vitest 1078 unchanged. v0.9.0 release ceremony (step 10) unblocked.
10. ✅ **Tag v0.9.0** — DONE 2026-05-09 (v0.9.0 released; CHANGELOG [0.9.0]). Release ceremony per the v0.8.0 / v0.8.1 pattern (intermediate develop PR + clean-cut release/main PR with `git read-tree --reset -u`).

### Pre-v0.10 — refactor train tail + polish queue (locked 2026-05-10)

> **Goal:** close the refactor train + privacy/governance gaps + cheap polish items BEFORE v0.10 feature work begins. This section is the execution queue from `develop` tip `3c0fe5e` (post privacy sweep PR #207) toward the start of v0.10. Order is **load-bearing** — Phase 1 + Phase 2 are sequential; Phase 3 / 4 / 5 can interleave with the train.
>
> Detailed entries for every item are in the body of BACKLOG.md below — search by title.

**Phase 1 — quick wins before the PR-10 train (parallel-safe, ~3-4h total, 1-2 PRs)**

1. **`tools/decouple-audit.mjs` real CI gate** — close the privacy regression class that PR #207 surfaced. New 13th required check on `develop` + `main`. ~1.5h. Detail: "💡 IDEA — `tools/decouple-audit.mjs` real CI gate".
2. **`KMP_WORKSPACE` env var docs** — `tools/README.md` + log-line on script startup. ~30 min. Detail: "💡 IDEA — `KMP_WORKSPACE` env var documentation".
3. **`'utf8'` encoding on `writeFileSync` calls** — 2 callsites in `android-orchestrator.js`. ~30 min. Detail: "💡 IDEA — Explicit `'utf8'` encoding".

**Phase 2 — PR-10 train (sequential, BLOCKING all v0.10 work)**

4. **PR-10a `refactor(orchestrators): extract result-rollup.js`** — junit-XML walks + execution summary classifier + F-1/F-2 demotion. Snapshot-safe. Wet smoke against the reference KMP composite project after merge.
5. **PR-10b `refactor(orchestrators): extract cascade-retry.js`** — per-module retry state machine. Only after 10a merged + wet smoke green.
6. **PR-10c `refactor(orchestrators): extract dispatch.js`** — per-leg gradle dispatch. Closes the split.
7. **PR-10d wet-validation gate (post PR-10)** — full 7-project × 8-subcommand matrix. Evidence in `WET-V0.10-POST-PR10.md` repo root. **BLOQUEANTE** — v0.10 #1 doesn't start until this is green. Detail: plan section "Wet-validation gate post-PR-10 (BLOQUEANTE)" in `.claude/plans/vale-ya-hemos-sacado-resilient-dusk.md`.

**Phase 3 — read-only investigation (interleavable with Phase 2)**

8. ✅ **`parseArgs` duplication INVESTIGATE + Option B** — INVESTIGATE closed 2026-05-11 with Option B picked (minimal shared layer). Option B shipped 2026-05-11: `lib/parsers/argv-constants.js` (3 frozen allowlists) + `splitGradleArgs` + orchestrator-side `expandNoCoverageAlias` in `lib/orchestrator-utils.js` + errors[] contract docstring. 5 orchestrators slimmed; vitest 1295 unchanged. Detail: "✅ SHIPPED — `parseArgs` duplication" below.

**Phase 3.5 — `lib/` reorganization (added 2026-05-10 after wet-validation gate, single PR)**

8.5. ✅ **Move `lib/*-orchestrator.js` → `lib/orchestrators/`** — DONE 2026-05-11 (PR #214 / 91b51b0 on develop). Closed the asymmetry where top-level orchestrator entry points lived in `lib/` raíz while their decomposed sub-modules already lived under `lib/orchestrators/parallel/` (PR #210). 9 files moved via `git mv` (orchestrator-utils.js + 8 *-orchestrator.js) + ~60 import-path rewrites across 27 files (9 moved + 7 lib/ callers including the audit-missed `lib/runner.js` dynamic-import block + 11 vitest files including the audit-missed `tests/vitest/orchestrator-utils.test.js`). Three follow-up inline fixes during validation: (a) `lib/orchestrators/parallel/{dispatch,cascade-retry}.js` had `../../orchestrator-utils.js` from the PR-10 sub-extraction — collapsed to `../orchestrator-utils.js` after the parent moved into the same directory; (b) `lib/orchestrators/update-orchestrator.js`'s `__dirname`-relative paths to `package.json` + `scripts/` needed a second `..` after the depth change; (c) `tests/vitest/_parity-helpers.js#SUBCOMMAND_TO_ORCHESTRATOR` constant table and `project-model.test.js`'s `lib/project/cache.js` import-shape regex both needed the new `lib/orchestrators/` prefix. Vitest 1295 unchanged. Snapshot diffs: only the pre-existing LF/CRLF noise on the 2 unrelated `__snapshots__/` files (stayed unstaged). `node tools/decouple-audit.mjs` green. End-to-end smoke (`kmp-test parallel --list-only` + `kmp-test info` on the in-repo fixture) green. Phase 4 #12 (JSDoc stubs) now unblocked.

**Phase 4 — test + doc polish (post-train, ~12-15h + measurement, 4-5 small PRs)**

9. ✅ **Coverage threshold gate** — DONE 2026-05-11 (PR #215 / cd719d0 on develop). Detail: "✅ SHIPPED — Coverage threshold gate".
10. ✅ **Bundle-size monitoring** — DONE 2026-05-11 (PR #216 / 3ce7e29 on develop). `npm pack --dry-run --json` budget gate. Detail: "✅ SHIPPED — Bundle-size monitoring".
11. ✅ **Direct unit tests for `orchestrator-utils.js` helpers** — DONE 2026-05-11 (PR #217 / 502a367 on develop). +32 direct tests across 6 helpers (stripKotlinComments, splitGradleArgs, expandNoCoverageAlias, discoverIncludedModules, readBuildFile, readPackageName). Vitest 1295 → 1327. Surfaced one inline-fixed bug: discoverIncludedModules single-arg regex didn't dedupe matches that were also inside multi-arg includes, contradicting the docstring's "deduplicated list" contract. Detail: "✅ SHIPPED — Direct unit tests for `orchestrator-utils.js`".
12. ✅ **JSDoc stubs on the npm-package public API** — DONE 2026-05-11 (PR #218 / dc468a2 on develop). 13 JSDoc blocks: 9 `run*` orchestrators + `runDoctor` + `runDoctorChecks` + envelope helpers (`buildJsonReport` / `buildInvalidArgsEnvelope` / `envErrorJson` / `buildDryRunReport`) + `EXIT` constant + `parseGradleConfig` + `getProjectRoot`. Terse 1-line description + `@param` + `@returns`; no multi-paragraph, no `@example`. Vitest 1327 unchanged. Detail: "✅ SHIPPED — JSDoc stubs on the public npm-package API".
13. ✅ **Multi-project size-bucketed token-cost re-measurement + README reframe** — DONE 2026-05-12 (PR #220 / 3cb4f82 on develop). 6 OSS projects (KaMPKit, kotlinconf-app, kmp-production-sample, PeopleInSpace, Confetti, NowInAndroid) + reused `private-large-A` (v0.9 evidence). Sub-step 2a (multi-project orchestrator) + 2b (chunked Anthropic counting) + 3 (wet measurement) + 4 (README reframe + CHANGELOG) shipped on `tools/multi-project-token-cost-measurement` branch. README new 3-row bucket table replaces single-project narrative; per-feature drill-downs relabeled "private-large-A reference"; 77,114× coverage outlier preserved as the headline footnote with chunked-recovery narrative. Methodology caveat: NowInAndroid measured via default top-level walker (5 of 35 modules); per-project filter customization queued for v0.10 step 7. Aggregate at `tools/runs/multi-project-token-cost-2026-05-12/aggregate-2026-05-12.md`. Vitest 1327 → 1371 (+44). Detail: "✅ SHIPPED — Multi-project size-bucketed token-cost re-measurement".

**Phase 5 — behavior IDEA (separate user-driven decision, NOT a polish item)**

14. ✅ **`benchmark` partial-success grading** — DONE 2026-05-17 (PR 3.2). Shipped as part of the benchmark-cluster fix (A9 + A11 + A10). When `totalTimedOut > 0 AND totalPass >= 1 AND !opts.strictTimeouts`, exit code is `EXIT.SUCCESS` (0) and `state.warnings` carries `{ code: 'partial_timeout', timed_out, passed, message }`. New `--strict-timeouts` opt-out flag restores pre-graded hard-fail behavior. 3 vitest cases. Detail: "✅ SHIPPED — `benchmark` partial-success grading".

**Estimated end-to-end time:** Phase 1+2 ~12-15h (assuming PR-10 train takes 8-10h across 4 sub-PRs); Phase 3 read-only 3h interleaved; Phase 3.5 ~3-4h; Phase 4 ~22-27h after train (incl. measurement). Phase 5 deferred until user prioritizes. Total queue depth: ~43-50h before v0.10 #1 (ANSI auto-detect) starts.

**Hard exits (NOT in this queue):**
- Cross-platform CI matrix expansion — ❌ DROPPED. Conflicts with `feedback_ci_minutes_minimal_macos.md` (macOS minutes are 10× Linux; manual gate on a secondary machine is the canonical replacement).

---

### v0.10 — minor (locked 2026-05-05) — ✅ RELEASED 2026-05-19

1. **Defensive `--console=plain` injection** — ✅ DONE 2026-05-15 (PR #227 / 22fd8c8 on develop, v0.10 #1). Auto-injects `--console=plain` in `spawnGradle` when `process.stdout.isTTY === false` or `NO_COLOR` set, plus `--color={always,never,auto}` override and idempotency guard (skip when user already passes any `--console=*` via `--gradle-args`). New `lib/runners/console-mode.js` + injection callsite in `lib/orchestrators/orchestrator-utils.js`; `KMP_COLOR_MODE` env survives the cli.js → wrapper → runner.js re-exec chain.
2. **CLI auto-respect `gradle.properties`** — ✅ DONE 2026-05-16 (v0.10 #2 — `parallel`-only scope). `kmp-test parallel` drops `--parallel` from the gradle dispatch when the project has a `gradle.properties` AND the resolved `org.gradle.parallel` is `false`. Optional envelope field `gradle_config_applied:{parallel_dropped:true}` (additive, schema_version unchanged). Migration note in `CHANGELOG.md` covers the "project file present + key absent → resolves to gradle default `false` → drop fires" case. Escape hatches: `org.gradle.parallel=true` in `gradle.properties` or `--gradle-args "--parallel"` (last-wins, v0.9 passthrough).
3. **Per-project config user-global** — ✅ DONE 2026-05-16 (v0.10 #3). `~/.kmp-test/config.json` keyed by git-remote → rootProject.name → basename (first hit wins). New `lib/user-config.js` (loader + resolveProjectKey + mergeConfigs + validateUserPreset). `lib/project-config.js` exports `loadMergedConfig` for the dispatch path. Schema full parity with project-local (`sharedProject`/`defaults`/`skip`) + new `java_home` (user-global only). Precedence: CLI > env > project-local > user-global. Security: project-local `java_home` is dropped + warned (closes supply-chain vector). Doctor surfaces "User config" row with matched preset key.
4. **Google `android` skills system viability** — ✅ DONE 2026-05-17 (all 5 sub-PRs SHIPPED). `INVESTIGATE-ANDROID-SKILLS.md` at repo root (gitignored). Decision matrix 7/7 → SHIP authorized. Skill is published as part of the `agentskills.io` open standard (multi-vendor — 35+ adopters: Claude Code, Gemini CLI, Cursor, GitHub Copilot, OpenAI Codex, etc.). **Multi-PR ship complete**: ✅ PR 1 (foundation) → ✅ PR 2 (workflows) → ✅ PR 3 (instrumented dual branch) + bug-fix sub-train (PRs 3.1-3.6) → ✅ PR 4 (convenience scripts `detect-env.{sh,ps1}` + `run-tests.{sh,ps1}` under `.skills/kmp-test-runner/scripts/`; 4 test files under `tests/skill-scripts/` wired into the build job's bats + Pester steps; SKILL.md detect-env one-liner replaced with the script reference plus a new "Convenience scripts" section) → ✅ PR 5 (Claude Code Plugin packaging — `.claude-plugin/plugin.json` at repo root re-uses `.skills/kmp-test-runner/` via `skills:[./.skills/]`; `tools/validate-plugin.mjs` zero-deps validator + 39 vitest cases; CI `skills-validate` job extended with manifest check; `tools/sync-versions.js` grows 6th target so future package.json bumps stay in lockstep; README adds "Install as a Claude Code Plugin" subsection).
4.5. **Cross-tool output alignment audit — `kmp-test` vs `android` CLI** — ✅ DONE 2026-05-17 (v0.10 #4.5, Path A doc-only). Captured side-by-side outputs of both tools against three projects (CLI repo self, pure-Android app, KMP composite) + env-level `doctor` vs `info`. Findings: (a) `android describe` is non-functional on Windows at `android` CLI 0.7.15222914 — invokes POSIX `gradlew` shell script instead of `gradlew.bat`, crashes with `CreateProcess error=193`; (b) `android info` is plain text key:value (3 lines: `sdk`, `version`, `launcher_version`), not JSON; (c) different design philosophy — `android describe` is a paths-to-JSON-files pointer tool, `kmp-test parallel --dry-run` inlines all module data; (d) different abstraction layer — `kmp-test` answers "what modules can I run tests on?", `android` CLI answers "where are the build artifacts / SDK?". Schema convergence is **not viable** (Windows blocker + plain-text shape + different abstractions). Skill update: new "Cross-tool comparison: `android` CLI analogues" section in `.skills/kmp-test-runner/references/cli/envelope-schema.md` (parallel↔describe + doctor↔info field-by-field tables + platform caveat) + "Tool selection" subsection in SKILL.md with link. Paths B (partial converge) and C (full converge + `schema_version: 2→3`) deferred — would ship code matching docs without wet validation on Windows + bump a breaking schema for no consumer benefit.
5. **Research direction B — `android describe` JSON discovery** — ❌ DROPPED 2026-05-18 (v0.10 #5) under the standing pre-authorization clause ("If negative → drop with user authorization"). Verdict file: `WET-V0.10-STEP-5-RESEARCH.md` at repo root. Findings inherit directly from item #4.5 (SHIPPED 2026-05-17): schema convergence is not viable (Windows blocker — `android describe` invokes POSIX `gradlew` not `gradlew.bat`, `CreateProcess 193`; `describe` is a paths-to-build-artifacts pointer, not a module-task graph; different abstraction layer from `kmp-test`). The original Windows-performance motivation cannot be served by a tool that does not run on Windows; the macOS/Linux paths do not carry the data `lib/project-model.js` consumes. No `lib/` change. Long-tail BACKLOG cross-link (line 2307–2313 "Use `android describe` JSON as module-discovery source") is moved to the dropped-with-rationale list rather than pending-review.
6. **macOS validation gate** — ✅ DONE 2026-05-18 (v0.10 #6). `MACOS-GATE-V0.10-SUMMARY.md` at repo root captures three phases of wet evidence. **probe** (45 cells, no gradle): 28 PASS / 1 benign DRIFT / 16 SKIP. **scoped** (45 cells, real gradle per cell): 15 PASS / 30 SKIP / 0 ERROR / 0 DRIFT / 0 TIMEOUT (14 of the 30 SKIPs are `benign no-op: no_changed_modules` for `changed` cells against a clean worktree — see gate-fix #2 below). **targeted wet** (4 commands outside the gate's matrix): `doctor`, `info`, `describe --json`, `parallel --test-type ios --module-filter :shared` against KaMPKit all exit 0; the ios cell ran real `iosSimulatorArm64Test` BUILD SUCCESSFUL in 106 s. Required disk-redirect env vars (`KMP_TMPDIR` / `GRADLE_USER_HOME` / `KONAN_DATA_DIR` → `<EXT_VOL>/...`) to fit scoped on a 6.3 GB-system-free Mac. Bundled tooling fixes in `tools/macos-validation-gate.mjs` (vitest 1592/1592 unchanged): (1) `--label <vX.Y>` flag parameterizes the summary title + `.smoke/macos-gate-<label>/` subdir; (2) `BENIGN_NO_OP_CODES` filter on scoped bucketing so structured no-op signals like `no_changed_modules` bucket to SKIP-with-reason instead of false ERROR, with mirroring in `--reclassify` so the fix applied to existing envelopes without re-spawning gradle. Follow-up: parity snapshot refresh against live `android --list-only` envelope to clear the probe-mode benign DRIFT; allow `--reclassify` standalone (without requiring `--mode <non-dry>`).
7. **Token-cost re-measurement** — ✅ DONE 2026-05-18 (v0.10 #7). Hybrid scope: `parallel` + `coverage` + `info` + `describe` across the 6 OSS projects (skipped `changed` and `benchmark` — envelopes unchanged in v0.10). Tooling fixes shipped en route: (a) recursive walker in `tools/measure-token-cost.js#filterModulesByGlob` so projects with nested grouping dirs (NowInAndroid's `core/`, `feature/`) are honestly enumerated — closes the PR #13 caveat that NowInAndroid was undersampled at 5 of 35 modules (this run captures 36); (b) per-project `moduleFilter` override in `.measurement-projects.json` (general-purpose, no longer required after the walker fix). Coverage A baseline reused from v0.9 PR #13's `private-large-A` reference because all six OSS projects ship without the Kover plugin (Approach A on the OSS sample captures only `task 'koverXmlReport' not found` errors, 200-1,000 cl100k). Skill loading cost included in the aggregate (v0.10 #4 deliverable): `SKILL.md` eager-load = 3,232 cl100k; total `.skills/kmp-test-runner/` worst-case full load = 53,595 cl100k (28 files); `.claude-plugin/plugin.json` = 255 cl100k. Vitest 1592 → 1601 (+9: 5 walker + 4 `resolveProjectOpts`). Evidence: `tools/runs/multi-project-token-cost-2026-05-18/aggregate-2026-05-18.md`.
8. ✅ **README v0.10 refresh + CHANGELOG** — DONE 2026-05-18 (PR #251).
9. ✅ **Tag v0.10.0** — DONE 2026-05-19 (prep + release PRs). Atomic version bump across the 6 sync-versions targets; bundled non-canonical 0.9.x sweep (README JSON examples, validate-plugin fixtures) + About polish across 7 surfaces (GitHub repo description via `gh repo edit`, README L3, package.json, .claude-plugin/plugin.json, gradle-plugin POM, CLAUDE.md L3); SKILL.md description left verbatim (load-bearing trigger keywords). Cascade fires `auto-tag.yml` → `publish-{npm,gradle,release}.yml`.

### ❌ DROPPED 2026-05-05 (decided OUT — not deleted, kept for traceability)

- **DX-parity lower-priority items** (`kmp-test docs`, `kmp-test devices`, `kmp-test sdk`, subcommand grouping verb/noun) — solap with `--help`, `adb devices`, `doctor`, and the verb/noun grouping is breaking change without agentic value. User decision 2026-05-05.
- **iOS/macOS TestKit matrix in CI** — incompatible with CI minute budget rule (`feedback_ci_minutes_minimal_macos.md`). Coverage replaced by step 5 (cross-platform parity check in CI) + step 7 (manual macOS validation gate). User decision 2026-05-05.

### 🅿️ PARKED — promote on user trigger

- **Maven Central publish for the Gradle plugin** — needs Sonatype account. Promote when account exists.
- **VitePress/MkDocs docs site** — promote when README exceeds 1500 lines (today: 716).

### 📋 QUEUED follow-ups (next sessions)

- **FULL-REPO AUDIT REMEDIATION v3.2 — active execution queue.** Source of truth:
  `docs/audits/full-repo-audit-improvement-plan-v3.2.md`; fresh-session handoff prompt:
  `docs/audits/claude-code-audit-corrections-prompt.md`. This supersedes the loose
  post-v0.12 follow-up ordering for audit/security/quality work without creating a new
  milestone bucket. Execute PR-sized units in the v3.2 order: start with Phase 0 privacy
  (`PR-00` fail-closed wet-evidence generator, `PR-01` synthetic device serial placeholder,
  `PR-02` decouple-audit v2 with the selected trusted fork-PR private-scan path), then Phase
  1 safety/release/CI (`PR-04`, `PR-05`, `PR-06`, early `PR-19`, `PR-20b`, `PR-20c`,
  `PR-06b`) before the Gradle-plugin and behavior waves. Mandatory quality gate for every
  implementation PR: wet validation on Windows against at least one official workspace
  project and one private project, Android-relevant changes on the connected S22 Ultra,
  macOS/iOS/manual checks only when needed, no recurring heavy macOS CI, private evidence
  only through anonymized artifacts. Before the final documentation/alignment PR, run a
  dedicated manual macOS validation phase that validates the accumulated audit train
  consistently on the available macOS machine / `macos-validation.yml` workflow_dispatch
  jobs; document sanitized public + private evidence, then do the final docs closeout.
- ✅ **PR-28e `fix(project): include precompiled build-logic scripts in cache key`** — SHIPPED
  2026-07-15 (this PR, closes PR-28b's own residual gap below). Reproduced (pinned repro:
  build a model with a build-logic precompiled-script plugin
  (`build-logic/convention/src/main/kotlin/<id>.gradle.kts`) applying `kover`, edit the
  script to apply `jacoco` instead, rebuild — pre-fix `computeCacheKey` stayed unchanged and
  `buildProjectModel` served the stale `coveragePlugin: kover`) and fixed: `computeCacheKey`
  (`lib/project/cache.js`) hashed `build-logic/**/*.kt` sources (PR-28b) but never
  `build-logic/**/*.gradle.kts` / `build-logic/**/*.gradle` precompiled script-plugin
  sources, even though `parseBuildLogicPluginDescriptors`
  (`lib/project/kotlin-dsl.js`) already parses BOTH file types as descriptor sources
  feeding `coveragePlugin`/`appliedPlugins`/module `type`, and `aggregateJdkSignals`
  (`lib/project/jdk-signals.js`) reads `.gradle.kts`/`.gradle` content anywhere in the
  project (including build-logic/) for `jdkRequirement`. Fixed by generalizing the
  private `collectBuildLogicKotlinFiles` walker into `collectBuildLogicSourceFiles`,
  now matching `.kt` + `.gradle.kts` + `.gradle` in one tree walk (same depth cap and
  exclusion set as before), hashed by relative path + content — deliberately NOT
  path-restricted to `src/main/kotlin/`/`src/main/groovy/` (unlike
  `parseBuildLogicPluginDescriptors`'s own precise regex): broader/simpler matching
  that over-invalidates rather than under-invalidates, the same simplification PR-28b
  already made for `.kt`. One accepted side effect: a
  `build-logic/<module>/build.gradle.kts` registration file is now hashed twice (once
  content-only via the pre-existing `collectBuildFiles`, once path+content via this
  walk) — redundant, not incorrect, locked in with a regression test. `SCHEMA_VERSION`
  bumped `9 → 10` (same shape as the `8 → 9` bump) to force-invalidate pre-fix caches
  on upgrade. 9 new Vitest cases (Vitest 2405 → 2414), `npm run test:coverage`
  94.85%/84.79%/94.01%/94.85% lines/branches/functions/statements (all ≥ configured
  thresholds), incl. a Kotlin AND a Groovy precompiled-script-plugin case and an
  end-to-end regression proving `buildProjectModel` reflects an edited
  precompiled-script plugin's applied coverage tool instead of serving a stale cache.
  `node tools/decouple-audit.mjs` (423 files, 3 public rules) and
  `node tools/check-line-endings.mjs` (74 LF-required files) both clean.
  **Scope decision**: `scripts/sh` / `scripts/ps1` gradle-tasks-probe cache-key walkers
  are out of scope architecturally, not by a snapshot of what they currently hash —
  they never read or write `model-*.json`, so a JS/shell key mismatch can only cause a
  safe miss in their own probe cache, never a stale hit in the JS model. **Wet
  validation**: no-regression checks against one official public project
  (`Kotlin/kmp-production-sample`, 3 modules, no `build-logic/`) and one private
  project (aliased "private-kmp-lib", 74 modules, real `.kt` build-logic convention
  plugins) — both `describe --json --skip-probe` cold→warm runs produced an identical
  `cache_key` and correct module data, confirming no regression. New-behavior proof:
  the required model-level `buildProjectModel(..., {skipProbe:true})` regression test
  (above), plus a best-effort CLI-level synthetic fixture (stub `gradlew` that exits
  immediately, no network/real Gradle) run through the real `describe` binary —
  cold/warm cache_key stable, then changed correctly after editing the
  precompiled-script-plugin, with `coveragePlugin` flipping `kover → jacoco` in the
  live envelope.
- ✅ **PR-28d `fix(project): ignore quoted scanner signals`** — SHIPPED 2026-07-15 (this PR,
  follow-up to PR-28a's residual gap + an incidental finding surfaced alongside it). Reproduced
  two related bugs, both traced to `stripGradleComments` (`lib/project/kotlin-dsl.js`) having no
  string-literal awareness: (1) a JDK-signal-shaped substring inside a string literal (e.g.
  `println("jvmToolchain(21)")`) was not a comment, so it survived stripping untouched and
  `aggregateJdkSignals`'s JDK_PATTERNS regexes then wrongly matched it as a live requirement; (2)
  `detectAgpVersion` (same file) never stripped comments at all, so a commented-out AGP
  declaration positioned before a live one won outright (pinned repro:
  `// classpath(...gradle:4.2.0")` above a live `classpath(...gradle:8.2.1")` resolved
  `agpVersion: "4.2.0"` → required-JDK floor **8** instead of the correct **17**, a false
  negative that could let a run proceed on an insufficient JDK). Fixed by rewriting
  `stripGradleComments` as a single-pass quote-aware scanner (line/block comment +
  single/double/triple-quoted-string states) that leaves string content byte-for-byte untouched
  — zero behavior change for its 5 existing call sites (plugin-id / coverage-tool / class-name
  detection in `project-model.js`, `analyze-module.js`, `kotlin-dsl.js` self-uses; 2 explicit
  non-regression tests added, not just full-suite-stayed-green: a plugin id inside a string
  literal still resolves, and a `//` inside a same-line URL string no longer eats real trailing
  code), since none of those names legitimately contain `//`/`/* */`-shaped text. New sibling
  export `stripGradleCommentsAndStrings` additionally blanks string CONTENT with equal-length
  spaces (keeps quote delimiters); `aggregateJdkSignals`'s build-script walk is the only caller
  switched to it. `detectAgpVersion` now strips comments before its 2 build-file regex matches
  (its `libs.versions.toml` catalog probe is untouched — see residual note below). An
  unterminated `/* comment` is swallowed to EOF rather than left in the scanned text, so a
  malformed file can't leak a phantom signal — an early design draft got this backwards (copied
  the unterminated tail back "for byte-parity with the old regex"), caught in plan review before
  implementation; regression test locks the fixed behavior. 14 new Vitest cases (vitest 2390 →
  2404), `npm run test:coverage` / `node tools/decouple-audit.mjs` /
  `node tools/check-line-endings.mjs` all green. **Residual, explicitly NOT the same bug shape as
  the fixes above — do not conflate**: `detectAgpVersion`'s `gradle/libs.versions.toml` catalog
  probe is unchanged. The direct analogue of the fixed bug (a commented-out `key = "value"` line)
  is already a non-issue there today — TOML comments use `#`, and the probe's regex requires the
  key to be the first non-whitespace token on the line, which a leading `#` can't satisfy. The
  actual remaining gap is different and lower-probability: the `[versions]` section-boundary
  regex has no comment-awareness of its own, so a stray commented-out `# [versions]` example
  header ahead of the real section could make it latch onto the wrong occurrence — a
  section-header-matching bug, not a key-value-comment bug. Needs its own quote-aware TOML lexer,
  own follow-up, priority TBD. Also explicitly out of scope, not touched: the pre-existing
  misleading comment at `lib/project-model.js:81-82` claiming `detectAgpVersion`/`agpRequiredJdk`
  are re-exported when only `aggregateJdkSignals` is; `scripts/sh/lib/jdk-check.sh` /
  `scripts/ps1/lib/Jdk-Check.ps1` dead-code duplicates; `describe-orchestrator.js`'s non-existent
  `jdkRequirement.agp` field read; no new JDK signal patterns added (e.g. `JavaLanguageVersion.of`
  was never matched by `JDK_PATTERNS` before this PR either — out of scope, a coverage addition
  not a false-positive fix). **Second residual, caught in post-CI review**: the lexer recognizes
  `'...'`/`"..."`/Kotlin `"""..."""` but NOT Groovy slashy (`/.../`) or dollar-slashy (`$/.../$`)
  string literals — a JDK-signal-shaped substring inside one (e.g. `def note = /jvmToolchain(21)/`
  in a `.gradle` file) can still false-positive. Deliberately not supported: a bare `/` is
  genuinely ambiguous between string-open and division without real expression-context tracking,
  and a naive heuristic risks the worse failure mode of eating real code between an actual
  division and the next unrelated `/`. Locked in with a regression test asserting the current
  (documented) behavior — own follow-up if ever prioritized, priority TBD.
- ✅ **PR-20a `test(env): make environment snapshots hermetic`** — SHIPPED 2026-07-14 (this PR,
  closes v3.2 finding M9's JAVA_HOME-dependent-snapshot half; the CRLF/bats half is PR-20b,
  separate, not touched here). Root cause: `lib/jdk-catalogue.js`'s `discoverInstalledJdks()`
  (called with no options from both `lib/commands/doctor.js` and
  `lib/orchestrators/info-orchestrator.js`) scans hardcoded absolute per-platform paths (e.g.
  `C:\Program Files\Eclipse Adoptium`, `/usr/lib/jvm`) that no env var can influence, so
  `info.jdk_catalogue` came back empty or populated purely based on what's really installed on
  whatever machine ran the test — hence "1922/1923 locally". `info.android_sdk`/`info.jdk` had the
  same null-vs-object divergence. `tests/vitest/_parity-helpers.js`'s existing normalizer already
  collapsed leaf *values* to type placeholders for `checks`/`info`/`gradle_config`
  (`HOST_ENV_KEY` → `schemaOf`) but reflected whatever *shape* (null vs object, `[]` vs
  populated) the live run happened to produce for these three fields — the gap this PR closes.
  Fix: generalized the existing `java_home`-only `NULLABLE_STRING_SCHEMA_FIELDS` precedent into
  `FIXED_SCHEMA_OVERRIDES`, a fixed contract shape for `jdk`/`jdk_catalogue`/`android_sdk`
  returned unconditionally regardless of the live value (values chosen to match what was already
  committed, so the `.snap` file needed zero changes). Snapshot-producing subprocesses
  (`runSubcommand`) now build their env via a new `makeHermeticEnv()` instead of inheriting full
  `process.env` — real `PATH` preserved (case-insensitive lookup, since Windows can store it as
  `Path` rather than `PATH`; naively assuming the literal key would silently drop PATH resolution
  on such a host and falsely flip `doctor`'s `exit_code` from 0→1) so `java`/`pwsh`/`bash`/`adb`
  still resolve normally; `HOME`/`USERPROFILE`/`LOCALAPPDATA`/`TMP`/`TEMP`/`CI` sandboxed;
  `JAVA_HOME`/`ANDROID_HOME`/`ANDROID_SDK_ROOT` omitted. `FIXED_SCHEMA_OVERRIDES` only affects the
  snapshot-side normalizer — a raw (non-normalized) envelope from `runSubcommand` still carries
  the real live shape; no production `lib/` code changed. 7 new tests in
  `tests/vitest/parity.test.js`, including a host-independent proof (hand-built "not found" vs
  "found" `info` blocks normalize identically) verified to fail without the fix and pass with it
  — the initial design (mutating real `process.env.ANDROID_HOME` around a real subprocess run)
  turned out to NOT discriminate on a dev machine that already has a real Android SDK detected, so
  it was replaced with the synthetic-envelope version instead of left as a non-gated assertion.
  Vitest 2371 → 2378 (+7). `npm run test:coverage` / `node tools/decouple-audit.mjs` /
  `node tools/check-line-endings.mjs` all green. `git diff --ignore-space-at-eol -- tests/vitest/__snapshots__/parity.test.js.snap`
  confirmed empty (zero real snapshot diff; the file's dirty `git status` was pre-existing
  autocrlf noise, left untouched).
- ✅ **M9 residual — `tests/bats`/`tests/installer` LF-pin** — SHIPPED 2026-07-14 (this PR).
  Closes M9's other half: "bats invalidated by CRLF on Windows checkouts." Note for future
  sessions: the literal audit-doc **PR-20b** (`ci: validate supported Node versions and line
  endings`) and **PR-20c** (dev-dep remediation) already shipped as #329/#330, well before
  PR-20a above — confirmed via `git merge-base --is-ancestor`. PR-20b delivered the Node
  18/24 CI matrix and the generic `tools/check-line-endings.mjs` guard (pattern-driven
  purely from `.gitattributes`, "no hardcoded patterns"), but never extended `.gitattributes`
  coverage to `tests/bats/*.bats` (26 files) or `tests/installer/*.bats` (1 file) — unlike
  their sibling `tests/skill-scripts/*.bats`, which was already covered from the earlier
  `.skills/**/*.sh` fix. Root cause: on a Windows checkout with `core.autocrlf=true`,
  `git check-attr text eol` returned `unspecified` for both paths and the working-tree files
  were physically CRLF, while `git show HEAD:<path>` proved the committed blob was already
  LF — a preventive coverage gap, not corrupted history, same shape as the earlier
  `scripts/*.sh` fix. Fix: two-line `.gitattributes` addition
  (`tests/bats/*.bats text eol=lf` + `tests/installer/*.bats text eol=lf`). Refreshing the
  working tree to match required more than `git add --renormalize` alone — on this
  git-for-windows build, both `git checkout -- <path>` and `git checkout-index -f` silently
  skipped rewriting files they considered already up to date via stat-cache; only deleting
  the file first and re-checking it out from the index forced a genuine rewrite (verified
  via `node tools/check-line-endings.mjs` + `git diff --ignore-space-at-eol` both unstaged
  and staged, both empty — the 27 `.bats` files end up with **zero** committable diff, only
  `.gitattributes` + docs + the new test change). New regression test in
  `tests/vitest/check-line-endings.test.js` reads the **real** `.gitattributes` (every other
  test in that file uses a synthetic string) and asserts `tests/bats/*.bats` +
  `tests/installer/*.bats` are covered — fails pre-fix, passes post-fix. Vitest 2378 → 2382
  (+4). `npm run test:coverage` / `node tools/decouple-audit.mjs` /
  `node tools/check-line-endings.mjs` all green. Bats wet-check: `test-doctor.bats` (7),
  `test-json.bats` (7), `test-deprecation-notice.bats` (6) all pass against the renormalized
  files; `tests/installer/install.bats`'s 8 syntax/safety tests pass, its 17 `E2E:` tests
  fail identically before and after this change (`install.sh` refuses to run its E2E path on
  native Windows git-bash — "Unsupported platform: MINGW64" — a pre-existing environment
  limitation unrelated to line endings; Windows CI exercises the equivalent E2E coverage via
  `install.ps1`/Pester instead, per the documented test strategy). The Node-18-floor-vs-
  current-LTS decision (§6 of the v3.2 audit, reserved for the user) remains open and
  untouched by this PR.
- ✅ **PR-28c `test(android): close stale xml audit finding`** — SHIPPED 2026-07-14 (this PR,
  final slice of the verify-first trio / v3.2 finding M10). Did NOT reproduce as stated:
  `android-orchestrator.js` has no JUnit-XML read path at all — `parseTestCounts` /
  `parseTestFailures` derive every count and failure exclusively from regex parsing of gradle's
  own stdout; `lib/parsers/junit-xml.js` is never imported (confirmed by a full-file read, not
  just the module's own header comment). The only place JUnit XML is read for Android-shaped
  output is `parallel --test-type androidInstrumented`, via the same `forEachJunitXml` /
  `recordLegResults` machinery already used (and already regression-tested) for JVM/common legs,
  including the F3 (2026-05-03) `cacheRespected` bypass — by inspection this is 100%
  shape-agnostic: `classifyTaskExecutionMode` applies one shared regex to every task string, and
  `forEachJunitXml` unions the legacy dir AND AGP's connected-test dir under the identical
  `sinceMs` gate, with no branch anywhere conditioning either on test type. The one real gap: this
  intersection (AGP dir × stale mtime × cache-respected × a REAL `androidInstrumented` dispatch)
  was untested. Closed with tests only, no production code changed: 3 new regression tests in
  `tests/vitest/parallel-orchestrator.test.js` mirror the JVM F3 tests against the AGP directory
  through a real `androidInstrumented` dispatch, plus 1 bonus end-to-end test proving
  `test_failures[]` populates from the AGP directory through a real dispatch (deliberately did NOT
  fabricate a "cache-respected AND failed" fixture — gradle cannot mark a task both
  UP-TO-DATE/FROM-CACHE and newly FAILED at once, so that combination isn't a reachable state).
  2 new tests in `tests/vitest/android-orchestrator.test.js` turn "no XML-read path" into a
  regression-locked behavioral proof: a poisoned on-disk JUnit XML (different count AND a
  different failure signature than the mocked gradle stdout) is planted in both directory shapes
  and shown to have zero effect on the envelope in both a PASS run and a FAIL run. Vitest 2365 →
  2371 (+6). `npm run test:coverage` / `node tools/decouple-audit.mjs` /
  `node tools/check-line-endings.mjs` all green.
  **Wet-check: CONFIRMED UNREACHABLE.** Dispatched a real KMP `androidLibrary {
  withDeviceTestBuilder }` module's `connectedAndroidDeviceTest` task (27 real on-device tests)
  twice in a row via raw `gradlew`, no source changes between runs, against a connected physical
  device (`<DEVICE_SERIAL>`, Samsung S22 Ultra). On the second run every upstream
  compile/bundle/dex/package task correctly showed `UP-TO-DATE` — but the connected-test task
  itself showed no caching suffix on either run and fully re-executed all 27 tests on-device both
  times. A third invocation through `kmp-test parallel --test-type androidInstrumented` confirmed
  the tool's own telemetry matches raw gradle exactly (`execution:{fresh:1,up_to_date:0,
  from_cache:0}`, `tests.individual_total:27` correctly reflecting the fresh XML from that run —
  itself a live end-to-end proof the freshness-gated walk works correctly on a real device). The
  `cacheRespected` bypass is real, correct, and shape-agnostic in code, but **unreachable in
  practice** for connected/instrumented Android test tasks: Gradle does not treat on-device
  instrumentation runs as incrementally cacheable, so the UP-TO-DATE/FROM-CACHE verdict this
  bypass keys off of never fires for this task type. It remains in place as harmless
  defense-in-depth (mirrors the JVM shape's real F3 incident precedent — removing
  un-reproduced-as-harmful code would itself be speculative, not a reproduced-defect fix).
  **M10 ("verify-first trio") is now fully closed**: PR-28a (JDK comment false-positives), PR-28b
  (project-model cache fingerprint), PR-28c (this entry) all shipped.
- ✅ **PR-28b `fix(project): include build-logic sources in model cache key`** — SHIPPED
  2026-07-14 (this PR, deferred slice of PR-28a / v3.2 finding M10). Reproduced (pinned
  repro: build a model with a build-logic convention plugin applying `kover`, edit the
  plugin to apply `jacoco` instead, rebuild — pre-fix `computeCacheKey` stayed unchanged and
  `buildProjectModel` served the stale `coveragePlugin: kover`) and fixed: `computeCacheKey`
  (`lib/project/cache.js`) hashed settings/build files + the version catalog but never
  `build-logic/**/*.kt` convention-plugin Kotlin sources, even though
  `detectBuildLogicCoverageHints` / `parseBuildLogicPluginDescriptors` derive each module's
  `coveragePlugin` from those files and `aggregateJdkSignals` derives `jdkRequirement` from
  them too. Fixed by hashing every `build-logic/**/*.kt` file by relative path + content
  (path included so rename/add/remove also invalidates the key — a convention plugin's
  class name comes from its filename), purely additive (a project with no `build-logic/`
  directory, or none containing `.kt` files, hashes identically to before).
  `SCHEMA_VERSION` bumped `8 → 9` (same shape as the `7 → 8` toml bump) to force-invalidate
  pre-fix caches on upgrade. 9 new Vitest cases (Vitest 2365, `npm run test:coverage`
  94.78%/84.62%/93.97%/94.78% lines/branches/functions/statements, all ≥ configured
  thresholds), incl. an end-to-end regression that rebuilds the model after the
  convention-plugin edit and asserts it reflects the new signal instead of a stale cache
  hit. **Residual gap, tracked, not fixed here**: precompiled-script-plugin
  `build-logic/**/*.gradle.kts` files (a related but distinct descriptor source in
  `parseBuildLogicPluginDescriptors`) are not yet hashed — own follow-up, priority TBD.
  ✅ **SHIPPED as PR-28e above.**
  **Scope decision**: `scripts/sh` / `scripts/ps1` gradle-tasks-probe cache-key walkers are
  NOT updated to match this new input — a JS/shell cache-key mismatch only ever produces a
  miss (safe, forces a fresh gradle probe), never a stale hit, so cross-implementation
  parity for this one input is deferred rather than blocking this fix.
- ✅ **PR-28a `fix(jdk): ignore commented toolchain signals`** — SHIPPED 2026-07-14 (this PR,
  verify-first trio slice of v3.2 finding M10). Fixed: `aggregateJdkSignals`
  (`lib/project/jdk-signals.js`) treated a JDK version number inside a `//`/`/* */` comment
  as a live requirement, which could false-block a run (`jdk_mismatch`) even when the host
  JDK was already correct — fixed via `stripGradleComments`. **Residual gap, tracked, not
  fixed here**: string-literal false positives in the same scanner (`stripGradleComments`
  has no quote-awareness) — own follow-up, priority TBD. ✅ **SHIPPED as PR-28d above.**
  **Deferred — PR-28b**: project-model
  cache fingerprint (`computeCacheKey`, `lib/project/cache.js`) reproduces — doesn't hash
  `build-logic/**/*.kt`, so a convention-plugin edit can serve a stale cached model
  (`describe` path only); needs a schema bump, own PR. ✅ **SHIPPED as PR-28b above.**
  **Deferred — PR-28c**: "Android reads
  stale XML" did NOT reproduce as stated (`android-orchestrator.js` has no XML-read path at
  all) — needs a closure decision + wet-check (can `parallel`'s `cacheRespected` bypass ever
  fire for AGP connected-test output?) before this M10 sub-finding can be marked resolved or
  given a scoped test. ✅ **SHIPPED as PR-28c above.** **Incidental findings, compact follow-ups**: `detectAgpVersion` (same
  file) had comment-blindness on its 2 build-file regex matches ✅ **SHIPPED as PR-28d above**
  (its `libs.versions.toml` catalog-probe branch is a distinct, separate, low-probability
  residual — see PR-28d's own note above; not the same bug shape, not silently left open);
  `scripts/sh/lib/jdk-check.sh` /
  `scripts/ps1/lib/Jdk-Check.ps1` carry a dead-code duplicate of the pre-fix scanner;
  `describe-orchestrator.js` reads a non-existent `jdkRequirement.agp` field (always null).
- ✅ **PR-27 `fix(envelope): honor published exit-code contract`** — SHIPPED 2026-07-14 (this PR).
  v3.1/v3.2 finding (DECIDED, recommendation inverted from an earlier round): `task_not_found` and
  `unsupported_class_version` are environment/toolchain problems, not test assertions — the
  published contract has always said exit `3` (`ENV_ERROR`) for both, but `parallel`'s
  `decideExitCode`, `android`'s flat error-count ternary, and `benchmark`'s if/else chain all
  independently resolved them to `1` (`TEST_FAIL`). The audit's own text named only
  `result-rollup.js` as the fix site; investigation found the identical bug duplicated in
  `android-orchestrator.js` and `benchmark-orchestrator.js` too — all three fixed via one new
  shared helper, `classifyExitCode` (`lib/envelope/exit-codes.js`), which
  `enforceErrorsExitCodeInvariant`'s dispatcher-level promotion also now targets instead of
  blindly promoting to `1`. `gradle_timeout` (the third code the audit named) was already
  correctly `3` — untouched, just regression-tested. A flawed first-draft version of the
  classifier (an allowlist rather than a catch-all) was caught in review before merge — it would
  have silently regressed `android`'s `spawn_error` case from non-zero back to `0`; the shipped
  version is fail-closed instead. Observable behavior change, documented in `CHANGELOG.md`: any
  consumer branching on exit code for these two specific conditions must update from `1` to `3`.
  Deferred (not fixed here, to keep this PR scoped to the exit-code contract itself): `no_project`'s
  doc-says-3/code-returns-2 drift (`describe` subcommand, docs need updating — code is the
  deliberate, tested v0.9 "F-1" fix); four hard error codes (`jdk_mismatch`, `lock_write_error`,
  `platform_unsupported`, `project_model_failed`) undocumented in both canonical docs;
  `envelope-schema.md`'s cross-tool-comparison table claiming "6 codes" for warnings when its own
  table lists 19; `no_test_modules`'s "Subcommand" column omitting `android`/`benchmark` (both emit
  it); `android`/`benchmark`'s `no_test_modules` not supporting the `caused_by_filter` split
  `parallel`/`changed` have (always hardcoded `ENV_ERROR`); `gradle_timeout`'s absence from both
  docs' soft-codes tables (it's in code's `SOFT_ERROR_CODES`, a wording/classification nuance, not
  a contract violation); `input-validation.test.js`'s CONFIG_ERROR cases not uniformly asserting
  `envelope.exit_code === result.exitCode` the way `describe-orchestrator.test.js`'s F-1 regression
  test does.
- ✅ **PR-18 `fix(parallel): make dry-run side-effect free`** — SHIPPED 2026-07-14 (this PR). v3.2
  finding H8: `resolveDryRunModules` (`lib/parsers/script-output.js`, the dispatcher-level
  `--dry-run` short-circuit shared by `parallel` and `changed`) called
  `buildProjectModel(projectRoot)` with no options — on a cold cache this spawned a real `gradlew
  tasks --all --quiet` probe and unconditionally wrote `.kmp-test-runner/cache/{tasks,model}-<sha>.
  {txt,json}`, contradicting the documented dry-run contract. Fixed with the one-line
  `{ useCache: false, skipProbe: true }` (same combination `describe --skip-probe` already uses —
  `skipProbe` alone doesn't stop the cache write, which is gated on `useCache`). Investigation
  found `runParallel`'s own internal dry-run branch (`parallel-orchestrator.js:335`) already
  correctly side-effect-free (fresh-daemon/ADB/coverage/benchmark/isolated-dir all properly
  gated) — it's just unreachable dead code from the real CLI, since the dispatcher short-circuits
  before ever invoking it. 10 new/extended regression tests across 3 files prove: no gradle
  task-probe spawn, no ADB probe, no coverage/benchmark dispatch, no isolated-dir mkdir, and no
  `.kmp-test-runner/` creation at all — including a real end-to-end subprocess test and a
  `changed --dry-run` case (same shared helper, same fix). Discovered but explicitly deferred
  (not fixed here): `pickWindowsShell()` still probes `pwsh` availability on Windows before the
  dry-run short-circuit — unrelated to gradle/adb/`.kmp-test-runner`, and fixing it would require
  reordering `script-dispatcher.js`'s sequencing, which its own header comment locks against
  ("17 Pester contract tests + parity snapshots key on this exact order"). **Trade-off surfaced
  by CI, not just predicted**: `build (ubuntu-latest)` caught 2 bats fixtures
  (`test-convention-flavors.bats`, `test-flavored-unit-only.bats`) that asserted the *old*
  probe-backed accuracy of `parallel --dry-run`'s module preview on a cold cache. Without the
  probe, a convention-applied-flavor module reports `has_flavor:false` on dry-run instead of the
  probed `true` (module presence in `plan.modules[]` unaffected); more significantly, a module
  whose only unit-test source sets are flavor-named (no bare `src/test/`) is now genuinely
  reclassified into `plan.skipped[]` with reason `"no test source set"` on a cold-cache dry-run —
  an honest static-only view, not a real-dispatch regression (a warm cache, or the real run
  itself, is unaffected). Both fixtures updated to assert the new, correct-by-necessity contract;
  see the CHANGELOG `[Unreleased]` entry's "Known trade-off" paragraph for the full write-up.
- ✅ **PRE-RELEASE — Opus 4.8 (`claude-opus-4-8`) token-cost refresh** — DONE 2026-06-07 (this PR). Finding: **`claude-opus-4-8` shares `claude-opus-4-7`'s tokenizer.** The cross-model re-measure showed a *constant* −5-token delta per `count_tokens` request regardless of input size (a 321-token and a 2.38 M-token capture both differ by exactly 5; chunked captures differ by ~5×chunks), i.e. `count_tokens` request scaffolding — not content tokenization. Confirmed across all four features incl. the 36 M-token coverage cell (re-measuring `claude-opus-4-7` reproduced 36,571,879 ≈ the committed 36,571,927, within chunk-boundary tolerance → captures byte-identical); cl100k / sonnet / haiku all reproduced exactly. **Refreshed** the opus column to the freshly-measured 4.8 numbers across the 4 README drill-down tables + `docs/token-cost-measurement.md` + the 4 committed `tools/runs/cross-model-results-{parallel,coverage,changed,benchmark}.txt`; recomputed within-project A:C (parallel 336× unchanged, changed 214×→217×, benchmark 145×→147×, coverage 29,952×→30,075×) and relabeled the tokenizer note + `--anthropic-models` examples + tool usage comments. **Bonus (user-requested):** replaced the render-broken `█` ASCII bars (GitHub renders them as barcode-noise) with clean numeric tables across README + docs. Out of scope: `cross-model-results-{info,describe}.txt` stay `claude-opus-4-7` (auxiliary, not README-referenced, captures absent so not re-measurable) and the CHANGELOG bars are frozen history. NOT a release — the version bump + tag + publish is the next `develop→main` session.
- ✅ **README / tools-usage audit** — DONE 2026-06-06 (this PR). Docs: new "Choosing a test type" decision table + "Compose UI tests are instrumented" callout, per-value `--test-type` guidance, clarified `android` subcommand + Gradle-plugin `testType` docs, an "instrumented-only flags" grouping note, and a warning-code catalogue in `docs/envelope-contract.md`. **Discoverability hint shipped too**: the unit/auto leg now emits `warnings[].code: "instrumented_only_skipped"` (+ actionable `[SKIP]` / `skipped[].reason`) pointing at `--test-type androidInstrumented`, suppressed under `--test-type all`; `parallel`/`changed`/`android` `--help` updated. (Original context: a UI teammate added the Gradle plugin to a Compose-UI-only project and saw "no reports" because auto-detect ran the unit leg and silently skipped instrumented-only modules.)
- ✅ **`--capture-on-fail` on `parallel --test-type androidInstrumented`** — DONE 2026-06-07 (this PR). Wired the shared `lib/orchestrators/android-capture.js` helper into `parallel/result-rollup.js`'s `module_failed` branch via an injected `capture` callback (built in `parallel-orchestrator.js`, gated to `testType === 'androidInstrumented'` in `cascade-retry.js` so the pure rollup module keeps its no-`child_process` invariant). Reuses `resolvedDeviceSerial` + the `.kmp-test-runner/logs/android/<runId>/` dir; captures once per still-failed module on the final-failure state (post `--auto-retry`/cascade), namespaced per module. `--capture-on-fail` / `--capture-dir` now parse in `parallel` (dispatch.js), pass through the `.sh` wrapper verbatim + the `.ps1` wrapper's new `-CaptureOnFail`/`-CaptureDir` params, and propagate through `ParallelTestsTask`. Fires for both `--test-type androidInstrumented` and the instrumented leg of `--test-type all`. Additive on `errors[]` — no `schema_version` bump. Emulators are first-class. Wet-validated on a physical S22 Ultra. Deferred from the android-subcommand PR (#278) to keep it focused.
- ✅ **`parseTestCounts` miscount on AGP 9.2.x connected tests** — DONE 2026-06-07 (this PR). (wet-finding 2026-06-06, S22 / JetNews / AGP 9.2.1). A single failing `connectedDebugAndroidTest` reported `tests: {total:1, passed:1, failed:0}` in the envelope — cosmetic (gradle exit code is the authority, so `exit_code:1` + `errors[].module_failed` were correct), but `parseTestCounts` (`lib/orchestrators/android-orchestrator.js`) didn't recognise the AGP 9.2 device-test reporter's failure line, so it graded the run as passed. **Fix shipped:** format-agnostic `reconcileTestCounts(counts, exit)` — when the task exited non-zero but the parse found a `total` with zero failures, attribute ≥1 failure (exit code is the authority; counts stay best-effort otherwise). Unit-tested (5 cases). NOT wet-reproduced on this hardware — the AGP-9.2 project the finding came from (JetNews) wasn't checked out, and the local KMP library available for probing is AGP 9.0.1 with an instrumented module whose custom test runner crashes instrumentation on init before any test runs, so a real AGP-9.2 connected failure couldn't be staged locally; the fix is validated by construction against the documented JetNews/AGP 9.2.1 shape + unit tests.
- ❌ **DROPPED 2026-06-07 — `parallel` instrumented `module_failed` "over-reports" `setup_failed:true` + `individual_total:0`** — was a **MISDIAGNOSIS**, not a bug. Two facts settled it during the 2026-06-07 S22 ground-truth session: (1) `forEachJunitXml` (`lib/parsers/junit-xml.js:78`) **already** walks the AGP instrumented tree `build/outputs/androidTest-results/connected/` — the original hypothesis ("walker never reads it") was simply false. (2) The "genuine on-device failure" that triggered the finding was actually a probe that **never ran**: my deliberately-failing test had an `assertEquals` arg-order compile error → `compileDebugAndroidTestKotlin FAILED`; subsequent attempts hit a no-FQN filter (`Starting 0 tests`) then the module's custom `BenchmarkTestRunner` crashing instrumentation on init (`tests="0"`, `Process crashed: Unable to instantiate application`). In every case `setup_failed:true` + `individual_total:0` were **correct** (no testcase executed → no XML). A real runtime instrumented failure DOES write `androidTest-results` XML with the failing testcase, which the walker reads → `setup_failed:false` + correct count. No code change. (Also corrected the record: the #282 capture wet-validation ran against a *compile* failure, not a runtime test failure — capture still fired + landed artifacts correctly, post-hoc, but the screenshot was the device home screen, not a torn-down app.) Kept for traceability per the DROPPED-section convention.
- **Configurable output root for all kmp-test-runner artifacts (IDEA — viability: HIGH, checked 2026-06-07).** Requested 2026-06-07. Today every runtime artifact lands under `<projectRoot>/.kmp-test-runner/` — aggregated reports + coverage, per-module logs/logcat/errors, android capture artifacts, benchmark logs, isolated gradle cache, gradle init-scripts, project-model cache — plus the root-level `.kmp-test-runner.lock`. A consumer on a **corporate repo may not want ANY kmp-related path in the project tree / `.gitignore`**. Goal: a single lever to relocate kmp's *own* output tree (e.g. to an absolute path outside the repo such as `~/.cache/kmp-test-runner/<project>` or `/tmp/...`), so the project stays clean with zero `.gitignore` entries. **Viability — HIGH:** the ~6 callsites all hardcode `path.join(projectRoot, '.kmp-test-runner', …)` with **no shared helper today** — `lib/project/cache.js` (`cache`), `lib/orchestrators/orchestrator-utils.js` (`cache-isolated/<runId>` + `init-scripts`), `lib/orchestrators/coverage-orchestrator.js` (`reports/coverage`), `lib/orchestrators/benchmark-orchestrator.js` (`logs/benchmark/<runId>`), `lib/orchestrators/android-orchestrator.js` (`logs/android/<runId>`), `lib/runners/lockfile.js` (`.kmp-test-runner.lock`). No `--output-dir` / `outputDir` / `KMP_TEST_OUTPUT_DIR` exists yet (verified). **Proposed shape:** one resolver `resolveOutputRoot({projectRoot, opts, config, env})` → default `<projectRoot>/.kmp-test-runner`, overridable via `--output-dir <path>` + env `KMP_TEST_OUTPUT_DIR` + `.kmp-test-runner.json` `outputDir` + Gradle DSL `outputDir`, threaded through those callsites. Reuses the existing precedence chain (CLI > env > project-local > user-global > built-in — `lib/project-config.js` + `lib/user-config.js`). Relative resolves against `projectRoot`, absolute used verbatim (mirrors `--output-file` / `--capture-dir`); per-type overrides (`--output-file`, `--capture-dir`, `--isolated-cache-dir`) keep winning (most-specific). **Open decisions (plan mode):** (1) the `.kmp-test-runner.lock` lockfile — move with the tree, or stay anchored to `projectRoot` (it's the cross-invocation concurrency key; likely stays at root so two runs of the same project still collide even with redirected outputs)? (2) the config FILE `.kmp-test-runner.json` is INPUT → stays at root by definition (it's where `outputDir` is declared). (3) **OUT OF SCOPE:** Gradle's own coverage XML under `module/build/reports/…` — kmp *reads* it, doesn't control where gradle writes it (already gitignored as `build/`; redirect gradle scratch via `GRADLE_USER_HOME` / `KMP_TMPDIR` if ever needed). Own PR. Milestone unassigned — user's call.
- **macOS validation gate for the FULL 2026-06-09 audit (HIGH + MEDIUM + LOW) → then release. (NEXT — user's macOS session.)** Everything from the audit now sits on `develop` unreleased: the HIGH+MEDIUM train (PRs #293–#302) plus the LOW-tier train (PRs #303–#311, entries below). Before cutting the release, validate the combined surface on the macOS machine: (1) `node tools/macos-validation-gate.mjs` probe + scoped modes over the usual 3-project matrix; (2) targeted wet checkpoints for the LOW train — dangling-flag rejections (`parallel --isolated-cache-dir` / `--device` dangling → exit 2 envelope, no lockfile left), `benchmark --platform jvm --test-filter X` → skip + `test_filter_unsupported` (and the android leg on a device/emulator), `parallel --skip-tests` → `latest.md` header "No (--skip-tests)", `doctor` `gradle java.home` WARN row on a `~` scratch value, oversized `TEST-*.xml` → `junit_xml_oversized`; (3) the platform legs Windows can't exercise — `--test-type ios` on simulators + `macosArm64Test` + bats-macos; (4) then bump version + CHANGELOG and open the `release: vX.Y.Z` develop→main PR (version number = user's call).
- **Audit 2026-06-09 — LOW-tier findings — ✅ ALL SHIPPED 2026-06-10 (PR train #303–#311: L1 #303, L2 #304, L1-EXT #305, L7 #306, skip-tests header #307, L4 #308, L6 #309, tools edges #310, L3+L5+cleanup #311).** The HIGH+MEDIUM tier shipped earlier as PRs #293–#302 (maxBuffer/spawn_error, dispatcher envelope, atomic lockfile, toml cache-key, artifact sweep + `clean`, diagnostics warnings). Per-finding closure notes below; the train also swept dead params from past iterations (cascade-retry's `runCoverageInjection` passthrough, script-dispatcher's `void autoSelected`, benchmark's never-consumed `config` placeholder, jdk-preflight's ignored `_maxDepth` — each checked for a coherent integration first; none existed):
  - ✅ **L1 — dangling `--isolated-cache-dir` should be `invalid_flag_value` — SHIPPED 2026-06-10 (PR #303).** Implementation upgraded the original two-site shape: (1) **three sites, not two** — `changed-orchestrator.js`'s inline `--isolated-cache-dir` case was a third divergent behavior (isolation silently ON with auto dir) and got the same guard; (2) both parsers return an additive `errors: []` (existing `invalid_flag_value` entry shape) instead of a `dangling:true` boolean, so the cli.js gate and the orchestrator `invalid_*` gates reuse the established contract — no new envelope codes; (3) `parseIsolatedArgs` now expands `=`-forms internally — pre-fix `--isolated-cache-dir=/x` was parsed by NOBODY on runner.js-direct routes (isolation silently no-opped) and `--isolated-cache-dir=` slipped past an undefined-only check. `runAndroid` gained its first invalid-args gate. cli.js rejects via `peekIsolatedFlags().errors` BEFORE the acquireLock decision. +14 vitest (1830→1844, incl. 1 characterization snapshot). Wet on a reference composite: dangling via bin → exit 2 + no lockfile left behind; direct `runner.js parallel` → exit 2; `changed` → exit 2; happy path still isolates with `cache_dir` override.
  - ✅ **L1-EXT — dangling values rejected on EVERY value-bearing flag — SHIPPED 2026-06-10 (this PR).** Extends L1's `--isolated-cache-dir` fix to the whole bug-class: pre-fix every parser silently treated a trailing value-bearing flag as if omitted (`argv[++i] || ''`). New `requireFlagValue(flag, value, errors)` helper in orchestrator-utils (returns the value verbatim incl. `''` so legacy falsy fallbacks survive; pushes `invalid_flag_value` + returns null on `undefined`), applied across parallel/dispatch (13 flags), changed (5), android (8, parser gains its first `errors[]`), benchmark (5), coverage (4), describe (1, folded into the `invalid_regex` gate), update (`--prefix`, parser gains `errors[]` + its first invalid-args gate + the equals-form expansion that orchestrator-only subs never got from cli.js). Deliberate contract flip: `validateEnum`/`validateNonNegativeInt` now treat `undefined` (dangling) as invalid — covers `--test-type/--coverage-tool/--platform/--max-workers/--timeout/--max-failures/--min-missed-lines` at the cli.js pre-spawn loop AND every parser; the 2 unit tests asserting the old "missing, not invalid" semantics were rewritten to the new contract (that flip IS this PR's purpose). `consumeTestFilter` now strips a dangling `--test-filter` and reports it through the same cli.js pre-spawn gate (pre-fix the flag leaked to the wrapper: bash dropped it silently, PowerShell died with an unstructured binding error). Policy boundary: only `undefined` is invalid; explicit `''` keeps each flag's legacy fallback. **Wet-found hole closed mid-PR**: on the Windows CLI route the orchestrator gates were unreachable for string flags — the ps1 wrapper's typed param block died in parameter binding first and the run surfaced as `no_summary` exit 1; new canonical `VALUE_BEARING_FLAGS` list (argv-constants.js) + a cli.js last-token dangling gate reject before the spawn on both OSes (orchestrator guards remain the runner.js-direct defense). +25 vitest. Wet on a reference composite: `parallel --device` / `android --test-filter` → exit 2 with the right `flag` payload; happy-path `--gradle-args` accumulation unaffected.
  - ✅ **L2 — `junit-xml.js` readFileSync without size guard — SHIPPED 2026-06-10 (PR #304).** `forEachJunitXml` now stats every candidate unconditionally (pre-L2 the stat ran only under the `sinceMs` stale-guard) and skips files above a 32 MB default cap, tunable via `KMP_JUNIT_XML_MAX_MB` (mirrors the `KMP_GRADLE_MAXBUFFER_MB` knob shape, warn-once on garbage values). Skips surface as `warnings[].code: "junit_xml_oversized"` ({module, task, file, size_bytes, max_mb}) via an optional side-channel collector param on `junitTestCountFor`/`junitTestFailuresFor` (probe_errors precedent — no return-shape change), deduped by file in `result-rollup.js` because failed tasks walk the same files twice (count + failures). Both warning catalogues updated (docs/envelope-contract.md + skill envelope-schema.md). Bonus: NEW `tests/vitest/junit-xml.test.js` — first direct unit coverage for the parser (~20 cases) + 2 envelope-level cases. The regex shape itself stays as-is (lazy + literal anchor — linear in practice; the "catastrophic backtracking" hypothesis was checked and discarded).
  - ✅ **L3 — `lib/user-config.js` precedence comment reworded — SHIPPED 2026-06-10 (this PR).** The comment claimed `loadMergedConfig` owned a `CLI flag > env var > …` chain; it now states the truth: the merge covers CONFIG layers only (project-local > user-global > built-in), CLI flags win via `cli.js#applyConfigDefaults` re-injection, and env vars are NOT a merge layer (feature-specific, env-first with config-fallback in the orchestrators). Comment-only.
  - ✅ **L4 — `~` in `org.gradle.java.home` is now diagnosed (not expanded) — SHIPPED 2026-06-10 (this PR).** New single-reader helper `readGradleJavaHome(projectRoot)` → `null | {raw, exists, hasTilde}` exported from jdk-preflight.js and consumed by BOTH `preflightJdkCheck` and `lib/commands/doctor.js` (the gradle.properties parse lives in one place). Preflight: `exists` → return null (unchanged); `hasTilde` → one stderr `[WARN] ... Gradle does not expand it; use an absolute path`, then **falls through to the signal-based gate** (deliberately NOT expanded — Gradle itself rejects `~` there, so expansion would suppress kmp-test's gate for a build Gradle rejects anyway; locked by a test that asserts the mismatch gate still fires after the warn). Doctor: new `gradle java.home` row — no row when unset (common case, keeps output focused); WARN on tilde; WARN on set-but-missing path; OK with the path when set+existing. Envelope `warnings[]` deliberately skipped per the validated direction (stderr + doctor; optional follow-up if agent demand appears). +9 vitest (4 helper, 2 preflight, 3 doctor rows).
  - ✅ **L5 — `computeCacheKey` symlink limitation documented — SHIPPED 2026-06-10 (this PR).** Document-only as planned: a known-limitation note above `computeCacheKey` (build files hashed by walked-path content without `realpathSync`; two worktrees sharing gradle sources via symlinks collide on one cache entry — deliberate trade-off, escape hatch `--no-cache`) + a matching bullet in `docs/concurrency.md` "Out of scope".
  - ✅ **L6 — `cascade-retry.js` diagnostic arrays now bounded at push time — SHIPPED 2026-06-10 (PR #309).** Upgraded from the planned "defensive slice" to bounded collection: `critical[]` caps at 50 with a `criticalSuppressed` counter + `(… N more critical lines suppressed — full output in the per-module log)` line (mirrors the tasksRun pattern); `statusNoise[]` became a plain counter (only its `.length` was ever read — holding the lines was pure waste); `tasksRun[]` pushes only while < 30 + a total counter whose suppressed arithmetic is byte-identical to the old `.slice(0, 30)` output. **Bonus: the new tests exposed a latent shadowing bug fixed in the same PR** — the generic `^\s*>\s+\S` continuation arm added 2026-05-03 (PeopleInSpace `> SDK location not found`) lived inside the combined CRITICAL_RE tested FIRST, so it swallowed every `> Task ...` line: the STATUS_RE / TASK_RUNNING_RE branches had been dead since then (invisible while critical emitted uncapped; with the new cap, UP-TO-DATE floods would have EVICTED real diagnostics from the 50-line budget). Classification now runs status-noise → named-critical (catches `> Task :x FAILED` via FAILED$) → task-running → generic continuation, restoring the documented trichotomy. +3 vitest with synthetic gradle floods (>50 critical → ≤50 + suppressed line; 40 task lines → exactly 30 + "10 more" parity; 5 UP-TO-DATE → identical counter text).
  - ✅ **L7 — `benchmark --test-filter` jvm leg emitted gradle `--tests` (kotlinx-benchmark rejects it) — SHIPPED 2026-06-10 (this PR).** Semantics chosen: **warn-and-SKIP**, not warn-and-drop — kotlinx-benchmark has NO CLI/-P filter mechanism (filtering is build-script DSL only), and dropping the filter would dispatch the full unfiltered jvm suite (hours on real composites) that the user explicitly narrowed. New third skip branch in the dispatch loop (mirrors the platform-capability and adb-opt-out skips): jvm (module, platform) cells skip with `skipped[].reason` + `tests.skipped++`, plus ONE aggregate `warnings[].code: "test_filter_unsupported"` ({platform:'jvm', test_filter, skipped_modules}, partial_timeout shape). `buildFilterArgs`'s jvm `--tests` branch now returns `[]` (defensive for direct callers). All-skipped case reuses the existing aggregate machinery: capable modules + all cells intentionally skipped → exit 0 (the KMP_TEST_SKIP_ADB precedent); no capable modules → unchanged `no_test_modules` exit 3. Doc convergence in the same squash: flags-reference `--test-filter` row + benchmark example, benchmarks.md (lead, when-to-use, step 2, common-flags row, resolution section, outer-timeout note, edge case — also anonymized a private project-derived memory-file reference that had slipped into committed text), both warning catalogues. Premise-rewrite of the jvm passthrough vitest (asserted `--tests` — wet-disproven) + 3 new cases. **Follow-up IDEA (parked, fragile)**: real jvm filtering via the existing `.kmp-test-runner/init-scripts` mechanism — an init script could set `benchmark { configurations { include(...) } }` patterns at configuration time, but it depends on kotlinx-benchmark's extension API per version; revisit only on user demand.

- **`buildProjectModel()` failure inside `runCoverage` is silently swallowed, mislabeled as `no_coverage_data` (IDEA — found during PR-17 design 2026-07-13, deferred).** `lib/orchestrators/coverage-orchestrator.js`'s `runCoverage` wraps `buildProjectModel(projectRoot, {...})` in a bare `try {...} catch { /* best-effort */ }`. If it throws (e.g. a probe timeout, malformed project files), `projectModel` stays `null`, `discoverCoverageModules(null, opts)` returns all-empty buckets, and the run falls through to the generic `no_coverage_data` warning — mislabeling "project-model build threw" as "no kover/jacoco configured", sending the user down the wrong troubleshooting path. Not one of PR-17's 3 named issues (threshold/aggregation decoupling, warnings-drop on the `parallel` path, python3 dependency removal); deliberately deferred to keep that PR narrow. **Proposed fix:** capture the caught exception and surface a distinct `coverage_project_model_failed` warning (or a hint appended to the existing `no_coverage_data` message) so the two failure modes are discriminable. Own PR, small — milestone unassigned, user's call.
- ✅ **`ci(review): enable coderabbit reviews for develop`** -- SHIPPED 2026-07-14
  (this PR). Root cause: CodeRabbit's `auto_review` only covers a repo's default
  branch (`main`) unless `base_branches` lists others; every PR here targets
  `develop` (gitflow), so CodeRabbit reported "Review skipped" on all of them. Fix:
  new root `.coderabbit.yaml` with `reviews.auto_review.base_branches: ["develop"]`
  (kept scoped -- no catch-all `".*"`), plus `enabled`/`drafts`/
  `auto_incremental_review`/`review_status` set explicitly. Guarded by a new
  `tests/vitest/coderabbit-config.test.js` (fails without the file, passes with it)
  picked up automatically by the existing required `build` job -- no new CI job. No
  runtime/wet validation applicable (repo-review config only, not CLI behavior).

### Project conventions (do-not-do list)

- **README "What's new in vX" sections** — don't add. Per-version highlight blocks belong in `CHANGELOG.md` only. Removed twice. See `CLAUDE.md` + `feedback_readme_no_whats_new.md`.
- **Milestone decisions belong to the user.** Claude must NEVER create v0.11 or move items to v1.0 unilaterally. On blockers / errors: ASK. See `CLAUDE.md` + `feedback_release_milestone_decisions.md`.
- **CI macOS minutes** — keep heavy mac jobs OFF the per-PR matrix. Per-PR matrix runs only `build (macos-latest)` + `installer-e2e (macos-latest)`. iOS / TestKit / E2E mac runs are manual / `workflow_dispatch` only. See `CLAUDE.md` + `feedback_ci_minutes_minimal_macos.md`.

---

## ACTIVE

### ✅ v0.8 — STRATEGIC PIVOT COMPLETE: orchestration logic migrated bash/ps1 → Node (2026-05-03)

**Status: COMPLETE 2026-05-03.** All 5 sub-entries shipped (PRs #110-#115). Spawn EINVAL fix landed PR #116. Sub-entry-5-followups + bats-macos closure landed PR #118. Total LOC delta: bash + ps1 6,196 → ~470 (12× reduction); new `lib/<feature>-orchestrator.js` aggregate covered by single vitest matrix on Linux+Mac+Windows. Migration is flag-complete (20/20 legacy flags + 4 originally dropped restored in PR #115 follow-up). The "Release readiness gate (post Sub-entry 5)" sub-block below tracks the post-pivot release-validation work; status of each gate updated 2026-05-05.

**Surfaced 2026-05-02 during the WS-2 / PR #105 firefighting session, after stepping back from "another Bash 3.2 patch" thinking.** Historical context preserved below for rationale + per-feature migration plan that drove PRs #110-#115. ~~Active~~ entries marked complete inline.

**Diagnosis of the maintenance trajectory:**

The repo has invested 3 PRs in this session alone (#102 SKIPPED_MODULES unbound, #103 WS-1/WS-5/UX-1/UX-2 task-not-found + target filter, #105 WS-2 declare -A + 2 surfaced empty-array landmines) plus the original v0.7.0 18-entry sourceSet walker — all on bash-side bug classes that **shellcheck does not catch**. Of the 11 wide-smoke bugs WS-1..WS-10 + UX-1/UX-2, 7 remain (WS-3, WS-4, WS-6, WS-7, WS-8, WS-9, WS-10) plus jvm()→jvmTest discovery. Every one of them lives in `scripts/sh/run-*.sh` or `scripts/ps1/run-*.ps1`. Same pattern: discover modules, dispatch parallel, parse output, aggregate summary — implemented twice (bash + ps1) with subtly different gotchas in each dialect.

The `bats-macos` job added in PR #105 to close the Bash 3.2 parity gap hit the adb-orphan flake on macos-latest in 2/2 runs. Validating bash-side fixes requires coming to mom's MacBook (the repo owner's primary machine is Windows). The cycle is: write fix on Windows → push to a Mac → smoke → discover the next bash-3.2 gotcha → repeat.

**The asymmetry that breaks this open:**

The product's value-add (per `README.md:5-123`) is the `--json` envelope — 13K → 100 token reduction for AI agents, ~542K → ~500 tokens for the coverage 5-iter loop. **That value lives entirely in Node** (`lib/cli.js` parser + envelope shaping, `lib/project-model.js` fast path, `lib/jdk-catalogue.js` multi-JDK selection, `tests/vitest/*` coverage). The bash + ps1 scripts are plumbing that invokes gradle and prints lines that Node then parses back. **The plumbing has no value the user pays for.**

**Decision: incremental migration of orchestration logic from bash/ps1 → Node. Bash and ps1 become thin gradle invokers (target: ≤100 LOC each, no associative arrays, no parallel loops).**

**Why this is the right move for this product (vs the alternatives considered):**

| Alternative considered | Rejected because |
|---|---|
| Keep bash + invest in custom shellcheck rules | Doesn't address triple maintenance; every feature still doubles. shellcheck custom rules are themselves new maintenance. |
| Hybrid Bash 4+ gate (require `brew install bash`) | Bad UX for an open-source product. "First install brew, then this" loses contributors. Repo owner explicitly retracted this option. |
| Migrate runtime to zsh | ~2000 LOC rewrite, shellcheck doesn't validate zsh, bats is bash-idiom, breaks installer. Larger lift than Node migration with worse outcome. |
| Status quo (keep firefighting) | 7 wide-smoke bugs remain + new ones surface every PR. Trajectory is more PRs not fewer. |
| Greenfield Node rewrite | Months of work, breaks existing user contracts. Migration is incremental — preserves contracts. |

**Why Node migration aligns with product reality (per the answers from 2026-05-02):**

- **Open-source product, every-OS contributor** — Node runs identically on Windows/Linux/macOS; one logic, one test suite (vitest already covers all 3 OSes in `build` matrix).
- **macOS must work on default Bash 3.2** — thin invoker scripts use no Bash-4 features, so this works for free.
- **Repo owner is Windows-primary, mom's MacBook for testing** — Node iteration happens on Windows; comes to Mac only for final smoke. Cuts the iteration cycle massively.
- **AI-agent first-class consumer** — vitest snapshots of envelope shapes catch agent-contract regressions deterministically (vs bats parsing stub gradle output).
- **Producto, no tooling** — defaults must be rock-solid; one Node implementation has fewer surfaces to be flaky than three (bash + ps1 + gradle plugin).

**Required precondition:**

`PRODUCT.md` (or `docs/strategy.md`) drafted in next session that codifies:
- Target user (open-source contributor any OS, with + without AI agents)
- Supported OS matrix (Windows/Linux/macOS, with platform-aware error messages e.g. iOS tests on Windows fail clearly)
- Value prop (token cost reduction via `--json` envelope, measured per README)
- Architecture principle: "logic in Node, plumbing in shell" — every PR justifies itself against this

Once `PRODUCT.md` exists, this entry expands into a per-feature migration plan (see "Approach" below).

**Approach (incremental, per-feature):**

Each feature migrates in a single PR following the same shape:
1. New `lib/<feature>-orchestrator.js` implementing discovery + parallel dispatch + output parsing logic (parsers already partly exist in `lib/cli.js`).
2. `scripts/sh/run-<feature>.sh` and `scripts/ps1/run-<feature>.ps1` shrink to thin wrappers that `exec node lib/runner.js <feature> ...`. Per `PRODUCT.md` architecture principle: ≤100 LOC each (realistic 40-80), no associative arrays, no parallel loops, no output parsing.
3. New `tests/vitest/<feature>-orchestrator.test.js` covers the migrated logic on all 3 OSes (Linux/Mac/Win — the existing `build` matrix).
4. Existing bats + Pester tests of the SCRIPT shrink to "wrapper invokes node correctly" contracts; LOGIC tests live in vitest.
5. `bats-macos` informational job stays during transition (catches Bash-3.2 regressions in remaining `run-*.sh` plumbing); removed in the PR that completes the migration (sub-entry 5).

LOC baseline (source of truth — feeds the per-entry LOC delta below):

| Script                              | LOC    |
|-------------------------------------|-------:|
| `run-benchmarks.sh`                 |   538  |
| `run-benchmarks.ps1`                |   471  |
| `run-changed-modules-tests.sh`      |   292  |
| `run-changed-modules-tests.ps1`     |   314  |
| `run-android-tests.sh`              |   784  |
| `run-android-tests.ps1`             |   649  |
| `run-parallel-coverage-suite.sh`    | 1,685  |
| `run-parallel-coverage-suite.ps1`   | 1,463  |
| **TOTAL bash + ps1**                | **6,196** |

Post-migration target: ~470 LOC of residual shell across 8 wrapper files (12× reduction) + ~1,800-2,400 LOC of new `lib/<feature>-orchestrator.js` covered by a single vitest matrix vs three test runners today.

**Cross-cutting decisions (locked 2026-05-02):**
- Coverage and parallel share the file `run-parallel-coverage-suite.{sh,ps1}` (per `lib/cli.js:45`, `coverage` = `parallel --skip-tests`). Migration is two phased PRs: PR4 extracts the coverage codepath into `lib/coverage-orchestrator.js` (small, low-risk pattern validator); PR5 then migrates the rest into `lib/parallel-orchestrator.js` and the wrapper becomes thin.
- The "4 build-logic backlog entries" bash-side coverage helpers are: `detect_coverage_tool` (sh) + `get_coverage_gradle_task` (sh) + ps1 mirrors of both. Their deletion was deferred from the v0.5.2 Gap A scope reduction; the coverage migration (sub-entry 4) finally executes it.
- WS-8 (`tests.total` = task count) ships as **additive `tests.individual_total`** in v0.8 (no major version bump). CHANGELOG carries a forward-rename note: "v1.0 will rename `tests.total` → `tests.tasks` and promote `tests.individual_total` → `tests.total`." Preserves PRODUCT success criterion 4.

**Migration order with per-feature acceptance criteria** (smallest blast radius first):

---

#### Sub-entry 1 — `benchmark` migration (warm-up; smallest blast radius)

**Migration PR title:** `feat(node): migrate benchmark orchestrator to lib/benchmark-orchestrator.js`

1. **Input contracts (wrapper passes through verbatim):** flags `--project-root`, `--config {smoke|main|stress}`, `--platform {all|jvm|android}`, `--module-filter`, `--include-shared`, `--test-filter`, `--ignore-jdk-mismatch`, `--java-home`, `--no-jdk-autoselect`, `--dry-run`, `--json`, `--force`. Env vars `JAVA_HOME`, `KMP_TEST_SKIP_ADB`, `KMP_GRADLE_TIMEOUT_MS`. No `SKIP_*_MODULES` apply.
2. **Output contract:** preserves the unique top-level `benchmark:{config,total,passed,failed}` envelope field (parsed today by `parseBenchmarkSummary`); preserves per-subcommand envelope `{tests,modules,skipped,coverage,errors,warnings}`. **Adds:** `benchmark.platforms:["jvm","android"]` enum array reflecting which legs ran.
3. **Test plan:** `tests/vitest/benchmark-orchestrator.test.js` snapshots for `--platform jvm` task dispatch, `--platform android` adb resolution + `instrumented_setup_failed` error; contract that no benchmark module → `errors[].code:"no_test_modules"` (NOT `no_summary`); regression that empty result sets do not throw. **e2e on mom's MacBook:** `cd Confetti && kmp-test benchmark --config smoke` exits 0 (today: WS-2 crashes with `declare -A`); `cd PeopleInSpace && kmp-test benchmark --json` round-trips through `JSON.parse`.
4. **Bugs closed by construction:** **WS-2** (`declare -A` Bash 4+ crash on macOS Bash 3.2.57 — JS has no Bash version dependency); empty-array under `set -u` landmines surfaced during PR #105 (same bug class).
5. **LOC delta:** 538 (sh) + 471 (ps1) = **1,009** today → ≤50 + ≤50 wrappers + ~250-350 in `lib/benchmark-orchestrator.js`. **Net: ~-600 LOC (40% reduction).**
6. **Risks / gotchas:** `tests/bats/test-benchmark.bats` + `tests/pester/Benchmark-Detect.Tests.ps1` shrink to wrapper-invocation contracts. Preserve `[OK] / [FAIL]` per-module banner lines (humans grep these). No cross-feature coupling — benchmark dispatches its own `:module:jvmBenchmark` / `:module:android*Benchmark` tasks.

---

#### Sub-entry 2 — `changed` migration

**Migration PR title:** `feat(node): migrate changed orchestrator to lib/changed-orchestrator.js`

1. **Input contracts:** flags `--project-root`, `--include-shared`, `--test-type {all|common|androidUnit|androidInstrumented|desktop|ios|macos}`, `--staged-only`, `--show-modules-only`, `--max-failures`, `--min-missed-lines`, `--coverage-tool`, `--exclude-coverage`, `--exclude-modules`, `--include-untested`, `--test-filter`, `--ignore-jdk-mismatch`, `--java-home`, `--no-jdk-autoselect`, `--no-coverage`, `--dry-run`, `--json`, `--force`. Env vars: benchmark set + `SKIP_DESKTOP_MODULES` / `SKIP_ANDROID_MODULES` / `SKIP_IOS_MODULES` / `SKIP_MACOS_MODULES` / `PARENT_ONLY_MODULES` (consumer-config API per `CLAUDE.md` "Decouple from L0" exemption — must remain stable).
2. **Output contract:** standard envelope. **Adds:** `changed:{detected_modules:[], staged_only:bool, base_ref:"HEAD"}` top-level field giving agents structured visibility into git-diff-to-module mapping. **Adds discriminator:** `errors[].code:"no_changed_modules"` (clean zero-set, distinct from `no_test_modules` "filter rejected everything").
3. **Test plan:** `tests/vitest/changed-orchestrator.test.js` contracts that git-diff-to-module mapping walks all 18 source-set leaves from `lib/project-model.js#sourceSetNames` (the v0.7.0 walker); `--staged-only` uses `git diff --cached`; zero detected modules → `no_changed_modules` + `exit_code:0`. **e2e:** `cd Confetti && touch shared/src/commonMain/kotlin/dev/johnoreilly/confetti/Model.kt && kmp-test changed --show-modules-only --json` → `changed.detected_modules:["shared"]` (today WS-4 reproducer returns `[]`); `cd PeopleInSpace && git stash && kmp-test changed --json` → `errors[0].code:"no_changed_modules"`, `exit_code:0`.
4. **Bugs closed by construction:** **WS-4** (changed does not detect modifications under source-set dirs); **half of UX-1** (modules with `commonTest` but no `jvm()`/`androidTarget()` — emits `skipped[]` with reason instead of dropping silently; full fix in sub-entry 5); jvm()→jvmTest fallback consumed from project-model fix.
5. **LOC delta:** 292 (sh) + 314 (ps1) = **606** today → ≤40 + ≤40 wrappers + ~200-300 in `lib/changed-orchestrator.js`. **Net: ~-280 LOC (46% reduction).**
6. **Risks / gotchas:** `tests/bats/test-changed.bats` shrinks to wrapper contract. **No dedicated Pester test** for `changed` exists today (only implicit via `Invoke-ScriptSmoke.Tests.ps1`); migration adds vitest as primary suite, removing the implicit Pester gap. Preserve `[SKIP] <module>` stdout banners + `--staged-only` semantics + `SKIP_*_MODULES` env API. **Cross-feature coupling:** changed delegates execution to the parallel suite. PR2 keeps the subprocess invocation initially; PR5 refactors to direct in-process call.

---

#### Sub-entry 3 — `android` migration

**Migration PR title:** `feat(node): migrate android orchestrator to lib/android-orchestrator.js`

1. **Input contracts:** flags `--project-root`, `--device <serial>`, `--module-filter`, `--skip-app`, `--verbose`, `--flavor`, `--auto-retry`, `--clear-data`, `--list | --list-only`, `--test-filter`, `--device-task <name>` (KMP `androidLibrary { }` DSL escape hatch), `--ignore-jdk-mismatch`, `--java-home`, `--no-jdk-autoselect`, `--dry-run`, `--json`, `--force`. Env vars: `JAVA_HOME`, `KMP_TEST_SKIP_ADB`, `KMP_GRADLE_TIMEOUT_MS`.
2. **Output contract:** standard envelope; `parseAndroidSummary` (`lib/cli.js:878`) already in Node and stays put. **Adds:** `android:{device_serial, device_task, flavor, instrumented_modules:[]}` top-level field (closes WS-10's empty-name renderer by construction — orchestrator builds the rendered list from the same data the count derives from). Preserves discriminators `instrumented_setup_failed` / `task_not_found` / `unsupported_class_version`.
3. **Test plan:** `tests/vitest/android-orchestrator.test.js` contracts that module detection consolidates through `lib/project-model.js#resolveTasksFor` `deviceTestTask` (same source as `parallel --test-type androidInstrumented` — closes WS-3); `--list-only` never renders empty names (closes WS-10); no adb device → `errors[].code:"instrumented_setup_failed"`, `exit_code:3` (NOT silent pass — per PRODUCT criterion 5); `--device-task` override propagates verbatim. **e2e on mom's MacBook** (S22 Ultra `<device-serial>`): `cd Confetti && kmp-test android --json` → 4 modules detected (matches `parallel --test-type androidInstrumented`); `--list-only` renders 4 non-empty names; `adb kill-server; cd KaMPKit && kmp-test android` → `instrumented_setup_failed`.
4. **Bugs closed by construction:** **WS-3** (`kmp-test android` finds 0 modules where `parallel` finds 4 — single source of truth via project model); **WS-10** (`--list-only` empty-name renderer). **Adb-orphan flake** in `tests/installer/install.bats` on macos-latest may close as a side-effect (orchestrator honors `KMP_TEST_SKIP_ADB=1`); defer formal closure until empirically validated post-migration.
5. **LOC delta:** 784 (sh) + 649 (ps1) = **1,433** today → ≤50 + ≤50 wrappers + ~400-500 in `lib/android-orchestrator.js`. **Net: ~-880 LOC (61% reduction — largest single drop, due to accumulated KMP DSL detection complexity in bash).**
6. **Risks / gotchas:** `tests/bats/test-android.bats` + `test-android-summary-counts.bats` and `tests/pester/Android-Summary-Counts.Tests.ps1` shrink to wrapper contracts. `parseAndroidSummary` + `parseAndroidModuleTableFallback` stay put (orchestrator emits the same banner shape). Preserve `JSON SUMMARY` block on stdout, per-module log files at `<project>/build/logcat/<run-id>/` surfaced via `errors[].log_file` / `logcat_file` / `errors_file` (Bug G v0.5.2), and the `--device-task` escape hatch.

---

#### Sub-entry 4 — `coverage` migration (script not yet thin — see sub-entry 5)

**Migration PR title:** `feat(node): migrate coverage orchestrator to lib/coverage-orchestrator.js`

> Note: `coverage` and `parallel` share `run-parallel-coverage-suite.{sh,ps1}` (per `lib/cli.js:45`, `coverage` = `parallel --skip-tests`). This PR migrates only the coverage-only codepath (`--skip-tests` branch + Kover/JaCoCo discrimination + report aggregation). The wrapper becomes fully thin only after sub-entry 5.

1. **Input contracts:** flags `--project-root`, `--coverage-tool {auto|jacoco|kover|none}`, `--coverage-modules`, `--min-missed-lines`, `--exclude-coverage`, `--output-file <name>` (default `coverage-full-report.md`), `--ignore-jdk-mismatch`, `--java-home`, `--no-jdk-autoselect`, `--no-coverage`, `--dry-run`, `--json`, `--force`. Env vars: same as benchmark.
2. **Output contract:** preserves `coverage:{tool, missed_lines, modules_contributing}`. **Adds:** `coverage.modules_with_kover_plugin:[]` and `coverage.modules_with_jacoco_plugin:[]` (consumes `lib/project-model.js#detectBuildLogicCoverageHints` already there). **Adds:** `warnings[].code:"coverage_aggregation_skipped"` when `--coverage-tool none` (today logged-only).
3. **Test plan:** `tests/vitest/coverage-orchestrator.test.js` contracts that Kover/JaCoCo plugin discrimination consumes existing CONVENTION-vs-SELF detection (v0.6 Bug 6) without behavior change; `--skip-tests` skips the dispatch loop entirely; zero coverage data → `warnings[].code:"no_coverage_data"` (existing v0.5.2 Bug E). **e2e:** `cd Confetti && kmp-test coverage --json` after a prior `parallel` run → `coverage.modules_contributing > 0`, `errors:[]`; `cd KaMPKit && kmp-test coverage --no-coverage --json` → `warnings[0].code:"coverage_aggregation_skipped"`, `exit_code:0`.
4. **Bugs closed by construction:** the **4 bash-side coverage helpers** deferred from Gap A scope-reduction at PR #67 — `detect_coverage_tool` (sh) + `get_coverage_gradle_task` (sh) + ps1 mirrors of both. The legacy chain was kept "load-bearing for projects without a model.json"; `lib/project-model.js` now carries that fallback path, so the helpers can finally be deleted.
5. **LOC delta** (within `run-parallel-coverage-suite.{sh,ps1}` only — script is not yet thin): coverage-specific subset ~300 LOC (sh) + ~280 LOC (ps1) = **~580** today → ~50 LOC of pass-through inside the script + ~150-200 in `lib/coverage-orchestrator.js`. **Net this PR: ~-300 LOC inside the parallel script.**
6. **Risks / gotchas:** `tests/bats/test-coverage.bats`, `test-build-logic-coverage-kind.bats`, `test-build-logic-selective-jacoco.bats` keep their behavioral contracts (project-model JS unchanged) — they shift from "tested via shell stub" to "tested via vitest stub" patterns. Pester equivalents same shape shrink. Preserve `coverage-full-report.md` filename + run-id naming (`coverage-full-report-<id>.md` per v0.3.8 lockfile work) and Markdown report structure (humans render this). **Cross-feature coupling — heavy:** must ship this PR before sub-entry 5; otherwise parallel-orchestrator subsumes everything and there is nothing to migrate.

---

#### Sub-entry 5 — `parallel` migration (largest; completes v0.8 PIVOT)

**Migration PR title:** `feat(node): migrate parallel orchestrator to lib/parallel-orchestrator.js`

1. **Input contracts (full set):** flags `--project-root`, `--include-shared`, `--test-type {all|common|androidUnit|androidInstrumented|desktop|ios|macos}`, `--module-filter`, `--test-filter`, `--max-workers`, `--coverage-tool`, `--coverage-modules`, `--min-missed-lines`, `--exclude-coverage`, `--exclude-modules`, `--include-untested`, `--timeout`, `--ignore-jdk-mismatch`, `--java-home`, `--no-jdk-autoselect`, `--no-coverage`, `--skip-tests` (used by coverage subcommand), `--dry-run`, `--json`, `--force`. Env vars: `JAVA_HOME`, `KMP_TEST_SKIP_ADB`, `KMP_GRADLE_TIMEOUT_MS`, `SKIP_DESKTOP_MODULES`, `SKIP_ANDROID_MODULES`, `SKIP_IOS_MODULES`, `SKIP_MACOS_MODULES`, `PARENT_ONLY_MODULES`, `FRESH_DAEMON`.
2. **Output contract:** full envelope `{tool, subcommand, version, project_root, exit_code, duration_ms, tests:{total,passed,failed,skipped}, modules:[], skipped:[], coverage:{...}, errors:[], warnings:[], gradle_config?:{...}}`. **Critical fix:** `modules:[]` populated when `tests.passed > 0` (closes WS-9 — today empty even on passing runs because the report-builder is keyed off coverage data presence, not test execution). **Additive WS-8 fix:** new field `tests.individual_total` aggregated from junit-XML walk under `<module>/build/test-results/<task>/TEST-*.xml`. `tests.total` keeps task-count semantic untouched (no major bump). **Discriminator fix (UX-2):** message text "No modules found matching filter: *" → "No modules support the requested --test-type=<X>" when filter is `*` AND `--test-type` is the cause. **Discriminator addition:** `errors[].code:"platform_unsupported"` when `--test-type ios|macos` is invoked on Windows/Linux (per PRODUCT.md "platform-aware behavior" bullet 1).
3. **Test plan:** `tests/vitest/parallel-orchestrator.test.js` contracts: `--test-type all` dispatches one set per supported type and aggregates (closes WS-6); `--test-type common` design decision (alias-with-doc OR `--test-type jvm` rename with deprecation; lands in PR description); `tests.individual_total` populates from junit-XML walking (closes WS-8); `modules[]` populated even with zero coverage data (closes WS-9); empty array under strict mode does not throw (locks v0.7.x SKIPPED_MODULES Bash-3.2 fix into JS forever); `--test-type ios` on Linux/Windows → `errors[].code:"platform_unsupported"`. **e2e on mom's MacBook:** `cd Confetti && kmp-test parallel --test-type ios --json` → PASS only on iOS-capable modules + rest emit `skipped[]` with reason "no iosX64()/iosSimulatorArm64() target" (closes UX-1 fully); `cd PeopleInSpace && kmp-test parallel --test-type all` → all 5+ test types invoked (closes WS-6); `cd KaMPKit && kmp-test parallel --test-type common --json` → "No modules support the requested --test-type=common" message text (closes UX-2); `--test-type ios` on Windows host → `errors[0].code:"platform_unsupported"`, `exit_code:3`.
4. **Bugs closed by construction:** **WS-4** (changed delegates to parallel-orchestrator — closed here at the execution layer); **WS-6** (`--test-type all` does not span all types); **WS-7** (`--test-type common` maps to desktopTest — design decision); **WS-8** (additive `tests.individual_total`); **WS-9** (`modules:[]` empty when `tests.passed > 0`); **UX-1** full fix (the partial sub-entry 2 fix at the changed layer becomes complete here); **UX-2** (misleading filter message); **jvm()→jvmTest fallback** (BACKLOG entry 133-162; orchestrator consumes `unitTestTask` from resolved project-model instead of hardcoding `desktopTest`); **PRODUCT charter alignment** via `platform_unsupported` error code.
5. **LOC delta** (residual after PR4 coverage extraction): `run-parallel-coverage-suite.sh` ~1,400 LOC + `.ps1` ~1,200 LOC = **~2,600** at start of PR5 → ≤80 LOC + ≤80 LOC wrappers + ~600-800 in `lib/parallel-orchestrator.js`. **Net this PR: ~-1,740 LOC (largest single migration delta).** **Cumulative across all 5 sub-entries:** bash + ps1 6,196 → ~470 (12× reduction); new `lib/<feature>-orchestrator.js` aggregate ~1,800-2,400 LOC covered by a single vitest matrix on Linux+Mac+Windows. **Net product LOC reduction: ~3,200-3,800 LOC, ~50%, with the bug-prone half eliminated.**
6. **Risks / gotchas:** the largest test surface in the repo lives here. `tests/bats/test-parallel.bats`, `test-parallel-ios-dispatch.bats`, `test-task-not-found.bats`, `test-module-exclusion.bats`, `test-ios-macos-support.bats`, `test-js-wasm-support.bats`, `test-jdk-gate.bats`, `test-deprecation-notice.bats`, `test-gradle-tasks-probe.bats`, `test-version-catalog-alias.bats` and Pester mirrors all shrink to wrapper-invocation contracts. `gradle-plugin/src/test/kotlin/` TestKit suite (9 tests including parameterized `CrossShapeParityTest`) **must not change** — plugin-side contracts (task names, property names, exit codes) stay identical. Preserve all 6 envelope fields (additions OK; renames forbidden without major bump per PRODUCT criterion 4); banner shape `[OK] / [FAIL] / [SKIP]`; lockfile `.kmp-test-runner.lock` shape (already in `lib/cli.js#acquireLock` — preserved by construction); `--coverage-tool auto` Kover/JaCoCo discrimination chain; run-id naming (`gradle-parallel-tests-<id>.log`). **Terminal cross-feature coupling:** this is the LAST migration. After it lands, `bats-macos` informational job can be removed (no remaining Bash plumbing) and `gradle-plugin-test-ios` can be promoted from informational to required (no remaining BSD-vs-GNU shell drift surface).

**Effort:** ~2-4 weeks of focused work (rough). Each feature migration is 1-3 days. Spread across v0.8.0 milestone.

**What this means for pending bugs (WS-3..WS-10, jvm()→jvmTest):**

- **Hold all bash-side patch PRs.** Opening more `fix(...)` PRs for these bugs is patching code that's scheduled for migration.
- The bugs themselves don't disappear — they get fixed AS PART OF each feature's migration PR. Each migration PR description must explicitly note which WS-* / UX-* / discovery bugs it resolves.
- BACKLOG entries below are **not deleted** — they document the bugs to verify against in the migration PR test plans.

**What this means for the `bats-macos` informational job (added PR #105):**

Stays in CI as a regression-guard against Bash 3.2 patterns in the remaining bash plumbing during the transition. Removed in the PR that completes the migration. Adb-orphan flake (separate BACKLOG entry below) gets investigated only if it blocks Mac-side smoke testing of migration PRs.

**Next session start:**

1. Draft `PRODUCT.md` codifying the 5 strategic answers (~30-60 min, repo owner drives, agent listens).
2. Refine this BACKLOG entry into a per-feature migration plan with concrete acceptance criteria.
3. Open first migration PR: `feat(node): migrate benchmark orchestrator to lib/benchmark-orchestrator.js`. Validates the pattern end-to-end before committing to the larger features.

---

#### v0.8.0 — Release readiness gate (post Sub-entry 5) — REVISED 2026-05-05

**Status revised 2026-05-05** after fix-PR-A through fix-PR-F landed. The original 4-gate framing (drafted 2026-05-02 before the 6 fix-PRs surfaced) was more aspirational than realized. Honest status of each gate:

- **Gate 1 — Cross-OS CLI parity workflow (`cross-os-parity.yml`)**: ❌ NEVER IMPLEMENTED. File doesn't exist. Deferred past v0.8.0; the existing 7-required-check matrix (build × ubuntu/win + secrets-scan + gradle-plugin-test + installer-e2e × ubuntu/win + Commit Lint) plus informational bats-macos + build-macos + gradle-plugin-test-ios + installer-e2e-macos provides parity coverage in practice. A dedicated `cross-os-parity.yml` envelope-diff workflow remains a v0.9 candidate.
- **Gate 2 — Cross-platform E2E fixture project**: DEFERRED to v0.8.x/v0.9 (see entry below; ~6-10h fixture + flakiness budget not justified for v0.8.0 given the 6 fix-PRs already absorbed the release-validation budget). The "promoted to release-blocker" claim below is now superseded.
- **Gate 3 — Branch-protection promotions of `bats-macos` + `gradle-plugin-test-ios` to required**: DEFERRED opportunistic. Both jobs are passing reliably (PR #118 closed bats-macos; gradle-plugin-test-ios passes on every recent PR). Promotion is a 1-2h Settings change + verification PR — schedule post-tag.
- **Gate 4 — Wide-smoke release validation on maintainer's macOS**: ✅ DONE via wide-smoke pass-9-mac (PR #129, 2026-05-04). Real iOS/macOS execution validated against a reference KMP composite project + 4 other projects; bucket counts match Win-side baseline.

**Net assessment**: v0.8.0 ships on the existing 7-required-check matrix + the 6 fix-PRs (A-F) + PR7-bis docs polish + PR8 release tag. The original gate framework was retroactively too strict for what v0.8.0 actually delivers (a Node-migration milestone, not an iOS-coverage milestone). The 4 listed items below remain the historical specification of the gate as drafted 2026-05-02; they're tracked individually for v0.9 planning rather than v0.8.0 blockers.

**Original 2026-05-02 specification preserved below for v0.9 planning context:**

Once Sub-entries 1-5 land, the v0.8.0 stamp does NOT ship until the four gates below are green. Surfaced 2026-05-02 during Sub-entry 2 review: PRODUCT.md success criterion #2 ("OS parity. Windows / Linux / macOS all behave identically modulo platform constraints") is enforced today only at the docs-text level — there is no CI workflow that verifies cross-OS parity of the `--json` envelope, and no green CI history for real iOS / macOS test execution on macOS hosts. Without these gates, "iOS works on macOS" rests on the maintainer's local wide-smoke alone, which doesn't survive in green/red CI history.

This entry is the **terminal acceptance criteria** for the v0.8 PIVOT. It is not a sixth sub-entry — Sub-entries 1-5 stand alone. This is the release-readiness work that runs once Sub-entry 5 closes the bash → Node migration.

1. **Cross-OS CLI parity workflow (NEW `cross-os-parity.yml`).** Matrix `{ubuntu-latest, windows-latest, macos-latest}` runs `kmp-test {parallel,changed,coverage,android,benchmark} --json --dry-run` against `tests/fixtures/kmp-cross-platform-e2e/` (see gate 2). For each subcommand, diff the captured envelope across the three OSes modulo an explicit allowlist of platform-specific fields (`android.device_serial`, `errors[].code:"platform_unsupported"` on Win/Linux for `--test-type ios|macos`, OS-specific paths in `project_root`, etc.). Fail the job if any non-allowlisted field diverges. **Effort: ~2-3h** (workflow + diff logic in Node + allowlist documentation). Becomes a **required** check on the v0.8.0 release PR.

2. **Buildable cross-platform E2E fixture promoted from "v0.7.x patch / v0.8.0 minor / v1.0" to v0.8.0 release-blocker.** The "Buildable cross-platform E2E fixture project" entry below (currently scoped flexibly across releases) is reclassified as a v0.8.0 dependency. The fixture under `tests/fixtures/kmp-cross-platform-e2e/` must include real `gradle/wrapper/`, `gradlew[.bat]`, KMP modules with every supported target (`jvm`, `js(IR)`, `wasmJs`, `iosX64+iosSimulatorArm64`, `macosArm64`, `androidLibrary`/`androidTarget`), pinned Kotlin + AGP versions, and a trivial passing test in each test source set. The `e2e (macos-latest)` leg of the new `e2e-cross-platform.yml` workflow boots an iOS simulator and runs `:module:iosSimulatorArm64Test` + `:module:macosArm64Test` for real (not just dispatch). **This is the only place where iOS actually runs in CI.** Effort estimate from the existing entry stands: ~6-10h fixture + flakiness budget.

3. **Branch-protection promotions.** `bats-macos` and `gradle-plugin-test-ios` move from informational to **required** status checks on `develop` and `main`. Promotion criteria: each must be green on at least 5 consecutive PRs after Sub-entry 5 lands (de-flake confidence — the bats-macos hang in `tests/bats/` and the install.bats adb-orphan flake must both be addressed first). The new `cross-os-parity` (gate 1) and `e2e (macos-latest)` (gate 2) jobs also become required at the same promotion. Effort: ~1-2h (manual `Settings → Branches → Edit rule` per CLAUDE.md "Adding a new required check" + verification PR).

4. **Wide-smoke release validation on the maintainer's macOS.** Per existing `feedback_e2e_validate_as_you_go` memory, run all 5 subcommands × `{Confetti, KaMPKit, PeopleInSpace}` × `{--test-type all, androidUnit, androidInstrumented, common, desktop, ios, macos}` matrix on the maintainer's macOS before tagging v0.8.0. This is **in addition to** (not instead of) the synthetic E2E in gate 2 — the synthetic catches deterministic regressions; wide-smoke catches integration-level surprises against real-world projects with pinned dependencies the maintainer doesn't control. Hardware: Galaxy S22 Ultra connected for Android instrumented; iOS 26.4 Simulator runtime; JDK catalogue 11/17/21. Logs preserved on the host machine. Effort: ~2-3h ad-hoc.

**Why this gate exists explicitly (vs leaving Sub-entry 5's existing acceptance line "the largest test surface in the repo lives here" load-bearing):**

- Sub-entry 5 acceptance criteria validate `--test-type ios → PASS only on iOS-capable modules + rest skipped[]`. That's the **detection** path — it doesn't validate that simulator boot + test execution actually work end-to-end on macOS. iOS on macOS could silently regress and Sub-entry 5 vitest + bats would still go green.
- Sub-entry 5 risks-line mention of "`gradle-plugin-test-ios` can be promoted from informational to required" is informational, not a blocking criterion. This entry makes it blocking.
- v0.8.0's pitch is "no more Bash bug class on macOS, OS parity is honest". Without gates 1+2 enforcing in CI, the pitch rests on local wide-smoke that doesn't survive PR rotation.

**Effort total: ~10-15h.** Spread across the v0.8.0 release ramp after Sub-entry 5 merges, before tagging `v0.8.0`. Each gate is independent (can be parallelized across multiple PRs).

**Out of scope for this entry:**
- Promoting `installer-e2e (macos-latest)` to required — it's already required in the existing 7-check matrix.
- Re-using an existing OSS KMP project as the cross-platform E2E fixture — see Buildable cross-platform E2E fixture entry below for that decision.
- ~~New CLI features.~~ **Carve-out (2026-05-03):** the project-level config file entry below (covers `sharedProjectName` + stable defaults) IS in v0.8.0 scope — closing the README ↔ tool surface gap honestly requires it rather than just deleting the misleading flag doc line.

### ✅ DONE 2026-05-04 (PR #130 / f95b57c) — v0.8.0 — Execution-summary classifier under-reports non-JVM test task RUNTIME failures (RELEASE-BLOCKER, surfaced 2026-05-04 wide-smoke pass-9 + Mac/Win post-toolchain-fix re-runs)

**Status: DONE — fix-PR-E shipped 2026-05-04 (PR #130 / `f95b57c`).** Two surgical changes in `executeLeg` (lib/parallel-orchestrator.js): (1) cascade trigger semantic refined to `no_evidence === taskList.length`; (2) post-step-5 alignment rebuilds `execSummary` from `classifyTaskResults` so tasks marked 'failed' get bucketed to `execution.failed` regardless of execMode. 762 → 768 vitest. Live S22 Ultra validated `execution.failed: 0→1` on a private benchmark module's `androidConnectedCheck` task. OS-parity invariant restored (`execution.failed === errors.filter(c='module_failed').length`). Original entry text preserved below for context.

**Status (historical):** OPEN — **RELEASE-BLOCKER for v0.8.0**. Initially scoped to K/N native test tasks only (`macosArm64Test`, `iosX/Sim/ArmTest`). After post-toolchain-fix re-runs of a reference KMP composite project with **device connected** (Win: S22 Ultra, Mac: S25 Ultra), the same classifier gap surfaced on AGP instrumented tasks too: `connectedAndroidDeviceTest` (Mac) and `androidConnectedCheck` (Win). Three task classes confirmed affected; scope is generalized to "non-JVM test task RUNTIME failures".

**Pre-S22/S25 wide-smoke runs always hit the infrastructure-failure path** on `connectedAndroidDeviceTest` (no device → adb returns nothing → gradle aborts pre-test-runner). That output shape the classifier DOES recognize → `execution.failed` was correct. With a real device, the SAME task class fails at the runtime test phase, which uses different output shape → classifier blind, `execution.failed: 0` despite real failures in `errors[]`.

The `[FAIL]`-line fallback catches all three task classes correctly, so end-user envelopes are functionally correct via `errors[]`. Structured `execution.failed` counter is wrong on K/N + AGP instrumented runtime failures.

**Repro envelope from pass-9-mac on a reference KMP composite project (`--test-type=all`):**

```json
{
  "test_type": "macos",
  "exit_code": 1,
  "execution": { "fresh": 1, "up_to_date": 54, "skipped_by_gradle": 7, "failed": 0 },
  "cascade_detected": false
}
```

…paired with the correct error in the same envelope:

```json
{ "code": "module_failed", "module": "<benchmark-module>",
  "task": ":<benchmark-module>:macosArm64Test", "message": "[FAIL] <benchmark-module>" }
```

**Diagnosis:** the execution-summary classifier introduced in PR5 (`1da639b`) parses gradle's task-result output to build the `execution` counter. K/N native test tasks (`macosArm64Test`, `iosSimulatorArm64Test`, `iosX64Test`, `iosArm64Test`) report task results in a shape the classifier doesn't recognize as "failed", so the counter stays at 0. The `[FAIL]`-line fallback (which scans `[FAIL] :module:task` lines) catches the actual failure independently — but only via the fallback path.

**Why Windows could not have caught this:**

K/N `macosArm64Test` requires a macOS host. Windows wide-smoke runs never dispatch the macos leg (gradle refuses to compile the target on Windows). Pass-8 + pass-9 on Windows triaged the reference project's macos leg as never-executed.

**Hypothesis to confirm:**

Same classifier gap likely exists for `iosSimulatorArm64Test` / `iosX64Test` / `iosArm64Test` since they share the K/N test task output shape with `macosArm64Test`. Pass-9-mac on a reference KMP composite project didn't dispatch iOS legs (`skipped[]` = 11 with reason "no ios target") — repro would land on a project with iOS targets (Confetti/KaMPKit candidates).

**Why this matters even though end-user envelope is correct:**

1. **OS parity principle (PRODUCT.md criterion 2):** Win and Mac should report execution counters identically modulo platform constraints.
2. **Defense-in-depth at risk:** if the `[FAIL]`-line scrape ever changes shape (e.g., gradle output format drift in a future AGP/KGP version), the counter being 0 would mask the failure entirely. Right now we have two independent signals; only one is reliable for native legs.
3. **Cascade detection input:** `detectCascadePattern` in tools/wide-smoke-pass-9.mjs reads `execution.failed` as one branch of its derivation. False zero in native legs could yield false cascade verdicts on edge cases (no immediate repro known, but the input-correctness invariant is broken).

**Fix shape (next session):**

1. Identify the K/N task-result line pattern in `lib/parallel-orchestrator.js` that the current classifier misses. Likely the K/N test task summary line uses different formatting than JVM `Test` task output.
2. Extend the execution-summary regex / state-machine to count K/N native test failures into `execution.failed`.
3. Add 2-3 vitest cases covering native task output shapes (use real captured output from a reference KMP composite project pass-9-mac forensic artifacts as fixtures).
4. No envelope-shape change — the `errors[]` fallback continues to work; this is purely about correcting the structured counter.

**Forensic artifacts (Mac-side):**

`.smoke/pass-9-mac-all/{Confetti,KaMPKit,PeopleInSpace,a reference KMP composite project}.{json,out,err,meta.json}` on the Mac. To be published in the follow-up `WIDE-SMOKE-PASS-9-MAC.md` PR.

**Out of scope:**

- Fixing this in a Mac-only patch path. The classifier lives in shared `lib/parallel-orchestrator.js` and should produce identical results on all hosts modulo platform constraints.
- Reworking the dual-signal (`execution` summary + `[FAIL]`-line fallback) architecture. Both signals are valuable; just need to align them on native legs.

---

### ✅ DONE 2026-05-05 (PR #135 / 89e3cba) — v0.8.0 — `--test-filter` on `parallel --test-type androidInstrumented` blindly pushes `--tests` to AGP `connectedAndroidTest` (RELEASE-BLOCKER, surfaced 2026-05-05 a multi-module DI sample live validation)

**Status: DONE — fix-PR-G shipped 2026-05-05.** Live repro on a multi-module DI sample: `kmp-test parallel --test-type androidInstrumented --module-filter benchmark --test-filter <FQN>` → gradle errored `Unknown command-line option '--tests'` → BUILD FAILED in 1s. Audit of `dispatchLeg` (`lib/parallel-orchestrator.js:547-549`) showed `--tests <pattern>` was pushed unconditionally for every leg. JvmTestTask, KotlinNativeTest, KotlinJsTest accept `--tests`; AGP `AndroidConnectedTest` does not — it expects `-Pandroid.testInstrumentationRunnerArguments.{class,method}` (per https://developer.android.com/studio/test/command-line). The dedicated `kmp-test android` and `kmp-test benchmark` subcommands already had the right translation (`lib/android-orchestrator.js#buildFilterArgs` + benchmark-orchestrator); only `parallel` was the gap.

Fix: new `buildFilterArgs(testFilter, testType, projectRoot)` mirrors the android-orchestrator translation. When `testType === 'androidInstrumented'`, the filter resolves through `resolveAndroidTestFilter` + `splitClassMethod` (both already exported from `lib/cli.js`) and emits the canonical `-Pandroid.testInstrumentationRunnerArguments.class=<FQN>` (+ `.method=<m>` when present). All other test types preserve `--tests <pattern>` (regression guard for JVM / K/N / KJS legs). `dispatchLeg` now threads `testType` through to the helper. **+9 vitest cases** (797 → 806 passing): 8 unit tests covering each test type's translation + 1 integration test through `runParallel` confirming the JVM-side `--tests` regression guard at the spawn site. Live verified end-to-end on a multi-module DI sample `:benchmark`: `[PASS] benchmark` with `connected/release/` outputs created (vs the pre-fix BUILD FAILED). Audit of all other gradle args pushed by `dispatchLeg` (`--parallel`, `--continue`, `--max-workers=N`) confirms they are universal gradle CLI flags accepted by every task class — no other JvmTestTask-only flag leaks into the AGP path.

**Side observation (NOT a regression — pre-existing in `kmp-test android` and `kmp-test benchmark`).** The AndroidJUnitRunner method-level filter shape `class=<FQN>` + `method=<m>` (separate `-P` args) is not honored by all instrumented runners — Microbenchmark in particular runs all class methods despite the `method` arg. Repro: live a multi-module DI sample run with `--test-filter "...DiBenchmark.lazyInit_noDeps_daggerB_analytics"` resolved to class+method correctly but 14 of 14 DiBenchmark methods ran instead of 1. The canonical AGP/AndroidJUnitRunner shape that ALWAYS works is the combined `class=<FQN>#<method>` single arg. Tracked under v0.9 follow-up entry below ("parallel parity gap").

---

### ✅ DONE 2026-05-10 (PR #206 / 4d38bee) — post-v0.9 — `kmp-test coverage --skip-tests` doubles the `--skip-tests` flag → ps1 wrapper hard-rejects (surfaced 2026-05-10 PR-09 wet-validation gate)

**Status: DONE — fix shipped 2026-05-10 (PR #206 / `4d38bee` on develop).** Recommended fix candidate (1) landed: `KNOWN_BOOLEAN_FLAGS` Set + `dedupBooleanFlags(args)` helper in `lib/runners/script-dispatcher.js`, called between the `--test-filter` injection and the Win/Unix shell branching. Set covers 24 boolean flags total (defensive for any future `prefix`-injected flag, not just `--skip-tests`). Value-bearing flags (`--module-filter`, `--gradle-args`, …) explicitly excluded — multi-occurrence semantics survive untouched. **+6 vitest cases** (1286 → 1292). Wet smoke green on a private KMP library composite project both for the bug repro path (`coverage --skip-tests --json`) and the canonical path (`coverage --json`) — byte-identical envelope shape across both, `exit_code: 0`, 62 kover modules. Original entry preserved below for context.

**Status (historical): OPEN, milestone-pending.** Pre-existing — confirmed reproducible at `f0f6f0a` (pre-PR-09 baseline) with byte-identical output. NOT a PR-09 regression. Surfaced incidentally while running the post-PR-09 wet-validation gate against a private KMP library composite project.

**Symptom (Windows + pwsh):**
```
> kmp-test coverage --skip-tests --json --project-root <project>
run-parallel-coverage-suite.ps1: Cannot bind parameter because parameter 'SkipTests' is specified more than once.
```
Exit code 1, envelope `errors[].code = "no_summary"`. Schema shape preserved (sv=2) but the run never executes any work.

**Cause:** `lib/cli.js#COMMANDS.coverage` declares `prefix: ['--skip-tests']` (canonical wire form for the coverage subcommand — coverage always skips tests by definition). The dispatcher concatenates `[...cmd.prefix, ...userArgs]` into `finalArgs` without dedup. When the user passes `--skip-tests` explicitly (as the README example arguably suggests), the kebab→PowerShell translator produces `-SkipTests -SkipTests` and pwsh's parameter-binder fails immediately.

**Fix candidates (one PR):**
1. **Dedup before spawn.** In `lib/runners/script-dispatcher.js` (post-PR-09), filter duplicates from `finalArgs` for known boolean flags (`--skip-tests`, `--include-shared`, `--include-untested`, `--no-coverage`, `--ignore-jdk-mismatch`, `--list-only`, `--no-jdk-autoselect`, `--isolated*`, `--coverage-only`). ~20 LOC + 2 vitest. Lowest risk, fixes the class.
2. **Drop the implicit prefix.** Remove `prefix: ['--skip-tests']` from `COMMANDS.coverage` and require users to pass it themselves. Breaks the contract that `kmp-test coverage` (with no flags) skips tests by default.
3. **README clarification only.** Document that `--skip-tests` is implicit on coverage. Surface-level fix; doesn't address the dedup hole for other flags.

Recommended: (1). Dedup is the right invariant; the underlying class is "user passes a flag the prefix already injects". Same trap could hit `kmp-test parallel --include-shared` (no prefix injection today) or future subcommand prefixes.

**Risk:** LOW. Mechanical fix in a single function. Snapshot suite (PR-00) covers the envelope shape.

**Effort:** ~30 min implementation + smoke wet against a multi-module KMP composite project.

---

### 🅿️ PARKED 2026-05-10 — post-v0.9 — `benchmark --platform jvm --config smoke` against a private KMP library composite project hits inner gradle timeout on a single benchmark module (surfaced 2026-05-10 PR-09 wet-validation gate)

**Status: PARKED 2026-05-10 — project-side bug in the consumer project.** Confirmed by the project owner (2026-05-10): the timing-out benchmark module is a known-broken module in the consumer project; the issue lives there, not in the CLI. The CLI surface is clean (sv=2, canonical `gradle_timeout` envelope, `benchmark.timed_out: 1`, errors[].code populated). The project owner will open a tracking issue against the consumer project separately to investigate the root cause of the benchmark hang. No CLI-side action under this entry — see "IDEA — benchmark gradle_timeout no debe hard-fail con éxito parcial" entry below for the related CLI ergonomics enhancement that emerged from the same triage. Original entry preserved below for context.

**Status (historical): OBSERVATION, milestone-pending.** Pre-existing — output byte-identical between `f0f6f0a` baseline and post-PR-09. NOT a PR-09 regression. The CLI behaves correctly (raises canonical `gradle_timeout` envelope, ec=3, sv=2, `benchmark.timed_out: 1`).

**Symptom:**
```
> kmp-test benchmark --platform jvm --config smoke --json --project-root <project>
# 5m20s wall time, 4/5 modules pass, 1 hits the inner 300000ms (5min) timeout
exit_code: 3
benchmark: { config: "smoke", total: 5, passed: 4, failed: 0, timed_out: 1, platforms: ["jvm"], timeout_ms: 300000 }
errors[]: [{ code: "gradle_timeout" }]
```

**Cause analysis:** the `smoke` config sets the inner per-module timeout to 300000ms = 5min (see `lib/benchmark-orchestrator.js#BENCHMARK_TIMEOUT_DEFAULTS_MS`). One of the 5 jvm benchmark modules in the consumer project legitimately exceeds 5min on this machine. Could be:
- (a) Project-side: that benchmark is genuinely too slow for smoke and should be excluded or moved to `--config main`.
- (b) CLI-side: `smoke` inner timeout is too tight for some real-world projects and should be bumped.
- (c) Both: project tags slow benchmarks + CLI bumps the floor slightly.

**Action: needs user / project owner decision.** This is not a CLI bug per se — the CLI surfaces the timeout cleanly. The question is policy: do we ship with `smoke` = 5min inner, document the constraint, and let users skip slow modules via `--module-filter`? Or do we bump the inner timeout (e.g. to 10min for `smoke`) so loose-tolerance projects pass without filtering?

**Risk if untouched:** users running `benchmark smoke` against projects with long-running benchmarks see flaky timeout failures. Already documented behavior; not a contract violation.

**Effort:** triage only (~10 min) until policy decided. If bump: ~15 LOC in `benchmark-orchestrator.js` + 1 vitest.

---

### ✅ SHIPPED 2026-05-17 (PR 3.2) — `benchmark` partial-success grading: `gradle_timeout` should not hard-fail when N-1 modules passed (surfaced 2026-05-10 during PARKED-bug triage)

**Status: SHIPPED 2026-05-17 (PR 3.2).** Closed as part of the benchmark-cluster fix (A9 + A11 + A10). Recommendation option (b) from this IDEA — graded exit code — implemented as A10's fix in `lib/orchestrators/benchmark-orchestrator.js`. When `totalTimedOut > 0 AND totalPass >= 1 AND !opts.strictTimeouts`, exit code is `EXIT.SUCCESS` (0) and `state.warnings` carries `{ code: 'partial_timeout', timed_out, passed, message }`. New `--strict-timeouts` opt-out flag restores pre-graded hard-fail behavior. 3 vitest cases lock the graded path, strict path, and everything-hung guard.

**Original IDEA below (preserved for context):** Surfaced 2026-05-10 during the PARKED-bug triage above (single benchmark module 5min timeout against a multi-module consumer project). User ask: the CLI shouldn't hard-fail when partial success exists.

**Current behavior** (`lib/benchmark-orchestrator.js:555-559`): any single `totalTimedOut > 0` flips the run to `EXIT.ENV_ERROR` (ec=3), regardless of how many other modules passed cleanly. Repro envelope from the PARKED bug: `passed: 4, failed: 0, timed_out: 1` → ec=3. The user-facing UX is "everything failed" when 80% actually succeeded.

**Decision originally locked at 2026-05-03** (`lib/benchmark-orchestrator.js:556-558` comment block — "BACKLOG #5 line 468 decision"): treat gradle_timeout as ENV_ERROR so agents can disambiguate hung-daemon from failing-tests. That decision is still correct for the all-timeout case but didn't account for partial success.

**Proposal:** grade the exit code by composition:
- ec=0 + `warnings[].code = "partial_timeout"` when `totalTimedOut > 0 AND totalPass >= 1`. Surface `benchmark.timed_out` count in the warning message + envelope intact for inspection.
- ec=3 + `errors[].code = "gradle_timeout"` only when `totalTimedOut > 0 AND totalPass === 0` (current strict behavior preserved for the "everything hung" case).
- New opt-out flag `--strict-timeouts` (or env `KMP_STRICT_TIMEOUTS=1`) for users who prefer the current fail-on-any-timeout shape (CI matrix where any timeout signals infrastructure regression).

**Effort:** ~30 LOC in `benchmark-orchestrator.js` + 2-3 vitest cases (current strict behavior, new partial-success path, opt-out flag). README "Flag reference" + "Exit codes" tables grow 1 row each.

**Open questions for the user when this gets prioritized:**
1. Threshold: `>= 1 passed` vs `>= 50%` vs configurable via flag? Recommend `>= 1` — simpler semantics, easier to reason about; threshold tuning is a slippery slope.
2. Should the same grading apply to `parallel --test-type benchmark` paths or only `kmp-test benchmark`? They share the same `benchmark-orchestrator.js` module, so consistency suggests yes.
3. Does this affect `benchmark` envelope stability for v0.9 consumers? If the new warning-shape is additive (existing `errors[]` codes preserved when ec=3), schema_version stays at 2.

**Risk:** medium-low. New behavior is opt-in by default in the new shape; opt-out flag preserves backwards compat. The semantic shift (ec=3 → ec=0 for partial-success) IS observable from CI scripts that gate on exit code, so document prominently in CHANGELOG when shipped.

**Cross-link:** related to the PARKED bug above — that one is project-side (a benchmark module is genuinely broken in the consumer project); this one is CLI-side ergonomics that would have made the surface less alarming.

---

### ✅ SHIPPED 2026-05-10 (PR #209 / 3824efc on develop) — `tools/decouple-audit.mjs` real CI gate enforcing the privacy rule (surfaced 2026-05-10 during privacy-sweep PR #207)

**Status: DONE.** `tools/decouple-audit.mjs` ships as a CI-required job (`decouple-audit`, branch protection enforced on `develop` + `main` since 2026-05-12). The in-script `PRIVATE_PATTERNS` registry is the canonical pattern list — extended in-place as new private identifiers appear. Original IDEA body preserved below for traceability.

The "Decouple from L0" rule in CLAUDE.md + CONTRIBUTING.md tells contributors private toolkit identifiers / private project names must stay 0-hits across committed text. The rule was historically enforced by a `tools/decouple-audit.mjs` script — but the script never actually existed in the repo (the doc reference was stale; PR #207 dropped it). Without an automated check, the next leak gets caught only by a reviewer's eye.

**Proposal:** create the script as a real CI gate. ~50 LOC ESM module:
- Reads a pattern list (private project / module names, the maintainer's home-dir paths, private package namespaces, etc.). Pattern list lives in the script — sentinel patterns the maintainer can extend without doc changes.
- Walks `git ls-files` (skipping `tools/runs/` and snapshots), greps each file against the patterns.
- Exits non-zero on any hit; prints `<file>:<line>:<match>` to stderr.
- New CI job `decouple-audit` becomes the 13th required check on `develop` + `main`.

**Effort:** ~1h implementation + 30 min wiring CI + branch protection update.

**Risk:** LOW. Pure read-only script; no behavior change. The pattern list is a private maintainer concern, so the script's contents themselves carry the real list — that's fine because the script exists for the maintainer's enforcement, not for outside contributors to extend.

**Why now:** PR #207's leak (the very rule's CLAUDE.md text named the patterns it forbids) is exactly the regression class this gate would have prevented. Closing it before more refactor work lands keeps the privacy invariant honest.

---

### ✅ SHIPPED 2026-05-10 (PR #209 / 3824efc on develop) — `KMP_WORKSPACE` env var documentation for tooling scripts (surfaced 2026-05-10 during privacy-sweep PR #207)

**Status: DONE.** `tools/README.md` documents the `KMP_WORKSPACE` env var contract (override + fallback semantics); the sweep scripts now emit `[NOTICE] WORKSPACE = <resolved-path>` to stderr at startup so the resolved root is unambiguous from the first log line. Original IDEA body preserved below for traceability.

PR #207 parameterised `tools/wide-smoke-pass-*.mjs`, `tools/wet-audit-v0.9.mjs`, `tools/macos-validation-gate.mjs` so they read `WORKSPACE` from `process.env.KMP_WORKSPACE` (with a `path.resolve(process.cwd(), '..')` fallback). The fallback works only if the user invokes the scripts from `tools/`'s parent dir; otherwise the user MUST set the env var. Currently undocumented — a contributor running `node tools/wide-smoke-pass-9.mjs` from any other cwd silently sweeps the wrong directory.

**Proposal:** document the env var contract in one of:
- A new short `tools/README.md` (preferred — keeps tooling docs co-located).
- An entry in `CONTRIBUTING.md` "Local validation" section.
- Both — `tools/README.md` is canonical, `CONTRIBUTING.md` cross-links.

Also: make the scripts emit a `[NOTICE]` log line on startup naming the resolved workspace path so the user immediately sees what's being swept.

**Effort:** ~30 min (docs + the 1-line log mutation).

**Risk:** ZERO. Docs + log line.

---

### ✅ SHIPPED 2026-05-15 (PR #223 / 04c5809 on develop) — `info.jdk.java_home` returns `null` on macOS shells without exported `JAVA_HOME` (surfaced 2026-05-13 during v0.9.1 wet-validation gate)

**Status: DONE.** Shipped Option (b) — product fallback. `lib/info-orchestrator.js` exports `resolveDarwinJavaHome(versionString, spawner)` which spawns `/usr/libexec/java_home -v <major>` on darwin when `process.env.JAVA_HOME` is empty; `reshapeJdk` wires the fallback into the `jdk.java_home` field. Guarded by `platform === 'darwin'`, returns `null` on any spawn error (no regression on Linux/Windows). Original IDEA body preserved below for traceability.

During the v0.9.1 pre-tag wet validation on macOS, `npm test` failed 1/1371 with a snapshot mismatch on `tests/vitest/parity.test.js > info --json --no-adb envelope shape is stable`: snapshot expected `jdk.java_home: "<string>"`, observed `"<null>"`. Root cause: `lib/info-orchestrator.js` reads `process.env.JAVA_HOME` literally and emits `null` when unset; on macOS, users routinely don't export `JAVA_HOME` and rely on `/usr/libexec/java_home` instead. CI always sets `JAVA_HOME` (`setup-java` action), masking the gap. With `JAVA_HOME=$(/usr/libexec/java_home -v 21) npm test` → 1371/1371 green. Not a regression of the v0.9.1 delta — the snapshot predates the 27-commit cycle. But it means anyone running the test suite locally on macOS without explicit `JAVA_HOME` sees a red test, eroding the suite's signal.

**Two independent fixes (either resolves):**

- **(a) Snapshot tolerance — `tests/vitest/parity.test.js`** — relax the `jdk.java_home` placeholder to accept `<string>|<null>`. ~1-line change in the normalizer. Respects the product's "don't lie about what gradle will use" stance but loses regression-detection if `null` leaks in by accident later.
- **(b) Product fallback — `lib/info-orchestrator.js` (and probably `lib/jdk-catalogue.js`)** — when `process.env.JAVA_HOME` is empty AND `process.platform === 'darwin'`, spawn `/usr/libexec/java_home -v <major>` synchronously and use the resolved path. ~5 LOC + one `spawnSync`. The envelope now reflects what gradle will actually use, which is more useful to AI-agent consumers (the prioritized audience per `PRODUCT.md`). Cost: one extra spawn on the `info` / `doctor` critical path.

**Recommendation:** (b). "info says `java_home: null` while JDK 21 is installed and `/usr/libexec/java_home` resolves it cleanly" is poor signal for an AI-agent consumer that's trying to reason about toolchain state.

**Effort:** ~30 min for (a); ~1.5h for (b) including vitest coverage on the darwin fallback path.

**Risk:** (a) LOW — pure test relaxation. (b) LOW — guarded by `platform === 'darwin'`, falls back to existing `null` behavior on any spawn error.

**Why now:** caught by Mac wet validation — the secondary machine is the canonical surfacing point for env-shape gaps that CI masks. The next contributor onboarding on macOS will hit this within their first `npm test`.

---

### ✅ SHIPPED 2026-05-15 (PR #224 / c6aac3e on develop) — `tools/macos-validation-gate.mjs --mode scoped` classifies every wet cell as DRIFT (surfaced 2026-05-13 during v0.9.1 wet-validation gate)

**Status: DONE.** Shipped Option (a) — scoped mode buckets cells on `exit_code === 0 && errors.length === 0` (PASS) vs anything else (ERROR), dropping snapshot comparison entirely for the wet path. `bucketCell` in `tools/macos-validation-gate.mjs` branches on `opts.mode === 'scoped'`. Probe mode still uses the canonical (dry) snapshot baseline. Original IDEA body preserved below for traceability.

During the v0.9.1 pre-tag wet validation, the gate's `--mode scoped` run reported **1 PASS / 28 DRIFT / 1 SKIP** across `--project fixture` + `--project KaMPKit`. Manual inspection of every DRIFT envelope showed `exit_code:0`, `errors:[]`, tests passing — product side fully green. Root cause: scoped mode invokes `kmp-test <sub> --module-filter <m>` (wet — gradle runs) but compares the resulting envelope against `tests/vitest/__snapshots__/parity.test.js.snap`, which was captured invoking with `--dry-run` (parallel/changed) / `--list-only` (android). Structural divergence between wet and dry shapes:

| Path | dry shape (snapshot) | wet shape (scoped run) |
|---|---|---|
| `dry_run`, `plan.{}`, `plan.modules[]`, `plan.script_path`, `plan.spawn_args` | present | absent |
| `parallel.legs[].execution`, `.exit_code`, `.cascade_detected` | absent | populated |
| `android.device_serial`, `.device_task`, `.flavor` | absent (except list-only post-OBS-6) | populated |
| `modules[].test_build_type`, `.has_flavor`, `.android_dsl`, ... | absent (array empty) | populated |
| `coverage.modules_contributing`, `skipped[].module` | absent | populated |

Drift count per cell is **18 missing + 27-36 unexpected paths** — uniform structural noise, not value-difference signal. The `--mode probe` path uses `--dry-run`/`--list-only` so envelopes match the snapshot baseline → 29/29 PASS on the same projects. Historical: v0.9.0 wet-pass (BACKLOG L21) reports "44 PASS / 0 DRIFT / 1 SKIP" — that was **probe mode**, not scoped. Real wet validation for v0.9.0 ran outside the gate (direct gradle invocations on jvm/desktop/iosSim/macosArm64). In other words: the gate's scoped mode **has never given a clean PASS even on a known-green release**, because the comparison infra is structurally misaligned.

**Two fixes (mutually exclusive):**

- **(a) Skip drift detection in scoped mode** — when `opts.mode === 'scoped'`, bucket as PASS iff `exit_code === 0 && errors.length === 0`, FAIL otherwise. Drop the snapshot comparison entirely for scoped. ~10 LOC in `bucketCell` (or equivalent) in `tools/macos-validation-gate.mjs`. Simple, makes scoped useful immediately. Trades structural regression detection for signal clarity.
- **(b) Wet-snapshot baseline** — new `tests/vitest/__snapshots__/parity-wet.test.js.snap` captured from a known-green wet run; gate loads it in scoped mode. ~50-100 LOC + a regenerate workflow + tooling-side normalizer for the wet-only volatility (leg durations, cache hit/up_to_date flags, leg ordering depending on parallelism). Larger lift; higher signal floor; more maintenance burden over time.

**Recommendation:** (a). The value of scoped is "gradle actually starts, legs dispatch, tests pass, envelope builds without throw" — that signal lives in `exit_code` + `errors[]`, not in path-diff against a baseline. The probe path already covers envelope-shape regression detection against the canonical (dry) snapshot.

**Effort:** ~1h for (a) including vitest + a re-run of the v0.9.1 scoped sweep to confirm bucket distribution flips correctly. ~6-8h for (b) with the normalizer + regen tooling.

**Risk:** (a) LOW — narrows what the gate detects but doesn't introduce false positives. (b) MEDIUM — wet snapshots are inherently noisier; risk of flake-driven snapshot churn.

**Why now:** v0.9.1 will tag soon; the next macOS validation gate (v0.10 step 6) will hit the same all-DRIFT result on scoped mode unless this is closed. Without it, every release's wet pass requires manual envelope inspection — defeating the gate's purpose.

---

### ✅ SHIPPED 2026-05-17 (PR 3.1 / d9e414a on feature branch) — `kmp-test --dry-run` envelopes drop subcommand-specific block (surfaced 2026-05-17 during v0.10 #4 PR 3 wet-validation)

**Status: SHIPPED 2026-05-17.** Closed by `feature/v0.10-step-4-pr-3-1-fix-dry-run-envelope` commit `d9e414a`. Both call sites (script-dispatcher short-circuit + orchestrator-direct path) converge on pure builders in `lib/envelope/dry-run-blocks.js`. All 4 affected subcommands (android, benchmark, changed, parallel) now emit their subcommand-specific block on dry-run with empty-but-present default values and flag-echo where the user supplied input. Vitest 1442 → 1510 (+66 new builder tests + 2 new parity snapshots). `envelope-schema.md` "Dry-run envelope" section updated to reflect the post-fix shape (removed the temporary PR 3 callout that documented the drift).

**Status (historical): IDEA, no milestone assigned.** Surfaced 2026-05-17 during the PR 3 (instrumented dual-branch docs) wet matrix — Cell 1b probed `kmp-test android --device <DEVICE_SERIAL> --dry-run --json` and confirmed: real-run + `--list-only` envelopes emit the `android:{device_serial, device_task, flavor, instrumented_modules[]}` block at top-level; `--dry-run` envelopes do NOT. `plan:{...}` + `isolated:{...}` are present, `android:{}` is absent.

**Contract reference:** `references/cli/envelope-schema.md` (PR 2-shipped, now in `.skills/kmp-test-runner/`) "Dry-run envelope" section says "produces the same envelope shape with a top-level `dry_run: true` flag and a `plan{}` block describing what *would* run". "Same envelope shape" includes the subcommand-specific block per the table at L28-36.

**Symptom (live envelope from 2026-05-17 wet probe, project `kmp-cross-platform-e2e` fixture):**
```
{"tool":"kmp-test","schema_version":2,"subcommand":"android","exit_code":0,"dry_run":true,
 "tests":{...},"modules":[],"coverage":{...},"errors":[],"warnings":[],
 "plan":{"spawn_cmd":"pwsh","spawn_args":[...,"--device","<DEVICE_SERIAL>","--module-filter",":benchmark-android-test"],...},
 "isolated":{"enabled":false,...}}
                                              ↑ no "android":{...} field
```

**Impact:** agents reading `android.device_serial` on a dry-run get `undefined`. Workaround currently documented in PR 3's envelope-schema.md callout: parse `plan.spawn_args[]` for the `--device <SERIAL>` token, or use `--list-only` (not `--dry-run`) when the `android:{}` block specifically is needed.

**Question:** is this android-specific or does the same drift affect `benchmark:{}` / `changed:{}` / `parallel:{}` blocks on their respective `--dry-run` envelopes? PR 2's wet audit caught `changed:{}` and `benchmark:{}` drifts inline but the `--dry-run` shape across all 5 subcommand-specific blocks hasn't been audited as a set. Worth a focused investigation pass before fixing.

**Proposal (when prioritized):**
1. Decide policy — dry-run envelope SHOULD or SHOULD NOT emit subcommand-specific blocks. The "same shape" wording in envelope-schema.md implies SHOULD; users may have downstream tooling that assumes the absence (less likely but worth checking).
2. If SHOULD: emit empty-but-present blocks (`android:{device_serial:"",device_task:"",flavor:"",instrumented_modules:[]}`) on all dry-run paths across `lib/orchestrators/android-orchestrator.js` + `parallel-orchestrator.js` + `benchmark-orchestrator.js` + `changed-orchestrator.js` + `coverage-orchestrator.js`. ~5 lines per orchestrator + parity test per subcommand (5 new vitest cases).
3. If SHOULD NOT: drop the "same shape" wording from envelope-schema.md and document the dry-run subset explicitly.

**Effort:** ~2-3h for option 2 (5 orchestrators × ~5 LOC + 5 vitest + audit existing parity snapshots for shape consistency). ~30 min for option 3 (doc-only).

**Risk:** LOW. Option 2 is additive (empty blocks where they're absent today). Agents reading `dry_run.plan.spawn_args` for the device echo continue to work; those who only read `android.device_serial` start working in dry-run mode (currently always undefined).

**Why now:** caught during PR 3 wet matrix; documented conservatively in envelope-schema.md as the fix proxy. Closing the orchestrator drift removes the doc caveat and aligns dry-run with `--list-only` / real-run shape.

---

### ✅ SHIPPED 2026-05-17 (PR 3.3) — `--device <serial>` not propagated to `connectedAndroidDeviceTest` (AGP Managed Devices) → AGP iterates ALL adb devices including offline ones (surfaced 2026-05-17 during v0.10 #4 PR 3 wet-validation parallel session)

**Status: SHIPPED 2026-05-17 (PR 3.3).** Closed via the android device-pin cluster fix (A1 + A5). Implementation in `lib/orchestrators/android-orchestrator.js`: (1) when the resolved task name ends in `connectedAndroidDeviceTest` (regex match), inject `-Pandroid.testInstrumentationRunnerArguments.deviceSerial=<deviceSerial>` into `gradleArgs` BEFORE spawn — the device-test reporter reads this property instead of `ANDROID_SERIAL`. (2) Set `ANDROID_SERIAL` in the spawn env unconditionally when `deviceSerial` resolved (auto-pick or explicit `--device`) — covers legacy AGP `connected{Variant}AndroidTest` paths that honor the env var, fixing the silent device-pin miss on multi-device hosts. Both injections apply to the first-attempt spawn AND the `--auto-retry` re-spawn. 4 vitest cases lock managed-device gradle-property injection / legacy no-property / ANDROID_SERIAL env on explicit pin / ANDROID_SERIAL env on auto-pick. Docs updated under `.skills/kmp-test-runner/references/workflows/instrumented/` + `references/troubleshooting/instrumented-setup-failed/` for both with-CLI and without-CLI branches. Bug #2 (the v0.10 #4 PR 3 wet-validation alias of A1) is also closed by this PR.

**Original BUG below (preserved for context):**

**Status: BUG, no milestone assigned. HIGH severity — selects wrong device / silently fails on test farms with multiple devices.** Surfaced 2026-05-17 by a concurrent `kmp-test android --device <DEVICE_SERIAL> --auto-retry` session on a multi-module KMP library project. Root cause confirmed via user log analysis (A1 in user's bug report 2026-05-17): the orchestrator passes `--device <DEVICE_SERIAL>` to the gradle invocation but does NOT inject `ANDROID_SERIAL` env var or `-Pandroid.testInstrumentationRunnerArguments.deviceSerial=<serial>` into the spawn. AGP's `connectedAndroidDeviceTest` then iterates EVERY device returned by `adb devices` and fails the entire build the moment any one of them is OFFLINE. Evidence from user: "benchmark-network/sdk/storage fallaron con `Skipping device 'emulator-5562' (emulator-5562): Device is OFFLINE`".

**Root cause (confirmed 2026-05-17):** the new KMP `androidLibrary { withDeviceTestBuilder { sourceSetTreeName = "test" } }` DSL (AGP 9+) generates the `connectedAndroidDeviceTest` task instead of the classic `connectedAndroidTest`. The orchestrator's device-task auto-resolution chain (`lib/project-model.js` + `lib/orchestrators/android-orchestrator.js`) eventually resolves to `connectedAndroidDeviceTest` correctly (shape b in the original hypothesis below) — BUT the device-pinning mechanism only sets `ANDROID_SERIAL` for the classic `connectedAndroidTest` path. For `connectedAndroidDeviceTest`, AGP needs the serial via either `-P` property or proper env propagation; without it, the task scans the full adb-visible device set.

**Original hypothesis (now closed — shape b confirmed):**
- (a) Picks the wrong task name (e.g. dispatches `connectedAndroidTest` which doesn't exist) → would surface as `task_not_found` error code. **NOT this — task IS resolved correctly.**
- (b) Picks `connectedAndroidDeviceTest` correctly but doesn't pass the AGP Managed Devices configuration (device pin) the task needs to filter the device set. **CONFIRMED.**
- (c) Skips the module entirely if no probed task matches → silent under-coverage. NOT this.

**Proposed fix:** in `lib/orchestrators/android-orchestrator.js` (and the device-task resolution helper in `lib/project-model.js` if applicable), detect when the resolved task is `connectedAndroidDeviceTest` and:
1. Inject `-Pandroid.testInstrumentationRunnerArguments.deviceSerial=<opts.device>` into the gradle args, OR
2. Set `ANDROID_SERIAL=<opts.device>` in the spawn environment (AGP Managed Devices may also respect this) AND `-P<property>` for redundancy, OR
3. Use AGP's managed-device filter via `-Pandroid.experimental.testOptions.managedDevices.allowOldApiLevelDevices=true` + a per-device-selector argv.

Need to verify which mechanism AGP 9+ actually honors for the `connectedAndroidDeviceTest` task. Likely (1) per the `testInstrumentationRunnerArguments` standard contract.

**Related observations from same wet session (cross-link bugs A5 / A9 / A10 below):**
- A5: `--auto-retry` JSON marks `retried: true` but logs show same duration as single fail → retry doesn't cleanup adb/daemon between attempts (the ghost-device issue persists on retry).
- A9: `kmp-test benchmark` doesn't persist per-task logs (unlike `kmp-test android` which writes `.kmp-test-runner/logs/android/<runId>/<module>.log`) → root-cause investigation requires re-running with verbose flags rather than reading captures.
- A10: `kmp-test benchmark --config smoke` 300s watchdog kills `a long-running benchmark module` (which legitimately takes 5m47s on this machine) → false negatives compound the A1 picture.

**Effort:** ~1h to investigate which AGP mechanism works (build a synthetic Managed Devices fixture in `tests/fixtures/`) + ~1-2h fix + ~30 min vitest cases + ~1h doc update (PR 3 workflow docs gain mention of the third variant + recovery pattern).

**Risk:** LOW-MEDIUM. The fix is additive (current `connectedAndroidTest` path keeps current behavior; only `connectedAndroidDeviceTest` path gains the device-pin propagation). Risk surface: AGP Managed Devices semantics differ across AGP versions (8.x vs 9.x) — need to verify the fix doesn't regress on AGP 8.

**Why now:** caught by a real-world 65-module KMP library project on user's wet-validation pass. The AGP 9+ KMP `withDeviceTestBuilder` DSL is the default for new microbenchmark modules per `androidx.benchmark` 1.2+; under-coverage today silently drops benchmark validation from CI test runs across that growing surface.

**Cross-link to PR 3 docs:** `references/workflows/instrumented/with-android-cli.md` + `without-android-cli.md` "`--device-task` auto-resolution" section currently mentions only `connectedDebugAndroidTest` and `androidConnectedCheck`. After the fix lands, extend to mention `connectedAndroidDeviceTest` (Managed Devices variant) + document `--device-task connectedAndroidDeviceTest` as the manual override + add per-device-pin recovery commands. Plus a new troubleshooting entry under `module-failed.md` (or a dedicated `connected-android-device-test.md` deep-dive) for the "ghost offline device" recovery pattern.

---

### ✅ SHIPPED 2026-05-17 (PR 3.4) — `kmp-test parallel --output-file <name>` flag IGNORED — coverage report written to `.kmp-test-runner/reports/coverage/<timestamp>.md` instead (surfaced 2026-05-17 user wet session — bug A2)

**Status: SHIPPED 2026-05-17 (PR 3.4).** Closed as part of the UX-polish bundle (A3 + A7 + A2 + Bug #3). Recommendation option (a) — path semantics — implemented in `lib/orchestrators/coverage-orchestrator.js` (dropped the `void outputFile` no-op) and `lib/orchestrators/parallel-orchestrator.js` (dropped the stale literal-default guard). `--output-file` is now a PATH: absolute → verbatim; relative → resolved against `--project-root`; omitted or set to the historic sentinel `coverage-full-report.md` → falls back to `.kmp-test-runner/reports/coverage/<runId>.md` with a `latest.md` alias. Custom paths write ONLY the user file (no `latest.md` alias). 6 new vitest cases (5 in `coverage-orchestrator.test.js`, 1 in `parallel-orchestrator.test.js`) plus help text + `.skills/.../cli/flags-reference.md` updates.

**Original BUG below (preserved for context):** User invoked `kmp-test parallel --output-file coverage-full-report.md`; the file at project root with that name (from a 2026-04-02 prior run) was NOT overwritten, and the real report landed at `.kmp-test-runner/reports/coverage/20260517-003209-036004.md` (timestamped path). The flag is documented in `references/cli/flags-reference.md` row "`--output-file <path>` | `coverage-full-report.md` | Markdown report filename inside `.kmp-test-runner/reports/coverage/`."

**Read carefully:** the documented default is "filename INSIDE `.kmp-test-runner/reports/coverage/`" — so the flag is supposed to be a filename, not a path. The user reasonably interpreted it as "path relative to project root" since they explicitly passed a relative path. The fix is one of:
- (a) Treat the value as a path (relative → project-root-relative, absolute → as-is) — matches user expectation. Doc clarifies. Bytes: ~10 LOC + doc + 1 vitest.
- (b) Strictly enforce filename only (reject `/` in value as `invalid_flag_value`), keep the in-reports-dir behavior — strict but breaks the user's reasonable expectation.
- (c) Hybrid: when value contains `/`, treat as full path; when value is a bare filename, place under reports dir. Most ergonomic but the "implicit path-vs-filename detection" is a footgun.

**Recommendation: (a).** Path semantics are what users expect; the timestamped `.kmp-test-runner/reports/coverage/<ts>.md` is a separate concern (audit trail) and should remain regardless of the user-named output.

**Effort:** ~1-2h fix + 2 vitest cases + doc clarification.

**Risk:** LOW. Backwards-compat: pre-fix users who passed bare filenames get a slightly different write location post-fix (now relative to cwd / project root). Document in CHANGELOG when shipped.

---

### ✅ SHIPPED 2026-05-17 (PR 3.4) — Coverage report header mislabels execution mode as "Tests Run: No (--skip-tests)" when tests DID run via `parallel` (surfaced 2026-05-17 user wet session — bug A3)

**Status: SHIPPED 2026-05-17 (PR 3.4).** Closed as part of the UX-polish bundle (A3 + A7 + A2 + Bug #3). Fix threads two new opts (`testsRan: boolean`, `originatingSubcommand: string`) through `runCoverage` → `writeMarkdownReport` in `lib/orchestrators/coverage-orchestrator.js`. `parallel-orchestrator.js` passes `testsRan: true, originatingSubcommand: 'parallel'` on the full-run aggregation path and `testsRan: false, originatingSubcommand: 'parallel'` on the `--skip-tests` early-delegate path. Header now reads `Yes (via parallel)`, `No (--skip-tests)`, or `No (coverage subcommand)` depending on origin; `EXECUTION_MODE` and generator footer mirror the same distinction. 3 new vitest cases assert all three branches end-to-end against the generated markdown.

**Original BUG below (preserved for context):** User ran `kmp-test parallel` (which dispatched tests AND aggregated coverage afterward). The resulting `latest.md` coverage report says `> Tests Run: No (--skip-tests)` and `EXECUTION_MODE: skip-tests` — but tests DID run, the user did NOT pass `--skip-tests`, and the report came from a real `parallel` dispatch, not from `coverage --skip-tests`.

**Root cause hypothesis:** the coverage-report writer at `lib/coverage-*` (likely the markdown emitter) hardcodes `EXECUTION_MODE: skip-tests` when called from any non-parallel-direct path, OR the `parallel`-driven coverage aggregation path mistakenly sets the `skipTests` flag on the report metadata even though tests just ran.

**Impact:** agents and humans reading the report believe it's a re-aggregation snapshot rather than the canonical post-run output. Confusing for triage. Wouldn't surface in any automated test because the report header is human-facing markdown, not envelope JSON.

**Proposed fix:** track the originating subcommand + the `--skip-tests` flag separately. Header line should distinguish:
- "Tests Run: Yes (via parallel)" — when run from `parallel` (or `changed`, `benchmark` with coverage)
- "Tests Run: No (--skip-tests)" — when run from `coverage --skip-tests` explicitly (canonical re-aggregation)
- "Tests Run: No (--coverage-only)" — when run from `parallel --coverage-only`

**Effort:** ~30 min fix + 1-2 vitest cases on the report-writer.

**Risk:** ZERO. Header-text-only change; no functional impact.

---

### ✅ SHIPPED 2026-05-17 (PR #239) — Kover module-count discrepancy: 62 plugins, 58 reports, 2 explicit "No coverage data", 2 unaccounted (surfaced 2026-05-17 user wet session — bug A4)

**Status: SHIPPED 2026-05-17 (PR #239).** Closed as part of the infrastructure bundle (A8 + A4) in `lib/orchestrators/coverage-orchestrator.js`. Implementation adds `coverage.module_buckets: {with_data, no_xml, parse_errored, skipped_by_user}` to the envelope. Bucket-sum invariant fires `warnings[].code: 'coverage_aggregation_drift'` with `{detected, accounted, unaccounted}` counts when accounting drifts. `parseCoverageXml` return shape becomes `{rows, errored}` so the iteration loop distinguishes empty rows from parser failure. `discoverCoverageModules` also returns `skippedByUser`. Dry-run + `--coverage-tool none` envelopes carry empty buckets for shape parity. 3 new vitest cases lock mixed-buckets / parse_errored / dry-run shapes. Wet-validated against a 63-plugin sibling KMP composite: `63 detected = 63 with_data`, invariant holds. Schema unchanged at v2 (additive). Follow-up PR #240 (`fix(envelope): module_buckets in dry-run + error builders`) extended `module_buckets` into `buildDryRunReport` / `envErrorJson` / `buildInvalidArgsEnvelope` to close the dispatcher-level dry-run gap surfaced during wet validation.

**Original IDEA below (preserved for context):** User report: "62 módulos tienen plugin Kover; 58 reportan coverage; 2 explícitamente 'No coverage data' (benchmark-infra, core-result). Faltan 2 módulos en el balance."

**Math check:** 58 (reported) + 2 (explicit no-data) = 60. 62 (plugin applied) - 60 (accounted) = 2 missing.

**Investigation needed:** where do the missing 2 modules go? Three plausible shapes:
- (a) Silently dropped during aggregation (e.g., reading `build/reports/kover/report.xml` fails parse, exception caught → module simply omitted).
- (b) Conditionally excluded by `--exclude-coverage` heuristic the user didn't pass.
- (c) Coverage plugin applied but no test source set → no XML generated; the aggregator counts them under "no data" but the COUNT off-by-2 suggests a code bug in the bucketing.

**Proposed fix:** add explicit per-module bucketing in the aggregator output: `{ with_data: [...], without_data: [...], skipped_by_user: [...], errored: [...] }`. Total must equal `modules_with_kover_plugin.length`. Vitest case ensures invariant holds. If error path exists, surface as a `warnings[].code` so agents can flag the accounting hole.

**Effort:** ~2-3h fix + ~30 min for the bucketing + 1-2 vitest cases.

**Risk:** LOW. Additive surface (no shape change). The error-path-aware bucketing is more honest than silent drops.

---

### ✅ SHIPPED 2026-05-17 (PR 3.3) — `--auto-retry` has no observable cleanup between attempts on instrumented retries → retries fail for the same ghost-device reason (surfaced 2026-05-17 user wet session — bug A5)

**Status: SHIPPED 2026-05-17 (PR 3.3).** Closed via the android device-pin cluster fix (A1 + A5). Implementation in `lib/orchestrators/android-orchestrator.js` `--auto-retry` block: BEFORE the retry `spawnGradle`, run `adb kill-server` then `adb start-server` (gated behind `--auto-retry` → zero impact on happy path). Refreshes the device list so the retry sees an up-to-date device state when the device went offline mid-run. The retry reuses the same `gradleArgs` (with PR 3.3 / A1's device-pin property and PR 3.2's `--isolated` cache-dir) so config stays consistent across attempts. 2 vitest cases lock the kill+start sequence on `--auto-retry` and the NO-OP on the happy path. Pairs with A1 to fully resolve the user's wet-session repro — without A1's device-pin fix, A5's adb refresh alone would still pick the wrong device on the retry.

**Original BUG below (preserved for context):** User report: "En la primera corrida con `--auto-retry`, el JSON los marca `retried: true` pero los logs muestran que el retry duró el mismo tiempo que un fail single y volvió a fallar por la misma causa (ghost device). El retry no incorpora limpieza de adb/daemon entre intentos."

**Root cause hypothesis:** `--auto-retry` re-dispatches the same gradle task with the same args, the same adb state, the same daemon. If the first failure was caused by adb's ghost device list (bug A1), the second dispatch sees the same list and fails identically. The retry is mechanically successful (dispatch happens; envelope marks `retried: true`) but semantically useless for the dominant failure class.

**Proposed cleanup between retries:**
1. `adb kill-server && adb start-server` to refresh the device list (drops ghost-offline entries).
2. Optionally `gradle --stop` to refresh the daemon between attempts.
3. With `--clear-data`: the existing `adb shell pm clear <pkg>` runs per-retry; extend to also call `adb -s <SERIAL> shell pm clear` rather than the global one (per-device cleanup).

**Cross-link:** depends on A1 fix landing first. With A1's device-pin propagation, A5's retry-cleanup gap is much smaller (the dispatch already won't see ghost devices). A5 alone (without A1) is a workaround for A1's symptom. Probably worth treating as one combined fix.

**Effort:** ~30 min after A1 lands; the cleanup steps are conditional on `--auto-retry` already being set.

**Risk:** LOW. `adb kill-server` between dispatches adds ~1-2s; gated behind `--auto-retry` so no impact on the happy path.

---

### ✅ SHIPPED 2026-05-17 (PR 3.4) — `kmp-test doctor` reports "ADB WARN not found" despite local.properties → sdk.dir auto-detect succeeding (surfaced 2026-05-17 user wet session — bug A7)

**Status: SHIPPED 2026-05-17 (PR 3.4).** Closed as part of the UX-polish bundle (A3 + A7 + A2 + Bug #3). Fix in `lib/commands/doctor.js`: when the PATH probe for `adb` fails, re-call the already-imported `inspectLocalProperties(projectRoot)` to resolve `sdk.dir` and try `<sdk.dir>/platform-tools/adb(.exe)`. On hit, emit `OK` with message `via SDK at <path>`; on miss with `sdk.dir` resolved, WARN with explicit `not on PATH and not at <expected-path>` instead of the generic install message. 3 new vitest cases cover PATH-fail+SDK-hit, PATH-fail+SDK-miss, and PATH-OK regression-guard.

**Original IDEA below (preserved for context):** User report: doctor's "ADB" check line says WARN/not-found, but the "Android SDK" check immediately below says OK and auto-detects via `local.properties → sdk.dir`. The two checks disagree on whether ADB is reachable.

**Root cause hypothesis:** the doctor's ADB check probes for `adb` on PATH (or via `$ANDROID_HOME/platform-tools/adb`); the SDK check resolves `sdk.dir` from `local.properties` which gives the SDK root, from which `platform-tools/adb` is reachable as a path but not necessarily on PATH. The two checks operate independently and don't share resolved state.

**Proposed fix:** doctor's ADB check should ALSO probe `<resolved sdk.dir>/platform-tools/adb` (or `.exe` on Windows) and report OK + the absolute path when found. Falls back to the current PATH probe. Message becomes "ADB OK (via SDK at <path>)" or "ADB WARN not on PATH (try `<sdk>/platform-tools/adb`)".

**Effort:** ~30 min in `lib/commands/doctor.js` (or wherever the ADB check lives) + 1 vitest case.

**Risk:** ZERO. Additive probe; existing PATH-only probe remains as fallback.

---

### ✅ SHIPPED 2026-05-17 (PR #239) — `kmp-test update` fails with `release_resolve_failed` on Windows hosts with revoked CA cert in SChannel (surfaced 2026-05-17 user wet session — bug A8)

**Status: SHIPPED 2026-05-17 (PR #239) — diagnostic-only fix.** Closed as part of the infrastructure bundle (A8 + A4) in `lib/orchestrators/update-orchestrator.js`. **Important nuance:** the original BUG hypothesis assumed Windows SChannel cert revocation; investigation showed the orchestrator already uses Node's built-in `fetch()` (undici), NOT curl + SChannel, so the cert path isn't the literal mechanism. The actual fix is the **silent-error-swallowing** that made `release_resolve_failed` opaque: both probe-tier catch blocks now push `{tier, source, message}` entries into a side-channel `probeErrors[]` array; non-throw fallthroughs (no-tag-in-url, !res.ok, prerelease-tag-rejected, tag-rejected) push structured entries too. `runUpdate` threads the array into `envErrorJson`'s existing `extra` parameter, producing `errors[0].probe_errors[]` on the failed envelope. Wet-validated on the originally-affected Windows host: envelope now surfaces `probe_errors: [{tier:1, source:"redirect", message:"fetch failed"}, {tier:2, source:"api", message:"fetch failed"}]` instead of a bare error. 3 vitest cases lock both-tiers-throw, tier-1-no-tag, and tier-2-not-ok paths. A speculative tier-3 `https.get` fallback is **deferred** pending wet evidence that cert validation is the actual root cause — the diagnostic itself may surface a different cause (proxy / DNS / rate-limit / corporate firewall) that the user resolves directly. If a future wet report confirms cert validation as the cause, a tier-3 fallback can ship as a separate follow-up.

**Original BUG below (preserved for context):** User report: `kmp-test update` returns `release_resolve_failed — "Could not resolve latest release for oscardlfr/kmp-test-runner (redirect + API both failed)"`. The user diagnosed it as a Windows SChannel cert revocation issue — `curl` (which the update path likely uses for the GitHub release redirect probe) fails to validate the cert chain, but `npm` and Node fetch (which use the bundled CA bundle, not SChannel) work fine.

**Root cause hypothesis:** the update orchestrator (`lib/commands/update.js` or `lib/update-orchestrator.js`) uses an HTTP client that defers to the OS cert store. On Windows hosts where SChannel has a revoked or stale CA root cert for GitHub's chain (a common transient state), all redirect + API attempts fail with cert-validation errors.

**Proposed fix:** switch the update path's HTTP client to Node's built-in `https` (or `node-fetch`-equivalent) which uses Node's bundled CA bundle, independent of the OS cert store. Specifically:
1. Replace any `curl`/`spawn(curl, ...)` invocations in the update path with `https.get` / `https.request` calls.
2. Ensure the User-Agent header is set (GitHub API requires it for `api.github.com` calls).
3. Honor `KMP_TEST_REGISTRY_STUB` (the env var the parity tests use) so the fix doesn't break the existing test harness.

**Workaround for affected users today:** `npm install -g kmp-test-runner@latest` (npm uses Node's CA bundle). User confirmed this works in their session.

**Effort:** ~2-3h fix + 2-3 vitest cases (cert-failure simulation via stub, success path with redirect chain).

**Risk:** LOW-MEDIUM. The current update path may have other dependencies on curl behavior (timeout semantics, redirect handling); the Node-https replacement needs careful audit. Risk surface: failing curl-style timeouts that the user's CI relied on.

---

### ✅ SHIPPED 2026-06-10 (this PR) — `kmp-test parallel --skip-tests` markdown header says "No (coverage subcommand)" instead of "No (--skip-tests)" (surfaced 2026-05-17 during PR 3.5-train wet validation — Finding #1)

**Status: SHIPPED 2026-06-10 (this PR), as part of the LOW-tier audit train (6/9).** Implemented a refined variant of option (a): the originating sub is threaded via **env var, not a wrapper flag** — `dispatchScriptCommand` adds `KMP_ORIGINATING_SUBCOMMAND: sub` to `spawnOpts.env` (next to the existing `KMP_TEST_RUNNER_EMIT_ENVELOPE` precedent, NOT gated on jsonMode since the markdown header is written in human mode too; zero sh/ps1 edits, dispatcher's LOCKED sequencing untouched), and runner.js's coverage branch reads it **allowlisted** (`'parallel'` else `'coverage'` — a stale exported var can't inject arbitrary header text) before calling `runCoverage`. The early-delegate inside `runParallel` is KEPT (it's the only correct handler for direct `node lib/runner.js parallel --skip-tests` invocations) with its comment corrected — it previously implied it served the standard CLI route, but the wrapper rewrites the sub before runner.js ever runs. +2 vitest at the `runCoverage` level (latest.md header for `originatingSubcommand:'parallel'` vs default; one level above PR 3.4's `writeMarkdownReport`-level cases — a bin-level CI e2e would have been the suite's first python3-dependent test, brittle for a header string; the dispatcher+runner wiring is wet-validated on a reference composite instead). Original entry preserved below for context.

**Original entry:** Wet finding from the PR 3.5-train wet validation matrix. PR 3.4 (A3) added `originatingSubcommand` threading from `parallel-orchestrator.js#runParallel` into `runCoverage` so the markdown header could distinguish "Yes (via parallel)" vs "No (--skip-tests)" vs "No (coverage subcommand)". The fix works at the orchestrator function level (3 vitest cases pass) but the live CLI route `kmp-test parallel --skip-tests` produces header "No (coverage subcommand)" instead of the documented "No (--skip-tests)".

**Root cause:** `kmp-test parallel --skip-tests` dispatches via `lib/commands/parallel.js → dispatchScriptCommand({sub:'parallel'})` → wrapper script (`run-parallel-coverage-suite.ps1 --skip-tests`) → wrapper translates parallel+skip-tests into a `coverage` invocation at the script level → `runner.js sub='coverage'` calls `runCoverage` with default `originatingSubcommand='coverage'`. PR 3.4's threading inside `runParallel` never runs because the script-level translation bypasses it.

**Fix options:**
- (a) Wrapper preserves the original sub: pass `--originating-subcommand parallel` when translating. `runner.js sub='coverage'` consumes it and threads to `runCoverage`. ~15 LOC across runner.js + ps1/sh wrappers + 1 vitest case.
- (b) `kmp-test parallel --skip-tests` routes through `runParallel`'s early-delegate (`parallel-orchestrator.js:263`) instead of through the wrapper-script translation. Cleaner architecturally but larger surface.
- (c) Accept the behavior, update the PR 3.4 closure docs to reflect that "No (--skip-tests)" is the standalone-coverage path, not the parallel+skip-tests path.

**Effort:** (a) ~30 min. (b) ~1-2h plus careful audit of the early-delegate path. (c) doc-only, ~5 min.

**Risk:** ZERO for (c); LOW for (a); LOW-MEDIUM for (b).

**Why now:** caught during the PR 3.5-train wet validation that confirmed all 11 fixes ship behaviorally. This is the only cosmetic gap; ship at user's discretion.

---

### ✅ SHIPPED 2026-05-17 (PR #240) — `kmp-test coverage --dry-run --json` envelope lacks `module_buckets` (surfaced 2026-05-17 during PR 3.5-train wet validation — Finding #2)

**Status: SHIPPED 2026-05-17 (PR #240).** Wet finding from the PR 3.5-train wet validation, fixed in a same-session follow-up. PR 3.5 added `coverage.module_buckets` to `runCoverage`'s success and dry-run code paths, but `kmp-test coverage --dry-run --json` short-circuits in the script-dispatcher BEFORE invoking `runCoverage`. The dispatcher's dry-run uses `buildDryRunReport` from `lib/envelope/builder.js`, which didn't carry `module_buckets`. Fix adds the empty `module_buckets` shape (`{with_data: [], no_xml: [], parse_errored: [], skipped_by_user: []}`) to all 3 envelope builders (`buildDryRunReport`, `envErrorJson`, `buildInvalidArgsEnvelope`) so the contract "`coverage.module_buckets` is always present" holds across success / dry-run / env-error / invalid-args envelopes. 16 snapshot tests updated (additive — no other diffs). Schema unchanged at v2.

**Original FINDING below (preserved for context):** wet validation re-run of `kmp-test coverage --dry-run --json` on the PR 3.5-train wet sweep showed the envelope's `coverage` block missing the `module_buckets` field that the live coverage path emits. The asymmetry would force downstream consumers to optional-chain on dry-run envelopes (`envelope.coverage.module_buckets ?? defaults`) — friction the additive contract was designed to avoid.

---

### ✅ SHIPPED 2026-05-17 — Stale lockfile cleanup + PID-recycle guard (surfaced 2026-05-17 during full-CLI wet validation — Finding #3)

**Status: SHIPPED 2026-05-17.** Wet finding from the full-CLI wet validation (2-occurrence repro in a single session). When `kmp-test benchmark` failed with `module_failed` (exit 1), the lockfile at `<project>/.kmp-test-runner.lock` remained on disk; subsequent runs hit `lock_held` referencing the original PID. Confirmed live: PID 39700 was alive as a `node` process started at exactly the lockfile's `start_time` — either the original benchmark never exited cleanly, OR Windows recycled PID 39700 to a new node process. The pre-fix schema only validates the PID via `process.kill(pid, 0)`, which can't distinguish a still-running original from a recycled-PID impostor.

**Fix:** add stale-by-time / boot-time heuristic to `lib/runners/lockfile.js#acquireLock`. New helper `isLockfileStaleByTime(existing, {now, uptimeMs})` returns true when (a) `existing.start_time` predates the host's last boot (computed from `os.uptime()`), or (b) the lock is older than `STALE_THRESHOLD_MS` (4 hours — well above the upper bound for any legitimate kmp-test run). When either branch fires, `acquireLock` reclaims the lock as `reclaimed: true` instead of returning `lock_held`. The `forced` path now only fires when the PID is genuinely alive AND `--force` was passed (no longer fires for stale-but-recycled PIDs, since those reclaim cleanly without bypass risk). Test surface relocated to `tests/vitest/lockfile.test.js` (extracted from cli.test.js in a separate refactor commit); 7 new vitest cases lock the boot-predate path, the >4h reclaim, the no-false-positive guard, and the four invariants of `isLockfileStaleByTime` itself (null input, predate-boot, age-exceeds, fresh-within-threshold).

**Original FINDING below (preserved for context):** Wet repro in the full-CLI sweep — `coverage --json` ran 3+ hours after a failed benchmark, hit `lock_held` against PID 39700 (started exactly at the original benchmark's lockfile `start_time`, 2026-05-17T14:41:45.821Z). Windows `Get-Process -Id 39700` confirmed a live `node` process at that start time — but the original benchmark had exited 1 ~3 hours earlier. Either the orchestrator's `finally`-block cleanup didn't fire on the failure path, OR the PID got recycled to a coincidentally-matching node process. Either way, the lockfile's PID-only validation is insufficient.

---

### ✅ SHIPPED 2026-05-17 — `kmp-test android --no-adb` hangs indefinitely without `--list-only` / `--dry-run` (surfaced 2026-05-17 during full-CLI wet validation — Finding #4)

**Status: SHIPPED 2026-05-17.** Wet repro: `kmp-test android --no-adb --json --project-root <root>` ran for 4+ minutes without producing output. Root cause: the android orchestrator's `parseArgs` switch statement dropped `--no-adb` via the `default:` arm; the orchestrator proceeded to build the project model + attempt `connectedAndroidTest` dispatch through gradle, which has no fail-fast path for "no device". `--no-adb` is documented as an `info`-subcommand flag ("Skip the ADB probe"), but the script-dispatcher's `KNOWN_BOOLEAN_FLAGS` set permits it through to all subcommands, where android silently inherited it.

**Fix:** `lib/orchestrators/android-orchestrator.js#parseArgs` now recognises `--no-adb` and sets both `noAdb: true` AND `listOnly: true` (instrumented tests fundamentally require adb, so the only sensible behavior on `--no-adb` is list-only — emit the discovered module set without dispatching gradle). The `--list-only` short-circuit (L484) emits a `warnings[].code: "no_adb_implies_list_only"` entry when the path was reached via `--no-adb` (vs explicit `--list-only`), so agents can branch on the implication. Help text in `lib/cli.js` updated to document the implicit-list-only behavior. 2 vitest cases lock the warning + the no-false-positive guard (`--list-only` alone doesn't emit the warning).

**Original FINDING below (preserved for context):** Wet repro in the full-CLI sweep — `kmp-test android --no-adb --json --project-root <kmp project>` was started at 14:58 UTC; PID 42092 still alive 4+ minutes later, lockfile held, zero output. Killed manually via `Stop-Process`. Retake with `--list-only` added returned exit 0 in <1 second. `--no-adb` on android is a footgun for agents probing for metadata without a device — the orchestrator's failure to short-circuit converts a fast envelope-shape query into an indefinite hang.

---

### ✅ SHIPPED 2026-05-17 (PR 3.2) — `kmp-test benchmark` does NOT persist per-task gradle logs (unlike `kmp-test android`) → no post-mortem when benchmarks fail (surfaced 2026-05-17 user wet session — bug A9)

**Status: SHIPPED 2026-05-17 (PR 3.2).** Closed as part of the benchmark-cluster fix (A9 + A11 + A10). Implementation in `lib/orchestrators/benchmark-orchestrator.js`: `safeModuleName` + `defaultRunId` helpers mirror android-orchestrator. Per-(module, platform) gradle stdout+stderr is persisted to `<projectRoot>/.kmp-test-runner/logs/benchmark/<runId>/<module>-<platform>.log` (best-effort). Envelope surface (additive, schema_version unchanged at 2): `benchmark.log_paths: { '<module>:<platform>': '<absolute path>' }` covers all dispatched modules; `errors[i].log_path` inline on `module_failed` + `gradle_timeout` entries for read-time ergonomics. 3 vitest cases lock success/fail/timeout paths.

**Original BUG below (preserved for context):** User report: "A diferencia de android (que crea `.kmp-test-runner/logs/android/<timestamp>/<module>.log`), el subcomando benchmark solo escribe el resumen `2 passed, 8 failed` sin gradle output ni stack traces. No hay forma de diagnosticar fallos post-mortem."

**Reference pattern:** `lib/orchestrators/android-orchestrator.js` writes per-module logs at `<projectRoot>/.kmp-test-runner/logs/android/<runId>/<module>.log` (post-v0.8.0 location). Each log captures the gradle subprocess's full stdout + stderr for that module. Agents and humans can grep these post-run for failure diagnosis.

**Proposed fix:** replicate the android-orchestrator pattern in `lib/orchestrators/benchmark-orchestrator.js`:
1. Create `<projectRoot>/.kmp-test-runner/logs/benchmark/<runId>/` directory on first dispatch.
2. For each (module, platform) gradle spawn, redirect stdout + stderr to `<module>-<platform>.log` (preserving the in-memory capture used for the envelope summary).
3. Surface the log path in the per-module result entry (envelope field `benchmark.legs[].log_path` or per-module in `modules[]`).
4. README updates: "Per-task logs are persisted under `.kmp-test-runner/logs/benchmark/<runId>/` — grep for failures."

**Cross-link bug A10:** A10 (the 300s smoke timeout false-negative) would be vastly easier to diagnose with A9's per-task logs in place. Probably ship A9 BEFORE A10's policy fix (so users have evidence to drive A10's threshold conversation).

**Effort:** ~2-3h fix (mostly mirroring the android-orchestrator code; the writeFileSync + mkdirSync calls + spawn opts plumbing) + ~1h vitest cases (log file creation, log content matches stdout+stderr).

**Risk:** LOW. Pure additive — adds files on disk under the existing `.kmp-test-runner/` directory (already in user `.gitignore` recommendations). No envelope shape change unless we add the `log_path` field (additive — schema doesn't bump).

---

### ✅ SHIPPED 2026-05-17 (PR 3.2) — `kmp-test benchmark --config smoke` 300s watchdog kills legitimate long-running benchmarks → false negatives (surfaced 2026-05-17 user wet session — bug A10)

**Status: SHIPPED 2026-05-17 (PR 3.2).** Closed as part of the benchmark-cluster fix (A9 + A11 + A10). Recommendation option (b) — graded exit code — shipped: when `totalTimedOut > 0 AND totalPass >= 1`, exit `EXIT.SUCCESS` (0) + `warnings[].code='partial_timeout'` aggregate entry (carries `{ timed_out, passed }` counts). When all modules timed out (zero passes), preserved hard fail at exit 3. New `--strict-timeouts` opt-out flag for CI matrix users that need the pre-graded behavior. Per-module `errors[].code='gradle_timeout'` entries stay; the warning layers on top. Same fix as the PARKED-bug IDEA above (now closed as superseded). Options (a) and (c) deferred (not scheduled).

**Original BUG below (preserved for context):** `smoke` config has been the friendly default since v0.7-era; producing false negatives erodes trust in the headline subcommand.** User report: "El benchmark real de a long-running benchmark module tarda 5m 47s (excede los 300s del watchdog). El runner mata/marca FAIL pese a que gradle eventualmente sucede." The user confirmed via direct gradle invocation that `:a long-running benchmark module:desktopSmokeBenchmark` SUCCEEDS in 5m47s when given the time. The other JVM benchmarks in the same batch also failed, possibly for the same reason (not yet verified — the user is waiting for A9's log-persistence fix to investigate).

**Reference:** `lib/benchmark-orchestrator.js` defines `BENCHMARK_TIMEOUT_DEFAULTS_MS = { smoke: 300_000, main: 1_800_000, stress: 3_600_000 }` (L105-109). The 300s smoke ceiling targets "fast feedback for the dev inner loop"; it does not accommodate larger benchmark modules.

**Three independent fixes (any combination):**
- **(a) Bump the smoke default upward** — e.g., to 600s (10min) or 900s (15min). Trade-off: cleaner first-run experience for medium-sized projects vs slower "fast" feedback signal. Reasonable bump: 600s.
- **(b) Implement the PARKED-bug graded exit code** — see existing entry "💡 IDEA — `benchmark` partial-success grading" above. When `total > 0 AND timed_out > 0 AND passed >= 1`, exit 0 with `warnings[].code: "partial_timeout"` instead of exit 3. This converts hard-failures-on-timeout into soft signals while preserving the "everything hung" hard-fail.
- **(c) Per-module timeout override** — `--module-timeout :a long-running benchmark module=600s` flag, or auto-detect from a `.kmp-test-runner/benchmark-timeouts.json` config. Most ergonomic but most complex.

**Recommendation:** ship (b) FIRST (the graded exit code already designed in the PARKED-bug IDEA above) — it changes the headline UX from "everything failed" to "1 of 5 timed out, 4 passed" without bumping the policy. Then evaluate (a) based on broader user reports. Defer (c) to a v0.11 or later milestone (sophisticated per-module config has lots of edge cases).

**Cross-link bug A9:** without A9's per-task logs, A10's affected users can't reliably distinguish "smoke timeout, real benchmark would have passed" from "benchmark genuinely hung". A9 must ship first OR concurrently for A10's fix to be debuggable.

**Cross-link to existing BACKLOG entry:** "💡 IDEA — `benchmark` partial-success grading: `gradle_timeout` should not hard-fail when N-1 modules passed" (above) IS option (b) — these are the same fix. Should merge or cross-link when both are scheduled.

**Effort:** (a) ~15 LOC + 1 vitest. (b) ~30 LOC + 2-3 vitest cases (reuse the IDEA's existing design). (c) ~2-3h.

**Risk:** (a) LOW — wider default doesn't break anyone, just makes some runs slower-to-fail. (b) MEDIUM — exit-code grading is observable from CI scripts; document prominently. (c) MEDIUM — new flag surface, edge cases (whitespace handling, glob support).

---

### ✅ SHIPPED 2026-05-17 (PR 3.2) — `kmp-test benchmark` does NOT propagate `--no-configuration-cache` by default → kotlinx-benchmark stale TEMP path masks as silent 2.2s FAIL (surfaced 2026-05-17 user wet session — bug A11)

**Status: SHIPPED 2026-05-17 (PR 3.2).** Closed as part of the benchmark-cluster fix (A9 + A11 + A10). Recommendation option (a) — default the flag — shipped: `--no-configuration-cache` is now injected into every per-(module, platform) gradle invocation before user `--gradle-args` (so user override `--gradle-args "--configuration-cache"` wins via gradle last-wins). Cost: ~5–10s config-cache miss per benchmark task; trade for reliability. 2 vitest cases lock default-injection and user-override paths. Underlying B5 upstream issue (kotlinx-benchmark caches `%TEMP%`) remains tracked as the IDEA below.

**Original BUG below (preserved for context):** composes with A9 (no per-task logs) to produce silent failures with NO diagnostic surface. User wet session confirmed live 2026-05-17. Stack trace from the underlying failure: `java.io.FileNotFoundException: C:\Users\<user>\AppData\Local\Temp\benchmarks<long-suffix>.txt` at `kotlinx.benchmark.UtilsKt.readFile (Utils.kt:12)` from `JvmBenchmarkRunnerKt.main`. The kotlinx-benchmark gradle plugin caches a path to `%TEMP%` (with a string suffix) in gradle's configuration cache; when Windows cleans `%TEMP%` (boot, idle cleanup), the next build re-uses the cached path but the file no longer exists → `FileNotFoundException`.

**Two related issues stacked:**
1. **Stale-path masking** — kmp-test runs gradle with config-cache enabled (default), so the kotlinx-benchmark stale TEMP path keeps re-firing. Symptom from user envelope: `[FAIL] benchmark-crypto (jvm) failed with exit code 1` in 2.2s, no further detail.
2. **Diagnostic gap** — without per-task logs (bug A9 above), the `FileNotFoundException` never reaches the user; they see only the [FAIL] line.

**User-confirmed workaround:** `kmp-test benchmark --config smoke --platform jvm --module-filter "benchmark-crypto" --gradle-args "--no-configuration-cache"` — runs ~5m47s and SUCCEEDS. The workaround works because the cache is bypassed; kotlinx-benchmark re-resolves a fresh TEMP path each invocation.

**Underlying root cause is project-side (B5):** kotlinx-benchmark itself shouldn't cache a `%TEMP%` path that can be cleared between builds. Fix should land in kotlinx-benchmark (write to `build/benchmarks/` instead — stable, gitignored) OR mark the desktop benchmark tasks with `@DisableCachingByDefault` / `notCompatibleWithConfigurationCache`. But until kotlinx-benchmark fixes that, kmp-test-runner can mitigate at the CLI level.

**Three independent fixes (any combination on CLI side):**
- **(a) Default `--no-configuration-cache` for benchmark dispatch.** Simplest. Cost: ~5-10s per benchmark task (config-cache miss). Reasonable trade for reliability. ~5 LOC in `lib/orchestrators/benchmark-orchestrator.js` to inject the flag into the gradle args before they hit `spawnGradle`.
- **(b) Detect FileNotFoundException in the gradle output stream → auto-retry with `--no-configuration-cache`.** More targeted (no per-run cost when the bug isn't hit). Cost: requires either (i) reading the spawn's stderr inline (current spawnGradle uses synchronous `spawnSync` — needs refactor) OR (ii) post-mortem the captured stderr after exit and dispatch a one-time retry. ~15-20 LOC.
- **(c) Document the flag as obligatory in the benchmark workflow doc + add explicit `errors[].code: "benchmark_config_cache_stale"` discriminator that points the agent at the `--gradle-args` workaround.** ~10 LOC + doc updates.

**Recommendation: (a) — default the flag.** kotlinx-benchmark's bug isn't going away soon; benchmark dispatch is naturally a "spend more time for reliability" workflow; the 5-10s config-cache cost is negligible against the 5+min benchmark runtime. Document the override flag for users who want the cache (`--gradle-args "--configuration-cache"` overrides per gradle last-wins).

**Cross-link bugs A9 + A10:**
- A9 (per-task logs) is a HARD dependency for A11 triage today. Users currently can't diagnose the FileNotFoundException because logs aren't captured. Ship A9 FIRST, then A11's behavior becomes self-documenting (logs show the actual stack trace).
- A10 (smoke 300s watchdog) is upstream of A11 in the failure-mode chain: without A11's fix, all 3 benchmarks fail in 2.2s each (well within the 300s ceiling) so A10 doesn't fire; with A11's fix, the same benchmarks legitimately run 5m+ and A10's ceiling becomes the new bottleneck.

**Effort:** (a) ~30 min + 1 vitest case. (b) ~3-4h + 2-3 vitest cases (stderr-pattern matching, retry-once-with-cache-disabled). (c) ~1h + doc updates.

**Risk:** (a) LOW — kotlinx-benchmark users who relied on config-cache speed lose ~5-10s per benchmark task; documented in CHANGELOG; opt back in via `--gradle-args "--configuration-cache"`. (b) MEDIUM — adds an inline stderr-scan path. (c) ZERO — doc + discriminator only, no behavior change.

**Why now:** caught live on user's wet session; confirmed workaround works. Together with A9 + A10 forms the "benchmark subcommand is unreliable on Windows for typical KMP library projects" issue cluster — closing all 3 makes benchmark a first-class subcommand again.

---

### 💡 IDEA — UPSTREAM ISSUE — kotlinx-benchmark caches `%TEMP%` path in gradle configuration-cache → stale-file FileNotFoundException between runs (surfaced 2026-05-17 user wet session — bug B5, project-side)

**Status: IDEA, no CLI milestone (upstream issue).** Captured here because it affects ALL kmp-test-runner users with kotlinx-benchmark JVM benchmark modules on Windows, not just one project. The actual fix lives in the kotlinx-benchmark gradle plugin (upstream), not in kmp-test-runner. kmp-test-runner mitigates at the CLI level via bug A11 (default `--no-configuration-cache` for benchmark dispatch).

**Symptom (user-confirmed 2026-05-17):**
```
java.io.FileNotFoundException: C:\Users\<user>\AppData\Local\Temp\benchmarks<long-suffix>.txt
  at kotlinx.benchmark.UtilsKt.readFile (Utils.kt:12)
  at JvmBenchmarkRunnerKt.main (line 17)
```

**Root cause:** the kotlinx-benchmark gradle plugin writes a per-benchmark-task scratch file to `%TEMP%` and caches the path in gradle's configuration cache. When Windows cleans `%TEMP%` (boot, idle cleanup, manual cleanup), the cached path points to a file that no longer exists. The next gradle invocation (with config-cache enabled) re-uses the cached path → `FileNotFoundException` → silent 2.2s task failure.

**Upstream fixes (in the kotlinx-benchmark project):**
- (a) Write to `build/benchmarks/<task-id>/` instead of `%TEMP%/` — stable, gitignored, per-project, survives `%TEMP%` cleanup.
- (b) Mark the `desktop*Benchmark` tasks with `@DisableCachingByDefault` or `notCompatibleWithConfigurationCache()` — disables config-cache for these specific tasks; everything else still benefits.
- (c) Validate the cached path exists during task setup; if missing, re-resolve and cache fresh path.

**Upstream tracking:** as of 2026-05-17, no kmp-test-runner-owned issue is filed against `Kotlin/kotlinx-benchmark`. Filing one with the user's stack trace would help upstream prioritization; cross-link to this entry when filed.

**kmp-test-runner mitigation (independent):** see bug A11 above — default `--no-configuration-cache` for `kmp-test benchmark` dispatch. The mitigation lands first since upstream fix timeline is independent; remove the mitigation when kotlinx-benchmark ships any of (a)(b)(c).

**Why captured here:** any kmp-test-runner user running JVM benchmarks via kotlinx-benchmark on Windows is affected. Without this contextual entry, future bug reports of the same shape ("kmp-test benchmark fails in 2.2s on Windows but works on macOS / Linux / with `--no-configuration-cache`") would land in our backlog with no clear root-cause. The entry exists as a navigation aid: "if you see this stack trace, it's B5, mitigated by A11, fix lives upstream."

**Cross-link:** A11 (CLI mitigation), A9 (per-task log persistence — was the diagnostic gap that hid B5's stack trace from the user). All 3 are in the same "benchmark on Windows" recovery chain.

---

### ✅ SHIPPED 2026-06-10 (this PR) — `tools/measure-token-cost.js` `--project-root` silently overridden when `.measurement-projects.json` exists (surfaced 2026-05-19 during v0.10.1 re-measurement)

**Status: SHIPPED 2026-06-10 (this PR), LOW-tier audit train (8/9).** Option (a) implemented: an explicit `--project-root` passes `conventionalPath: null` into `resolveProjectsConfig`, disabling ONLY the gitignored auto-detect; explicit `--projects-config` / `KMP_MEASUREMENT_PROJECTS` still win (deliberate multi-project requests). +1 vitest locks the gating contract. Original entry preserved below.

**Original status: IDEA, no milestone assigned. LOW severity — tooling sharp edge, not user-facing.** Captured during the v0.10.1 token-cost re-measurement: invoking `node tools/measure-token-cost.js --project-root <single-project-path> --feature parallel --runs 1` against the `private-large-A` reference composite silently entered multi-project mode instead and overwrote the v0.10 #7 OSS aggregate file. Root cause at `tools/measure-token-cost.js#main` (line 1135): when the conventional gitignored `tools/.measurement-projects.json` exists, multi-project mode auto-resolves and wins unconditionally over single-project mode — even when `--project-root` is explicitly passed.

**Recommendation:**
- **(a) Single-project wins** when `--project-root` is explicit. Multi-project mode only fires if `--projects-config <path>` / `--features <list>` / `$KMP_MEASUREMENT_PROJECTS` is explicit OR no `--project-root` is passed.
- **(b) Warn-then-proceed**: keep current behavior but emit `[WARNING] --project-root ignored — .measurement-projects.json auto-trigger active, use --no-projects-config to suppress` to stderr so the override isn't silent.
- **(c) Opt-in auto-detect**: rename the conventional path resolution behind `--use-projects-config-default` flag; default mode does NOT auto-resolve. Most surgical.

Option (a) is the least disruptive — `--project-root` is the strongest user signal and should win. (c) is the cleanest long-term contract but breaks any consumer that relied on the auto-detect (none in-tree today).

**Workaround used during v0.10.1:** `mv tools/.measurement-projects.json tools/.measurement-projects.json.hidden` before the single-project run; `mv` back after. Documented in [[project_v0_10_1_shipped]].

---

### ✅ SHIPPED 2026-06-10 (this PR) — `tools/measure-token-cost.js` `runCrossModelMode` segfaults on 74 MB capture (surfaced 2026-05-19 during v0.10.1 re-measurement)

**Status: SHIPPED 2026-06-10 (this PR), LOW-tier audit train (8/9).** Option (a) implemented: `countTokensCl100k(text, {chunkBytes})` chunks above 4 MB (`CL100K_CHUNK_BYTES`) via the existing `splitForAnthropic` record-boundary splitter and sums per-chunk `enc.encode` lengths — same ≤1-token-per-chunk boundary-error argument as the chunked-Anthropic path. The one-off `chunked-count.mjs` workaround approach is now first-class in the tool. +4 vitest (short-circuit identity below threshold, chunked-vs-whole within ±chunks, record-boundary preference, empty/nullish 0). Original entry preserved below.

**Original status: IDEA, no milestone assigned. MEDIUM severity — blocks `coverage` A-row Anthropic counts on large composites in Node v24.** When `runCrossModelMode` re-reads the coverage A capture (74 MB, 28.7 M cl100k tokens) and re-encodes via `countTokensCl100k(cap.text)` at line 1013, Node v24.12.0 segfaults inside `js-tiktoken/lite.cjs#bytePairMerge` (`TypeError: Derived TypedArray constructor created an array which was too small` at smaller chunks; SIGSEGV at larger). The original measurement (`runApproachA`) computes cl100k successfully because it streams the slurp; the cross-model re-read of the full string crashes.

**Workaround used during v0.10.1:** dropped a one-off `tools/runs/chunked-count.mjs` helper that splits the capture at `\n=== <file> ===\n` file-record boundaries (27 chunks @ ~2.6 MiB UTF-8 each), spawns Anthropic `count_tokens` per chunk per model, sums `input_tokens`. cl100k baseline taken from the prior `runApproachA` value (`28,754,177`). Helper deleted post-use; chunked Anthropic counts succeeded for opus / sonnet / haiku.

**Recommendation:**
- **(a) Mirror the chunked path for cl100k too**: when `cap.text.length > CL100K_CHUNK_THRESHOLD` (e.g. 4 MB), split at the same file-record boundaries and `enc.encode(chunk)` each, sum lengths. Same `<0.001% boundary error` argument as the Anthropic chunked path.
- **(b) Bail out early**: when `cap.text.length > THRESHOLD`, skip cl100k re-encode and use the cached value from the previous single-project measurement (re-read from `tools/runs/<feature>/cl100k-baseline.json` if persisted).
- **(c) Upstream patch on js-tiktoken**: file an issue against `Tiktoken/lite.cjs#bytePairMerge` for the TypedArray bounds bug. Likely a 32-bit signed int overflow on the bytePairMerge internal index when input exceeds some threshold.

Option (a) is the safest in-tree fix and matches the existing chunked-Anthropic pattern in the same file. The helper script proved the approach works; promoting it from one-off to `lib/` is ~50 LOC.

**Why this matters:** the `coverage` outlier is the README's headline finding. Future re-measurements with even larger composites (or larger reports) would hit the same crash without the workaround documented somewhere durable.

---

### ✅ DONE 2026-06-07 — Document `NODE_OPTIONS=--use-system-ca` Windows TLS escape hatch in CLAUDE.md / docs

**Fix:** new `docs/troubleshooting-windows.md` (linked from `docs/README.md`) with the `UNABLE_TO_VERIFY_LEAF_SIGNATURE` symptom, the one-line `node -e "fetch(...)"` diagnosis, and the `--use-system-ca` fix (PowerShell session + persist + CMD). Notes which Node tools hit external HTTPS (`update`, `measure-token-cost.js`) and that the core gradle flow is unaffected. Also folded in the shell-script line-ending note. Doc-only.


**Status: IDEA, no milestone assigned. LOW severity — documentation gap, no code change.** Hosts running Windows with corporate TLS interception (corporate AV / proxy SSL inspection) reject Node's bundled CA bundle when validating the Anthropic API certificate. Node's fetch / Anthropic SDK fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. Fix: set `NODE_OPTIONS=--use-system-ca` (Node 22+) to use the Windows trust store, which the corp AV typically populates.

Affects any Node-tool in this repo that hits external HTTPS — `tools/measure-token-cost.js` (Anthropic count_tokens), `lib/orchestrators/update-orchestrator.js` (GitHub Releases probe), `lib/commands/doctor.js` (none currently — but a future doctor probe of `https://api.anthropic.com/health` would inherit the same issue).

**Recommendation:** add a "Windows TLS interception" troubleshooting subsection to `CLAUDE.md` or `docs/concurrency.md` or a fresh `docs/troubleshooting-windows.md`. Cover:
- Symptom: `UNABLE_TO_VERIFY_LEAF_SIGNATURE` or `fetch failed` on first HTTPS call.
- Diagnosis: `node -e "fetch('https://api.anthropic.com/').then(r => console.log('OK')).catch(e => console.log('ERR:', e.cause?.code))"` returns the `UNABLE_TO_VERIFY_LEAF_SIGNATURE` code.
- Fix: `set NODE_OPTIONS=--use-system-ca` (CMD) / `$env:NODE_OPTIONS = '--use-system-ca'` (PowerShell) / persist via `[Environment]::SetEnvironmentVariable('NODE_OPTIONS', '--use-system-ca', 'User')`.
- Why: Node bundles its own CA list, doesn't see the corp AV root cert. System trust store does.

**Why this matters:** caught live during v0.10.1 measurement — without this knowledge the Anthropic API path would have stayed dark for ~30 min of confused debugging.

---

### ✅ DONE 2026-06-07 — Add "cross-project metric labelling" rule to publication checklist (surfaced 2026-05-19 from v0.10.0 → v0.10.1 patch)

**Fix:** added a concise rule to `CLAUDE.md` "Architecture decisions worth knowing" (next to "Keep README clean"): any published `A:C` ratio must take numerator + denominator from the same project/capture; cross-project comparisons must be labelled inline; audit grep provided. Doc/process-only.


**Status: IDEA, no milestone assigned. PROCESS — README publication checklist enhancement, no code change.** v0.10.0's "Large-project ceiling — coverage outlier" headline claimed `85,376× cross-project ratio` by combining `private-large-A`'s 28.7M cl100k A baseline with NowInAndroid's 336 cl100k C envelope. Side-by-side the per-feature drill-down table reported the honest within-private-large-A coverage A:C as `77,114×` (`28,686,309 / 372`). Two different numbers, two different denominators — the cross-project mix was technically labelled in the aggregate doc as `A:C (private-large-A → C-large)` but the README prose presented it as if it were a within-project ratio. The user spotted the inconsistency post-ship; v0.10.1 re-measured and replaced the cross-project number with an honest within-project `39,175× / 29,952× / 30,350×`.

**Recommendation:** add to the README-update checklist (currently encoded in `CLAUDE.md` v0.10 #8/#9 closure pattern + v0.10.1 closure memory):
- **Rule**: any published ratio in the README MUST have numerator and denominator from the same project. No exceptions.
- **Sanity check**: for every `A:C = N×` cell in the README, verify the corresponding `A` and `C` cells come from the same `tools/runs/<feature>/` capture or the same per-project aggregate row. Reject the publish if any cell hybridises projects.
- **Audit pattern**: `grep -nE "(cross-project|→ C-large|cross-bucket)" README.md` — if any hit, the ratio MUST be clearly labelled with explicit "(cross-project — numerator from X, denominator from Y)" prose right next to it.

**Why this matters:** README headlines compound trust. A cross-project mix that looks like within-project erodes credibility once spotted. This is encoded in [[feedback_release_clean_cut_pattern]] follow-up notes; promoting it to BACKLOG makes the checklist surface during every release cycle.

---

### ✅ SHIPPED 2026-05-17 (PR 3.4) — `--isolated` does not bypass project lockfile + `lock_held` error message could be richer (surfaced 2026-05-17 during v0.10 #4 PR 3 wet-validation)

**Status: SHIPPED 2026-05-17 (PR 3.4).** Closed as part of the UX-polish bundle (A3 + A7 + A2 + Bug #3). Both improvements shipped together. Sub-fix (a) — enriched message: `lib/runners/script-dispatcher.js` now lists four recovery options (wait / `--isolated-cache-dir <path>` / different `--project-root` / `--force` with risk callout). Single source of truth — both JSON envelope and stderr block consume the same string. Sub-fix (b) — `--isolated-cache-dir` bypasses the lockfile: `bypassLock = isolatedFlags.noLock || !!isolatedFlags.cacheDir` (mirrors the existing `--isolated-no-lock` implication chain). Pre-flight race audit confirmed SAFE (every report write is `${runId}`-suffixed; cache writes are per-PID atomic via `${cacheFile}.tmp.${process.pid}` + `renameSync`). 3 vitest cases (1 extended `lock_held` envelope assertion requiring all 4 keywords + 2 new for the bypass path and the bare-`--isolated` regression guard). New troubleshooting deep-dive at `.skills/kmp-test-runner/references/troubleshooting/lock-held.md`.

**Original IDEA below (preserved for context):** Surfaced 2026-05-17 during the PR 3 wet matrix when two concurrent `kmp-test android` sessions hit the same project root. Confirmed live: the second invocation (mine, `kmp-test android --device <DEVICE_SERIAL> --module-filter ":benchmark-android-test" --isolated --list-only --json`) was rejected with `errors[0].code: "lock_held"` despite `--isolated`. Error message: `"another kmp-test (android) is already running with PID 15512 (started 4m25s ago). Pass --force to bypass."` — exit 3.

**Behavior is by-design but the user mental-model trap is real.** `--isolated` documents (per `references/cli/flags-reference.md` "Concurrency isolation") as "Tier-3 — `--project-cache-dir <tmp>` for concurrent runs". Users reading "concurrent runs" reasonably infer it enables multi-instance on the same project root. In fact `--isolated` only isolates:
- Gradle config-cache dir (each run gets a private `--project-cache-dir`).
- ADB device-race (combined with `--device <SERIAL>`).

It does NOT isolate the project lockfile (`.kmp-test-runner/.lock`), which is the orchestrator-side serializer that prevents two `kmp-test` processes from racing on the same project's `lib/orchestrators/<orch>.js` state. The lockfile is intentional safety to protect gradle config-cache from cross-process corruption when one process is mid-configure.

**Two improvements (independent, can ship together or separately):**

- **(a) Richer error message.** Current message tells the user `--force` is the only escape — that's incomplete. Add discoverable alternatives:
  ```
  another kmp-test (android) is already running with PID 15512 (started 4m25s ago).
  Recovery options:
    - Wait for the running process to finish (recommended).
    - Pass --force to bypass (risky: cache-corruption window if prior process is still running).
    - Run against a DIFFERENT --project-root (lockfile is per-project; --isolated does NOT bypass it).
  ```
  ~10 LOC change in the lockfile-error helper. Pure message-text rewrite; no behavior shift.

- **(b) Make `--isolated` bypass the lockfile when combined with `--isolated-cache-dir`.** When a user explicitly hands the CLI a fresh cache-dir path, they're declaring isolation intent. The lockfile's job is to protect the SHARED cache-dir; with an explicit cache-dir override the shared cache-dir is no longer at risk. ~5-10 LOC: in the lock-acquisition path, skip lockfile if `opts.isolatedCacheDir` is truthy. New vitest case for the bypass path. Documentation: cross-link from `--isolated-cache-dir` row in flags-reference.md.

  Recommended over option (a) only — gives users a real concurrent-execution path on the same project root, not just better error messaging.

**Cross-link to PR 3 docs:** `references/workflows/instrumented/with-android-cli.md` + `without-android-cli.md` "Edge cases" section already received a clarifying patch in PR 3: "**`--isolated` does NOT bypass the project lockfile**: concurrent runs against the **same** `--project-root` still trigger `lock_held` (exit 3) — `--isolated` isolates cache state, not project ownership. Use `--force` to bypass the lockfile when the prior process is known-dead." That doc clarification stands regardless of which fix lands here.

**Effort:** ~30 min for (a); ~1.5h for (b) including vitest + the `--isolated-cache-dir` interaction sweep.

**Risk:** (a) ZERO — message-only. (b) LOW-MEDIUM — opens a concurrent-on-same-root path. Edge case: two processes both pass distinct `--isolated-cache-dir` paths and the lockfile bypasses correctly, but they may still race on `.kmp-test-runner/reports/` writes (per-module log files, coverage reports). Audit needed.

**Why now:** caught during a perfectly natural multi-agent workflow (two Claude Code sessions, same project, concurrent android dispatch). Multi-instance scenarios are a first-class use-case for agent-driven workflows — every friction point we close compounds.

---

### ✅ SHIPPED — Coverage threshold gate (DONE 2026-05-11 / PR #215)

**Status: DONE.** Original premise (surfaced 2026-05-10 during pre-PR-10 polish triage) was stale: `vitest.config.js` already declared `coverage.thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 }` and `.github/workflows/ci.yml:98` ran `npx vitest run --coverage`. Vitest 2.x auto-enforces `coverage.thresholds` when `--coverage` runs (no `--check-coverage` flag needed — that flag belongs to `c8`/`nyc`); when a threshold is breached, vitest sets `process.exitCode = 1` and the CI step fails. The gate was already live; coverage % could not silently regress below 80%. It just couldn't rise either.

**What this PR does:** measures the actual baseline (develop tip `91b51b0`) and retunes the floor to `max(80, floor(baseline − 2))` per metric — never lowering an existing floor, raising the three that had slack.

| Metric | Baseline | Old floor | New floor | Headroom |
|---|---|---|---|---|
| Statements | 93.89% | 80 | **91** | 2.89pp |
| Branches | 81.82% | 80 | **80** (unchanged) | 1.82pp |
| Functions | 92.91% | 80 | **90** | 2.91pp |
| Lines | 93.89% | 80 | **91** | 2.89pp |

Branches stays at 80 because `floor(81.82 − 2) = 79` would lower the existing floor — a regression in floor protection. The 1.82pp headroom is tighter than the other three but is the price of "no regression."

**Deferred (deliberately, kept here as open questions for a future polish PR):**
- Per-file thresholds (`coverage.thresholds[<glob>]: { ... }`). Today aggregate-only; one file dragging average down is invisible (e.g. `lib/runner.js` shows 0/0/0/0 across 219 lines in the same run — masked by the rest of the codebase).
- Local enforcement via `npm test`. Today `npm test` is `vitest run` (fast, no coverage); `npm run test:coverage` is the enforcing path. CI runs the enforcing path on every PR.

**Risk:** LOW — same shape as the IDEA framing. The gate still fails noisily, not silently.

---

### ✅ SHIPPED — Bundle-size monitoring (DONE 2026-05-11 / PR #216 / 3ce7e29)

**Status: DONE.** Original premise (surfaced 2026-05-10 during pre-PR-10 polish triage) was: `kmp-test-runner` ships as a Node CLI (`npm install -g kmp-test-runner`); the published artefact size was previously unmonitored, so a refactor pulling in heavy transitive deps or unintended files would slip through silently.

**What this PR does:** new `tools/check-bundle-size.mjs` (pure Node ESM, zero deps, mirrors `tools/decouple-audit.mjs` shape) runs `npm pack --dry-run --json` and fails when the would-be-published tarball or unpacked size exceeds named-constant budgets. New `bundle-size` CI job (always-runs, ubuntu-latest, no matrix) at `.github/workflows/ci.yml` after `decouple-audit`. New `npm run size-check` script in `package.json`. `*.tgz` added to `.gitignore` so accidental `npm pack` runs (without `--dry-run`) don't litter the working tree. README "Quick check before a PR" gains one row.

**Baseline measured 2026-05-11 on develop tip `cd719d0`:** tarball 215_614 bytes (210.6 KB) / unpacked 727_541 bytes (710.5 KB) / 76 files. **Budgets:** `tarball_budget = ceil(baseline × 1.25 / 1024) × 1024` → 270_336 bytes (264 KB tarball) / 910_336 bytes (889 KB unpacked) — +25% headroom rounded up to the next KB. Retunable in the script's named constants.

**Cross-platform invocation:** on Windows, Node 20+ refuses to `spawnSync` an `npm.cmd` directly (EINVAL per CVE-2024-27980). The script routes through `cmd.exe /d /s /c` with `windowsVerbatimArguments: true`, mirroring `lib/orchestrators/orchestrator-utils.js#spawnGradle`. Command is entirely static — no injection surface, no `shell: true` (avoids DEP0190).

**Branch-protection follow-up (manual, OWNER action):** add `bundle-size` to the required-status-checks list on both `develop` and `main` (Settings → Branches → Edit rule). Mirrors the pattern from `decouple-audit` (PR #209).

**Verification:** local `node tools/check-bundle-size.mjs` → exit 0. `npm test` → 1295 unchanged. `node tools/decouple-audit.mjs` → exit 0.

---

### ✅ SHIPPED (sweep prior to 2026-05-17) — Explicit `'utf8'` encoding on `writeFileSync` calls in `android-orchestrator.js` (surfaced 2026-05-10 during pre-PR-10 code-quality audit)

**Status: DONE.** All `writeFileSync` callsites in `lib/orchestrators/android-orchestrator.js` (currently lines 731 / 735 / 768 post-refactor train) carry explicit `'utf8'` as the third argument. The fix landed organically during a subsequent code-quality sweep before 2026-05-17. Original IDEA body preserved below for traceability (line numbers in the body reflect pre-refactor state).

`lib/android-orchestrator.js:671` + `lib/android-orchestrator.js:675` write log files via `writeFileSync(logFile, stdout)` without an explicit encoding argument. Node defaults to `'utf8'` for string content so functionally fine, but explicit is better than implicit — every other `writeFileSync` in the codebase passes the encoding string.

**Proposal:** add `'utf8'` as the third arg on both calls. Trivial diff; no behavior change.

**Effort:** 30 min (edit + tiny vitest sanity check).

**Risk:** ZERO. Defensive coding; the implicit default is the same value.

**Why now:** quick win identifiable as a "polish" item — could ride along with a PR-10 sub-PR if the file is being touched anyway, otherwise stand-alone fix.

---

### ✅ SHIPPED — Direct unit tests for `orchestrator-utils.js` exported helpers (DONE 2026-05-11 / PR #<TBD>)

**Status: DONE.** Original premise (surfaced 2026-05-10 during pre-PR-10 code-quality audit) was: `lib/orchestrators/orchestrator-utils.js` exports ~20 helpers consumed by every orchestrator. Most were covered only indirectly via per-orchestrator integration tests; a regression in (e.g.) `stripKotlinComments` would have surfaced as cascading orchestrator-test failures with confusing root-cause rather than pinpointed at the helper.

**What this PR does:** extends `tests/vitest/orchestrator-utils.test.js` with **+32 direct tests** across 6 previously-untested helpers — `stripKotlinComments` (7), `splitGradleArgs` (5), `expandNoCoverageAlias` (6), `discoverIncludedModules` (6), `readBuildFile` (3), `readPackageName` (5). Vitest 1295 → **1327** (+32). Pure additions; the existing 36 tests (parseIsolatedArgs, resolveIsolatedDir, splitCsv, globToRegex, matchModuleFilter, etc.) stayed unchanged. Other already-covered helpers were deliberately skipped to avoid duplication: `validateEnum`/`validateNonNegativeInt` (covered in `input-validation.test.js`), `expandPosixEqualsForm` (covered in `posix-flags.test.js`), `spawnGradle` (covered in `e2e-spawn-gradle.test.js`), `defaultAdbProbe` (system-touching, deferred).

**Bug surfaced + inline-fixed:** the `discoverIncludedModules` single-arg regex `/include\s*\(\s*"(:[\w\-:]+)"/g` matches the first `":name"` of any include — including the first arg of multi-arg forms like `include(":foo", ":bar")`. Pre-fix, the single-arg loop pushed without dedupe (only the multi-arg pass had a `!out.includes` guard), so a settings file mixing single + multi forms with overlapping names produced duplicates — contradicting the docstring's "deduplicated list of module names" contract. One-line fix mirrors the multi-pass guard; the test that surfaced it (`dedupes across single + multi forms`) now passes.

**lib/runner.js 0% gap stays open** (219-line entry-point dispatcher; mutates `process.env` and does dynamic-import-and-invoke; not unit-testable in isolation). Tracked as a separate future polish — a per-file threshold tweak OR a refactor for testability.

**Verification:** local `npm test` → 1327. `npm run test:coverage` → all 4 thresholds (91/90/80/91) green. `node tools/decouple-audit.mjs` + `node tools/check-bundle-size.mjs` → exit 0.

---

### ✅ SHIPPED — JSDoc stubs on the public npm-package API (DONE 2026-05-11 / PR #<TBD>)

**Status: DONE.** Original premise (surfaced 2026-05-10 during pre-PR-10 code-quality audit): `lib/` had <5% JSDoc coverage on exported functions; the npm-package surface that an external integrator's IDE auto-completion sees was undocumented at the JSDoc level (inline architectural comments are dense and high-quality but invisible to IDE tooling).

**What this PR does:** 13 terse JSDoc blocks inserted directly above each public entry point — 1-line description + `@param` + `@returns`, no multi-paragraph, no `@example`, no "used by X" notes.

| Surface                                                | Count |
|--------------------------------------------------------|-------|
| `run*` orchestrators (`runParallel`, `runInfo`, `runDescribe`, `runAndroid`, `runCoverage`, `runBenchmark`, `runChanged`, `runUpdate`) | 8 |
| `runDoctor` + `runDoctorChecks` (`lib/commands/doctor.js`) | 2 |
| Envelope helpers (`buildJsonReport`, `buildInvalidArgsEnvelope`, `envErrorJson`, `buildDryRunReport`) | 4 |
| `EXIT` constant (`@property` per code) | 1 |
| `parseGradleConfig` (`lib/project/jdk-preflight.js`) + `getProjectRoot` (`lib/parsers/argv.js`) | 2 |

**Vitest 1327 unchanged** (JSDoc has no runtime impact). Bundle-size impact: tarball +2.3 KB (210.7 → 213.0 KB; 24% headroom — well within budget).

**Deliberately skipped:**
- Private helpers (the existing inline comments already cover them).
- TypeScript `.d.ts` generation (separate work, future polish).
- `@example` blocks (default skip — only add when call shape is genuinely non-obvious; none here qualified).
- CI lint gate enforcing JSDoc on new exports (overkill at this stage).

**Verification:** `npm test` → 1327 unchanged. `node tools/decouple-audit.mjs` → exit 0. `node tools/check-bundle-size.mjs` → exit 0 (within budget after +2.3 KB).

---

### ✅ SHIPPED — Multi-project size-bucketed token-cost re-measurement (PR #13 — 2026-05-12)

**Status: DONE 2026-05-12.** PR #220 / 3cb4f82 on develop. Originally surfaced 2026-05-10 during pre-v0.10 BACKLOG ordering — entry preserved below for historical context.

**What shipped:**

- `tools/measure-token-cost.js` extended with multi-project orchestrator (`--projects-config`, `--features`, env var + conventional path resolution), bucketing helpers (`classifyBucket`, `summarizeBucket`, `aggregateByBucket`, `formatAggregateReport`), and chunked Anthropic counting (`splitForAnthropic` + `countTokensAnthropic` opts) — see commits `1e1b749` + `3d2163b`.
- 6-project OSS wet sweep on 2026-05-12: KaMPKit, kotlinconf-app, kmp-production-sample (small), PeopleInSpace, Confetti (medium), NowInAndroid (large) + reused `private-large-A` from v0.9 evidence. Bucketed median A→C ratios: small 60×, medium 93×, large 804× (with explicit caveat that NIA's measurement undersamples because the default walker visited only top-level modules — 5 of 35 — and large-bucket spread is dominated by `private-large-A`'s 1,579× ratio).
- README reframed to lead with the 3-row bucket table (`a7ce035`). Per-feature drill-downs relabeled "private-large-A reference". 77,114× coverage outlier preserved as the headline footnote tied to the chunked-recovery narrative. `tests/fixtures/kmp-cross-platform-e2e/` promoted as the reproducible floor.
- CHANGELOG `[Unreleased]` covers the orchestrator + chunked counting + README reframe in a single entry.

**Vitest:** 1327 → 1371 (+44). **Audits:** decouple-audit clean (private project paths sourced from gitignored `tools/.measurement-projects.json`); bundle-size 214 KB / 264 KB budget.

**Follow-ups (queued for v0.10 step 7):**

1. Re-measure NowInAndroid with `--module-filter "**"` to recover the full large-bucket data point. The default top-level walker is robust for nested KMP projects but undersamples deeply-nested Android projects like NIA.
2. Multi-project bucketed re-measurement for `coverage` / `changed` / `benchmark` (this PR did parallel only because each gradle invocation takes 1-5 min × 6 projects × 4 gradle-backed features = ~2-3 hours of wall time, beyond a single session).
3. Cross-model Anthropic per-bucket counts (this PR cites the v0.9 ±20%-of-cl100k correlation for the bucket table; the chunked-counting path is wired in but not exercised on the new captures yet).

**Original IDEA entry — preserved below for traceability:**

The current README + v0.9 measurement evidence calibrate the token-cost reduction claims (e.g. "~77,114× reduction on coverage") against a SINGLE reference KMP composite project. That single-project framing is illustrative but **volatile** — the ratio depends on the project's specific module count, file sizes, kover XML output volume, plugin mix, etc. Real consumers run `kmp-test-runner` against projects of wildly different sizes; the README's headline numbers don't help an outside reader self-locate ("my project is mid-sized — what reduction should I expect?").

**Proposal:** broaden the measurement matrix to several projects of varying sizes and re-frame the README narrative around size-bucketed averages.

**Methodology:**

1. **Keep the existing synthetic fixture as the controlled baseline** — `tests/fixtures/kmp-cross-platform-e2e/` stays as the reproducible floor (1 module, all 8 targets). Document its role explicitly in the README so the floor is auditable; the new bucket averages sit above it.
2. **Real-project sample spanning 3 size buckets**, drawn from two pools:
   - **OSS pool** (named, public projects under the workspace's OSS-samples subfolder): KaMPKit, PeopleInSpace, Confetti, NYTimes-KMP, FileKit, kotlinconf-app, androidify, kmp-basic-sample, kmp-production-sample, nav3-recipes, DroidconKotlin, Nav3Guide, KMedia.
   - **Private pool** (anonymized — see privacy rule below): a handful of the maintainer's private KMP projects across small/medium/large.
   - Bucket assignment by module count: **small** (1–5 modules), **medium** (6–20), **large** (21+).
   - Aim for 2-3 projects per bucket per pool so averages aren't dominated by a single outlier.
3. **For each project × each of the 6 gradle-backed features** (parallel, changed, coverage, describe, info, benchmark) run `tools/measure-token-cost.js` Approaches A / B / C and capture token counts. (`describe` + `info` are agent-query features → B+C only — already handled by the tool's `skipApproachA` flag from v0.9 step 8.)
4. **Aggregate** by size bucket: report mean + median + spread (e.g. "median A→C reduction for medium projects: 800–1500×; small: 50–200×; large: 5000–80000×"). Cite outliers explicitly.
5. **Privacy rule** (per `feedback_no_private_project_refs_in_public_cli.md`):
   - OSS projects from the workspace's OSS-samples subfolder: **named** in the README + evidence. They're public.
   - Private projects from the maintainer's workspace: **anonymized** as `private-small-A`, `private-medium-B`, `private-large-C`. NEVER name them in committed text.
   - The new wrapper script's project list MUST come from `process.env.KMP_MEASUREMENT_PROJECTS` or a gitignored local config — NOT a hardcoded array — so private names never enter committed text. Same pattern as `KMP_WORKSPACE`.

**Sub-tasks (last one is the README refresh, per user direction):**

1. (~1h) Define size buckets + curate the project sample. User picks which OSS/private projects fall in which bucket. Output: a local `tools/.measurement-projects.json` template (gitignored) with the agreed list.
2. (~3-4h) Add `tools/measure-token-cost-matrix.mjs` wrapper:
   - Reads project list from `process.env.KMP_MEASUREMENT_PROJECTS` (path to JSON) or `tools/.measurement-projects.json` (gitignored).
   - Iterates: for each project, runs `measure-token-cost.js` for the 6 features, captures Approach A / B / C token counts, anonymizes private project names per the bucket convention.
   - Aggregates into bucket-keyed averages + spread statistics.
   - Writes per-bucket evidence to `tools/runs/cross-model-results-<feature>.txt` (the canonical evidence files that ARE tracked — replacing the v0.9-step-8 single-project snapshots).
3. (~2-3h) Run the matrix locally. Capture output. Spot-check that no private project name leaks into committed evidence (`git diff tools/runs/` + the privacy grep gate).
4. (~1h) Curate the per-bucket aggregates. Commit the regenerated `tools/runs/cross-model-results-*.txt` with the new size-bucketed numbers.
5. (~2h, **LAST**) Update README's "Why this exists — token cost per agent test-run iteration" section:
   - Replace the single-project hero number with a 3-row "size bucket → median × range" table.
   - Keep the 77,114× outlier as a "large-project ceiling" footnote with explicit context.
   - Promote the synthetic-fixture baseline as the reproducible floor.
   - Add CHANGELOG entry under [Unreleased] for the README refresh + measurement methodology change.

**Effort:** ~10-12h end-to-end. Sits in Phase 4 of the Pre-v0.10 queue (post-PR-10 train, after the cheap polish items).

**Risk:** LOW. Measurement is read-only against existing projects; tooling additions are clean. The only privacy risk is the wrapper script hardcoding private project names — explicitly mitigated by env/gitignored config (mirrors the `KMP_WORKSPACE` pattern shipped in PR #207).

**Why now:** the user flagged the volatility of single-project numbers as a credibility gap for the README's claims. Reframing around bucketed averages makes the cost-reduction promise meaningful to outside consumers ("my project has 12 modules → expect ~800–1500× on coverage"). It also serves as the methodology that v0.10 step 7's re-measurement should adopt, so this IDEA effectively defines the contract that v0.10 step 7 inherits.

**Cross-link:** v0.10 step 7 ("Token-cost re-measurement — captures any v0.10 envelope changes") should adopt the multi-project bucketed methodology defined here. Update the v0.10 ROADMAP entry to reference this IDEA when it gets prioritized.

---

### ✅ SHIPPED 2026-05-11 — `parseArgs` duplication INVESTIGATE + Option B (Pre-v0.10 Phase 3 closure)

**Status: DONE — INVESTIGATE closed 2026-05-11, Option B shipped same day.** Investigation surveyed all 8 orchestrators (the 7 script-backed + `update`); see memory `project_phase_3_parseargs_investigate_findings.md`. User picked Option B (minimal shared layer). Implementation landed in the same session:

- `lib/parsers/argv-constants.js` (NEW) — 3 frozen allowlists (`TEST_TYPE_VALUES`, `COVERAGE_TOOL_VALUES`, `PLATFORM_VALUES`) as single source of truth. Previously declared 4 times across the orchestrators.
- `lib/orchestrator-utils.js` — added `splitGradleArgs(raw)` (replaces 4 inline whitespace-split copies) + orchestrator-side `expandNoCoverageAlias(argv)` (lifted from 2 byte-identical bodies). Added `// Validation error contract` header docstring documenting the `errors[]` shape and `validateEnum`/`validateNonNegativeInt` null-return convention.
- 5 orchestrators (`coverage`, `parallel/dispatch`, `changed`, `benchmark`, `android`) now import shared symbols. Local copies deleted; ESM re-export chains preserved via live bindings.
- Parity fix from the original plan was UNNECESSARY in practice — `--no-coverage` is not in any subcommand-specific `SUBCOMMAND_HELP` block (it's a CLI-globals line), so the parity scan never required it. Confirmed empirically.

Vitest count: 1295 → 1295 (pure extraction, no semantic change). Decouple audit clean. 9 files touched (1 new + 7 edited + BACKLOG closure).

**[Original entry — preserved for traceability]**

### 🔍 INVESTIGATE — `parseArgs` duplication across 7 orchestrators (~125 LOC each — surfaced 2026-05-10 during pre-PR-10 code-quality audit)

**Status: INVESTIGATE before deciding.** The 7 script-backed orchestrators (`android`, `benchmark`, `changed`, `coverage`, `describe`, `info`, `parallel`) + `update` each carry their own `parseArgs(argv)` implementation, ~125 LOC apiece. The audit's first instinct (and the agent's recommendation) was "accepted architectural debt — each orchestrator's flag set is genuinely unique, a shared DSL would be YAGNI". On second look that conclusion may be too quick — there's clear common scaffolding (POSIX `--name=value` expansion via `expandPosixEqualsForm`, validators like `validateEnum` / `validateNonNegativeInt`, the global flags `--project-root` / `--java-home` / `--ignore-jdk-mismatch` that EVERY orchestrator must skip). The real question isn't "shared DSL vs per-orchestrator" — it's "how much of the parseArgs body is shared vs unique, and is the shared portion big enough to extract without forcing a hostile abstraction?"

**Investigation scope:**
1. **Diff the 7 `parseArgs` bodies side-by-side.** Identify line-by-line: which lines are literal copies, which are near-copies (same shape, different flag name), which are genuinely unique to each subcommand.
2. **Catalogue the global / shared flag set.** Today every orchestrator hand-skips `--project-root`, `--java-home`, etc. Is there a canonical `CLI_GLOBAL_FLAGS` (already exists in `tests/vitest/_parity-helpers.js` per memory) that orchestrators should consume directly via a shared helper?
3. **Audit drift risk.** When v0.9 added `--isolated*` flags, every orchestrator had to be updated independently — confirm that all 7 actually got the flag wired or whether some silently dropped it (drift across the train).
4. **Decide between three outcomes**:
   - **(a) Document as accepted debt** — add a comment block to each `parseArgs` linking to a "why duplicated" rationale.
   - **(b) Extract minimal shared layer** — pull only the genuinely-shared bits (POSIX expansion, global-flag skip set, validator imports) into `lib/parsers/argv-utils.js`. Each `parseArgs` keeps its switch but calls the shared utilities. This is what the codebase IS doing already — so the question becomes "is there more to extract".
   - **(c) Full DSL** — declarative flag table per orchestrator, single shared parser. Highest impact, highest risk, possibly hostile to readability if flag-quirks need escape hatches.

**Effort:** investigation ~3h (diff + categorize). Implementation depends on outcome: (a) ~1h docs, (b) ~6h targeted extraction, (c) ~15-20h full rewrite.

**Risk:** Investigation is read-only; zero risk. Implementation risk depends on outcome.

**Why this matters:** if v0.10 / v0.11 adds new flags that touch multiple subcommands (e.g. v0.10 #2 `gradle.properties` auto-respect, which would hit all of them), we'll feel this duplication as friction. Better to know now whether we're paying for accepted debt or carrying avoidable boilerplate.

---

### ✅ SHIPPED 2026-05-05 (v0.9 step 1, PR #146 / `4ef1f26` on develop) — `kmp-test parallel --test-type androidInstrumented` parity gap with `kmp-test android` subcommand (surfaced 2026-05-05 during fix-PR-G audit)

**Status: DONE — v0.9 step 1 shipped 2026-05-05 (PR #146 / `4ef1f26`).** All 6 parity-gap flags wired into `parallel --test-type androidInstrumented` (`--clear-data`, `--auto-retry`, `--device <serial>`, `--flavor <name>`, `--device-task <name>`, canonical `class=<FQN>#<method>` filter shape). Vitest 816 → 838 (+22). 13/13 CI green. 4/6 flags live-verified on the maintainer's reference projects + S22 Ultra. Lesson: ps1 wrapper has param whitelist (sh passes through verbatim). Original entry preserved below for context.

**[Original entry — preserved for traceability]**

**Status (historical): OPEN, deferred from v0.8.0.** The `kmp-test android` subcommand offers several instrumented-test ergonomics that the `parallel --test-type androidInstrumented` path does not surface today. None BREAK an existing flow (so they're not v0.8.0 release-blockers — fix-PR-G closed the only blocker), but they're features users will reasonably expect on the unified `parallel` path. Closing the gap is mostly mechanical: thread the missing flags through `parseArgs` + `dispatchLeg` + per-module retry path.

| Flag | Available in `kmp-test android` | Available in `kmp-test parallel --test-type androidInstrumented` | Effort |
|---|:---:|:---:|---|
| `--clear-data` (clears app data via `adb shell pm clear <pkg>` before retry) | ✅ | ❌ | ~30 LOC + 2 vitest |
| `--auto-retry` (re-spawn once on failure) | ✅ | ❌ (PR5 cascade-isolation covers ONLY evaluation-phase aborts, not runtime failures) | ~20 LOC + 2 vitest |
| `--device <serial>` (multi-device targeting) | ✅ | ❌ (relies on first connected device) | ~15 LOC + 1 vitest |
| `--flavor <name>` (productFlavors → `connected${Flavor}DebugAndroidTest`) | ✅ | ⚠️ partial (project-model `hasFlavor` signal exists but no CLI surface on `parallel`) | ~25 LOC + 3 vitest |
| `--device-task <name>` (explicit gradle task override) | ✅ | ⚠️ alternative — `--variant` covers debug/release/all, but no full task-name override path | ~15 LOC + 1 vitest |
| `class=<FQN>#<method>` filter shape (single arg, canonical AGP) | ❌ (uses separate `class=`/`method=` args — same gap as `parallel`) | ❌ | ~10 LOC in `cli.js#splitClassMethod` consumer + 2 vitest. Affects `kmp-test android`, `kmp-test benchmark`, AND `kmp-test parallel --test-type androidInstrumented`. |

**Action shape**: one PR per row (or one bundled "parallel parity" PR if scoped together). Bundled is cheaper for the maintainer; individual is cheaper for review. The `class=<FQN>#<method>` row is the highest-impact: it would also fix the Microbenchmark method-filter weakness surfaced live during fix-PR-G validation.

**Token-cost re-measurement when v0.9 parity-gap flags land.** When the 6 pending parity-gap items (`--clear-data`, `--auto-retry`, `--device <serial>`, `--flavor`, `--device-task`, `class=<FQN>#<method>` filter shape) get implemented, also extend `tools/measure-token-cost.js` and the README's "Why this exists — token cost per agent test-run iteration" tables. Audit per-flag at implementation time: does this flag change the `--json` envelope output shape? If yes (e.g. `--auto-retry` adds a `retries[]` field; `--clear-data` adds a `pre_run_actions` field), capture a fresh A/B/C measurement so the agentic-cost claim stays honest. If no (e.g. `--device <serial>` only selects which adb device, doesn't change stdout shape), skip with a note in the PR description. Cross-link to the original token-cost measurement entry (`Multi-feature token-cost measurement (v0.4 milestone)`) for context. Surfaced 2026-05-05 during PR8 release prep — the user noted that mac-side fix-PR-F-bis and fix-PR-G work surfaced these Android-side gaps, and re-measurement should be part of any v0.9 parity work that changes envelope shape.

**Out of scope until parity decision**: full `parallel`-side adoption of android-orchestrator's `--list-tests`, `--logcat-tail`, `--clear-cache`, `--no-uninstall` flags — those are android-subcommand-specific UX that may not apply to the parallel sweep model.

---

### ✅ SHIPPED 2026-05-06 (v0.9 step 5, PR #150 / `0a88797` on develop) — Cross-platform parity check in CI (NEW 2026-05-05)

**Status: DONE — v0.9 step 5 shipped 2026-05-06 (PR #150 / `0a88797`).** All 4 static sub-checks landed (flag matrix audit + envelope JSON schema snapshot + README ↔ code drift detection + platform-behaviour matrix). Vitest 963 → 1004 (+41). 13/13 CI green across ubuntu/macos/windows after 2 follow-up commits resolving snapshot portability (`PLATFORM_SPECIFIC_KEY` + `HOST_ENV_KEY` + `schemaOf()`). Surfaced + fixed ~10 undocumented flags + missing v0.9 README rows in the same PR. Original entry preserved below for context.

**[Original entry — preserved for traceability]**

**Status (historical): OPEN, scheduled as step 5 of v0.9 milestone (per ROADMAP).** Replaces the dropped iOS/macOS TestKit-in-CI matrix with a lightweight static parity check that catches drift between flag tables, envelope schema, README, and platform-behavior matrix without burning macOS minutes (`feedback_ci_minutes_minimal_macos.md`).

**Scope — 4 sub-checks:**
1. **Flag matrix audit** — vitest spec that enumerates every CLI subcommand × every flag, asserting platform-applicability matches the README "Platforms supported" table. Catches drift like "added `--device` to `parallel` but forgot to update README".
2. **Envelope JSON schema snapshot** — golden-file snapshot of the `kmp-test ... --json` output shape for each subcommand (using a dry-run mode where possible). Any envelope-shape change forces a deliberate snapshot update.
3. **README ↔ code drift detection** — regex over README flag table compared against the actual `bin/kmp-test.js` argv parser. Detects flags documented but not parsed, or parsed but not documented.
4. **Platform-behavior matrix lock-in** — vitest spec asserting which gradle task name / source set each `--test-type` resolves to per platform (e.g. `--test-type ios` → `iosSimulatorArm64Test` candidate chain). Catches dispatch-table regressions.

**Acceptance:** 4 new vitest specs (or 1 with 4 describe blocks) + a CI step that runs them on every PR. **No new macOS minutes** — all checks run on `ubuntu-latest`. Failure messages must be actionable ("README says X, code does Y, fix one of them").

**Estimated effort:** ~4-5h.

**Out of scope:** runtime gradle dispatch validation against real projects (that's step 7, manual). E2E flake tests (those are real-execution territory).

---

### ✅ SHIPPED 2026-05-06 (v0.9 step 7, PRs #153 + #154 + #155 on develop) — macOS validation gate (manual smoke before tagging)

**Closure summary.** New `tools/macos-validation-gate.mjs` driver — 45-cell matrix (`{parallel, changed} × 7 --test-type values × 3 projects = 42` + `android × 3 projects = 3`) against the in-repo fixture + the reference KMP composite project + `KaMPKit`. Four modes:
- `--mode dry` — enumerate cells, no spawn (for matrix-shape sanity).
- `--mode probe` — spawn `kmp-test <sub> --dry-run|--list-only --json` per cell. Captures REAL envelopes without invoking gradle (orchestrators short-circuit). Disk-safe at any free-space level.
- `--mode scoped` — spawn `kmp-test` per cell with `--module-filter <smallest>`. One gradle daemon per cell. For wet-validation when disk allows.
- `--mode full` — unfiltered sweep, gated by `--i-have-20gb-free` (encodes `feedback_disk_space_awareness.md` rule in code).

Drift detection by path-only shape diff against `tests/vitest/__snapshots__/parity.test.js.snap` (with `normalizeForShapeDiff` mirroring `_parity-helpers.js#PLATFORM_SPECIFIC_KEY` collapse, empty-array `[]` symmetry, array-child runtime-vs-contract distinction). Per-cell artifacts `.smoke/macos-gate-v0.9/<safe>.{out,err,json,meta.json}`.

`--mode probe` against the 3 projects on develop tip (`0d8cc34`): **44 PASS / 0 DRIFT / 1 SKIP** (the single skip is the in-repo fixture's android cell, `no-instrumented-target` — the fixture has no instrumented android tests by design).

The probe sweep surfaced **one genuine envelope-contract drift** mid-PR: `lib/android-orchestrator.js` was emitting an incomplete `coverage` block (`{ tool, missed_lines }`) in three places (`--list-only`, `KMP_TEST_SKIP_ADB=1`, main per-module dispatch state) instead of the canonical `{ tool, missed_lines, modules_with_kover_plugin: [], modules_with_jacoco_plugin: [] }` that every other subcommand emits. Fixed inline in PR #154 with a regression test in `tests/vitest/android-orchestrator.test.js` (per `feedback_close_in_one_session.md` — bugs surfaced in the milestone's session get fixed in the same session, not deferred to follow-up PRs).

**Wet pass (PR #155).** Real gradle invocations against the 3 projects, with the Samsung S22 attached for instrumented cells. Cells exercised: jvm/desktop, jsTest/wasmJsTest (in-repo fixture), iosSimulatorArm64Test, macosArm64Test, testAndroidHostTest (KaMPKit hybrid pattern), `connectedAndroidDeviceTest` on the S22 (`bench-net` from a reference KMP composite project ran 3 instrumented tests, `BUILD SUCCESSFUL`). 14 wet cells executed. Three additional bugs surfaced and fixed inline in PR #155 (per `feedback_close_in_one_session.md`):

1. **`tests/fixtures/kmp-cross-platform-e2e/gradlew` had no execute bit** (git mode `100644` instead of `100755`) — first wet cell hit `permission denied: ./gradlew`. Fixed via `git update-index --chmod=+x`. Other read-only `tests/fixtures/build-logic-*` fixtures keep `100644` intentionally (static parser tests, never invoke gradle).
2. **`lib/parallel-orchestrator.js#pickGradleTaskFor('androidUnit')` early-return missed the hybrid plugin pattern.** KaMPKit `:shared` uses `com.android.library` plugin + `kotlin { android { withHostTestBuilder {} } }` DSL → parser surfaces `androidDsl=null` + `androidDslVariant='kmpAndroidLibrary'`. Gate previously only checked `type` + `androidDsl`. Extended to include `androidDslVariant`. Regression test in `tests/vitest/parallel-orchestrator.test.js`.
3. **`lib/android-orchestrator.js#parseTestCounts` only handled the legacy AGP format.** The new KMP-Android plugin's `connectedAndroidDeviceTest` reporter emits `"Starting N tests on <device>"` + progress lines + `"Finished N tests on <device>"`. a reference KMP composite project `:bench-net` ran 3 real tests on the S22 with `BUILD SUCCESSFUL`, but the envelope reported `testsPassed: 0`. Added fallback regex chain: legacy first, then `Finished N tests` for total + last progress line for failed/skipped. 5 regression tests in `tests/vitest/android-orchestrator.test.js`.

Evidence: the macOS gate summary (probe shape-validation, auto-generated) + the macOS gate wet-results notes (wet evidence with cell-by-cell table) — both committed in PR #155. The gate can be re-run anytime: `--mode probe` (~5s, no gradle, disk-safe at any free-space level) for shape drift; `--mode scoped` for module-filtered wet runs; `--mode full` (gated by `--i-have-20gb-free`) for the unfiltered sweep. Out-of-scope (deliberately): iOS simulator on a reference KMP composite project benchmark modules — the `KmpBenchmarkConventionPlugin.kt` declares only `jvm("desktop")` + `macosArm64()` + `androidLibrary {}`, no iOS targets. Coincides with memory `reference_kmp_benchmark_platforms.md`.

Vitest delta: 1018 → 1068 (+50 across the three PRs: 32 in `tests/vitest/macos-validation-gate.test.js` for the gate driver itself; 11 in the same file for probe-mode behavior + shape-diff refinements; 7 in `tests/vitest/android-orchestrator.test.js` (1 coverage-shape + 5 parseTestCounts + 1 hybrid-pattern via parallel-orchestrator); 1 in `tests/vitest/parallel-orchestrator.test.js` for the KaMPKit hybrid androidUnit gate). Manual-only; not wired into CI per `feedback_ci_minutes_minimal_macos.md`.

---

**[Original entry — preserved for traceability]**

**Status: OPEN, scheduled as step 7 of v0.9 milestone (per ROADMAP).** With iOS/macOS TestKit dropped from the per-PR CI matrix (`feedback_ci_minutes_minimal_macos.md`), the only mac coverage is `build (macos-latest)` (vitest, ~30s) + `installer-e2e (macos-latest)` (~20s). Drift in real iOS/macOS gradle dispatch is invisible until manual validation. This gate runs **once before tagging v0.9.0**, against a curated set of real KMP projects.

**Scope:** matrix of `{kmp-test parallel, kmp-test changed, kmp-test android}` × `{--test-type common, jvm, android, ios, macos, all}` × `{v0.9 fixture (step 6), a reference KMP composite project, KaMPKit}`. Capture each run's JSON envelope; diff against expected shape from step 5's snapshot tests. Any drift becomes a fix-PR before the v0.9 tag.

**Acceptance:** all subcommand × test-type × project combinations produce envelopes matching the step-5 snapshots. Tooling: a small `tools/macos-validation-gate.mjs` script that drives the matrix and produces a markdown summary (mirrors the `tools/wide-smoke-pass-9-mac.mjs` pattern from v0.8.0). Failures captured as gitignored evidence files at repo root; each becomes a fix-PR docked to the v0.9 ramp.

**Estimated effort:** ~2-3h validation run + N×fix-PRs (open-ended; bounds set by what the gate surfaces).

**Out of scope:** automating this in CI (explicitly NOT desired per `feedback_ci_minutes_minimal_macos.md`). The gate stays manual on a secondary local machine.

---

### ✅ DONE 2026-05-07 (PR #<TBD>) — v0.9 — Token-cost re-measurement after parity-gap + DX-parity land

**Status: DONE 2026-05-07.** Closed in this session. Full matrix re-run on a reference KMP composite project (4 gradle-backed: parallel/coverage/changed/benchmark; 2 agent-query: info/describe). `tools/measure-token-cost.js` extended with `skipApproachA` + `acceptsModuleFilter` per-feature flags so info/describe (no raw-gradle equivalent) can be measured B+C only. Vitest 1068 → 1078 (+10 cases). Headline numbers (cl100k_base, single run on real KMP project): parallel 1331036→843 = 1579×; coverage 28686309→372 = **77,114×**; changed 1118241→144 = 7766×; benchmark 245140→309 = 793×. **Coverage Approach A overflows Anthropic's `count_tokens` endpoint** (413 request_too_large) — even Anthropic's own tokenizer cannot process raw gradle output for a real coverage run. Cross-model captures committed under `tools/runs/cross-model-results-<feature>.txt` for all 6 features × 3 Claude families (Opus 4.7 / Sonnet 4.6 / Haiku 4.5). Anthropic models tokenize ~1.5–1.7× cl100k_base on long captures (cost reduction is even more dramatic on real Anthropic models). Evidence: the v0.9 measurement notes at repo root. README prose deferred to step 9 — re-framing is required (different reference project, dual-track gradle vs --json story, mention of the coverage 413-overflow), not a one-line tweak. Also closes the v0.8.0 cross-model deferral at L1042.

---

### ✅ SHIPPED 2026-05-07 (v0.9 step 8, PR #156 / `b6402ea` on develop) — Token-cost re-measurement after parity-gap + DX-parity land (NEW 2026-05-05)

**Status: DONE — v0.9 step 8 shipped 2026-05-07 (PR #156 / `b6402ea`).** Full matrix re-run on the maintainer's reference KMP composite project. `tools/measure-token-cost.js` extended with `info` + `describe` features (B+C only — agent-query features without raw-gradle equivalent); per-feature `skipApproachA` + `acceptsModuleFilter` flags. 6 features × 3 Claude families captured. Headline finding: coverage A=28.7M cl100k tokens (74 MB kover) → C=372 = **77,114× reduction**; coverage A overflows Anthropic's `count_tokens` (413 too large) — load-bearing finding promoted to README v0.9 lead. Vitest 1068 → 1078 (+10). README prose deferred to step 9 (re-framing required, not a tweak). Closes the v0.8.0 cross-model deferral. **Important**: this measurement was single-project. The "💡 IDEA — Multi-project size-bucketed token-cost re-measurement" entry above defines a follow-up that broadens the methodology to size-bucketed averages. Original entry preserved below for context.

**[Original entry — preserved for traceability]**

**Status (historical): OPEN, scheduled as step 8 of v0.9 milestone (per ROADMAP — the "step 4" reference in the original text was a typo; canonical step is 8).** After the 6 parity-gap flags (entry above) AND the DX-parity bundle (`--variant` global, `kmp-test describe`, `kmp-test info`, `kmp-test update` — see "DX/UX parity audit" entry) land, re-run the full `tools/measure-token-cost.js` matrix to capture the new envelope shape and the new subcommands. The original token-cost claim ("13K → 100 token reduction for AI agents", "~542K → ~500 tokens for the coverage 5-iter loop") was calibrated at v0.5.0; the v0.8.0 envelope is structurally identical but the v0.9 parity-gap + DX-parity adds `retries[]` (auto-retry), `pre_run_actions` (clear-data), `device.serial` field (device targeting), `describe`-mode JSON shape, etc. — every additive field that an agent might consume.

**Why AFTER all envelope-shape work lands** (load-bearing ordering): re-measuring per-flag is a dead-weight loop — each flag PR would invalidate the previous measurement. Single re-measurement at the end captures the FINAL v0.9 surface in one pass.

**Tasks:**
1. Audit each merged v0.9 PR's envelope diff: collect the additive fields. Bucket: `{shape-changing | shape-preserving}`. Skip the shape-preserving flags (`--device <serial>` doesn't change stdout shape, only adb target).
2. Extend `tools/measure-token-cost.js` to include the new subcommands (`kmp-test describe`, `kmp-test info`) in its measurement matrix.
3. Run the full matrix on the reference KMP composite project (or KaMPKit). 4 features × 3 approaches × cross-model. ~$10-15 USD in API calls.
4. Update the README "Why this exists — token cost per agent test-run iteration" tables with v0.9 numbers + a timestamp note ("Measured at v0.9.0 on YYYY-MM-DD").
5. Bump `tests/vitest/measure-token-cost.test.js` baselines if any changed.

**Effort:** ~2-3h (1h re-running, 1h reviewing, 30-45min editing tables).

**Cross-link**: original token-cost measurement context in "✅ Multi-feature token-cost measurement (v0.4 milestone)" entry below. The note inside the v0.9 parity-gap entry above (L335) is the inline rationale; this entry is the action item.

---

### ✅ DONE 2026-05-XX (PR #<num>) — v0.9 — README refresh after parity-gap + DX-parity + token-cost re-measurement

**Status: SHIPPED 2026-05-XX (PR #<num>) on develop.** Last v0.9 step before tagging. README hero token-cost narrative re-framed against a reference KMP composite project — different reference project, dual-track gradle-vs-`--json` story, coverage-A 413-overflow callout. Cross-feature summary + per-feature drill-down + savings-ratio tables rebuilt from the v0.9 measurement notes + `tools/runs/cross-model-results-*.txt`. Hero practical-impact paragraph updated to a reference KMP composite project numbers (5-iter agent loop now ~6.6 M / ~5.6 M / ~1.2 M / ~143 M tokens for parallel / changed / benchmark / coverage; sub-5K each on `--json`). Flag reference table gained 6 rows (`--clear-data` / `--auto-retry` / `--device` / `--device-task` / `--flavor` / `--module-filter`); subcommands table gained 3 rows (`info` / `describe` / `update`); new "Agent-query subcommands" section before "Gradle Plugin" with envelope examples + flag lists for each. Canonical `class=<FQN>#<method>` filter shape documented in `--test-filter` section with migration note from the legacy `class=` + `method=` separate-args form. AI-agent envelope JSON example bumped to `version: "0.9.0"` + new `isolated:{}` / `skipped:[]` / expanded `coverage:{}` fields. CHANGELOG `[0.9.0]` section assembled per-PR — Summary paragraph (mirroring [0.8.0]'s shape) plus per-step entries (1–9). Vitest 1078 unchanged (no test changes). 13/13 CI green. v0.9.0 release ceremony (step 10) unblocked.

**Original scope** (preserved for traceability — all landed):

After steps 1-4 of v0.9 land, refresh the README to document the new surface. This is the v0.9-milestone analogue of the "v0.8.0 README refresh" entry (which covers v0.7.0+v0.8.0 surface and ships in v0.8.1 per ROADMAP). The v0.9 refresh covers ONLY what's new in v0.9 on top of v0.8.x.

**Tasks:**
1. **New flags** under each subcommand's flag table: `--clear-data`, `--auto-retry`, `--device <serial>`, `--flavor <name>`, `--device-task <name>`, global `--variant`, `--gradle-args`. Document precedence rules + interaction with existing flags.
2. **New subcommands**: `kmp-test describe`, `kmp-test info`, `kmp-test update`. One-paragraph each + an example.
3. **Updated `class=<FQN>#<method>` filter shape**: explain the new canonical AGP single-arg form, document migration from the legacy `class=` + `method=` separate-args form (still supported).
4. **Updated token-cost numbers** from step 4 of v0.9 milestone. Add timestamp ("Measured at v0.9.0 on YYYY-MM-DD").
5. **Pre-existing TODOs from "Verify all CLI tools advertised in README" entry** that didn't make it into v0.8.1 (if any) — close out as part of this refresh.
6. **CHANGELOG `[0.9.0]` section**: per-PR breakdown (mirroring the [0.8.0] structure).

**Effort:** ~2-3h.

**Ship-when**: bundled with the v0.9.0 release PR (per `feedback_release_wide_smoke.md` standing rule, this lands in the same release-prep cycle as the wide-smoke pass-N+1 validation).

---

### ✅ DONE 2026-05-05 (PR #131 + #134) — v0.8.0 — `--variant` flag honored on the instrumented (`androidInstrumented`) dispatch path (RELEASE-BLOCKER, surfaced 2026-05-04 wide-smoke pass-9 against a multi-module DI sample)

**Status (2026-05-05 follow-up): DONE — fix-PR-F-bis closes a regression in fix-PR-F's coverage on the probed-task path.** The original fix-PR-F (PR #131) only honored `--variant` + `testBuildType` in the AGP fallback branch (when `r.deviceTestTask === null`). After a multi-module DI sample commit `058a520` enabled `connectedDebugAndroidTest` alongside the canonical `connectedReleaseAndroidTest` via `androidComponents.beforeVariants`, gradleTasks contained both and `resolveTasksFor.deviceTestTask` matched Debug first → early-return at `parallel-orchestrator.js:391` bypassed the variant logic → orchestrator dispatched `connectedDebugAndroidTest` even though `testBuildType="release"` and the parser correctly resolved it. fix-PR-F-bis lands two surgical changes: (1) `lib/project-model.js#resolveTasksFor` candidate chain prepends `connected{TestBuildType}AndroidTest` when `analysis.testBuildType` is set, fixing all consumers (parallel/android/benchmark/coverage/changed) uniformly; (2) `pickGradleTaskFor('androidInstrumented')` in `lib/parallel-orchestrator.js` reorders the AGP source-set branch BEFORE the probe early-return so explicit `--variant debug|release` overrides win regardless of probed task name. **+10 vitest cases** (775 → 797 passing). Live verified inline against the real cached gradleTasks for a multi-module DI sample `:benchmark`. Probe-wins legacy contract preserved for non-AGP / no-source-set modules.

**Status: DONE — fix-PR-F shipped 2026-05-05.** Two bundled changes in `lib/parallel-orchestrator.js` + `lib/project-model.js`:

1. **Orchestrator helper.** New `androidConnectedTask(gradlePath, variant, mod)` mirrors `androidUnitTask`: `--variant {auto,debug,release,all}` honored + `mod.testBuildType === 'release'` respected for static per-module variant selection. Hardcoded `connectedDebugAndroidTest` at line 396 replaced. `kmpAndroidLibrary` branch unchanged (no Debug/Release split in the new plugin).
2. **Parser enhancement.** `lib/project-model.js#analyzeModule` now resolves single-file `val NAME = ... ?: "literal"` and `val NAME = "literal"` patterns when `testBuildType = NAME` references a variable. Out of scope: `project.findProperty()` lookups against `gradle.properties`, multi-file refs (`buildSrc`, root build), conditional expressions — those still fall through to null.

Help text in `lib/cli.js` updated to reflect that `--variant` now applies to both unit + instrumented dispatch. **768 → 775 vitest** (5 orchestrator cases + 2 parser cases + 1 existing parser test updated). Live verified against a multi-module DI sample under default `--variant auto`: `:benchmark:connectedReleaseAndroidTest` dispatched (auto-resolved from `val benchmarkBuildType = (...) ?: "release"`) and `:sample-multimodule:connectedDebugAndroidTest` dispatched (no testBuildType, AGP default). Both accepted by gradle. Fully closes the pass-9 a multi-module DI sample `task_not_found` repro under default args — no user workaround required.

**The asymmetry today:**

`lib/parallel-orchestrator.js#androidUnitTask` (line 306) honors `--variant {auto,debug,release,all}` AND respects `mod.testBuildType === 'release'` for static per-module variant selection. So unit-test runs against benchmark-style modules (e.g. a multi-module DI sample's `:benchmark` with `testBuildType = "release"`) correctly dispatch `:m:testReleaseUnitTest` under default `--variant auto`.

The instrumented path (`selectTaskForLeg` case `androidInstrumented`, lines 373-399) hardcodes `connectedDebugAndroidTest`. No `mod.testBuildType` lookup, no variant honoring. Modules with `testBuildType = "release"` (which only generate `connectedReleaseAndroidTest`) fail with `task_not_found` on every default sweep.

**Repro (any time):** a multi-module DI sample `:benchmark` (legacy `com.android.library`, `testBuildType = "release"`) dispatched via `kmp-test parallel --test-type=androidInstrumented` — gradle responds `Cannot locate tasks that match ':benchmark:connectedDebugAndroidTest' as task 'connectedDebugAndroidTest' not found in project ':benchmark'.`

**Fix shape (next session):**

1. Add `androidConnectedTask(gradlePath, variant, mod)` mirroring `androidUnitTask` semantics:
   - `auto` (default): dispatch `connectedReleaseAndroidTest` when `mod.testBuildType === 'release'`, else `connectedDebugAndroidTest`
   - `debug` / `release`: forced
   - `all`: emit two leg entries (one per variant) — same shape as the unit-test `--variant all` path
2. Replace the hardcoded `${gradlePath}:connectedDebugAndroidTest` at parallel-orchestrator.js:396 with `androidConnectedTask(gradlePath, opts.androidVariant, mod)`.
3. Mirror in the `kmpAndroidLibrary` branch (line 387) where applicable — though the new KMP plugin uses `androidConnectedCheck` without Debug/Release variants, so the variant flag stays a no-op there (already documented in fix-PR-D's commit message).
4. +3-4 vitest cases:
   - `mod.testBuildType === 'release'` + `--variant auto` → `connectedReleaseAndroidTest`
   - `mod.testBuildType === 'release'` + `--variant debug` → `connectedDebugAndroidTest` (user override)
   - `mod.testBuildType === undefined` + `--variant auto` → `connectedDebugAndroidTest` (legacy default)
   - `--variant all` emits both legs

**Repro projects (parking):**
- a multi-module DI sample (`:benchmark`, `:sample-multimodule`)
- Any benchmark module across the wide-smoke matrix that uses `testBuildType = "release"`

**Why this IS blocking v0.8.0 (corrected 2026-05-04 second incident):**
Initially framed as "not blocking" because pass-9 bucket counts match pass-8 (3/14/13/0/0/0) and the a multi-module DI sample failures happened in both passes. User pushed back: "no va a ser para la 0.8.x — tiene que estar antes". Standing rule per `feedback_dont_defer_to_post_release.md`: any bug found during a release-validation gate gets root-caused and fixed before the version tag. The "pre-existing in earlier pass" framing does NOT exempt the bug from the rule — pass-7 and pass-8 just happened to not stress this path. Pass-9 surfaced it; fix it pre-tag.

**Out of scope:**
- Changing the default variant from auto to anything else
- Auto-mixing debug + release in the same sweep without `--variant all`
- Refactoring `androidUnitTask` (already correct; just needs to be paralleled for connected)

---

### v0.8 — ✅ Silent-pass class FIXED — but the unsilenced REDs surfaced 3 more pre-existing bugs (2026-05-03)

**Status: silent-pass class FIXED + parseSettingsIncludes phantom-module FIXED + stderr filter WIDENED. Still outstanding: 2 pre-existing bugs that were hidden behind silent-pass and need their own investigation.**

**What's fixed in commits on `fix/windows-spawn-einval`:**

1. **Spawn EINVAL** — `lib/orchestrator-utils.js#spawnGradle` (cmd.exe wrapper + `windowsVerbatimArguments:true`); 5 spawn sites in parallel/android/benchmark routed through it. Defense-in-depth in `classifyTaskResults` (legExit + no positive evidence → 'failed'). Stale-junit guard (mtime gate). 9 new e2e cases with real spawn (`tests/vitest/e2e-spawn-gradle.test.js`).

2. **Phantom commented modules** — `lib/project-model.js#parseSettingsIncludes` did NOT strip Kotlin comments before matching `\binclude\b`, so `// include(":bench-android")` was treated as a live module. Gradle then errored at task resolution (`project 'bench-android' not found`), which combined with EINVAL silent-pass produced the false GREEN. Fixed by mirroring `orchestrator-utils.js#stripKotlinComments`. Schema bumped 2 → 3 to invalidate stale `.kmp-test-runner-cache/model-*.json` entries that contain phantom modules. 4 regression tests added in `tests/vitest/project-model.test.js`.

3. **stderr filter swallowed gradle's actual error context** — `executeLeg`'s pre-fix filter only forwarded lines matching `Cannot locate|FAILURE:|BUILD FAILED|UnsupportedClassVersionError|Failed to install`. The `* What went wrong:`, `> Could not resolve`, `Android Gradle plugin requires Java 17` and similar diagnostic blocks were dropped. Widened to forward `> Task :*`, `* What went wrong:`, `* Try:`, `Caused by:`, AGP/JDK requirement messages, plugin-resolution errors, and capped at 60 lines/leg with a "(N more suppressed)" footer. Wide-smoke surfaced a private KMP application's actual error: `Android Gradle plugin requires Java 17 to run. You are currently using Java 11`.

**Wide-smoke trajectory across 6 fix passes:**

| Verdict | Broken | P1 spawn | P2 +strip+stderr | P3 +AGP+cascade | P4 +per-mod-isolation | P5 +jvm("name")+hierarchy | P6 +variant+sdk+default-jvm |
|---|---:|---:|---:|---:|---:|---:|---:|
| SILENT-FAKE-PASS | 14 | **0** ✅ | 0 | 0 | 0 | 0 | 0 |
| REAL-GREEN | 0 | 0 | 3 | 6 | 5 | 6 | **8** |
| REAL-RED | 0 | 14 | 11 | 8 | 9 | 8 | 6 |
| NO-MODULES | 9 | 9 | 9 | 9 | 9 | 9 | 9 |

P6 flips: a multi-module DI sample, `PeopleInSpace-main` to GREEN (instrumented-only skip + default jvm() detection + ANDROID_HOME auto-set). The 6 remaining REDs are honest:
- a private KMP application — 5 tests desync with refactored production
- a private KMP application — 1 missing `DesktopPKCEGenerator` cascades 7 features
- `local-app-1` — 1 real test failing (`LoadingAndErrorStatesTest`)
- `nav3-recipes` — `NavigatorTest.kt` references removed `RouteV2`/`Navigator`
- `nowinandroid` — `:foryou:impl` Prod variant missing dep + 2 real tests
- `Confetti-main` — `:wearApp` 2 real tests fail (`WorkManagerTest`, `ComplicationScreenshotTest`)

Notable per-project flips:
- **a reference KMP composite project**: silent-pass-38 → cross-contaminated-37-fail → 35/2 → 35/2 → **63/0** (jvm("desktop") fix unlocked all modules)
- **a private KMP application**: silent-pass-1 → JDK-mismatch-fail → JDK-mismatch-fail → **PASS** (AGP-aware JDK fix)
- **Confetti-main**: silent-pass-4 → cascade-fail-4 → fake-green-via-cascade → REAL-RED-2/2 (cascade isolation honest, then per-module isolation honest)
- **nowinandroid**: silent-pass-14 → real-RED → real-RED (real Kotlin compile error in `:feature:foryou:impl` — repo bug, not CLI)

REAL-GREEN flips after Pass 3: a private KMP application (AGP 8.8.2 → JDK 17 picked correctly), Confetti-main (cascade-isolation: `:shared:jvmTest` succeeds when isolated from broken `:androidApp`), kotlinconf-app-main + FileKit-main (cache invalidation + AGP fix). Pre-existing REAL-GREEN: local-challenge, androidify-main.

**The 8 remaining REAL-REDs** (decompose by root cause):

- **2 are REAL test failures** — local-app-1 (`LoadingAndErrorStatesTest.errorStateWithRetryShowsButton FAILED`), nowinandroid (`feature:foryou:impl` + `lint` test tasks fail). The CLI is correctly surfacing real project bugs.
- **1 is a project-model task-name discovery bug** — a reference KMP composite project sends gradle `:core-X:desktopTest` for 37 modules; gradle says `Cannot locate tasks that match` for each one (per-module retry confirmed each individually fails). The convention plugin shape is registering tasks under different names than the project model expects. Separate v0.7.x BACKLOG entry candidate.
- **5 need per-project investigation** — a private KMP application, a private KMP application, a multi-module DI sample, nav3-recipes, PeopleInSpace — could be real test failures, JDK/dep issues, or more orchestrator bugs. The widened stderr filter now exposes their real errors so investigation is straightforward.

**The 11 REAL-REDs decompose as follows (root-cause categories that the orchestrator could mitigate but doesn't yet):**

- **JDK auto-select picks the bytecode `jvmTarget` instead of AGP's required runtime JDK.** a private KMP application has `jvmTarget = "11"` in `app/build.gradle.kts` so the orchestrator chose JDK 11; AGP 8.8.2 needs JDK 17 to RUN (separate from bytecode target). Manual `JAVA_HOME=jdk-17 ./gradlew :app:testDebugUnitTest` → BUILD SUCCESSFUL in 1m 8s. Affects: a private KMP application, possibly a private KMP application / a private KMP application / a multi-module DI sample / local-app-1 / nav3-recipes / FileKit (all show similar fast-fail patterns). Fix: in `lib/jdk-catalogue.js` discoverer / `lib/cli.js#preflightJdkCheck`, prefer the AGP-version-implied JDK over the project's `jvmTarget`. AGP version → required JDK table is publicly documented (`https://developer.android.com/build/releases/gradle-plugin#compatibility`).

- **One-shot multi-module dispatch + `--continue` + evaluation-time abort cascades.** When the orchestrator dispatches `:a:test :b:test :c:test` in ONE gradle invocation, if module A fails at evaluation phase (plugin resolution, AGP-JDK mismatch, missing SDK), gradle aborts BEFORE reaching B and C. defense-in-depth correctly marks all three as failed (none have `> Task :foo:bar` evidence in stdout). Confetti-main reproduces this: `:shared:jvmTest` succeeds in 1m 44s when invoked alone, fails when bundled with `:androidApp:testDebugUnitTest` whose evaluation aborts. Affects: Confetti-main, a reference KMP composite project (37 modules cascade-fail because some configuration bug aborts the whole graph), a private KMP application, etc. Fix options: (a) per-module gradle dispatch (slower but isolates failures); (b) detect evaluation-phase abort vs task-execution failure and report differently; (c) `--no-continue` retry split when first invocation aborts at evaluation.

- **(Already noted) jvm()→jvmTest fallback** in project model — separate `v0.7.x` BACKLOG entry below; surfaces here as `[SKIP] X (no resolvable test task)` in nowinandroid (4 modules skipped: app, core:database, core:ui, sync:work).

The CRITICAL silent-pass bug IS fixed. These 3 follow-up bugs should each get their own PR and BACKLOG entry. Defense-in-depth means they now produce HONEST RED instead of silent GREEN — already a major win for AI-agent users who can no longer be misled.

**Severity: CRITICAL. Blocks v0.8.0 release. Every parallel/coverage/changed/android/benchmark invocation on Windows produces false-positive PASS envelopes.** PRODUCT.md WS-1 contract ("never silent pass") violated by every dispatch in the migrated orchestrators on win32.

**Repro:**
```bash
node bin/kmp-test.js --json parallel --project-root C:/path/to/any-gradle-project --no-coverage --max-workers 4
# → exit_code:0, tests.passed = modules.length, parallel.legs[0].exit_code:1, duration_ms:11-722
```

**Root cause:** Node `spawnSync("gradlew.bat", args, { ... })` on Windows returns `status:null, error:'EINVAL'` because Node 18.20.2 / 20.12.2 / 22.0.0+ enforce CVE-2024-27980 which forbids direct `.bat`/`.cmd` execution without `shell:true` or explicit `cmd.exe /c` invocation. **All 5 migrated orchestrators (`parallel`, `coverage`, `changed`, `android`, `benchmark`) call `spawn(gradlewPath, ...)` with `shell:false` (the default).** Verified by direct test:

```js
spawnSync("gradlew.bat", [...], { cwd, encoding:"utf8" })            // → status:null, EINVAL
spawnSync("gradlew.bat", [...], { cwd, encoding:"utf8", shell:true }) // → status:0, real output
```

**The cascade:**
1. `dispatchLeg` calls `spawn(gradlewPath, gradleArgs, {...})` — no `shell:true` (line 409, parallel-orchestrator.js).
2. spawn returns `result.status === null`. Line 416: `const exit = (typeof result.status === 'number') ? result.status : 1;` → exit:1.
3. `result.stdout` and `result.stderr` are both empty strings (gradle never ran).
4. `classifyTaskResults(stdout, stderr, taskList)` (line 424) checks the empty `all` for `<task>\s+FAILED` regex → no match → defaults to `'passed'` (line 439: `out.set(task, re.test(all) ? 'failed' : 'passed')`).
5. Per-task loop (line 521-548) emits `[PASS] mod` for every task; `state.tests.passed += 1` for every module.
6. No `errors[]` row added; top-level `exit_code` stays 0.
7. Envelope reports GREEN with `tests.passed = modules.length` for a project where gradle was **never invoked**.

**Wide-smoke evidence** (23 gradle-rooted projects under `<workspace>/<project> run via `.smoke/run.sh`):

| Project | reported | reality | leg.exit | duration |
|---|---|---|---|---|
| a private KMP application | GREEN, 20/20 passed, 7393 individual | NEVER RAN (manual `gradlew tasks` → BUILD FAILED 16s) | 1 | 722ms |
| a private KMP application | GREEN, 10/10 passed, 4063 individual | NEVER RAN | 1 | 241ms |
| a private KMP application | GREEN, 1/1 passed | NEVER RAN (manual gradle → BUILD FAILED 1s, gradle.properties JAVA_HOME issue) | 1 | 11ms |
| local-challenge | GREEN, 1/1 | NEVER RAN | 1 | 13ms |
| a multi-module DI sample | GREEN, 3/3, 68 individual | NEVER RAN | 1 | 116ms |
| local-app-1 | GREEN, 1/1, 26 individual | NEVER RAN | 1 | 20ms |
| a reference KMP composite project | GREEN, 38/38 passed, 317 individual | NEVER RAN | 1 | 681ms |
| nav3-recipes / nowinandroid / Confetti / PeopleInSpace / androidify / kotlinconf / FileKit | GREEN, all passed | NEVER RAN | 1 | 38–143ms |
| dokka-markdown / Nav3Guide-scenes / DroidconKotlin / KMedia / KaMPKit / NYTimes-KMP / Nav3Guide-master / kmp-basic-sample / kmp-production-sample | AMBER (`no_test_modules`) | discovery short-circuited before dispatch | n/a | 11–36ms |

**14 of 14 "green" envelopes are false positives.** The 9 AMBER results never reached `dispatchLeg` (caught at module-discovery stage), so they're correct by accident.

`tests.individual_total` populated values (7393, 4063, 317, 68, 26) are **stale junit XMLs from previous bash-wrapper-era runs** that the v0.7.0 wrapper left on disk under `<module>/build/test-results/`. The walker counts them every time because no recency check exists.

**Why CI didn't catch this:**
- `tests/vitest/parallel-orchestrator.test.js` (48 cases) injects a mock `spawn` that returns synthetic stdout/stderr — never exercises real `spawnSync` on Windows.
- `tests/bats/*` runs on Linux only (no `.bat`).
- `tests/pester/*` exists but the v0.8 PIVOT shrank Pester contracts to "wrapper invokes node" assertions (sub-entry 5 removed `Invoke-ScriptSmoke.Tests.ps1` 206→? lines), losing the integration-test coverage that would have caught EINVAL.
- The `gradle-plugin-test-ios` informational job runs on macOS, not Windows.
- Manual repo-owner testing happened on a reference KMP composite project with `--test-type androidUnit --module-filter X` — same EINVAL bug, but I read the `tests.passed:1` as success during sub-entry 5 dev. (`leg.exit_code:1` was also visible but dismissed at the time.)

**Fix (trivial, ~5 LOC × 5 orchestrators = ~25 LOC):**

```js
// lib/parallel-orchestrator.js (and 4 mirror sites)
const isWin = process.platform === 'win32';
const result = spawn(gradlewPath, gradleArgs, {
  cwd: projectRoot,
  encoding: 'utf8',
  env: { ...env },
  maxBuffer: 64 * 1024 * 1024,
  timeout: opts.timeout > 0 ? opts.timeout * 1000 : undefined,
  shell: isWin,   // ← required for .bat on Node 18.20.2+ / 20.12.2+ / 22+
});
```

Caveats:
- `shell: true` triggers `DEP0190` deprecation warning in Node 22+ ("args not escaped, only concatenated"). For our case (gradle task names: `:mod:taskName` — no shell metachars in module/task names by Gradle convention), this is safe but should be quoted defensively. Cleaner long-term: invoke `process.env.ComSpec || 'cmd.exe'` with `['/d', '/s', '/c', gradlewPath, ...args]` explicitly — bypasses the deprecation entirely.
- `--tests "<filter>"` user input does flow into args; need to ensure proper escaping if going `shell:true` route, OR use the explicit cmd.exe approach.
- Same fix needed in `parallel-orchestrator.js` `--stop` daemon-stop call (line 669).

**Required additional work to PREVENT recurrence:**

1. **Live integration test on Windows CI** — at least one Pester or vitest case that does `spawn(gradlewPath, ['--version'], {...})` against a real fixture and asserts non-null status. Cost: ~20 LOC, would have caught this in PR #110.
2. **Refuse to silent-pass when leg.exit_code !== 0** — even after the spawn fix, `classifyTaskResults` should treat unclassified-tasks-after-failed-leg as `'failed'`, not `'passed'`. Defense in depth against future `[PASS]` fallthroughs. (This is also what F2 / WS-1 contract demands — already a documented invariant per PRODUCT.md.)
3. **Stale-junit guard** — `junitTestCountFor(projectRoot, task)` should filter by `mtime > orchestrator_start_time` to avoid counting prior runs' XMLs.
4. **Pre-release wide-smoke job in CI** — current process is manual repo-owner pass on Windows; should be a `wide-smoke` workflow that runs `kmp-test parallel --json` against the 5-6 curated KMP fixtures listed in PRODUCT.md success criteria + asserts `parallel.legs[*].exit_code === 0` when `tests.passed > 0` (catches the silent-pass invariant).

**Knock-on:** the previously-noted F1 / F2 / F3 findings (above, in earlier draft of this section) still apply but become low-priority. F2 (`--test-type all` double-counting) is even masked by this bug — when the spawn never runs, `--test-type all` reports false GREEN per-leg.

**Recommended sequence:**
1. Hotfix PR `fix(orchestrator): pass shell:true / cmd.exe wrapper on Windows for gradle dispatch` — touches all 5 orchestrators, adds 2-3 vitest/Pester live-integration cases, no new CLI surface.
2. Re-run wide-smoke against 23 projects, capture true GREEN/RED distribution, file follow-up tickets per RED project.
3. Then resume the v0.8.0 release-readiness gate (BACKLOG entry below).

---

### v0.8 — Sub-entry 5 follow-up findings (F1+F2+F3 ✅ FIXED 2026-05-03)

> **NOTE:** these 3 findings were discovered during the same wide-smoke pass as the CRITICAL Windows-spawn bug above. F1 + F2 closed in PR `feature/sub-entry-5-followups` (2026-05-03). F3 closed in PR `fix/android-individual-total-walker` (2026-05-03).

**✅ Finding F1 — `--dry-run` not consumed in 3 of 5 orchestrators (FIXED 2026-05-03).** `changed`, `android`, `benchmark` orchestrators now short-circuit on `--dry-run` before any spawn / git probe / adb probe, emitting `dry_run:true` envelope with subcommand-specific plan fields. +3 vitest cases. Validated e2e on macOS.

**✅ Finding F2 — `--test-type all` per-leg `no_test_modules` forced exit 3 (FIXED 2026-05-03).** Per-leg empties demoted to `warnings[].code:"no_test_modules_for_leg"` when at least one other leg produced test results. +1 vitest case. PR `feature/sub-entry-5-followups`.

**✅ Finding F3 — `tests.individual_total:0` on UP-TO-DATE / FROM-CACHE runs (FIXED 2026-05-03).** Root cause confirmed via Windows-side repro on a multi-module DI sample: 4 valid `TEST-*.xml` files at the canonical `<module>/build/test-results/<taskShort>/` path containing 68 testcases, but `mtime` from a prior run (~8 days old). The post-PR #116 stale-XML guard at `lib/parallel-orchestrator.js#junitTestCountFor` (filter `mtime >= state.runStartMs`) false-discarded all 68 because gradle marked the task UP-TO-DATE and AGP didn't rewrite the XMLs. Fix: bypass the guard in `executeLeg` when `classifyTaskExecutionMode` returns `up_to_date` or `from_cache` — gradle has already confirmed the existing XMLs reflect the current source state in those modes, so they're not stale by definition. Modes `fresh` / `failed` / `no_evidence` keep the guard active to preserve the original PR #116 protection against bash-wrapper-era leftovers. Verified live: a multi-module DI sample `individual_total` flips `0 → 68`. +3 vitest cases (`F3 fix: UP-TO-DATE …`, `F3 fix: FROM-CACHE …`, `F3 fix: fresh tasks still discard stale TEST-*.xml`).

### ✅ v0.8.0 — JDK auto-select prefers AGP runtime JDK over `jvmTarget` (DONE 2026-05-03 in `8b4c92f` / PR #116 + closeout PR `fix/jdk-auto-select-agp-runtime`)

**Surfaced 2026-05-03 during the post-EINVAL wide-smoke pass on Windows.** a private KMP application declares `jvmTarget = "11"` in `app/build.gradle.kts` so the orchestrator's JDK auto-select picked JDK 11; AGP 8.8.2 needs JDK 17 to RUN (separate from bytecode target — bytecode 11 means "produce class files compatible with Java 11 runtime", which is a different question from "what JDK does the gradle build itself need"). Manual override `JAVA_HOME=jdk-17 ./gradlew :app:testDebugUnitTest` → BUILD SUCCESSFUL in 1m 8s, confirming the bug.

**Affected (wide-smoke evidence 2026-05-03):** a private KMP application (definitive); strong fast-fail patterns in a private KMP application, a private KMP application, a multi-module DI sample, local-app-1, nav3-recipes, FileKit. All showed JDK-mismatch shape: gradle aborted in <1s with `Android Gradle plugin requires Java 17 to run` once stderr filter widening (PR #116) exposed the real error.

**Fix landed in two commits:**

1. **`8b4c92f` (bundled into PR #116, merged 2026-05-03)** — `lib/project-model.js` gains `detectAgpVersion(projectRoot)` (probes `gradle/libs.versions.toml [versions]` for `agp`/`android-gradle`/`androidGradlePlugin`/`android` keys, then plugins-DSL `id("com.android.*") version "..."`, then buildscript `com.android.tools.build:gradle:X.Y.Z`) + `agpRequiredJdk(version)` mapping (4→8, 7→11, 8→17, 9→17). The AGP-implied JDK joins `aggregateJdkSignals.signals[]` so the strictest signal wins. `agpVersion` exposed on the result envelope. 7 vitest regression cases added under `'AGP-implied runtime JDK'` (catalog 8.8.2 + 7.4.2, plugins-DSL 8.5.0, buildscript 8.2.1, a private KMP application shape, higher project toolchain wins, no-AGP KMP). Live-validated: a private KMP application now picks JDK 17, BUILD SUCCESSFUL in 4s.

2. **PR3 closeout `fix/jdk-auto-select-agp-runtime` (2026-05-03)** — `preflightJdkCheck` now returns `agpVersion` so the auto-select `[NOTICE]` banner can include `project applies AGP X.Y.Z` for diagnostic clarity. +1 AGP 9.0 regression vitest case (locks `9.x → 17` mapping; cite to live AGP 9.2.0 docs). +2 cli.test.js cases for the AGP-aware notice text.

**Final resolution precedence:**

1. Explicit `--java-home <path>` (user override; trust them)
2. AGP-version-implied JDK if project has AGP plugin AND auto-select catalogue has it
3. `gradle.properties#org.gradle.java.home` if set
4. `org.jetbrains.kotlin.jvmTarget` if no AGP (current behavior for KMP-pure-JVM and Java-only projects)
5. Host default JDK

**AGP → minimum runtime JDK mapping (verified against https://developer.android.com/build/releases/gradle-plugin 2026-05-03):**

- AGP 4.x → JDK 8
- AGP 7.x → JDK 11
- AGP 8.0+ → JDK 17
- AGP 8.8+ → JDK 17
- AGP 9.x → JDK 17 (live AGP 9.2.0 docs confirm this; an earlier draft of this entry incorrectly stated "AGP 9.0+ → JDK 21")

**Follow-up — wide-smoke pass-7:** the 5 per-project investigations (a private KMP application, a private KMP application, a multi-module DI sample, nav3-recipes, PeopleInSpace) are now unblocked. Once re-run, persistent REDs are repo-level test failures, not orchestrator bugs. Tracked as PR4 (`chore/wide-smoke-pass-7`).

### v0.8.0 — Cascade isolation: per-module retry when one-shot dispatch aborts at evaluation phase (surfaced 2026-05-03 wide-smoke; **DONE 2026-05-04 in PR5 — `fix/cascade-isolation-retry`**)

**Surfaced 2026-05-03 during the wide-smoke pass on Confetti-main and a reference KMP composite project.** When the orchestrator dispatches `:a:test :b:test :c:test` in ONE gradle invocation with `--continue`, and module `:a` fails at the **evaluation phase** (plugin resolution, AGP-JDK mismatch, SDK location not found, missing dep), gradle aborts BEFORE reaching `:b` and `:c`. The post-#116 defense-in-depth correctly marks all three as failed (none have `> Task :foo:bar` evidence in stdout) — but this is **honest RED for the wrong reason**: `:b` and `:c` would have succeeded in isolation.

**Affected (wide-smoke evidence 2026-05-03):**
- **Confetti-main**: `:shared:jvmTest` succeeds in 1m 44s when invoked alone; fails when bundled with `:androidApp:testDebugUnitTest` whose evaluation aborts. Cascade-isolated retry confirmed `:shared` is real-green.
- **a reference KMP composite project**: 37 modules cascade-fail because some configuration bug aborts the whole graph at evaluation. Per-module retry isolates the actual broken modules.
- Likely affects most multi-module projects with one misconfigured module at evaluation time.

**Note:** PR #116 already added a "one-shot dispatch aborted before any task ran — retrying per-module" path (parallel-orchestrator.js#executeLeg step 4a) which fires when `legExit !== 0 && taskList.length > 1 && !anyTaskMentioned`. It correctly classifies each retry independently. **What's pending:** verifying the cascade isolation handles every shape we've observed (especially mixed evaluation-vs-execution failures in the same dispatch — when SOME tasks ran and SOME aborted) and that it scales to the 37-module a reference KMP composite project case without timing out.

**Wide-smoke pass-7 evidence (2026-05-04, PR4):** the cascade-isolation pattern affects **8 of 30** projects swept (`a private KMP application, a multi-module DI sample, a private KMP application, nav3-recipes, a private Android-only KMP project (3 variants), FileKit-main`). Detection signature: per-leg `execution.failed === 0 && execution.no_evidence > 0` while emitting `module_failed` for every dispatched task. **PR #116's retry path did NOT fire** in any of these cases despite all documented conditions matching (`legExit !== 0 && taskList.length > 1 && !anyTaskMentioned`):
- `a private Android-only KMP project` stderr is 1 line (only the JDK [NOTICE] auto-select); no `retrying per-module` message anywhere in stdout/stderr.
- 8 cases × 0 retry firings = retry condition is too narrow OR the retry message is suppressed OR `anyTaskMentioned` is incorrectly truthy.
- One MIXED case: the reference KMP composite project — cascade in `androidUnit` leg + REAL failures in `androidInstrumented` leg. Validates that the per-leg detection (not per-project) is the right granularity.

**Fix verification (UPDATED for pass-7):**
1. **Re-investigate why retry doesn't fire** on the 8 pass-7 cases. Add `console.error` instrumentation around the `executeLeg` step 4a guard to see which condition fails.
2. Reproduce `a private Android-only KMP project` cascade on Windows (118 tasks × 4 legs, all `no_evidence`); confirm post-fix retry isolates the actual broken module(s).
3. Reproduce a private KMP application 48-task cascade (4 legs); confirm per-leg detection works (each cascade leg gets its own retry).
4. Reproduce the reference KMP composite project MIXED case (cascade in androidUnit + real failures in androidInstrumented); confirm retry fires only for the cascade leg.
5. Add ≥3 vitest cases: (a) leg with all-`no_evidence` triggers retry, (b) leg with mixed real failures + `no_evidence` does NOT trigger retry (real failures take priority), (c) a private Android-only KMP project-shape: 4 legs all-cascade triggers retry on every leg independently.
6. Add the cascade-detection signature to the orchestrator's emitted envelope as a new field (e.g. `parallel.legs[].cascade_detected: boolean`) so downstream agents can branch on it without re-deriving from execution counters.

**Effort:** ~4-6h (deeper than originally estimated; root-cause why retry doesn't fire + 6 vitest cases + envelope schema bump).

**Ship-when:** v0.8.0 release-blocker. PR5 (`test/cascade-isolation-validation`) — promoted in priority by pass-7. Wide-smoke pass-7 RED-orchestrator-cascade count must drop from 8 to 0 before v0.8.0 release tag.

**Closure (2026-05-04, PR5 `fix/cascade-isolation-retry`):**
- **Root cause:** the retry-guard regex (`Task\s+:foo:bar(\s|$)` at parallel-orchestrator.js:643) was more permissive than `classifyTaskExecutionMode`'s strict regex (`Task\s+:foo:bar(?:\s+SUFFIX)?\s*$` at parallel-orchestrator.js:501). Gradle's housekeeping/daemon log lines mentioning task names tripped the lax regex, setting `anyTaskMentioned=true` and skipping the retry, even when the strict regex (used for execution-mode classification) showed all tasks as `no_evidence`. PR #116's retry path was correct but the trigger predicate was wrong.
- **Fix:** replaced the `anyTaskMentioned` heuristic with the same execution-summary cascade signature (`exit !== 0 && execSummary.failed === 0 && execSummary.no_evidence > 0`) that pass-7's classifier uses, eliminating the divergence. Dropped the `taskList.length > 1` requirement so single-task cascades (nav3-recipes shape) also retry — surfaces the per-module gradle error context that the bundled-leg output buried. `classifyTaskExecutionMode` was hoisted above the retry guard (was at step 5 line 728, now computed at step 4a line ~620) and the post-retry execModes are recomputed from merged retry stdout.
- **Envelope additions:** `parallel.legs[].cascade_detected: boolean` + `parallel.legs[].retry_fired: boolean` exposed for downstream consumers (pass-N sweeps, dashboards, AI agents) — branch on the orchestrator's verdict directly instead of re-deriving the signature from `execution.failed`/`execution.no_evidence`.
- **Pass-7 classifier update:** when `cascade_detected=true && retry_fired=true` on every cascade leg AND post-retry summary still shows the cascade signature, the bucket flips from `RED-orchestrator-cascade` → `RED-repo` (modules independently broken at evaluation phase, not orchestrator bug). Pre-PR5 saved envelopes lack `retry_fired` (undefined → fallback signature derivation) and correctly stay as `RED-orchestrator-cascade`.
- **Tests:** +6 vitest cases (702 total, 696 baseline). Pure cascade single-leg, single-task cascade (drops `>1`), real failures NOT triggering retry, mid-line `Task` mention regression guard (the false-positive that fooled the old guard), mixed-in-leg conservative non-trigger, envelope-shape lock for the new boolean fields.
- **Live verification:** wide-smoke re-run of all 8 cascade cases on Windows; `RED-orchestrator-cascade` bucket dropped from 8 → 0. Cases redistributed: 7 → `RED-repo` (modules genuinely broken at evaluation phase, retry confirmed), 1 → outcome per project's actual gradle exit. WIDE-SMOKE-PASS-7-postfix.md captures the post-fix bucket counts.

### ✅ DONE 2026-05-04 (PR #127 / 049828a) — v0.8.0 — Confetti-main `unsupported_class_version` despite PR3's AGP-aware JDK auto-select (surfaced 2026-05-04 wide-smoke pass-7)

**Surfaced 2026-05-04 in PR4 wide-smoke pass-7.** Confetti-main classified as RED-repo (1 module_failed, 133 testcases ran). The `errors[]` array contains both `module_failed` AND `unsupported_class_version` — meaning the JDK gate did fire after PR3's AGP-aware auto-select selected a JDK. PR3 was supposed to prevent exactly this by picking the AGP-required JDK runtime over the project's `jvmTarget`.

**Hypothesis:** The auto-selected JDK satisfies AGP runtime + most modules, but ONE module compiles with a Kotlin `jvmTarget` that's higher than the auto-selected JDK can run. When that module's test class is loaded at test-runtime, the JVM throws `UnsupportedClassVersionError`. PR3's logic picked "AGP runtime JDK ≥ project's jvmTarget" but if a single module overrides jvmTarget higher than the project default, the auto-select misses it.

**Investigation steps:**
1. Read `.smoke/pass-7/Confetti-main.{out,err,json}` for the exact module + class version mismatch.
2. Check `Confetti-main/.kmp-test-runner-cache/model-*.json` for per-module `jvmTarget` values vs project root's value.
3. If single-module-overrides-jvmTarget is the cause: extend `aggregateJdkSignals` to scan per-module overrides, not just project-root signals.

**Effort:** ~2-3h.

**Ship-when:** v0.8.0 nice-to-have (not release-blocker — Confetti is an external sample; user repos that hit this should already be addressable via `--java-home` override).

### ✅ DONE 2026-05-04 (PRs #125 + #126) — v0.8.0 — `task_not_found` paired with `module_failed` in 4 projects (project-model task-name overreach; surfaced 2026-05-04 wide-smoke pass-7)

**Status: DONE 2026-05-05 — closed by fix-PR-A (#125) + fix-PR-D (#126) + fix-PR-F (#131).** Re-validated live 2026-05-05 against the 3 of 4 originally-affected projects:

| Project | Pre-fix L533 | Post-fix-PR-A/D/F (2026-05-05 live) | Closure |
|---|---|---|---|
| a private KMP application | 1 task_not_found + 48 module_failed | 0 + 0 (24 modules clean-skipped, mostly via fix-PR-D `withHostTestBuilder{}` opt-in) | ✅ |
| a reference KMP composite project | 1 task_not_found + 66 module_failed | 0 + 0 (69 modules clean-skipped via fix-PR-D) | ✅ |
| a multi-module DI sample `:benchmark` testDebugUnitTest | task_not_found | parser variable-resolution (fix-PR-F) auto-resolves `testBuildType = benchmarkBuildType` → `testReleaseUnitTest` | ✅ |
| FileKit-main | 1 + 4 | Project not properly set up locally (no gradlew.bat in current path) — kmp-test correctly errors with structured `no gradlew` message; not a regression | n/a (validate post-tag if user re-clones) |

Root cause was three-fold: (1) source-set gate missing on AGP-fallback dispatch path (fix-PR-A); (2) kmpAndroidLibrary plugin opt-in detection missing (fix-PR-D); (3) `testBuildType` variable expressions parser-blind (fix-PR-F bundled with parser enhancement). All three closed in v0.8.0 fix-PR ramp. Original entry text preserved below for context.

**Surfaced 2026-05-04 in PR4 wide-smoke pass-7.** Four projects emit BOTH `module_failed` and `task_not_found` discriminators in the same envelope: a private KMP application, a multi-module DI sample, a reference KMP composite project, FileKit-main. The `task_not_found` example from a multi-module DI sample: "Cannot locate tasks that match `:benchmark:testDebugUnitTest` as task `testDebugUnitTest` not found in project `:benchmark`."

**Root cause hypothesis:** The orchestrator's project model (`lib/project-model.js`) infers a task name (e.g. `testDebugUnitTest`) for the module from generic patterns, but THIS particular module (`:benchmark`) doesn't expose that task — perhaps it has only `connectedDebugAndroidTest` (instrumented) or a custom test task. The model's predict-from-source-sets fallback (added in PR #116) might be predicting a task that doesn't actually exist in gradle.

**Investigation steps:**
1. Read `a multi-module DI sample/.kmp-test-runner-cache/model-*.json` for `:benchmark` module's `gradleTasks` and `sourceSets` arrays.
2. If `gradleTasks` is null but `sourceSets.androidUnitTest === true`, the predictTaskFromSourceSets fallback (project-model.js:841-884) is the culprit — it predicts `testDebugUnitTest` even though gradle's task graph doesn't expose it.
3. Fix: when the model probe ran successfully but `gradleTasks` is empty for a module, treat that module as untestable for that test-type rather than predicting a task name.

**Affected (in addition to a multi-module DI sample):**
- a private KMP application — 1 task_not_found alongside 48 module_failed (entangled with cascade-isolation entry above).
- a reference KMP composite project — 1 task_not_found alongside 66 module_failed.
- FileKit-main — 1 task_not_found alongside 4 module_failed.

**Effort:** ~2-3h.

**Ship-when:** v0.8.0 nice-to-have. Lower priority than cascade-isolation fix because the impact is "1-2 false dispatches per multi-module project" rather than "entire project marked RED".

### ✅ DONE 2026-05-04 (wide-smoke pass-9 + pass-9-mac) — v0.8.0 — Wide-smoke per-project triage: confirm REDs are repo-level vs orchestrator (surfaced 2026-05-03)

**Status: DONE — process completed via wide-smoke passes 7 (PR4 / `020ea86`), 8 (during PR6 era), and 9 (PR #129 / `61704f3`).** All 6 REAL-REDs from the original triage classified as repo-bugs (a private KMP application 5-test desync, a private KMP application DesktopPKCEGenerator, local-app-1 LoadingAndErrorStatesTest, nav3-recipes RouteV2/Navigator, nowinandroid `:foryou:impl`, Confetti-main `:wearApp` 2 tests). The "5 per-project investigations" carve-out (a private KMP application, a private KMP application, a multi-module DI sample, nav3-recipes, PeopleInSpace) resolved: a multi-module DI sample + a private KMP application now pass via fix-PR-A through F (validated 2026-05-05); the other 3 remain repo-level bugs documented in pass-9 results. Pass-9 final bucket counts (per `project_v0_8_0_pass_9_shipped.md`): match pass-8 baseline 3 GREEN / 14 SKIP / 13 RED-repo / 0 cascade. Original entry text preserved below for context.

**Surfaced 2026-05-03 wide-smoke against 23 KMP/Android projects on Windows post-EINVAL.** After the spawn fix + 13 collateral fixes (PR #116), the wide-smoke produced 8 REAL-GREEN, 6 REAL-RED, 9 NO-MODULES. The 6 REAL-REDs decompose into:

| Project | Suspected root cause | Confirm in v0.8.0? |
|---|---|---|
| a private KMP application | 5 tests desync with refactored production | Repo-level (skip) |
| a private KMP application | 1 missing `DesktopPKCEGenerator` cascades 7 features | Repo-level (skip) |
| local-app-1 | 1 real test failing (`LoadingAndErrorStatesTest`) | Repo-level (skip) |
| nav3-recipes | `NavigatorTest.kt` references removed `RouteV2`/`Navigator` | Repo-level (skip) |
| nowinandroid | `:foryou:impl` Prod variant missing dep + 2 real tests | Repo-level (skip) |
| Confetti-main | `:wearApp` 2 real tests fail (`WorkManagerTest`, `ComplicationScreenshotTest`) | Repo-level (skip) |

**Plus the 5 per-project investigations** (still pending):
- a private KMP application, a private KMP application, a multi-module DI sample, nav3-recipes, PeopleInSpace — flagged as "could be real test failures, JDK/dep issues, or more orchestrator bugs" pre-AGP-JDK fix. Once the AGP-JDK fix above lands, re-run wide-smoke and each of these will resolve to one of: (a) real repo bug → document and skip, (b) orchestrator bug → file own entry.

**Process for v0.8.0:**
1. Land the AGP-JDK fix (entry above).
2. Re-run wide-smoke on Windows + Mac. Capture envelope diffs vs the 2026-05-03 baseline.
3. For each REAL-RED, do a 5-minute triage: read the stderr context (now visible post-PR #116 widening), decide product-bug vs repo-bug.
4. Product-bugs → file own v0.8.0 entry, fix in this milestone.
5. Repo-bugs → document the project + reason in PRODUCT.md "known wide-smoke skip-list" (so v0.8.0 wide-smoke gate doesn't fail on them).

**Effort:** ~3-4h (re-run wide-smoke + triage + filing).

**Ship-when:** v0.8.0 release-blocker, AFTER the AGP-JDK fix lands. Closes the "5 per-project investigations" carve-out from the silent-pass entry.

### v0.8.0 — `resolveTasksFor` returns null when `gradleTasks` is null even though `sourceSets` declares the test set (surfaced 2026-05-02; promoted 2026-05-03; CLOSED 2026-05-03 in PR #116)

**CLOSED 2026-05-03 in PR #116** — `predictTaskFromSourceSets` helper at `lib/project-model.js:841-884` plus cold-cache fallback wired into `unitTestTask` / `webTestTask` / `iosTestTask` / `macosTestTask` (5 of 6 fields; `deviceTestTask` correctly stays null since instrumented test names like `connectedDebugAndroidTest` have no source-set parity). 7 vitest cases at `tests/vitest/project-model.test.js:1804-1874` cover all 4 scenarios specified in the original fix plan plus 3 extras (JS-only, macOS, empty sourceSets, deviceTestTask-stays-null). The bats integration fixture (fix step 5) was a nice-to-have integration check; vitest coverage is comprehensive enough that the PR1 of v0.8.0 (`fix(benchmark): adaptive timeout`) closed this entry without a dedicated bats fixture PR.



**Surfaced 2026-05-02 while validating PR #103 (`fix(parallel): proactive iOS/macOS/common/desktop target filter`).** When a KMP module declares `jvm()` (no custom name), Gradle exposes the unit-test task as `:moduleX:jvmTest` — not `:moduleX:desktopTest`. The wrapper hardcodes `desktopTest` for `--test-type common|desktop`. The proactive UX-1 filter from PR #103 now lets such a module slip into the dispatch set; the reactive WS-1 fallback then catches the resulting `Cannot locate tasks that match ':moduleX:desktopTest'` as a real failure (good — no more PASS fantasma). But the user-visible result is still `[FAIL] :moduleX (task not found)`, when the correct behavior would be: per-module task lookup picks `jvmTest` from the project model and runs it green.

**Root cause** (file:line evidence): `lib/project-model.js:697-706` — when `gradleTasks` is null (probe didn't run / cache miss), `resolveTasksFor` returns all task fields as `null` — *even though* the `sourceSets` analysis available alongside it already knows which test source sets exist. Confetti reproducer from cached model `.kmp-test-runner-cache/model-1b53ddf*.json`:

```json
"shared": {
  "type": "kmp",
  "sourceSets": { "jvmTest": true, ...rest false },
  "gradleTasks": null,
  "resolved": { "unitTestTask": null, ... }
}
```

The `sourceSets.jvmTest: true` is enough signal to predict `unitTestTask: "jvmTest"` without a gradle probe — the same way `predictedCoverage` is computed at line 694-696 as a fallback for `coverageTask`. This pattern is missing for the four other resolved fields.

**Reproducer (live):** `cd $KMP_WORKSPACE/Confetti && grep -c '":jvmTest"\|"jvmTest "' .kmp-test-runner-cache/tasks-*.txt` → 5 modules with `jvmTest` task; `kmp-test parallel --test-type common --json` → 5 of those are dispatched as `:moduleX:desktopTest`, gradle "Cannot locate", reactive WS-1 catches as FAIL. Direct `./gradlew :shared:jvmTest` → BUILD SUCCESSFUL.

**Fix direction:**

1. **Add `predictTaskFromSourceSets(analysis, candidate)` helper** in `lib/project-model.js` mirroring `predictCoverageTask`. Returns the first candidate task name whose corresponding source set is `true` in `analysis.sourceSets`.
2. **Wire predicted fallbacks into the `gradleTasks==null` branch** for `unitTestTask` / `deviceTestTask` / `webTestTask` / `iosTestTask` / `macosTestTask`. Use the same candidate orders as the populated branch.
3. **Sh + ps1 readers no change needed** — they already consume `unitTestTask` via `pm_get_unit_test_task` (per-module fast path).
4. **Vitest in `tests/vitest/project-model.test.js`** — assert `resolveTasksFor('mod', null, { sourceSets: { jvmTest: true, ...rest false }, type: 'kmp' })` returns `unitTestTask: 'jvmTest'`. Repeat for desktopTest precedence, jsTest fallback, iosSimulatorArm64Test, macosArm64Test.
5. **Bats integration test** — fixture project with a single `jvm()` KMP module + stub gradlew that succeeds on `jvmTest` and fails on `desktopTest`; assert `kmp-test parallel --test-type common` dispatches to `jvmTest`, exit 0, no `Cannot locate` in output.

**Effort: 2-3h** (1h core resolver + tests, 1h fixture + bats integration, 30min sanity-check on Confetti live). Could ship in PR4 (alongside WS-3 which also touches the project-model resolver) or as its own standalone PR. Listed standalone here because it has zero coupling to Android detection (WS-3 territory).

**Cross-references:** complement to v0.7.0 Phase 1 (`unitTestTask` candidate chain landed there with the assumption that `gradleTasks` would be populated). Complement to PR #103 reactive WS-1 fix (which now surfaces this bug as a real FAIL instead of swallowing it).

### v0.8.0 — Adaptive `KMP_GRADLE_TIMEOUT_MS` per benchmark config (surfaced 2026-05-03; promoted to v0.8.0 release-blocker 2026-05-03; CLOSED 2026-05-03)

**CLOSED 2026-05-03 in v0.8.0 PR1 (`fix(benchmark): adaptive timeout per config + exit-code 3 on timeout`).** `lib/benchmark-orchestrator.js` now resolves an effective inner timeout per `--config` (smoke=300_000 / main=1_800_000 / stress=3_600_000) with override precedence: `--ignore-gradle-timeout` > `--timeout <seconds>` > `KMP_GRADLE_TIMEOUT_MS` env > per-config default. Timeout fires now surface as `errors[].code:"gradle_timeout"` and exit 3 (ENV_ERROR), distinguishing "build hung / config too tight" from "tests failed" (exit 1). `lib/cli.js` outer wrapper-level watchdog (`resolveBenchmarkOuterTimeoutMs`) bumps to `inner + 30 min buffer` so legitimate stress runs no longer trip cli.js outer SIGTERM before the orchestrator can react. 11 vitest cases cover the full resolution table + timeout-fire path on POSIX (SIGTERM) and Windows (ETIMEDOUT). Below entry retained for historical context.



**Surfaced 2026-05-03 during e2e validation of the new `--benchmark` / `--benchmark-config` parallel hook against `a reference KMP composite project:bench-io`.** `--config smoke` completes in ~1-3s; `--config stress` legitimately needs 30+ minutes (full JMH warmup + measurement iterations across 5 benchmarks). The orchestrator's default `KMP_GRADLE_TIMEOUT_MS=1800000` (30 min) is calibrated to detect hung daemons but trips on legitimate stress runs.

**Observed behavior (validated):**
- `kmp-test benchmark --config stress --module-filter bench-io --platform jvm` against a reference KMP composite project hit the 1800s timeout with the message `"gradle invocation exceeded 1800s timeout — likely a hung daemon"`. Plumbing was correct — task `:bench-io:desktopStressBenchmark` dispatched, gradle ran the JMH stress harness, just exceeded the budget.
- Exit code anomaly: orchestrator emits the timeout message but reports exit code 0 to the caller. Pre-existing in benchmark-orchestrator, not introduced by the parallel `--benchmark` hook. Worth a separate audit (timeout-as-warning vs timeout-as-error semantics).

**Proposal — adaptive timeout default by config:**

| `--benchmark-config` | Suggested default `KMP_GRADLE_TIMEOUT_MS` |
|---|---|
| `smoke` (CI / validation) | 300000 (5 min) — generous slack on the 1-3s expected |
| `main` (kotlinx-benchmark default) | 1800000 (30 min) — current default |
| `stress` (real perf measurement) | 3600000 (1 h) — or `0` to disable |

User override via env var continues to win. The `kmp-test benchmark --help` output should mention the implicit per-config defaults so users know what to expect.

**Lift:** 1-2h. `lib/benchmark-orchestrator.js` reads `KMP_GRADLE_TIMEOUT_MS` already; add a config-aware default fallback when env var is unset. Vitest covers the resolution table. Document in README's flag reference.

**Ship-when:** **v0.8.0 release-blocker** (promoted 2026-05-03 — every known bug closes before tag). Lands as a dedicated PR alongside the README refresh.

**Includes (added when promoted to v0.8.0):**
- Fix the exit-code-0-on-timeout discrepancy at the same time. Today the orchestrator emits the timeout warning but reports exit 0 to the caller; this conflates "test passed" and "build hung". Decision: timeout → exit 3 (`errors[].code:"gradle_timeout"`), with `--ignore-gradle-timeout` as the explicit bypass. Closes the audit gap surfaced 2026-05-03 against `--config stress`.

### v0.8.0 — `tests/installer/install.bats` leaves orphan adb process and hangs on macos-latest (surfaced 2026-05-02; promoted 2026-05-03; CLOSED 2026-05-03 by PR #118)

**CLOSED 2026-05-03 by PR #118 (`fix(doctor): skip adb probe via KMP_TEST_SKIP_ADB to fix bats-macos hang`).** Hypothesis-correction note: the original "install.bats spawns adb via `--version`/`--help`" framing was wrong. install.bats E2E tests use a stub `bin/kmp-test.js` (built inline by `setup_e2e_archive`) with no adb codepath; even the real CLI short-circuits `--version`/`--help` at `lib/cli.js:1498-1505` before any subcommand dispatch. The actual leak source was `tests/bats/test-doctor.bats` + `tests/bats/test-concurrency.bats` (the only files that invoke `kmp-test doctor`, which spawns `adb version` at `lib/cli.js:1411`). Fixed by adding a `KMP_TEST_SKIP_ADB=1` env opt-out in `runDoctorChecks` and exporting it from those two bats files' `setup_file` hooks. Empirical validation in PR #118: bats-macos completes in 1m48s vs prior 15-min hang; in-CI `pgrep -af adb` after the suite confirms zero residual adb processes. `tests/installer/` restored in the bats-macos CI scope.

**Surfaced 2026-05-02 by the new `bats-macos` CI job in PR #105 (WS-2 parity).** When `npx bats tests/bats/ tests/installer/` runs on `macos-latest`, the suite passes the first 227 tests cleanly (entire `tests/bats/` directory + part of `tests/installer/install.bats`) in ~3 min, then **hangs for 8 min** on the next test until the 15-min job timeout fires. Cleanup logs show `Terminate orphan process: pid (2875) (adb)` — an `adb` subprocess was spawned by one of the install.bats tests and never reaped, blocking bats's "wait for child to exit" step.

Same symptom referenced in pre-existing comment at `.github/workflows/ci.yml:70-72` ("the wider tests/bats/ suite has a hang on macos-latest"); root cause now narrowed: it's specifically `tests/installer/install.bats` (not the wider `tests/bats/`).

**Reproducer (when bats is installed locally):** `cd kmp-test-runner && /bin/bash -c 'npx bats --timing tests/installer/install.bats'` on macos-latest. Last test that completes is "E2E: install.sh fails when --archive file is missing"; the suite then hangs starting the next test. `pgrep adb` during the hang confirms a leaked daemon.

**Suspect tests:** the install.bats E2E tests run `kmp-test --version` / `kmp-test --help` after install. The `kmp-test doctor` codepath at `lib/cli.js:1306` runs `spawnSync('adb', ['version'], ...)` — on a fresh macos-latest runner without prior adb usage, this triggers `adb start-server` which forks a daemon. Bats then waits for the daemon process tree to terminate. Hypothesis to verify: doctor / version checks are spawning the adb daemon during a wrapper invocation, and bats counts the daemon as a child of the test process.

**Fix candidates:**
1. Add an explicit `adb kill-server || true` in install.bats's `teardown_file()` (or per-test `teardown()`) to reap the daemon.
2. Skip the adb probe in `kmp-test doctor` when `KMP_TEST_SKIP_ADB=1` (env opt-out) and set it in install.bats fixtures.
3. Replace `adb` invocation with a process-group-isolated spawn (`setsid` or `kill -- -$pid` on teardown).

**Workaround in flight (PR #105):** scope `bats-macos` to `tests/bats/` only. The 216 tests in that directory exercise the WS-2 regression coverage and pass in ~3 min. installer-e2e (macos-latest) at `ci.yml:45-77` already runs install.bats E2E with `--filter "E2E"` (different invocation that avoids the hang). Net effect: no parity loss for WS-2; install.bats macOS hang remains as documented follow-up here.

**Effort: 1-2h** to identify the exact test (run install.bats one test at a time on macos-latest with `--filter` until the hang triggers), confirm the adb hypothesis, and pick a fix. Likely option 1 is the minimal change.

### v0.8.0 — `bats-macos` job hangs in `tests/bats/` on macos-latest (surfaced 2026-05-02; promoted 2026-05-03; CLOSED 2026-05-03 by PR #118)

**CLOSED 2026-05-03 by PR #118.** Same root cause as the install.bats entry above — `runDoctorChecks` at `lib/cli.js:1411` spawning `adb version` whose client inherits Node's pipe FDs on macos-latest. The leak fired from `tests/bats/test-doctor.bats` (and to a lesser extent `tests/bats/test-concurrency.bats`'s lockfile-not-acquired test). Fixed by `KMP_TEST_SKIP_ADB=1` env opt-out exported from those files' `setup_file` hooks. The hypothesised BSD signal-delivery alternative for `test-concurrency.bats` (cross-referenced in fix-candidate 2 below) was NOT the cause. With the env-var fix, bats-macos completes in 1m48s and runs the full `tests/bats/ + tests/installer/` scope (parity with the ubuntu bats job). Branch-protection promotion of `bats-macos` to required is now unblocked — promote when v0.8.0 ships.

**Surfaced 2026-05-02 in PR #108** (`docs(backlog): expand v0.8 STRATEGIC PIVOT per-feature migration plan`, doc-only — no `.sh` / `.js` / test changes). The `bats-macos` CI job was cancelled at 15m17s (job `timeout-minutes: 15` at `.github/workflows/ci.yml:124`). The cancelled step is `bats (macOS — Bash 3.2 regression coverage)` which executes `npx bats --timing tests/bats/` (`.github/workflows/ci.yml:131-132`).

**This is a NEW finding distinct from the `tests/installer/install.bats` adb-orphan hang** documented in the entry above:
- The PR #105 workaround (BACKLOG entry above, "Workaround in flight") explicitly scoped `bats-macos` to `tests/bats/` only, claiming "the 216 tests in that directory exercise the WS-2 regression coverage and pass in ~3 min." That assumption no longer holds: the same scope now hangs >15 min.
- This PR (#108) modified only `BACKLOG.md`. No script, lib, or test files changed. The hang was therefore present in `develop` HEAD `d02b2f7` already and was not surfaced because PR #105's `bats-macos` introduction predated this run.

**Evidence:**
- Run URL: `https://github.com/oscardlfr/kmp-test-runner/actions/runs/25251117434/job/74043227381`
- Job conclusion: `cancelled` (15m17s wall time)
- Steps before the cancelled bats step: `Set up job` / `actions/checkout` / `actions/setup-node` / `npm ci` — all `success` → setup is not the culprit, the hang is in `npx bats tests/bats/` itself.
- Other macOS jobs in the same run completed cleanly: `build (macos-latest)` 12s pass, `installer-e2e (macos-latest)` 12s pass, `gradle-plugin-test-ios` 3m pass. None of them invoke `bats tests/bats/`.

**Reproducer (when bats is installed locally on macos-latest):** `cd kmp-test-runner && /bin/bash -c 'npx bats --timing tests/bats/'`. If hangs >5 min, reproduces. To bisect to the specific file: run each `tests/bats/test-*.bats` individually with `npx bats --timing <file>` and identify which one hangs. Suspects (priority by likelihood of spawning lingering processes / sub-shells):
1. `tests/bats/test-concurrency.bats` — already known macOS-flaky per the original comment at `.github/workflows/ci.yml:70-72` ("the wider tests/bats/ suite has a hang on macos-latest" + the BSD-vs-Linux SIGINT delivery hypothesis surfaced in PR #30 deferred entry, BACKLOG line ~404). Forks stub `gradlew` that `sleep 30`s, sends SIGINT to parent, then `wait $cli_pid` — could leak children under BSD signal-delivery semantics.
2. `tests/bats/test-android.bats` / `test-android-summary-counts.bats` / `test-parallel-ios-dispatch.bats` — invoke wrappers that may spawn `adb` (same class of orphan as the install.bats hang above).
3. `tests/bats/test-doctor.bats` — runs `kmp-test doctor` which probes adb directly (`lib/cli.js:1306`'s `spawnSync('adb', ['version'], ...)`) — same pattern as the install.bats root cause.

**Hypothesis:** likely the same adb-daemon-leak root cause as the install.bats entry above, just from a different test file in `tests/bats/`. The `KMP_TEST_SKIP_ADB=1` env opt-out documented as fix candidate 2 in the install.bats entry would address both hangs simultaneously if implemented in `lib/cli.js#runDoctorChecks` and exported to bats's setup_file(). Could ALTERNATIVELY be the BSD signal-delivery flake from `test-concurrency.bats` — those are different bug classes and need separate confirmation.

**Fix candidates** (mostly subsume into the install.bats entry's fix, but with broader scope):
1. Implement `KMP_TEST_SKIP_ADB=1` opt-out in `lib/cli.js#runDoctorChecks` (already referenced in PRODUCT.md OS matrix bullets and BACKLOG line 176); set it in BOTH `tests/installer/install.bats` and `tests/bats/` setup hooks. Single fix, both hangs closed.
2. Bisect first via `--filter` on macos-latest to pin down the exact bats file → if it's `test-concurrency.bats`, fix is the BSD-signal-delivery option from PR #30 deferred entry; if it's a different file, fix is option 1.
3. Mark `bats-macos` as `continue-on-error: true` until root cause confirmed (already done by branch-protection treating it as informational; document explicitly in `.github/workflows/ci.yml` for clarity).

**Impact assessment:** the `bats-macos` job remains informational (NOT in the 7 required CI checks per `CLAUDE.md` "Daily workflow" bullet — required set is `build x2`, `secrets-scan`, `gradle-plugin-test`, `installer-e2e x2`, `commit-lint`). PR #108 merged with the failure; future doc-only and code-only PRs will continue to merge despite the hang as long as the 7 required checks pass. **No release blocker.** Quality concern: bash 3.2 regression coverage is currently de facto disabled on macOS, leaving WS-2 (`declare -A`)-class bugs unchecked at the CI level. The 2-3h migration of `benchmark` to Node (Sub-entry 1 of v0.8 PIVOT) closes WS-2's specific bug class by construction, partially compensating for the gap until this hang is fixed.

**Effort: 2-3h.** Bisect (1h) + fix (1h via option 1, otherwise 1-2h via option 2) + CI re-run validation (30min). Recommended order: ship the v0.8 PIVOT benchmark migration first (closes the WS-2 surface that `bats-macos` is supposed to guard), then fix this hang to restore the regression-coverage net for the remaining bash plumbing across the migration window.

**Cross-references:**
- BACKLOG entry above (`tests/installer/install.bats` adb-orphan hang) — likely shared root cause; fixes should be coordinated.
- BACKLOG entry below in the QUEUED section (`macOS bats end-to-end validation (deuda from PR #30)`, line ~404) — original BSD-signal hypothesis for `test-concurrency.bats`; possibly the same bug as this one or a sibling.
- PR #105 BACKLOG entry "Workaround in flight" claim ("tests/bats/ passes in ~3 min") — invalidated by this finding; the workaround scope reduction did not actually deliver a passing macOS bats job.

### v0.8.0 — Project-level config file for stable settings (`sharedProjectName`, defaults) — surfaced 2026-05-03 — **DONE 2026-05-04 (PR6 — bundled with `.kmp-test-runner/` subdir)**

**Surfaced 2026-05-03 during the README ↔ tool-surface audit.** `--shared-project-name` is documented in the README's CLI flag tables (line 409 + line 639), but **has never existed as a CLI flag**. The legacy bash wrapper only ever read the `SHARED_PROJECT_NAME` env var; the Gradle plugin exposes it as a real DSL property (`sharedProjectName = "..."`).

The repo owner's workflow makes the design tension visible: their main project depends on the reference KMP composite project (a sibling project that's a pure-libraries package). The shared-project relationship is **stable per-checkout** — it doesn't change between runs. A per-invocation CLI flag is the wrong shape; project-level config is.

**Proposal — `.kmp-test-runner.json` (or `.kmp-test-runner.yml` / TOML) at project root:**

```json
{
  "sharedProject": {
    "name": "a reference KMP composite project",
    "path": "../a reference KMP composite project"
  },
  "defaults": {
    "testType": "common",
    "coverageTool": "auto",
    "excludeModules": "*:test-fakes,konsist-guard"
  },
  "skip": {
    "android": ["legacy-app"],
    "ios": ["bench-android"]
  }
}
```

CLI flags continue to override config-file defaults (per-invocation precedence: CLI > env > config file > built-in default). Gradle plugin DSL props continue to work the same way; they read the same config file under the hood. This lets `kmp-test parallel --include-shared` Just Work without any CLI argument or env-var setup once the config is committed.

**Pairs naturally with the `.kmp-test-runner/` subdir entry below** — both put the runner's project-level surface under a single coherent root (`.kmp-test-runner.json` for config, `.kmp-test-runner/cache/` + `.kmp-test-runner/reports/` for artifacts). One `.gitignore` line covers all artifacts; the config file is committed.

**Migration path for `--shared-project-name`:**
1. v0.8.0 README refresh: **remove** `--shared-project-name` from the CLI flag tables (it never worked there). Document `SHARED_PROJECT_NAME` env var as the current interim. Keep the Gradle DSL property.
2. v0.8.x or v0.9: ship config-file support; deprecate the env var with a friendly warning.
3. v1.0: env var removed if config-file adoption sticks.

**What else fits naturally as project config (post-config-file shape — not v0.8.0 scope):**
- Default `testType`, `coverageTool`, `coverageModules`, `excludeCoverage`
- Skip lists per platform (`SKIP_DESKTOP_MODULES` / `SKIP_ANDROID_MODULES` / `SKIP_IOS_MODULES` / `SKIP_MACOS_MODULES` env vars all become array fields)
- `--output-file` default for coverage reports
- `--module-filter` default (rare but possible for monorepo subproject focus)

**Out of scope:**
- Per-invocation flags that genuinely vary per CI job: `--json`, `--dry-run`, `--test-filter`, `--ignore-jdk-mismatch`, `--fresh-daemon`. These stay flag-only.
- Schema validation / autocompletion — defer to v0.9 with a published JSON schema.

**Effort:** ~4-6h (config loader in `lib/cli.js`, CLI > env > config precedence resolver, migration code for `SHARED_PROJECT_NAME` → file, vitest for precedence + parse). **Promoted to v0.8.0 release-blocker** (2026-05-03) — closing the `--shared-project-name` README↔CLI gap honestly requires this rather than just deleting the doc line. Without project-level config the user's "main project depends on a reference KMP composite project" workflow has no clean shape (env var is a workaround, not a feature). Lands as a dedicated PR before the v0.8.0 release readiness gate.

### v0.8.0 — Move CLI-emitted artifacts into a single `.kmp-test-runner/` subdir (surfaced 2026-05-03; promoted to v0.8.0 release-blocker 2026-05-03) — **DONE 2026-05-04 (PR6 — bundled with `.kmp-test-runner.json` config)**

**Surfaced 2026-05-03 during e2e validation of `kmp-test coverage --coverage-tool kover` on the reference KMP composite project.** The orchestrator scatters CLI-generated artifacts at the project root, mixed with the user's actual files:

- `coverage-full-report-<runId>.md` (one per run — ~20 accumulated in a reference KMP composite project after a week of iteration)
- `coverage-full-report.md` (legacy alias — overwritten each run)
- `androidtest-logs/<timestamp>/` (legacy `kmp-test android` log dir — pre-v0.8 sub-entry 3)
- `.kmp-test-runner-cache/` (project-model + gradle-tasks cache — already in subdir, only correctly-grouped artifact)

Users currently have no clean way to gitignore CLI output without enumerating every path individually. The legacy `coverage-full-report*.md` glob is fragile (third-party tools may produce similar filenames).

**Proposed shape:**

```
<project-root>/
  .kmp-test-runner/
    cache/                      # was .kmp-test-runner-cache/ (consolidate)
      model-<sha>.json
      tasks-<sha>.txt
    reports/
      coverage/
        <runId>.md
        latest.md               # symlink/copy alias (replaces coverage-full-report.md)
    logs/
      android/
        <runId>/<module>.log    # was build/logcat/<runId>/ (sub-entry 3 contract)
        <runId>/<module>_logcat.log
        <runId>/<module>_errors.json
```

**One-line `.gitignore` recipe** users can adopt:
```
# kmp-test-runner local artifacts (CLI output — never commit)
.kmp-test-runner/
```

**Migration plan:**
1. Single PR introduces `<project>/.kmp-test-runner/{cache,reports/coverage,logs/android}/` paths in coverage-orchestrator + android-orchestrator + project-model cache writer.
2. Cache layer reads from BOTH old and new paths during a transition release (v0.8.x); writes to new only. Old caches become stale and ignored.
3. Coverage reports read from new path; the `coverage-full-report.md` legacy alias at project root stays for one release with a deprecation banner inside the file ("> This file will be removed in v0.9 — see `.kmp-test-runner/reports/coverage/latest.md`").
4. Android log dir migration: `<project>/build/logcat/<runId>/` (current, since sub-entry 3) → `<project>/.kmp-test-runner/logs/android/<runId>/`. The current path is gitignored by Gradle's default `build/` exclusion already; the new path needs the user-side `.gitignore` rule.
5. README "Quick start" gains a 2-line section: "Add `.kmp-test-runner/` to your project `.gitignore` to keep CLI output out of git."

**Effort:** ~120 LOC across 3 orchestrators + 2-3 vitest cases per orchestrator covering the new path resolution + 1 cli.test.js case for the doctor / `--help` text mention. Schema bump on the project-model cache (versions to 7) so old caches at the legacy path don't get half-read on first upgrade.

**Ship-when:** **v0.8.0 release-blocker** (promoted 2026-05-03 — every known bug/improvement closes before tag). Lands as a dedicated PR after the project-level config file PR (the two pair: `.kmp-test-runner.json` config + `.kmp-test-runner/` artifacts share the same root). Cache layer keeps the dual-read transition behavior intact for one release so users coming from v0.7.x don't lose their cached models on first upgrade.

### ✅ SHIPPED 2026-05-06 (v0.9 step 6, PR #151 / `f296d21` on develop) — Buildable cross-platform E2E fixture project

**Closure summary.** New `tests/fixtures/kmp-cross-platform-e2e/` — a single buildable `:sample` module exercising every supported KMP target: `jvm()`, `js(IR) { nodejs() }`, `wasmJs { nodejs() }`, `iosX64()` + `iosSimulatorArm64()` + `iosArm64()`, `macosArm64()`, and `androidLibrary { … withHostTestBuilder { } }` (AGP 9 native KMP-Android plugin `com.android.kotlin.multiplatform.library`). Pinned to Kotlin 2.3.20 / AGP 9.0.1 / Gradle 9.1.0 (matches the reference KMP composite project + a private KMP application production). Wrapper jar (~45 KB) vendored from `gradle-plugin/`. New `tests/vitest/cross-platform-fixture.test.js` with 14 specs across 3 groups (structural integrity / `buildProjectModel` direct call / `kmp-test describe` spawn-based). Vitest 1004 → 1018. New `tests/fixtures/README.md` indexing all 10 fixtures. `.gitignore` exception for the fixture's source-of-truth `gradle.properties`. `.gitattributes` rules locking gradlew (LF) / gradlew.bat (CRLF) / gradle-wrapper.jar (binary). **Zero new CI minutes** — runs on existing `build (ubuntu-latest)` + `build (windows-latest)` jobs. Local Windows verify: `./gradlew :sample:tasks` lists per-target test tasks including `testAndroidHostTest`. **Deliberately skipped:** Gradle TestKit acceptance test invoking `:sample:tasks` against the fixture — would force AGP 9 + compileSdk 36 + Kotlin 2.3 plugin downloads on every `gradle-plugin-test (ubuntu-latest)` run, adding 3-5 min + network risk without proportional value (the static parser is what the fixture is for). Real iOS/macOS task execution stays on v0.9 step 7 (manual macOS gate). Original deferred-entry text preserved below for traceability.

---

**[Original entry — preserved for traceability]**

**Updated 2026-05-05** — scope reduced to **build only, no CI matrix** per `feedback_ci_minutes_minimal_macos.md`. Real iOS/macOS execution validation moved to v0.9 step 7 (manual macOS validation gate). The CI-matrix paragraphs below (`e2e-cross-platform.yml`, per-OS jobs) are **HISTORICAL — superseded 2026-05-05** — kept for traceability but NOT the current direction. Current scope: the fixture builds (so `kmp-test` discovery + dispatch can be exercised against it), but per-PR CI does NOT run iOS/macOS test tasks against it. Scheduled as **v0.9 step 6** in ROADMAP.

**Status: DEFERRED 2026-05-05.** Originally framed as "promoted to release-blocker per release-readiness gate #2" (entry above L172). Demoted to v0.8.x/v0.9 candidate because: (1) the 6 fix-PRs (A-F) absorbed the v0.8.0 release-validation budget; (2) ~6-10h fixture build + open-ended CI flakiness budget is not justified pre-tag when wide-smoke pass-9-mac (PR #129) already validates real iOS/macOS execution against a reference KMP composite project + 4 other projects; (3) the existing 7-required-check matrix + informational macOS jobs (build-macos, bats-macos, gradle-plugin-test-ios, installer-e2e-macos) provide acceptable CI coverage. Promote back to release-blocker at v0.9 when the milestone scope can absorb the flakiness work. Original entry text preserved below.

**Surfaced 2026-05-01 during v0.7.0 Phase 3 review.** The current iOS / macOS test coverage is the same shape as JS/Wasm/Android — model unit tests, wrapper integration tests with stub `gradlew`, Gradle TestKit acceptance — but **no real iOS / macOS test execution in CI**. This is in parity with the rest of the platforms (Android instrumented + JS/Wasm also lack real-task CI runs), so v0.7.0 ships honestly. But it's the largest single piece of testing debt the project carries: every "iOS support works" claim today rests on wide-smoke validation against the user's local KMP projects, which doesn't survive in green/red CI history.

**Proposal**: build a **minimum-viable buildable Kotlin Multiplatform fixture** under `tests/fixtures/kmp-cross-platform-e2e/` with:
- Real `gradle/wrapper/` (gradle-wrapper.jar + properties pinning a stable Gradle 8.x or 9.x)
- Real `gradlew` + `gradlew.bat`
- Root `build.gradle.kts` with kotlin-multiplatform plugin
- One module exercising **every supported target**: `jvm()`, `js(IR)`, `wasmJs()`, `iosX64()` + `iosSimulatorArm64()`, `macosArm64()`, `androidLibrary { }` (or `androidTarget()`)
- Trivial passing test in each test source set (`commonTest`, `jvmTest`, `jsTest`, `wasmJsTest`, `iosX64Test`, `iosSimulatorArm64Test`, `macosArm64Test`, `androidUnitTest`)
- Pinned Kotlin + AGP versions in `gradle/libs.versions.toml`

**[HISTORICAL — superseded 2026-05-05] CI matrix** (new workflow `e2e-cross-platform.yml`):
- `e2e (ubuntu-latest)`: runs `kmp-test parallel --test-type common` + `--test-type androidUnit` + `--test-type ios` (dispatch only — no simulator) + `--test-type macos` (dispatch only) + JS-via-jvmTest fallback. Verifies the wrapper picks the right per-module task in the JSON envelope (no real test execution beyond JVM).
- `e2e (windows-latest)`: same as ubuntu — Pester / bash-via-Git-Bash parity check.
- `e2e (macos-latest)`: full iOS + macOS execution. Boots simulator (Approach B fallback if needed), runs `:module:iosSimulatorArm64Test` and `:module:macosArm64Test` for real. This is the only place where iOS actually runs.

**Risk + cost:**
- **Risk**: high CI flakiness from network deps (Maven plugin downloads), Xcode version drift on macos-latest, simulator boot races. Initial implementation could spend 50% of effort fighting infrastructure.
- **Cost**: ~6-10h to build a working fixture + reliable CI. Net new bytes in the repo: ~70KB for `gradle-wrapper.jar` (binary).
- **[HISTORICAL — superseded 2026-05-05] Per-run CI cost**: macOS minutes are 10× ubuntu minutes — full E2E job could add 5-10 min per CI run, ~50 min macOS-equivalent per PR. (No longer applicable: per-PR CI does NOT run mac/iOS targets against this fixture; manual validation handles that.)

**When to ship:**
- v0.7.x patch — if a v0.7 user surfaces an iOS regression that the unit/integration suite missed, this becomes urgent.
- v0.8.0 minor — if v0.7 ships clean, defer to a dedicated milestone where we can budget the CI flakiness work properly.
- v1.0.0 — if v0.7 + v0.8 hold up, the bar for v1.0 is "no major iOS regressions in 3+ months", and this fixture is part of the v1.0 stability claim.

**Out of scope for this entry:**
- Re-using an existing real-world OSS KMP project (Confetti / KaMPKit) as the fixture — version drift makes our CI flakier than a pinned synthetic; only revisit if synthetic proves too much work.
- Replacing the wide-smoke local validation gate (`feedback_release_wide_smoke.md`). Both should coexist: wide-smoke catches integration-level bugs against real projects; the synthetic E2E catches regressions deterministically.

### ✅ DONE 2026-05-07 (v0.9 step 8) — surface refresh shipped 2026-05-05 (v0.8.1); cross-model re-tokenisation closed in v0.9 step 8 — v0.8.0 — README refresh + token-cost re-measurement across all CLI tools (surfaced 2026-05-03)

**Surfaced 2026-05-03 after sub-entry 5 + PR #116 + sub-entry-5-followups landed.** The README has not been refreshed since v0.6.x; v0.7.0 (iOS/macOS surface), the v0.8 STRATEGIC PIVOT (5 orchestrators migrated to Node), the EINVAL spawn fix (PR #116), and the new flags restored in PR #115 follow-up (`--fresh-daemon`, `--output-file`, `--coverage-only`, `--benchmark` + `--benchmark-config`) all need to land in the user-facing docs before v0.8.0 tag.

Concurrently, `tests/vitest/measure-token-cost.test.js` was last calibrated against the bash-wrapper-era output; the migrated orchestrators' envelope-mode output is structurally identical but the human-banner output paths diverged. The token-cost numbers reported in the README ("13K → 100 token reduction for AI agents", "~542K → ~500 tokens for the coverage 5-iter loop") need re-measurement against:
- `kmp-test parallel` — both `--json` envelope mode AND human-banner mode, across `--test-type {common, desktop, androidUnit, androidInstrumented, ios, macos, all}` × `--no-coverage` × baseline
- `kmp-test coverage` — `--json` + human modes
- `kmp-test changed` — `--json` + human, with realistic git-diff scenarios
- `kmp-test android` — `--json` + human
- `kmp-test benchmark` — `--json` + human, across `--config {smoke, main, stress}`
- `kmp-test doctor` — `--json` + human

**Tasks:**
1. Run the full token-cost measurement matrix on a representative project (e.g. a reference KMP composite project or KaMPKit) and record before/after/reduction-ratio numbers per subcommand.
2. Refresh README sections: "Why kmp-test-runner" lead numbers, "AI agents and JSON envelope" examples, the per-subcommand flag tables (add `--fresh-daemon` / `--output-file` / `--coverage-only` / `--benchmark` / `--benchmark-config` / `--dry-run` to whichever subcommands accept them post-F1).
3. Verify "Platforms supported" table still matches `lib/project-model.js` candidate chains.
4. Audit README's tool surface against `lib/cli.js#COMMANDS` — add a separate BACKLOG entry below for any tool dropped during the migration.
5. **Remove `--shared-project-name` from the CLI flag tables** (lines 409 + 639). Has never existed as a CLI flag — only the `SHARED_PROJECT_NAME` env var works, and the Gradle DSL property `sharedProjectName` works in the plugin. Replacement design tracked in the project-level config file BACKLOG entry below — the env var stays as the interim shape until that lands. Surfaced 2026-05-03 during the README ↔ tool-surface audit.

**Effort:** 2-3h ad-hoc on the maintainer's macOS once a stable wide-smoke baseline is captured.

**Ship-when:** Folded into the v0.8.0 release-readiness gate (BACKLOG entry above) — README refresh is a release-PR scope item, not standalone.

### v0.8.0 — Verify all CLI tools advertised in README are still offered post-Node-migration (✅ audited 2026-05-03; remediation pending)

**Audited 2026-05-03 during the sub-entry-5-followups PR.** First pass complete; findings below feed into the README refresh entry above. No action needed on this entry beyond folding the findings into that PR.

**Audit findings (2026-05-03):**

✅ **All 6 subcommands listed in README exist in `lib/cli.js#COMMANDS` and dispatch correctly:** parallel, changed, android, benchmark, coverage, doctor.

✅ **All concrete `kmp-test ...` examples in README execute against valid parseArgs cases.** ~25 command-line examples extracted from backtick blocks; every flag matched to a parser case in the corresponding orchestrator.

✅ **All legacy bash wrapper flags successfully migrated.** Compared `git show 1b92c6d^:scripts/sh/run-parallel-coverage-suite.sh` against `lib/parallel-orchestrator.js#parseArgs`: 20/20 legacy flags present. The 4 originally dropped (`--fresh-daemon`, `--output-file`, `--coverage-only`, `--benchmark` + `--benchmark-config`) were restored in PR #115 follow-up. **Migration is flag-complete.**

⚠️ **`--shared-project-name` documented in README's CLI flag tables (line 409 + 639) but has never existed as a CLI flag.** Legacy bash wrapper only ever read the `SHARED_PROJECT_NAME` env var; Gradle plugin DSL `sharedProjectName` does work. Pre-existing README bug, not migration loss. **Tracked separately in the "Project-level config file" v0.8.0 entry above.**

⚠️ **Flag reference table at README line 393-410 is significantly out-of-date.** Documents 8 flags; `parallel-orchestrator.js#parseArgs` parses 19+. Missing from README (need to be added or omitted with rationale): `--include-shared`, `--test-filter`, `--exclude-coverage`, `--timeout`, `--skip-tests`, `--dry-run`, `--fresh-daemon`, `--output-file`, `--coverage-only`, `--benchmark`, `--benchmark-config`. **Tracked in the "README refresh + token-cost re-measurement" v0.8.0 entry above** — this audit feeds that PR's task list.

**Ship-when:** No standalone PR — findings already documented; remediation lands as part of the README refresh PR. Close this entry when README refresh ships.

### v0.8 — KMP target tier intel for iOS/macOS strategy (surfaced 2026-05-02 during sub-entry 3 validation in a reference KMP composite project)

**Source:** repo owner's investigation in a reference KMP composite project while validating sub-entry 3 (PR #113). Captures the current Kotlin/Native target tier status that affects (a) the v0.7.0 `resolveTasksFor` candidate-chain design (`iosX64Test → iosArm64Test → iosSimulatorArm64Test` for `iosTestTask`; `macosX64Test → macosArm64Test → macosTest` for `macosTestTask`), (b) the v0.8.0 release-readiness gate's "Buildable cross-platform E2E fixture" target matrix, and (c) the `gradle-plugin-test-ios` informational job's promotion criteria.

**Tier table (Kotlin 2.x current state):**

| Target | Tier | Status | Action for kmp-test-runner |
|---|---|---|---|
| `macosArm64` | Tier 1 | Active, tested every Kotlin release | **Primary macOS target.** First in `macosTestTask` candidate chain (line 738). |
| `iosSimulatorArm64` | Tier 1 | Active | **Primary iOS test target.** First in `iosTestTask` chain. |
| `iosArm64` | Tier 2 | Active (physical device, publish-time) | Keep in chain for device runs; not test-runtime on Apple Silicon hosts. |
| `iosX64` | Tier 2 | Active (Intel sim — won't execute on Apple Silicon hosts) | Keep in chain BUT document the Apple Silicon caveat. |
| `macosX64` | Deprecated | Removed in Kotlin 2.4.0 | **Drop from `macosTestTask` candidates** when the v0.8.0 fixture pins Kotlin 2.4+. Keep in v0.7.x for back-compat. |

**Implications for the v0.8.0 release-readiness gate's E2E fixture (BACKLOG entry "Buildable cross-platform E2E fixture project"):**

- Fixture target list: `jvm()`, `js(IR)`, `wasmJs()`, `iosSimulatorArm64()` + `iosArm64()` (NOT `iosX64()` — won't execute on the macos-latest CI runner which is Apple Silicon since 2024). Drop `macosX64()` (deprecated, gone in 2.4).
- Pin Kotlin 2.4+ AGP 8.x — captures the post-`macosX64` shape that ships with v0.8.0.
- `e2e (macos-latest)` job runs `:module:macosArm64Test` + `:module:iosSimulatorArm64Test` — these are the two Tier 1 paths and the only ones that ACTUALLY execute on the runner.
- `gradle-plugin-test-ios` promotion (currently informational) gets the same tier-1-only test list.

**What's testable on the maintainer's Apple Silicon Mac WITHOUT a physical iPhone (per repo owner's research):**

| Test type | How |
|---|---|
| `commonTest` unit | `:module:macosArm64Test` + `:module:iosSimulatorArm64Test` — same `commonMain` runs in both K/N runtimes |
| iOS-specific unit | `:module:iosSimulatorArm64Test` — simulator is a real iOS runtime (same K/N, same Foundation/UIKit) |
| macOS-specific unit | `:module:macosArm64Test` — native on host |
| Compose UI Desktop | native on macOS |
| Compose UI iOS | XCUITest on simulator |
| Producer ↔ Consumer integration | macOS process + iOS Simulator process share `localhost`/`127.0.0.1` loopback (simulator shares host network) |
| Deep links / Universal Links | `xcrun simctl openurl` on simulator |
| Push notifications | `xcrun simctl push` on iOS 16+ simulator |
| Foundation / UIKit / CoreData APIs | all functional on simulator |

**What requires a physical device (out of scope for kmp-test-runner CI; deferred to TestFlight / Firebase Test Lab / BrowserStack farms):**

- Bluetooth / MultipeerConnectivity (no simulation, hardware only)
- Camera / Mic with real data (simulator injects fake video)
- HealthKit, sensors (accelerometer, precise GPS) — limited or stub
- Performance characterization (simulator uses Mac CPU, not A-series chip)
- Battery / thermal throttling
- Realistic memory pressure / OOM (simulator inherits host GB)
- App Store / TestFlight signing flow
- iOS sandbox-specific bugs (simulator sandbox is more permissive)

**Producer ↔ consumer integration test pattern (no physical device required):**

1. Gradle test target arranges the producer macOS process via `exec` task.
2. `xcrun simctl boot` + `xcrun simctl launch` boots the iOS Simulator from Gradle.
3. JVM-side test driver (`junit` / `kotlin-test`) asserts on observable behavior (HTTP requests, files, sockets, IPC).
4. Producer ↔ consumer comms over `localhost` / `127.0.0.1` (simulator shares host loopback).

This pattern covers ~90-95% of integration bugs. The remaining 5% (hardware/performance) is industry-standard "TestFlight beta + device farm" territory — outside this product's scope.

**Action items (defer to v0.8.0 release-readiness work, after sub-entries 4+5 close):**

1. Update `lib/project-model.js#resolveTasksFor` `macosTestTask` candidate chain (line 742) to drop `macosX64Test` once the v0.8.0 fixture pins Kotlin 2.4+. Pre-2.4 users still get the candidate via the legacy ordering.
2. v0.8.0 fixture targets: `jvm`, `js(IR)`, `wasmJs`, `iosSimulatorArm64`, `iosArm64`, `macosArm64`, `androidLibrary` / `androidTarget` — drop `iosX64` + `macosX64`.
3. README "Multi-platform test dispatch" section (v0.7.0): add an explicit note that `iosX64Test` / `macosX64Test` won't execute on Apple Silicon hosts (only show up via cross-compilation publish). Document the test-time vs publish-time distinction.
4. `gradle-plugin-test-ios` promotion: same tier-1-only test list as the E2E fixture — `:module:macosArm64Test` + `:module:iosSimulatorArm64Test` are the only two that execute on the runner.

**Effort:** ~2-3h folded into v0.8.0 release-readiness gate (1) cross-OS parity workflow + (2) fixture build. Documentation update lands as a follow-up README polish PR pre-tag.

### ✅ HISTORICAL — Wide-smoke validation findings (mom's MacBook session, 2026-05-01)

> **STATUS (2026-05-03):** All WS-1 through WS-10 + UX-1/UX-2 findings closed via v0.8 sub-entries 1-5 (PRs #110-#115) + PR #116 EINVAL fix + sub-entry-5-followups (this PR). Entry preserved for historical context (the original 11-issue triage that drove v0.8 STRATEGIC PIVOT scoping).
>
> **What replaced it:** the post-#116 wide-smoke baseline lives in BACKLOG entry "v0.8 — ✅ Silent-pass class FIXED" (line ~199) and the 3 follow-up v0.8.0 entries (JDK-AGP, cascade isolation, per-project triage). Future wide-smoke surfaces feed those entries, not this one.

**Surfaced 2026-05-01 during cross-project wide-smoke validation against PeopleInSpace, Confetti (multi-module ~13 subprojects), and KaMPKit at `$KMP_WORKSPACE/`. Validation hardware: Galaxy S22 Ultra (SM-S908B, Android 16, arm64-v8a, instrumented tests), iOS 26.4 Simulator runtime (10 devices: iPhone 17 Pro/Air/17e, iPad Pro M5, etc.), JDK catalogue 11/17/21, host JDK 21 default.** Eleven issues uncovered (twelfth `SKIPPED_MODULES` fix tracked separately below). Target: clear ALL before v0.8.0.

The session ran an end-to-end reproducible matrix: every `--test-type {common,androidUnit,androidInstrumented,desktop,macos,ios,all}` × {PeopleInSpace, Confetti, KaMPKit} plus all five subcommands (`parallel`, `android`, `changed`, `coverage`, `benchmark`). Logs preserved at `/tmp/kmp-{pis,conf,kk}-*.log` on the host machine for evidence. The whole-session HANDOFF lives at `$KMP_WORKSPACE/../HANDOFF.md`.

**🔴 Critical (false-positive PASS / broken subcommand):**

- **Bug WS-1 — PASS fantasma when Gradle reports "task not found".** `scripts/sh/run-parallel-coverage-suite.sh` interprets ANY `gradle exit 1` as "deprecation warning + tasks passed individually" (the v0.5.0 Bug C workaround). When exit 1 is from `Cannot locate tasks that match ':moduleX:iosSimulatorArm64Test'` (module without that KMP target), the script reports `[PASS] moduleX` and the JSON envelope says `tests.passed = N, errors = []`. Confirmed reproducer: `cd Confetti && kmp-test parallel --test-type ios` reports 4 PASS in 15s (identical with/without iOS Simulator runtime installed); direct `./gradlew :androidApp:iosSimulatorArm64Test` immediately returns `BUILD FAILED in 981ms` with "task not found". Same false-positive applies to `--test-type macos` (4 PASS in 16s on modules without `macosArm64()`). Fix direction: the `gate_gradle_exit_for_deprecation` path (sh + ps1) must distinguish `BUILD FAILED ... Cannot locate tasks that match` from `Deprecated Gradle features were used` before counting un-named tasks as pass. Concrete signal: presence of `Cannot locate tasks that match` substring in stdout/stderr → real failure, emit `errors[].code = "task_not_found"` (already a defined code, just not wired here) and reflect in exit code. **Effort: 2-3h** (sh + ps1 + tests). Risk: the per-task PASS/FAIL parsing today is line-prefix-based; need to anchor task-not-found detection to the gradle exception block.

- **Bug WS-2 — `run-benchmarks.sh` uses `declare -A` (Bash 4+) on macOS Bash 3.2.** Lines 242, 338, 339 declare associative arrays `MODULE_STATUS`, `MODULE_BENCHMARK_COUNT`, `MODULE_AVG_SCORE`; macOS default Bash 3.2.57 fails immediately with `declare: -A: invalid option`. `kmp-test benchmark` is broken on every macOS without `brew install bash` first. Sister scripts already document this as a known gotcha (`run-changed-modules-tests.sh:133` "Use temp file instead of declare -A for Bash 3.2 compatibility"; `run-parallel-coverage-suite.sh:202` "Build set of modules from settings.gradle.kts (Bash 3.2 compatible — no declare -A)"). The benchmark script slipped through. Reproducer: `cd Confetti && kmp-test benchmark --config smoke` → exit 2, `errors[0].code:"no_summary"` after 368ms; module discovery and platform detection had succeeded (logged "Found 2 benchmark module(s): androidBenchmark, wearBenchmark", "JVM Desktop OK", "Android — SM_S908B (physical) OK"). Fix: port the same parallel-strings-array workaround used in `run-parallel-coverage-suite.sh` (lookup via `module_status_<i>` indexed scalars + `string|key|string` join). **Effort: 1-2h** for all three usages + a Bash-3.2 syntax-only smoke test in CI on `macos-latest`.

**🟠 High (agent / automation impact):**

- **Bug WS-3 — `kmp-test android` subcommand finds 0 modules where `parallel --test-type androidInstrumented` finds 4** in the same project root. Reproducer: `cd Confetti && kmp-test android` → "ERROR: No modules found with androidTest directory" exit 1; `kmp-test parallel --test-type androidInstrumented` → 4 PASS (`:androidApp:`, `:backend:service-import:`, `:shared:`, `:wearApp:connectedDebugAndroidTest`) in 17s on S22 Ultra. Plus `kmp-test android --list-only` reports "Android Test Modules (1):" with the listed name empty (`-  -`). Three different module-detection paths with three different criteria: (a) `parallel --test-type androidInstrumented` uses gradle task probe (works), (b) `android` subcommand looks for literal `src/androidTest/` directory (misses KMP `androidTarget()` modules where the source set is `androidInstrumentedTest/` or implied by KMP DSL), (c) `android --list-only` somewhere counts but doesn't render. Fix: consolidate Android detection through the project-model fast path (`pm_get_*_test_task` style — already proven in v0.5.1 Phase 4 refactor) so all three callers see the same module set. **Effort: 3-4h** (model.json field if missing + sh/ps1 readers + cli wiring + tests). Cross-references v0.7.0 surface (Bug B' / B'' from v0.5.1).

- **Bug WS-4 — `kmp-test changed` does not detect modifications under module source-set directories.** Reproducer: in Confetti `git status -s` showed `M shared/src/commonMain/kotlin/dev/johnoreilly/confetti/Model.kt` (clean modify). `kmp-test changed --show-modules-only` reported "No modules with uncommitted changes detected" + JSON `errors[0].code:"no_summary"` with `exit_code:0`. The `:shared` module clearly contains the file. Suspected: `scripts/sh/run-changed-modules-tests.sh` git-diff-to-module mapping does not enumerate KMP source-set subdirs (commonMain/androidMain/iosMain/etc.) under `<module>/src/`, only top-level module-root paths. Plus envelope inconsistency: human-readable output produced a recognizable "No modules…" line but the wrapper Node parser still flagged `no_summary` (treating "no detected modules" as an error rather than a clean zero-set). Fix: (a) module-mapping must walk all source-set leaves (the same 18-entry sourceSetNames list from v0.7.0 Phase 1); (b) parser must recognize "No modules with uncommitted changes detected" as a clean exit (similar to v0.6.2 Gap 1.1's `no_test_modules` discriminator). **Effort: 2-3h** (mapping fix + new discriminator + tests). Tagentially related to v0.6.2 Gap 1 hierarchy.

- **Bug WS-5 — `errors[]` populated while `exit_code:0`.** Confetti `--test-type common --json` returned `errors[0].code:"task_not_found", message:"Cannot locate tasks that match ':androidApp:jacocoTestReport'..."` AND `exit_code:0` simultaneously. Either the task-not-found is a real failure (and exit must be ≠0) or it's a recoverable warning (and belongs in `warnings[]`, not `errors[]`). Today both can fire and an agent reading `errors.length > 0` to branch on failure will get false positives on a passing run. Same root issue surfaces with WS-1 from a different angle. Fix: define the contract — anything in `errors[]` MUST correspond to non-zero exit; recoverable should move to `warnings[]`. **Effort: ~1h** once WS-1 is in flight (likely same PR).

- **HANDOFF UX-1 (still alive in v0.7) — modules with `commonTest` but no `jvm()`/`androidTarget()` go invisible.** KaMPKit `:shared` declares `commonTest`, `androidHostTest`, `iosTest` source sets per `settings.gradle.kts include(":shared")` and on-disk `shared/src/{commonTest,androidHostTest,iosTest}` — yet `kmp-test parallel --test-type common --json` returns `modules:[]` AND `skipped:[{module:"app", ...}]`: `:shared` appears in **neither** array. Today users see "no modules ran" with no clue why. Fix: when filesystem walker observes a test source set on a module that lacks the requested test-type's target, emit `skipped[{module, reason: "no <target>() target for --test-type <X>"}]` instead of dropping the module entirely. **Effort: 1-2h.** Also addresses HANDOFF UX-2 (below) by giving the user real signal instead of the misleading default error.

**🟡 Medium (DX / observability):**

- **Bug WS-6 — `--test-type all` does not span all types.** Both PeopleInSpace and Confetti runs of `--test-type all` invoke only `:*:desktopTest` (4 tasks, identical to `--test-type desktop`); androidUnit / androidInstrumented / common / macos / ios are NOT ALSO dispatched. Either the flag is misnamed or the dispatch is incomplete. If "all" is supposed to span every supported type, the fix is wide (sh + ps1 dispatch one set per type, parallel across types). If "all" is "auto-pick the best fit per module", the rename is `--test-type auto` and that's a CLI surface change. **Effort: 1h** for design clarification + 2-4h once direction is chosen.

- **Bug WS-7 — `--test-type common` maps to `desktopTest`** (not to a true `commonTest`-source-set runner). Functionally OK in pure-KMP modules where common tests are inherited by JVM target, but the naming surprises new users who pass `--test-type common` expecting "run only the common source set". Document explicitly OR rename to `--test-type jvm` to align with the gradle task name. **Effort: 30min** (docs-only fix in `parallel --help` + flag-reference table) or 2-3h if renamed (alias + deprecation path + tests).

- **Bug WS-8 — `tests.total` counts gradle tasks, not individual tests.** Across all matrix runs `tests.total` equals `count(gradle test tasks invoked)` — `:app:testDebugUnitTest` reports 1 even when its junit-XML has 5 method results. For an agent budgeting on test counts (e.g. CI sharding, regression blast-radius assessment) this is wrong by 1-2 orders of magnitude. Fix: parse junit XML reports under `<module>/build/test-results/<task>/TEST-*.xml` post-run, sum `<testsuite tests="N">` per task. **Effort: 3-4h** (reports walker + per-OS path quirks + tests + JSON envelope shape addition `tests.tasks` vs `tests.total`).

- **Bug WS-9 — `modules:[]` JSON envelope empty even when `tests.passed > 0`.** Across PeopleInSpace runs with 3 PASS, the `modules` array stayed `[]`. The agent today has to infer module names from `skipped[]` complement against `settings.gradle.kts`. Fix: per-module result entries must populate `modules[]` regardless of coverage data presence. Likely a one-line fix in the report-builder. **Effort: 1h.**

- **Bug WS-10 — `kmp-test android --list-only` shows "Android Test Modules (1):" with empty name.** Renderer prints the count from one source and the names from another (and the names path resolves to "" or whitespace). Fix: align rendered list with the count-source; use the project-model fast path. Pairs with WS-3. **Effort: ~1h** (likely subsumed by WS-3).

- **HANDOFF UX-2 (still alive in v0.7) — misleading "No modules found matching filter: *" when `--test-type` is the filter that rejected.** KaMPKit `kmp-test parallel --test-type common` (no `--module-filter`) returns `errors[0].code:"no_test_modules", message:"No modules found matching filter: *"`. The literal filter `*` is correct; what filtered everything out was the test-type. Cross-references v0.6.2 Gap 1.1 (the `no_test_modules` discriminator was added but the message text retained from before). Fix: change message to "No modules support the requested --test-type=<X>" when the cause is type filtering vs the `*` filter. **Effort: 1h** (message wording + test).

**Out of scope for this entry:**
- The `SKIPPED_MODULES[@]` unbound fix — handled in its own backlog entry below (patch already validated, awaiting first PR).
- Re-measuring token-cost tables to capture iOS / macOS dispatch cost — already a separate backlog entry.
- Any new feature work (WS-* are all bugs, not features).

**Aggregate effort estimate:** ~20-25h to clear all 11 (sequential), or 3-4 PRs of 5-7h each if grouped: PR1 (WS-1 + WS-5 + UX-2) — error/exit-code consistency; PR2 (WS-2) — benchmark Bash 3.2; PR3 (WS-3 + WS-10 + UX-1) — Android detection + invisible-module fix; PR4 (WS-4 + WS-6 + WS-7 + WS-8 + WS-9) — DX cleanup. Suggested order by user-impact: WS-1 → WS-2 → WS-3/UX-1 → WS-4 → DX bundle.

**Wide-smoke evidence:** logs at `/tmp/kmp-{pis,conf,kk}-*.{log,json}` on the macOS validation machine (2026-05-01); npm-link active there (global `kmp-test` → `$KMP_WORKSPACE/kmp-test-runner`). Direct gradle reproductions captured for WS-1 evidence.

### ✅ OBSOLETE — `SKIPPED_MODULES[@]` unbound under Bash 3.2 set -u (resolved by v0.8 PIVOT 2026-05-03)

**Resolution:** the v0.8 STRATEGIC PIVOT (sub-entry 5, PR #115) replaced `scripts/sh/run-parallel-coverage-suite.sh` (1,701 LOC) with a 28 LOC thin Node launcher. The line `scripts/sh/run-parallel-coverage-suite.sh:779` referenced in this entry no longer exists. The Bash 3.2 array-expansion bug is structurally impossible in the migrated `lib/parallel-orchestrator.js` (Node has no equivalent gotcha). Locked-in regression coverage: `tests/vitest/parallel-orchestrator.test.js` test "`partitionBySkipEnv` empty SKIP_* env partitions cleanly (locks Bash 3.2 SKIPPED_MODULES regression into JS)".

**Original report below preserved for historical context only:**

**Surfaced 2026-04-30 (HANDOFF.md, sesión previa). Validated 2026-05-01 with reverted-then-restored A/B experiment.**

`scripts/sh/run-parallel-coverage-suite.sh:779` references `"${SKIPPED_MODULES[@]}"` directly. macOS Bash 3.2.57 (default) treats expansion of an empty array as unbound under `set -u`, so the script crashes BEFORE producing any test/build summary whenever no module is skipped (e.g. when `--include-untested` overrides every auto-skip, or when the project happens to have zero skip candidates).

Reproducer (validated this session): `cd $KMP_WORKSPACE/PeopleInSpace && kmp-test parallel --test-type common --include-untested --json`
- **Without fix**: `exit_code:1, duration_ms:1348, errors[0].code:"no_summary", tests.total:0` (script dies in ~1.3s, before gradle).
- **With fix**: `exit_code:0, duration_ms:16581, tests.passed:7, skipped:[]` (script proceeds normally; with `--include-untested` 7 tasks run end-to-end).

Fix is **one line**, applied locally on mom's MacBook but **NOT committed**:

```diff
-for skipped in "${SKIPPED_MODULES[@]}"; do
+for skipped in "${SKIPPED_MODULES[@]+"${SKIPPED_MODULES[@]}"}"; do
     skipped_list="${skipped_list}|${skipped}|"
 done
```

Pattern is the **idiomatic one already used in this same file at line 792** for `TEST_TASKS` / `TEST_TASKS_SHARED`. Preferred over `${arr[@]:-}` (HANDOFF's first instinct) because `:-` introduces a phantom empty-string element when the array is empty (`for` runs once with `skipped=""` and pollutes `skipped_list` with `||`). The `${arr[@]+"${arr[@]}"}` form expands to nothing on empty arrays — clean.

**Test coverage gap to close in same PR:**
- bats test: assert exit 0 when `SKIPPED_MODULES` is empty (use a fixture project where every module has test sources, or use `--include-untested`).
- Pester equivalent N/A — PowerShell associative arrays don't have this Bash-3.2 specific semantics (script runs Windows path).

**Effort: 30-45 min** (1-line code fix, 1-2 bats tests, 1 vitest if the JS layer touches the codepath, PR description with the A/B evidence above).

**Suggested first PR for the v0.7.x patch run** — small, isolated, evidence-rich, high signal-to-effort. Good warm-up before tackling WS-1 (which is the architecturally trickiest of the wide-smoke findings).

### ✅ DONE 2026-05-05 (v0.8.1 / PR #142) — v0.7.x / v0.8 — Community standards (issue + PR templates)

**Surfaced 2026-05-01.** GitHub flags the repo as missing two community-standards files:

- `.github/ISSUE_TEMPLATE/` — at minimum a `bug_report.md` and `feature_request.md` (or YAML form templates). The README's "How to file an issue" path today is implicit; templates make first-time contributors land on a structured form.
- `.github/PULL_REQUEST_TEMPLATE.md` — a single-file template that pre-fills the PR description with the standard sections we already use ad-hoc (Summary, What changed, Tests, Out of scope, Test plan). Today every PR copies the shape from a previous PR's description; codifying it in a template removes that drift.

Both are tiny single-file additions (~50-100 lines each). Pair with a CONTRIBUTING.md cross-reference (already exists). Estimated effort: 30-45 min total.

### ✅ SUPERSEDED — Refresh token-cost measurement tables (folded into v0.8.0 README refresh entry above 2026-05-03)

**Surfaced 2026-05-01 during v0.7.0 README revamp.** The token-cost numbers in the README were captured at v0.5.0. The JSON envelope shape barely changed since (additive fields only — `skipped[]` in v0.6.2, `iosTestTask` / `macosTestTask` in v0.7.0 when those test types are picked), so the numbers remain representative within ±5%. But the date is now stale.

Refresh approach:
- Re-run `tools/measure-token-cost.js` against the reference KMP composite project for all 4 features × 3 approaches × cross-model. ~$10-15 USD in Anthropic API calls.
- Add a new column / row showing iOS or macOS dispatch token cost (different envelope content vs JVM).
- Update the timestamp note in the README (currently absent — should say "Measured at v0.X.Y on YYYY-MM-DD").
- Optional: bump bar resolution / column widths if the new layout (post-v0.7.0 redesign) exposes any awkward wraps.

Effort: ~2-3h total (1h re-running, 1h reviewing, 30-45 min editing the tables). Defer to v0.8 unless a v0.7.x bug pushes the JSON envelope shape (in which case re-measure becomes load-bearing).

### ✅ SUPERSEDED — Update README to reflect post-v0.6.x feature surface (folded into v0.8.0 README refresh entry above 2026-05-03)

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

### ✅ v0.6.2 — Refine `no_summary` discrimination into specific sub-codes (DONE 2026-04-30 in v0.6.2 — PRs #91-#94)

**Status: DONE 2026-04-30 in v0.6.2** (PRs #91-#94 — see `project_v0_6_2_shipped.md` memory). All three sub-gaps shipped: Gap 1.1 (`errors[].code = "no_test_modules"` discriminator on parse-gap fallback) + Gap 1.2 (`state.skipped: [{module, reason}]` array on JSON envelope) + Gap 1.3 (`applyErrorCodeDiscriminators` preempts generic `no_summary` fallback when a specific code fires; locked by 4 vitest regression-guards). Live-validated: wide-smoke ALL phase against 28 projects: 5/5 wild Gap 1.1 hits + 0 generic `no_summary` + 0 AMBER-JDK. **Gap 1.4 (out of scope) — `[KMP_TEST_EXIT_REASON]` structured stdout line** remains deferred (would require a protocol break to v0.7+; no demand surfaced post-shipping). Original entry text preserved below.

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

### ✅ Multi-JDK auto-selection per project (DONE — sub-items 1-4+6 shipped via v0.6.1 + v0.8.0 PR3 + fix-PR-B; sub-item 5 tracked in entry below)

**Status: DONE.** All 6 investigation questions addressed across 3 release ramps. Verified live 2026-05-05 (file paths + grep counts):

1. ✅ **Detect installed JDKs** — `lib/jdk-catalogue.js` (v0.6.1) walks Adoptium / Zulu / Microsoft / Semeru / BellSoft on Win; `/Library/Java/JavaVirtualMachines/` on macOS; `/usr/lib/jvm` + `/opt/{java,jdk}` on Linux.
2. ✅ **Match required JDK + auto-select** — `aggregateJdkSignals` + `agpRequiredJdk` + `preflightJdkCheck` (3 lib files: `lib/project-model.js`, `lib/cli.js`, `lib/runner.js`). v0.8.0 PR3 (`0910615`) added AGP-runtime aware selection (e.g., AGP 8.x → JDK 17 even when `jvmTarget = "11"`). fix-PR-B (PR #127 / `049828a`) added preserve-host-when-meets-floor logic.
3. ✅ **Surface in `kmp-test doctor`** — "JDK catalogue" check row (3 mentions in `lib/cli.js`).
4. ✅ **`--java-home <path>` hoisted to CLI** — 8 occurrences in `lib/cli.js` parser + propagation chain.
5. ⏭️ **Per-project config presets pinning JDK path** — TRACKED IN NEXT ENTRY ("Per-project config presets" — partial: `.kmp-test-runner.json` project-local shipped in PR6; user-global `~/.kmp-test/config.json` deferred).
6. ✅ **`gradle.properties#org.gradle.java.home` precedence** — bypasses gate (final-resolution-precedence rule documented in JDK auto-select entry above).

Original entry text preserved below.

When running `kmp-test parallel` against many KMP projects in one session, each project may require a different JDK (KaMPKit JDK 11 / nav3-recipes JDK 11 / Confetti JDK 17 / a reference KMP composite project JDK 21). Today the user must restart the shell with a different `JAVA_HOME` between projects, or pass `--ignore-jdk-mismatch` to bypass the gate. Wide-smoke surface 2026-04-30: 4/20 surveyed projects exited 3 with `jdk_mismatch` because the host's `java -version` was 21.

Investigation questions:
1. **Detect installed JDKs** — common locations on each platform (Eclipse Adoptium / Zulu / Microsoft Build / SAP / `/usr/libexec/java_home -V` on macOS / `update-alternatives --list java` on Linux / `where java` + Registry on Windows). Build a catalogue at startup.
2. **Match required JDK** — when `findRequiredJdkVersion` returns N and the catalogue has a matching install, use it for the spawn (export `JAVA_HOME=<path>` to the gradle subprocess). Bypass the gate.
3. **Surface in `kmp-test doctor`** — list installed JDKs + show which one would be chosen for the current project.
4. **`--java-home <path>`** flag already exists in `scripts/{sh,ps1}` (added v0.5.1 Bug F). Hoist it to the CLI layer so users can override the auto-detected pick.
5. **Per-project config presets** (sister entry below) could pin a specific JDK path — useful when auto-detection picks the wrong major (e.g. project tests fail under JDK 21 even though it satisfies the toolchain version).
6. **`gradle.properties` precedence** — `org.gradle.java.home=<path>` already bypasses the gate; the auto-selection should respect this when present.

Estimated effort: ~3-4h for catalogue + match + doctor surfacing. Probably v0.6.x or v0.7.

### Per-project config presets (post-v0.5.1 idea — DONE)

**Status: DONE in two parts**:
- ✅ **Project-local `.kmp-test-runner.json`** shipped 2026-05-04 in PR6 (`63a292b`). Schema covers `sharedProject`, `defaults`, `skip` per platform. Loader at `lib/project-config.js`. Precedence: CLI > env > config file > built-in default.
- ✅ **User-global `~/.kmp-test/config.json`** shipped 2026-05-16 in v0.10 #3. New `lib/user-config.js` (loader + `resolveProjectKey` via git-remote → rootProject.name → basename fallback + `mergeConfigs`). `lib/project-config.js` exports `loadMergedConfig` for the dispatch path; the CLI auto-injects `--java-home` from the user-global preset via `applyConfigDefaults`. Schema = full parity with project-local + user-global-only `java_home`. Precedence chain extended to `CLI > env > project-local > user-global > built-in default`. Security: project-local `java_home` is dropped + warned (closes supply-chain vector). Doctor surfaces a "User config" row.

Original entry text preserved below.

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
      "a reference KMP composite project": {
        "java_home": "C:/Program Files/Zulu/zulu-21",
        "benchmark": { "config": "main" }
      },
      "<personal-android-only>": {
        "benchmark": { "platform": "android", "config": "smoke", "test_filter": "*Scale*" }
      }
    }
  }
  ```
- `kmp-test benchmark --project a reference KMP composite project` reads the preset and applies env + flags.
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

### Side-issue documented in a reference KMP composite project (NOT a kmp-test-runner bug)

- `bench-store` with `kmp-test benchmark --config main --platform jvm` on JDK 21 Windows produces `org.gradle.launcher.daemon.client.DaemonDisappearedException`. The CLI handles this cleanly — emits structured `errors[].code = "module_failed"` envelope. Likely root cause is **MMKV native lib + kotlinx-benchmark + Gradle 9.1 + JDK 21 + Windows** combo (the `BenchmarkMmkvAdapter` class crashes the daemon JVM during benchmark fork). To fix in **a reference KMP composite project side**: try `--no-configuration-cache`, increase `org.gradle.jvmargs=-Xmx8g`, isolate the failing benchmark, or update kotlinx-benchmark plugin version. Other benchmark modules (V13: `*bench-net*`) run cleanly with the same setup.

### Deferred

- **README hero banner** — hand-drawn banner from 2026-04-27 has typos (`CONTEXTUAUZATION`, `"savings_rae"`) and informal style that may not fit the "professional infra tool" positioning. Postponed past v0.5.0 pending a cleaner regeneration. File on user's Desktop: `FondoKMPtestRunner.jpeg`.

---

## QUEUED — post-v0.3.4 ideas (newest first)

### ✅ DONE 2026-06-07 — `.gitattributes` LF-pin gap on `scripts/*.sh` + `scripts/sh/**/*.sh` (surfaced 2026-05-25 during cross-platform parity audit)

**Fix:** added `scripts/*.sh` + `scripts/**/*.sh` → `text eol=lf` to `.gitattributes` (mirroring the `.skills/**/*.sh` pin). Covers install / uninstall / build-artifact + every bundled `scripts/sh/**/*.sh` wrapper. `git add --renormalize` confirmed the in-repo scripts were already LF (the entries are preventive — they stop a Windows `core.autocrlf=true` checkout from corrupting `set -euo pipefail` locally AND stop `build-artifact.sh` from baking CRLF into the release tarball). Was HIGH (Windows-local-dev + cross-host-tarball corruption vector).


**Status: IDEA, no milestone assigned. HIGH — local Windows dev usage broken; published GH releases safe.** PR #244 Finding #5 pinned LF on `.skills/**/*.sh` + `tests/skill-scripts/*.bats` after a CRLF corruption of `set -euo pipefail` was discovered on Windows git-bash. The same logic was never extended to the canonical install / uninstall / build-artifact / wrapper scripts. With `core.autocrlf=true` (default on Windows git installs), `scripts/install.sh` + `scripts/uninstall.sh` + `scripts/build-artifact.sh` + every `scripts/sh/**/*.sh` lands on disk with CRLF. Confirmed live in this checkout: `file scripts/install.sh` reports `with CRLF line terminators` and `git check-attr text eol -- scripts/install.sh` returns `unspecified` on both fields.

**Impact matrix:**
- **GH release builds (ubuntu-latest)** — SAFE. CI clones fresh with `core.autocrlf=false` so the published `kmp-test-runner-<ver>-linux.tar.gz` carries LF scripts.
- **Windows dev running `bash scripts/install.sh --archive <local>`** for E2E install tests — BROKEN. The `set -euo pipefail` line interprets `\r` as part of the option name and exits 2 with `set: pipefail<CR> : invalid option name`.
- **Windows dev running `bash scripts/build-artifact.sh <ver> dist/`** to produce a local tarball — BROKEN-WORSE. The `cp -r scripts/` step preserves the CRLF endings, so the resulting tarball carries CRLF on every `scripts/sh/run-*.sh` wrapper. When that tarball is extracted on a mac or Linux host, every wrapper invocation hard-fails on the same `set -euo pipefail` line. This is the silent multi-host corruption vector the `.skills` fix already closed.

**Fix:** add to `.gitattributes` (mirroring the existing `.skills/**/*.sh` pattern):
```
scripts/*.sh text eol=lf
scripts/sh/**/*.sh text eol=lf
```
Then `git add --renormalize .` on a Windows checkout to force-rewrite the working tree to LF. The renormalize commit should be its own PR so the diff is purely line-ending churn and reviewable as such. Index versions in any existing dev clone will still be LF (git stores normalized form internally), so the renormalize is a one-shot worktree fix.

**Effort estimate.** <30 min total — 2-line `.gitattributes` delta + renormalize sweep + 1 sanity-check unit test (verify `file scripts/install.sh` reports LF on a fresh Linux clone, optional — the .gitattributes mechanism is already validated by the existing `.skills/**/*.sh` precedent).

**Cross-link:** PR #244 Finding #5 (`project_v0_10_step_4_pr_4_shipped`) is the precedent that closed the same bug class for skill scripts.

---

### ✅ DONE 2026-06-07 — `unknown subcommand` error gives no actionable signal for users on a stale install (surfaced 2026-05-25 during user-reported `kmp-test update` failure on a pre-v0.5 mac)

**Fix:** `lib/cli.js` unknown-subcommand handler now writes a "your installed kmp-test may be out of date" hint with a platform-aware re-install one-liner (`curl … install.sh | bash` on POSIX, `iwr … install.ps1 | iex` on Windows, + npm) BEFORE `printHelp()`. Generic over any unknown sub (a today-version binary that goes stale relative to a future subcommand surfaces the pointer). bats `test-json.bats` extended to assert the hint. Was MEDIUM (recurring stale-install UX trap).


**Status: IDEA, no milestone assigned. MEDIUM — UX gap, recurring failure mode for any user whose install predates a now-canonical subcommand.** `lib/cli.js:838` emits `kmp-test: unknown subcommand '<sub>'` followed by `printHelp()`. When the local binary is obsolete (e.g. a mac install from before PR #148 which introduced `update` in v0.5.x), the help text printed comes from the obsolete binary too — and naturally lists only the subcommands that existed at the time of that install. The user has no signal that their installed `kmp-test` is the problem, not the requested subcommand. Concrete repro from a user session 2026-05-25: ran `kmp-test update` on a pre-v0.5 mac, got "unknown subcommand 'update'", concluded the bug was in current `develop` rather than in their stale install. The actual fix was a one-liner `curl ... | bash` re-run of `install.sh`, which the error gave zero pointers toward.

**Recommendation:** when `sub ∈ {update, info, describe, doctor}` AND `sub ∉ COMMAND_MODULES`, append a "your install may be outdated" hint with the re-install one-liner BEFORE `printHelp()`. Something like:

```
kmp-test: unknown subcommand 'update'

Looks like your install predates this subcommand. Re-run the installer
to upgrade to the latest release:

  curl -fsSL https://raw.githubusercontent.com/oscardlfr/kmp-test-runner/main/scripts/install.sh | bash

Then retry: kmp-test update
```

Note the asymmetry — this fix only helps users running **>= v0.10.2 onward** when a future v0.11+ subcommand goes missing on their stale install. It does NOT retroactively help anyone on the current pre-v0.5 era (their binary doesn't have this code). But it closes the loop for every subsequent generation. The reverse direction — making `install.sh` advertise the existence of `kmp-test update` in its post-install message — could also help, but feels heavier.

**Edge cases to handle:**
- The hint must be `process.platform`-aware: emit the curl one-liner on darwin/linux, emit the equivalent PowerShell `iwr ... | iex` form on win32.
- The set `{update, info, describe, doctor}` is the "post-v0.5 surface". Anything older (parallel, changed, android, benchmark, coverage) should NOT trigger the hint, because typo-on-old-subcommand is more likely the actual cause than a stale install.

**Effort estimate.** ~30 min code + 2-3 vitest cases (each subcommand fires the hint, others do not, platform-aware curl vs PowerShell shape). Single PR, ~15 LOC + tests.

**Why this matters.** Removes a sharp edge that wastes user time when a stale install is the real issue. Surfaced organically — the user almost concluded a real CLI bug existed and asked Claude to "audit all the CLI" before the root cause (stale install) was identified.

---

### KotlinConf'26 — MCP server shape for `kmp-test` (Junie / Air / any MCP-compatible agent)

KCon'26 day 1 confirmed Junie CLI exposes MCP for tool integration (`/mcp` slash command + MCP Installation Assistant) and JetBrains Air supports Claude/Gemini/Codex/Junie agents — all MCP-compatible. Today `kmp-test` ships an `agentskills.io` skill (`.skills/kmp-test-runner/`) + Claude Code Plugin (`.claude-plugin/plugin.json`). MCP is the third leg that unlocks Junie CLI + Gemini CLI + any MCP host without per-agent packaging.

**Scope.** A stdio-transport MCP server (`mcp-server-kmp-test`) exposing existing subcommands as MCP tools (`kmp_test.parallel`, `kmp_test.coverage`, `kmp_test.changed`, `kmp_test.benchmark`, `kmp_test.android`, `kmp_test.doctor`, `kmp_test.info`, `kmp_test.describe`). Tool schemas mirror existing CLI flags (already documented in `.skills/kmp-test-runner/references/cli/`). Reuses the existing JSON envelope as the tool response — no new shape to maintain.

**Reuse.** `tools/sync-versions.js` grows a 7th target. Zero-deps validator pattern from PR #245 (`tools/validate-plugin.mjs`) ports to `tools/validate-mcp-server.mjs`. `skills-validate` CI job extended; no new CI job.

**Effort estimate.** ~12-16h across 4 PRs (manifest + scaffolding / tool defs + envelope mapping / vitest + smoke against Claude Code MCP host / docs + README subsection). Same shape as the v0.10 #4 PR 5 train.

### KotlinConf'26 — ACP (Agent Client Protocol) adapter smoke

KCon'26 day 1 announced ACP as the open standard for IDE↔agent communication, paired with JetBrains Air's multi-agent environment. Standard is <1.0 and evolving.

**Scope (doc-only first).** Verify the existing `.claude-plugin/plugin.json` mounts cleanly inside JetBrains Air (Air supports Claude Agent natively). If yes → no code change, file the evidence. If no → draft a delta-adapter (single PR, similar size to PR #245).

**Why doc-only first.** ACP is pre-1.0; shipping a full adapter against a moving target is wasted code. 30-min smoke verifies forward-compat. Upgrade trigger to code-shipping: ACP publishes its first conformance test suite AND our current shape fails it, OR a user files an issue.

**Effort estimate.** Smoke ~30 min. Adapter delta if triggered ~4-6h.

### KotlinConf'26 — Amper `module.yaml` detection probe (research-only)

KCon'26 day 1 promoted Amper to "core of the Kotlin Toolchain" with `amper test`. Amper standalone is still <1.0 (v0.10 as of March 2026); `layout: gradle-kmp` compatibility mode is being deprecated. >95% of KMP projects remain Gradle-native today.

**Scope.** Read-only research probe. When a project root contains `module.yaml` (Amper standalone marker) AND no `build.gradle.kts`/`settings.gradle.kts`, does `kmp-test parallel` fail gracefully with a discriminated error code (`amper_project_detected`) instead of an opaque crash? If not → single-file delta in `lib/envelope/error-codes.js` + matching `lib/envelope/builder.js` vitest.

**Out of scope.** Building an Amper-aware `analyze-amper-module.js` parser. Adoption too low + spec too volatile to invest today. Re-evaluate trigger: Amper hits 1.0 OR a real user files an issue.

**Why not wait silently.** A clear error message ("Amper standalone project detected — `kmp-test` is Gradle-only today") beats an opaque crash on `settings.gradle.kts not found`.

**Effort estimate.** Probe ~1h. Error-code delta if needed ~1h. Total ~2h, single PR.

### KotlinConf'26 — Smoke fixture for the new KMP default project structure

KCon'26 day 1 announced a new default KMP project structure ("each module has a single clear responsibility"). JetBrains will publish official fixtures alongside Kotlin 2.4 GA. `lib/project/analyze-module.js` resolves modules from `settings.gradle.kts` includes + per-target task probing, which should be structure-agnostic — but worth blinding it with a fixture once one exists.

**Scope.** When the official fixture lands, copy it to `tests/fixtures/kmp-default-structure-2026/` (analogous to existing `tests/fixtures/kmp-with-ios/` and `tests/fixtures/kmp-cross-platform-e2e/`). Wire into the existing fixture vitest matrix. Expected delta: 0 production code changes, 1 new smoke vitest ensuring `--list-only --dry-run --json` produces a well-shaped envelope.

**Watch trigger.** Official Kotlin 2.4 fixture repository (likely `github.com/Kotlin/` or similar) OR user issue reporting the new layout.

**Effort estimate.** ~1-2h once a fixture exists. Lower if existing `tests/fixtures/kmp-cross-platform-e2e/` can be retrofitted.

### KotlinConf'26 — Cross-tool integration patterns (Koog / Junie / Amper hybrid) in `.skills/`

Same shape as v0.10 #4.5's "Cross-tool comparison: `android` CLI analogues" section (`.skills/kmp-test-runner/references/cli/envelope-schema.md` + SKILL.md "Tool selection" subsection). Doc-only, no CLI code change.

**Scope.** Add a "Cross-tool integration patterns" section to `.skills/kmp-test-runner/SKILL.md` covering:

1. **Calling `kmp-test` from a Koog agent** — ~10-15 line snippet showing a Koog workflow DSL invoking `kmp-test parallel --json` and consuming the envelope. Highlights layering: Koog (agent framework) sits one layer above; `kmp-test` (test executor) sits one layer below.
2. **Exposing `kmp-test` to Junie via MCP** — canonical wiring once the MCP server shape ships (see sibling BACKLOG entry). Stub until then: "use the `.skills/` shape today; MCP shape tracked at [link]".
3. **Co-existing with Amper in hybrid projects** — until `layout: gradle-kmp` is removed, projects can have both. `kmp-test` ignores `module.yaml` and reads `settings.gradle.kts` directly; document this so users know it's safe to keep both side-by-side.

**Why now.** Sections 1 + 3 don't depend on MCP shipping. Section 2 stubs in. Doc-only PR, low risk.

**Effort estimate.** ~2-3h research + drafting, single PR.

### ✅ Multi-feature token-cost measurement (v0.4 milestone) (DONE in v0.4 — PRs #34–#37)

**Status: DONE in v0.4** (PRs #34–#37). All 4 in-scope features (`parallel` / `coverage` / `changed` / `benchmark`) shipped with cross-tokenizer measurement (`cl100k_base` + `opus-4-7` + `sonnet-4-6` + `haiku-4-5`) in the README's "Why this exists — token cost per agent test-run iteration" section (line ~5). Chart redesign landed as one markdown bar table per feature (no Mermaid). `android` (instrumented) deferred per the entry's explicit out-of-scope clause; `doctor` skipped per the entry's "too small" note. Original entry text preserved below.

Today's measurement (PRs #27–#29) covers **one** scenario: `kmp-test parallel` with Kover coverage on a single failing module of the reference KMP composite project. The "127–154× cheaper than raw gradle" claim in the README only stands up for that scenario. The CLI ships several other features the same agent-cost story applies to but we haven't measured:

- **`coverage`** (= `parallel --skip-tests`) — "I already ran tests, just regenerate the report." Approach A is `./gradlew koverXmlReport` (or `jacocoXmlReport`) + read the aggregated report; B/C are `kmp-test coverage` markdown / `--json`. Hypothesis: the largest A:C ratio of the lot, because A drops the test logs but the aggregated XML is still huge.
- **`changed`** — incremental retry of changed modules. Approach A is `git diff` filter + per-module raw gradle + reports for that subset; B/C are `kmp-test changed --json`. Hypothesis: matches `parallel`'s ratio but at smaller absolute scale.
- **`benchmark`** — `kotlinx-benchmark` runs. Approach A is `./gradlew :module:nativeBenchmark` + read benchmark report JSON/HTML; B/C are `kmp-test benchmark --json`. Hypothesis: distinct story — benchmark output is denser/structured, the savings story is "you don't need the per-iteration noise."
- **`android`** (instrumented tests on emulator) — out of scope for v0.4; needs an emulator + connected device, breaks the CI repro story. Defer to v1.0 with an Android-flavored variant of the measurement script.
- **`doctor`** — too small (<200 tokens regardless of mode). Skip.

**Coverage-tool variation worth one extra column.** The default is Kover; JaCoCo is supported but currently undocumented in the README (separate quick-fix entry below). For one project run it twice (Kover, JaCoCo) and tabulate side-by-side — the A row will diverge (different XML schemas), B/C should be identical (CLI normalises). One row per coverage tool answers "does the savings claim depend on Kover?"

**Reference projects.** Stick with the reference KMP composite project for v0.4 (consistent variables — same module count, same deps, same JDK). Other personal KMP projects are tempting cross-validation but at least one larger one (43 modules) hung on Windows MinGW already (per current docs) — adding a third project doesn't validate the claim more, it just adds tokens spent.

**Chart redesign (mandatory).** 4 features × 3 approaches × 4 tokenizers = 48 bars in one chart is unreadable. Two viable layouts:
- **One chart per feature** at the top of `docs/token-cost-measurement.md`, then a single "summary" row in the README with feature on x-axis and `A:C ratio` on y-axis (one number per feature). README stays scannable, doc has the full breakdown.
- **One markdown bar table per feature** (no Mermaid), like the current README structure. Renders everywhere, easy to scan for "which feature gets which savings."

Recommend the second — Mermaid xychart-beta has been a pain (PRs #28–#29 history) and a clean markdown table per feature is more durable.

**Cost projection.** `messages.countTokens` calls cost ~$3–15/MTok depending on model. 4 features × 3 captures × 3 Claude models × ~25k input tokens average ≈ 900k tokens ≈ **$3–14 per full re-measure**. Acceptable as a one-time investment per release that updates these numbers; not OK to re-run on every PR. Treat the captures in `tools/runs/` as authoritative for the docs and only re-measure when the CLI's output shape changes (e.g. `--json` schema bump).

**Effort estimate.** Per feature: ~1–2h to add the "approach A" raw-gradle equivalent in `tools/measure-token-cost.js`, capture, tokenize, write up. 3 features = 4–6h coding + ~$10 API. Plus 2–3h for the chart redesign and doc reorg. Total **~8–10h** for v0.4.

**Out of scope for this entry.** README quick-fix mentioning Kover/JaCoCo as supported coverage tools (currently undocumented — separate small entry below).

### ✅ Document Kover and JaCoCo in README (quick win) (DONE since v0.5.1 — README "Coverage tools" subsection at L334)

**Status: DONE since v0.5.1.** README's "Coverage tools" subsection (line ~334) covers both Kover and JaCoCo by name with links, the `--coverage-tool` flag with `auto` / `kover` / `jacoco` / `none` values, heterogeneous-project handling, and the convention-plugin coverage detection note (v0.6.1+). Original entry text preserved below.

`--coverage-tool` accepts `kover`, `jacoco`, or `none` (current default `kover`). README never mentions either tool by name — only references "coverage" generically. New users land on the README, see "coverage" with no signal that JaCoCo is supported, assume Kover-only or look for `--jacoco`-style flags. Quick fix: a 1-paragraph "Coverage tools" subsection under "Usage" naming both tools, the default, and the flag.

Estimated effort: 15 min. Probably bundle into the next docs PR.

### ✅ macOS bats end-to-end validation (DONE 2026-05-03 in PR #118 — root cause was adb pipe FDs, NOT BSD-signal hypothesis)

**Status: DONE 2026-05-03 (PR #118).** Original BSD-signal hypothesis below was wrong. Real root cause: `runDoctorChecks` (`lib/cli.js:1411`) spawning `adb version` whose client inherits Node's pipe FDs on macos-latest, leaving an orphan adb daemon that bats counts as an unfinished child process and waits indefinitely. Fix: `KMP_TEST_SKIP_ADB=1` env opt-out exported from `tests/bats/test-doctor.bats` + `tests/bats/test-concurrency.bats`'s `setup_file()` hooks. Empirical validation in PR #118: bats-macos completes in 1m48s vs prior 15-min hang; `pgrep -af adb` after suite confirms zero residual adb processes. CI verification 2026-05-05: bats-macos passing in last 28/30 CI runs (the 2 failures were on a v0.8.0 wide-smoke pass-9 branch, unrelated to bats). PR #118 also closed L644 (install.bats orphan adb) + L665 (bats-macos hangs in tests/bats/) — same root cause across all three.

Branch-protection promotion of `bats-macos` to required is now unblocked technically; deferred opportunistic per Gate 3 of L172 release-readiness (post-tag scheduling). Original entry text preserved below.

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

1. **✅ Doctor surfacing — DONE in v0.8.1 (PR #142).** `kmp-test doctor --json` carries a top-level `gradle_config{}` object with the resolved values for `org.gradle.parallel`, `workers.max`, `caching`, `daemon`, `jvmargs`, `configureondemand` from `<project>/gradle.properties` merged on top of `~/.gradle/gradle.properties`. Pure diagnostic — no behavior change. (Tier 2 below scheduled as **v0.9 step 2**; Tier 3 as **v0.10 step 2**.)
2. **Generic pass-through (~1h)** — `--gradle-args "..."` global flag that appends arbitrary tokens to the gradlew invocation. Lets any agent or user inject `--no-parallel`, `--no-build-cache`, `--max-workers 1`, `-Pflag=value`, etc. Documented as an escape hatch — the CLI still has its opinionated defaults. Lower precedence than dedicated flags.
3. **Auto-detect + respect — ✅ DONE 2026-05-16 (v0.10 #2, `--parallel` only).** `parallel-orchestrator.js` reads `gradle.properties` (via existing `parseGradleConfig`) and drops the unconditional `--parallel` injection when `sources.project && parallel === false`. Other levers (`workers.max`, `caching`, `configureondemand`) were left out of scope because the CLI never injects them today — gradle reads them natively. Envelope surfaces `gradle_config_applied:{parallel_dropped:true}` on drop. Escape hatches: `org.gradle.parallel=true` or `--gradle-args "--parallel"` (last-wins, v0.9 passthrough). Migration note in `CHANGELOG.md` explicitly covers the "project file with only `jvmargs` but no `parallel` key → drop fires (resolves to gradle default false)" surprise case.

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
- **`--capture-on-fail` for `kmp-test android`** — 🚧 IN PROGRESS (feature/capture-on-fail, milestone TBD by user): on instrumented-test failure, capture a device screenshot (`adb exec-out screencap`) + UI-hierarchy dump (`adb exec-out uiautomator dump`) beside the per-module log/logcat/errors artifacts; paths surface on the `module_failed` error as `screenshot_file` / `ui_hierarchy_file` (+ `capture_error`). Best-effort, forensic-only — never changes the exit code. `--capture-dir <path>` overrides the location. **Post-hoc** (adb runs at task-end, like the logcat dump): best for crashes/ANRs/hangs. Visual-diff/golden-image testing is explicitly OUT of scope (Roborazzi/Paparazzi territory). `parallel --test-type androidInstrumented` capture is a queued follow-up (see QUEUED section).
- **Subcommand grouping**: android groups by topic (`emulator <subsub>`, `sdk <subsub>`, `skills <subsub>`). Our flat namespace (parallel/changed/android/benchmark/coverage/doctor) is fine for 6 commands but won't scale past ~10. Decide now whether to migrate to verb/noun (`kmp-test run parallel`, `kmp-test run changed`, `kmp-test diagnose doctor`, `kmp-test diagnose info`) before more commands accumulate. Probably defer until 8+ commands.

**Lower priority — speculative**

- **`kmp-test docs`** (from `android docs`): opens the README anchor or specific section in `$BROWSER` / man-page. Marginal win when `--help` already exists.
- **`kmp-test devices`** (from `android emulator` + `screen`): wrap ADB device-listing/management. Probably out of scope — `adb devices` is fine.
- **`kmp-test sdk`** (from `android sdk`): install/check SDK packages. Out of scope — `doctor` already flags missing tooling.

Estimated effort per item: 1-3h each except the subcommand-grouping refactor (full day if done with backwards compat). Recommend shipping the high-value 4 (`--debug`/`--release`, `describe`, `info`, `update`) as a single v0.4.0 "DX-parity" PR and leaving the rest as separate backlog candidates.

### Use `android describe` JSON as module-discovery source — ❌ DROPPED 2026-05-18

DROPPED as part of v0.10 ramp #5 (research-first item, pre-authorized drop clause). Verdict file: `WET-V0.10-STEP-5-RESEARCH.md` at repo root. Inherits findings from v0.10 #4.5 (SHIPPED 2026-05-17): schema convergence not viable on three independent grounds.

Original entry preserved for traceability:

> The official `android` CLI's `describe` subcommand emits a JSON document of build targets + APK paths for an Android project. Currently kmp-test does its own module discovery via bash filesystem walks (`scripts/sh/lib/script-utils.sh` etc.), which on Windows MinGW is the slow path that motivated the [concurrent-invocation safety entry](#concurrent-invocation-safety-multi-agent-scenarios) above and is the suspect for the 10+ min hang against a 43-module personal project. Consider replacing or augmenting the bash discovery with an `android describe` invocation when the CLI is on PATH — gets the official Google schema, faster on Windows.
>
> Open questions: (1) does `describe` cover KMP-only (non-Android) modules, or only AGP-rooted ones? (2) what's the schema stability guarantee, esp. for multi-module multi-target KMP? (3) fallback path when `android` CLI isn't installed — keep bash discovery as default, opt-in via `--use-android-describe` flag.
>
> Estimated effort: ~2h research first to confirm `android describe` enumerates KMP-non-AGP modules (test against the reference KMP composite project), then ~3-4h refactor in `lib/project-model.js` if research is positive. Scheduled as **v0.10 step 5 (research-first)** — if research is negative, the entry gets dropped per user direction (`feedback_release_milestone_decisions.md` allows the user to authorize drops on case-by-case basis after research). Note: the legacy reference to `scripts/sh/lib/` above predates the v0.8 Node-pivot — discovery now lives in `lib/project-model.js`.

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
2. **✅ Audit + docs — DONE in v0.8.1 (PR #142).** Full Tier 2 collision matrix landed in `docs/concurrency.md` — 10-row subcommand × resource × outcome × mitigation-status table. Tier 3 (`--isolated`) flips deferred rows when it ships (scheduled as **v0.9 step 4**).
3. **Opt-in isolation (~3-4h)** — queued: `--isolated` global flag → injects `--project-cache-dir <tmp>` into every gradle invocation, giving each run its own `.gradle/` cache. Slow (no cache hits), but truly parallel-safe. Ideal for CI multi-agent fan-out.

Out of scope for this item: cross-host coordination (use a real lock manager), Gradle-internal concurrency tuning, or rewriting the daemon model.

### Other QUEUED ideas

- **Maven Central publish** for Gradle plugin — currently GitHub Packages only; needs Sonatype account + signing keys
- **iOS/macOS TestKit** matrix — needs Mac hardware in CI
- **VitePress/MkDocs docs site** — separate consumer-facing docs beyond README

---

## DONE (recent — newest first)

- 2026-04-30: **v0.6.0** — "Real-world diversity hardening." Five bugs surfaced from v0.6 smoke survey against 17 official KMP projects (KaMPKit, Confetti, nowinandroid, Compose Multiplatform html, nav3-recipes, DroidconKotlin, etc.); Bug 4 (iOS support) deferred to v0.7. Suite at release: ~353 vitest + ~175 bats + ~157 Pester (+27 / +16 / +10 over v0.5.2 baseline). Real-world re-validated against KaMPKit + Confetti + nowinandroid + compose-multiplatform/html (5/5 expected behaviors confirmed):
  - **Bug 1 (#73)** — `--dry-run` no longer blocks on JDK toolchain mismatch. Pre-flight `preflightJdkCheck` now skipped when `dryRun === true`. 13/17 projects in the smoke survey hit this — `--dry-run` is for plan inspection, not run validation, so gating it on a JDK mismatch defeats the purpose. Real runs (`parallel`/`changed`/etc.) still gate. Smoke validated against KaMPKit (JDK 11) on JDK 17 host: dry-run exits 0 with plan instead of `jdk_mismatch` error.
  - **Bug 5 (#74)** — `--no-coverage` alias for `--coverage-tool none`. Users naturally reach for `--no-coverage` based on most-CLI conventions; pre-fix neither sh nor ps1 scripts wired it up — only `--coverage-tool none` worked. New `expandNoCoverageAlias` helper expands at the CLI normalization layer BEFORE flag translation, so `kmp-test parallel --no-coverage` works on both Linux and Windows. If `--coverage-tool` is already explicit, user choice wins (conservative). Smoke validated against KaMPKit: PS1 spawn args now contain `-CoverageTool none`, not the rejected `-NoCoverage`.
  - **Bug 2 (#75)** — `analyzeModule` now classifies `com.android.test` and `kotlin("android")` modules as Android. Pre-fix the AGP plugin pattern only matched `library|application`; `com.android.test` modules (Confetti's `androidBenchmark`) fell through to `type=unknown`. New `hasKotlinAndroidPlugin` regex catches both `kotlin("android")` and `id("org.jetbrains.kotlin.android")`. Real-world validated against Confetti: `androidApp` AND `androidBenchmark` now both `type=android`. Out of scope: version-catalog `alias(libs.plugins.<...>)` form (covers nav3-recipes / Confetti's modern modules — separate v0.7 scope).
  - **Bug 6 (#76)** — `detectBuildLogicCoverageHints` distinguishes CONVENTION vs SELF kover/jacoco signals. Pre-fix the naive `\bjacoco\b` scan over all build-logic files false-positived on nowinandroid (`build-logic/convention/build.gradle.kts` only NAMES jacoco-related convention plugins via `register("...Jacoco...")` blocks — but jacoco isn't applied for build-logic itself or for consumer modules from this file). Discrimination now uses path heuristic + registration-noise stripping: files under `build-logic/<X>/src/main/...` → CONVENTION; files outside → SELF (after stripping `register(...) { ... }`, `implementationClass = ...`, `id = libs.plugins.<...>`, `pluginId = ...`, `asProvider().get().pluginId`, and comments). `analyzeModule` only inherits when kind === 'convention'. Return-shape break: `{ hasKover: bool, hasJacoco: bool }` → `{ hasKover: 'convention'\|'self'\|null, ... }`. Real-world validated: nowinandroid → `hasJacoco: 'convention'` (correctly detects real `Plugin<Project>` jacoco classes under `src/main/kotlin/`); a reference KMP composite project → `hasKover: 'convention'` (continues to inherit kover for all 71 modules). Out of scope: per-module convention-plugin application detection (which modules apply `nowinandroid.android.application.jacoco`?) — needs version-catalog plugin-id mapping, separate v0.7 scope. Three CI fixtures locked under `tests/fixtures/build-logic-{convention,self,noise}-jacoco/` are loaded by both bats and Pester via `node --input-type=module -e "..."` to keep the JS classifier as the single source of truth.
  - **Bug 3 (#77)** — JS / Wasm source-set + task support in the project model. `analyzeModule` enumerates 3 additional source-set directories (`jsTest`, `wasmJsTest`, `wasmWasiTest`); `resolveTasksFor` adds `jsTest`/`wasmJsTest` as `unitTestTask` candidates AFTER the JVM ones (KMP+JS modules still pick `jvmTest`); new `webTestTask` field surfaces JS/Wasm test invocation explicitly. Sh and ps1 readers grow `pm_get_web_test_task` / `Get-PmWebTestTask`. Real-world validated against compose-multiplatform/html: `core`, `benchmark-core`, `compose-compiler-integration` all now report `sourceSets.jsTest=true` (previously these source sets weren't enumerated at all). Out of scope: actual JS test EXECUTION in CI (requires Node + browser drivers; v0.6.x follow-up). One CI fixture under `tests/fixtures/kmp-with-js/` covers both JS-only fallback (`:web-only`) and KMP+JS regression (`:kmp-multi`).
  - **Deferred to v0.7**: iOS source-set + task support (Bug 4). Adds 30% of the complexity for ~5% of KMP projects (3/17 with iosTest in survey). Requires macOS GitHub Actions runner job + Xcode integration + xcodebuild OR `gradlew iosSimulatorArm64Test` + simulator boot orchestration. Estimated 6-8h + CI hardware costs.

- 2026-04-30: **v0.5.2** — "Minor-gaps milestone." Five non-blocking follow-ups from the v0.5.1 ship cycle (Phase 4 D1+D4 deferrals + post-ship validation findings + one DX gap). Suite at release: ~326 vitest + ~159 bats + ~147 Pester (+ ~37/~14/~17 over v0.5.1 baseline). Real-world validated against a reference KMP composite project on Windows + S22 Ultra + JDK 21:
  - **Gap E (#63)** — Android `--test-filter` method-level filtering. `kmp-test android --test-filter "FQN#method"` and `--test-filter "FQN.method"` now run a single test method via AndroidJUnitRunner. cli.js splits class+method, resolves wildcards in the class part as before, recombines as `<resolvedClass>#<method>` on the wire; platform scripts (sh + ps1) detect `#` and emit BOTH `-Pandroid.testInstrumentationRunnerArguments.class=` AND `.method=` flags. Same gap closed for `kmp-test benchmark --platform android`. Smoke validated end-to-end on S22 Ultra against `:sample-encryption:AndroidEncryptionServiceTest#test_encrypt_returnsBase64EncodedString` and `.test_decrypt_recoversOriginalPlaintext` (heuristic form). Tests: +13 vitest, +5 bats, +2 Pester.
  - **Gap D (#64)** — `summary.json` counter shape regression coverage. PR #54 fixed the PS1 single-item-pipeline collapse where `$modules.Count` returned hashtable-key count (5/11) instead of array length (1) on single-module runs. Bash side audited clean (`${!result_names[@]}` indexed iteration, no `${#hash[@]}` bug-pattern). New `tests/bats/test-android-summary-counts.bats` (5 tests) + `tests/pester/Android-Summary-Counts.Tests.ps1` (9 tests including a negative-guard against the bug-pattern returning) lock the contract at source level. Real-world validated during Gap E smoke run — single-module produced `totalModules:1, passedModules:1, modules.length:1`.
  - **Gap B (#65)** — JDK gate walker unification via ProjectModel fast-path. `gate_jdk_mismatch` (sh) + `Invoke-JdkMismatchGate` (ps1) now consult `pm_get_jdk_requirement` / `Get-PmJdkRequirement` first; the JS canonical walker (9-dir exclude list + depth=12) returns the MAX-of-signals into the model JSON's `jdkRequirement.min`. Legacy walkers (sh: 4 dirs unbounded, ps1: 5 dirs unbounded) preserved as fallback when model.json absent. Eliminates exclusion-list drift. Tests: +2 bats, +2 Pester.
  - **Gap C (#66)** — Cache-key SHA byte-parity across walkers AND across host platforms. JS / bash / PS1 now produce IDENTICAL SHAs for the same logical content regardless of file line endings (CRLF / LF / mixed) or runner OS. Strategy: every walker normalizes by stripping ALL `\r` then trailing `\n+` before hashing — bash uses `tr -d '\r'`, JS uses `s.replace(/\r/g, '').replace(/\n+$/, '')`, PS1 uses `-replace '\r', ''` then `-replace '\n+$', ''`. Pre-fix: Linux bash `$(cat)` only stripped LF (left stray `\r`), Windows Git Bash text-mode read collapsed CRLF→LF transparently — Linux/Windows hashes diverged. Validated against a reference KMP composite project (71 build files): `57f70e4c119d81bfd4ba8590f96025e7c3d4cfcb` on every walker. Tests: +6 vitest, +4 bats, +5 Pester (+ 1 negative guard that fixtures with same logical content but different line endings hash identically).
  - **Gap A (#67)** — Build-logic kover/jacoco detection ported into JS + coverage-task prediction in `resolveTasksFor`. New `lib/project-model.js#detectBuildLogicCoverageHints` walks `build-logic/**/*.{gradle.kts,kt}` (previously only the bash `detect_coverage_tool` scanned this location). `analyzeModule` ORs the per-module signal with the project-wide hint; `resolveTasksFor` predicts `coverageTask` from `(coveragePlugin, type)` when probe data is missing (kover+kmp → `koverXmlReportDesktop`, etc.). Closes the practical gap of "fast-path returns null when it shouldn't": a reference KMP composite project went from 0/71 to 69/71 modules with `resolved.coverageTask` populated. Tests: +16 vitest. **Scope reduction** — deletion of `detect_coverage_tool` / `get_coverage_gradle_task` from sh + ps1 deferred to a future milestone since the legacy chain is still load-bearing for projects without a model.json (no probe + no model = legacy file scan is the only detection path). The pre-work alone closed the user-visible gap.

- 2026-04-29: **v0.5.1** — "Real-world validation hardening, round 2 + Phase 4 ProjectModel refactor". Closes 11 bugs surfaced when v0.5.0 was tested against (a) a 13-module Android-only Gradle 9 project on macOS and (b) the reference KMP composite project on Windows + S22 Ultra physical device + JDK 21:
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
  - Real-world validation against a reference KMP composite project (Win + S22 Ultra + JDK 21): V8 (android tier 1 with model-*.json), V10/V12-real (parallel cold + warm), V13 (benchmark `--config main --platform jvm` happy-path 22s 1/1 passed), V9 (Bug H ETIMEDOUT structured envelope). Coverage report: 95.1% TOTAL on sample-encryption modules.

- 2026-04-27: **v0.5.0** — "Real-world Mac validation hardening." Four production bugs surfaced on macOS running v0.4.1 against a 20-module Android-only KMP project, all bundled into one milestone:
  - **Bug A (#43)** — JDK toolchain mismatch becomes BLOCKING by default. Was: warning printed and script continued, then tests failed downstream with `UnsupportedClassVersionError`. Now: exits 3 with a per-OS `JAVA_HOME` hint; `--ignore-jdk-mismatch` / `-IgnoreJdkMismatch` downgrades to WARN; `gradle.properties` `org.gradle.java.home` bypasses the check (gradle's explicit override wins). 12 vitest + 9 bats + 6 Pester. Shared helpers `scripts/sh/lib/jdk-check.sh` + `scripts/ps1/lib/Jdk-Check.ps1`.
  - **Bug B (#44)** — modules without test source sets cause silent failures + misleading reports. Was: script invoked `:module:jacocoTestReport` blindly; api/build-logic modules failed with "task not found" but final output said `[OK] Full coverage report generated!` with 0% coverage. Now: auto-skip modules with no `src/*Test*` directory (9 KMP/Android source-set variants checked); `--exclude-modules "*:api,build-logic"` for explicit exclusion (matches `--module-filter` syntax); `--include-untested` to opt out of the auto-skip. 4 vitest + 10 bats + 9 Pester. Shared helper `module_has_test_sources` in `script-utils.sh`.
  - **Bug C (#46)** — Gradle 9 deprecation noise lumped into `errors[]`. Was: `[!]` prefix indistinguishable from real warnings; `BUILD FAILED` from the deprecation pile ended up in `errors[]`. Now: distinct `[NOTICE]` prefix (sh + ps1); JSON envelope grows `warnings: [{code: "gradle_deprecation", gradle_exit_code, tasks_passed}]`; `BUILD FAILED` suppressed in `errors[]` when paired with the deprecation notice; PowerShell script gains the 3-branch JVM-error/deprecation/per-module logic that bash already had. 10 vitest + 4 bats + 5 Pester.
  - **Bug D (#47)** — installer "installed successfully" but `kmp-test` not on PATH. Was: `~/.zshrc` updated but no `source` hint; broken outright for fish (wrote bash-syntax to `~/.profile`). Now: install.sh detects `$SHELL` and writes the right rc file with the right syntax (zsh / bash / fish via `set -gx PATH` to `~/.config/fish/config.fish` / sh fallback); per-shell hint shows both literal `export`/`set` line AND `source <rc-file>` shortcut. install.ps1: clarified that `$env:PATH` is already updated for the current session. 6 bats E2E (incl. idempotent re-run).
  - **Docs (#45)** — README gains "Heterogeneous projects (modules without tests)" + "JDK toolchain mismatch" sections; flag-reference table + exit-code row updated; `errors` vs `warnings` distinction documented in agentic section.
  - Suite totals at release: **221 vitest + 87 bats + 74 Pester**. README banner deferred per design decision.

- 2026-04-26: **v0.3.8** — Tier 1 concurrent-invocation safety. Advisory lockfile at `<project>/.kmp-test-runner.lock` (`{schema:1, pid, start_time, subcommand, project_root, version}` JSON); `--force` global flag bypasses live lock; stale-PID reclaim is automatic; SIGINT/SIGTERM/uncaughtException cleanup hooks; `--json` mode emits `errors[].code = "lock_held"`. Run-id naming `YYYYMMDD-HHMMSS-PID6` for `coverage-full-report-<id>.md`, `benchmark-report-<id>.md`, and `gradle-parallel-tests-<id>.log`; legacy stable filenames retained as a last-finished mirror so existing consumers keep working. Tests: 121 vitest (96% line coverage on cli.js, +30 lockfile-specific cases) + 12 bats (`tests/bats/test-concurrency.bats`, 3 skipped under MinGW due to MSYS PID semantics — Linux CI runs all of them) + 10 Pester 5 (`tests/pester/Concurrency.Tests.ps1`). `doctor` and `--dry-run` skip the lock since they're read-only.
- 2026-04-26: **Real token-cost metrics for the "Agentic usage" claim** — `tools/measure-token-cost.js` (Node + js-tiktoken; `--project-root`, `--module-filter`, `--test-task`, `--runs`) runs the three approaches (A: raw `./gradlew + read build/reports/**`, B: `kmp-test parallel`, C: `kmp-test parallel --json`) against any KMP project and emits a markdown table with token counts. First run against `a reference KMP composite project:sample-result:desktopTest` produced **A 12,816 tok / B 376 tok / C 100 tok** — `--json` is **128× cheaper than raw gradle**. Captured run logs committed to `tools/runs/`; methodology + caveats in `docs/token-cost-measurement.md`; README "Agentic usage" section updated to link the doc. Replaces the prior qualitative claim with a self-auditable measurement.
- 2026-04-26: **v0.3.7** — DX & agentic features bundle. `--dry-run` (skip spawn, print/JSON the resolved plan), `kmp-test doctor` subcommand (5 env checks: Node, shell, gradlew, JDK, ADB; human table + `--json` array), and `--test-filter <pattern>` passthrough (gradle `--tests` for JVM, `-Pandroid.testInstrumentationRunnerArguments.class=` for Android with `*Pattern*` → FQN resolution by source scan). Plus Conventional Commits enforcement on PR titles via `.github/workflows/commit-lint.yml` (adapted inline from private-toolkit reusable workflow — repo stays standalone). 91 vitest + 52 bats tests. **Branch protection must be updated to add `commit-lint / 🔤 Commit Lint` as required check.**
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
