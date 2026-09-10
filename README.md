# kmp-test-runner

Parallel test runner for Kotlin Multiplatform and Android Gradle projects. It discovers the
relevant tasks, runs compatible modules concurrently, aggregates test and coverage results, and
can return a single-line JSON envelope designed for coding agents and CI.

- npm CLI: `kmp-test-runner`
- Gradle plugin: `io.github.oscardlfr.kmp-test-runner`
- Platforms: Windows, macOS, and Linux; Apple targets execute on macOS
- Coverage: Kover and JaCoCo
- License: MIT

## Why it exists

A KMP repository can mix JVM, Android, Apple, JavaScript, and Wasm targets, each with different
Gradle tasks and reports. A caller otherwise has to discover the right tasks, run them, inspect
JUnit and coverage files, and interpret large build logs. `kmp-test` keeps Gradle as the execution
engine but provides one test-focused interface over that work.

For AI coding agents, this also reduces the output that must be placed in context. The measurement
method compares raw Gradle plus generated reports (A), the human `kmp-test` summary (B), and the
JSON envelope (C).

| Measurement | Public capture | Raw Gradle tokens | JSON tokens | Same-capture reduction |
| --- | --- | ---: | ---: | ---: |
| `parallel`, large project | NowInAndroid, 36 modules, May 2026 | 226,291 | 1,839 | 123.1x |
| `parallel`, large-project validation | NowInAndroid, July 2026 | 234,046–235,097 | 2,013–2,015 | 116.3x–116.7x |

These are independent measurements of the same public project using `cl100k_base`, not a universal
speed or cost guarantee. They support an observed output reduction of approximately **116x–123x**
for this large-project sample. Earlier small- and medium-project figures are retained in the
measurement record but are not used as current headlines until the complete public matrix is
repeated.

A historical coverage stress capture measured 28,754,177 raw tokens from roughly 74 MB of Kover
reports versus 734 JSON tokens: 39,175x. That arithmetic is valid within one anonymized configured
composite, but the result is a report-volume ceiling, not a typical-project estimate.

See [Metrics and measurement](docs/metrics.md) for provenance and publication rules, and
[Token-cost measurement](docs/token-cost-measurement.md) for the full method and reproduction
tooling.

## What you get

- Per-module task discovery for JVM/Desktop, Android unit and instrumented tests, iOS, macOS,
  JavaScript, and Wasm.
- Parallel execution with module filtering, changed-module selection, timeouts, Android retry, and
  post-failure device capture.
- Kover and JaCoCo report discovery and aggregation, including heterogeneous projects where only
  some modules publish coverage.
- Stable exit classes and a versioned JSON envelope for automation.
- Project-scoped locking and opt-in isolated Gradle cache directories for concurrent callers.
- JDK requirement detection, installed-JDK discovery, and explicit JDK overrides.
- npm, release-archive, Gradle-plugin, and reusable Agent Skill distribution shapes.

## Installation

### Requirements

- Node.js 18 or newer.
- Bash on Linux/macOS, or PowerShell 5.1 or newer on Windows.
- A Gradle wrapper in the target project.
- A JDK compatible with that project's Gradle, AGP, and Kotlin versions.
- Gradle 7.6 or newer when using the Gradle plugin.
- Android SDK plus a usable device/emulator for instrumented tests.
- Xcode and a suitable simulator/host for iOS and macOS tests.

After installing, run `kmp-test doctor --project-root <project>` to inspect the host without running
tests.

### npm

```sh
npm install -g kmp-test-runner
kmp-test --version
```

For CI, prefer a pinned version such as `npx kmp-test-runner@0.14.0 ...` instead of `@latest`.

### Release installer

Linux and macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/oscardlfr/kmp-test-runner/main/scripts/install.sh | bash
```

Windows PowerShell:

```powershell
iwr -useb https://raw.githubusercontent.com/oscardlfr/kmp-test-runner/main/scripts/install.ps1 | iex
```

Remote installs verify the SHA-256 checksum published with the GitHub Release before extraction.
Failed upgrades restore the previous installation.

For an offline installation from a checked-out repository:

```sh
bash scripts/install.sh \
  --archive kmp-test-runner-0.14.0-linux.tar.gz \
  --archive-sha256 kmp-test-runner-0.14.0-linux.tar.gz.sha256
```

```powershell
.\scripts\install.ps1 `
  -LocalArchive kmp-test-runner-0.14.0-windows.zip `
  -LocalArchiveSha256 kmp-test-runner-0.14.0-windows.zip.sha256
```

Detailed prefix, rollback, proxy/TLS, update, and uninstall instructions are in
[Installation and upgrades](docs/installation.md).

### Gradle plugin

The plugin is published to GitHub Packages, so consumers must add that repository and provide a
GitHub token with `read:packages`. Maven Central distribution is not currently available. See the
[Gradle plugin guide](docs/gradle-plugin.md) or the complete example below.

## Quick start

Run from a Gradle project root:

```sh
kmp-test doctor
kmp-test parallel
```

Or target another directory:

```sh
kmp-test parallel --project-root /path/to/project
```

For agents and scripts, add `--json`:

```sh
kmp-test parallel --json
```

Add the managed output directory to the consumer project's `.gitignore`:

```gitignore
.kmp-test-runner/
```

## Choose the test surface

| Tests to run | Command | Execution environment |
| --- | --- | --- |
| Host-side JVM, Desktop, or Android unit tests | `kmp-test parallel` | Host JVM; unit leg is auto-detected |
| Explicit JVM/Desktop | `kmp-test parallel --test-type jvm` or `desktop` | Host JVM |
| Explicit Android unit tests | `kmp-test parallel --test-type androidUnit` | Host JVM |
| Android instrumented or Compose UI tests | `kmp-test android` | Connected device or emulator |
| Android instrumented tests through the parallel orchestrator | `kmp-test parallel --test-type androidInstrumented` | Connected device or emulator; this leg does not generate coverage XML |
| iOS | `kmp-test parallel --test-type ios` | macOS with Xcode/simulator or device target |
| macOS | `kmp-test parallel --test-type macos` | macOS host |
| JavaScript | `kmp-test parallel --test-type js` | Host Node environment |
| Wasm | `kmp-test parallel --test-type wasm` | Host toolchain/browser environment required by the project |
| Host/common + Desktop + Android unit/instrumented, plus Apple on macOS | `kmp-test parallel --test-type all` | Does not include JS or Wasm; set `KMP_TEST_SKIP_ADB=1` to omit the instrumented leg |

When `--test-type` is omitted, the runner selects the unit leg. A module containing only
`androidInstrumentedTest`/`androidTest` sources is therefore skipped with
`warnings[].code: "instrumented_only_skipped"`; run it with `kmp-test android` or the explicit
instrumented test type.

For Apple targets, task choice is per module. The iOS preference is
`iosSimulatorArm64Test → iosX64Test → iosArm64Test → iosTest`; macOS uses
`macosArm64Test → macosX64Test → macosTest`.

## Commands

| Command | Purpose |
| --- | --- |
| `parallel` | Discover and run compatible test tasks, then aggregate coverage |
| `changed` | Run tests for modules affected by current Git changes |
| `android` | Run Android instrumented tests on a device/emulator |
| `benchmark` | Run Android or JVM benchmark suites |
| `coverage` | Discover coverage metadata and aggregate existing XML without running tests or report tasks |
| `doctor` | Diagnose Node, shell, Gradle wrapper, JDK, Android SDK, and ADB |
| `info` | Return environment and project configuration without PASS/WARN judgments |
| `describe` | Return the project model: modules, tasks, platforms, coverage, dependencies |
| `update` | Update a release-installer installation |
| `clean` | Remove runner-owned logs, caches, temporary files, and optionally reports |

Each command has focused help. The exhaustive option matrix is in the
[CLI reference](docs/cli-reference.md).

```sh
kmp-test parallel --help
kmp-test android --help
kmp-test benchmark --help
kmp-test coverage --help
```

## Common workflows

### Filter modules or tests

```sh
# Comma-separated module globs
kmp-test parallel --module-filter ":core:*,feature-*"

# JVM class or method through Gradle --tests
kmp-test parallel --test-filter "com.example.FooServiceTest.shouldSave"

# Android class/method through AndroidJUnitRunner
kmp-test android --test-filter "*WidgetTest*#rendersEmptyState"

# Preview the module set without Gradle dispatch
kmp-test parallel --module-filter "feature-*" --list-only --json
```

Android benchmark filtering is supported. The current JVM `kotlinx-benchmark` path does not support
`--test-filter`; those legs are skipped with `test_filter_unsupported` instead of pretending the
filter was applied.

### Run only changed modules

```sh
kmp-test changed
kmp-test changed --staged-only
kmp-test changed --show-modules-only --json
```

### Inspect the project model

`describe` returns discovered modules, platforms, resolved test tasks, dependencies, flavors, and
coverage metadata without running tests. Its `--module-filter` deliberately accepts a JavaScript
regular expression, unlike the glob syntax used by test-dispatch commands:

```sh
kmp-test describe --json --module-filter "^:sample-result$"
```

`parallel`, `android`, and `benchmark` accept module globs. `changed` derives its module set from
Git state and does not accept `--module-filter`.

### Android retry and failure capture

```sh
kmp-test android --device emulator-5554 --auto-retry --capture-on-fail --json
```

`--capture-on-fail` writes a best-effort screenshot and UI-hierarchy dump after the final failed
attempt. These are post-hoc forensic artifacts: useful for crashes, ANRs, and persistent bad state,
but not guaranteed to reproduce the exact assertion frame. Capture failure never changes the test
exit code.

### Clean local artifacts

```sh
kmp-test clean --dry-run
kmp-test clean
kmp-test clean --all --json
```

The default removes run artifacts while preserving the model/task cache and reports. `--all` also
purges those managed caches and reports; project sources and `.kmp-test-runner.json` are untouched.

## Coverage

`parallel` executes eligible host-side test legs and their resolved coverage report tasks before
aggregation. Android instrumented, iOS, macOS, JS, and Wasm legs do not generate coverage through
this workflow; an instrumented-only invocation can at most aggregate XML that was already present.

`coverage` never runs tests or coverage report tasks. It reads existing XML, but on an uncached
project it may call `gradlew tasks --all --quiet` to discover modules and coverage metadata before
that read. This configuration probe can resolve plugins and update Gradle's normal local caches.

| `--coverage-tool` | Behavior |
| --- | --- |
| `auto` | Probe each module's Gradle task graph and select Kover or JaCoCo |
| `kover` | Require a Kover report task |
| `jacoco` | Require a JaCoCo report task; XML is enabled through a temporary init script when needed |
| `none` | Run tests without coverage |

Modules with no coverage task are reported as skipped rather than made to fail unrelated tests.
Use exact, colonless module names with `--coverage-modules` and `--exclude-coverage`.

```sh
kmp-test parallel --coverage-tool auto --json
kmp-test coverage --min-missed-lines 100 --json
```

A positive missed-line threshold fails closed when coverage data is unavailable; the envelope uses
`coverage_data_unavailable` rather than treating missing XML as zero missed lines. Without
`--output-file`, reports are stored at `.kmp-test-runner/reports/coverage/<runId>.md` and
`latest.md` points to the latest completed managed report.

See [Coverage workflows](docs/usage.md#coverage) and the
[envelope error catalogue](docs/envelope-contract.md#error-codes-errorscode).

## JDK selection

The runner derives the project requirement from signals such as `jvmToolchain(N)`,
`JvmTarget.JVM_N`, and `JavaVersion.VERSION_N`. Effective precedence is:

1. A valid `org.gradle.java.home` in the project's `gradle.properties`; Gradle owns this setting,
   so `--java-home` does not override it.
2. `--java-home <path>` (or the user-global `java_home` setting that injects the same flag).
3. A matching system installation discovered in the JDK catalogue.
4. The host `java` on `PATH`.

If no compatible JDK can be selected, the run exits 3 with `errors[].code: "jdk_mismatch"`.
`--no-jdk-autoselect` disables catalogue selection; `--ignore-jdk-mismatch` deliberately bypasses
the guard.

## Concurrent runs

An advisory `.kmp-test-runner.lock` prevents two normal invocations from mutating the same project
artifacts at once. A second caller receives `lock_held`; dead, pre-boot, malformed, or over-age
locks are reclaimed after validation.

`--isolated` gives Gradle a separate project cache but retains the safety lock. True intentional
fan-out requires either a distinct `--isolated-cache-dir` per caller or `--isolated-no-lock`, and
the operator remains responsible for shared devices, simulators, and consumer-defined outputs.
`--force` bypasses only the project lock and should be reserved for overlaps already proven safe.

See [Concurrent invocation safety](docs/concurrency.md) for the collision matrix and CI patterns.

## Output contract

### Human output

The default output is meant for a terminal or CI log:

```text
========================================
  Parallel Test Suite
========================================
Project: /workspace/sample-app
Test Type: common
Module filter: *

[>] Executing 2 test task(s) in parallel...
    :core:jvmTest
    :feature:jvmTest
  [PASS] core
  [PASS] feature
```

Full per-task logs and generated reports remain under `.kmp-test-runner/` for diagnosis.

### JSON output

`--json` emits exactly one JSON object on stdout; progress stays out of the machine-readable
channel. A representative successful envelope is:

```json
{"tool":"kmp-test","schema_version":2,"subcommand":"parallel","version":"0.14.0","project_root":"/workspace/sample-app","exit_code":0,"duration_ms":83000,"tests":{"total":2,"passed":2,"failed":0,"skipped":0,"individual_total":42},"modules":[{"name":"core","type":"kmp","coverage_plugin":"kover","test_build_type":null,"has_flavor":false,"flavors":[],"android_dsl":false,"android_dsl_variant":null},{"name":"feature","type":"kmp","coverage_plugin":"kover","test_build_type":null,"has_flavor":false,"flavors":[],"android_dsl":false,"android_dsl_variant":null}],"skipped":[],"coverage":{"tool":"kover","missed_lines":16,"modules_contributing":2,"modules_with_kover_plugin":["core","feature"],"modules_with_jacoco_plugin":[],"module_buckets":{"with_data":["core","feature"],"no_xml":[],"parse_errored":[],"skipped_by_user":[]}},"errors":[],"warnings":[],"isolated":{"enabled":false,"cache_dir":null,"kept":false,"locked":true},"parallel":{"test_type":"common","max_workers":0,"timeout_s":600,"legs":[{"test_type":"common","exit_code":0,"execution":{"fresh":2,"up_to_date":0,"from_cache":0,"no_source":0,"skipped_by_gradle":0,"failed":0,"no_evidence":0},"cascade_detected":false,"retry_fired":false}]}}
```

Important guarantees:

- `schema_version` identifies the wire contract; the product version is separate.
- `exit_code` matches the process exit code.
- Missing or partial evidence becomes a typed error/warning, never a fabricated zero.
- `warnings[]` is non-fatal. Most `errors[]` entries are fatal, but documented soft codes can
  coexist with exit 0; always use `exit_code` plus the typed code semantics.
- Subcommands add their own blocks while preserving the common envelope fields.

The authoritative field and code catalogue is [JSON envelope contract](docs/envelope-contract.md).

### Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | Successful run or documented non-fatal/no-op outcome |
| `1` | Tests, benchmark tasks, or a coverage budget failed |
| `2` | Invalid command/configuration or an impossible requested selection |
| `3` | Environment/setup failure such as missing tooling, JDK mismatch, lock contention, or timeout |

Consumers should branch on `errors[].code` as well as the broad process class.

## Configuration

Stable project defaults can live in `.kmp-test-runner.json`:

```json
{
  "sharedProject": { "name": "shared-libs", "path": "../shared-libs" },
  "defaults": {
    "testType": "common",
    "coverageTool": "kover",
    "excludeModules": "*:test-fakes"
  },
  "skip": { "android": ["legacy-app"], "ios": ["bench-android"] },
  "cleanup": { "auto": true, "logsTtlDays": 7 }
}
```

Machine-specific presets, including `java_home`, belong in `~/.kmp-test/config.json` (or
`%USERPROFILE%\.kmp-test\config.json`). A project-local `java_home` is rejected so a checked-in
change cannot redirect a contributor's process environment.

Precedence is CLI, environment, project-local config, user-global preset, then built-in default.
The complete schema and supported environment variables are in the
[usage guide](docs/usage.md#project-configuration).

## Gradle plugin

Configure GitHub Packages in `settings.gradle.kts`:

```kotlin
pluginManagement {
    repositories {
        gradlePluginPortal()
        maven {
            url = uri("https://maven.pkg.github.com/oscardlfr/kmp-test-runner")
            credentials {
                username = providers.gradleProperty("gpr.user").orNull
                    ?: System.getenv("GITHUB_ACTOR")
                password = providers.gradleProperty("gpr.key").orNull
                    ?: System.getenv("GITHUB_TOKEN")
            }
        }
    }
}
```

Apply and configure it in the root `build.gradle.kts`:

```kotlin
plugins {
    id("io.github.oscardlfr.kmp-test-runner") version "0.14.0"
}

kmpTestRunner {
    projectRoot = rootDir.absolutePath
    maxWorkers = 4
    coverageTool = "kover"
    coverageModules = "core,app"
    minMissedLines = 0
    sharedProjectName = "my-shared-lib"
    testType = "" // auto, or a documented CLI test-type value
    captureOnFail = false
    captureDir = ""
}
```

Store consumer credentials outside the repository:

```properties
# ~/.gradle/gradle.properties
gpr.user=<github-username>
gpr.key=<token-with-read:packages>
```

The plugin registers `parallelTests`, `changedTests`, `androidTests`, `benchmarkTests`, and
`coverageTask`. It extracts the bundled JavaScript runtime and starts it through Node; Node must be
available on `PATH`. The plugin intentionally exposes a focused subset of CLI configuration, not
flag-for-flag parity. See [Gradle plugin](docs/gradle-plugin.md) for task properties, Android
capture, and CI.

## CI example

```yaml
jobs:
  tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: 17
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npx kmp-test-runner@0.14.0 doctor --project-root "$GITHUB_WORKSPACE" --json
      - run: npx kmp-test-runner@0.14.0 parallel --json
```

Instrumented jobs must provision an emulator/device. Apple legs require a macOS runner. If a CI
matrix deliberately fans out multiple commands against one checkout, follow the isolated-run
requirements above instead of bypassing the lock blindly.

## Agent Skill and Claude Code plugin

The reusable Agent Skill lives at `.skills/kmp-test-runner/`. Place that directory in a supported
project-local or user-level skill location so an agent can select commands and interpret the JSON
contract without rediscovering the workflow.

The same content is packaged as a Claude Code plugin through `.claude-plugin/plugin.json`:

```sh
git clone https://github.com/oscardlfr/kmp-test-runner.git
claude --plugin-dir ./kmp-test-runner
```

Repository installation is currently the supported distribution path; no marketplace listing is
available yet.

## Evaluation and reproducibility

Output-size measurement and agentic evaluation are separate programs. Output ratios describe the
captured material. Agentic evaluation examines correctness, evidence quality, tool behavior,
latency, resource use, and protocol integrity under controlled conditions; neither result should be
used as a substitute for the other.

The core agentic harness runs offline on Windows, macOS, and Linux. Strict live Claude campaigns
have evidence on Windows and macOS. The full Evidence1 Product/FreeBaseline custody workflow is
currently Windows-specific because it uses Hyper-V, PowerShell Direct, Windows firewall controls,
Task Scheduler, and VHD checkpoints. Authentication remains an explicit manual boundary; secrets,
OAuth state, authenticated disks, and raw transcripts are never publication artifacts.

The committed 2026-09-10 Windows operational canary produced the following descriptive values:

| Arm | Sessions | Expected outcome matched | Wall time, median (range) | Median tool / shell calls | Test invocations |
| --- | ---: | ---: | ---: | ---: | ---: |
| Product | 3 | 3/3 | 121.1 s (116.3-125.1) | 3 / 2 | 1 in every session |
| FreeBaseline | 3 | 0/3 | 170.5 s (165.7-237.1) | 18 / 18 | 0 in every session |

This validates the one-shot operational path; it is not a benchmark or causal result. Every run is
explicitly `benchmark_eligible:false`, the sample is small, and two harness commits are represented
in both arms. Full per-run values, runtime-native usage, provenance, and limitations are in
[Metrics and measurement](docs/metrics.md#evidence1-results).

Codex runtime validation is being performed separately. This README makes no Codex support or
metric claim until the adapter and sanitized evidence are merged and verifiable from a clean
checkout.

- [Evaluation overview](docs/evaluation/README.md)
- [Run the agentic harness](docs/evaluation/running-agentic-eval.md)
- [Provision Evidence1 on Windows](docs/evaluation/evidence1-windows-setup.md)
- [Operate an Evidence1 live canary](docs/evaluation/evidence1-live-canary.md)
- [Metrics and publication rules](docs/metrics.md)

## Documentation

- [Installation and upgrades](docs/installation.md)
- [Usage guide](docs/usage.md)
- [CLI reference](docs/cli-reference.md)
- [Gradle plugin](docs/gradle-plugin.md)
- [JSON envelope contract](docs/envelope-contract.md)
- [Concurrency and isolation](docs/concurrency.md)
- [Maintainer tooling](tools/README.md)
- [Documentation index](docs/README.md)
- [Changelog](CHANGELOG.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the branch model, required checks, test matrix, and
release process. Pull-request titles use Conventional Commits because the squash title becomes the
landed commit subject.

Security vulnerabilities should be reported privately according to [SECURITY.md](SECURITY.md), not
opened as public issues. Community expectations are in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

MIT — see [LICENSE](LICENSE).
