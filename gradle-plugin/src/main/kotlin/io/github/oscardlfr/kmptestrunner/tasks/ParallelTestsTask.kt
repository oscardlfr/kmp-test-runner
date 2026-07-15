// SPDX-License-Identifier: MIT
package io.github.oscardlfr.kmptestrunner.tasks

import io.github.oscardlfr.kmptestrunner.RuntimeExtractor
import io.github.oscardlfr.kmptestrunner.buildNodeCommand
import io.github.oscardlfr.kmptestrunner.runNodeRunner
import org.gradle.api.tasks.TaskAction
import java.nio.file.Files

abstract class ParallelTestsTask : NodeRunnerTask() {
    @TaskAction
    fun run() {
        val effectiveRoot = extension.projectRoot.ifEmpty { defaultProjectRoot }
        val tempDir = Files.createTempDirectory("kmp-test-parallel-")
        try {
            RuntimeExtractor.extractTo(tempDir, javaClass)
            val runnerPath = tempDir.resolve("lib/runner.js").toString()
            val cmd = buildNodeCommand(runnerPath, "parallel",
                "--project-root", effectiveRoot,
                "--max-workers", extension.maxWorkers.toString(),
                "--coverage-tool", extension.coverageTool,
                "--min-missed-lines", extension.minMissedLines.toString()
            ).toMutableList()
            if (extension.coverageModules.isNotEmpty()) {
                cmd += listOf("--coverage-modules", extension.coverageModules)
            }
            if (extension.testType.isNotEmpty()) {
                cmd += listOf("--test-type", extension.testType)
            }
            if (extension.captureOnFail) {
                cmd += "--capture-on-fail"
            }
            if (extension.captureDir.isNotEmpty()) {
                cmd += listOf("--capture-dir", extension.captureDir)
            }
            runNodeRunner(execOperations, "parallelTests", cmd, effectiveRoot, extension.sharedProjectName)
        } finally {
            RuntimeExtractor.cleanup(tempDir)
        }
    }
}
