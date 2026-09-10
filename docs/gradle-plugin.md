# Gradle plugin

The plugin `io.github.oscardlfr.kmp-test-runner` exposes the runner as five
Gradle tasks; it is normally applied to the root project. It packages the JavaScript runner and platform glue
inside the plugin artifact, extracts that runtime to a temporary directory for
each task, invokes it through Node.js, and removes the temporary directory when
the task finishes.

The plugin is currently distributed through GitHub Packages.

## Requirements

- Gradle 7.6 or newer. The plugin rejects older Gradle versions during apply.
- A JDK capable of running the consumer build; the plugin itself uses a JDK 17
  toolchain.
- Node.js 18 or newer on `PATH`. The plugin bundles runner source, not a Node
  executable.
- GitHub Packages read credentials during plugin resolution.

Set `KMP_NODE_LAUNCHER` when `node` is not the correct launcher name or an
absolute executable must be selected:

```sh
export KMP_NODE_LAUNCHER=/opt/node/bin/node
```

```powershell
$env:KMP_NODE_LAUNCHER = 'C:\Program Files\nodejs\node.exe'
```

## Configure GitHub Packages

Add the repository to `pluginManagement` in `settings.gradle.kts`:

```kotlin
pluginManagement {
    repositories {
        gradlePluginPortal()
        maven {
            name = "GitHubPackages"
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

Store local credentials in `~/.gradle/gradle.properties`, never in the
repository:

```properties
gpr.user=<github-username>
gpr.key=<token-with-read-packages>
```

A classic personal access token with `read:packages` is sufficient for
consumption. In GitHub Actions, use a token whose workflow/repository permissions
allow reading the package and pass it through `GITHUB_TOKEN`; `GITHUB_ACTOR`
supplies the username.

## Apply the plugin

In the root `build.gradle.kts`:

```kotlin
plugins {
    id("io.github.oscardlfr.kmp-test-runner") version "0.14.0"
}

kmpTestRunner {
    projectRoot = rootDir.absolutePath
    maxWorkers = 4
    coverageTool = "auto"
    coverageModules = "core,app"
    minMissedLines = 0
    sharedProjectName = ""
    testType = ""
    captureOnFail = false
    captureDir = ""
}
```

An empty `projectRoot` uses the root directory of the build where the plugin is
applied. An empty `testType` preserves runner auto-detection.

## Extension properties

| Property | Type | Default | Used by | Meaning |
|---|---|---|---|---|
| `projectRoot` | `String` | `""` | all tasks | Explicit Gradle project root; empty uses `rootDir` |
| `maxWorkers` | `Int` | `4` | `parallelTests` | Value forwarded as `--max-workers` |
| `coverageTool` | `String` | `"kover"` | parallel, changed, coverage | `auto`, `kover`, `jacoco`, or `none` |
| `coverageModules` | `String` | `""` | parallel, coverage | Exact comma-separated module list |
| `minMissedLines` | `Int` | `0` | parallel, changed, coverage | Coverage missed-line budget |
| `sharedProjectName` | `String` | `""` | all tasks | Exposed to the runner as `SHARED_PROJECT_NAME` |
| `testType` | `String` | `""` | parallel, changed | Test-type value forwarded when non-empty; `coverageTask` currently forwards the argument for cross-shape consistency, but the coverage subcommand ignores it |
| `captureOnFail` | `Boolean` | `false` | parallel, Android | Enable Android failure captures |
| `captureDir` | `String` | `""` | parallel, Android | Capture output path; a non-empty value also implies capture in the runner |

The CLI supports these test-type values:
`common`, `jvm`, `android`, `androidUnit`, `androidInstrumented`, `ios`,
`macos`, `js`, `wasm`, `desktop`, and `all`. The Gradle extension does not
validate the string itself; the bundled runner validates it when the task runs.

The default `coverageTool` differs intentionally from the CLI: the extension
defaults to `"kover"`, while the CLI's coverage-aware commands default to
`auto`. Set `coverageTool = "auto"` when the build contains mixed Kover/JaCoCo
modules or should be discovered from its task graph.

## Registered tasks

| Gradle task | Runner subcommand | Extension values forwarded |
|---|---|---|
| `parallelTests` | `parallel` | project root, workers, coverage tool/modules/budget, test type, capture options |
| `changedTests` | `changed` | project root, coverage tool/budget, test type |
| `androidTests` | `android` | project root, capture options |
| `benchmarkTests` | `benchmark` | project root |
| `coverageTask` | `coverage` | project root and coverage tool/modules/budget; a configured test type is forwarded but has no coverage semantics |

Examples:

```sh
./gradlew parallelTests
./gradlew changedTests
./gradlew androidTests
./gradlew benchmarkTests
./gradlew coverageTask
```

On Windows use `gradlew.bat` or `./gradlew.bat` as appropriate for the shell.

The task fails the Gradle build when the runner exits non-zero. Runner stdout and
stderr are forwarded to the Gradle console. For the complete JSON envelope and
the full CLI option surface, invoke `kmp-test <subcommand> --json` directly; the
Gradle extension is a curated task interface, not a one-property mirror of every
CLI flag.

## Android capture through Gradle

Capture options apply to `androidTests` and to the instrumented leg of
`parallelTests`:

```kotlin
kmpTestRunner {
    testType = "androidInstrumented"
    captureOnFail = true
    captureDir = layout.buildDirectory.dir("kmp-test-captures").get().asFile.absolutePath
}
```

The runner captures a screenshot and UI hierarchy after a failed module on a
best-effort basis. Capture failures do not replace the underlying test verdict.

## CI example

```yaml
- uses: actions/setup-java@v4
  with:
    distribution: temurin
    java-version: 17
- uses: actions/setup-node@v4
  with:
    node-version: 22
- name: Run KMP tests
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  run: ./gradlew parallelTests
```

If the package belongs to a different repository or organization than the
workflow, use a secret containing a token with explicit `read:packages` access.

## Distribution boundary

The plugin artifact contains `lib/`, `scripts/`, and `package.json` resources.
It does not depend on a separately installed `kmp-test` command, but it does
depend on the host's Node executable and the consumer project's Gradle wrapper
environment. Maven Central distribution is not currently available.
