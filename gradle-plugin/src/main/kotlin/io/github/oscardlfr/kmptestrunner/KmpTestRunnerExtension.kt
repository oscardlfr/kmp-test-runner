// SPDX-License-Identifier: MIT
package io.github.oscardlfr.kmptestrunner

open class KmpTestRunnerExtension {
    var projectRoot: String = ""
    var maxWorkers: Int = 4
    var coverageTool: String = "kover"   // "kover" | "jacoco" | "none"
    var coverageModules: String = ""
    var minMissedLines: Int = 0
    var sharedProjectName: String = ""   // → SHARED_PROJECT_NAME env var
    // v0.7.0: opt into a specific test type. Empty = wrapper auto-detects
    // (kmp-desktop → "common"; otherwise → "androidUnit"). Accepts:
    // "common" | "desktop" | "androidUnit" | "androidInstrumented"
    // | "ios" | "macos" | "all".
    var testType: String = ""
    // On instrumented-test failure, capture a device screenshot + UI-hierarchy
    // dump via adb (best-effort, forensic-only — never changes the build's exit
    // code). Propagated to the `androidTests` task as --capture-on-fail. Paths
    // surface on the JSON envelope's failed-module error entries. captureDir
    // overrides where artifacts land (relative to projectRoot) and implies
    // captureOnFail.
    var captureOnFail: Boolean = false
    var captureDir: String = ""
}
