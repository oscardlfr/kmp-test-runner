// SPDX-License-Identifier: MIT
package io.github.oscardlfr.kmptestrunner.tasks

import io.github.oscardlfr.kmptestrunner.RuntimeExtractor
import io.github.oscardlfr.kmptestrunner.buildNodeCommand
import io.github.oscardlfr.kmptestrunner.runNodeRunner
import org.gradle.api.tasks.TaskAction
import java.nio.file.Files

abstract class ChangedTestsTask : NodeRunnerTask() {
    @TaskAction
    fun run() {
        val effectiveRoot = extension.projectRoot.ifEmpty { defaultProjectRoot }
        val tempDir = Files.createTempDirectory("kmp-test-changed-")
        try {
            RuntimeExtractor.extractTo(tempDir, javaClass)
            val runnerPath = tempDir.resolve("lib/runner.js").toString()
            val cmd = buildNodeCommand(runnerPath, "changed",
                "--project-root", effectiveRoot,
                "--min-missed-lines", extension.minMissedLines.toString(),
                "--coverage-tool", extension.coverageTool
            ).toMutableList()
            if (extension.testType.isNotEmpty()) {
                cmd += listOf("--test-type", extension.testType)
            }
            if (extension.baseRef.isNotEmpty()) {
                cmd += listOf("--base", extension.baseRef)
            }
            if (extension.includeDependents) {
                cmd += "--include-dependents"
            }
            if (extension.flavor.isNotEmpty()) {
                cmd += listOf("--flavor", extension.flavor)
            }
            if (extension.variant.isNotEmpty()) {
                cmd += listOf("--variant", extension.variant)
            }
            if (extension.minLineCoverage >= 0) {
                cmd += listOf("--min-line-coverage", extension.minLineCoverage.toString())
            }
            runNodeRunner(execOperations, "changedTests", cmd, effectiveRoot, extension.sharedProjectName)
        } finally {
            RuntimeExtractor.cleanup(tempDir)
        }
    }
}
