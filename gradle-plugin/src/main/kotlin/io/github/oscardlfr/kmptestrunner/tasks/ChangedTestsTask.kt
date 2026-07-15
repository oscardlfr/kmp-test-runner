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
            runNodeRunner(execOperations, "changedTests", cmd, effectiveRoot, extension.sharedProjectName)
        } finally {
            RuntimeExtractor.cleanup(tempDir)
        }
    }
}
