// SPDX-License-Identifier: MIT
package io.github.oscardlfr.kmptestrunner

open class KmpTestRunnerExtension {
    var projectRoot: String = ""
    var maxWorkers: Int = 4
    var coverageTool: String = "kover"   // "kover" | "jacoco" | "none"
    var coverageModules: String = ""
    var minMissedLines: Int = 0
    var sharedProjectName: String = ""   // → SHARED_PROJECT_NAME env var
}
