// SPDX-License-Identifier: MIT
package io.github.oscardlfr.kmptestrunner.tasks

import io.github.oscardlfr.kmptestrunner.KmpTestRunnerExtension
import io.github.oscardlfr.kmptestrunner.RuntimeExtractor
import io.github.oscardlfr.kmptestrunner.buildNodeCommand
import org.gradle.api.DefaultTask
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.TaskAction
import java.nio.file.Files

open class ParallelTestsTask : DefaultTask() {
    @get:Internal
    lateinit var extension: KmpTestRunnerExtension

    @get:Internal
    var defaultProjectRoot: String = ""

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
            val pb = ProcessBuilder(cmd).redirectErrorStream(true)
            if (extension.sharedProjectName.isNotEmpty()) {
                pb.environment()["SHARED_PROJECT_NAME"] = extension.sharedProjectName
            }
            val proc = pb.start()
            proc.inputStream.transferTo(System.out)
            val rc = proc.waitFor()
            if (rc != 0) error("[parallelTests] runner exited with code $rc")
        } finally {
            RuntimeExtractor.cleanup(tempDir)
        }
    }
}
