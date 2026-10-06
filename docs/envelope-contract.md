# `--json` envelope contract

Versioned from `v0.9.0`. The current contract is `schema_version: 3`; breaking
shape or exit/error semantic changes bump it.

## Runner identity and capability preflight

Before invoking Gradle, consumers can probe the installed binary with:

```bash
kmp-test --version --json
```

```json
{"tool":"kmp-test","version":"0.16.0","schema_version":3,"contracts":{"coverage_evidence":1}}
```

Plain `kmp-test --version` remains the semver-only text form. A consumer that
depends on fail-closed coverage must JSON-parse the identity and require
`tool === "kmp-test"` plus integer `contracts.coverage_evidence >= 1`. Missing,
non-JSON, malformed, or lower values are incompatible. The same `contracts`
object appears on every canonical execution envelope so consumers can verify
the contract again before trusting results. If a migrated wrapper falls back
to the coarse legacy text parser, the execution envelope deliberately reports
`coverage_evidence: 0` because that parser cannot reconstruct the rich coverage
fields; reject that run even when the preflight identity was compatible.

`stdout` contains the single JSON envelope. For a failed migrated command, `stderr`
also retains a bounded excerpt of the runner's captured human diagnostics (at most
64 KiB, with truncation labelled). Internal envelope markers and their JSON blocks
are excluded. Successful commands do not forward those captured progress logs.
Exit codes, grading facts and envelope schema are unchanged. Parse `stdout` only;
do not concatenate the streams before parsing JSON.

Diagnostic stderr is **not privacy-safe telemetry**: Gradle can include source paths,
repository URLs or build messages. Keep it in the execution's protected artifact
boundary. A restricted evaluator must export only approved structured projections,
not the text itself. The excerpt is not a complete Gradle transcript and cannot
recover captures already discarded by an older CLI version.

## Top-level shape

Every subcommand emits the same canonical envelope on `--json`. Subcommand-specific blocks (`parallel`, `android`, `benchmark`, `changed`, `doctor`, `info`, `describe`, `clean`) are added at the top level when relevant.

```jsonc
{
  "tool": "kmp-test",
  "schema_version": 3,
  "contracts": { "coverage_evidence": 1 },
  "subcommand": "parallel",        // | "android" | "benchmark" | "changed" | "coverage" | "doctor" | "info" | "describe" | "clean" | "update"
  "version": "<semver>",           // CLI version reading package.json
  "project_root": "<absolute path>",
  "exit_code": 0,                  // 0 ok | 1 test fail | 2 config error | 3 env error
  "duration_ms": 0,
  "tests": {
    "total": 0,                    // module-level (count of dispatched tasks for parallel)
    "passed": 0,
    "failed": 0,
    "skipped": 0,
    "individual_total": 0,         // testcase-level (parallel only — derived from JUnit XML)
    "individual_failed": 0,        // testcases with a <failure> or <error> child (parallel only)
    "individual_skipped": 0        // testcases with a <skipped> child (parallel only)
  },
  "modules": [
    {
      "name": "moduleB",
      "type": "kmp",               // | "android" | "jvm" | "unknown"
      "coverage_plugin": "kover",  // | "jacoco" | null
      "test_build_type": null,
      "has_flavor": false,
      "android_dsl": true,
      "android_dsl_variant": "kmpAndroidLibrary",
      "test_failures": []          // populated when status='failed' AND XML evidence exists
    }
  ],
  "skipped": [
    { "module": "moduleC", "reason": "no test source set" }
  ],
  "coverage": {
    "tool": "auto",                // | "jacoco" | "kover" | "none"
    "missed_lines": null,          // complete selected-module total; never narrowed by --min-missed-lines; only meaningful when modules_contributing > 0
    "covered_lines": null,         // same scope/null-semantics as missed_lines — null whenever modules_contributing is 0
    "total_lines": null,           // same scope/null-semantics as missed_lines — null whenever modules_contributing is 0
    "modules_contributing": 0,     // count of selected modules with real aggregated data
    "modules_with_kover_plugin": [],
    "modules_with_jacoco_plugin": [],
    "module_buckets": {            // per-module accounting; sum must equal detected-plugin count
      "with_data": [],             // XML found fresh and parsed -- may still hold zero coverable lines; see below
      "no_xml": [],                // XML missing or rejected as stale for this run
      "parse_errored": [],         // coverage-xml.js parser reported errored:true (malformed/missing/oversized XML)
      "skipped_by_user": []        // filtered by --exclude-coverage / --coverage-modules
    },
    "module_results": [],         // {module,status,covered_lines,missed_lines,total_lines,line_coverage_percent,xml_report_file}; null numbers = no evaluable lines
    "data_provenance": "saved_reports", // "current_run" for full parallel/changed runs; standalone coverage reads saved XML
    "report_file": null            // project-relative markdown report path; null when none was written
  },
  "errors": [],                    // see Error codes below
  "warnings": [],
  "isolated": {                    // present when --isolated was passed
    "enabled": false,
    "cache_dir": null,
    "kept": false,
    "locked": true
  }

  // Subcommand-specific blocks — only emit one per envelope:
  // "parallel": { "test_type": "...", "legs": [...], "max_workers": 0, "timeout_s": 0 }
  // "android":  { "device_serial": "...", "device_task": "...", "flavor": "...", "instrumented_modules": [] }
  // "benchmark": { ... }
  // "changed":   { ... }
  // "doctor":    { "checks": [...], "gradle_config": {} }
  // "info":      { "node": "v22.x", "os": "...", "platform": "...", "shell": "...", "gradlew": {...},
  //                "jdk": {...}, "jdk_catalogue": {...}, "android_sdk": {...}, "adb": {...},
  //                "config": {...}, "gradle_config": {...} }
  // "describe":  { "schema_version": 1, "cache_key": "<sha1>", "generated_at": "ISO-8601",
  //                "coverage_tool": "...", "jdk_requirement": {...}, "dependency_graph": {...},
  //                "modules": [...] }
}
```

### `tests`: module-level and testcase-level counts

`total`, `passed`, `failed` and `skipped` are module-level: one unit per dispatched Gradle task (for `parallel`,
`skipped` is not incremented). `individual_total`, `individual_failed`, `individual_failed_distinct` and `individual_skipped` are the
testcase-level view of the same run, and only `parallel` (and `changed`, which copies its delegate) carries them:

- They are counted from the same JUnit XML files, with the same freshness and size guards, whatever the task's status:
  `individual_total` is every `<testcase>`, `individual_failed` those with a `<failure>` or `<error>` child,
  `individual_skipped` those with a `<skipped>` child. A passing task can carry skipped testcases.
- The files are the task's own Gradle result directory and, for an instrumented task (`connected…AndroidTest`,
  `connectedCheck`, `androidConnectedCheck`, or any task of the `androidInstrumented` leg), AGP's
  `build/outputs/androidTest-results/connected/` directory. A unit-test task never reads that directory, so results
  that an earlier device run left there are not counted for it.
- Under the umbrella `test` task of a flavored module (no `--flavor`, see `flavor_defaulted_umbrella`) every flavor's
  run counts, so a test that exists in two flavors is counted twice. `modules[].test_failures[]` lists one entry per
  failing execution in the same way, and `individual_failed` equals the number of those entries for a failed task.
  `individual_failed_distinct` counts unique `(module, testcase)` identities, so those two executions count once.
  Pass `--flavor <name>` to count one flavor.
- Envelopes built without JUnit XML (`--dry-run`, error envelopes, `changed --show-modules-only`) omit these four keys
  rather than report zeros: a consumer treats an absent key as unknown, like the coverage keys below. A real run that
  found no XML reports zeros.
- `tests.skipped` keeps its meaning and is not a testcase count.

### `covered_lines` / `total_lines` scope

`covered_lines` / `total_lines` accompany `missed_lines`, with the same null-semantics (`null` exactly
when `modules_contributing` is `0`), on every envelope `parallel` / `changed` / `coverage` construct
through the shared envelope builders (`buildJsonReport`'s real aggregate, `buildDryRunReport`,
`envErrorJson`, `buildInvalidArgsEnvelope`) or their own equivalent literal — including `--dry-run`,
CONFIG_ERROR/ENV_ERROR envelopes, and `changed`'s `--show-modules-only` short-circuit. The one
exception is `parallel`'s `modules.length === 0` (`no_test_modules`) early-exit shape: it stays at its
existing 4 keys (`tool`, `missed_lines`, `modules_with_kover_plugin`, `modules_with_jacoco_plugin`) —
a fixed contract the agentic-eval grader's `isCoherentNoApplicableTestsCoverageBlock` pins by exact
shape, deliberately left untouched.

`android` / `benchmark` / `describe` / `info` / `update` / `clean` / `doctor` construct their own
one-off `coverage:{}` placeholders (they never compute coverage line counts at all) and do **not**
carry `covered_lines`/`total_lines` — except where they too route through the shared
`buildDryRunReport`/`envErrorJson`/`buildInvalidArgsEnvelope` builders (e.g. `android --dry-run`,
`benchmark --dry-run`), which now include the two fields as a side effect of being shared, generic
infrastructure. A consumer should treat an absent key the same as an explicit `null`, not assume its
absence means anything else.

### `module_buckets.with_data` vs. `modules_contributing`

`with_data` means the module's coverage XML was found fresh and parsed without error — nothing more. A
module can land in `with_data` while contributing zero coverable lines: an interface-only module, or a
report produced by a build that ran the coverage-report task without ever executing a test (e.g. the
underlying unit-test task failed at setup, so Kover/JaCoCo still emit a structurally valid, empty
report). That module counts toward `with_data.length` but not toward `modules_contributing`, and the
aggregate (`missed_lines`/`covered_lines`/`total_lines`) does not include it. A consumer that wants to
know whether ANY real coverage data exists must read `modules_contributing`, never `with_data.length` —
the two are not interchangeable, and a project where every `with_data` module happens to be
zero-coverage-real will show `modules_contributing: 0` alongside a non-empty `with_data` array.

For `parallel` / `changed`, explicitly passing `--coverage-tool auto|kover|jacoco`
activates contract `coverage_evidence: 1`: zero real contributors fail closed as
`coverage_data_unavailable` (exit `3`), even without `--min-missed-lines`. If at
least one selected module contributes real XML while another is `no_xml`, the run
may succeed and the three numeric totals are computed only from the contributors;
the non-contributor remains visible in `module_buckets.no_xml`.

## Exit codes

| Exit | Meaning | Source |
|---|---|---|
| `0` | Success — tests pass, or non-test cell completed cleanly | default |
| `1` | Test failure — at least one module reported a failed test | `EXIT.TEST_FAIL` |
| `2` | CLI usage / configuration error — fail-fast before gradle when possible | `EXIT.CONFIG_ERROR` |
| `3` | Environment error — adb missing, gradlew missing, JDK mismatch, etc. | `EXIT.ENV_ERROR` |

Exit codes 124+ are reserved for OS-level signals; the orchestrator never emits them directly.

## Error codes (`errors[].code`)

| Code | Subcommand | Exit | Description |
|---|---|---|---|
| `lock_held` | any | 3 | another `kmp-test` process holds `<project>/.kmp-test-runner.lock`; pass `--force` to bypass when sure |
| `no_gradlew` | any | 3 | no `gradlew` / `gradlew.bat` in `--project-root` |
| `missing_shell` | any | 3 | `pwsh`/`powershell` (Windows) or `bash` (Unix) not on `PATH` |
| `wrapper_no_output` | any | 3 | the wrapper (sh/ps1) process exited non-zero without writing anything to stdout — it never ran far enough to produce a summary. On Windows, this means PowerShell refused to load the ps1 even with the `-ExecutionPolicy Bypass` kmp-test's spawn already passes — typically an execution policy enforced by Group Policy (a MachinePolicy/UserPolicy scope outranks the Process-scope Bypass); also covers a POSIX wrapper that can't start (permission denied, `noexec`, missing `bash`). `errors[].message` carries a bounded stderr excerpt and, when the stderr contains `about_Execution_Policies` / `UnauthorizedAccess` / `PSSecurityException`, a "PowerShell execution policy" hint. **`--json` only** — in text mode the child's output streams directly to the terminal (`stdio:'inherit'`) and is never captured, so this diagnosis isn't observable there. Discriminates from the soft `no_summary` (wrapper ran to completion but produced nothing parseable) |
| `no_test_modules` | parallel, changed | 2 \| 3 | no modules match the leg's test-type or `--module-filter`. `errors[].caused_by_filter:true` → CONFIG_ERROR (user filter mismatch); `:false` → ENV_ERROR (project genuinely empty) |
| `module_failed` | parallel, changed, android | 1 | a gradle task failed. `errors[].setup_failed:true` when no JUnit XML evidence exists. For a recognized Gradle compile failure on parallel/changed, `errors[].compile_failures[]` contains `{task, diagnostics:[{file,line,column,message,language}]}`; `file` is relative to the project when possible and Java diagnostics use `column:null`. The compile cause also suppresses cascade retry. On `kmp-test android --capture-on-fail` or `parallel --test-type androidInstrumented --capture-on-fail`, the entry additionally carries `screenshot_file` / `ui_hierarchy_file` (device captures) and `capture_error` when adb couldn't oblige |
| `spawn_error` | any | 1 \| 3 | a child process errored at the spawn layer and never ran to completion (e.g. `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` when output exceeds `KMP_GRADLE_MAXBUFFER_MB`, default 64 MB). Orchestrator-level (gradle child; android/benchmark, exit 1): `errors[].errno` carries the Node error code — discriminates from `module_failed` ("gradle ran, tests failed"). Dispatcher-level (the wrapper itself failed to spawn; exit 3): env-error envelope, sibling of `missing_shell` |
| `instrumented_setup_failed` | android, parallel, benchmark | 3 | adb has no usable device when one was required. On `parallel`, the whole adb check only runs when the leg set includes `androidInstrumented` (`--test-type androidInstrumented` explicitly, or `all` — a plain `--test-type common`/etc. never probes adb at all, `--device`/`--clear-data` included). Within that: fires for `--device <serial>` (not found, or found in some other non-ready state), for `--clear-data` *when at least one device is connected but none is usable*, and for the explicit `androidInstrumented` test-type with no `--device`/`--clear-data`. Does **not** fire for `--clear-data` with **zero** devices connected (that's the softer `clear_data_no_device` warning below) or for `--test-type all` with no `--device`/`--clear-data` (the implicit leg is dropped instead — see `instrumented_leg_skipped` below) |
| `device_offline` | android, parallel, benchmark | 3 | a device is present in `adb devices` but its state is `offline` — reconnect USB or restart adb. Same `parallel` prerequisite and branch coverage as `instrumented_setup_failed` above |
| `device_unauthorized` | android, parallel, benchmark | 3 | a device is present but not authorized for USB debugging — accept the RSA prompt on the device. Same `parallel` prerequisite and branch coverage as `instrumented_setup_failed` above |
| `multiple_adb_devices` | android, parallel, benchmark | 3 | multiple usable adb devices without `--device <serial>` — pass `--device` to eliminate ambiguity. On `parallel` (same `androidInstrumented`-leg prerequisite as above), this can fire for `--clear-data` (≥1 device connected) or the explicit `androidInstrumented` test-type — **never** for `--device <serial>` itself (it validates only the one named device, not the full list) — and **not** for `--test-type all` with no `--device`/`--clear-data`, which instead proceeds without pinning a device (gradle picks its own default) |
| `flavor_unused` | parallel(`androidInstrumented`/`all`) | 2 | `--flavor <name>` supplied but no discovered module declares `productFlavors {}`; orchestrator early-exits before any gradle dispatch |
| `isolated_runtime_race` | parallel | 2 | `--isolated` combined with a test-type that hits a shared runtime resource (`ios` simulator, `androidInstrumented` without `--device`, or `all`) |
| `coverage_threshold_exceeded` | parallel/changed(`--min-missed-lines`), coverage | 1 | aggregated (unfiltered) `coverage.missed_lines` exceeds the threshold. `--min-missed-lines` never removes coverage data — it only decides this gate and narrows the *markdown report's* per-class detail section; `coverage.missed_lines` / `modules_contributing` / `module_buckets` always reflect the complete project even when this error fires |
| `module_coverage_threshold_exceeded` | parallel/changed/coverage(`--min-line-coverage`) | 1 | one or more scored modules have line coverage below the requested percentage. Carries `threshold` and sorted `modules`. Modules without coverage tooling have null values in `coverage.module_results` and are not scored. |
| `coverage_data_unavailable` | parallel/changed(explicit `--coverage-tool` or coverage threshold), coverage | 3 | requested coverage evidence could not be evaluated. Carries `reason`: `no-contributing-data`, `target-not-detected`, `target-no-xml`, `target-parse-error`, `report-dispatch-failed`, `aggregation-failed`, `variant-ambiguous` or `target-no-coverable-lines`. A threshold additionally carries `threshold:number`; an explicit tool without a budget carries `required_by:"explicit-coverage-tool"`. The per-module percentage gate requires one flavor and variant for flavored Android builds. `changed` inherits the coverage/errors/warnings blocks from its parallel delegate. |
| `coverage_budget_without_coverage` | parallel/changed/coverage | 2 | A coverage threshold was combined with `--no-coverage` / `--coverage-tool none` — a usage contradiction caught before any gradle dispatch or XML read |
| `git_error` | changed | 3 | a git command failed — repo unreadable, corrupted, or access denied. `errors[].git_command` carries the invoked subcommand (e.g. `rev-parse --is-inside-work-tree`, `status --porcelain`, `diff --cached --name-only`); `errors[].exit_status` the numeric git exit code; `errors[].stderr_summary` the first 300 chars of stderr with CR/LF collapsed to spaces (omitted when empty). This is a **hard** code — `exit_code` is always 3 |
| `gradle_timeout` | parallel, benchmark | 3 | the gradle spawn process was killed by the `--timeout` deadline (SIGTERM on POSIX; ETIMEDOUT on Windows). **`parallel`** errors carry `module:string`, `task:string`, `timeout_ms:number`. **`benchmark`** errors additionally carry `platform:string` and `log_path:string`. Never retried — a spawn timeout is an infra failure, not a flaky test |
| `task_not_found` | any | 3 | gradle task class missing — usually a plugin not applied to the requested module. Carries `probe_failed:true` when the gradle-tasks probe never recovered real task-graph data for this run (see `gradle_probe_failed` below) — dispatch fell back to statically guessing the task name, so this may be a wrong guess rather than a genuinely missing task. Absent (not `false`) when the probe succeeded normally |
| `unsupported_class_version` | any | 3 | JDK toolchain mismatch — gradle daemon ran on an older JVM than the test classes target |
| `invalid_*` | any | 2 | CLI validation failure (e.g. `invalid_flag_value`, `invalid_regex`) — a value-bearing flag was dangling (no value) or otherwise malformed. Carries `flag` and/or `value` when known |
| `no_project` | describe, any | 3 | no gradle project found at `--project-root` |
| `release_resolve_failed` | update | 3 | `kmp-test update` could not resolve the latest release tag (HEAD redirect + REST API both failed). Carries `probe_errors: [{tier, source, message}]` — per-tier diagnostic (cert / proxy / DNS / rate-limit) |
| `current_version_unresolvable` | update | 3 | `kmp-test update` could not read its own `package.json` to compare versions |
| `install_failed` | update | 3 | `kmp-test update` resolved the release but the install script exited non-zero. Carries `install_command` |
| `clean_failed` | clean | 3 | `kmp-test clean` could not remove one or more targets under `.kmp-test-runner/` (file locks / antivirus contention). The `message` lists the offending paths |

**Soft codes** ride `errors[]` but do **not** affect `exit_code` (they stay at `0`):

| Code | Subcommand | Description |
|---|---|---|
| `no_summary` | any | wrapper output had no recognizable test/build summary line — a parse-gap fallback (e.g. stub scripts in unit tests legitimately exit 0 with this signal) |
| `no_changed_modules` | changed | working tree clean — no changed modules to test; a legitimate exit-0 outcome. **Only emitted when git probing succeeds and the diff is genuinely empty.** Git command failures produce `git_error` (hard, exit 3) instead |

Other codes are reserved for orchestrator-internal use; agents should treat unknown codes as opaque (forward to the user verbatim).

## Warning codes (`warnings[].code`)

Non-fatal signals. They never change the exit code — an agent can branch on them but a run with only warnings is still a success.

| Code | Subcommand | Description |
|---|---|---|
| `instrumented_only_skipped` | parallel, changed | the unit / auto-detect leg skipped a module whose only test surface is instrumented (`androidInstrumentedTest` / `androidTest`). Carries `module`. Run those tests with `--test-type androidInstrumented` (or `kmp-test android`). Suppressed under `--test-type all` (that run already targets the instrumented leg) |
| `gradle_deprecation` | any | gradle exited 1 solely because of Gradle 9+ deprecation warnings while every task passed; the `BUILD FAILED` line is not duplicated to `errors[]` |
| `flavor_defaulted_umbrella` | parallel, changed | a flavored Android module ran without `--flavor`, so dispatch fell back to the flavor-agnostic umbrella task (`:module:test` or `:module:connectedAndroidTest`, which run every flavor), under any test type that dispatches it: the default (auto) test type, `androidUnit`, `androidInstrumented` and `all`. Emitted once per run. Not emitted when `--flavor` is given or when `--variant all` asked for the umbrella. `changed` carries the warning of its parallel delegate. Carries `candidates` (the flavors of every filtered module) and `test_type` |
| `variant_unrecognized` | parallel, changed, android, benchmark | `--variant` (or `--android-variant`) was given a value outside `auto`, `debug`, `release`, `all` (matched case-insensitively). Dispatch is unchanged: the value is treated as `auto`. A flavored build variant such as `demoDebug` is passed as `--flavor <flavor> --variant <buildType>`. Carries `value` (as typed) and `allowed` (`["auto","debug","release","all"]`). Emitted once; `changed` raises it itself and drops the copy of its parallel delegate. A dangling `--variant` is still the `invalid_flag_value` error (exit 2) |
| `no_test_modules_for_leg` | parallel (`all`) | a leg matched no modules, but at least one sibling leg passed — demoted from `no_test_modules` error to a per-leg warning. Carries `test_type` |
| `no_adb_implies_list_only` | android, info | `--no-adb` / `KMP_TEST_SKIP_ADB` set on the instrumented path; dispatch was skipped and the module set emitted as list-only |
| `partial_timeout` | benchmark | at least one module timed out but others passed; graded exit 0 (override with `--strict-timeouts`) |
| `config_invalid_field` | any (runner-backed) | a `.kmp-test-runner.json` / user-global config field failed validation and was dropped. Carries `source: "project_local" \| "user_global"` and the per-field message — previously visible only as a stderr `[WARN]` line, invisible to `--json` consumers |
| `envelope_parse_failed` | parallel, changed, android, benchmark, coverage | the orchestrator's envelope sentinel was present in stdout but its JSON did not parse (truncated/corrupted); results come from the coarser legacy output parser. Carries `reason: "json_parse_failed"` |
| `log_write_failed` | android | a per-module log/logcat/errors artifact could not be written (disk full, read-only dir). Carries `path` — the envelope's `log_file`/`logcat_file`/`errors_file` pointer for that module may be a dead link |
| `junit_xml_oversized` | parallel, changed | a `TEST-*.xml` report exceeded the size cap (default 32 MB; tunable via `KMP_JUNIT_XML_MAX_MB`) and was skipped — `tests.individual_total` undercounts and `test_failures[]` may be incomplete for that task. Carries `module`, `task`, `file`, `size_bytes`, `max_mb` |
| `test_filter_unsupported` | benchmark | `--test-filter` was set and jvm benchmark legs were skipped (kotlinx-benchmark tasks reject gradle's `--tests` and have no CLI filter; running unfiltered would dispatch the full suite the user narrowed). Per-module detail in `skipped[]`. Carries `platform: "jvm"`, `test_filter`, `skipped_modules`. The android leg still filters via `-P` instrumentation args |
| `instrumented_leg_skipped` | parallel(`all`), changed(`all`) | `--test-type all`'s implicit `androidInstrumented` leg (added by `legsForAll` unless `KMP_TEST_SKIP_ADB=1`) was dropped because no usable adb device was found (no device connected, all offline, or all unauthorized) — the leg was never requested explicitly, so this narrows the run instead of failing it; the other legs still dispatch and their own results decide `exit_code`. Carries `reason` (the adb error code that would have fired under an explicit `androidInstrumented` request: `instrumented_setup_failed` \| `device_offline` \| `device_unauthorized`) |
| `clear_data_no_device` | parallel | `--clear-data` was passed with **zero** adb devices connected at all — the `pm clear` hook is skipped, best-effort, and the run proceeds (never an error, regardless of test-type). Distinct from `instrumented_setup_failed`: this fires only when no device is connected *at all*; once at least one device is connected, `--clear-data` falls through to the same strict `instrumented_setup_failed`/`device_offline`/`device_unauthorized`/`multiple_adb_devices` validation as an explicit `--device`-less request |
| `no_coverage_data` | coverage, parallel, changed | no XML coverage data collected from any module — either no plugin is applied or no test run has produced reports yet |
| `coverage_aggregation_skipped` | coverage | `--coverage-tool none` (or the `--no-coverage` alias) disabled the aggregation step |
| `coverage_aggregation_drift` | coverage, parallel | the four `module_buckets` (`with_data` + `no_xml` + `parse_errored` + `skipped_by_user`) didn't sum to `modules_with_kover_plugin.length + modules_with_jacoco_plugin.length` — defensive guard against silent model drops. Carries `detected`, `accounted`, `unaccounted` |
| `coverage_xml_disabled` | coverage, parallel | a jacoco module ran its report but emitted HTML/`.exec` only — no XML (Gradle's default `xml.required=false`). `kmp-test parallel` enables jacoco XML automatically; this fires when `--no-coverage-xml-autofix` was passed (or XML is otherwise absent). Carries `modules` |
| `coverage_parse_failed` | coverage, parallel | a module's coverage XML failed to read or parse (malformed, truncated, or missing content) — the module lands in `module_buckets.parse_errored` and its data is excluded from the aggregate, never silently folded into a bare `no_coverage_data`. Carries `modules` |
| `coverage_xml_oversized` | coverage, parallel | a module's coverage XML exceeded the parser's size cap (default 128 MB; tunable via `KMP_COVERAGE_XML_MAX_MB`) and was skipped — a size-cap-specific subset of `coverage_parse_failed`, discriminated so a legitimately huge report (e.g. a large monorepo's Kover XML) is distinguishable from a malformed one. Carries `modules` |
| `coverage_report_write_failed` | coverage, parallel | the coverage markdown report could not be written to disk (full disk, permissions) — the JSON envelope and its `coverage` data are still valid; only the on-disk `.md` file failed. Message carries the short fs error code (e.g. `ENOSPC`/`EACCES`) only, never a resolved path |
| `coverage_xml_stale` | parallel, changed | an XML file predates this run and is excluded from totals; the module lands in `module_buckets.no_xml` and has `status:"stale_xml"` in `coverage.module_results`. Standalone `coverage` intentionally reads saved reports. |
| `gradle_config_applied` | parallel (envelope payload, not a `warnings[]` entry) | the project's `gradle.properties` had `org.gradle.parallel=false`, so the CLI dropped its own `--parallel` injection to respect user intent. Surfaces as a top-level `gradle_config_applied: { parallel_dropped: bool }` field |
| `gradle_probe_failed` | parallel, coverage, android, benchmark, describe | the `gradlew tasks --all --quiet` probe that resolves real per-module task names didn't succeed cleanly on the first try. The probe retries exactly once on `exit_nonzero` or `empty_output` (never on `timeout` or `spawn_error`); this warning fires whenever that first attempt failed, including when the retry then succeeded. Carries `reason` (`timeout` \| `exit_nonzero` \| `empty_output` \| `spawn_error`), `exit_code` (number or null), `attempts`, `recovered` (`true` when the retry succeeded and task names came from real probe data; `false` when every attempt failed and dispatch fell back to static guessing), and `message` (a short summary plus a bounded, de-duplicated stderr excerpt — capped at 2 KB — covering the probe's own "What went wrong" line, any `cannot be cast`/`Exception` line, and the last 10 lines of stderr). Never affects `exit_code`. When `recovered:false`, any `task_not_found` entry in `errors[]` this run also carries `probe_failed:true` |

Other codes are reserved for orchestrator-internal use; agents should treat unknown codes as opaque (forward to the user verbatim).

## Per-leg shape (`parallel.legs[]`)

```jsonc
{
  "test_type": "androidUnit",
  "exit_code": 0,
  "execution": {
    "fresh": 0,            // task ran, output produced
    "up_to_date": 0,       // gradle skipped — inputs match cache
    "from_cache": 0,       // gradle replayed cached output
    "no_source": 0,        // task has no source set to operate on
    "skipped_by_gradle": 0,
    "failed": 0,           // task ran, exited non-zero
    "no_evidence": 0       // gradle never mentioned this task (eval-phase abort)
  },
  "cascade_detected": false,  // true when no_evidence > 0 AND failed === 0 (build aborted before reaching this leg)
  "retry_fired": false        // true when the orchestrator's per-module retry path executed for this leg
}
```

## Breaking changes

### Version 2 (`v0.9.0`)

- **`no_test_modules`** — exit-code semantics split. Empty match downstream of a user filter is now `CONFIG_ERROR` (2); empty match against a project that genuinely has no test modules stays `ENV_ERROR` (3). New `errors[].caused_by_filter:bool` field discriminates.
- **`flavor_unused`** — promoted from `warnings[]` to `errors[]`, mapped to `CONFIG_ERROR` (2). Pre-v0.9 the misconfiguration was a soft warning + exit 0 that CI gates routinely missed.
- **`isolated_runtime_race`** — new error code. Returned with `CONFIG_ERROR` (2) when `--isolated` is combined with a test-type that hits a shared runtime resource (iOS simulator, ADB without `--device`, or `--test-type all` which expands to include those).
- **`module_failed`** — gains `errors[].setup_failed:bool`. `true` when the task failed AND no JUnit XML evidence exists (compile-time / setup-time failure). Discriminates from "tests ran and one failed".

Additive changes (do **not** bump `schema_version`):

- `doctor` / `info` envelope unified with other subcommands (added empty-default `tests`/`modules`/`skipped`/`coverage`/`errors`/`warnings`).
- `--list-only` short-circuit on `parallel` (mirrors `android`'s shape; emits the discovered module set without gradle dispatch).
- `parallel.legs[]` always populated (was conditionally absent in some early-exit paths pre-v0.9).
- `android.device_serial` populated on `parallel --test-type androidInstrumented` even without `--device` (best-effort adb probe).
- `coverage_data_unavailable` (`ENV_ERROR`, 3) / `coverage_budget_without_coverage` (`CONFIG_ERROR`, 2) — new error codes closing a fail-open gap: a positive `--min-missed-lines` budget could previously exit 0 when zero modules contributed data, a target module lacked fresh/parseable XML, report generation failed, or aggregation threw. Both dispatch through the same `classifyExitCode` every other orchestrator error already uses; threshold 0 (the default) is unaffected.
