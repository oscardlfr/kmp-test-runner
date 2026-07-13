# `--json` envelope contract

Stable from `v0.9.0`. Bumped via `schema_version` on breaking change.

## Top-level shape

Every subcommand emits the same canonical envelope on `--json`. Subcommand-specific blocks (`parallel`, `android`, `benchmark`, `changed`, `doctor`, `info`, `describe`, `clean`) are added at the top level when relevant.

```jsonc
{
  "tool": "kmp-test",
  "schema_version": 2,
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
    "individual_total": 0          // testcase-level (parallel only — derived from JUnit XML)
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
    "missed_lines": null,
    "modules_with_kover_plugin": [],
    "modules_with_jacoco_plugin": [],
    "module_buckets": {            // per-module accounting; sum must equal detected-plugin count
      "with_data": [],             // XML parsed, rows added to aggregation
      "no_xml": [],                // XML missing on disk (the common silent-drop case)
      "parse_errored": [],         // Python parser exited non-zero
      "skipped_by_user": []        // filtered by --exclude-coverage / --coverage-modules
    }
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
| `no_test_modules` | parallel, changed | 2 \| 3 | no modules match the leg's test-type or `--module-filter`. `errors[].caused_by_filter:true` → CONFIG_ERROR (user filter mismatch); `:false` → ENV_ERROR (project genuinely empty) |
| `module_failed` | parallel, android | 1 | a gradle task failed. `errors[].setup_failed:true` when no JUnit XML evidence exists (compile-time / runner-setup failure) — discriminates from "tests ran and one failed". On `kmp-test android --capture-on-fail` or `parallel --test-type androidInstrumented --capture-on-fail`, the entry additionally carries `screenshot_file` / `ui_hierarchy_file` (device captures) and `capture_error` when adb couldn't oblige |
| `spawn_error` | any | 1 \| 3 | a child process errored at the spawn layer and never ran to completion (e.g. `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` when output exceeds `KMP_GRADLE_MAXBUFFER_MB`, default 64 MB). Orchestrator-level (gradle child; android/benchmark, exit 1): `errors[].errno` carries the Node error code — discriminates from `module_failed` ("gradle ran, tests failed"). Dispatcher-level (the wrapper itself failed to spawn; exit 3): env-error envelope, sibling of `missing_shell` |
| `instrumented_setup_failed` | android, parallel(`androidInstrumented`), benchmark | 3 | adb has no devices when one was required (`--device <serial>` mismatch, or implicit need) |
| `device_offline` | android, parallel(`androidInstrumented`), benchmark | 3 | a device is present in `adb devices` but its state is `offline` — reconnect USB or restart adb |
| `device_unauthorized` | android, parallel(`androidInstrumented`), benchmark | 3 | a device is present but not authorized for USB debugging — accept the RSA prompt on the device |
| `multiple_adb_devices` | android, parallel(`androidInstrumented`), benchmark | 3 | multiple usable adb devices without `--device <serial>` — pass `--device` to eliminate ambiguity |
| `flavor_unused` | parallel(`androidInstrumented`/`all`) | 2 | `--flavor <name>` supplied but no discovered module declares `productFlavors {}`; orchestrator early-exits before any gradle dispatch |
| `isolated_runtime_race` | parallel | 2 | `--isolated` combined with a test-type that hits a shared runtime resource (`ios` simulator, `androidInstrumented` without `--device`, or `all`) |
| `coverage_threshold_exceeded` | parallel(`--min-missed-lines`), coverage | 1 | aggregated `coverage.missed_lines` exceeds the threshold |
| `git_error` | changed | 3 | a git command failed — repo unreadable, corrupted, or access denied. `errors[].git_command` carries the invoked subcommand (e.g. `rev-parse --is-inside-work-tree`, `status --porcelain`, `diff --cached --name-only`); `errors[].exit_status` the numeric git exit code; `errors[].stderr_summary` the first 300 chars of stderr with CR/LF collapsed to spaces (omitted when empty). This is a **hard** code — `exit_code` is always 3 |
| `task_not_found` | any | 3 | gradle task class missing — usually a plugin not applied to the requested module |
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
| `flavor_defaulted_umbrella` | parallel (`androidUnit`/`androidInstrumented`) | a flavored project ran without `--flavor`; dispatch fell back to the flavor-agnostic umbrella task (runs every flavor). Carries `candidates` |
| `no_test_modules_for_leg` | parallel (`all`) | a leg matched no modules, but at least one sibling leg passed — demoted from `no_test_modules` error to a per-leg warning. Carries `test_type` |
| `no_adb_implies_list_only` | android, info | `--no-adb` / `KMP_TEST_SKIP_ADB` set on the instrumented path; dispatch was skipped and the module set emitted as list-only |
| `partial_timeout` | benchmark | at least one module timed out but others passed; graded exit 0 (override with `--strict-timeouts`) |
| `config_invalid_field` | any (runner-backed) | a `.kmp-test-runner.json` / user-global config field failed validation and was dropped. Carries `source: "project_local" \| "user_global"` and the per-field message — previously visible only as a stderr `[WARN]` line, invisible to `--json` consumers |
| `envelope_parse_failed` | parallel, changed, android, benchmark, coverage | the orchestrator's envelope sentinel was present in stdout but its JSON did not parse (truncated/corrupted); results come from the coarser legacy output parser. Carries `reason: "json_parse_failed"` |
| `log_write_failed` | android | a per-module log/logcat/errors artifact could not be written (disk full, read-only dir). Carries `path` — the envelope's `log_file`/`logcat_file`/`errors_file` pointer for that module may be a dead link |
| `junit_xml_oversized` | parallel, changed | a `TEST-*.xml` report exceeded the size cap (default 32 MB; tunable via `KMP_JUNIT_XML_MAX_MB`) and was skipped — `tests.individual_total` undercounts and `test_failures[]` may be incomplete for that task. Carries `module`, `task`, `file`, `size_bytes`, `max_mb` |
| `test_filter_unsupported` | benchmark | `--test-filter` was set and jvm benchmark legs were skipped (kotlinx-benchmark tasks reject gradle's `--tests` and have no CLI filter; running unfiltered would dispatch the full suite the user narrowed). Per-module detail in `skipped[]`. Carries `platform: "jvm"`, `test_filter`, `skipped_modules`. The android leg still filters via `-P` instrumentation args |
| `no_coverage_data` | coverage, parallel | no XML coverage data collected from any module — either no plugin is applied or no test run has produced reports yet |
| `coverage_aggregation_skipped` | coverage | `--coverage-tool none` (or the `--no-coverage` alias) disabled the aggregation step |
| `coverage_aggregation_drift` | coverage, parallel | the four `module_buckets` (`with_data` + `no_xml` + `parse_errored` + `skipped_by_user`) didn't sum to `modules_with_kover_plugin.length + modules_with_jacoco_plugin.length` — defensive guard against silent model drops. Carries `detected`, `accounted`, `unaccounted` |
| `coverage_xml_disabled` | coverage, parallel | a jacoco module ran its report but emitted HTML/`.exec` only — no XML (Gradle's default `xml.required=false`). `kmp-test parallel` enables jacoco XML automatically; this fires when `--no-coverage-xml-autofix` was passed (or XML is otherwise absent). Carries `modules` |
| `gradle_config_applied` | parallel (envelope payload, not a `warnings[]` entry) | the project's `gradle.properties` had `org.gradle.parallel=false`, so the CLI dropped its own `--parallel` injection to respect user intent. Surfaces as a top-level `gradle_config_applied: { parallel_dropped: bool }` field |

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
