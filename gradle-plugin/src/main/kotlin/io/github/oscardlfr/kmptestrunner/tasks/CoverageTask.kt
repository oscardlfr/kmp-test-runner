// SPDX-License-Identifier: MIT
package io.github.oscardlfr.kmptestrunner.tasks

import io.github.oscardlfr.kmptestrunner.RuntimeExtractor
import io.github.oscardlfr.kmptestrunner.buildNodeCommand
import io.github.oscardlfr.kmptestrunner.runNodeRunner
import org.gradle.api.tasks.TaskAction
import java.nio.file.Files

abstract class CoverageTask : NodeRunnerTask() {
    @TaskAction
    fun run() {
        val effectiveRoot = extension.projectRoot.ifEmpty { defaultProjectRoot }
        val tempDir = Files.createTempDirectory("kmp-test-coverage-")
        try {
            RuntimeExtractor.extractTo(tempDir, javaClass)
            val runnerPath = tempDir.resolve("lib/runner.js").toString()
            val cmd = buildNodeCommand(runnerPath, "coverage",
                "--project-root", effectiveRoot,
                "--coverage-tool", extension.coverageTool,
                "--min-missed-lines", extension.minMissedLines.toString()
            ).toMutableList()
            if (extension.coverageModules.isNotEmpty()) {
                cmd += listOf("--coverage-modules", extension.coverageModules)
            }
            if (extension.testType.isNotEmpty()) {
                cmd += listOf("--test-type", extension.testType)
            }
            runNodeRunner(execOperations, "coverageTask", cmd, effectiveRoot, extension.sharedProjectName)
        } finally {
            RuntimeExtractor.cleanup(tempDir)
        }
    }
}
