# Gradle plugin

The plugin exposes the runner as Gradle tasks while reusing the bundled Node runtime. It is not a byte-for-byte mirror of the npm CLI: the DSL intentionally exposes a stable subset of options.

## Apply the plugin

Configure GitHub Packages as described in [Installation](installation.md), then:

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
    sharedProjectName = ""
    testType = ""
    captureOnFail = false
    captureDir = ""
}
```

## DSL

| Property | Default | Meaning |
|---|---|---|
| `projectRoot` | root project directory | Gradle project to inspect and run. |
| `maxWorkers` | `4` | Maximum parallel workers for plugin tasks. This differs from the CLI's `0`/auto default. |
| `coverageTool` | `"kover"` | `kover`, `jacoco`, or `none`. |
| `coverageModules` | empty | Comma-separated coverage modules. |
| `minMissedLines` | `0` | Optional missed-line threshold. |
| `sharedProjectName` | empty | Optional sibling shared project name. |
| `testType` | empty | Empty selects the unit leg; otherwise a supported concrete test type or `all`. |
| `captureOnFail` | `false` | Capture screenshot and UI hierarchy for failed Android device tests. |
| `captureDir` | empty | Override the failure-capture directory; implies capture. |

## Tasks

| Task | Equivalent workflow |
|---|---|
| `parallelTests` | Parallel test dispatch. |
| `changedTests` | Git-affected module dispatch. |
| `androidTests` | Android instrumented dispatch. |
| `benchmarkTests` | Benchmark dispatch. |
| `coverageTask` | Coverage aggregation. |

The task implementations extract the packaged runtime and execute Node directly. They do not depend on a host bash installation on Windows, and the old statement that every task calls a shell script is no longer correct.

For options not represented in the DSL, use the npm CLI or release installer shape and consult the [CLI reference](cli-reference.md).
