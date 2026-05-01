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
}
