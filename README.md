# kmp-test-runner

Standalone parallel test runner for Kotlin Multiplatform and Android Gradle projects.

## Requirements

- Node.js 18+
- Either:
  - **Unix (Linux/macOS)**: bash
  - **Windows**: PowerShell 5.1+ (built-in) or pwsh 7+
- JDK 17+ and Gradle 8+ on the target project

<!-- TODO: finalize in sub-wave c -->
## Install

```sh
npm install -g kmp-test-runner
```

<!-- TODO: finalize in sub-wave c -->
## Usage

```sh
# Run all tests in parallel with coverage
kmp-test parallel --project-root /path/to/project

# Run only changed modules
kmp-test changed --project-root /path/to/project

# Run Android instrumented tests
kmp-test android --project-root /path/to/project

# Run benchmarks
kmp-test benchmark --project-root /path/to/project

# Generate coverage report only (skip test run)
kmp-test coverage --project-root /path/to/project
```

## Gradle Plugin

`io.github.oscardlfr.kmp-test-runner` is the second consumer shape (npm CLI
is the first). It registers 5 Gradle tasks that mirror the npm subcommands
and dispatch to the same bash scripts.

### Setup (consumer side)

In `settings.gradle.kts`:
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

In `build.gradle.kts`:
```kotlin
plugins {
    id("io.github.oscardlfr.kmp-test-runner") version "0.2.0"
}

kmpTestRunner {
    projectRoot = rootDir.absolutePath
    maxWorkers = 4
    coverageTool = "kover"           // "kover" | "jacoco" | "none"
    coverageModules = ":core,:app"
    minMissedLines = 0
    sharedProjectName = "my-shared-lib"
}
```

### Tasks

| Task | Subcommand | Underlying script |
|------|-----------|-------------------|
| `parallelTests` | `kmp-test parallel` | `run-parallel-coverage-suite.sh` |
| `changedTests` | `kmp-test changed` | `run-changed-modules-tests.sh` |
| `androidTests` | `kmp-test android` | `run-android-tests.sh` |
| `benchmarkTests` | `kmp-test benchmark` | `run-benchmarks.sh` |
| `coverageTask` | `kmp-test coverage` | `run-parallel-coverage-suite.sh --skip-tests` |

### Authentication (consumer side)

Add to `~/.gradle/gradle.properties` (NOT to a checked-in file):
```properties
gpr.user=<your-github-username>
gpr.key=<github-personal-access-token-with-read:packages-scope>
```

A token with `read:packages` scope is sufficient for consumers. Maven
Central will be the recommended channel from v0.4.0 onward (no auth needed).

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
