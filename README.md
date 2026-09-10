# kmp-test-runner

Parallel test runner for Kotlin Multiplatform and Android Gradle projects. It discovers the project, fans out Gradle work safely, and emits one compact JSON envelope for humans, CI, and coding agents.

## Quick start

Requires Node.js 18+, the project's Gradle wrapper, and a compatible JDK. Android device tests also require ADB; Apple targets require macOS and the corresponding Apple toolchain.

Linux or macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/oscardlfr/kmp-test-runner/main/scripts/install.sh | bash
```

Windows PowerShell:

```powershell
iwr -useb https://raw.githubusercontent.com/oscardlfr/kmp-test-runner/main/scripts/install.ps1 | iex
```

Or install from npm:

```sh
npm install -g kmp-test-runner
```

Run the default unit-test leg from a Gradle project:

```sh
kmp-test parallel
```

For automation and agents, request the stable JSON envelope:

```sh
kmp-test parallel --json
```

## Choose a command

| Command | Purpose |
|---|---|
| `parallel` | Discover modules and run the selected test type in parallel. |
| `changed` | Test modules affected by Git changes. |
| `android` | Run Android instrumented tests on a device or emulator. |
| `benchmark` | Run configured JVM or Android benchmark suites. |
| `coverage` | Aggregate existing JaCoCo or Kover reports. |
| `doctor` | Diagnose Node, Gradle, JDK, shell, SDK, and ADB readiness. |
| `info` | Return host and toolchain information. |
| `describe` | Return the discovered project model and Gradle tasks. |
| `update` | Check for or install the latest release. |
| `clean` | Remove runner-owned reports, logs, and optionally caches. |

Use `kmp-test <command> --help` for live help, or see the complete [CLI reference](docs/cli-reference.md).

## Platform dispatch

`parallel` defaults to the ordinary unit-test leg: `common` for desktop-oriented KMP projects and `androidUnit` otherwise. Device and Apple targets are opt-in.

| `--test-type` | Typical Gradle task | Host requirement |
|---|---|---|
| `common` / `jvm` | `jvmTest` or another JVM unit-test task | Windows, Linux, or macOS |
| `desktop` | `desktopTest` | Windows, Linux, or macOS |
| `androidUnit` | `testDebugUnitTest` or the resolved variant task | JDK + Android project |
| `androidInstrumented` | `connectedDebugAndroidTest` or resolved device task | Android SDK + connected device/emulator |
| `ios` | `iosSimulatorArm64Test`, `iosX64Test`, or resolved iOS task | macOS + Xcode/simulator |
| `macos` | `macosArm64Test`, `macosX64Test`, or resolved macOS task | macOS |
| `js` | `jsTest` or the discovered JS task | Node/browser toolchain required by the project |
| `wasm` | `wasmJsTest` or the discovered Wasm task | Toolchain required by the project |
| `all` | Multiple applicable legs | Requirements of every selected leg |

Examples:

```sh
# One class or method, compact output
kmp-test parallel --test-type common --test-filter "com.example.UserTest#loadsUser" --json

# Changed modules only
kmp-test changed --json

# Android device tests with forensic capture on failure
kmp-test android --capture-on-fail --json

# Concurrent callers: isolate Gradle's project cache
kmp-test parallel --isolated --json
```

See [usage and recipes](docs/usage.md), [concurrency](docs/concurrency.md), and the [JSON envelope contract](docs/envelope-contract.md).

## Agentic output

With `--json`, stdout contains a single machine-readable envelope. Human-oriented progress goes to stderr, and process exit codes remain meaningful:

| Exit | Meaning |
|---:|---|
| `0` | Successful execution, including intentionally partial benchmark outcomes represented as warnings. |
| `1` | Tests, benchmark work, or a coverage threshold failed. |
| `2` | Invalid configuration or command-line input. |
| `3` | Environment, platform, toolchain, or execution infrastructure failed. |

Consumers should branch on `exit_code` and typed `errors[].code`, not scrape Gradle text. The envelope is additive within the pre-1.0 line; removals or renames require an explicit migration note.

## Measured impact

The runner is designed to reduce both elapsed orchestration work and the output an agent must ingest. Public measurements use within-project comparisons only.

| Evidence | Result | Scope |
|---|---:|---|
| Multi-project raw Gradle vs JSON | 56.6x median reduction on small projects; 90.0x on medium projects | Token-count captures across public OSS projects |
| Large-project `parallel` capture | 123.1x fewer measured tokens | One public project, same capture for numerator and denominator |
| Evidence1 live canary, 3 paired rounds | 3/3 expected outcomes with the product vs 0/3 free baseline; mean tool calls 3 vs 18 | Windows VM operational canary, descriptive only |

The live canary is deliberately marked `benchmark_eligible: false`: six sessions are useful operational evidence, not a general claim about models or statistical significance. Definitions, provenance, caveats, and all result tables live in [Metrics and evidence](docs/metrics.md).

## Gradle plugin

The plugin is published through GitHub Packages. Add the package repository to `settings.gradle.kts`, then apply:

```kotlin
plugins {
    id("io.github.oscardlfr.kmp-test-runner") version "0.14.0"
}

kmpTestRunner {
    projectRoot = rootDir.absolutePath
    maxWorkers = 4
    coverageTool = "kover"
    coverageModules = ":core,:app"
    minMissedLines = 0
    testType = ""
    captureOnFail = false
    captureDir = ""
}
```

The plugin registers `parallelTests`, `changedTests`, `androidTests`, `benchmarkTests`, and `coverageTask`. Its DSL is intentionally smaller than the npm CLI; both use the bundled Node runtime, but not every CLI flag has a Gradle property. See the [Gradle plugin guide](docs/gradle-plugin.md) for repository credentials, tasks, and exact defaults.

## Installation and updates

Release installers verify the published checksum before extraction. Offline installs can supply a local archive and optional checksum:

```sh
bash scripts/install.sh --archive kmp-test-runner-0.14.0-linux.tar.gz \
  --archive-sha256 kmp-test-runner-0.14.0-linux.tar.gz.sha256
```

```powershell
.\scripts\install.ps1 -LocalArchive kmp-test-runner-0.14.0-windows.zip `
  -LocalArchiveSha256 kmp-test-runner-0.14.0-windows.zip.sha256
```

Check or apply updates with:

```sh
kmp-test update --check --json
kmp-test update
```

Full installer, uninstaller, PATH, and GitHub Packages instructions are in [Installation](docs/installation.md).

## Documentation

- [Documentation index](docs/README.md)
- [Installation](docs/installation.md)
- [Usage and recipes](docs/usage.md)
- [CLI reference](docs/cli-reference.md)
- [Gradle plugin](docs/gradle-plugin.md)
- [JSON envelope contract](docs/envelope-contract.md)
- [Metrics and evidence](docs/metrics.md)
- [Agentic evaluation](docs/evaluation/README.md)
- [Windows troubleshooting](docs/troubleshooting-windows.md)
- [Contributor guide](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## Contributing and security

Issues and pull requests are welcome. Target `develop`, use a Conventional Commit PR title, and run the local validation described in [CONTRIBUTING.md](CONTRIBUTING.md).

Do not publish credentials, raw authenticated transcripts, machine identifiers, or custody bundles. Evaluation artifacts committed to this repository must be sanitized and accompanied by their validation sidecars.

## License

[MIT](LICENSE)
