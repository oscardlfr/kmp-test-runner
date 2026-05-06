# kmp-cross-platform-e2e

Synthetic, buildable Kotlin Multiplatform fixture used by `kmp-test-runner` tests. Exercises every supported target in a single `:sample` module:

- `jvm()` — JVM/Desktop
- `js(IR) { nodejs() }` — JS IR
- `wasmJs { nodejs() }` — WebAssembly (JS)
- `iosX64()` + `iosSimulatorArm64()` + `iosArm64()` — Apple iOS (3 archs)
- `macosArm64()` — Apple macOS (Apple Silicon)
- `androidLibrary { … }` — AGP 9 native KMP-Android plugin (`com.android.kotlin.multiplatform.library`)

## What this fixture proves

1. The project-model source-set walker (`lib/project-model.js`) detects all per-platform test source sets.
2. `resolveTasksFor` picks the canonical task per platform: `iosSimulatorArm64Test`, `macosArm64Test`, `jvmTest`, `jsTest`, etc.
3. The Gradle plugin's TestKit acceptance suite can invoke a real Gradle build against a non-trivial KMP shape.

## Build-only — no per-PR CI execution

Per-PR CI does **not** run `iosSimulatorArm64Test` or `macosArm64Test` against this fixture. Real iOS/macOS task execution is reserved for the manual macOS validation gate (a separate, opportunistic step). The fixture exists so that:

- `./gradlew :sample:tasks` lists the per-target test tasks.
- `./gradlew :sample:compileKotlinJvm` / `:sample:compileKotlinJs` succeed on every host.
- iOS/macOS targets can be **configured** on Windows/Linux even when they cannot be **executed** there.

## Vendored gradle wrapper

`gradle/wrapper/gradle-wrapper.jar` (~45 KB) is checked into the repo so the fixture can be invoked without a separate Gradle install. The wrapper is copied verbatim from `gradle-plugin/gradle/wrapper/` (Gradle 9.1.0) so all sub-projects in the repo share the same Gradle minor.

## Pinned versions

Locked in `gradle/libs.versions.toml`:

- Kotlin `2.3.20`
- AGP `9.0.1`
- Gradle `9.1.0` (via the wrapper)
- compileSdk `36` / minSdk `26`

These match the production pin-set used by the user's `shared-kmp-libs` and `DawSync` repos circa 2026, so the fixture stays representative without diverging.
