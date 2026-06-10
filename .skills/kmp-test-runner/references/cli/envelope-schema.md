# Envelope schema reference (`schema_version: 2`)

The `kmp-test` CLI emits a JSON envelope to stdout when invoked with `--json`. The shape is stable within a major schema version; breaking changes bump `schema_version`. **This file is a curated agent-facing extract.** The canonical source of truth lives at [`docs/envelope-contract.md`](https://github.com/oscardlfr/kmp-test-runner/blob/main/docs/envelope-contract.md) in the source repo.

## Top-level fields (all subcommands)

| Field | Type | Notes |
|-------|------|-------|
| `tool` | string | Always `"kmp-test"`. Discriminator for nested-tool scenarios. |
| `schema_version` | number | Currently `2`. Bumped only on breaking shape changes (additive fields don't bump). |
| `subcommand` | string | One of: `parallel`, `changed`, `android`, `benchmark`, `coverage`, `doctor`, `info`, `describe`, `clean`, `update`. |
| `version` | string | kmp-test CLI version (matches `package.json`). |
| `project_root` | string | Absolute path to the gradle project root. |
| `exit_code` | number | `0` SUCCESS / `1` TEST_FAIL / `2` CONFIG_ERROR / `3` ENV_ERROR. See [`exit-codes.md`](exit-codes.md). |
| `duration_ms` | number | Wall-clock duration of the run. |
| `tests` | object | `{ total, passed, failed, skipped, individual_total? }` — see [`tests` shape](#tests-shape). |
| `modules` | array | Per-module results — see [`modules[]` shape](#modules-shape). |
| `skipped` | array | `[{ module, reason }]` — modules the dispatcher legitimately skipped. |
| `coverage` | object | `{ tool, missed_lines, modules_with_kover_plugin, modules_with_jacoco_plugin }`. |
| `errors` | array | `[{ message, code?, ...extra }]` — see [error-codes table](#errors-discriminated-codes). |
| `warnings` | array | Soft signals — never affect `exit_code`. |
| `isolated` | object | `{ enabled, cache_dir, kept, locked }` — present when `--isolated` was passed (omitted by `coverage` orchestrator since it never spawns gradle). |

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
{ "total": 42, "passed": 40, "failed": 1, "skipped": 1, "individual_total": 58 }
```

- `total` / `passed` / `failed` / `skipped` — module-level counts (count of dispatched gradle tasks for `parallel`).
- `individual_total` — testcase-level count derived from JUnit XML. Populated by `parallel` only; omitted for other subcommands.

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

> Compile-time / setup-time failures (e.g. unresolved imports, missing test dependencies) produce **no** JUnit XML and therefore no `test_failures[]` entries. Detect these via the `module_failed` error with `setup_failed:true` (see error-codes table).

## `errors[]` discriminated codes

Branch on `errors[].code` before reading `message` (the message is human-readable and not stable across versions).

| Code | Subcommand | `exit_code` | Description | Extra fields |
|------|-----------|-------------|-------------|--------------|
| `lock_held` | any | 3 | Another `kmp-test` process holds the project lock. Pass `--force` to bypass when safe. | — |
| `no_gradlew` | any | 3 | No `gradlew` / `gradlew.bat` in `--project-root`. | — |
| `missing_shell` | any | 3 | `pwsh`/`powershell` (Windows) or `bash` (Unix) not on `PATH`. | — |
| `no_test_modules` | parallel, changed | **2 \| 3** | No modules match the leg's test-type or `--module-filter`. | `caused_by_filter:bool` (`true` → 2, `false` → 3) |
| `module_failed` | parallel, android | 1 | A gradle task failed. | `setup_failed:bool`, `module:string`; on `kmp-test android --capture-on-fail` or `parallel --test-type androidInstrumented --capture-on-fail`: `screenshot_file?:string`, `ui_hierarchy_file?:string`, `capture_error?:string` |
| `spawn_error` | any | **1 \| 3** | A child process errored at the spawn layer (e.g. output exceeded `KMP_GRADLE_MAXBUFFER_MB`, default 64 MB). Orchestrator-level gradle child → exit 1; dispatcher-level wrapper spawn failure → exit 3 (env-error envelope, sibling of `missing_shell`). | orchestrator-level: `errno:string` (Node error code), `module:string` |
| `instrumented_setup_failed` | android, parallel (`androidInstrumented`), benchmark | 3 | adb has no devices when one was required (or `--device <serial>` mismatch). | — |
| `flavor_unused` | parallel (`androidUnit`/`androidInstrumented`/`all`) | 2 | `--flavor <name>` passed but no module on the leg is flavored (static `productFlavors {}` or probe-recovered). | — |
| `isolated_runtime_race` | parallel | 2 | `--isolated` combined with a test-type that hits a shared runtime resource (iOS sim, ADB without `--device`, `--test-type all`). | — |
| `coverage_threshold_exceeded` | parallel (`--min-missed-lines`), coverage | 1 | Aggregated `coverage.missed_lines` exceeds the threshold. | — |
| `task_not_found` | any | 3 | Gradle task class missing — typically a plugin not applied to the requested module. | — |
| `unsupported_class_version` | any | 3 | JDK toolchain mismatch — gradle daemon ran on an older JVM than the test classes target. | — |
| `invalid_*` | any | 2 | CLI validation failure (e.g. `invalid_flag_value`, `invalid_regex`). | `flag?`, `value?` |
| `no_project` | any | 3 | No gradle project found at `--project-root`. | — |
| `release_resolve_failed` | update | 3 | `kmp-test update` could not resolve the latest release tag (HEAD redirect + REST API both failed). | `probe_errors: [{tier, source, message}]` — per-tier diagnostic (cert / proxy / DNS / rate-limit error message) |
| `current_version_unresolvable` | update | 3 | `kmp-test update` could not read its own `package.json` to compare versions. | — |
| `install_failed` | update | 3 | `kmp-test update` resolved the release but the install script exited non-zero. | `install_command: string` |
| `clean_failed` | clean | 3 | `kmp-test clean` could not remove one or more targets under `.kmp-test-runner/` (file locks / antivirus contention). | `message` lists the offending paths |

**Soft codes** (do **not** affect `exit_code` and do **not** trigger WS-5 promotion):

| Code | Subcommand | Description |
|------|-----------|-------------|
| `no_summary` | any | Wrapper output had no recognizable summary line. Parse-gap fallback — stub scripts in unit tests legitimately exit 0 with this signal. |
| `no_changed_modules` | changed | Working tree clean — no changed modules to test. Legitimate exit-0 outcome with structured signal. |

> Other discriminated codes may be reserved for orchestrator-internal use; agents should treat unrecognized codes as **opaque** and forward `message` to the user verbatim.

## `warnings[]` discriminated codes

`warnings[]` carries non-fatal signals that don't affect `exit_code`. Agents can switch on `warnings[].code` to surface advisory information.

| Code | Subcommand | Description | Extra fields |
|------|-----------|-------------|--------------|
| `no_coverage_data` | coverage, parallel | No XML coverage data collected from any module — either no plugin is applied or no test run has produced reports yet. | — |
| `coverage_aggregation_skipped` | coverage | `--coverage-tool none` (or the `--no-coverage` alias) disabled the aggregation step. | — |
| `coverage_aggregation_drift` | coverage, parallel | The four `module_buckets` (`with_data` + `no_xml` + `parse_errored` + `skipped_by_user`) didn't sum to `modules_with_kover_plugin.length + modules_with_jacoco_plugin.length`. Defensive guard against silent model drops. | `detected:int`, `accounted:int`, `unaccounted:int` |
| `coverage_xml_disabled` | coverage, parallel | A jacoco module ran its report but emitted HTML/`.exec` only — no XML (Gradle's default `xml.required=false`). `kmp-test parallel` enables jacoco XML automatically; this fires when `--no-coverage-xml-autofix` was passed (or XML is otherwise absent). The module is also in `module_buckets.no_xml`. | `modules:string[]` |
| `partial_timeout` | benchmark | At least one benchmark module timed out but at least one other passed. Exit code stays at `0` (graded). Pass `--strict-timeouts` to restore pre-graded hard-fail behavior. | `timed_out:int`, `passed:int` |
| `flavor_defaulted_umbrella` | parallel (`androidUnit`/`androidInstrumented`/`all`) | Project is flavored and no `--flavor` was supplied, so the leg dispatched the flavor-agnostic umbrella task (`:module:test` / `:module:connectedAndroidTest`, which run every flavor — slower). Pass `--flavor <name>` to target one. | `candidates:string[]`, `test_type:string` |
| `gradle_config_applied` | parallel (envelope payload, not `warnings[]` entry) | Project's `gradle.properties` had `org.gradle.parallel=false` so the CLI dropped its own `--parallel` injection to respect user intent. | `parallel_dropped:bool` (on the top-level `gradle_config_applied:{}` field) |
| `config_invalid_field` | any (runner-backed) | A `.kmp-test-runner.json` / user-global config field failed validation and was dropped — previously visible only as a stderr `[WARN]` line, invisible to `--json` consumers. | `source: "project_local" \| "user_global"` |
| `envelope_parse_failed` | parallel, changed, android, benchmark, coverage | The orchestrator's envelope sentinel was present in stdout but its JSON did not parse (truncated/corrupted); results come from the coarser legacy output parser. | `reason: "json_parse_failed"` |
| `log_write_failed` | android | A per-module log/logcat/errors artifact could not be written (disk full, read-only dir) — that module's `log_file`/`logcat_file`/`errors_file` pointer may be a dead link. | `path:string` |
| `junit_xml_oversized` | parallel, changed | A `TEST-*.xml` report exceeded the size cap (default 32 MB; tunable via `KMP_JUNIT_XML_MAX_MB`) and was skipped — `tests.individual_total` undercounts and that task's `test_failures[]` may be incomplete. | `module:string`, `task:string`, `file:string`, `size_bytes:int`, `max_mb:int` |
| `test_filter_unsupported` | benchmark | `--test-filter` was set, so jvm benchmark legs were skipped: kotlinx-benchmark tasks reject gradle's `--tests` and have no CLI filter — running unfiltered would dispatch the full suite the user narrowed. Per-module detail in `skipped[]`; the android leg still filters via `-P` instrumentation args. Narrow jvm runs with `--module-filter` or the build-script `benchmark { configurations { include(...) } }` DSL. | `platform:"jvm"`, `test_filter:string`, `skipped_modules:int` |
| `instrumented_only_skipped` | parallel, changed | The unit / auto-detect leg skipped a module whose only test surface is instrumented (`androidInstrumentedTest` / `androidTest`). Run those tests with `--test-type androidInstrumented` (or `kmp-test android`). Suppressed under `--test-type all` (that run already targets the instrumented leg). | `module:string` |
| `gradle_deprecation` | any | gradle exited 1 solely because of Gradle 9+ deprecation warnings while every task passed; the `BUILD FAILED` line is not duplicated to `errors[]`. | — |
| `no_test_modules_for_leg` | parallel (`all`) | a leg matched no modules, but at least one sibling leg passed — demoted from the `no_test_modules` error to a per-leg warning. | `test_type:string` |
| `no_adb_implies_list_only` | android, info | `--no-adb` / `KMP_TEST_SKIP_ADB` was set on the instrumented path; dispatch was skipped and the module set emitted as list-only. | — |

> Like errors, future warning codes can land additively without bumping `schema_version`. Treat unrecognized codes as opaque.

## WS-5 invariant

If `errors[]` contains any HARD-coded entry, the `exit_code` MUST be non-zero. The CLI auto-promotes `0 → 1 (TEST_FAIL)` when this invariant would otherwise be violated. Soft codes (`no_summary`, `no_changed_modules`) do NOT trigger promotion.

This guarantee was introduced post-v0.7.x. Before it, agents reading `errors.length > 0` while the process exited 0 received false positives on "passing" runs.

This lets agents safely read **either** `errors.length > 0` **or** `exit_code !== 0` and get consistent semantics. (Reading both is even safer.)

## `coverage` shape

```json
{
  "tool": "auto",
  "missed_lines": null,
  "modules_with_kover_plugin": [":core:network", ":feature:auth"],
  "modules_with_jacoco_plugin": [],
  "module_buckets": {
    "with_data": [":core:network"],
    "no_xml": [":feature:auth"],
    "parse_errored": [],
    "skipped_by_user": []
  }
}
```

- `tool` — `"auto"` / `"kover"` / `"jacoco"` / `"none"`.
- `missed_lines` — aggregated count or `null` when coverage couldn't be aggregated.
- `modules_with_kover_plugin` / `modules_with_jacoco_plugin` — per-module surface so agents see which coverage flavor each module declares.
- `module_buckets` — per-module accounting on a successful `coverage` / `parallel` run. Each module with a detected coverage plugin lands in exactly one bucket: `with_data` (XML parsed + rows added to aggregation), `no_xml` (XML missing on disk — the most common silent-drop case in CI), `parse_errored` (Python parser exited non-zero), or `skipped_by_user` (filtered out by `--exclude-coverage` / `--coverage-modules`). The sum of the four buckets should equal `modules_with_kover_plugin.length + modules_with_jacoco_plugin.length`; when it doesn't, a `coverage_aggregation_drift` entry is pushed to `warnings[]` with `{detected, accounted, unaccounted}` counts. Buckets are empty on `--dry-run` and `--coverage-tool none` for shape parity.

## `parallel.legs[]` shape

Emitted on the `parallel` subcommand. Each leg corresponds to a test-type (e.g. `androidUnit`, `jvmTest`, `desktopTest`, `androidInstrumented`).

```json
{
  "test_type": "androidUnit",
  "exit_code": 0,
  "execution": {
    "fresh": 0,
    "up_to_date": 0,
    "from_cache": 0,
    "no_source": 0,
    "skipped_by_gradle": 0,
    "failed": 0,
    "no_evidence": 0
  },
  "cascade_detected": false,
  "retry_fired": false
}
```

- `execution.*` — per-task disposition counts.
- `cascade_detected` — `true` when `no_evidence > 0` AND `failed === 0` (build aborted before reaching this leg).
- `retry_fired` — `true` when the orchestrator's per-module retry path executed for this leg.

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
| Schema version | `schema_version: 2` (versioned breaking-change policy) | (none in output) |
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

`android info` is a quick SDK-location probe; `kmp-test doctor` is a full test-orchestration readiness check with discriminated diagnostics. Do **not** `JSON.parse(android info)` — it's plain text. For programmatic SDK lookup on the same machine, prefer `kmp-test doctor --json | jq '.checks[] | select(.name=="Android SDK") | .value'`.

### When to pick which tool

- **`kmp-test` (default for this skill)** — cross-platform, stable schema, discriminated error/warning codes, no side effects on `--dry-run`.
- **`android` CLI** — quick SDK probe (`android info | grep sdk`), emulator/screen/UI workflows (`android emulator`, `android screen capture`, `android layout`), or build-artifact enumeration on POSIX hosts (`android describe` writes per-target JSON files).

### Platform caveat (`android describe` 0.7.15)

At `android` CLI version `0.7.15222914`, `android describe` invokes the POSIX `gradlew` shell script on Windows instead of `gradlew.bat`, crashing with `CreateProcess error=193, %1 no es una aplicación Win32 válida`. **Avoid `android describe` on Windows hosts** until upstream fixes; use `kmp-test parallel --dry-run --json` for cross-platform module enumeration. No `--gradlew` override flag exists in `android describe` at this version.

## See also

- [`exit-codes.md`](exit-codes.md) — exit-code semantics + WS-5 invariant in detail
- [`flags-reference.md`](flags-reference.md) — CLI flag reference (placeholder; full table in a follow-up release)
- [`docs/envelope-contract.md`](https://github.com/oscardlfr/kmp-test-runner/blob/main/docs/envelope-contract.md) — canonical source of truth in the kmp-test-runner repo
