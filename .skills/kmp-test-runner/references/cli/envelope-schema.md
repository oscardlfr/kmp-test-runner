# Envelope schema reference (`schema_version: 3`)

The `kmp-test` CLI emits a JSON envelope to stdout when invoked with `--json`. The shape is stable within a major schema version; breaking changes bump `schema_version`. **This file is a curated agent-facing extract.** The canonical source of truth lives at [`docs/envelope-contract.md`](https://github.com/oscardlfr/kmp-test-runner/blob/main/docs/envelope-contract.md) in the source repo.

## Top-level fields (all subcommands)

| Field | Type | Notes |
|-------|------|-------|
| `tool` | string | Always `"kmp-test"`. Discriminator for nested-tool scenarios. |
| `schema_version` | number | Currently `3`. Bumped on breaking shape or exit/error semantic changes. |
| `contracts` | object | Named runtime capabilities. Require integer `coverage_evidence >= 1` before trusting explicit coverage requests. Probe cheaply with `kmp-test --version --json`; old binaries return non-JSON semver text. |
| `subcommand` | string | One of: `parallel`, `changed`, `android`, `benchmark`, `coverage`, `doctor`, `info`, `describe`, `clean`, `update`. |
| `version` | string | kmp-test CLI version (matches `package.json`). |
| `project_root` | string | Absolute path to the gradle project root. |
| `exit_code` | number | `0` SUCCESS / `1` TEST_FAIL / `2` CONFIG_ERROR / `3` ENV_ERROR. See [`exit-codes.md`](exit-codes.md). |
| `duration_ms` | number | Wall-clock duration of the run. |
| `tests` | object | `{ total, passed, failed, skipped, individual_total?, individual_failed?, individual_failed_distinct?, individual_skipped? }` — see [`tests` shape](#tests-shape). |
| `modules` | array | Per-module results — see [`modules[]` shape](#modules-shape). |
| `skipped` | array | `[{ module, reason }]` — modules the dispatcher legitimately skipped. |
| `coverage` | object | `{ tool, missed_lines, covered_lines, total_lines, modules_contributing, modules_with_kover_plugin, modules_with_jacoco_plugin, module_buckets, module_results, data_provenance }` — see [`coverage` shape](#coverage-shape). Aggregate counts follow the selected modules, never the `--min-missed-lines` report-detail filter. Counts are `null` when `modules_contributing` is `0`. |
| `errors` | array | `[{ message, code?, ...extra }]` — see [error-codes table](#errors-discriminated-codes). |
| `warnings` | array | Soft signals — never affect `exit_code`. |
| `isolated` | object | `{ enabled, cache_dir, kept, locked }` — present when `--isolated` was passed (omitted by `coverage` orchestrator, which never dispatches tests — the only gradle process it can trigger is an unrelated, cached module-discovery probe, not a concurrent test run `--isolated` isolates). |

## Subcommand-specific blocks

Exactly one subcommand-specific block is emitted per envelope, at the top level alongside the canonical fields.

| Field | Subcommand | Shape (abbreviated) |
|-------|-----------|---------------------|
| `parallel` | parallel | `{ test_type, legs[], max_workers, timeout_s }` — see [`parallel.legs[]` shape](#parallellegs-shape) |
| `android` | android | `{ device_serial, device_task, flavor, instrumented_modules[] }` |
| `benchmark` | benchmark | Benchmark-specific aggregates. |
| `changed` | changed | List of files/modules detected as changed. |
| `doctor` | doctor | `{ checks[], gradle_config{} }` |
| `info` | info | `{ node, os, platform, shell, gradlew{}, jdk{}, jdk_catalogue{}, android_sdk{}, adb{}, config{}, gradle_config{} }` |
| `describe` | describe | `{ schema_version, cache_key, generated_at, coverage_tool, jdk_requirement, dependency_graph, modules[] }` |
| `clean` | clean | `{ all, dry_run, targets[], removed[], failed[], bytes_freed, bytes_in_targets }` — artifact purge summary (`kmp-test clean`) |

Plus the orthogonal `dry_run: true` flag (with a `plan{}` block) on any subcommand invoked with `--dry-run`.

## `tests` shape

```json
{ "total": 42, "passed": 40, "failed": 1, "skipped": 0, "individual_total": 58, "individual_failed": 3, "individual_failed_distinct": 2, "individual_skipped": 2 }
```

- `total` / `passed` / `failed` / `skipped` — module-level counts (count of dispatched gradle tasks for `parallel`).
- `individual_total` / `individual_failed` / `individual_skipped` — testcase-level execution counts derived from the same JUnit XML files: every testcase, those with a `<failure>` or `<error>` child, those with a `<skipped>` child, whatever the task's status. `individual_failed_distinct` counts unique `(module, testcase)` failure identities. Populated by `parallel` (and `changed`, which copies it) only; omitted for other subcommands and for dry-run and error envelopes.
- Under the umbrella `test` task of a flavored module (no `--flavor`) every flavor's run counts, so a test present in two flavors counts twice, and `modules[].test_failures[]` has one entry per failing execution (`individual_failed` equals their number for a failed task). `individual_failed_distinct` counts that testcase once within its module. Pass `--flavor <name>` to count one flavor.
- `skipped` is module-level and is not incremented by `parallel`; use `individual_skipped` for skipped testcases.

## `modules[]` shape

```json
[
  {
    "name": ":core:network",
    "type": "kmp",
    "coverage_plugin": "kover",
    "test_build_type": null,
    "has_flavor": false,
    "flavors": [],
    "android_dsl": true,
    "android_dsl_variant": "kmpAndroidLibrary",
    "test_failures": []
  }
]
```

Fields:

- `name` — gradle module path (e.g. `:core:network`).
- `type` — `"kmp"` / `"android"` / `"jvm"` / `"unknown"`.
- `coverage_plugin` — `"kover"` / `"jacoco"` / `null`.
- `test_build_type` — `null` unless overridden by the project.
- `has_flavor` — `true` when the module is flavored: declared via `productFlavors {}` **or** recovered from the `gradlew tasks --all` probe (catches flavors applied by a build-logic convention plugin).
- `flavors` — array of recovered flavor names (e.g. `["demo","prod"]`); empty when not flavored or the probe didn't run.
- `android_dsl` — `true` when AGP plugin applied.
- `android_dsl_variant` — variant identifier when `android_dsl` is true (e.g. `kmpAndroidLibrary`, `application`, `library`).
- `test_failures` — populated when the module's task failed AND JUnit XML evidence exists.

### `test_failures[]` shape

```json
[
  {
    "test": "com.example.UserRepositoryTest.fetchUserHandlesTimeout",
    "cause": "expected:<200> but was:<504>",
    "type": "java.lang.AssertionError"
  }
]
```

- `test` — fully-qualified `ClassName.methodName` (or just `methodName` when class can't be resolved).
- `cause` — failure/error message body from JUnit XML.
- `type` — exception class (`null` when the XML element has no `type` attribute).

> Compile-time / setup-time failures (e.g. unresolved imports, missing test dependencies) produce **no** JUnit XML and therefore no `test_failures[]` entries. Detect these via `module_failed` with `setup_failed:true`. Recognized compilation diagnostics appear in the owning module's `errors[].compile_failures[]` (`task`, then `diagnostics[]` with source location and message). `parallel.legs[].compile_failures[]` keeps all recognized compiler failures for that leg, including an upstream compile task outside the selected test modules. Do not treat `setup_failed:true` alone as proof of a compiler error; dependency resolution and other setup faults also have that flag.

## `errors[]` discriminated codes

Branch on `errors[].code` before reading `message` (the message is human-readable and not stable across versions).

| Code | Subcommand | `exit_code` | Description | Extra fields |
|------|-----------|-------------|-------------|--------------|
| `lock_held` | any | 3 | Another `kmp-test` process holds the project lock. Pass `--force` to bypass when safe. | — |
| `no_gradlew` | any | 3 | No `gradlew` / `gradlew.bat` in `--project-root`. | — |
| `missing_shell` | any | 3 | `pwsh`/`powershell` (Windows) or `bash` (Unix) not on `PATH`. | — |
| `wrapper_no_output` | any | 3 | The wrapper (sh/ps1) process exited non-zero without writing anything to stdout — it never ran far enough to produce a summary. On Windows, this means PowerShell refused to load the ps1 even with the `-ExecutionPolicy Bypass` kmp-test's spawn already passes — typically an execution policy enforced by Group Policy (a MachinePolicy/UserPolicy scope outranks the Process-scope Bypass); also covers a POSIX wrapper that can't start (permission denied, `noexec`, missing `bash`). **`--json` only** — in text mode `stdio:'inherit'` streams the child's output straight to the terminal and it is never captured, so this diagnosis isn't observable there; a text-mode run just returns the raw non-zero exit code. Discriminates from the soft `no_summary` (wrapper ran to completion but produced nothing parseable). | `message` carries a bounded stderr excerpt and, when the stderr contains `about_Execution_Policies` / `UnauthorizedAccess` / `PSSecurityException`, a "PowerShell execution policy" hint |
| `no_test_modules` | parallel, changed | **2 \| 3** | No modules match the leg's test-type or `--module-filter`. | `caused_by_filter:bool` (`true` → 2, `false` → 3) |
| `module_failed` | parallel, changed, android | 1 | A Gradle task failed. Recognized compiler diagnostics suppress cascade retry; an independent JUnit failure in the same leg remains a test failure. | `setup_failed:true` (key absent when tests ran), `module:string`, `compile_failures?:[{task:string,diagnostics:[{file:string,line:int,column:int\|null,message:string,language:"kotlin"\|"java"}]}]` **only for the module owning the compiler task**; on instrumented `--capture-on-fail`: `screenshot_file?:string`, `ui_hierarchy_file?:string`, `capture_error?:string` |
| `spawn_error` | any | **1 \| 3** | A child process errored at the spawn layer (e.g. output exceeded `KMP_GRADLE_MAXBUFFER_MB`, default 64 MB). Orchestrator-level gradle child → exit 1; dispatcher-level wrapper spawn failure → exit 3 (env-error envelope, sibling of `missing_shell`). | orchestrator-level: `errno:string` (Node error code), `module:string` |
| `instrumented_setup_failed` | android, parallel, benchmark | 3 | adb has no usable device when one was required. On `parallel`, the adb check only runs when the leg set includes `androidInstrumented` (`--test-type androidInstrumented` explicitly, or `all`) — a plain `--test-type common`/etc. never probes adb, `--device`/`--clear-data` included. Within that: `--device <serial>` (not found / bad state), `--clear-data` when ≥1 device is connected but none usable, or the explicit `androidInstrumented` test-type. **Not** for `--clear-data` with zero devices connected (`clear_data_no_device` instead) or `--test-type all` with neither flag (`instrumented_leg_skipped` instead). | — |
| `device_offline` | android, parallel, benchmark | 3 | A device is present in `adb devices` but its state is `offline` — reconnect USB or restart adb. Same `parallel` prerequisite and branch coverage as `instrumented_setup_failed` above. | `device?:string` (serial, when `--device` was passed) |
| `device_unauthorized` | android, parallel, benchmark | 3 | A device is present but not authorized for USB debugging — accept the RSA prompt on the device. Same `parallel` prerequisite and branch coverage as `instrumented_setup_failed` above. | `device?:string` |
| `multiple_adb_devices` | android, parallel, benchmark | 3 | Multiple usable adb devices without `--device <serial>` — pass `--device` to eliminate ambiguity. On `parallel` (same `androidInstrumented`-leg prerequisite as above): `--clear-data` (≥1 device connected) or the explicit `androidInstrumented` test-type — never `--device <serial>` itself (validates only the one named device). Under `--test-type all` with neither flag, proceeds instead without pinning a device. | — |
| `flavor_unused` | parallel (`androidUnit`/`androidInstrumented`/`all`) | 2 | `--flavor <name>` passed but no module on the leg is flavored (static `productFlavors {}` or probe-recovered). | — |
| `isolated_runtime_race` | parallel | 2 | `--isolated` combined with a test-type that hits a shared runtime resource (iOS sim, ADB without `--device`, `--test-type all`). | — |
| `coverage_threshold_exceeded` | parallel (`--min-missed-lines`), coverage | 1 | Aggregated (unfiltered) `coverage.missed_lines` exceeds the threshold. `--min-missed-lines` never removes coverage data — it only decides this gate and narrows the *markdown report's* per-class detail section; `coverage.missed_lines` / `modules_contributing` / `module_buckets` always reflect the complete project even when this error fires. | `threshold:int`, `missed_lines:int` |
| `module_coverage_threshold_exceeded` | parallel, changed, coverage | 1 | At least one scored module has LINE coverage below `--min-line-coverage`. | `threshold:number`, `modules:string[]` |
| `coverage_data_unavailable` | parallel, changed, coverage | 3 | Requested coverage evidence is unavailable. Explicit `--coverage-tool auto\|kover\|jacoco` requests fail when zero selected modules contribute, even without a numeric budget; mixed real/no-XML inputs retain real totals and expose the missing module in `module_buckets.no_xml`. | `reason:string`; `threshold:int` for a budget, otherwise `required_by:"explicit-coverage-tool"` |
| `dependency_graph_unavailable` | changed | 3 | `--include-dependents` could not resolve the Gradle project graph. The command fails closed instead of running only the direct modules. | — |
| `coverage_budget_without_coverage` | parallel, changed, coverage | 2 | A positive `--min-missed-lines` budget was combined with `--coverage-tool none` / `--no-coverage`. | — |
| `git_error` | changed | 3 | A git command failed — repo unreadable, corrupted, or access denied. **Hard code** — `exit_code` is always 3. Only emitted when git probing fails; `no_changed_modules` is emitted instead when git succeeds but the diff is empty. | `git_command:string` (subcommand invoked), `exit_status:number` (git exit code), `stderr_summary?:string` (first 300 chars of stderr, CR/LF collapsed, omitted when empty) |
| `gradle_timeout` | parallel, benchmark | 3 | The gradle spawn process was killed by the `--timeout` deadline (SIGTERM on POSIX; ETIMEDOUT on Windows). Never retried — spawn timeouts are infra failures, not flaky tests. | **parallel**: `module:string`, `task:string`, `timeout_ms:number`. **benchmark**: additionally `platform:string`, `log_path:string` |
| `task_not_found` | any | 3 | Gradle task class missing — typically a plugin not applied to the requested module. | `probe_failed:true` when the gradle-tasks probe never recovered real task-graph data this run (see `gradle_probe_failed` below) — the task name was guessed statically and may simply be wrong, not genuinely missing. Absent (not `false`) on a normal probe |
| `unsupported_class_version` | any | 3 | JDK toolchain mismatch — gradle daemon ran on an older JVM than the test classes target. | — |
| `invalid_*` | any | 2 | CLI validation failure (e.g. `invalid_flag_value`, `invalid_regex`). `invalid_variant_flavor_conflict` means a composite `--variant` selected a different flavor than explicit `--flavor`. | `flag?`, `value?`; flavor conflict adds `flavor`, `variant_flavor` |
| `unknown_flag` | any | 2 | A `--flag` token was not recognized by any subcommand. Two-layer gate: Layer 1 (cli.js) catches flags unknown to all subcommands before the PS wrapper spawns; Layer 2 (each orchestrator's `default:` case) catches flags valid for other subcommands but not this one. | `flag:string` |
| `no_project` | any | 3 | No gradle project found at `--project-root`. | — |
| `release_resolve_failed` | update | 3 | `kmp-test update` could not resolve the latest release tag (HEAD redirect + REST API both failed). | `probe_errors: [{tier, source, message}]` — per-tier diagnostic (cert / proxy / DNS / rate-limit error message) |
| `current_version_unresolvable` | update | 3 | `kmp-test update` could not read its own `package.json` to compare versions. | — |
| `install_failed` | update | 3 | `kmp-test update` resolved the release but the install script exited non-zero. | `install_command: string` |
| `clean_failed` | clean | 3 | `kmp-test clean` could not remove one or more targets under `.kmp-test-runner/` (file locks / antivirus contention). | `message` lists the offending paths |

**Soft codes** (do **not** affect `exit_code` and do **not** trigger WS-5 promotion):

| Code | Subcommand | Description |
|------|-----------|-------------|
| `no_summary` | any | Wrapper output had no recognizable summary line. Parse-gap fallback — stub scripts in unit tests legitimately exit 0 with this signal. |
| `no_changed_modules` | changed | Working tree clean — no changed modules to test. Legitimate exit-0 outcome. **Only emitted when git probing succeeds** and the diff is genuinely empty; git failures produce `git_error` (hard, exit 3) instead. |

> Other discriminated codes may be reserved for orchestrator-internal use; agents should treat unrecognized codes as **opaque** and forward `message` to the user verbatim.

## `warnings[]` discriminated codes

`warnings[]` carries non-fatal signals that don't affect `exit_code`. Agents can switch on `warnings[].code` to surface advisory information.

| Code | Subcommand | Description | Extra fields |
|------|-----------|-------------|--------------|
| `no_coverage_data` | coverage, parallel, changed | No XML coverage data collected from any module — either no plugin is applied or no test run has produced reports yet. | — |
| `coverage_xml_stale` | parallel, changed | XML predates this execution and was excluded from `current_run` totals. | `modules:string[]` |
| `coverage_aggregation_skipped` | coverage | `--coverage-tool none` (or the `--no-coverage` alias) disabled the aggregation step. | — |
| `coverage_aggregation_drift` | coverage, parallel | The four `module_buckets` (`with_data` + `no_xml` + `parse_errored` + `skipped_by_user`) didn't sum to `modules_with_kover_plugin.length + modules_with_jacoco_plugin.length`. Defensive guard against silent model drops. | `detected:int`, `accounted:int`, `unaccounted:int` |
| `coverage_xml_disabled` | coverage, parallel | A jacoco module ran its report but emitted HTML/`.exec` only — no XML (Gradle's default `xml.required=false`). `kmp-test parallel` enables jacoco XML automatically; this fires when `--no-coverage-xml-autofix` was passed (or XML is otherwise absent). The module is also in `module_buckets.no_xml`. | `modules:string[]` |
| `coverage_parse_failed` | coverage, parallel | A module's coverage XML failed to read or parse (malformed, truncated, or missing content) — the module lands in `module_buckets.parse_errored` and is excluded from the aggregate, never silently folded into a bare `no_coverage_data`. | `modules:string[]` |
| `coverage_xml_oversized` | coverage, parallel | A module's coverage XML exceeded the parser's size cap (default 128 MB; tunable via `KMP_COVERAGE_XML_MAX_MB`) and was skipped — a size-cap-specific subset of `coverage_parse_failed`, discriminated so a legitimately huge report is distinguishable from a malformed one. | `modules:string[]` |
| `coverage_report_write_failed` | coverage, parallel | The coverage markdown report could not be written to disk (full disk, permissions) — the JSON envelope and its `coverage` data are still valid; only the on-disk `.md` file failed. | `message` carries the short fs error code (e.g. `ENOSPC`/`EACCES`) only, never a resolved path |
| `partial_timeout` | benchmark | At least one benchmark module timed out but at least one other passed. Exit code stays at `0` (graded). Pass `--strict-timeouts` to restore pre-graded hard-fail behavior. | `timed_out:int`, `passed:int` |
| `flavor_defaulted_umbrella` | parallel, changed (default test type, `androidUnit`/`androidInstrumented`/`all`) | A flavored Android module ran with no `--flavor`, so the leg dispatched the flavor-agnostic umbrella task (`:module:test` / `:module:connectedAndroidTest`, which run every flavor — slower). Emitted once per run, whatever the test type; not emitted when `--flavor` is given or `--variant all` was asked for. Pass `--flavor <name>` to target one. | `candidates:string[]`, `test_type:string` |
| `variant_unrecognized` | parallel, changed, android, benchmark | `--variant` / `--android-variant` got a value outside `auto|debug|release|all` and the `<flavor>Debug` / `<flavor>Release` forms. Dispatch treats the unknown value as `auto`. | `value:string` (as typed), `allowed:string[]` |
| `gradle_config_applied` | parallel (envelope payload, not `warnings[]` entry) | Project's `gradle.properties` had `org.gradle.parallel=false` so the CLI dropped its own `--parallel` injection to respect user intent. | `parallel_dropped:bool` (on the top-level `gradle_config_applied:{}` field) |
| `config_invalid_field` | any (runner-backed) | A `.kmp-test-runner.json` / user-global config field failed validation and was dropped — previously visible only as a stderr `[WARN]` line, invisible to `--json` consumers. | `source: "project_local" \| "user_global"` |
| `envelope_parse_failed` | parallel, changed, android, benchmark, coverage | The orchestrator's envelope sentinel was present in stdout but its JSON did not parse (truncated/corrupted); results come from the coarser legacy output parser. | `reason: "json_parse_failed"` |
| `log_write_failed` | android | A per-module log/logcat/errors artifact could not be written (disk full, read-only dir) — that module's `log_file`/`logcat_file`/`errors_file` pointer may be a dead link. | `path:string` |
| `junit_xml_oversized` | parallel, changed | A `TEST-*.xml` report exceeded the size cap (default 32 MB; tunable via `KMP_JUNIT_XML_MAX_MB`) and was skipped — `tests.individual_total` undercounts and that task's `test_failures[]` may be incomplete. | `module:string`, `task:string`, `file:string`, `size_bytes:int`, `max_mb:int` |
| `test_filter_unsupported` | benchmark | `--test-filter` was set, so jvm benchmark legs were skipped: kotlinx-benchmark tasks reject gradle's `--tests` and have no CLI filter — running unfiltered would dispatch the full suite the user narrowed. Per-module detail in `skipped[]`; the android leg still filters via `-P` instrumentation args. Narrow jvm runs with `--module-filter` or the build-script `benchmark { configurations { include(...) } }` DSL. | `platform:"jvm"`, `test_filter:string`, `skipped_modules:int` |
| `instrumented_only_skipped` | parallel, changed | The unit / auto-detect leg skipped a module whose only test surface is instrumented (`androidInstrumentedTest` / `androidTest`). Run those tests with `--test-type androidInstrumented` (or `kmp-test android`). Suppressed under `--test-type all` (that run already targets the instrumented leg). | `module:string` |
| `instrumented_leg_skipped` | parallel (`all`), changed (`all`) | Distinct from `instrumented_only_skipped` above (that one skips a single module on a *different* leg; this one skips the *entire* `androidInstrumented` leg itself). `--test-type all`'s implicit `androidInstrumented` leg (added by `legsForAll` unless `KMP_TEST_SKIP_ADB=1`) was dropped because no usable adb device was found — the leg was never requested explicitly, so this narrows the run instead of failing it (an explicit `androidInstrumented` request, or `--device`/`--clear-data`, still gets the hard `instrumented_setup_failed`/`device_offline`/`device_unauthorized` error in the same situation). The other legs still dispatch and their own results decide `exit_code`. | `reason:string` (the adb error code that would have fired explicitly) |
| `clear_data_no_device` | parallel | `--clear-data` was passed with zero adb devices connected — the `pm clear` hook is skipped, best-effort, and the run proceeds (never an error). Once at least one device is connected, `--clear-data` instead falls through to the same strict validation as an explicit `--device`-less request. | — |
| `gradle_deprecation` | any | gradle exited 1 solely because of Gradle 9+ deprecation warnings while every task passed; the `BUILD FAILED` line is not duplicated to `errors[]`. | — |
| `no_test_modules_for_leg` | parallel (`all`) | a leg matched no modules, but at least one sibling leg passed — demoted from the `no_test_modules` error to a per-leg warning. | `test_type:string` |
| `no_adb_implies_list_only` | android, info | `--no-adb` / `KMP_TEST_SKIP_ADB` was set on the instrumented path; dispatch was skipped and the module set emitted as list-only. | — |
| `gradle_probe_failed` | parallel, coverage, android, benchmark, describe | The `gradlew tasks --all --quiet` probe that resolves real per-module task names didn't succeed cleanly on the first try. Retried exactly once on `exit_nonzero`/`empty_output` (never on `timeout`/`spawn_error`); fires whenever attempt 1 failed, including when the retry then succeeded. | `reason:"timeout"\|"exit_nonzero"\|"empty_output"\|"spawn_error"`, `exit_code:number\|null`, `attempts:int`, `recovered:bool`, `message` (bounded ≤2 KB stderr excerpt) |

**Agent guidance for `gradle_probe_failed`:** if `recovered:true`, the run already used real probe data — no action needed. If `recovered:false`, dispatch fell back to guessing task names statically, so a sibling `task_not_found` may be a false alarm; rerun the command once (the underlying failure is often transient). If it persists, run `gradlew tasks --all` directly in the project to see the actual build error behind the probe failure.

> Like errors, future warning codes can land additively without bumping `schema_version`. Treat unrecognized codes as opaque.

## WS-5 invariant

If `errors[]` contains any HARD-coded entry, the `exit_code` MUST be non-zero. The CLI auto-promotes `0 → 1 (TEST_FAIL)` when this invariant would otherwise be violated. Soft codes (`no_summary`, `no_changed_modules`) do NOT trigger promotion.

This guarantee was introduced post-v0.7.x. Before it, agents reading `errors.length > 0` while the process exited 0 received false positives on "passing" runs.

This lets agents safely read **either** `errors.length > 0` **or** `exit_code !== 0` and get consistent semantics. (Reading both is even safer.)

## `coverage` shape

```json
{
  "tool": "auto",
  "missed_lines": 12,
  "covered_lines": 88,
  "total_lines": 100,
  "modules_contributing": 1,
  "modules_with_kover_plugin": [":core:network", ":feature:auth"],
  "modules_with_jacoco_plugin": [],
  "module_buckets": {
    "with_data": [":core:network"],
    "no_xml": [":feature:auth"],
    "parse_errored": [],
    "skipped_by_user": []
  },
  "module_results": [
    { "module": "core:network", "status": "with_data", "covered_lines": 88, "missed_lines": 12, "total_lines": 100, "line_coverage_percent": 88, "xml_report_file": "core/network/build/reports/kover/report.xml" },
    { "module": "feature:auth", "status": "no_xml", "covered_lines": null, "missed_lines": null, "total_lines": null, "line_coverage_percent": null, "xml_report_file": null }
  ],
  "data_provenance": "saved_reports"
}
```

- `tool` — `"auto"` / `"kover"` / `"jacoco"` / `"none"`.
- `missed_lines` — aggregated count, across the modules `--coverage-modules` / `--exclude-coverage` selected for this run, or `null` when `modules_contributing` is `0` (no module actually contributed coverage data). `--min-missed-lines` never narrows this field within that selected set (it only decides the `coverage_threshold_exceeded` gate and the markdown report's per-class detail section).
- `covered_lines` / `total_lines` — same aggregate scope and null-semantics as `missed_lines` (`total_lines` == `covered_lines` + `missed_lines` when non-null). `null` whenever `modules_contributing` is `0` — no coverage plugin contributed data, so there is nothing to report a ratio over.
- `modules_contributing` — count of modules with real aggregated data. Same unfiltered guarantee as `missed_lines`: a `--min-missed-lines` value that no single class individually crosses does **not** zero this out, and does **not** trigger a false `no_coverage_data` warning.
- `modules_with_kover_plugin` / `modules_with_jacoco_plugin` — per-module surface so agents see which coverage flavor each module declares.
- `module_buckets` — per-module accounting on a successful `coverage` / `parallel` run. Each module with a detected coverage plugin lands in exactly one bucket: `with_data` (XML found fresh and parsed without error — see below, this does NOT guarantee non-zero coverage), `no_xml` (XML missing on disk — the most common silent-drop case in CI), `parse_errored` (the coverage-XML parser reported a failure — malformed, unreadable, or oversized XML; see the `coverage_parse_failed` / `coverage_xml_oversized` warning codes for the discriminated reason), or `skipped_by_user` (filtered out by `--exclude-coverage` / `--coverage-modules`). The sum of the four buckets should equal `modules_with_kover_plugin.length + modules_with_jacoco_plugin.length`; when it doesn't, a `coverage_aggregation_drift` entry is pushed to `warnings[]` with `{detected, accounted, unaccounted}` counts. Buckets are empty on `--dry-run` and `--coverage-tool none` for shape parity.
- `module_results[]` — each selected module's LINE result: `module`, `status`, `covered_lines`, `missed_lines`, `total_lines`, `line_coverage_percent` (rounded to one decimal), and project-relative `xml_report_file` or `null`. Status may be `with_data`, `no_xml`, `parse_errored`, `stale_xml`, `skipped_by_user`, `tool_mismatch`, or `no_coverage_plugin`; only positive coverable lines produce a percentage. A `--min-line-coverage` gate fails with `module_coverage_threshold_exceeded` (exit 1) for scores below the requested decimal percentage. Missing required XML, parse failures, zero coverable lines, or ambiguous flavored variants emit `coverage_data_unavailable` (exit 3) rather than silently passing.
- `data_provenance` — `"current_run"` when `parallel`/`changed` aggregates coverage from that test execution, excluding stale XML; `"saved_reports"` on standalone `coverage` or `parallel --skip-tests`/`--coverage-only`; `null` for dry-run, disabled coverage, or empty shapes. Do not use `saved_reports` to claim fresh test execution.
- **`with_data` vs. `modules_contributing`** — not interchangeable. `with_data` only means the XML parsed cleanly; a module can sit in `with_data` with zero coverable lines (interface-only module, or a coverage-report task that ran without any test executing — e.g. the unit-test task failed at setup, and Kover/JaCoCo still emit a structurally valid, empty report). That module is excluded from `modules_contributing` and from the aggregate. To check whether ANY real coverage data exists, read `modules_contributing`, never `with_data.length`.
- Coverage XML parsing is Node-native (`lib/parsers/coverage-xml.js`) — no `python3` (or any interpreter) is required on the host.

**`covered_lines`/`total_lines` scope**: present with `missed_lines`'s null-semantics on every `parallel`/`changed`/`coverage` envelope (including `--dry-run` and CONFIG_ERROR/ENV_ERROR envelopes), **except** `parallel`'s `no_test_modules` (`modules.length === 0`) early-exit, which stays at its fixed 4-key shape. Other subcommands (`android`, `benchmark`, `describe`, `info`, `update`, `clean`, `doctor`) may omit both fields entirely in their own coverage placeholders — treat an absent key as `null`.

## `parallel.legs[]` shape

Emitted on the `parallel` subcommand. Each leg corresponds to a test-type (e.g. `androidUnit`, `jvmTest`, `desktopTest`, `androidInstrumented`).

```json
{
  "test_type": "androidUnit",
  "exit_code": 1,
  "execution": {
    "fresh": 0,
    "up_to_date": 0,
    "from_cache": 0,
    "no_source": 0,
    "skipped_by_gradle": 0,
    "failed": 0,
    "no_evidence": 1
  },
  "cascade_detected": false,
  "retry_fired": false,
  "compile_failures": [
    { "task": ":core:data:compileKotlin", "diagnostics": [{ "file": "core/data/src/main/kotlin/Example.kt", "line": 47, "column": 12, "message": "Unresolved reference", "language": "kotlin" }] }
  ]
}
```

- `execution.*` — per-task disposition counts.
- `cascade_detected` — `true` when every requested task has `no_evidence`, the Gradle process failed, and no compiler failure was recognized; this may trigger one per-module retry.
- `retry_fired` — `true` when the orchestrator's per-module retry path executed for this leg. Recognized compilation failures keep it `false`.
- `compile_failures` — optional, leg-wide compiler evidence. Each failure names the compiler task and its diagnostic locations. The owning module's `module_failed` error also receives its matching failures; unrelated test-failure errors do not.

## Special envelopes

### Invalid-args envelope (`exit_code: 2`)

When CLI args fail validation, kmp-test emits a minimal envelope with `exit_code: 2` and `errors[]` populated with `invalid_*` codes only. Empty `modules: []`, `skipped: []`, `tests: {total:0, ...}`, `coverage{}` with empty plugin arrays.

### Env-error envelope (`exit_code: 3`)

When the environment is missing prerequisites (no `gradlew`, no JDK, no project root), kmp-test emits an envelope with `exit_code: 3` and a single discriminated entry in `errors[]` (typically `no_project`, `no_gradlew`, `missing_shell`, etc.).

### Dry-run envelope (`dry_run: true`)

`--dry-run` produces the same envelope shape with a top-level `dry_run: true` flag and a `plan{}` block describing what *would* run. `exit_code` is always `0` in dry-run mode unless validation pre-fails. When `--isolated` is combined with `--dry-run`, the top-level `isolated:{}` field is also emitted to match real-run shape. The subcommand-specific block (`android:{}` / `benchmark:{}` / `changed:{}` / `parallel:{}`) is also emitted on dry-run with empty-but-present default values — `--device` / `--device-task` / `--flavor` / `--config` are echoed verbatim, counter fields default to `0`, array fields default to `[]`.

## Versioning policy

`schema_version` bumps on:

- Removing or renaming a top-level field.
- Changing the type of an existing field.
- Changing the semantics of an `exit_code` or `errors[].code` → exit mapping.

Additive changes do NOT bump:

- New top-level fields (e.g. a future `notices: []`).
- New enum entries in `errors[].code`.
- New entries in a subcommand-specific block.
- New optional fields on an existing `errors[]` entry (e.g. `module_failed` gains `screenshot_file` / `ui_hierarchy_file` / `capture_error` under `kmp-test android` or `parallel --test-type androidInstrumented` with `--capture-on-fail`).

### Version 2 (v0.9.0) breaking changes

- **`no_test_modules`** — exit-code split. `CONFIG_ERROR (2)` when downstream of a user filter (`caused_by_filter:true`); `ENV_ERROR (3)` when project genuinely has no test modules.
- **`flavor_unused`** — promoted from `warnings[]` to `errors[]`, mapped to `CONFIG_ERROR (2)`. Pre-v0.9 the misconfiguration was a soft warning + exit 0 that CI gates routinely missed.
- **`isolated_runtime_race`** — new error code. `CONFIG_ERROR (2)` when `--isolated` is combined with a test-type that hits a shared runtime resource (iOS sim, ADB without `--device`, or `--test-type all`).
- **`module_failed`** — gains `setup_failed:bool`. `true` when the task failed AND no JUnit XML evidence exists (compile-time / setup-time failure). Discriminates from "tests ran and one failed".

## Cross-tool comparison: `android` CLI analogues

An agent that loads this skill may also have Google's [`android` CLI](https://developer.android.com/tools/agents/android-cli) available. Two command pairs superficially overlap:

| kmp-test                                | `android` CLI       | Both answer                              |
|-----------------------------------------|---------------------|------------------------------------------|
| `kmp-test parallel --dry-run --json`    | `android describe`  | "What modules / build targets does this project have?" |
| `kmp-test doctor --json`                | `android info`      | "Where is my SDK / JDK / environment?"   |

The shapes are **deliberately independent** — the tools target different consumers and platforms. Default to `kmp-test` for these flows; use `android` CLI for SDK probing or emulator / screen / UI workflows that `kmp-test` does not cover.

### Pair 1: `kmp-test parallel --dry-run --json` ↔ `android describe`

| Aspect | kmp-test | `android describe` |
|---|---|---|
| Output channel | JSON document on stdout | Plain-text status lines on stdout + JSON files written to disk; stdout prints their paths |
| Consumption model | inline (parse one JSON, get everything) | pointer (parse path lines, open each per-target file) |
| Tool identifier | `tool: "kmp-test"` | (none) |
| Schema version | `schema_version: 3` (versioned breaking-change policy) | (none in output) |
| Project root | `project_root` (string) | `Target project directory: <abs path>` (text) |
| Modules / targets (dry-run preview) | `plan.modules[]` with `{name, type, coverage_plugin, test_build_type, has_flavor, flavors, android_dsl, android_dsl_variant}` per entry | per-target JSON files documenting build outputs (e.g. APK paths) |
| Errors | `errors[]` with discriminated `code` (17+ codes) + WS-5 invariant | Plain-text `Error: …` lines + non-zero exit |
| Warnings | `warnings[]` with discriminated `code` (6 codes) | (none) |
| Side effects | None (pure read-only probe) | Copies `init.gradle.kts` into target's `.gradle/`; invokes `gradlew dumpModels` |

Different abstractions: `kmp-test` answers "what modules can I run tests on?"; `android describe` answers "where are the build artifacts?". The two are complementary, not interchangeable.

### Pair 2: `kmp-test doctor --json` ↔ `android info`

| Aspect | kmp-test | `android info` |
|---|---|---|
| Output format | JSON document, stable schema | Plain text `key: value` lines (3 fields: `sdk`, `version`, `launcher_version`) |
| SDK location | `checks[]` row `{name:"Android SDK", value:"<path or null>", status:"OK"\|"WARN"\|"FAIL"}` | Top-level `sdk: <path>` |
| JDK location + version | `checks[]` rows for `JAVA_HOME`, `JAVA_VERSION`, `JDK Catalogue` | (not surfaced) |
| Gradle wrapper presence | `checks[]` row `gradlew` | (not surfaced) |
| ADB availability | `checks[]` row `ADB` | (not surfaced) |
| Gradle config | `gradle_config{parallel, workers_max, caching, daemon, configureondemand, jvmargs}` | (not surfaced) |
| User-global / project config | `checks[]` rows for User Config / Project Config (matched preset key) | (not surfaced) |

`android info` is a quick SDK-location probe; `android info sdk` returns only the SDK path on the current CLI. `kmp-test doctor` is a full test-orchestration readiness check with discriminated diagnostics. Do **not** `JSON.parse(android info)` — it's plain text. On Windows PowerShell, `$Sdk = (android info sdk).Trim()` gives the SDK path; on POSIX, the `doctor --json` output can be queried with `jq`.

### When to pick which tool

- **`kmp-test` (default for this skill)** — cross-platform, stable schema, discriminated error/warning codes, no side effects on `--dry-run`.
- **`android` CLI** — quick SDK probe (`android info sdk`), app deployment and screen/UI workflows (`android run`, `android screen capture`, `android layout`). Use the SDK emulator executable for AVD lifecycle on Windows; Google's current known issues list `android emulator` as disabled there. `android describe` writes per-target build-output files, separate from kmp-test module discovery.

### Windows verification boundary

An older Android CLI build failed to invoke `gradlew.bat` from `android describe` on Windows. This has not been retested here with the current build, so do not infer either that the bug persists or that it is fixed. For kmp-test module selection, use `kmp-test describe --json`; check the installed Android CLI help and run `android describe` separately only when its AGP build-output paths are needed.

## See also

- [`exit-codes.md`](exit-codes.md) — exit-code semantics + WS-5 invariant in detail
- [`flags-reference.md`](flags-reference.md) — CLI flag reference (placeholder; full table in a follow-up release)
- [`docs/envelope-contract.md`](https://github.com/oscardlfr/kmp-test-runner/blob/main/docs/envelope-contract.md) — canonical source of truth in the kmp-test-runner repo
