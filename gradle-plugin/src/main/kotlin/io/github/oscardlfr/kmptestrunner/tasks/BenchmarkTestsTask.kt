// SPDX-License-Identifier: MIT
package io.github.oscardlfr.kmptestrunner.tasks

import io.github.oscardlfr.kmptestrunner.RuntimeExtractor
import io.github.oscardlfr.kmptestrunner.buildNodeCommand
import io.github.oscardlfr.kmptestrunner.runNodeRunner
import org.gradle.api.tasks.TaskAction
import java.nio.file.Files

abstract class BenchmarkTestsTask : NodeRunnerTask() {
    @TaskAction
    fun run() {
        val effectiveRoot = extension.projectRoot.ifEmpty { defaultProjectRoot }
        val tempDir = Files.createTempDirectory("kmp-test-bench-")
        try {
            RuntimeExtractor.extractTo(tempDir, javaClass)
            val runnerPath = tempDir.resolve("lib/runner.js").toString()
            val cmd = buildNodeCommand(runnerPath, "benchmark",
                "--project-root", effectiveRoot
            )
            runNodeRunner(execOperations, "benchmarkTests", cmd, effectiveRoot, extension.sharedProjectName)
        } finally {
            RuntimeExtractor.cleanup(tempDir)
        }
    }
}
