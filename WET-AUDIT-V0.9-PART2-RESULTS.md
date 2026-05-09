# Wet Audit v0.9 — Part 2 Results

> **Scope:** Complete CLI wet-audit against workspace projects, focused on macOS native + iOS simulator paths (Windows can't validate these) and the v0.9 parity-gap flags. Two-window execution due to battery/USB-port constraint: Part 1 = no S22 Ultra (PC charging, port free); Part 2 = with S22 Ultra (Android instrumented).
>
> **Branch:** `chore/wet-audit-v0_9-part2` (synced hard to `origin/develop` @ `989f57b` before audit start).
>
> **Disk baseline:** 6.9 GB free / 97 % full at start; cleanup discipline applied between lanes (project `build/.gradle` purged, `~/.gradle/caches/modules-2/` preserved per `feedback_disk_space_awareness`).

---

## Part 1 — non-S22 Ultra lanes (in progress … Part 2 pending S22 connection)

### Lane × project × cell matrix

| Lane | Project | Subcommand | Test-type | Cells | Result |
|---|---|---|---|---|---|
| L1.A non-exec smoke | KaMPKit | doctor / info --no-adb / describe / parallel --dry-run + describe cache HIT/MISS | n/a | 6 | ✅ all exit 0, schema 1 |
| L1.A non-exec smoke | PeopleInSpace | same 4 | n/a | 4 | ✅ all exit 0, schema 1, modules=7 |
| L1.A non-exec smoke | di-patterns-demo | same 4 | n/a | 4 | ✅ all exit 0, modules=43 |
| L1.A non-exec smoke | Confetti | same 4 | n/a | 4 | ✅ all exit 0, modules=13 |
| L1.A non-exec smoke | shared-kmp-libs | same 4 | n/a | 4 | ✅ all exit 0, modules=69 |
| L1.A non-exec smoke | (no project) | `update --check` | n/a | 1 | ✅ exit 0, schema 1 |
| L1.B JVM/Android-unit | di-patterns-demo | parallel | androidUnit | 1 | ✅ exit 0, 1 mod, 68 tests pass, 41 skipped[] discriminados |
| L1.B JVM/Android-unit | di-patterns-demo | changed (synthetic diff) | androidUnit | 1 | ✅ exit 0, detected_modules=[di-contracts], 68 tests |
| L1.B JVM/Android-unit | Confetti | parallel | jvm | 1 | ⚠ exit 1 — real test failure in `wearApp` (SpeakerDetailsTest + SettingsScreenTest); BUG-1 surfaced |
| L1.B JVM/Android-unit | Confetti | changed (synthetic diff) | jvm | 1 | ✅ exit 0, detected_modules=[shared] |
| L1.B JVM/Android-unit | Confetti | parallel | desktop | 1 | ✅ exit 0, 2 mods (jvm fallback) |
| **L1.C iOS sim (gap-closing)** | KaMPKit | parallel | ios | 1 | ✅ exit 0, 1 mod (`:shared`), 24 ios tests pass |
| **L1.C iOS sim (gap-closing)** | KaMPKit | changed (synthetic diff) | ios | 1 | ✅ **NEW combo, never wet'd before** — exit 0, 24 tests |
| **L1.C iOS sim (gap-closing)** | PeopleInSpace | parallel | ios | 1 | ✅ **NEW project for iOS wet** — exit 0, 1 mod (`common`), 8 tests, 6 skipped[] discriminados |
| **L1.C iOS sim (gap-closing)** | PeopleInSpace | changed (synthetic diff) | ios | 1 | ✅ exit 0, 1 mod, 8 tests |
| L1.D macOS native | shared-kmp-libs | parallel --module-filter (3 mods) | macos | 1 | ✅ exit 0, 3 mods, 57 tests pass |
| L1.D macOS native | shared-kmp-libs | changed (synthetic diff) | macos | 1 | ✅ exit 0, 1 mod (core-audit), 57 tests |
| L1.E coverage Kover | shared-kmp-libs | coverage standalone | n/a | 1 | ✅ exit 0, 62 mods with kover plugin detected |
| L1.E coverage Kover | shared-kmp-libs | parallel --coverage-tool kover | jvm | 1 | ✅ exit 0, 317 missed lines, 58 mods contributing |
| L1.E coverage Kover | shared-kmp-libs | parallel --min-missed-lines 50 | jvm + kover | 1 | ⚠ exit 0 (BUG-2 — gate not wired to exit) |
| **L1.F concurrency --isolated** | KaMPKit × 2 | 2 procesos en paralelo | ios | 2 | ⚠ A=exit 1 / B=exit 0 — iOS sim race (OBS-4); cache_dirs distintos OK |
| **L1.F concurrency --isolated** | KaMPKit × 2 | 2 procesos en paralelo | jvm | 2 | ✅ ambos exit 0, cache_dirs distintos |
| L1.G envelope contract sweep | (todos los `--json` previos) | jq sweep schema/exit/required | n/a | 47 | ✅ 46/47 OK (1 falso positivo por `2>&1`); F-1 regression preservada |

**Cells totales Part 1:** 38 wet/non-exec invocaciones across 5 proyectos.

### Bugs encontrados Part 1

| ID | Severity | File:Line | Title | Status |
|---|---|---|---|---|
| **BUG-1** | Sev2 (contract gap) | `lib/android-orchestrator.js:696` (only emitter) vs `lib/cli.js#buildJsonReport` | `modules[].testFailures[]` populated only on `android` instrumented path; absent for `parallel --test-type jvm/desktop/macos/ios/androidUnit`. Agents reading `--json` output cannot identify WHICH test cases failed in those paths — must fall back to parsing JUnit XML on disk. Contract asymmetry: PR mac-audit drift #4 added testFailures for android; symmetric fix needed for parallel orchestrator. **Reproduced:** Confetti parallel jvm wearApp had 2 real failures (SpeakerDetailsTest, SettingsScreenTest) → envelope `tests.failed: 1` (module count) + `errors[].code: module_failed` but `modules[].testFailures` field absent. | OPEN — needs decision: fix in this audit cycle or defer (parser addition non-trivial) |
| **BUG-2** | Sev3 (doc/help drift) | `lib/cli.js:173` (help) vs `lib/coverage-orchestrator.js:234` (impl) | `--min-missed-lines <N>` — help text says "Fail if missed lines exceed N" but implementation uses N as a row-filter threshold (`if minMissedLines > 0 && missed < minMissedLines: continue`). With 317 missed lines and `--min-missed-lines 50`, exit was 0 — no fail-gate fires. **Reproduced:** `parallel --test-type jvm --coverage-tool kover --module-filter core-audit --min-missed-lines 50` → exit 0, missed_lines:86, modules_contributing:1 (filtered). | OPEN — trivial fix (either correct help text or wire fail-gate; user decision) |
| **BUG-3 candidate** | Sev3 | `lib/cli.js#SOFT_ERROR_CODES` (line 1743) | `no_test_modules` discriminator (mac-audit Gap 1.1) treated as hard error → exit 3 (ENV_ERROR). But "filter matches no modules" is a usage / config issue, not env failure. Should be either soft (exit 0 + warning) or CONFIG_ERROR (exit 2). **Reproduced:** `parallel --test-type macos --module-filter "a|b|c"` (regex syntax invalid for comma-glob) → `no_test_modules` + exit 3. | OPEN — needs policy decision (which exit code for "empty filter match"?) |

### Observaciones (no bugs, contratos a documentar)

| ID | File:Line | Observation |
|---|---|---|
| **OBS-1** | `lib/cli.js:2080-2102` `runDoctor` | Doctor envelope has 9 keys (`tool, schema_version, subcommand, version, project_root, exit_code, duration_ms, checks, gradle_config`); other subcommand envelopes have 14-16 keys (added `errors`, `warnings`, `modules`, `tests`, `coverage`, `skipped`). PR #178 (Bug-K) added `schema_version: 1` to all envelopes but did NOT unify shape — same schema_version describes two distinct shapes. Agents writing generic envelope-readers must special-case `subcommand: "doctor"`. |
| **OBS-2** | `lib/cli.js#buildDryRunReport` | `--dry-run --json` plan output is at spawn-command level (`spawn_cmd`, `spawn_args`, `script_path`, `final_args`, `test_filter`) only — does NOT enumerate which modules would actually receive the dispatch. Agents wanting to preview "what modules would run" must invoke `describe` separately. Probably by-design; worth noting in CLI docs. |
| **OBS-4** | `lib/parallel-orchestrator.js#--isolated` | `--isolated` isolates Gradle's `--project-cache-dir` and (optionally) lockfile, but does NOT protect against shared runtime resources: iOS simulator (only 1 booted sim per host), ADB daemon, system-wide Konan caches. Concurrent `parallel --test-type ios --isolated` runs WILL race on simulator state. **Reproduced:** L1.F first cell (KaMPKit × 2 ios) → A failed, B passed. Same code, same project. JVM concurrency works fine (no shared resources). Should be in `--isolated` help text or CLI docs. |
| **OBS-5** | `lib/cli.js#envErrorJson` (line 1793) | `envErrorJson` builds error object with `{ message }` only when `code` arg is omitted — for "no gradlew found in <path>" path, the call site passes no code, so `errors[0]` has only `message`. Other env-error paths (e.g. `no_project`, `no_changed_modules`) populate `code` consistently. Agents discriminating on `errors[].code` cannot branch on this case. Should default `code: "no_gradlew"` (or similar) when invoked without one. |

### Disk telemetry per lane

| Lane checkpoint | Disk free | Δ from baseline |
|---|---|---|
| Pre-audit (start) | 6.9 GB | 0 |
| After pre-flight | 6.7 GB | -200 MB |
| After L1.A smoke (5 projects) | 6.7 GB | 0 |
| After L1.B (di-pat + Confetti wet) | 6.7 GB | 0 |
| After L1.C KaMPKit ios | 6.7 GB | 0 |
| After L1.C PIS ios | 4.7 GB | **-2 GB** (kotlin-native cold compile cost) |
| After cleanup + L1.D start | 5.7 GB | recovered 1 GB |
| After L1.D macOS + L1.E coverage | 5.7 GB | 0 |
| After L1.F concurrency | 5.7 GB | 0 |
| **End of Part 1** | **5.7 GB** | **-1.2 GB net** (within budget; kotlin-native shared cache is the heavy item) |

`~/.gradle/caches/modules-2/` preserved at 3.2 GB (per memory rule, never purged).

---

## Inline fix PR (between Part 1 and Part 2)

User chose "Fix los 3 bugs ahora" before continuing to Part 2. PR #183 opened from `fix/wet-audit-v0_9-part2-bugs` off `develop`, 12/12 CI green, squash-merged as `3209cf5`.

| Bug | Fix commit (in PR #183) | Wet re-validation post-merge |
|---|---|---|
| **BUG-1** testFailures gap | `feat(parallel): modules[].test_failures populated for failed tasks` | ✅ Confetti `parallel --test-type jvm` → `modules[wearApp].test_failures[]` has 2 entries (NPE in SettingsScreenTest + SpeakerDetailsTest) with `{test, cause, type}` shape |
| **BUG-2** `--min-missed-lines` doc/impl drift | `fix(coverage): --min-missed-lines fires fail-gate, missed_lines reports project total` | ✅ shared-kmp-libs `parallel --test-type jvm --coverage-tool kover --module-filter core-audit --min-missed-lines 50` → exit 1, `errors[].code: coverage_threshold_exceeded`, `coverage.missed_lines: 317` (real total) |
| **OBS-5** envErrorJson missing code | `fix(cli): envErrorJson carries code on no_gradlew + missing_shell paths` | ✅ `parallel --project-root /nonexistent --json` → `errors[0].code: "no_gradlew"` |

**BUG-3 reclassified to OBS** after reading code (`lib/parallel-orchestrator.js:1740-1751` documents `no_test_modules → ENV_ERROR (3)` as an INTENTIONAL design choice mirroring the legacy wrapper exit code). Behavior is consistent and documented; not a bug, just an audit-time observation.

---

## Part 2 — S22 Ultra lanes (executed post-bugfix-merge)

Device: Samsung S22 Ultra (Exynos), Serial `R3CT30KAMEH`, Model `SM-S908B`, Android 16, arm64-v8a.

| Lane | Project | Subcommand × test-type | Cells | Result |
|---|---|---|---|---|
| L2.A Android unit (host) | KaMPKit | `parallel --test-type androidUnit` | 1 | ✅ exit 0, 1 mod, 24 individual tests |
| L2.A Android unit (host) | KaMPKit | `changed --test-type androidUnit` (synthetic diff) | 1 | ✅ exit 0, detected_modules `[shared]`, 24 tests |
| L2.A Android unit (host) | Confetti | `parallel --test-type androidUnit` | 1 | ⚠ exit 1 (BUG-1 fix in action — `modules[wearApp].test_failures` shows 2 entries: SpeakerDetailsTest + SettingsScreenTest, both NPE. Bug surfaced + fix lands in same audit cycle.) |
| L2.B `kmp-test android` | di-patterns-demo | `--list-only --device $SERIAL` | 1 | ✅ exit 0, `android.instrumented_modules` array of 43 entries; `device_serial` empty post-list-only (OBS-6) |
| L2.B `kmp-test android` | di-patterns-demo | `--device $SERIAL --module-filter di-contracts` (real) | 1 | ✅ exit 0, `tests.total: 0` (NO-SOURCE androidTest), build SUCCESSFUL on device, `android.device_serial: "R3CT30KAMEH"` echoed post-run |
| **L2.C parity-flag matrix** | di-patterns-demo | dry-run for each of 6 PR #146 flags | 6 | ✅ all 6 flags plumb through to spawn args correctly: `--device`, `--device-task`, `--flavor`, `--auto-retry`, `--clear-data`, `--test-filter "class=FQN#method"` |
| L2.C wet-1 | di-patterns-demo | integrated `--device + --device-task + --clear-data + --auto-retry --module-filter di-contracts` | 1 | ✅ exit 0, `android.device_serial`/`device_task` echoed, `retry_fired:false` (no failure to retry), build OK on S22 |
| L2.C wet-2 | di-patterns-demo | `--flavor nonexistentFlavorName --module-filter di-contracts` (negative path) | 1 | ⚠ exit 0 — `--flavor` silently no-ops on projects without productFlavors. **OBS-7** new finding. |
| L2.D failure recovery | n/a | (no workspace project has failing instrumented tests) | 0 wet, plumbing-only | Auto-retry / clear-data plumbing validated via L2.C-W1 + dry-run + existing vitest unit-test coverage in `parallel-orchestrator.test.js`. Real failure injection deferred (synthetic-fail in benchmark module would cost 5+ min/cell with low signal-to-noise). |
| L2.E describe android-aware | Confetti | `describe --module-filter androidApp` (with device connected) | 1 | ✅ envelope IDENTICAL to Part 1 (without device). Confirms describe is a project-model query, NOT a runtime probe. Top-level keys + module shapes byte-identical. |
| L2.F regression sanity | KaMPKit | `parallel --test-type ios` (re-run L1.C cell post-bugfix-merge) | 1 | ✅ exit 0, no regression |
| L2.F regression sanity | shared-kmp-libs | `parallel --test-type macos` (re-run L1.D cell) | 1 | ✅ exit 0, 57 tests, 30s |
| L2.F regression sanity | shared-kmp-libs | `parallel --test-type jvm --coverage-tool kover` (re-run L1.E cell, no min-missed-lines) | 1 | ✅ exit 0, 317 missed (matches Part 1), 58 mods contributing |
| L2.F regression sanity | di-patterns-demo | `parallel --test-type androidUnit` (re-run L1.B cell) | 1 | ✅ exit 0, 1 mod, 68 tests |

**Cells totales Part 2:** 19 (4 wet android + 6 dry-run plumbing + 4 regression + 5 describe/list-only).

### Bugs encontrados Part 2

(none — Part 2 surfaced 1 new observation but no bugs.)

### Observaciones Part 2

| ID | File:Line | Observation |
|---|---|---|
| **OBS-6** | `lib/android-orchestrator.js#runAndroid --list-only` path | `--list-only` populates `android.instrumented_modules[]` (43 entries) but top-level `modules[]` stays empty. Also `android.device_serial` is empty in the list-only envelope (set later only after a real run). Agents reading `modules[]` length to gauge "how many modules will run" must instead pivot on `android.instrumented_modules[]`. Worth aligning shape — but additive, not breaking. |
| **OBS-7** | `scripts/sh/run-parallel-coverage-suite.sh` (computed task chain) | `--flavor <name>` silently no-ops when the project has no productFlavors. Reproduced: `parallel --test-type androidInstrumented --flavor nonexistentFlavorName --module-filter di-contracts` → exit 0, build SUCCESSFUL with default `connectedDebugAndroidTest` task. User's typo / wrong flavor name doesn't surface as a warning. CLI could either (a) warn when `--flavor` is set but project has no flavors, or (b) fail when the resulting `connected${Flavor}DebugAndroidTest` task name doesn't exist. |

### Disk telemetry Part 2

| Lane checkpoint | Disk free | Δ from Part 1 end |
|---|---|---|
| Pre-Part 2 (post-bugfix-merge) | 5.7 GB | 0 |
| After L2.A | 5.6 GB | -100 MB |
| After L2.B + L2.C wet | 5.6 GB | 0 |
| After L2.E + L2.F | 5.6 GB | 0 |
| **End of audit** | **5.6 GB** | **-100 MB** (Part 2 was very disk-light: hot caches from Part 1, no fresh kotlin-native compile) |

**Total audit disk delta:** 6.9 GB → 5.6 GB = **-1.3 GB** (well within budget; main cost was Part 1's kotlin-native compilation against PIS).

---

## What this audit closed (factual, no verdict)

- **iOS gap closed (in evidence)**: `parallel --test-type ios` wet'd on KaMPKit + PeopleInSpace; `changed --test-type ios` wet'd for the first time. Both pass exit 0.
- **macOS native validated (in evidence)**: 3 modules of shared-kmp-libs pass `parallel --test-type macos`, 57 individual tests.
- **3 fixes wet-revalidated** (PR #183 → `3209cf5`): BUG-1 testFailures, BUG-2 coverage gate, OBS-5 envErrorJson code.
- **Schema invariant holds**: 47/47 captured envelopes carry `schema_version: 1`; F-1 regression (envelope.exit_code = process exit) preserved.
- **Parity flags PR #146**: 6/6 plumb correctly via dry-run; 1 integrated wet against S22 echo'd `device_serial` + `device_task` post-run.

## Open findings — pending user classification

The audit surfaced **9 total findings** (3 fixed inline in PR #183; 6 still open). Classifications below describe the *behavior*; whether each is a v0.9 blocker, a v0.9.x follow-up, or a deferred backlog item is the user's decision and is NOT recorded here.

| ID | File:Line | Behavior | Fix complexity (rough) |
|---|---|---|---|
| OBS-1 | `lib/cli.js:2080-2102` `runDoctor` | `doctor` envelope has 9 keys; `info`/`describe`/`parallel` envelopes have 14-16 keys (added `errors`, `warnings`, `modules`, `tests`, `coverage`, `skipped`). Same `schema_version: 1` describes two distinct shapes. | Small — add empty arrays/objects to runDoctor envelope (~10 lines + tests) |
| OBS-2 | `lib/cli.js#buildDryRunReport` | `--dry-run --json` plan output is at spawn-cmd level (`spawn_cmd`, `spawn_args`, `script_path`, `final_args`, `test_filter`); does NOT enumerate which modules would actually receive the dispatch. Agents wanting "what would run" must invoke `describe` separately. | Medium — would need to invoke project-model + filter resolution from buildDryRunReport (~30 lines + tests) |
| OBS-3 | `lib/parallel-orchestrator.js:1740-1751` | `no_test_modules` discriminator (mac-audit Gap 1.1) maps to ENV_ERROR (exit 3). Code comment says "mirrors legacy wrapper's exit 3 path". I previously reclassified this from a bug-candidate to an observation based on the comment alone — **that's a milestone-shape decision, not mine**. | Small — change one Set entry; impact spans CI consumers that branch on exit 3 |
| OBS-4 | `lib/parallel-orchestrator.js#--isolated` family | `--isolated` isolates Gradle's `--project-cache-dir` and lockfile, but does NOT protect against shared runtime resources: iOS simulator, ADB daemon, system-wide Konan caches. Concurrent `parallel --test-type ios --isolated` runs WILL race on simulator state. Reproduced wet (L1.F): KaMPKit × 2 ios → A failed, B passed. | Doc-only (cheap): warning emission in `--isolated` help text. Real fix (resource isolation) is out-of-scope for v0.9. |
| OBS-6 | `lib/android-orchestrator.js#runAndroid --list-only` path | `--list-only` populates `android.instrumented_modules[]` but top-level `modules[]` stays empty. `android.device_serial` is also empty in the list-only envelope (set later only after a real run). Agents reading `modules[]` length must instead pivot on `android.instrumented_modules[]`. | Small — populate top-level `modules[]` from `instrumented_modules` + echo `device_serial` when supplied (~15 lines + tests) |
| OBS-7 | `scripts/sh/run-parallel-coverage-suite.sh` (computed task chain) | `--flavor <name>` silently no-ops when the project has no productFlavors. Reproduced (L2.C-W2): `parallel --test-type androidInstrumented --flavor nonexistentFlavorName --module-filter di-contracts` → exit 0 with default `connectedDebugAndroidTest` task. User typo / wrong flavor doesn't surface. | Small — wrapper warns or fails when supplied flavor doesn't yield a known task; OR Node-side validates against project-model `has_flavor` (~20 lines + tests) |

### Audit metrics

- **Cells executed total**: 38 (Part 1) + 19 (Part 2) + 4 wet revalidations = **61 cells**.
- **Wet projects**: 5 / 5 workspace (KaMPKit, PeopleInSpace, Confetti, di-patterns-demo, shared-kmp-libs).
- **Bugs found**: 3 (BUG-1, BUG-2, OBS-5) — all CLOSED in PR #183 (`3209cf5`).
- **Observations**: 6 (OBS-1, OBS-2, OBS-3, OBS-4, OBS-6, OBS-7) — all OPEN, awaiting user classification.
- **Audit walltime**: ~2 hours (Part 1: ~1h, fix PR cycle: ~30min, Part 2: ~30min).
- **Disk impact**: -1.3 GB net (preserved `~/.gradle/caches/modules-2/` per memory rule).
- **CI**: PR #183 green on 12/12 checks (Linux + Windows + macOS).

### Decision still owed by the user

For each OBS-N above, the user must choose: (a) block v0.9 release until fixed, (b) fix in v0.9.x, or (c) defer further. Until those decisions are recorded, this doc carries no release-readiness verdict.

