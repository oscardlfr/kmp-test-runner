# tests/fixtures/

Synthetic Gradle / KMP project layouts that the test suite exercises. Each fixture is small, version-pinned, and shaped to provoke a specific surface in the codebase. Two flavors:

- **Parse-only fixtures** — no real Gradle invocation. The test suite reads `settings.gradle.kts` + per-module `build.gradle.kts` statically (`lib/project-model.js#analyzeModule`, source-set walker, plugin alias resolution). `gradlew` / `gradlew.bat` are stubs (often `exit 1`); the wrapper jar is omitted. These are deterministic, fast, and host-agnostic.
- **Buildable fixtures** — full Gradle wrapper jar checked in, real plugin application. The test suite can still parse them statically (cheaper) but they also `./gradlew :module:tasks` cleanly when needed for end-to-end checks.

## Inventory

| Directory | Flavor | Surface exercised |
|---|---|---|
| `build-logic-convention-jacoco/` | parse-only | Convention plugin + jacoco — `core-foo` inherits coverage via build-logic |
| `build-logic-noise-jacoco/` | parse-only | False-positive guard: build-logic mentions jacoco in comments without applying it |
| `build-logic-selective-jacoco/` | parse-only | Per-module jacoco descriptor application (only modules that apply the convention plugin inherit it) |
| `build-logic-self-jacoco/` | parse-only | `build-logic`'s own buildscript uses jacoco; consumers should NOT inherit it |
| `fake-gradlew/` | parse-only | Minimal `app` module + stub gradlew used by installer / wrapper smoke tests |
| `kmp-cross-platform-e2e/` | **buildable** | Every supported KMP target in one module — see below |
| `kmp-with-benchmark/` | parse-only | Benchmark detection (`bench-android`, `bench-jvm`, `no-bench`) |
| `kmp-with-ios/` | parse-only | v0.7.0 iOS / macOS source-set walker — 3 modules covering single-target + multi-target shapes |
| `kmp-with-js/` | parse-only | JS / Wasm source-set walker (`web-only` JS-IR target + `kmp-multi` JVM+JS combo) |
| `version-catalog-alias-plugins/` | parse-only | `alias(libs.plugins.X)` resolution against `gradle/libs.versions.toml` |

## `kmp-cross-platform-e2e/` — the buildable cross-platform fixture (v0.9 step 6)

A single `:sample` module exercising every supported target in one place:

- `jvm()`
- `js(IR) { nodejs() }`
- `wasmJs { nodejs() }`
- `iosX64()` + `iosSimulatorArm64()` + `iosArm64()`
- `macosArm64()`
- `androidLibrary { … withHostTestBuilder { } }` (AGP 9 native KMP-Android plugin `com.android.kotlin.multiplatform.library`)

Pinned to Kotlin `2.3.20` + AGP `9.0.1` + Gradle `9.1.0` (matches the maintainer's private KMP repos circa 2026). Per-PR CI does **not** execute iOS/macOS test tasks against this fixture — that's the manual macOS validation gate (v0.9 step 7). Vitest exercises the static parser (`buildProjectModel({ skipProbe: true })`) + the spawn-based `kmp-test describe` envelope.

The Gradle wrapper jar (`gradle/wrapper/gradle-wrapper.jar`, ~45 KB) is vendored from `gradle-plugin/gradle/wrapper/` so all Gradle invocations in the repo share the same minor (`9.1.0`).

A specific `.gitignore` exception keeps the fixture's `gradle.properties` tracked — the global rule (`**/gradle.properties`) ignores build-artifact properties produced when fixtures are exercised.
