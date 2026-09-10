# kmp-cross-platform-e2e

Synthetic, buildable Kotlin Multiplatform fixture used by `kmp-test-runner` tests. Exercises every supported target in a single `:sample` module:

- `jvm()` — JVM/Desktop
- `js(IR) { nodejs() }` — JS IR
- `wasmJs { nodejs() }` — WebAssembly (JS)
- `iosX64()` + `iosSimulatorArm64()` + `iosArm64()` — Apple iOS (3 archs)
- `macosArm64()` — Apple macOS (Apple Silicon)
- `androidLibrary { … }` — AGP 9 native KMP-Android plugin (`com.android.kotlin.multiplatform.library`)

## What this fixture validates

1. Vitest verifies that the project-model source-set walker detects every declared platform's test source sets.
2. Vitest verifies that `resolveTasksFor` selects the expected task names, including `iosSimulatorArm64Test`, `macosArm64Test`, `jvmTest`, and `jsTest`.
3. The buildable project supports direct Gradle smoke checks and the manual macOS validation gate against a non-trivial KMP shape. The Gradle plugin's TestKit suite uses its own generated projects; it does not execute this fixture.

## Build-only — no per-PR CI execution

Per-PR CI does **not** run `iosSimulatorArm64Test` or `macosArm64Test` against this fixture. Real iOS/macOS task execution is reserved for the manual macOS validation gate (a separate, opportunistic step). The fixture exists so that:

- `./gradlew :sample:tasks` can inspect the per-target task surface directly.
- `./gradlew :sample:compileKotlinJvm` and `:sample:compileKotlinJs` are available as direct smoke
  entry points on hosts with the compatible JDK and toolchain prerequisites; the repository does
  not claim a per-host automated matrix for these commands.
- iOS/macOS targets support configuration-only inspection on non-macOS hosts; native execution
  remains part of the manual macOS gate.

## Vendored gradle wrapper

`gradle/wrapper/gradle-wrapper.jar` (~45 KB) is checked into the repo so the fixture can be invoked without a separate Gradle install. The wrapper is copied verbatim from `gradle-plugin/gradle/wrapper/` (Gradle 9.1.0) so all sub-projects in the repo share the same Gradle minor.

## Pinned versions

Locked in `gradle/libs.versions.toml`:

- Kotlin `2.3.20`
- AGP `9.0.1`
- Gradle `9.1.0` (via the wrapper)
- compileSdk `36` / minSdk `26`

These versions form the repository's public cross-platform compatibility fixture. Update the pins together and re-run the static fixture tests, direct Gradle smoke checks, and manual macOS gate when the supported toolchain advances.
